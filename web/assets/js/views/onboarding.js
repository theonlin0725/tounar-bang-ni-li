/* v1.1.5 first-run progressive guide. Per-user localStorage only; never gates
 * normal navigation and never sends credentials.
 *
 * Four real completion gates:
 *   1. plugin installed/paired
 *   2. at least one job captured into the ledger
 *   3. mailbox authorized and connected
 *   4. completion acknowledged with "开始使用"
 * "稍后再说 / 稍后同步" only hides this mount for the current page visit. It
 * never writes a permanent done flag, so returning to the ledger or refreshing
 * re-evaluates and shows the unfinished step again. */
import { api } from '../api.js';
import { h, clear } from '../util.js';
import { PLUGIN_VERSION, pluginDownloadLink } from './plugin-help.js?v=20261125-1';

const KEY_PREFIX = 'tounar.onboarding.v115.';
const STEP_NAMES = ['插件', '抓岗', '邮箱', '完成'];

function keyFor(email) { return KEY_PREFIX + String(email || 'anonymous'); }
function readState(email) {
  try {
    const raw = localStorage.getItem(keyFor(email));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeState(email, state) {
  try { localStorage.setItem(keyFor(email), JSON.stringify(state)); } catch { /* storage unavailable */ }
}
function isCompleted(email) { return readState(email)?.completed === true; }
function probeExtension() {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener('message', receive); resolve(null); }, 1200);
    function receive(event) {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'tounar-access-response' || event.data.id !== id) return;
      clearTimeout(timer); window.removeEventListener('message', receive);
      resolve(event.data.ok ? event.data.data : null);
    }
    window.addEventListener('message', receive);
    window.postMessage({ channel: 'tounar-access-request', id, action: 'discovery', payload: {} }, location.origin);
  });
}
function pulseDemo() {
  return h('div', { class: 'tn-onboarding-demo', 'aria-hidden': 'true' },
    h('div', { class: 'tn-onboarding-window' }, h('div', { class: 'tn-onboarding-dot' }), h('div', { class: 'tn-onboarding-line' }), h('div', { class: 'tn-onboarding-line short' })),
    h('div', { class: 'tn-onboarding-float' }, h('span', { text: '岗位已收纳' })),
    h('div', { class: 'tn-onboarding-ledger-card' }, h('strong', { text: '字节跳动 · 产品经理' }), h('span', { text: '看过没投' }))
  );
}
function mailDemo() {
  return h('div', { class: 'tn-onboarding-demo mail', 'aria-hidden': 'true' },
    h('div', { class: 'tn-onboarding-envelope', text: '✉' }),
    h('div', { class: 'tn-onboarding-flow', text: '笔试 / 面试 / 拒信 → 台账状态自动更新' }),
    h('div', { class: 'tn-onboarding-status' }, h('span', { text: '已投递' }), h('span', { class: 'is-change', text: '面试中' }))
  );
}

/* The only source of truth for the current step. Step 1 is a transient
 * "detecting" state and is never persisted. */
function evaluateCompletion({ paired, jobs, mailBound }) {
  if (!paired) return 2;
  if (!(jobs > 0)) return 3;
  if (!mailBound) return 4;
  return 5;
}

