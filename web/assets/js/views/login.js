/* 登录页 / 落地页内嵌登录：邮箱验证码（无密码、无演示账号）。
   OTP 状态矩阵：输入邮箱 → 发送中 → 已发送（倒计时）→ 输入验证码 → 验证中 → 错误/过期 → 准入拒绝。 */

import { api, ApiError, errorText } from '../api.js';
import { h, clear } from '../util.js';
import { pluginDownloadLink, openPluginHelp } from './plugin-help.js';

export function renderLogin(root, options = {}) {
  const { notice = null, compact = false, onSuccess = () => {}, heading = null } = options;
  clear(root);

  const emailInput = h('input', {
    class: 'tn-input', type: 'email', name: 'email', autocomplete: 'email',
    placeholder: 'you@example.com', 'data-test': 'login-email'
  });
  const sendBtn = h('button', {
    class: 'tn-btn tn-btn-primary', type: 'button', text: '获取验证码', 'data-test': 'login-send'
  });
  const inviteInput = h('input', {
    class: 'tn-input', type: 'text', name: 'invite', autocomplete: 'off',
    placeholder: '首次激活邀请码（已激活账号可留空）', 'data-test': 'login-invite'
  });
  const codeInput = h('input', {
    class: 'tn-input', type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code',
    placeholder: '6 位验证码', maxlength: '6', 'data-test': 'login-code'
  });
  const loginBtn = h('button', {
    class: 'tn-btn tn-btn-primary tn-btn-block', type: 'button', text: '验证登录', 'data-test': 'login-submit'
  });
  const resendBtn = h('button', {
    class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', text: '重新发送', 'data-test': 'login-resend'
  });
  const msgBox = h('div', { 'data-test': 'login-msg' });
  const codeBlock = h('div', { hidden: true });

  let sentEmail = null;
  let countdownTimer = null;

  function setMsg(text, kind = 'info') {
    clear(msgBox);
    if (!text) return;
    msgBox.append(h('div', { class: `tn-inline-msg ${kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : ''}` }, h('span', { text })));
  }

  function setSending(busy) {
    sendBtn.disabled = busy;
    sendBtn.textContent = busy ? '发送中…' : '获取验证码';
  }

  function setVerifying(busy) {
    loginBtn.disabled = busy;
    loginBtn.textContent = busy ? '验证中…' : '验证登录';
  }

  function startCountdown(seconds) {
    if (countdownTimer) clearInterval(countdownTimer);
    let left = Math.max(0, Number(seconds) || 0);
    const render2 = () => {
      if (left <= 0) {
        resendBtn.disabled = false;
        resendBtn.textContent = '重新发送';
        clearInterval(countdownTimer);
        return;
      }
      resendBtn.disabled = true;
      resendBtn.textContent = `重新发送（${left}s）`;
      left -= 1;
    };
    render2();
    countdownTimer = setInterval(() => {
      if (!document.body.contains(resendBtn)) { clearInterval(countdownTimer); return; }
      render2();
    }, 1000);
  }

  function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()); }

  async function sendCode() {
    const email = emailInput.value.trim();
    setMsg('');
    if (!validEmail(email)) {
      emailInput.classList.add('err');
      setMsg('请输入有效邮箱地址', 'err');
      return;
    }
    emailInput.classList.remove('err');
    setSending(true);
    try {
      const res = await api.post('/api/v1/auth/request-otp', { email }, { silent401: true });
      const data = res;
      sentEmail = email;
      codeBlock.hidden = false;
      const ttlMin = data.expires_in ? Math.round(data.expires_in / 60) : 10;
      if (data.selftest_code) {
        codeInput.value = data.selftest_code;
        setMsg(`本机管理员自测模式：验证码 ${data.selftest_code} 已自动填入，未发送邮件。有效期约 ${ttlMin} 分钟。`, 'ok');
      } else {
        setMsg(`验证码已发送，请查收（中性提示：不确认该邮箱是否注册）。有效期约 ${ttlMin} 分钟。`, 'ok');
      }
      startCountdown(data.resend_after != null ? data.resend_after : 60);
      codeInput.focus();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429 && err.details?.retry_after) {
        startCountdown(err.details.retry_after);
        setMsg(`发送过于频繁，请 ${err.details.retry_after} 秒后再试。`, 'err');
      } else {
        setMsg(errorText(err), 'err');
      }
    } finally {
      setSending(false);
    }
  }

  async function verify() {
    const email = emailInput.value.trim();
    const code = codeInput.value.trim();
    setMsg('');
    if (!validEmail(email)) { setMsg('请输入有效邮箱地址', 'err'); emailInput.focus(); return; }
    if (!/^\d{6}$/.test(code)) { codeInput.classList.add('err'); setMsg('请输入 6 位数字验证码', 'err'); return; }
    codeInput.classList.remove('err');
    setVerifying(true);
    try {
      const res = await api.post('/api/v1/auth/verify-otp', { email, code, invite_code: inviteInput.value.trim() }, { silent401: true });
      if (countdownTimer) clearInterval(countdownTimer);
      onSuccess(res);
    } catch (err) {
      if (err instanceof ApiError && ['NOT_ALLOWLISTED', 'INVITE_REQUIRED', 'INVITE_INVALID', 'INVITE_FULL', 'INVITE_CLOSED'].includes(err.code)) {
        const text = err.code === 'INVITE_FULL' ? '内测名额已满，暂不能激活新账号。' : err.code === 'INVITE_INVALID' ? '邀请码不正确，请核对后重试。' : err.code === 'INVITE_REQUIRED' ? '首次激活需要内测邀请码；老账号可直接登录。' : err.code === 'INVITE_CLOSED' ? '内测邀请尚未开放，请稍后再试。' : '当前账号暂未获得内测资格。';
        inviteInput.classList.add('err'); inviteInput.focus();
        setMsg(text, 'err');
      } else if (err instanceof ApiError && err.code === 'DELETION_IN_PROGRESS') {
        setMsg('该账号的数据删除任务尚未完成，暂不能登录；删除完成后会有明确回执。', 'err');
      } else {
        setMsg(errorText(err), 'err');
      }
    } finally {
      setVerifying(false);
    }
  }

  sendBtn.addEventListener('click', sendCode);
  resendBtn.addEventListener('click', sendCode);
  loginBtn.addEventListener('click', verify);
  emailInput.addEventListener('input', () => {
    // 改邮箱后旧 challenge 失效：收起验证码区，要求对新邮箱重新发送
    if (sentEmail && emailInput.value.trim() !== sentEmail) {
      codeBlock.hidden = true;
      sentEmail = null;
      setMsg('');
      if (countdownTimer) { clearInterval(countdownTimer); resendBtn.disabled = false; resendBtn.textContent = '重新发送'; }
    }
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCode(); });

  codeBlock.append(
    h('div', { class: 'tn-field', style: { marginTop: '14px' } },
      h('label', { text: '验证码' }),
      h('div', { class: 'tn-row' }, h('div', { class: 'tn-grow' }, codeInput), resendBtn)
    ),
    loginBtn
  );

  const form = h('div', {},
    h('div', { class: 'tn-field' },
      h('label', { text: '邮箱' }),
      h('div', { class: 'tn-row' }, h('div', { class: 'tn-grow' }, emailInput), sendBtn)
    ),
    h('div', { class: 'tn-field' },
      h('label', { text: '内测邀请码（首次激活必填）' }),
      inviteInput,
      h('p', { class: 'tn-small tn-muted', text: '邀请码只用于首次激活；已激活账号再次登录无需填写。平台分享码不是应用邀请码。' })
    ),
    codeBlock,
    msgBox
  );

  if (compact) {
    root.append(h('div', { class: 'tn-landing-card', 'data-test': 'landing-login' },
      h('h1', { text: heading || '请先登录' }),
      h('p', { class: 'tn-muted', text: '用邮箱验证码登录后，才能查看这条记录；打开本页不会标记任何状态。' }),
      form
    ));
    return;
  }

  const loginCard = h('div', { class: 'tn-login-card' },
    h('h2', { text: '登录 / 注册' }),
    h('p', { class: 'tn-muted tn-small', style: { marginTop: '2px' } }, '使用邮箱验证码登录；无密码、无匿名演示账号、无社交登录。'),
    form,
    h('div', { class: 'tn-login-note' }, '内测说明：仅开放给受邀用户；首次激活需邀请码，服务端校验为准。'),
    h('div', { class: 'tn-action-row', style: { justifyContent: 'center', marginTop: '10px' } }, pluginDownloadLink({ label: '下载插件', test: 'login-download-plugin' }), h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '安装指引', 'data-test': 'login-plugin-help', onclick: openPluginHelp }))
  );

  root.append(h('div', { class: 'tn-login-wrap' },
    h('div', { class: 'tn-login-brand', text: 'Tounar · 帮你理' }),
    h('h1', { class: 'tn-login-slogan', text: 'Tounar. Your application tracker.' }),
    h('p', { class: 'tn-login-sub', text: '你的投递线索整理助手' }),
    h('p', { class: 'tn-login-desc' }, '浏览和投递时由插件记录；QQ 招聘邮件辅助更新，官网仅在你访问时采集。'),
    notice ? h('div', { class: 'tn-banner info' }, h('div', { class: 'tn-banner-body', text: notice })) : null,
    loginCard,
    h('details', { class: 'tn-login-details' },
      h('summary', { text: '关于数据与授权（必读）' }),
      h('p', {}, '你可单独授权插件与 QQ 邮箱。邮箱同步会读取约定范围的必要邮件头部进行筛选；只有在你允许正文读取时，才处理命中招聘候选的正文。默认不保留正文，不读附件，可随时断开。'),
      h('p', {}, '台账数字来自你的真实云台账；接口失败时不会塞入演示数据，也不把失败转成 0。')
    )
  ));
}
