import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { config } from '../../config.js';
import { AppError } from '../../util.js';

/* Minimal, dependency-free OOXML writer. It intentionally uses a clean
 * standard layout for PDF/text sources; original .docx style preservation is
 * a separate fidelity track and is not claimed as pixel-perfect conversion. */
function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28); name.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
function xml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function isHeading(line) {
  const value = String(line || '').trim();
  if (!value || value.length > 36) return false;
  return /^(基本信息|个人信息|教育背景|教育经历|工作经历|实习经历|项目经历|校园经历|技能|技能证书|证书|获奖|荣誉|自我评价|求职意向|个人总结|专业技能|研究经历)$/.test(value)
    || /^[一二三四五六七八九十]+[、.]/.test(value)
    || /^[A-Z][A-Z\s&/]{3,}$/.test(value);
}
function paragraph(line, index) {
  const value = String(line || '').trim();
  if (!value) return '<w:p/>';
  const heading = isHeading(value);
  const bullet = /^[-*•·]\s+/.test(value);
  const style = heading ? 'ResumeHeading' : 'ResumeBody';
  const text = bullet ? value.replace(/^[-*•·]\s+/, '') : value;
  const prefix = bullet ? '• ' : '';
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/><w:spacing w:before="${heading ? 180 : 0}" w:after="${heading ? 80 : 70}" w:line="300" w:lineRule="auto"/>${bullet ? '<w:ind w:left="360" w:hanging="180"/>' : ''}</w:pPr><w:r><w:rPr>${heading ? '<w:b/><w:sz w:val="26"/><w:color w:val="1F5C45"/>' : '<w:sz w:val="21"/>'}</w:rPr><w:t xml:space="preserve">${xml(prefix + text)}</w:t></w:r></w:p>`;
}
function templateParagraph(block, index, photoDrawing, linkId, { spaceBefore, subtitle }) {
  const value = block.rewritten_text || block.original_text;
  const heading = block.kind === 'heading';
  const contact = block.section === '基本信息' && !heading;
  const name = contact && index === 0;
  const date = !heading && !block.editable && value.match(/\s+((?:\d{1,2}\/20\d{2}|20\d{2}[.\/-]\d{1,2})(?:\s*[-–—至]\s*(?:[\d./-]+|至今|今|Present))?)$/i);
  const entry = block.kind === 'entry' || Boolean(date);
  const bullet = !heading && !entry && (/^[·•●▪◦]|^[-*]\s|^(?:总\s*GPA|核心课程|证书技能|语言能力)[：:]/.test(block.original_text)
    || (['实习经历', '项目经历'].includes(block.section) && /^[^：:]{2,18}[：:]/.test(block.original_text)));
  const main = (bullet ? value.replace(/^[·•●▪◦]\s*|^[-*]\s+/, '') : date ? value.slice(0, date.index) : value);
  const eastAsia = xml(process.env.RESUME_CJK_FONT || (process.platform === 'darwin' ? 'Songti SC' : 'Noto Serif CJK SC'));
  const run = (content, extra = '') => '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="' + eastAsia + '"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/>' + extra
    + '<w:sz w:val="' + (name ? 32 : heading ? 24 : 22) + '"/><w:szCs w:val="' + (name ? 32 : heading ? 24 : 22) + '"/></w:rPr>'
    + content.split('\n').map((line) => '<w:t xml:space="preserve">' + xml(line) + '</w:t>').join('<w:br/>') + '</w:r>';
  const emphasis = heading || name || entry ? '<w:b/>' : subtitle ? '<w:b/><w:i/>' : '';
  const linkIndex = linkId ? main.lastIndexOf('链接') : -1;
  const label = bullet ? main.match(/^[^：:]{2,18}[：:]/)?.[0] : null;
  const content = linkIndex >= 0
    ? run(main.slice(0, linkIndex), emphasis) + '<w:hyperlink xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="' + linkId + '">'
      + run('链接', '<w:color w:val="800080"/><w:u w:val="single"/>') + '</w:hyperlink>' + run(main.slice(linkIndex + 2), emphasis)
    : label ? run('•     ' + label, '<w:b/>') + run(main.slice(label.length))
    : run((bullet ? '•     ' : '') + main, emphasis);
  return '<w:p><w:pPr>' + (heading ? '<w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="14" w:space="0" w:color="000000"/></w:pBdr>' : '')
    + (date ? '<w:tabs><w:tab w:val="right" w:pos="10997"/></w:tabs>' : '')
    + '<w:spacing w:before="' + (heading ? 195 : spaceBefore ? 170 : 0) + '" w:after="' + (name ? 285 : 0) + '" w:line="' + (name ? 400 : heading ? 300 : 274) + '" w:lineRule="exact"/>'
    + (bullet ? '<w:ind w:left="340" w:hanging="340"/>' : '') + (contact ? '<w:jc w:val="center"/>' : '') + '</w:pPr>'
    + content
    + (date ? '<w:r><w:tab/></w:r>' + run(date[1], '<w:i/>') : '') + (name ? photoDrawing : '') + '</w:p>';
}
export function generateResumeDocx(text, { title = '简历', blocks = null, photo = null } = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const imageExt = blocks && photo?.base64 ? ({ 'image/jpeg': 'jpeg', 'image/png': 'png' }[photo.mime]) : null;
  const drawing = imageExt ? '<w:r><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH><wp:positionV relativeFrom="margin"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="756000" cy="972000"/><wp:wrapNone/><wp:docPr id="1" name="简历照片"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="简历照片"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="756000" cy="972000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>' : '';
  const linkRels = [];
  const entry = (block) => block?.kind === 'entry';
  const datedSections = new Set();
  const body = blocks ? blocks.map((block, index) => {
    const linkId = block.link_url && /^https?:\/\//i.test(block.link_url) ? 'rIdLink' + index : null;
    if (linkId) linkRels.push('<Relationship Id="' + linkId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xml(block.link_url) + '" TargetMode="External"/>');
    const isEntry = ['实习经历', '项目经历'].includes(block.section) && entry(block);
    const spaceBefore = isEntry && datedSections.has(block.section);
    if (isEntry) datedSections.add(block.section);
    const subtitle = block.kind === 'subtitle' || (['实习经历', '教育背景', '教育经历'].includes(block.section)
      && !entry(block) && entry(blocks[index - 1]));
    return templateParagraph(block, index, drawing.replace('<wp:posOffset>0</wp:posOffset>', '<wp:posOffset>-72000</wp:posOffset>'), linkId, { spaceBefore, subtitle });
  }).join('') : lines.map(paragraph).join('');
  const margins = blocks ? 'w:top="454" w:right="454" w:bottom="454" w:left="454"' : 'w:top="1134" w:right="1247" w:bottom="1134" w:left="1247"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar ${margins} w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei"/><w:sz w:val="21"/><w:color w:val="222222"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="ResumeBody"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="ResumeHeading"><w:name w:val="Resume Heading"/><w:basedOn w:val="ResumeBody"/><w:next w:val="ResumeBody"/><w:qFormat/></w:style>
</w:styles>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  return zipStore([
    { name: '[Content_Types].xml', data: imageExt ? contentTypes.replace('</Types>', '<Default Extension="' + imageExt + '" ContentType="' + photo.mime + '"/></Types>') : contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/_rels/document.xml.rels', data: docRels.replace('</Relationships>',
      (imageExt ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/photo.' + imageExt + '"/>' : '')
      + linkRels.join('') + '</Relationships>') },
    ...(imageExt ? [{ name: 'word/media/photo.' + imageExt, data: Buffer.from(photo.base64, 'base64') }] : [])
  ]);
}
export function resumeDocxRelativePath(ownerId, resumeId) {
  return path.posix.join('resumes', String(ownerId).replace(/[^A-Za-z0-9_.-]/g, '_'), `${String(resumeId).replace(/[^A-Za-z0-9_.-]/g, '_')}.docx`);
}
export function verifySingleA4Docx(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tounar-page-check-'));
  try {
    const source = path.join(dir, 'resume.docx');
    fs.writeFileSync(source, buffer, { mode: 0o600 });
    let info;
    try {
      const env = { ...process.env, LC_ALL: 'C' };
      if (process.platform === 'darwin' && !env.FONTCONFIG_FILE) {
        const fonts = path.join(dir, 'fonts.conf');
        fs.writeFileSync(fonts, '<?xml version="1.0"?><fontconfig><dir>/System/Library/Fonts</dir><dir>/System/Library/Fonts/Supplemental</dir><dir>/Library/Fonts</dir><dir>'
          + xml(path.join(os.homedir(), 'Library', 'Fonts')) + '</dir><cachedir>' + xml(path.join(dir, 'font-cache')) + '</cachedir></fontconfig>', { mode: 0o600 });
        env.FONTCONFIG_FILE = fonts;
      }
      execFileSync(process.env.RESUME_SOFFICE_BIN || 'soffice', ['-env:UserInstallation=' + pathToFileURL(path.join(dir, 'profile')).href,
        '--headless', '--convert-to', 'pdf', '--outdir', dir, source], { timeout: 15000, stdio: 'pipe', env });
      info = execFileSync(process.env.RESUME_PDFINFO_BIN || 'pdfinfo', [path.join(dir, 'resume.pdf')], { timeout: 5000, encoding: 'utf8', env });
    } catch {
      throw new AppError(503, 'RESUME_PAGE_CHECK_UNAVAILABLE', '暂时无法验证 Word 页数；草稿已保留，请稍后再导出。');
    }
    if (!/^Pages:\s+1\s*$/m.test(info) || !/^Page size:.*\(A4\)/m.test(info)) {
      throw new AppError(422, 'RESUME_EXCEEDS_A4_PAGE', 'Word 排版超过一页 A4，请精简实习或项目描述后再导出。');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
export function writeResumeDocx({ ownerId, resumeId, text, title, buffer = null, relativePath = null }) {
  const rel = relativePath || resumeDocxRelativePath(ownerId, resumeId);
  const absolute = path.join(config.dataDir, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolute, buffer || generateResumeDocx(text, { title }), { mode: 0o600 });
  return { relativePath: rel, absolutePath: absolute, bytes: fs.statSync(absolute).size };
}
export function readResumeDocx(relativePath) {
  const safe = String(relativePath || '');
  if (!safe.startsWith('resumes/') || safe.includes('..')) return null;
  const absolute = path.join(config.dataDir, safe);
  return fs.existsSync(absolute) ? exactFile(absolute) : null;
}
function exactFile(absolute) { return { absolutePath: absolute, buffer: fs.readFileSync(absolute) }; }
