/* 通用工具：DOM 构建、转义、时间/状态格式化、弹窗与 toast。
   规则：所有外部不可信文本（公司、岗位、证据、错误消息）只经 h()/textContent 写入，绝不拼 HTML。 */

export const STATUS_LABELS = {
  pending: '待投递',
  applied: '已投递',
  assessment: '笔试/测评',
  interview: '面试中',
  offer: 'Offer',
  rejected: '已拒绝',
  closed: '已结束'
};
export const STATUS_ORDER = ['pending', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'closed'];
export const APPLIED_STATUSES = ['applied', 'assessment', 'interview', 'offer', 'rejected', 'closed'];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function statusChip(status, { withLabel = true } = {}) {
  const label = STATUS_LABELS[status] || status || '未知';
  return h('span', { class: `tn-status status-${status || 'closed'}`, text: withLabel ? label : '' });
}

/* 时间显示：一律按上海时区展示（口径与后台一致；不用于算天数） */
const dtf = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});
const df = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return dtf.format(d).replace(/\//g, '-');
}
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return df.format(d).replace(/\//g, '-');
}
export function fmtDateShort(iso) { return fmtDate(iso).slice(5); }

export function relativeTime(iso) {
  if (!iso) return null;
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return null;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return fmtDate(iso);
}

/* 已投天数：采用后台算好的 days_since_applied（上海口径），前端不自行计算 */
export function daysText(days) {
  if (days === null || days === undefined) return '投递时间待补';
  if (days === 0) return '今天投递';
  if (days < 0) return '时间待核对';
  return `已投 ${days} 天`;
}

export function idemKey(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `web-${prefix}-${Date.now().toString(36)}-${rand}`;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* 极简 Markdown 无关：纯文本只保留换行 */
export function textBlock(value) {
  return h('div', { class: 'tn-pre-wrap', text: value ?? '—' });
}

/* ---------- Toast ---------- */
export function toast(message, kind = 'info') {
  const box = document.getElementById('tn-toasts');
  const node = h('div', { class: `tn-toast ${kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : ''}`, text: message });
  box.append(node);
  setTimeout(() => node.remove(), kind === 'err' ? 5200 : 3200);
}

/* 带操作的 toast：用于「已更新 … 撤销」。默认停留 10 秒（用户要求 10 秒内可撤销）。
   操作按钮必须能点：.tn-toasts 整体 pointer-events:none，这里单独放开。 */
export function toastAction(message, { actionLabel = '撤销', onAction, kind = 'ok', timeout = 10000 } = {}) {
  const box = document.getElementById('tn-toasts');
  let settled = false;
  const node = h('div', { class: `tn-toast has-action ${kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : ''}` },
    h('span', { class: 'tn-toast-text', text: message })
  );
  const timer = setTimeout(() => { if (!settled) { settled = true; node.remove(); } }, timeout);
  const button = h('button', {
    class: 'tn-toast-action', type: 'button', text: actionLabel,
    onclick: async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      button.disabled = true;
      try {
        if (onAction) await onAction();
      } finally {
        node.remove();
      }
    }
  });
  node.append(button);
  box.append(node);
  return { dismiss: () => { settled = true; clearTimeout(timer); node.remove(); } };
}

/* ---------- 弹窗 ---------- */
export function openModal({ title, subtitle, body, footer, tabs, activeTab, narrow = false, onClose, testid, stacked = false }) {
  /* stacked=true 时另建一层遮罩（用于确认框叠在已打开的弹窗之上），关闭后恢复下层弹窗。 */
  const layer = stacked ? h('div', { class: 'tn-modal-layer', style: { zIndex: '80' } }) : document.getElementById('tn-modal-layer');
  if (stacked) document.body.append(layer);
  else clear(layer);
  layer.hidden = false;
  const modal = h('div', { class: `tn-modal${narrow ? ' tn-modal-narrow' : ''}`, role: 'dialog', 'aria-modal': 'true', ...(testid ? { 'data-test': testid } : {}) });
  let close = () => {
    if (stacked) layer.remove();
    else { layer.hidden = true; clear(layer); }
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const head = h('div', { class: 'tn-modal-head' },
    h('div', {}, h('h2', { text: title }), subtitle ? h('div', { class: 'tn-modal-sub', text: subtitle }) : null),
    h('button', { class: 'tn-btn tn-btn-sm tn-modal-close', type: 'button', text: '关闭', onclick: close })
  );
  const bodyNode = h('div', { class: 'tn-modal-body' }, body || null);
  modal.append(head);
  if (tabs && tabs.length) {
    const tabRow = h('div', { class: 'tn-modal-tabs' });
    for (const t of tabs) {
      tabRow.append(h('button', {
        class: `tn-tab${t.id === activeTab ? ' active' : ''}`, type: 'button', text: t.label,
        onclick: () => t.onSelect()
      }));
    }
    modal.append(tabRow);
  }
  modal.append(bodyNode);
  if (footer) modal.append(h('div', { class: 'tn-modal-foot' }, footer));
  layer.append(h('div', { class: 'tn-modal-mask', onclick: close }), modal);
  const focusable = modal.querySelector('input, select, textarea, button.tn-btn-primary');
  if (focusable) focusable.focus();
  return { close, body: bodyNode };
}

export function confirmDialog({ title, message, detail, confirmLabel = '确认', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; handle.close(); resolve(value); } };
    const input = requireText ? h('input', { class: 'tn-input', placeholder: requireText, 'data-test': 'confirm-input' }) : null;
    const okBtn = h('button', {
      class: `tn-btn ${danger ? 'tn-btn-danger' : 'tn-btn-primary'}`, type: 'button', text: confirmLabel,
      'data-test': 'confirm-ok',
      disabled: !!requireText,
      onclick: () => {
        if (requireText && input.value.trim() !== requireText) return;
        finish(true);
      }
    });
    if (input) input.addEventListener('input', () => { okBtn.disabled = input.value.trim() !== requireText; });
    const handle = openModal({
      title, narrow: true, stacked: true,
      body: h('div', {},
        h('p', { text: message }),
        detail ? h('p', { class: 'tn-muted tn-small', text: detail }) : null,
        input ? h('div', { class: 'tn-field', style: { marginTop: '12px' } },
          h('label', { text: `请输入「${requireText}」以继续` }), input) : null
      ),
      footer: [
        h('button', { class: 'tn-btn', type: 'button', text: '取消', onclick: () => finish(false) }),
        okBtn
      ],
      onClose: () => finish(false)
    });
  });
}

export function extLink(href, label) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label });
}
