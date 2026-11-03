import fs from 'node:fs';
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(line) {
  const codes = [];
  let text = escape(line).replace(/`([^`]+)`/g, (_, code) => { codes.push('<code>'+code+'</code>'); return 'CODETOKEN'+(codes.length-1)+'END'; });
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/https?:\/\/[^\s<>，；）]+/g, url => '<a href="'+url+'">'+url+'</a>');
  return text.replace(/CODETOKEN(\d+)END/g, (_, index) => codes[Number(index)]);
}
const lines = fs.readFileSync(new URL('../docs/MAIL-SELFTEST-GUIDE.md', import.meta.url), 'utf8').split('\n');
const output = []; let code = false, table = false, list = null;
function closeBlocks() { if (table) { output.push('</tbody></table></div>'); table = false; } if (list) { output.push('</'+list+'>'); list = null; } }
for (const line of lines) {
  if (line.startsWith('```')) { closeBlocks(); output.push(code ? '</code></pre>' : '<pre><code>'); code = !code; continue; }
  if (code) { output.push(escape(line)+'\n'); continue; }
  if (line.startsWith('|')) {
    if (list) { output.push('</'+list+'>'); list = null; }
    if (!table) { output.push('<div class="table-wrap"><table><tbody>'); table = true; }
    if (/^[|\s:-]+$/.test(line)) continue;
    output.push('<tr>'+line.replace(/^\||\|$/g,'').split('|').map(cell => '<td>'+inline(cell.trim())+'</td>').join('')+'</tr>'); continue;
  }
  if (table) { output.push('</tbody></table></div>'); table = false; }
  const item = line.match(/^(?:([-])|\d+\.)\s+(.+)/);
  if (item) { const kind = item[1] ? 'ul' : 'ol'; if (list !== kind) { closeBlocks(); list = kind; output.push('<'+kind+'>'); } output.push('<li>'+inline(item[2])+'</li>'); continue; }
  if (list) { output.push('</'+list+'>'); list = null; }
  const heading = line.match(/^(#{1,6})\s+(.+)/);
  if (heading) output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
  else if (line.trim()) output.push('<p>'+inline(line)+'</p>');
}
closeBlocks();
fs.writeFileSync(new URL('../web/mail-selftest.html', import.meta.url), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>帮你理 · 真实邮件自测指南</title><link rel="stylesheet" href="/assets/mail-guide.css"></head><body><nav><a href="/?panel=mail-admin">打开邮件测试与模板</a> · <a href="/">返回台账</a></nav><main>'+output.join('\n')+'</main></body></html>');
console.log('已更新浏览器自测指南。');
