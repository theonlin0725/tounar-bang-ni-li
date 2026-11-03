import { createSiteAccessCard, promptPluginConnection } from './plugin-access.js';
/* 提醒设置 + 数据与授权：全部敏感操作显式、可解释；外部条件失败如实展示，不伪装成功。 */

import { api, ApiError, errorText } from '../api.js';
import { App } from '../app.js?v=20261102-1';
import {
  h, clear, toast, openModal, confirmDialog, fmtDateTime, relativeTime, idemKey,
  STATUS_LABELS
} from '../util.js';

const MAIL_STATUS = {
  connecting: { label: '连接中', cls: 'state-warn' },
  syncing: { label: '同步中', cls: 'state-warn' },
  connected: { label: '已连接', cls: 'state-ok' },
  degraded: { label: '同步受阻', cls: 'state-warn' },
  reauth_required: { label: '需重新授权', cls: 'state-err' },
  disconnected: { label: '已断开', cls: 'state-muted' }
};

const DELETION_STATUS = {
  blocking_writes: { label: '正在阻断写入', cls: 'state-warn' },
  deleting: { label: '删除中', cls: 'state-warn' },
  awaiting_device_ack: { label: '等待设备清理回执', cls: 'state-warn' },
  completed: { label: '已完成', cls: 'state-ok' },
  failed: { label: '失败（未声称完成）', cls: 'state-err' }
};

const MODE_LABEL = {
  all: '全部提醒（状态变化 + 定期回看）',
  changes_only: '仅状态变化',
  review_only: '仅定期回看',
  off: '关闭提醒'
};

const SCOPE_LABELS = {
  managed_database: '托管业务数据库',
  mail_credentials: '邮箱授权凭证',
  plugin_bindings: '插件绑定',
  reminder_links: '提醒链接',
  backups: '托管备份',
  external_workbuddy_cloud: '外部 WorkBuddy 云数据'
};

const SCOPE_VALUE = {
  delete_all_business_records: '删除全部业务记录',
  deleted: '已删除',
  delete_and_stop_sync: '删除并停止同步',
  revoke_and_request_device_cleanup: '撤销并要求设备清理回执',
  awaiting_device_cleanup_ack: '等待设备清理回执',
  no_devices: '无设备',
  delete: '删除',
  no_managed_backup_configured: '未配置托管备份（如实）',
  not_available_local_substitute: '本地替代实现，不存在该云端数据'
};

const PROGRESS_LABELS = {
  writes_blocked: '写入阻断',
  business_records: '业务记录',
  mail_credentials: '邮箱凭证',
  devices: '设备清理',
  backups: '备份',
  note: '说明'
};

const PROGRESS_VALUE = {
  pending: '待处理',
  deleting: '删除中',
  deleted: '已删除',
  pending_ack: '等待设备回执',
  awaiting_device_ack: '等待设备回执',
  acknowledged: '已回执',
  none: '无设备',
  not_configured: '未配置'
};

