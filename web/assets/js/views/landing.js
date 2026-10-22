/* 邮件回看落地页：/r/<token>
   安全约束：打开即 GET 不标记；只有明确点击「已确认，状态无变化」才两步提交；
   confirmation_token 仅保存在内存变量；刷新页面只会重新 GET，不会重复确认。 */

import { api, ApiError, errorText } from '../api.js';
import { App } from '../app.js';
import {
  h, clear, statusChip, fmtDateTime, daysText, idemKey, extLink
} from '../util.js';
import { renderLogin } from './login.js';

const SOURCE_LABELS = { plugin: '插件采集', mail: '招聘邮件', manual: '用户确认' };

export async function renderLanding(root, token) {
  clear(root);
  const wrap = h('div', { class: 'tn-landing-wrap' });
  const brand = h('div', { class: 'tn-login-brand', text: 'Tounar · 帮你理' });
  const host = h('div', {});
  wrap.append(brand, host);
  root.append(wrap);

  let reqSeq = 0;
  let busy = false;
  let ready = null; // { token, application_version, expires_at } — 仅内存

  function goLedger() { location.href = '/'; }

  function showNeutral(title, message, extra) {
    clear(host);
    host.append(h('div', { class: 'tn-landing-card', 'data-test': 'landing-error' },
      h('h1', { text: title }),
      h('p', { class: 'tn-muted', text: message }),
      extra || null,
      h('div', { class: 'tn-landing-actions' },
        h('button', { class: 'tn-btn tn-btn-primary', type: 'button', text: '打开我的台账', onclick: goLedger })
      )
    ));
  }

  function showLoading() {
    setupLoginShell();
    clear(host);
    host.append(h('div', { class: 'tn-landing-card' }, h('p', { class: 'tn-muted', text: '正在读取…' })));
  }

  let loginMode = false;
  function setupLoginShell() {
    clear(host);
  }

  async function load() {
    const seq = ++reqSeq;
    try {
      const res = await api.get(`/api/v1/reminder-links/${encodeURIComponent(token)}`, { silent401: true });
      if (seq !== reqSeq) return;
      const data = res.data;
      if (data.login_required) {
        loginMode = true;
        clear(host);
        renderLogin(host, {
          compact: true,
          heading: '登录后查看这条回看提醒',
          onSuccess: () => {
            App.loggedIn = true;
            load();
          }
        });
        return;
      }
      loginMode = false;
      renderRecord(data);
    } catch (err) {
      if (seq !== reqSeq) return;
      if (err instanceof ApiError && err.code === 'LINK_EXPIRED') {
        showNeutral('链接已过期', '这条提醒链接已过期。你仍可打开自己的台账，在记录详情里使用「已确认，状态无变化」完成确认。');
      } else if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        showNeutral('链接无效', '链接无效，或该记录不属于当前登录账号。');
      } else if (err instanceof ApiError && err.status === 401) {
        clear(host);
        renderLogin(host, { compact: true, heading: '请先登录', onSuccess: () => { App.loggedIn = true; load(); } });
      } else {
        showNeutral('暂时无法读取', errorText(err));
      }
    }
  }

  function renderRecord(data) {
    const app = data.application;
    clear(host);
    const card = h('div', { class: 'tn-landing-card', 'data-test': 'landing-card' });

    if (data.completed) {
      const result = data.completed_result || {};
      card.append(
        h('h1', { text: '已确认 · 状态无变化' }),
        h('div', { style: { margin: '6px 0 10px' } }, statusChip(app.status)),
        h('p', { class: 'tn-muted' },
          `${app.company_name} · ${app.job_title}`),
        h('div', { class: 'tn-banner info', style: { marginTop: '12px' } },
          h('div', { class: 'tn-banner-body' },
            h('div', { text: result.reviewed_at ? `确认时间：${fmtDateTime(result.reviewed_at)}` : '该确认已完成。' }),
            h('div', { class: 'tn-small', text: result.same_day
              ? '今天已经确认过：本次不重复计时，也不会重复改状态。'
              : '本次确认已写入台账；刷新本页不会重复确认。' })
          )
        ),
        h('div', { class: 'tn-landing-meta' },
          `最近有效进展：${fmtDateTime(app.last_progress_at)} · 官网最近采集：${app.last_site_observed_at ? fmtDateTime(app.last_site_observed_at) : '尚无'}`),
        h('div', { class: 'tn-landing-actions' },
          app.primary_status_url ? extLink(app.primary_status_url, app.primary_status_url_scope === 'application' ? '再次打开申请状态页' : '打开岗位页') : null,
          h('button', { class: 'tn-btn tn-btn-primary', type: 'button', text: '打开我的台账', onclick: goLedger })
        )
      );
      host.append(card);
      return;
    }

    const days = app.days_since_applied;
    card.append(
      h('h1', { text: app.company_name || '—' }),
      h('p', { class: 'tn-muted', style: { margin: '0 0 10px' }, text: app.job_title || '—' }),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
        statusChip(app.status),
        h('span', { class: 'tn-small tn-muted', text: daysText(days) }),
        h('span', { class: 'tn-small tn-faint', text: `回看阈值 ${app.review_threshold_days} 天` })
      ),
      h('div', { class: 'tn-landing-meta' },
        h('div', { text: `投递时间：${app.applied_at ? fmtDateTime(app.applied_at) : '投递时间待补'}` }),
        h('div', { text: `最近有效进展：${fmtDateTime(app.last_progress_at)}` }),
        h('div', { text: `官网最近采集：${app.last_site_observed_at ? fmtDateTime(app.last_site_observed_at) : '尚无（官网仅在你访问时采集）'}` }),
        h('div', { text: `最近确认：${app.last_reviewed_at ? fmtDateTime(app.last_reviewed_at) : '尚未确认过'}` }),
        h('div', { text: `来源：${(app.source_methods || []).map((m) => SOURCE_LABELS[m] || m).join(' / ') || '未知'}` })
      )
    );

    const actions = h('div', { class: 'tn-landing-actions' });
    if (app.primary_status_url) {
      actions.append(extLink(app.primary_status_url,
        app.primary_status_url_scope === 'application' ? '打开申请状态页' : '打开岗位页（回退）'));
    }
    const confirmBtn = h('button', {
      class: 'tn-btn tn-btn-primary', type: 'button', 'data-test': 'landing-confirm', text: '已确认，状态无变化'
    });
    actions.append(confirmBtn);
    card.append(actions);

    const msg = h('div', { 'data-test': 'landing-msg' });
    card.append(msg);

    card.append(
      h('div', { class: 'tn-landing-meta' },
        '打开官网链接不会被当作确认；只有点击上面的确认按钮、并在服务端两步校验通过后，才会更新「最近确认」时间。本确认不会改变投递状态。'),
      h('div', { class: 'tn-small tn-faint' },
        `链接有效期至 ${fmtDateTime(data.expires_at)}。刷新本页只会重新读取，不会重复确认。`)
    );

    confirmBtn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      confirmBtn.disabled = true;
      confirmBtn.textContent = '正在准备确认…';
      clear(msg);
      try {
        /* 第二步提交：如已有 ready 凭据且版本一致，直接使用；否则先向服务端申请动作凭据 */
        let tokenInfo = ready;
        if (!tokenInfo || tokenInfo.application_version !== app.version) {
          const prep = await api.post(`/api/v1/reminder-links/${encodeURIComponent(token)}/confirmations`,
            { expected_version: app.version },
            {
              idempotencyKey: idemKey('reminder-confirm'),
              tounarAction: 'explicit-confirm'
            });
          const d = prep.data;
          if (d.confirmation_state === 'completed') {
            toastCompleted(d);
            return;
          }
          tokenInfo = {
            token: d.confirmation_token,
            application_version: d.application_version,
            expires_at: d.expires_at
          };
          ready = tokenInfo;
        }
        confirmBtn.textContent = '正在写入确认…';
        const res = await api.post(`/api/v1/applications/${encodeURIComponent(app.id)}/reviewed`, {
          expected_version: tokenInfo.application_version,
          context: 'reminder',
          confirmation_token: tokenInfo.token
        }, { idempotencyKey: idemKey('reminder-reviewed') });
        ready = null;
        const result = {
          reviewed_at: res.data.reviewed_at,
          same_day: !res.data.changed,
          application_version: tokenInfo.application_version + (res.data.changed ? 1 : 0)
        };
        renderCompleted(app, result);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
          msg.append(h('div', { class: 'tn-inline-msg err', text: '记录刚刚被更新：已重新读取最新状态，请再次确认。' }));
          confirmBtn.disabled = false;
          confirmBtn.textContent = '已确认，状态无变化';
          busy = false;
          ready = null;
          load();
          return;
        }
        if (err instanceof ApiError && ['CONFIRMATION_EXPIRED', 'CONFIRMATION_CONSUMED', 'CONFIRMATION_INVALID'].includes(err.code)) {
          ready = null;
          msg.append(h('div', { class: 'tn-inline-msg err', text: '确认资格已失效或已使用；已重新准备，请再点击一次确认。' }));
          confirmBtn.disabled = false;
          confirmBtn.textContent = '已确认，状态无变化';
          busy = false;
          return;
        }
        if (err instanceof ApiError && err.code === 'LINK_EXPIRED') {
          showNeutral('链接已过期', '这条提醒链接已过期。你仍可打开自己的台账，在记录详情里使用「已确认，状态无变化」完成确认。');
          return;
        }
        msg.append(h('div', { class: 'tn-inline-msg err', text: errorText(err) }));
        confirmBtn.disabled = false;
        confirmBtn.textContent = '已确认，状态无变化';
        busy = false;
      }
    });

    /* 若之前已经完成但页面数据仍旧（极端并发），completed 分支会处理；这里无需额外操作 */

    function toastCompleted(d) {
      const result = d.result || {};
      renderCompleted(app, { reviewed_at: result.reviewed_at || new Date().toISOString(), same_day: !!result.same_day });
    }

    host.append(card);
  }

  function renderCompleted(app, result) {
    clear(host);
    const card = h('div', { class: 'tn-landing-card', 'data-test': 'landing-completed' });
    card.append(
      h('h1', { text: '已确认 · 状态无变化' }),
      h('div', { style: { margin: '6px 0 10px' } }, statusChip(app.status)),
      h('p', { class: 'tn-muted', text: `${app.company_name} · ${app.job_title}` }),
      h('div', { class: 'tn-banner info', style: { marginTop: '12px' } },
        h('div', { class: 'tn-banner-body' },
          h('div', { text: result?.reviewed_at ? `确认时间：${fmtDateTime(result.reviewed_at)}` : '确认已写入。' }),
          h('div', { class: 'tn-small', text: result?.same_day
            ? '今天已经确认过：本次不重复计时。'
            : '本次确认已写入台账；刷新本页不会重复确认。' })
        )
      ),
      h('div', { class: 'tn-landing-actions' },
        h('button', { class: 'tn-btn tn-btn-primary', type: 'button', text: '打开我的台账', onclick: goLedger })
      ),
      h('div', { class: 'tn-small tn-faint', text: '你可以在台账详情里继续纠错、归档或查看历史。' })
    );
    host.append(card);
  }

  showLoading();
  await load();
}