export function mountOnboardingGuide(host, { email } = {}) {
  if (!host) return;
  if (isCompleted(email)) return;
  host.dataset.onboardingActive = '1';
  let disposed = false;
  let poll = null;
  const data = { step: 1, loading: true, error: null, paired: false, jobs: 0, mailBound: false };

  function stopPoll() {
    if (poll) { clearInterval(poll); poll = null; }
  }
  function hide() {
    disposed = true;
    stopPoll();
    delete host.dataset.onboardingActive;
    clear(host);
  }
  // "稍后再说" / "稍后同步": hide only this mount. No persistent write.
  function dismissTemporarily() { hide(); }
  // "开始使用": write the permanent completion flag only after all four gates.
  function markAllCompleted() {
    if (evaluateCompletion(data) !== 5) return;
    writeState(email, {
      completed: true,
      version: '1.1.5',
      completed_at: new Date().toISOString()
    });
    hide();
  }

  const render = () => {
    if (disposed || !host.isConnected) return;
    clear(host);
    if (data.loading) {
      host.append(h('div', { class: 'tn-onboarding tn-onboarding-loading', 'data-test': 'onboarding-guide' },
        h('span', { class: 'tn-onboarding-pulse' }), '正在准备首次使用引导…'));
      return;
    }
    const card = h('section', { class: 'tn-onboarding', 'data-test': 'onboarding-guide' });
    const doneCount = data.step === 5 ? 4 : Math.max(0, data.step - 1);
    const progress = h('div', {
      class: 'tn-onboarding-progress', 'data-test': 'onboarding-progress',
      'aria-label': `已完成 ${doneCount} / 4 步`
    },
    h('span', { class: 'tn-onboarding-progress-count', text: `${doneCount}/4` }),
    h('div', { class: 'tn-onboarding-progress-steps' }, ...STEP_NAMES.map((name, index) => {
      const done = index < doneCount;
      const current = index === doneCount && data.step < 5;
      return h('span', { class: `tn-onboarding-progress-step${done ? ' done' : ''}${current ? ' current' : ''}` },
        h('span', { class: 'tn-onboarding-progress-dot', text: done ? '✓' : String(index + 1) }),
        h('span', { class: 'tn-onboarding-progress-name', text: name }));
    })));
    const head = h('div', { class: 'tn-onboarding-head' },
      h('div', {}, h('strong', { text: data.step === 5 ? '已准备就绪' : '开始使用帮你理' }),
        h('span', { class: 'tn-small tn-muted', text: data.step === 5 ? '插件、岗位采集与邮箱同步均已完成' : '四步完成采集、授权和邮件同步' })),
      data.step === 5 ? null : h('button', {
        class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'onboarding-skip',
        text: '稍后再说', onclick: dismissTemporarily
      }));
    card.append(head, progress);
    const stepBody = (icon, title, desc, actions, extra = null) => h('div', { class: 'tn-onboarding-body' },
      h('div', { class: 'tn-onboarding-icon', text: icon }),
      h('div', { class: 'tn-onboarding-main' }, h('strong', { text: title }), h('p', { class: 'tn-small tn-muted', text: desc }),
        extra, h('div', { class: 'tn-action-row' }, ...actions)));
    if (data.step === 1) {
      card.append(h('div', { class: 'tn-onboarding-body' },
        h('div', { class: 'tn-onboarding-pulse' }), h('div', {}, h('strong', { text: '正在检测浏览器插件…' }),
          h('p', { class: 'tn-small tn-muted', text: '检测到已连接插件后会直接进入下一步。' }))));
    } else if (data.step === 2) {
      card.append(stepBody('1', '装好插件，逛招聘页顺手就能记下岗位',
        '下载解压 → Chrome 扩展管理 → 加载已解压的扩展程序 → 回到本页点击检测。',
        [pluginDownloadLink({ class: 'tn-btn tn-btn-primary tn-btn-sm', label: `下载插件包（v${PLUGIN_VERSION}）`, test: 'onboarding-plugin-download' }),
          h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'onboarding-probe', text: '已完成，重新检测', onclick: refresh })]));
    } else if (data.step === 3) {
      card.append(stepBody('2', '直接浏览，3秒入库',
        '去 Boss / 官网打开任意岗位详情页，插件会自动收纳到「看过没投」。',
        [h('a', { class: 'tn-btn tn-btn-sm', href: 'https://www.zhipin.com/', target: '_blank', rel: 'noopener noreferrer', text: '打开 Boss' }),
          h('a', { class: 'tn-btn tn-btn-sm', href: 'https://jobs.bytedance.com/', target: '_blank', rel: 'noopener noreferrer', text: '打开字节招聘' }),
          h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'onboarding-refresh', text: '我已试过，刷新看看', onclick: refresh })], pulseDemo()));
    } else if (data.step === 4) {
      card.append(stepBody('3', '自动同步更新你的投递状态',
        '授权邮箱后，笔试、面试、拒信会自动识别并更新台账；你也可以随时关闭。',
        [h('a', { class: 'tn-btn tn-btn-primary tn-btn-sm', href: '/?panel=settings&tab=data#tn-mail-section', 'data-test': 'onboarding-mail', text: '去授权邮箱' }),
          h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '稍后同步', onclick: dismissTemporarily })], mailDemo()));
    } else {
      card.append(stepBody('✓', '你的采集、同步和助手已准备就绪',
        '之后可随时在设置里管理插件、邮箱和提醒。',
        [h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'onboarding-done', text: '开始使用', onclick: markAllCompleted })]));
      card.querySelector('.tn-onboarding-icon')?.classList.add('ok');
    }
    if (data.error) card.append(h('div', { class: 'tn-small tn-error', text: data.error }));
    host.append(card);
  };

  function next(step) {
    stopPoll();
    data.step = step;
    data.loading = false;
    data.error = null;
    render();
  }
  function startPolling() {
    stopPoll();
    if (disposed || !host.isConnected) return;
    if (data.step === 2) {
      poll = setInterval(async () => {
        if (disposed || !host.isConnected) { stopPoll(); return; }
        const detected = await probeExtension();
        if (detected?.paired) { stopPoll(); refresh(); }
      }, 2500);
    } else if (data.step === 3 || data.step === 4) {
      poll = setInterval(async () => {
        if (disposed || !host.isConnected) { stopPoll(); return; }
        try {
          const [applied, viewed, me] = await Promise.all([
            api.get('/api/v1/ledger?view=applied&limit=1'),
            api.get('/api/v1/ledger?view=viewed&limit=1'),
            api.get('/api/v1/me')
          ]);
          if (disposed) return;
          const jobs = Number(applied.data?.stats?.total_applied || 0) + Number(viewed.data?.counts?.viewed || 0);
          const mailBound = ['connected', 'degraded'].includes(me.data?.mail_connection?.status);
          if (data.step === 3 && jobs > 0) { stopPoll(); refresh(); }
          else if (data.step === 4 && mailBound) { stopPoll(); refresh(); }
        } catch { /* transient */ }
      }, 2500);
    }
  }
  async function refresh() {
    if (disposed) return;
    stopPoll();
    data.loading = true;
    data.error = null;
    render();
    try {
      const [meRes, applied, viewed] = await Promise.all([
        api.get('/api/v1/me'),
        api.get('/api/v1/ledger?view=applied&limit=1'),
        api.get('/api/v1/ledger?view=viewed&limit=1')
      ]);
      if (disposed) return;
      const me = meRes.data;
      const jobs = Number(applied.data?.stats?.total_applied || 0) + Number(viewed.data?.counts?.viewed || 0);
      const plugin = await probeExtension();
      if (disposed) return;
      const paired = Boolean(plugin?.paired) || (me.plugin_devices || []).some((device) => !device.server_revoked_at);
      const mailBound = Boolean(me.mail_connection) && ['connected', 'degraded'].includes(me.mail_connection.status);
      data.paired = paired;
      data.jobs = jobs;
      data.mailBound = mailBound;
      next(evaluateCompletion({ paired, jobs, mailBound }));
      startPolling();
    } catch (error) {
      data.loading = false;
      data.error = error?.message || '首次引导加载失败';
      render();
    }
  }
  refresh();
  return () => { disposed = true; stopPoll(); };
}
