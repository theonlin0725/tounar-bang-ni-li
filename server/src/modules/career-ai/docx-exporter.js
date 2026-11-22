import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

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
export function generateResumeDocx(text, { title = '简历' } = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const body = lines.map(paragraph).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1247" w:bottom="1134" w:left="1247" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
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
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/_rels/document.xml.rels', data: docRels }
  ]);
}
export function resumeDocxRelativePath(ownerId, resumeId) {
  return path.posix.join('resumes', String(ownerId).replace(/[^A-Za-z0-9_.-]/g, '_'), `${String(resumeId).replace(/[^A-Za-z0-9_.-]/g, '_')}.docx`);
}
export function writeResumeDocx({ ownerId, resumeId, text, title, relativePath = null }) {
  const rel = relativePath || resumeDocxRelativePath(ownerId, resumeId);
  const absolute = path.join(config.dataDir, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolute, generateResumeDocx(text, { title }), { mode: 0o600 });
  return { relativePath: rel, absolutePath: absolute, bytes: fs.statSync(absolute).size };
}
export function readResumeDocx(relativePath) {
  const safe = String(relativePath || '');
  if (!safe.startsWith('resumes/') || safe.includes('..')) return null;
  const absolute = path.join(config.dataDir, safe);
  return fs.existsSync(absolute) ? exactFile(absolute) : null;
}
function exactFile(absolute) { return { absolutePath: absolute, buffer: fs.readFileSync(absolute) }; }