export function openSettings({ tab = 'reminder', onChanged } = {}) {
  const genAtOpen = App.gen;
  const timers = new Set();
  const state = {
    activeTab: tab,
    me: null,
    loadError: null,
    loading: true,
    reauthAt: null,
    reauthSent: false
  };
  let disposed = false;
  let siteAccessCard = null;

  const tabRow = h('div', { class: 'tn-tabs', style: { marginBottom: '16px' } });
  const panelHost = h('div', {});
  const body = h('div', {}, tabRow, panelHost);

  const modal = openModal({
    title: '设置与授权',
    subtitle: '提醒设置 · 插件绑定 · QQ 邮箱 · 删除数据',
    body,
    onClose: () => { disposed = true; siteAccessCard?.dispose(); for (const t of timers) clearTimeout(t); timers.clear(); },
    testid: 'settings-modal'
  });

  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); if (!disposed) fn(); }, ms);
    timers.add(t);
  }

  function renderTabs() {
    clear(tabRow);
    for (const [id, label] of [['reminder', '提醒设置'], ['data', '数据与授权']]) {
      tabRow.append(h('button', {
        class: `tn-tab${state.activeTab === id ? ' active' : ''}`, type: 'button', 'data-test': `settings-tab-${id}`,
        text: label,
        onclick: () => { state.activeTab = id; renderTabs(); renderPanel(); }
      }));
    }
  }

  function renderPanel() {
    if (disposed) return;
    siteAccessCard?.dispose();
    siteAccessCard = null;
    clear(panelHost);
    if (state.loading) {
      panelHost.append(h('div', { class: 'tn-empty' }, h('p', { class: 'tn-muted', text: '加载中…' })));
      return;
    }
    if (state.loadError) {
      panelHost.append(
        h('div', { class: 'tn-banner err' }, h('div', { class: 'tn-banner-body', text: `无法加载设置：${state.loadError}` })),
        h('button', {
          class: 'tn-btn tn-btn-sm', type: 'button', text: '重试', 'data-test': 'settings-retry',
          onclick: () => loadMe()
        })
      );
      return;
    }
    if (state.activeTab === 'reminder') renderReminderPanel();
    else renderDataPanel();
  }

  async function loadMe() {
    state.loading = true;
    state.loadError = null;
    renderPanel();
    try {
      const res = await api.get('/api/v1/me');
      if (disposed || App.gen !== genAtOpen) return;
      state.me = res.data;
    } catch (err) {
      if (disposed || App.gen !== genAtOpen) return;
      state.loadError = errorText(err);
    } finally {
      if (!disposed && App.gen === genAtOpen) {
        state.loading = false;
        renderPanel();
      }
    }
  }

  function reloadMe() {
    return loadMe();
  }

  /* ==================== 提醒设置 ==================== */
  function renderReminderPanel() {
    const prefs = state.me.notification_preferences || {};
    let mode = prefs.mode || 'all';
    let frequency = prefs.review_frequency || 'weekly_monday';
    let threshold = Number(prefs.review_threshold_days || 14);
    let version = prefs.version;
    let saving = false;

    const modeSel = h('select', { class: 'tn-select', 'data-test': 'pref-mode' });
    for (const [v, label] of Object.entries(MODE_LABEL)) modeSel.append(h('option', { value: v, text: label }));
    modeSel.value = mode;
    const freqSel = h('select', { class: 'tn-select', 'data-test': 'pref-frequency' });
    freqSel.append(h('option', { value: 'weekly_monday', text: '每周一' }), h('option', { value: 'daily', text: '每天' }));
    freqSel.value = frequency;
    const thresholdRange = h('input', { type: 'range', min: '7', max: '30', step: '1', value: String(threshold), 'data-test': 'pref-threshold' });
    const thresholdVal = h('span', { class: 'tn-range-val', text: `${threshold} 天` });
    const stageSel = h('select', { class: 'tn-select', 'data-test': 'pref-stage-followup' });
    for (const [value, text] of [[7, '7 天'], [14, '14 天'], [0, '关闭']]) stageSel.append(h('option', { value: String(value), text }));
    stageSel.value = String(prefs.stage_followup_days ?? 7);
    const statusLine = h('div', { class: 'tn-faint tn-small', text: `设置版本 v${version ?? '—'} · 最近更新 ${fmtDateTime(prefs.updated_at)}` });
    const errBox = h('div', { 'data-test': 'pref-error' });
    const saveBtn = h('button', { class: 'tn-btn tn-btn-primary', type: 'button', text: '保存设置', 'data-test': 'pref-save' });

    const syncDisabled = () => {
      const reviewRelevant = mode === 'all' || mode === 'review_only';
      freqSel.disabled = !reviewRelevant;
      thresholdRange.disabled = !reviewRelevant;
      stageSel.disabled = !reviewRelevant;
    };
    modeSel.addEventListener('change', () => { mode = modeSel.value; syncDisabled(); });
    freqSel.addEventListener('change', () => { frequency = freqSel.value; });
    thresholdRange.addEventListener('input', () => {
      threshold = Number(thresholdRange.value);
      thresholdVal.textContent = `${threshold} 天`;
    });
    syncDisabled();

    saveBtn.addEventListener('click', async () => {
      if (saving) return;
      saving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      clear(errBox);
      try {
        const res = await api.put('/api/v1/notification-preferences', {
          expected_version: version,
          mode,
          review_frequency: frequency,
          review_threshold_days: Number(threshold),
          stage_followup_days: Number(stageSel.value)
        });
        state.me.notification_preferences = res.data;
        toast('提醒设置已保存', 'ok');
        if (onChanged) onChanged();
        renderPanel();
      } catch (err) {
        if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
          errBox.append(h('div', { class: 'tn-inline-msg err', text: '设置已在别处更新：已重新加载最新值，请重新修改后保存。' }));
          try {
            const fresh = await api.get('/api/v1/notification-preferences');
            state.me.notification_preferences = fresh.data;
            renderPanel();
          } catch { /* 保留当前表单 */ }
        } else {
          errBox.append(h('div', { class: 'tn-inline-msg err', text: errorText(err) }));
          saving = false;
          saveBtn.disabled = false;
          saveBtn.textContent = '保存设置';
        }
      }
    });

    const previewHost = h('div', { 'data-test': 'pref-preview' });
    const previewBtn = h('button', {
      class: 'tn-btn tn-btn-sm', type: 'button', text: '预览下一批摘要', 'data-test': 'pref-preview-btn',
      onclick: async () => {
        clear(previewHost);
        previewHost.append(h('div', { class: 'tn-small tn-muted', text: '生成预览中…' }));
        try {
          const res = await api.get('/api/v1/notification-preferences/preview');
          const p = res.data;
          clear(previewHost);
          previewHost.append(
            h('div', { class: 'tn-small tn-muted', text: `${MODE_LABEL[p.mode] || p.mode} · ${p.frequency === 'daily' ? '每天' : '每周一'} · 阈值 ${p.threshold_days} 天` }),
            h('div', { class: 'tn-small', style: { marginTop: '6px' }, text: `A 有进展：${p.a.length} 条` }),
            ...p.a.slice(0, 5).map((x) => h('div', { class: 'tn-small tn-muted', text: `· ${x.company_name} · ${x.job_title}：${x.summary}` })),
            h('div', { class: 'tn-small', style: { marginTop: '6px' }, text: `B 等待回看：${p.b.length} 条` }),
            ...p.b.slice(0, 5).map((x) => h('div', { class: 'tn-small tn-muted', text: `· ${x.company_name} · ${x.job_title}：已投 ${x.days_since_applied} 天${x.has_safe_link ? '，有安全链接' : '，无安全链接'}` })),
            h('div', { class: 'tn-small', style: { marginTop: '6px' } }, h('strong', { text: p.would_send ? '当前条件下会发送' : '当前条件下不会发送' })),
            h('div', { class: 'tn-tiny tn-faint', text: p.note })
          );
        } catch (err) {
          clear(previewHost);
          previewHost.append(h('div', { class: 'tn-inline-msg err', text: errorText(err) }));
        }
      }
    });

    panelHost.append(
      h('div', { class: 'tn-banner info' },
        h('div', { class: 'tn-banner-body' },
          h('div', { text: '默认每日北京时间 08:00 汇总；已投回看默认 14 天，笔试 / 面试后默认 7 天。' }),
          h('div', { class: 'tn-small', text: '提醒只发送摘要，不会自动改状态；关闭提醒只停止摘要发信，不停止邮箱同步。' })
        )
      ),
      h('div', { class: 'tn-pref-group' },
        h('h4', { text: '提醒方式' }),
        h('div', { class: 'tn-field', style: { marginBottom: '10px' } }, h('label', { text: '接收哪些提醒' }), modeSel,
          h('div', { class: 'tn-hint', text: '“仅状态变化”不包含定期回看；全部关闭后仍可在台账里手动回看。' })),
        h('div', { class: 'tn-field', style: { marginBottom: '10px' } }, h('label', { text: '回看频率' }), freqSel),
        h('div', { class: 'tn-field', style: { marginBottom: '0' } },
          h('label', { text: '回看阈值（7–30 天）' }),
          h('div', { class: 'tn-range-row' }, thresholdRange, thresholdVal),
          h('div', { class: 'tn-hint', text: '“待回看”= 距离最近有效进展/上次确认超过该天数。与 B 邮件基础集合一致，但不等于本次可发信名单。' })
        )
      ),
      h('div', { class: 'tn-pref-group' },
        h('h4', { text: '笔试 / 面试后提醒回看' }),
        h('div', { class: 'tn-field' }, h('label', { text: '收到邀请后多久提醒' }), stageSel,
          h('div', { class: 'tn-hint', text: '按邀请收到日期计算；预约面试更晚时从面试时间算起。阶段推进后重算，终态停止。确认没变化后再等同样天数，与已投回看设置独立。' }))
      ),
      h('div', { class: 'tn-pref-group' },
        h('h4', { text: '下一批摘要预览（只读，不发送、不标记）' }),
        previewBtn, previewHost
      ),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, saveBtn),
      statusLine,
      h('div', { class: 'tn-small tn-faint', style: { marginTop: '6px' }, text: '提醒收件人固定为当前已验证登录邮箱；不提供自定义收件人。' }),
      errBox
    );
  }

  /* ==================== 数据与授权 ==================== */
  function renderDataPanel() {
    const me = state.me;
    siteAccessCard = createSiteAccessCard();
    panelHost.append(
      siteAccessCard.element,
      renderPairingSection(me),
      renderDevicesSection(me),
      renderMailSection(me),
      renderDeletionSection(me),
      renderDecisionsSection()
    );
  }

  /* ---------- 配对 ---------- */
  function renderPairingSection(me) {
    return h('div', {class:'tn-pref-group', 'data-test':'pairing-section'},
      h('h4', {text:'插件绑定'}),
      h('p', {class:'tn-small tn-muted', text:'打开网页后会自动提示连接。无需打开插件栏或输入配对码，也可以在这里重新检测。'}),
      h('button', {class:'tn-btn tn-btn-primary', text:'检测并连接插件', onclick:() => {modal.close(); promptPluginConnection();}}));
  }

  /* ---------- 设备列表 ---------- */
  function renderDevicesSection(me) {
    const section = h('div', { class: 'tn-pref-group', 'data-test': 'devices-section' });
    section.append(h('h4', { text: '已绑定设备' }));
    const devices = me.plugin_devices || [];
    if (!devices.length) {
      section.append(h('div', { class: 'tn-small tn-muted', text: '尚无已绑定设备。安装扩展后，在弹窗里发起配对。' }));
      return section;
    }
    for (const d of devices) {
      const revoked = !!d.server_revoked_at;
      const ack = d.device_cleanup_state === 'acknowledged';
      const pill = revoked
        ? (ack ? h('span', { class: 'tn-state-pill state-muted', text: '已撤销 · 设备已回执' })
          : h('span', { class: 'tn-state-pill state-warn', text: '已撤销 · 清理待回执' }))
        : h('span', { class: 'tn-state-pill state-ok', text: '已绑定' });
      const row = h('div', { class: 'tn-device', 'data-test': 'device-item', 'data-device-id': d.id },
        h('div', { class: 'tn-device-name' }, d.name || '未命名设备', pill),
        h('div', { class: 'tn-device-meta', text: [
          `绑定版本 v${d.binding_version}`,
          `创建于 ${fmtDateTime(d.created_at)}`,
          d.last_heartbeat_at ? `最近联系 ${relativeTime(d.last_heartbeat_at)}` : '尚未联系',
          d.last_event_at ? `最近采集 ${relativeTime(d.last_event_at)}` : '尚无采集事件'
        ].join(' · ') }),
        revoked ? h('div', { class: 'tn-device-meta' },
          ack
            ? `设备已回执清理：${fmtDateTime(d.device_cleanup_ack_at)}；历史台账保留。`
            : `服务端已撤销于 ${fmtDateTime(d.server_revoked_at)}；设备离线/未运行时无法保证瞬时停采与本地清理，普通心跳不算清理回执。`
        ) : null
      );
      if (!revoked) {
        row.append(h('div', { class: 'tn-action-row', style: { marginTop: '8px' } },
          h('button', {
            class: 'tn-btn tn-btn-sm tn-btn-danger', type: 'button', text: '撤销此设备', 'data-test': 'device-revoke',
            onclick: async () => {
              const ok = await confirmDialog({
                title: '撤销此设备绑定？',
                message: '服务端将撤销该绑定并拒绝后续上传；历史台账保留。',
                detail: '离线或未运行的扩展不能保证瞬时停采/清理，需要等待设备回执；回执前不会标记为已清理。',
                confirmLabel: '撤销', danger: true
              });
              if (!ok) return;
              try {
                await api.post(`/api/v1/plugin-devices/${encodeURIComponent(d.id)}/revoke`, {});
                toast('已撤销该设备绑定', 'ok');
                await reloadMe();
                if (onChanged) onChanged();
              } catch (err) {
                toast(errorText(err), 'err');
              }
            }
          })
        ));
      }
      section.append(row);
    }
    section.append(h('div', { class: 'tn-small tn-faint', style: { marginTop: '6px' } },
      '撤销与清理是两个状态：服务端撤销 ≠ 设备已清理。只有设备回执后才显示「已回执」。'));
    return section;
  }

  /* ---------- 邮箱 ---------- */
  function renderMailSection(me) {
    const section = h('div', { class: 'tn-pref-group', 'data-test': 'mail-section' });
    section.append(h('h4', { text: 'QQ 邮箱（只读）' }));
    const conn = me.mail_connection;
    if (!conn) {
      section.append(renderMailConnectForm(null));
      return section;
    }
    const meta = MAIL_STATUS[conn.status] || { label: conn.status, cls: 'state-muted' };
    section.append(
      h('div', { class: 'tn-device', 'data-test': 'mail-connection' },
        h('div', { class: 'tn-device-name' }, conn.email, h('span', { class: `tn-state-pill ${meta.cls}`, text: meta.label })),
        h('div', { class: 'tn-device-meta', text: [
          conn.mode === 'headers_only' ? '仅读取邮件头' : '招聘候选正文模式',
          `首扫起始 ${conn.scan_since ? fmtDateTime(conn.scan_since) : '—'}`,
          conn.last_sync_success_at ? `最近成功同步 ${relativeTime(conn.last_sync_success_at)}` : '尚无成功同步'
        ].join(' · ') }),
        conn.first_scan_total ? h('div', { class: 'tn-device-meta', text: `首扫进度 ${conn.first_scan_processed ?? 0}/${conn.first_scan_total}` }) : null,
        conn.last_error_message ? h('div', { class: 'tn-device-meta tn-danger-text', text: `最近错误（${conn.last_error_code || 'UNKNOWN'}）：${conn.last_error_message}` }) : null
      )
    );

    const actionRow = h('div', { class: 'tn-action-row', style: { marginTop: '8px' } });
    const msgBox = h('div', { 'data-test': 'mail-msg' });
    if (conn.status !== 'disconnected') {
      actionRow.append(h('button', {
        class: 'tn-btn tn-btn-sm', type: 'button', text: '立即同步', 'data-test': 'mail-sync',
        onclick: async () => {
          clear(msgBox);
          try {
            const res = await api.post(`/api/v1/mail-connections/${encodeURIComponent(conn.id)}/sync`, {});
            msgBox.append(h('div', { class: 'tn-inline-msg', text: '同步请求已受理（202），完成后状态会更新；不代表已同步成功。' }));
            pollMail(conn.id, msgBox);
            if (res.data?.status) { await reloadMe(); }
          } catch (err) {
            msgBox.append(h('div', { class: 'tn-inline-msg err', text: errorText(err) }));
          }
        }
      }));
    }
    actionRow.append(h('button', {
      class: 'tn-btn tn-btn-sm', type: 'button', text: conn.status === 'disconnected' ? '重新连接…' : '重新授权…',
      'data-test': 'mail-reauth-open',
      onclick: () => {
        clear(msgBox);
        msgBox.append(renderMailReauthForm(conn));
      }
    }));
    if (conn.status !== 'disconnected') {
      actionRow.append(h('button', {
        class: 'tn-btn tn-btn-sm tn-btn-danger', type: 'button', text: '断开连接', 'data-test': 'mail-disconnect',
        onclick: async () => {
          const ok = await confirmDialog({
            title: '断开 QQ 邮箱连接？',
            message: '服务端会删除授权凭证并停止同步；历史台账保留。',
            detail: '断开后不会删除已解析的投递记录；如需删除数据请使用「删除全部数据」。',
            confirmLabel: '断开', danger: true
          });
          if (!ok) return;
          try {
            await api.post(`/api/v1/mail-connections/${encodeURIComponent(conn.id)}/disconnect`, {});
            toast('已断开邮箱连接', 'ok');
            await reloadMe();
            if (onChanged) onChanged();
          } catch (err) {
            toast(errorText(err), 'err');
          }
        }
      }));
    }
    section.append(actionRow, msgBox);
    section.append(h('div', { class: 'tn-small tn-faint', style: { marginTop: '6px' } },
      '真实 QQ IMAP 与 SMTP 未在当前环境配置时，连接/同步会如实失败并显示错误，不会伪装成“已同步”。'));
    return section;
  }

  function renderMailConnectForm(conn, compact = false) {
    const box = h('div', { ...(compact ? { style: { width: '100%', marginTop: '8px' } } : {}) });
    const emailInput = h('input', {
      class: 'tn-input', type: 'email', placeholder: 'xxx@qq.com / foxmail.com / vip.qq.com',
      value: conn?.email || (isQqEmail(state.me.user.email) ? state.me.user.email : '')
    });
    const codeInput = h('input', { class: 'tn-input', type: 'password', autocomplete: 'new-password', placeholder: 'QQ 邮箱授权码（非登录密码）' });
    const modeSel = h('select', { class: 'tn-select' });
    modeSel.append(
      h('option', { value: 'headers_only', text: '只读邮件头（推荐）' }),
      h('option', { value: 'recruitment_body', text: '招聘候选正文（读取范围更大）' })
    );
    modeSel.value = conn?.mode || 'headers_only';
    const scanInput = h('input', { class: 'tn-input', type: 'date', value: defaultScanSince() });
    const consent = h('input', { type: 'checkbox', 'data-test': 'mail-consent' });
    const msg = h('div', { 'data-test': 'mail-form-msg' });
    const submit = h('button', {
      class: 'tn-btn tn-btn-primary', type: 'button', text: conn ? '重新授权并扫描' : '连接并开始首扫',
      'data-test': 'mail-connect',
      onclick: async () => {
        clear(msg);
        if (!consent.checked) { msg.append(h('div', { class: 'tn-inline-msg err', text: '请先阅读并勾选只读授权说明' })); return; }
        submit.disabled = true;
        submit.textContent = '提交中…';
        try {
          const body = {
            email: emailInput.value.trim(),
            auth_code: codeInput.value.trim(),
            mode: modeSel.value,
            consent_version: 'QQ_MAIL_READ_CONSENT_V1',
            scan_since: new Date(`${scanInput.value || defaultScanSince()}T00:00:00+08:00`).toISOString()
          };
          if (conn) {
            await api.post(`/api/v1/mail-connections/${encodeURIComponent(conn.id)}/reauthorize`,
              { auth_code: body.auth_code, consent_version: body.consent_version });
            msg.append(h('div', { class: 'tn-inline-msg', text: '重新授权请求已受理（202），正在连接。' }));
            pollMail(conn.id, msg);
          } else {
            const res = await api.post('/api/v1/mail-connections', body);
            msg.append(h('div', { class: 'tn-inline-msg', text: '连接请求已受理（202）；正在验证授权并启动首扫。' }));
            pollMail(res.data.id, msg);
          }
          await reloadMe();
        } catch (err) {
          if (err instanceof ApiError && err.code === 'MAIL_CONNECTION_EXISTS') {
            msg.append(h('div', { class: 'tn-inline-msg err', text: '当前账号已有邮箱连接；请先断开或使用「重新授权」。' }));
          } else {
            msg.append(h('div', { class: 'tn-inline-msg err', text: errorText(err) }));
          }
        } finally {
          submit.disabled = false;
          submit.textContent = conn ? '重新授权并扫描' : '连接并开始首扫';
        }
      }
    });
    box.append(
      h('div', { class: 'tn-form-grid' },
        h('div', { class: 'tn-field' }, h('label', { text: 'QQ 邮箱地址' }), emailInput),
        h('div', { class: 'tn-field' }, h('label', { text: '授权码' }), codeInput),
        h('div', { class: 'tn-field' }, h('label', { text: '读取模式' }), modeSel),
        h('div', { class: 'tn-field' }, h('label', { text: '首扫起始日' }), scanInput)
      ),
      h('div', { class: 'tn-small tn-muted' },
        '获取方式：QQ 邮箱 → 设置 → 账户 → 开启 IMAP → 生成授权码。授权码仅加密保存用于连接；可随时断开。'),
      h('label', { class: 'tn-check' }, consent,
        h('span', { text: '我已阅读并同意《QQ 邮箱只读授权说明》：Tounar 通过 IMAP 只读连接，读取约定范围的必要邮件头部用于筛选招聘邮件；仅在选择「招聘候选正文」模式时处理命中候选的正文；默认不保留正文、不读附件。' })
      ),
      msg,
      h('div', { class: 'tn-action-row' }, submit),
      h('div', { class: 'tn-small tn-faint', style: { marginTop: '6px' } },
        '一期仅支持 QQ 邮箱（qq.com / foxmail.com / vip.qq.com）；其他邮箱会被明确拒绝。')
    );
    return box;
  }

  function renderMailReauthForm(conn) {
    const box = h('div', { style: { marginTop: '8px' } });
    const codeInput = h('input', { class: 'tn-input', type: 'password', autocomplete: 'new-password', placeholder: '新的 QQ 邮箱授权码' });
    const consent = h('input', { type: 'checkbox' });
    const msg = h('div', {});
    box.append(
      h('div', { class: 'tn-form-grid' },
        h('div', { class: 'tn-field' }, h('label', { text: '新的授权码' }), codeInput),
        h('div', { class: 'tn-field' }, h('label', { text: '授权同意' }),
          h('label', { class: 'tn-check', style: { margin: '0' } }, consent, '同意 QQ_MAIL_READ_CONSENT_V1'))
      ),
      msg,
      h('div', { class: 'tn-action-row' },
        h('button', {
          class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', text: '提交重新授权', 'data-test': 'mail-reauth-submit',
          onclick: async (e) => {
            const btn = e.currentTarget;
            clear(msg);
            if (!consent.checked) { msg.append(h('div', { class: 'tn-inline-msg err', text: '请勾选授权同意' })); return; }
            btn.disabled = true;
            try {
              await api.post(`/api/v1/mail-connections/${encodeURIComponent(conn.id)}/reauthorize`,
                { auth_code: codeInput.value.trim(), consent_version: 'QQ_MAIL_READ_CONSENT_V1' });
              msg.append(h('div', { class: 'tn-inline-msg', text: '重新授权已受理（202），正在连接。' }));
              pollMail(conn.id, msg);
              await reloadMe();
            } catch (err) {
              msg.append(h('div', { class: 'tn-inline-msg err', text: errorText(err) }));
            } finally {
              btn.disabled = false;
            }
          }
        })
      )
    );
    return box;
  }

  function pollMail(id, msgBox) {
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      try {
        const res = await api.get(`/api/v1/mail-connections/${encodeURIComponent(id)}`);
        const c = res.data;
        state.me.mail_connection = c;
        if (['connected', 'degraded', 'reauth_required', 'disconnected'].includes(c.status) || attempts >= 12) {
          await reloadMe();
          return;
        }
        if (document.body.contains(msgBox)) {
          clear(msgBox);
          msgBox.append(h('div', { class: 'tn-inline-msg', text: `当前状态：${(MAIL_STATUS[c.status] || {}).label || c.status}…` }));
        }
        later(tick, 2500);
      } catch {
        if (attempts < 12) later(tick, 3000);
      }
    };
    later(tick, 1200);
  }

  function isQqEmail(email) { return /@(qq\.com|foxmail\.com|vip\.qq\.com)$/i.test(String(email || '')); }

  function defaultScanSince() {
    const d = new Date(Date.now() - 30 * 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  /* ---------- 删除全部数据 ---------- */
  function renderDeletionSection(me) {
    const section = h('div', { class: 'tn-danger-zone', 'data-test': 'deletion-section' });
    section.append(h('h4', { style: { margin: '0 0 6px' }, text: '删除全部数据（敏感操作）' }));
    const job = me.deletion_job;
    if (job) return renderDeletionJob(section, job);

    section.append(
      h('p', { class: 'tn-small', style: { marginTop: '0' } },
        '此操作不可恢复，将删除托管数据库中的全部业务记录，并撤销邮箱授权与插件绑定。未核实的范围不会标记为已删除。'),
      h('ul', { class: 'tn-scope-list' },
        h('li', { text: '申请、历史、事件、复核项、提醒与提醒链接：删除' }),
        h('li', { text: '邮箱授权凭证：删除并停止同步' }),
        h('li', { text: '插件绑定：撤销，并要求设备清理回执（离线设备需等待回执）' }),
        h('li', { text: '托管备份：当前未配置（如实显示）' }),
        h('li', { text: '外部 WorkBuddy 云数据：当前为本地替代实现，不存在可删除的云数据' })
      ),
      h('div', { class: 'tn-banner warn', style: { margin: '10px 0' } },
        h('div', { class: 'tn-banner-body', text: '删除不等于注销登录方式；完成前需要重新验证邮箱。已交给邮件供应商的信件无法召回。' })
      )
    );

    const reauthBox = h('div', { 'data-test': 'reauth-box' });
    const reauthStatus = h('div', { class: 'tn-small tn-muted' });
    const codeInput = h('input', { class: 'tn-input', type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '邮箱验证码', style: { maxWidth: '180px' } });
    const sendBtn = h('button', {
      class: 'tn-btn tn-btn-sm', type: 'button', text: '发送验证码',
      onclick: async () => {
        clear(reauthStatus);
        sendBtn.disabled = true;
        try {
          await api.post('/api/v1/auth/request-otp', { email: me.user.email });
          state.reauthSent = true;
          reauthStatus.textContent = '验证码已发送，请查收（中性提示：不确认该邮箱是否注册）。';
        } catch (err) {
          reauthStatus.textContent = errorText(err);
        } finally {
          sendBtn.disabled = false;
        }
      }
    });
    const verifyBtn = h('button', {
      class: 'tn-btn tn-btn-sm', type: 'button', text: '验证邮箱', 'data-test': 'reauth-verify',
      onclick: async () => {
        clear(reauthStatus);
        verifyBtn.disabled = true;
        try {
          await api.post('/api/v1/auth/reauthenticate', { email: me.user.email, code: codeInput.value.trim() });
          state.reauthAt = new Date();
          reauthStatus.textContent = `已验证（${fmtDateTime(state.reauthAt.toISOString())}）。请尽快提交删除。`;
          toast('邮箱重新验证成功', 'ok');
        } catch (err) {
          reauthStatus.textContent = errorText(err);
        } finally {
          verifyBtn.disabled = false;
        }
      }
    });
    reauthBox.append(
      h('div', { class: 'tn-small', style: { marginBottom: '6px' }, text: '敏感操作重新验证邮箱：' }),
      h('div', { class: 'tn-row', style: { flexWrap: 'wrap' } }, sendBtn, codeInput, verifyBtn),
      reauthStatus
    );
    section.append(reauthBox);

    const confirmInput = h('input', { class: 'tn-input', placeholder: '请输入「删除全部数据」', 'data-test': 'deletion-confirm-input' });
    const ack = h('input', { type: 'checkbox', 'data-test': 'deletion-ack' });
    const submit = h('button', {
      class: 'tn-btn tn-btn-danger', type: 'button', text: '删除全部数据', disabled: true, 'data-test': 'deletion-submit'
    });
    const msg = h('div', { 'data-test': 'deletion-msg' });
    const sync = () => { submit.disabled = !(confirmInput.value.trim() === '删除全部数据' && ack.checked); };
    confirmInput.addEventListener('input', sync);
    ack.addEventListener('change', sync);
    submit.addEventListener('click', async () => {
      if (submit.disabled) return;
      submit.disabled = true;
      submit.textContent = '提交中…';
      clear(msg);
      try {
        const res = await api.post('/api/v1/data-deletions', {
          confirmation: '删除全部数据',
          acknowledge_irreversible: true
        }, { idempotencyKey: idemKey('deletion') });
        toast('删除任务已受理', 'ok');
        state.me.deletion_job = res.data;
        state.me = { ...state.me };
        renderPanel();
        pollDeletion(res.data.id);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'REAUTH_REQUIRED') {
          msg.append(h('div', { class: 'tn-inline-msg err', text: '需要先重新验证邮箱（上方区域），验证后 5 分钟内提交删除。' }));
        } else {
          msg.append(h('div', { class: 'tn-inline-msg err', text: errorText(err) }));
        }
        submit.disabled = false;
        submit.textContent = '删除全部数据';
      }
    });

    section.append(
      h('div', { class: 'tn-field', style: { marginTop: '12px' } },
        h('label', { text: '输入确认文本' }), confirmInput),
      h('label', { class: 'tn-check' }, ack, '我确认删除不可恢复，并理解设备清理需等待回执。'),
      msg,
      h('div', { class: 'tn-action-row' }, submit)
    );
    return section;
  }

  function renderDeletionJob(section, job) {
    const meta = DELETION_STATUS[job.status] || { label: job.status, cls: 'state-muted' };
    const msgBox = h('div', { 'data-test': 'deletion-progress-msg' });
    section.append(
      h('div', { class: 'tn-device' },
        h('div', { class: 'tn-device-name' }, '删除任务', h('span', { class: `tn-state-pill ${meta.cls}`, text: meta.label })),
        h('div', { class: 'tn-device-meta', text: `任务 ${job.id} · 申请于 ${fmtDateTime(job.requested_at)}${job.completed_at ? ` · 完成于 ${fmtDateTime(job.completed_at)}` : ''}` }),
        job.error_code ? h('div', { class: 'tn-device-meta tn-danger-text', text: `错误：${job.error_code}` }) : null
      )
    );
    /* scope */
    if (job.scope && Object.keys(job.scope).length) {
      const scopeList = h('ul', { class: 'tn-progress-list' });
      for (const [key, value] of Object.entries(job.scope)) {
        scopeList.append(h('li', {}, h('span', { class: 'tn-progress-key', text: SCOPE_LABELS[key] || key }),
          h('span', { text: SCOPE_VALUE[value] || String(value) })));
      }
      section.append(h('div', { class: 'tn-small', style: { marginTop: '8px' }, text: '范围（只展示已验证状态）' }), scopeList);
    }
    /* progress */
    if (job.progress && Object.keys(job.progress).length) {
      const progList = h('ul', { class: 'tn-progress-list' });
      for (const [key, value] of Object.entries(job.progress)) {
        if (key === 'note') continue;
        progList.append(h('li', {}, h('span', { class: 'tn-progress-key', text: PROGRESS_LABELS[key] || key }),
          h('span', { text: PROGRESS_VALUE[value] || String(value) })));
      }
      section.append(h('div', { class: 'tn-small', style: { marginTop: '8px' }, text: '进度' }), progList);
      if (job.progress.note) section.append(h('div', { class: 'tn-small tn-faint', text: job.progress.note }));
    }
    if (job.status === 'awaiting_device_ack') {
      section.append(h('div', { class: 'tn-banner warn', style: { marginTop: '10px' } },
        h('div', { class: 'tn-banner-body', text: '业务数据已删除；插件设备的清理回执尚未到齐。离线设备需要下次启动并回执后，任务才会标记完成——这里不会伪造“已清理”。' })));
    }
    if (job.status === 'completed') {
      section.append(h('div', { class: 'tn-banner info', style: { marginTop: '10px' } },
        h('div', { class: 'tn-banner-body', text: '删除任务已完成（仅指上方已验证范围）。账号邮箱已置为「已删除账号」，当前页面数据已失效，可刷新或退出。' })));
    }
    section.append(
      msgBox,
      h('div', { class: 'tn-action-row', style: { marginTop: '10px' } },
        h('button', {
          class: 'tn-btn tn-btn-sm', type: 'button', text: '刷新任务状态', 'data-test': 'deletion-refresh',
          onclick: async () => {
            clear(msgBox);
            try {
              const res = await api.get(`/api/v1/data-deletions/${encodeURIComponent(job.id)}`);
              state.me.deletion_job = res.data;
              renderPanel();
            } catch (err) {
              msgBox.append(h('div', { class: 'tn-inline-msg err', text: errorText(err) }));
            }
          }
        }),
        job.status === 'completed' ? h('button', {
          class: 'tn-btn tn-btn-sm', type: 'button', text: '刷新页面',
          onclick: () => location.reload()
        }) : null
      ),
      h('div', { class: 'tn-small tn-faint', style: { marginTop: '6px' } },
        '删除进行中时，业务接口会返回 DELETION_IN_PROGRESS，这是预期行为；不会展示旧数据或伪造空台账。')
    );
    return section;
  }

  function pollDeletion(id) {
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      try {
        const res = await api.get(`/api/v1/data-deletions/${encodeURIComponent(id)}`);
        const job = res.data;
        /* 状态变化即重绘：否则会停留在「正在阻断写入」，直到 20 次轮询后才展示待设备回执。 */
        const prevStatus = state.me?.deletion_job?.status;
        state.me.deletion_job = job;
        if (job?.status !== prevStatus) renderPanel();
        if (job?.status === 'completed' || job?.status === 'failed') return;
        if (attempts >= 20) return;
        later(tick, 2500);
      } catch {
        if (attempts < 20) later(tick, 3000);
      }
    };
    later(tick, 1500);
  }

  /* ---------- 决定项（只读） ---------- */
  function renderDecisionsSection() {
    const details = h('details', { class: 'tn-pref-group', style: { marginTop: '4px' } });
    details.append(h('summary', { class: 'tn-small', style: { cursor: 'pointer' }, text: '当前未冻结参数与外部条件（只读）' }));
    const host = h('div', { style: { marginTop: '8px' } });
    details.append(host);
    details.addEventListener('toggle', async () => {
      if (!details.open || host.dataset.loaded) return;
      host.dataset.loaded = '1';
      host.append(h('div', { class: 'tn-small tn-muted', text: '加载中…' }));
      try {
        const res = await api.get('/api/v1/meta/decisions');
        clear(host);
        const decisions = res.data.decisions || {};
        const gates = res.data.gates || {};
        const list = h('ul', { class: 'tn-progress-list' });
        for (const [key, value] of Object.entries(decisions)) {
          list.append(h('li', {}, h('span', { class: 'tn-progress-key', text: key }), h('span', { text: String(value) })));
        }
        host.append(h('div', { class: 'tn-small', style: { fontWeight: '600' }, text: '决定项（D）' }), list);
        const gateList = h('ul', { class: 'tn-progress-list' });
        for (const [key, gate] of Object.entries(gates)) {
          gateList.append(h('li', {}, h('span', { class: 'tn-progress-key', text: key }),
            h('span', { text: `${gate.status}：${gate.note}` })));
        }
        host.append(h('div', { class: 'tn-small', style: { fontWeight: '600', marginTop: '8px' }, text: '外部条件（G）' }), gateList);
        host.append(h('div', { class: 'tn-tiny tn-faint', style: { marginTop: '6px' }, text: '这些是待冻结/待外部验证项，不是已完成的承诺。' }));
      } catch (err) {
        clear(host);
        host.append(h('div', { class: 'tn-inline-msg err', text: errorText(err) }));
      }
    });
    return details;
  }

  renderTabs();
  loadMe();
  return modal;
}
