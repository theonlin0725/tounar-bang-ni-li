import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError } from '../../util.js';

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const MAX_RESUME_TEXT = 60000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const DOCX_SCRIPT = String.raw`
import base64, io, json, re, sys, zipfile, xml.etree.ElementTree as ET
data = sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(data)) as z:
    xml = z.read('word/document.xml')
    rels_path = 'word/_rels/document.xml.rels'
    rels = ET.fromstring(z.read(rels_path)) if rels_path in z.namelist() else []
    external = {r.get('Id'): r.get('Target', '') for r in rels
                if r.get('TargetMode') == 'External' and r.get('Type', '').endswith('/hyperlink')}
    images = [entry for entry in z.infolist() if entry.filename.startswith('word/media/') and entry.file_size <= 250000
              and entry.filename.lower().endswith(('.jpg', '.jpeg', '.png'))]
    photo = None
    if len(images) == 1:
        raw = z.read(images[0])
        mime = 'image/png' if raw.startswith(b'\x89PNG\r\n\x1a\n') else 'image/jpeg' if raw.startswith(b'\xff\xd8\xff') else None
        if mime:
            photo = {'mime': mime, 'base64': base64.b64encode(raw).decode('ascii')}
root = ET.fromstring(xml)
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
lines = []
links = []
for p in root.findall('.//w:p', ns):
    w = '{' + ns['w'] + '}'
    parts = []
    for run in p.findall('.//w:r', ns):
        for node in run:
            if node.tag == w + 't':
                parts.append(node.text or '')
            elif node.tag == w + 'tab':
                parts.append('\t')
            elif node.tag in (w + 'br', w + 'cr'):
                parts.append('\n')
    text = ''.join(parts)
    if text.strip():
        lines.append(text)
    if '链接' not in text or len(links) >= 24:
        continue
    field = ' '.join((t.text or '') for t in p.findall('.//w:instrText', ns))
    match = re.search(r'\bHYPERLINK\s+"(https?://[^"]+)"', field, re.I)
    urls = [match.group(1)] if match else []
    for link in p.findall('.//w:hyperlink', ns):
        urls.append(external.get(link.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'), ''))
    uri = next((u for u in urls if re.fullmatch(r'https?://[^\s<>"]{1,2000}', u, re.I)), None)
    if uri:
        links.append({'line': text.strip(), 'url': uri})
sys.stdout.write(json.dumps({'text': '\n'.join(lines), 'photo': photo, 'links': links}, ensure_ascii=False))
`;

const PDF_SCRIPT = String.raw`
import base64, io, json, re, sys
from pypdf import PdfReader
reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
parts = []
photo, links = None, []
for index, page in enumerate(reader.pages):
    try:
        text = page.extract_text() or ''
    except Exception:
        text = ''
    if text.strip():
        parts.append(text)
    if index == 0:
        try:
            if len(page.images) == 1:
                image = page.images[0]
                w, h = image.image.size
                mime = 'image/jpeg' if image.data.startswith(b'\xff\xd8\xff') else 'image/png' if image.data.startswith(b'\x89PNG\r\n\x1a\n') else None
                if mime and 0.45 <= w / h < 0.95 and len(image.data) <= 250000:
                    photo = {'mime': mime, 'base64': base64.b64encode(image.data).decode('ascii')}
        except Exception:
            pass
    try:
        project_lines, in_projects = [], False
        for line in text.splitlines():
            if line.strip() == '项目经历':
                in_projects = True
            elif re.fullmatch(r'(?:荣誉\s*[&＆与及]\s*技能|技能|教育背景|教育经历|实习经历|其他经历|其他)', line.strip()):
                in_projects = False
            elif in_projects and re.search(r'链接\s+\d{1,2}/20\d{2}\s*$', line):
                project_lines.append(line.strip())
        by_y = {}
        for ref in page.get('/Annots', []):
            annotation = ref.get_object()
            action = annotation.get('/A') or {}
            url = str(action.get('/URI') or '')
            if not re.fullmatch(r'https?://[^\s<>"]{1,2000}', url, re.I):
                continue
            x0, y0, x1, y1 = map(float, annotation['/Rect'])
            y = round((y0 + y1) / 2)
            if y not in by_y or by_y[y][0] < x0:
                by_y[y] = (x0, url)
        if project_lines and len(project_lines) == len(by_y) and len(links) + len(project_lines) <= 24:
            links.extend({'line': line, 'url': by_y[y][1]} for line, y in zip(project_lines, sorted(by_y, reverse=True)))
    except Exception:
        pass
sys.stdout.write(json.dumps({'text': '\n\n'.join(parts), 'photo': photo, 'links': links}, ensure_ascii=False))
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
  let photo = null;
  let links = [];
  if (ext === '.pdf' || normalizedMime === 'application/pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new AppError(422, 'RESUME_PARSE_FAILED', '文件不是有效的 PDF');
    format = 'pdf';
    ({ text, photo, links } = JSON.parse(await runPython(PDF_SCRIPT, buffer)));
  } else if (ext === '.docx' || normalizedMime.includes('officedocument.wordprocessingml.document')) {
    if (buffer.subarray(0, 2).toString('latin1') !== 'PK') throw new AppError(422, 'RESUME_PARSE_FAILED', '文件不是有效的 DOCX');
    format = 'docx';
    ({ text, photo, links } = JSON.parse(await runPython(DOCX_SCRIPT, buffer)));
  } else if (['.txt', '.md', '.markdown', ''].includes(ext) || normalizedMime.startsWith('text/')) {
    format = 'text';
    text = decodeText(buffer);
  } else {
    throw new AppError(415, 'RESUME_UNSUPPORTED', '首版支持 PDF、DOCX 和粘贴文本；请转换格式或直接粘贴简历文本');
  }
  text = cleanText(text);
  if (text.length < 20) throw new AppError(422, 'RESUME_TEXT_TOO_SHORT', '没有提取到足够的简历文本，请改用粘贴文本或检查文件');
  const truncated = text.length > MAX_RESUME_TEXT;
  return { text: text.slice(0, MAX_RESUME_TEXT), format, truncated, photo, links };
}
