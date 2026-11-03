import { api, errorText } from '../api.js';
import { h, clear, toast, idemKey } from '../util.js';

const endpoint = '/api/v1/admin/mail';
const statusText = { accepted: 'SMTP 已受理，请检查收件箱', outbox_written: '仅写本地文件，未发送真实邮件', sent: '批次已完成，请核对投递记录', failed: '失败', delivery_unknown: '送达未知，先检查收件箱再决定重发', skipped_empty: '没有符合条件的提醒', sending: '发送中' };
export async function renderMailAdmin(root, { isCurrent = () => true } = {}) {
  root.append(h('p', { text: '正在读取管理员邮件配置…' }));
  let data;
  try { data = (await api.get(endpoint)).data; } catch (err) { if (!isCurrent()) return; clear(root); root.append(h('p', { role: 'alert', text: errorText(err) }), h('a', { href: '/', text: '返回台账' })); return; }
  if (!isCurrent()) return;
  clear(root);
  const error = h('div', { class: 'mail-error', role: 'alert', tabindex: '-1', hidden: true });
  const announcement = h('div', { class: 'tn-hint', role: 'status', 'aria-live': 'polite' });
  const workspace = h('div', { class: 'mail-admin-grid' });
  const recordsHost = h('div', { 'data-test': 'mail-records' });
  root.append(h('div', { class: 'tn-row mail-admin-heading' }, h('div', { class: 'tn-grow' }, h('h1', { text: '邮件测试与模板' }), h('p', { text: '管理员专用 · 模板试发和业务触发分别验证 · 真实收到请到收件箱核对' })), h('a', { class: 'tn-btn', href: '/', text: '返回台账' }), h('a', { class: 'tn-btn', href: '/mail-selftest.html', target: '_blank', rel: 'noopener', text: '打开自测指南' })),
    h('div', { class: 'tn-hint', 'data-test': 'mail-environment', text: `当前环境：${data.transport === 'smtp' ? 'SMTP 真实发信' : 'outbox 仅本地文件'}；发件人：${data.from}。测试收件人由服务配置限定。保存模板立即影响本测试环境后续邮件；已发送邮件不变。` }), error, announcement, workspace,
    h('section', { class: 'mail-card' }, h('div', { class: 'tn-row' }, h('h2', { class: 'tn-grow', text: '触发与发送记录' }), button('刷新记录', loadRecords)), h('p', { text: 'SMTP 已受理不等于收件箱已收到。记录显示触发类型、使用版本、批次、邮件 ID 和安全的失败原因。真实验证码不记录正文。' }), recordsHost));
  let current = data.templates[0], preview = null, busy = false;
  const mode = h('select', { class: 'tn-select', id: 'mail-mode', 'data-test': 'mail-mode' }, h('option', { value: 'template', text: 'A · 仅测试模板发送' }), h('option', { value: 'business', text: 'B · 测试真实业务触发通路', disabled: !data.business_test_enabled }));
  const templateSelect = h('select', { class: 'tn-select', id: 'mail-template', 'data-test': 'mail-template' }, data.templates.map(t => h('option', { value: t.id, text: t.name })));
  const to = h('select', { class: 'tn-select', id: 'mail-recipient', 'data-test': 'mail-recipient' }, data.test_recipients.map(email => h('option', { value: email, text: email })));
  const appSelect = h('select', { class: 'tn-select', id: 'mail-application', 'data-test': 'mail-application' });
  function fillApplications() { clear(appSelect); appSelect.append(h('option', { value: '', text: '选择你在台账中提交的测试记录…' }), ...data.applications.map(x => h('option', { value: x.id, text: `${x.eligible ? '可提醒' : '当前无候选'} · ${x.company_name} · ${x.job_title} · ${x.id}` }))); }
  fillApplications();
  const subject = input('mail-subject'), text = area('mail-text', 7), html = area('mail-html', 10);
  const rulesBox = h('div'), variablesBox = h('div'), editor = h('section', { class: 'mail-card' });
  const purpose = h('p'), versionLabel = h('p', { 'data-test': 'mail-active-version' });
  const history = h('select', { class: 'tn-select', id: 'mail-history' });
  const save = button('保存并启用新版本', async () => {
    const saved = (await api.put(endpoint+'/templates/'+current.id, { template: draft(), expected_version: current.version, variables: variables() })).data;
    data.templates[data.templates.findIndex(x => x.id === current.id)] = { ...saved, history: [{ version: saved.version, actor: saved.actor, created_at: saved.created_at }, ...current.history] };
    current = data.templates.find(x => x.id === saved.id); fillEditor(current); toast('已保存 v'+saved.version+'；后续邮件立即生效', 'ok');
  }, 'mail-save');
  const restore = button('恢复所选版本并启用', async () => {
    const saved = (await api.post(endpoint+'/templates/'+current.id+'/restore', { version: Number(history.value), expected_version: current.version, variables: variables() })).data;
    const fresh = (await api.get(endpoint)).data;
    data = fresh; current = data.templates.find(x => x.id === saved.id); fillEditor(current); toast('已恢复为新版本 v'+saved.version, 'ok');
  });
  const loadOld = button('查看所选版本', async () => {
    const old = (await api.get(endpoint+'/templates/'+current.id+'/versions/'+history.value)).data;
    fillEditor(old, true); announcement.textContent = `正在编辑历史 v${old.version} 的副本；当前生效版本仍为 v${current.version}。保存后才会启用新版本。`;
  });
  let ruleFields, variableInputs;
  function invalidate() { preview = null; send.disabled = true; announcement.textContent = '内容已变化，请重新预览。'; }
  function draft() {
    const variable_max = {};
    for (const [name, el] of Object.entries(ruleFields.variable_max)) if (el.value.trim()) variable_max[name] = Number(el.value);
    return { subject: subject.value, text: text.value, html: html.value, rules: {
      required: Object.entries(ruleFields.required).filter(([, el]) => el.checked).map(([k]) => k), missing: ruleFields.missing.value, fallback: ruleFields.fallback.value,
      max_subject: Number(ruleFields.max_subject.value), max_text: Number(ruleFields.max_text.value), max_html: Number(ruleFields.max_html.value),
      variable_max, fixed: lines(ruleFields.fixed.value), forbidden: lines(ruleFields.forbidden.value)
    } };
  }
  function variables() { return Object.fromEntries(Object.entries(variableInputs).map(([k, el]) => [k, el.value])); }
  function fillEditor(doc, historical = false) {
    subject.value = doc.subject; text.value = doc.text; html.value = doc.html;
    purpose.textContent = current.purpose;
    versionLabel.textContent = `当前生效：v${current.version} · ${current.actor}；${historical ? '编辑历史版本的副本' : '编辑当前版本'}。双花括号输出转义文本；三花括号仅用于列明的系统 HTML 片段。`;
    if (!historical) { clear(history); history.append(...current.history.map(x => h('option', { value: x.version, text: `v${x.version} · ${x.actor}` }))); }
    clear(rulesBox); clear(variablesBox);
    const r = doc.rules;
    ruleFields = { required: {}, variable_max: {} };
    variablesBox.append(h('p', { text: '示例变量仅用于模板预览和试发。业务模式直接读取台账，不使用这些替换值。缺失策略测试可在“删除变量”中选择一项。' }));
    for (const [name, label] of Object.entries(current.variables)) {
      const essential = current.essential.includes(name);
      const check = h('input', { type: 'checkbox', checked: r.required.includes(name) || essential, disabled: essential });
      const max = h('input', { class: 'tn-input', type: 'number', min: '1', max: '150000', value: r.variable_max[name] || '', 'aria-label': name+' 最大字数' });
      ruleFields.required[name] = check; ruleFields.variable_max[name] = max;
      rulesBox.append(h('div', { class: 'mail-rule-row' }, h('label', {}, check, ` ${label}（${name}）${essential ? ' · 核心必填' : ''}`), h('label', {}, '变量最多字数（空为不限）', max)));
    }
    const missing = h('select', { class: 'tn-select', id: 'mail-missing' }, h('option', { value: 'error', text: '阻止发送并报错' }), h('option', { value: 'empty', text: '可选变量缺失时留空' }), h('option', { value: 'fallback', text: '可选变量缺失时使用替代文案' })); missing.value = r.missing;
    ruleFields.missing = missing; ruleFields.fallback = input('mail-fallback', r.fallback);
    rulesBox.append(field('变量缺失处理（核心及勾选必填字段始终阻止发送）', missing), field('替代文案', ruleFields.fallback));
    for (const [name, label] of [['max_subject', '主题最多字数'], ['max_text', '纯文本最多字数'], ['max_html', 'HTML 源码最多字数']]) {
      ruleFields[name] = h('input', { class: 'tn-input', id: 'mail-'+name, type: 'number', min: '1', value: r[name] }); rulesBox.append(field(label, ruleFields[name]));
    }
    for (const [name, label] of [['fixed', '必须出现的固定文案（每行一项）'], ['forbidden', '禁止出现的内容（每行一项，忽略大小写）']]) { ruleFields[name] = area('mail-'+name, 3); ruleFields[name].value = r[name].join('\n'); rulesBox.append(field(label, ruleFields[name])); }
    variableInputs = {};
    for (const [name, label] of Object.entries(current.variables)) {
      const el = area('mail-var-'+name, ['body_text','body_html','official_html'].includes(name) ? 4 : 2); el.value = current.sample[name] ?? ''; variableInputs[name] = el;
      variablesBox.append(field(`${label} · {{${name}}}${current.raw.includes(name) ? ' · 允许系统 HTML 片段' : ''}`, el));
    }
    clear(omitVariable); omitVariable.append(h('option', { value: '', text: '不删除变量' }), ...Object.keys(current.variables).map(k => h('option', { value: k, text: '删除变量 '+k })));
    invalidate();
  }
  const omitVariable = h('select', { class: 'tn-select', id: 'mail-omit-variable' });
  const previewHost = h('div', { 'data-test': 'mail-preview' });
  const previewDraft = button('预览编辑中的草稿（不发送）', () => showPreview(true), 'mail-preview-draft');
  const previewSaved = button('预览已保存版本／业务内容', () => showPreview(false), 'mail-preview-saved');
  const send = button('发送到所选测试邮箱', async () => {
    const payload = { ...preview.payload, to: to.value, expected_versions: preview.template_versions, data_revision: preview.data_revision, request_key: preview.request_key };
    const response = (await api.post(endpoint+'/send', payload)).data;
    announcement.textContent = `触发记录 ${response.run_id}：${statusText[response.status] || response.status}。${response.result?.error || ''}`;
    await loadRecords();
    send.disabled = true; preview = null;
  }, 'mail-send');
  send.disabled = true;
  const businessHelp = h('div', { class: 'tn-hint', hidden: true, text: '先返回台账手动补录一条今天的新记录，并开启“全部提醒”或“仅进展”。这里读取所选记录的真实未消费进展／到期回看，使用正式摘要生成和 SMTP 流程；测试批次跳过时间窗口，不消耗正式提醒，不证明 08:00 自动调度成功。先预览，再发送。修改卡片模板后可重复验证。' });
  const businessField = field('选择本人台账中的测试记录', appSelect); businessField.hidden = true;
  workspace.append(h('section', { class: 'mail-card' }, h('h2', { text: '1 · 选择测试路径' }), field('测试模式', mode), h('p', { id: 'mail-mode-help', text: '模板试发使用你填写的示例变量，只验证模板、SMTP 和收件箱，不会创建台账或业务事件。' }), field('指定测试收件邮箱', to), !data.test_recipients.length ? h('p', { role: 'alert', text: '尚未配置 TEST_MAIL_RECIPIENTS，请由服务管理员配置后重启。' }) : null, businessHelp, businessField, button('刷新台账记录', async () => { data = (await api.get(endpoint)).data; fillApplications(); invalidate(); }),
    h('h2', { text: '2 · 预览和发送' }), previewDraft, previewSaved, h('p', { text: '草稿仅供预览。发送始终使用已保存模板；试发主题固定带“自测”标识，收件人无法超出服务白名单。卡片单独试发不会自动套用整封摘要外壳。' }), previewHost, send), editor);
  editor.append(h('h2', { text: '模板编辑与约束' }), field('选择模板', templateSelect), purpose, versionLabel, field('邮件主题（卡片模板的主题仅用于单独试发）', subject), field('纯文本正文', text), field('HTML 正文（可用内联样式，禁止脚本、图片、表单及 CSS URL）', html), h('h3', { text: '发送前约束' }), h('p', { text: '按渲染后的内容校验；保存时也会用下方当前示例变量验证。固定／禁止文案按主题及正文合并检查，不支持正则表达式。' }), rulesBox, save,
    h('h3', { text: '版本历史' }), field('已保存版本', history), loadOld, restore,
    h('details', { open: true }, h('summary', { text: '测试变量与字段说明' }), variablesBox, field('模拟变量缺失（只影响预览和模板试发）', omitVariable)));
  function testVariables() { const vars = variables(); if (omitVariable.value) delete vars[omitVariable.value]; return vars; }
  async function showPreview(useDraft) {
    if (mode.value === 'business' && useDraft) throw new Error('业务预览使用已保存模板；请先保存修改，再点击“预览已保存版本／业务内容”。');
    const payload = mode.value === 'business' ? { mode: 'business', application_id: appSelect.value }
      : { mode: 'template', template_id: current.id, variables: testVariables(), ...(useDraft ? { draft: draft() } : {}) };
    if (!useDraft && mode.value === 'template' && JSON.stringify(draft()) !== JSON.stringify({ subject: current.subject, text: current.text, html: current.html, rules: current.rules })) {
      // 约束对象的键序可能不同，使用稳定逐字段比较。
      const d = draft(), same = ['subject','text','html'].every(k => d[k] === current[k]) && stable(d.rules) === stable(current.rules);
      if (!same) throw new Error('有未保存的模板修改，请保存并启用新版本，或切换模板重新加载，然后再预览已保存版本。');
    }
    const p = (await api.post(endpoint+'/preview', payload)).data;
    if (!isCurrent()) return;
    clear(previewHost);
    const frame = h('iframe', { title: '邮件 HTML 示例预览（不可操作）', sandbox: '', inert: true, tabindex: '-1', class: 'mail-preview-frame', referrerpolicy: 'no-referrer' });
    frame.src = p.preview_url;
    previewHost.append(h('h3', { text: useDraft ? '未保存草稿预览' : '发送内容预览' }), h('p', { text: '主题：'+p.subject }), h('p', { text: '使用版本：'+JSON.stringify(p.template_versions) }), p.note ? h('p', { text: p.note }) : null, frame, h('details', {}, h('summary', { text: '纯文本正文' }), h('pre', { class: 'mail-pre', text: p.text })), h('details', {}, h('summary', { text: '实际渲染 HTML 源码' }), h('pre', { class: 'mail-pre', text: p.html })));
    preview = useDraft ? null : { ...p, payload, request_key: idemKey('mailtest').replace(/[^a-zA-Z0-9_-]/g, '_') };
    send.disabled = useDraft || !to.value;
    announcement.textContent = useDraft ? '草稿校验通过；请保存后预览已保存版本再发送。' : '校验通过。确认收件人后点击发送；只有此操作会真实发信。';
  }
  async function loadRecords() {
    const r = (await api.get(endpoint+'/records')).data;
    if (!isCurrent()) return;
    clear(recordsHost);
    if (!r.runs.length && !r.deliveries.length) recordsHost.append(h('p', { text: '暂无记录。请先预览再发送。' }));
    for (const run of r.runs) recordsHost.append(h('article', { class: 'mail-record' }, h('strong', { text: `${run.mode === 'business' ? '业务通路' : '模板试发'} · ${statusText[run.status] || run.status}` }), h('p', { text: `${run.created_at} · 收件人 ${run.recipient} · 触发 ${run.id}` }), run.application_id ? h('a', { href: '/?app='+encodeURIComponent(run.application_id), text: '查看触发的台账记录' }) : null, h('p', { text: '模板版本：'+JSON.stringify(run.result.template_versions || {}) }), run.result.batch_id ? h('p', { text: '业务批次：'+run.result.batch_id }) : null, run.result.provider_message_id ? h('p', { text: '服务商邮件 ID：'+run.result.provider_message_id }) : null, run.result.error ? h('p', { role: 'alert', text: (run.result.error_code || '失败')+'：'+run.result.error }) : null, h('details', {}, h('summary', { text: '查看技术详情' }), h('pre', { class: 'mail-pre', text: JSON.stringify(run.result, null, 2) }))));
    recordsHost.append(h('h3', { text: '邮件投递记录（包含验证码和正式业务邮件）' }));
    for (const item of r.deliveries) recordsHost.append(h('article', { class: 'mail-record' }, h('strong', { text: `${statusText[item.status] || item.status} · ${item.kind}` }), h('p', { text: item.subject }), h('p', { text: `收件人：${item.recipient}；版本：${JSON.stringify(item.template_versions)}；邮件 ID：${item.provider_message_id || '暂无'}；时间：${item.created_at}` }), item.error_message ? h('p', { role: 'alert', text: `${item.error_code}：${item.error_message}` }) : null));
    if (r.batches.length) recordsHost.append(h('details', {}, h('summary', { text: '业务批次状态' }), h('pre', { class: 'mail-pre', text: JSON.stringify(r.batches, null, 2) })));
  }
  function button(label, action, test) {
    const el = h('button', { type: 'button', class: 'tn-btn', text: label, 'data-test': test, onclick: async () => {
      if (busy || !isCurrent()) return; busy = true; el.disabled = true; error.hidden = true;
      for (const inline of root.querySelectorAll('[data-mail-inline-error]')) inline.remove();
      for (const input of root.querySelectorAll('[aria-invalid]')) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
      try { await action(); } catch (err) {
        if (!isCurrent()) return;
        error.hidden = false; clear(error);
        error.append(h('strong', { text: errorText(err) }));
        for (const [index, item] of (err.details?.issues || []).entries()) {
          let control = { subject, text, html }[item.field];
          if (!control && item.field === 'variables') { const key = Object.keys(variableInputs || {}).find(k => item.message.includes(k)); control = variableInputs?.[key]; }
          if (!control && item.field === 'rules') control = rulesBox.querySelector('input,select,textarea');
          if (control?.id) {
            const id = 'mail-inline-error-'+index;
            control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-describedby', id);
            control.after(h('p', { id, class: 'tn-inline-msg err', 'data-mail-inline-error': 'true', text: item.message }));
            error.append(h('p', {}, h('a', { href: '#'+control.id, text: `${item.field} · ${item.rule}：${item.message}`, onclick: e => { e.preventDefault(); control.focus(); } })));
          } else error.append(h('p', { text: `${item.field} · ${item.rule}：${item.message}` }));
        }
        error.focus();
      } finally { busy = false; if (isCurrent() && el !== send) el.disabled = false; else if (isCurrent()) el.disabled = !preview; }
    } }); return el;
  }
  mode.addEventListener('change', () => { const b = mode.value === 'business'; businessField.hidden = !b; businessHelp.hidden = !b; previewDraft.hidden = b; document.getElementById('mail-mode-help').textContent = b ? '业务通路使用本人台账、候选筛选、当前模板和真实发送；测试记录独立保存。' : '模板试发使用示例变量，只验证模板、SMTP 和收件箱。'; invalidate(); });
  templateSelect.addEventListener('change', () => { current = data.templates.find(x => x.id === templateSelect.value); fillEditor(current); });
  editor.addEventListener('input', invalidate); editor.addEventListener('change', invalidate);
  appSelect.addEventListener('change', invalidate); to.addEventListener('change', invalidate);
  fillEditor(current); await loadRecords();
}
function input(id, value = '') { return h('input', { class: 'tn-input', id, value }); }
function area(id, rows) { return h('textarea', { class: 'tn-textarea', id, rows }); }
function field(label, control) { return h('div', { class: 'tn-field' }, h('label', { for: control.id || null, text: label }), control); }
function lines(value) { return value.split('\n').map(x => x.trim()).filter(Boolean); }
function stable(value) {
  const normalize = v => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
  return JSON.stringify(normalize(value));
}
