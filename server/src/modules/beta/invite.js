import crypto from 'node:crypto';
import { config } from '../../config.js';
import { one, run, transaction } from '../../db.js';
import { AppError, newId, normalizeEmail, nowIso, sha256 } from '../../util.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeInviteCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
export function inviteCodeHash(value) {
  const normalized = normalizeInviteCode(value);
  return sha256(`${config.masterKey.toString('hex')}:beta-invite:${normalized}`);
}
export function generateInviteCode() {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `BNL-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}
export function activeInvite() {
  return one('SELECT * FROM beta_invites WHERE active = 1 ORDER BY created_at DESC LIMIT 1');
}
export function inviteStatus() {
  const invite = one('SELECT * FROM beta_invites ORDER BY created_at DESC LIMIT 1');
  if (!invite) return { configured: false, used: 0, remaining: 0, max: config.betaInviteMaxUses, redemptions: 0 };
  const redemptions = one('SELECT COUNT(*) AS n FROM beta_invite_redemptions WHERE invite_id = ?', [invite.id]).n;
  return {
    configured: true, invite_id: invite.id,
    used: invite.used_count, remaining: Math.max(0, invite.max_uses - invite.used_count),
    max: invite.max_uses, active: !!invite.active, created_at: invite.created_at,
    redemptions
  };
}
export function createInvite({ code = generateInviteCode(), maxUses = config.betaInviteMaxUses } = {}) {
  const normalized = normalizeInviteCode(code);
  if (normalized.length < 8) throw new Error('邀请码至少 8 位');
  const hash = inviteCodeHash(normalized);
  return transaction(() => {
    const existing = one('SELECT * FROM beta_invites WHERE active = 1 LIMIT 1');
    if (existing) throw new AppError(409, 'INVITE_EXISTS', '已存在启用中的邀请码；如需更换请使用轮换', { details: inviteStatus() });
    const id = newId('inv');
    run(`INSERT INTO beta_invites (id, code_hash, max_uses, used_count, active, created_at)
         VALUES (?, ?, ?, 0, 1, ?)`, [id, hash, Math.max(1, Number(maxUses) || 10), nowIso()]);
    return { id, code: normalized, max_uses: Math.max(1, Number(maxUses) || 10) };
  });
}
export function rotateInvite({ code = generateInviteCode(), maxUses = null } = {}) {
  const normalized = normalizeInviteCode(code);
  if (normalized.length < 8) throw new Error('邀请码至少 8 位');
  return transaction(() => {
    const current = one('SELECT * FROM beta_invites WHERE active = 1 ORDER BY created_at DESC LIMIT 1');
    if (!current) return createInvite({ code: normalized, maxUses: maxUses ?? config.betaInviteMaxUses });
    run(`UPDATE beta_invites SET code_hash = ?, max_uses = ?, rotated_at = ? WHERE id = ?`,
      [inviteCodeHash(normalized), Math.max(current.used_count, Number(maxUses) || current.max_uses), nowIso(), current.id]);
    return { id: current.id, code: normalized, max_uses: Math.max(current.used_count, Number(maxUses) || current.max_uses), rotated: true };
  });
}
export function assertInviteUsable(invite) {
  if (!invite || !invite.active) throw new AppError(403, 'INVITE_REQUIRED', '首次激活需要有效邀请码');
  if (invite.used_count >= invite.max_uses) throw new AppError(403, 'INVITE_FULL', '内测名额已满，暂不能激活新账号');
}
/* 必须在 transaction() 内调用；返回 redemption 是否是本次新建。 */
export function redeemInvite({ invite, email, userId }) {
  assertInviteUsable(invite);
  const normalized = normalizeEmail(email);
  const existing = one('SELECT * FROM beta_invite_redemptions WHERE email_normalized = ?', [normalized]);
  if (existing) return { already: true, redemption: existing };
  const current = one('SELECT * FROM beta_invites WHERE id = ?', [invite.id]);
  assertInviteUsable(current);
  run(`UPDATE beta_invites SET used_count = used_count + 1
       WHERE id = ? AND used_count < max_uses`, [invite.id]);
  const after = one('SELECT used_count FROM beta_invites WHERE id = ?', [invite.id]);
  if (!after || after.used_count > invite.max_uses) throw new AppError(403, 'INVITE_FULL', '内测名额已满，暂不能激活新账号');
  run(`INSERT INTO beta_invite_redemptions (email_normalized, user_id, invite_id, redeemed_at)
       VALUES (?, ?, ?, ?)`, [normalized, userId, invite.id, nowIso()]);
  return { already: false, redemption: one('SELECT * FROM beta_invite_redemptions WHERE email_normalized = ?', [normalized]) };
}
