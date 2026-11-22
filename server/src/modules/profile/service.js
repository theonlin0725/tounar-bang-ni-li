import { bumpRevision, one, run, transaction } from '../../db.js';
import { AppError, clipText, newId, nowIso, safeJsonParse } from '../../util.js';

/* v1.1.1 六维求职画像。只做用户明确确认的偏好，不把模型推测当事实。 */
const ARRAY_FIELDS = [
  ['preferred_locations_json', 'preferred_locations', 12, 40],
  ['industry_preferences_json', 'industry_preferences', 12, 40],
  ['company_preferences_json', 'company_preferences', 12, 40]
];
const TEXT_FIELDS = [
  ['salary_expectation', 'salary_expectation', 120],
  ['work_mode', 'work_mode', 80],
  ['career_direction', 'career_direction', 160]
];

function list(value, maxItems, maxChars) {
  if (typeof value === 'string') value = value.split(/[、,，;；\n]/);
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim().slice(0, maxChars))
    .filter(Boolean))].slice(0, maxItems);
}
function text(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function summaryFor(profile) {
  if (profile.summary_text) return profile.summary_text;
  const direction = profile.career_direction || '求职方向待补充';
  const places = profile.preferred_locations?.length ? ` · ${profile.preferred_locations.join('/')}` : '';
  const industries = profile.industry_preferences?.length ? ` · ${profile.industry_preferences.slice(0, 2).join('/')}` : '';
  return `${direction}${places}${industries}`.slice(0, 240);
}
function normalize(body = {}) {
  const result = {};
  for (const [jsonKey, apiKey, maxItems, maxChars] of ARRAY_FIELDS) {
    result[apiKey] = list(body[apiKey] ?? body[jsonKey], maxItems, maxChars);
  }
  for (const [apiKey, , max] of TEXT_FIELDS) result[apiKey] = text(body[apiKey], max);
  result.summary_text = text(body.summary_text, 240);
  return result;
}
function projection(row) {
  if (!row) return null;
  return {
    owner_id: row.owner_id,
    preferred_locations: safeJsonParse(row.preferred_locations_json, []) || [],
    salary_expectation: row.salary_expectation || '',
    work_mode: row.work_mode || '',
    career_direction: row.career_direction || '',
    industry_preferences: safeJsonParse(row.industry_preferences_json, []) || [],
    company_preferences: safeJsonParse(row.company_preferences_json, []) || [],
    summary_text: row.summary_text || '',
    status: row.status,
    onboarding_completed_at: row.onboarding_completed_at || null,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
export function getProfile(ownerId, { confirmedOnly = false } = {}) {
  const row = one('SELECT * FROM user_profiles WHERE owner_id = ?', [ownerId]);
  if (!row) return { profile: null, exists: false };
  if (confirmedOnly && row.status !== 'confirmed') return { profile: null, exists: true };
  return { profile: projection(row), exists: true };
}
export function profileForMatch(ownerId) {
  return getProfile(ownerId, { confirmedOnly: true }).profile;
}
export function saveProfile(ownerId, body = {}, { status = 'confirmed' } = {}) {
  const normalized = normalize(body);
  const now = nowIso();
  return transaction(() => {
    const existing = one('SELECT * FROM user_profiles WHERE owner_id = ?', [ownerId]);
    const summary = summaryFor(normalized);
    if (existing) {
      run(`UPDATE user_profiles SET preferred_locations_json=?, salary_expectation=?, work_mode=?,
        career_direction=?, industry_preferences_json=?, company_preferences_json=?, summary_text=?,
        status=?, onboarding_completed_at=COALESCE(onboarding_completed_at, ?), version=version+1, updated_at=?
        WHERE owner_id=?`,
      [JSON.stringify(normalized.preferred_locations), normalized.salary_expectation, normalized.work_mode,
        normalized.career_direction, JSON.stringify(normalized.industry_preferences),
        JSON.stringify(normalized.company_preferences), summary,
        status === 'confirmed' ? 'confirmed' : existing.status,
        status === 'confirmed' ? now : null, now, ownerId]);
    } else {
      run(`INSERT INTO user_profiles
        (owner_id, preferred_locations_json, salary_expectation, work_mode, career_direction,
         industry_preferences_json, company_preferences_json, summary_text, status, onboarding_completed_at,
         version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [ownerId, JSON.stringify(normalized.preferred_locations), normalized.salary_expectation, normalized.work_mode,
        normalized.career_direction, JSON.stringify(normalized.industry_preferences),
        JSON.stringify(normalized.company_preferences), summary, status,
        status === 'confirmed' ? now : null, now, now]);
    }
    run(`INSERT INTO audit_log (id, owner_id, actor, action, target_type, target_id, meta_json, created_at)
         VALUES (?, ?, 'user', 'profile.save', 'user_profile', ?, ?, ?)`,
    [newId('aud'), ownerId, ownerId, JSON.stringify({ status, fields: Object.keys(normalized) }), now]);
    bumpRevision();
    return { ...projection(one('SELECT * FROM user_profiles WHERE owner_id = ?', [ownerId])), exists: true };
  });
}
export function profilePayload(profile) {
  if (!profile) return null;
  return {
    preferred_locations: profile.preferred_locations,
    salary_expectation: profile.salary_expectation,
    work_mode: profile.work_mode,
    career_direction: profile.career_direction,
    industry_preferences: profile.industry_preferences,
    company_preferences: profile.company_preferences,
    summary_text: profile.summary_text
  };
}
