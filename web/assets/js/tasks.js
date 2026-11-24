/* v1.1.4 global background task tray: survives view changes, restores active
 * rewrite tasks from the server and reports mail sync completion. */
import { api } from './api.js';
import { h, clear } from './util.js';

let timer = null;
let tray = null;
let polling = false;
let previousMailStatus = null;
let seenRunning = new Set();
const notified = new Set();
let minimized = false;
let lastTaskKey = '';
let lastRender = {};

function ensureTray() {
  if (tray?.isConnected) return tray;
  tray = h('div', { class: 'tn-task-tray', id: 'tn-task-tray', 'data-test': 'task-tray', hidden: true });
  document.body.append(tray);
  return tray;
}
function notifyTask(text, actionText, href) {
  const box = document.getElementById('tn-toasts');
  if (!box) return;
  const node = h('div', { class: 'tn-toast ok tn-task-toast', 'data-test': 'task-toast' },
    h('span', { text }), h('button', { class: 'tn-task-toast-action', type: 'button', text: actionText, onclick: () => { location.assign(href); node.remove(); } }));
  box.append(node);
  setTimeout(() => node.remove(), 9000);
}
function renderTray({ rewrite = null, mail = null } = {}) {
  const node = ensureTray();
  const items = [];
  if (rewrite) items.push({ kind: 'rewrite', label: `正在改写简历 · ${rewrite.application?.company_name || rewrite.application?.job_title || '岗位'}（${Math.round(rewrite.progress_percent || 0)}%）`, href: `/?panel=career&section=rewrite&draft=${encodeURIComponent(rewrite.id)}` });
  if (mail) items.push({ kind: 'mail', label: '正在同步邮箱…', href: '/?panel=settings&tab=data' });
  clear(node);
  if (!items.length) { node.hidden = true; minimized = false; lastTaskKey = ''; return; }
  lastRender = { rewrite, mail };
  const key = items.map((item) => item.kind === 'rewrite' ? `rewrite:${rewrite?.id}` : `mail:${mail?.id}`).join('|');
  if (key !== lastTaskKey) { lastTaskKey = key; minimized = false; }
  const first = items[0];
  node.hidden = false;
  if (minimized) {
    node.append(h('button', { class: 'tn-task-tray-minimized', type: 'button', 'data-test': 'task-tray-expand', title: '展开任务条', text: '展开任务', onclick: () => { minimized = false; renderTray(lastRender); } }));
    return;
  }
  node.append(h('button', { class: 'tn-task-tray-main', type: 'button', 'data-test': 'task-tray-main', onclick: () => location.assign(first.href) },
    h('span', { class: 'tn-task-tray-pulse' }), h('span', { text: items.length > 1 ? `${first.label} · 另有 ${items.length - 1} 个任务` : first.label })));
  node.append(h('button', { class: 'tn-task-tray-min', type: 'button', 'data-test': 'task-tray-minimize', title: '最小化任务条', 'aria-label': '最小化任务条', text: '−', onclick: () => { minimized = true; renderTray(lastRender); } }));
}
async function poll() {
  if (polling || !document.getElementById('tn-root')) return;
  polling = true;
  try {
    const [draftRes, meRes] = await Promise.all([
      api.get('/api/v1/career-ai/rewrite-drafts/active', { silent401: true }),
      api.get('/api/v1/me', { silent401: true })
    ]);
    const drafts = Array.isArray(draftRes.data) ? draftRes.data : [];
    const running = drafts.find((d) => d.status === 'ready' && Number(d.progress_percent ?? 100) < 100) || null;
    for (const draft of drafts) {
      if (draft.status === 'ready' && Number(draft.progress_percent ?? 100) < 100) seenRunning.add(draft.id);
      if (seenRunning.has(draft.id) && (Number(draft.progress_percent ?? 100) >= 100 || draft.status === 'failed')) {
        if (!notified.has(draft.id)) {
          notified.add(draft.id);
          seenRunning.delete(draft.id);
          const app = draft.application || {};
          const label = `${app.company_name || '岗位'} · ${app.job_title || ''}`.trim();
          if (draft.status === 'failed') notifyTask(`「${label}」简历改写失败`, '去查看', `/?panel=career&section=rewrite&draft=${encodeURIComponent(draft.id)}`);
          else notifyTask(`「${label}」简历改写已完成`, '去查看', `/?panel=career&section=rewrite&draft=${encodeURIComponent(draft.id)}`);
        }
      }
    }
    const mail = meRes.data?.mail_connection;
    const mailRunning = mail?.status === 'syncing';
    if (previousMailStatus === 'syncing' && !mailRunning) {
      const stats = mail?.sync_stats || {};
      notifyTask(`邮箱同步完成：新增 ${stats.new ?? 0} 条，更新 ${stats.applied ?? 0} 条`, '刷新台账', '/');
      window.dispatchEvent(new CustomEvent('tounar:mail-synced', { detail: { connection_id: mail?.id } }));
    }
    previousMailStatus = mail?.status || null;
    renderTray({ rewrite: running, mail: mailRunning ? mail : null });
  } catch (error) {
    if (error?.status === 401) stopTaskManager();
  } finally {
    polling = false;
  }
}
export function startTaskManager() {
  if (timer) return;
  ensureTray();
  poll();
  timer = setInterval(poll, 5000);
  timer.unref?.();
}
export function stopTaskManager() {
  if (timer) clearInterval(timer);
  timer = null;
  polling = false;
  previousMailStatus = null;
  if (tray) { tray.remove(); tray = null; }
}
