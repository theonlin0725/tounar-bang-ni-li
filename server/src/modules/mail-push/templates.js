import { all, one, run, transaction } from '../../db.js';
import { AppError, escapeHtml, nowIso } from '../../util.js';
import { templateDefaults } from './template-defaults.js';

const variablePattern = /\{\{\{\s*([a-z_]+)\s*\}\}\}|\{\{\s*([a-z_]+)\s*\}\}/g;
const length = value => [...String(value)].length;
const issue = (field, rule, message) => ({ field, rule, message });
function fail(issues) { throw new AppError(422, 'TEMPLATE_INVALID', issues.map(x => x.message).join('；'), { details: { issues } }); }
function known(id) {
  if (!Object.hasOwn(templateDefaults, id)) throw new AppError(404, 'NOT_FOUND', '模板不存在');
  return templateDefaults[id];
}
export function checkHtml(html) {
  // 邮件只允许展示标签；所有链接必须为 http(s)，禁止脚本、事件、表单、远程图片与 CSS URL。
  const tags = new Set('html body main article section header footer h1 h2 h3 h4 p div span strong b em i small br hr a table tbody thead tr td th ul ol li'.split(' '));
  if (/<!--|<!\[(?!CDATA)|<\?|[\u0000-\u0008]/i.test(html)) return false;
  const stripped = html.replace(/<!doctype html>/ig, '').replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/ig, (full, tag, attrs) => {
    if (!tags.has(tag.toLowerCase())) return '\u0000';
    let invalid = false;
    const rest = attrs.replace(/\s+([a-z][a-z0-9-]*)\s*=\s*("[^"]*"|'[^']*')/ig, (_, key, quoted) => {
      const value = quoted.slice(1, -1);
      if (!['style', 'href', 'lang', 'class', 'role', 'align', 'width', 'cellpadding', 'cellspacing', 'border'].includes(key.toLowerCase())) invalid = true;
      if (key.toLowerCase() === 'href' && !/^(https?:\/\/[^\s<>"']+|\{\{\s*[a-z_]+\s*\}\})$/i.test(value)) invalid = true;
      if (key.toLowerCase() === 'href' && /&(?:#|[a-z]+;)/i.test(value.replace(/&amp;/g, '&'))) invalid = true;
      if (key.toLowerCase() === 'style' && /url|expression|@|\\|&|[<>]/i.test(value)) invalid = true;
      return '';
    }).trim().replace(/\/$/, '');
    return invalid || rest ? '\u0000' : '';
  });
  return !/[<>\u0000]/.test(stripped);
}
export function getTemplate(id, version = null) {
  const base = known(id);
  if (version !== null && (!Number.isInteger(Number(version)) || Number(version) < 1)) throw new AppError(400, 'VALIDATION_ERROR', '版本号必须为正整数');
  const row = version ? one('SELECT * FROM mail_template_versions WHERE template_id=? AND version=?', [id, Number(version)])
    : one('SELECT * FROM mail_template_versions WHERE template_id=? ORDER BY version DESC LIMIT 1', [id]);
  if (!row && version && Number(version) !== 1) throw new AppError(404, 'NOT_FOUND', '模板版本不存在');
  return { id, ...base, ...(row ? JSON.parse(row.definition_json) : {}), version: row?.version || 1, actor: row?.actor || '系统默认', created_at: row?.created_at || null };
}
export function templateHistory(id) {
  known(id);
  const rows = all('SELECT version,actor,created_at FROM mail_template_versions WHERE template_id=? ORDER BY version DESC', [id]);
  if (!rows.some(x => x.version === 1)) rows.push({ version: 1, actor: '系统默认', created_at: null });
  return rows;
}
export function validateDefinition(id, input) {
  const base = known(id), issues = [];
  const allowed = ['subject', 'text', 'html', 'rules'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail([issue('template', 'type', '模板必须是一个对象')]);
  const doc = Object.fromEntries(allowed.map(k => [k, input[k]]));
  for (const field of ['subject', 'text', 'html']) {
    if (typeof doc[field] !== 'string' || !doc[field].trim() || doc[field].length > 150000) issues.push(issue(field, 'required', `${field} 必须填写，且不得超过 150000 字符`));
    else {
      const leftovers = doc[field].replace(variablePattern, (_, raw, normal) => {
        const key = raw || normal;
        if (!Object.hasOwn(base.variables, key)) issues.push(issue(field, 'unknown_variable', `${field} 中变量 ${key} 不存在，请使用变量表中的名称`));
        if (raw && (field !== 'html' || !base.raw.includes(key))) issues.push(issue(field, 'raw_variable', `${key} 不允许作为原始 HTML 使用；普通变量使用双花括号`));
        return '';
      });
      if (/[{}]{2}/.test(leftovers)) issues.push(issue(field, 'syntax', `${field} 花括号语法错误，只支持 {{变量}} 和指定的 {{{HTML变量}}}`));
    }
  }
  if (typeof doc.subject === 'string' && /[\r\n]/.test(doc.subject)) issues.push(issue('subject', 'header', '主题不能包含换行'));
  if (typeof doc.html === 'string' && !checkHtml(doc.html)) issues.push(issue('html', 'safe_html', 'HTML 含不支持的标签、属性或链接；请使用展示标签、带引号属性和 http(s) 链接，移除脚本、图片、表单及 CSS URL'));
  const r = doc.rules;
  if (!r || typeof r !== 'object' || Array.isArray(r)) issues.push(issue('rules', 'type', '约束必须是 JSON 对象'));
  else {
    const keys = ['required', 'missing', 'fallback', 'max_subject', 'max_text', 'max_html', 'variable_max', 'fixed', 'forbidden'];
    for (const key of Object.keys(r)) if (!keys.includes(key)) issues.push(issue('rules', 'unknown_rule', `未知约束 ${key}，请删除或按指南使用支持的规则`));
    for (const key of ['required', 'fixed', 'forbidden']) if (!Array.isArray(r[key]) || r[key].length > 50 || r[key].some(v => typeof v !== 'string' || !v.trim() || v.length > 500)) issues.push(issue('rules', 'array', `${key} 必须是最多 50 项的非空字符串数组`));
    if (Array.isArray(r.required)) for (const key of r.required) if (!Object.hasOwn(base.variables, key)) issues.push(issue('rules', 'unknown_variable', `必填变量 ${key} 不存在`));
    if (!['error', 'empty', 'fallback'].includes(r.missing)) issues.push(issue('rules', 'missing', 'missing 只能是 error、empty 或 fallback'));
    if (typeof r.fallback !== 'string' || r.fallback.length > 500) issues.push(issue('rules', 'fallback', 'fallback 必须是最多 500 字的文本'));
    for (const [key, limit] of [['max_subject', 500], ['max_text', 150000], ['max_html', 150000]]) if (!Number.isInteger(r[key]) || r[key] < 1 || r[key] > limit) issues.push(issue('rules', 'length', `${key} 必须是 1～${limit} 的整数`));
    if (!r.variable_max || typeof r.variable_max !== 'object' || Array.isArray(r.variable_max)) issues.push(issue('rules', 'variable_max', 'variable_max 必须是变量名到正整数的对象'));
    else for (const [key, max] of Object.entries(r.variable_max)) if (!Object.hasOwn(base.variables, key) || !Number.isInteger(max) || max < 1 || max > 150000) issues.push(issue('rules', 'variable_max', `${key} 的长度限制无效，请使用已知变量和 1～150000 的整数`));
  }
  for (const key of base.essential) {
    const re = new RegExp('\\{\\{\\{?\\s*' + key + '\\s*\\}\\}\\}?');
    if (!['subject', 'text', 'html'].some(f => typeof doc[f] === 'string' && re.test(doc[f]))) issues.push(issue('template', 'essential', `必须保留核心变量 ${key}，不能移除业务内容或操作入口`));
  }
  if (id === 'otp') for (const field of ['text', 'html']) for (const key of ['code', 'ttl_minutes']) if (!new RegExp('\\{\\{\\s*'+key+'\\s*\\}\\}').test(doc[field] || '')) issues.push(issue(field, 'essential', `${field} 必须保留 {{${key}}}`));
  const requiredByField = id === 'reminder' ? { text: ['body_text'], html: ['body_html'] }
    : { text: base.essential, html: base.essential };
  for (const [field, keys] of Object.entries(requiredByField)) for (const key of keys) {
    if (!new RegExp('\\{\\{\\{?\\s*'+key+'\\s*\\}\\}\\}?').test(doc[field] || '')) issues.push(issue(field, 'essential', `${field} 必须保留核心变量 ${key}，保证纯文本与 HTML 都有完整信息`));
  }
  if (issues.length) fail(issues);
  return doc;
}
export function renderTemplate(id, variables, override = null) {
  const current = getTemplate(id), doc = override ? { ...current, ...validateDefinition(id, override), version: '未保存草稿' } : current;
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) fail([issue('variables', 'type', '测试变量必须是 JSON 对象')]);
  const vars = { ...variables }, issues = [];
  for (const [key, value] of Object.entries(vars)) {
    if (!Object.hasOwn(doc.variables, key)) issues.push(issue('variables', 'unknown_variable', `变量 ${key} 不存在，请删除或使用变量表中的字段`));
    if (typeof value !== 'string' && typeof value !== 'number') issues.push(issue('variables', 'type', `${key} 必须为字符串或数字`));
  }
  for (const key of new Set([...doc.essential, ...doc.rules.required])) if (vars[key] == null || !String(vars[key]).trim()) issues.push(issue('variables', 'required', `必填变量 ${key} 缺失，请补齐`));
  for (const [key, max] of Object.entries(doc.rules.variable_max)) if (vars[key] != null && length(vars[key]) > max) issues.push(issue('variables', 'variable_max', `${key} 超过 ${max} 字，请缩短`));
  const substitute = (source, field) => source.replace(variablePattern, (_, raw, normal) => {
    const key = raw || normal;
    let value = vars[key];
    if (value == null) {
      if (doc.rules.missing === 'error') issues.push(issue('variables', 'missing', `变量 ${key} 缺失；请填写或将缺失策略改为 empty / fallback`));
      value = doc.rules.missing === 'fallback' ? doc.rules.fallback : '';
    }
    if (raw) { if (!checkHtml(String(value))) issues.push(issue('variables', 'safe_html', `${key} 含不安全的 HTML，请移除脚本、非法标签或链接`)); return String(value); }
    return field === 'html' ? escapeHtml(String(value)) : String(value);
  });
  const result = Object.fromEntries(['subject', 'text', 'html'].map(field => [field, substitute(doc[field], field)]));
  if (/[\r\n]/.test(result.subject)) issues.push(issue('subject', 'header', '渲染后主题含换行，请修正测试变量或主题'));
  if (!checkHtml(result.html)) issues.push(issue('html', 'safe_html', '渲染后链接或 HTML 不安全，请检查变量，链接必须使用 http(s)'));
  for (const field of ['subject', 'text', 'html']) if (length(result[field]) > doc.rules['max_'+field]) issues.push(issue(field, 'length', `${field} 渲染后超过 ${doc.rules['max_'+field]} 字，请缩短内容或提高限制`));
  const decode = value => value.replace(/&#(x[0-9a-f]+|[0-9]+);/ig, (_, n) => { const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1),16) : Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; }).replace(/&nbsp;/ig, ' ').replace(/&amp;/ig, '&');
  const combined = `${result.subject}\n${result.text}\n${decode(result.html.replace(/<[^>]*>/g, ''))}`;
  for (const word of doc.rules.fixed) if (!combined.includes(word)) issues.push(issue('rules', 'fixed', `缺少固定文案“${word}”，请加入主题或正文`));
  for (const word of doc.rules.forbidden) if (combined.toLowerCase().includes(word.toLowerCase())) issues.push(issue('rules', 'forbidden', `含禁止内容“${word}”，请删除或更正`));
  if (issues.length) fail(issues);
  return { ...result, template_id: id, version: doc.version };
}
export function saveTemplate(id, input, expectedVersion, actor, validationVariables = null) {
  const doc = validateDefinition(id, input);
  // 保存前使用系统示例渲染，避免保存无法正常展示的版本。
  const sample = validationVariables || templateDefaults[id].sample;
  renderTemplate(id, sample, doc);
  doc.sample = { ...sample };
  return transaction(() => {
    const previous = getTemplate(id);
    if (Number(expectedVersion) !== previous.version) throw new AppError(409, 'VERSION_CONFLICT', '模板已被其他页面修改，请重新加载后再保存');
    if (previous.version === 1) run('INSERT OR IGNORE INTO mail_template_versions VALUES (?,1,?,?,?)', [id, JSON.stringify(Object.fromEntries(['subject','text','html','rules'].map(k => [k, previous[k]]))), '系统默认', nowIso()]);
    run('INSERT INTO mail_template_versions VALUES (?,?,?,?,?)', [id, previous.version + 1, JSON.stringify(doc), actor, nowIso()]);
    return getTemplate(id);
  });
}
