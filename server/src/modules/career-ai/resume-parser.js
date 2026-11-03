import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError } from '../../util.js';

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const MAX_RESUME_TEXT = 60000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const DOCX_SCRIPT = String.raw`
import io, sys, zipfile, xml.etree.ElementTree as ET
data = sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(data)) as z:
    xml = z.read('word/document.xml')
root = ET.fromstring(xml)
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
lines = []
for p in root.findall('.//w:p', ns):
    text = ''.join((t.text or '') for t in p.findall('.//w:t', ns))
    if text.strip():
        lines.append(text)
sys.stdout.write('\n'.join(lines))
`;

const PDF_SCRIPT = String.raw`
import io, sys
from pypdf import PdfReader
reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
parts = []
for page in reader.pages:
    try:
        text = page.extract_text() or ''
    except Exception:
        text = ''
    if text.strip():
        parts.append(text)
sys.stdout.write('\n\n'.join(parts))
`;

function runPython(code, buffer, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.env.PYTHON_BIN || 'python3', ['-c', code], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
    } catch (err) {
      reject(new AppError(422, 'RESUME_PARSER_UNAVAILABLE', '本机没有可用的简历解析器', { details: { reason: err.message } }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(reject, new AppError(422, 'RESUME_PARSE_TIMEOUT', '简历解析超时，请重试或改为粘贴文本'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish(reject, new AppError(422, 'RESUME_TOO_LARGE', '简历提取内容过大，请精简后重试'));
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(0, 4000); });
    child.on('error', (err) => {
      finish(reject, new AppError(422, 'RESUME_PARSER_UNAVAILABLE', '本机没有可用的简历解析器', {
        details: { reason: err.code === 'ENOENT' ? '未找到 python3' : err.message }
      }));
    });
    child.on('close', (code) => {
      if (code === 0) finish(resolve, stdout);
      else {
        const pdfMissing = /No module named ['"]pypdf['"]/.test(stderr);
        finish(reject, new AppError(422, pdfMissing ? 'RESUME_PDF_UNSUPPORTED' : 'RESUME_PARSE_FAILED',
          pdfMissing ? '当前环境缺少 PDF 解析组件（pypdf）。可粘贴简历文本，或安装 pypdf 后重试。'
            : '无法从文件中提取简历文本，请检查文件是否损坏，或粘贴文本后重试。',
          { details: { parser: 'python3', code: String(code) } }));
      }
    });
    child.stdin.on('error', () => { /* child may exit before stdin is consumed */ });
    child.stdin.end(buffer);
  });
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16?.();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8');
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export async function extractResumeText({ filename = 'resume', mime = '', buffer }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new AppError(400, 'VALIDATION_ERROR', '简历文件为空');
  if (buffer.length > MAX_RESUME_BYTES) throw new AppError(413, 'RESUME_TOO_LARGE', '简历文件不能超过 5 MB');
  const ext = path.extname(String(filename || '')).toLowerCase();
  const normalizedMime = String(mime || '').toLowerCase();
  let format;
  let text;
  if (ext === '.pdf' || normalizedMime === 'application/pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new AppError(422, 'RESUME_PARSE_FAILED', '文件不是有效的 PDF');
    format = 'pdf';
    text = await runPython(PDF_SCRIPT, buffer);
  } else if (ext === '.docx' || normalizedMime.includes('officedocument.wordprocessingml.document')) {
    if (buffer.subarray(0, 2).toString('latin1') !== 'PK') throw new AppError(422, 'RESUME_PARSE_FAILED', '文件不是有效的 DOCX');
    format = 'docx';
    text = await runPython(DOCX_SCRIPT, buffer);
  } else if (['.txt', '.md', '.markdown', ''].includes(ext) || normalizedMime.startsWith('text/')) {
    format = 'text';
    text = decodeText(buffer);
  } else {
    throw new AppError(415, 'RESUME_UNSUPPORTED', '首版支持 PDF、DOCX 和粘贴文本；请转换格式或直接粘贴简历文本');
  }
  text = cleanText(text);
  if (text.length < 20) throw new AppError(422, 'RESUME_TEXT_TOO_SHORT', '没有提取到足够的简历文本，请改用粘贴文本或检查文件');
  const truncated = text.length > MAX_RESUME_TEXT;
  return { text: text.slice(0, MAX_RESUME_TEXT), format, truncated };
}
