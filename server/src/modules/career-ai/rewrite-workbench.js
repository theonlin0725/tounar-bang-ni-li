import { all, one, run, transaction } from '../../db.js';
import { AppError, newId, nowIso, safeJsonParse } from '../../util.js';
import { getApplication } from '../../db.js';
import { getResume, createResumeVersionFromText } from './service.js';
import { applicationDetail } from '../../domain/ledger.js';
import { profileForMatch, profilePayload } from '../profile/service.js';
import { chatAgent } from '../agent/llm.js';
import { writeResumeDocx } from './docx-exporter.js';

const ALIGNMENT_TYPES = ['supported_optimize', 'improvable', 'needs_user_fact', 'unsupported_blocked'];
const SECTION_RE = /^(基本信息|个人信息|教育背景|教育经历|工作经历|实习经历|项目经历|校园经历|技能|技能证书|证书|获奖|荣誉|自我评价|求职意向|个人总结|专业技能|研究经历)$/;

function text(value, max = 2000) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, max);
}
function norm(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function sourceBlocks(resumeText) {
  const lines = String(resumeText || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let section = '基本信息';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (SECTION_RE.test(line)) { section = line; blocks.push({ block_id: `b${blocks.length + 1}`, section, kind: 'heading', original_text: line }); continue; }
    blocks.push({ block_id: `b${blocks.length + 1}`, section, kind: 'line', original_text: line });
  }
  return blocks;
}
function defaultName(resume, app) {
  const base = String(resume.filename || '简历').replace(/\.(pdf|docx|txt|md)$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || '简历';
  const job = String(app.job_title || app.company_name || '岗位').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return `${base}_${job}`.slice(0, 180);
}
function parseJson(raw) {
  const value = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(value); } catch { /* extract */ }
  const start = value.indexOf('{'); const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
  throw new Error('not json');
}
function fakeGeneration(resume, application, profile) {
  const blocks = sourceBlocks(resume.text);
  return {
    jd_analysis: {
      keywords: ['数据分析', '用户研究', 'SQL'], requirements: ['数据分析与用户研究'],
      gaps: profile ? [] : ['求职画像未建立，偏好判断受限']
    },
    alignments: blocks.map((block, index) => ({
      block_id: block.block_id,
      alignment_type: index === 0 ? 'supported_optimize' : (index === 1 ? 'needs_user_fact' : 'improvable'),
      rewritten_text: index === 0 ? `${block.original_text}（突出与目标岗位相关的成果）` : block.original_text,
      reason: index === 0 ? '对齐目标岗位关键词' : (index === 1 ? '需要补充真实量化数据' : '优化表达结构'),
      jd_evidence: String(application.jd_text || application.jd_summary || '').slice(0, 120),
      needs_user_fact: index === 1
    })),
    report: { keyword_coverage: 62, gaps: ['需要补充量化结果'], risks: ['未补充事实的内容不会写入正文'] }
  };
}

export function buildRewriteBlocks(resumeText, alignments = [], report = {}) {
  const source = sourceBlocks(resumeText);
  const byId = new Map((Array.isArray(alignments) ? alignments : []).map((item) => [String(item?.block_id || ''), item]));
  const blocked = [];
  const needs = [];
  const blocks = source.map((block) => {
    const item = byId.get(block.block_id) || {};
    let alignment = ALIGNMENT_TYPES.includes(item.alignment_type) ? item.alignment_type : 'improvable';
    let rewritten = text(item.rewritten_text, 4000) || block.original_text;
    if (alignment === 'unsupported_blocked') { blocked.push(block.block_id); rewritten = block.original_text; }
    if (alignment === 'needs_user_fact') { needs.push({ block_id: block.block_id, section: block.section, prompt: text(item.reason || '请补充真实指标或职责', 300) }); rewritten = block.original_text; }
    if (alignment === 'supported_optimize' || alignment === 'improvable') {
      if (!rewritten || rewritten === block.original_text) alignment = 'improvable';
    }
    return {
      block_id: block.block_id, section: block.section, kind: block.kind,
      original_text: block.original_text, rewritten_text: rewritten,
      alignment_type: alignment,
      reason: text(item.reason, 600), jd_evidence: text(item.jd_evidence, 600),
      needs_user_fact: alignment === 'needs_user_fact'
    };
  });
  return {
    blocks,
    needs_user_fact: needs,
    blocked_blocks: blocked,
    report: {
      ...report,
      optimized_count: blocks.filter((b) => b.alignment_type === 'supported_optimize').length,
      improvable_count: blocks.filter((b) => b.alignment_type === 'improvable').length,
      needs_user_fact_count: needs.length,
      blocked_count: blocked.length,
      needs_user_fact: needs
    }
  };
}

export async function generateRewriteDraft({ ownerId, resumeId, applicationId, requirements = '' }) {
  const resume = getResume(ownerId, resumeId, { includeText: true });
  if (!resume?.text || resume.text.length < 20) throw new AppError(422, 'RESUME_TEXT_TOO_SHORT', '所选简历文本不足');
  const app = applicationDetail(ownerId, applicationId).data;
  const jd = String(app.jd_text || app.jd_summary || '').trim();
  if (jd.length < 20) throw new AppError(409, 'JD_REQUIRED', '目标岗位缺少完整 JD，请先补充 JD 后再改写');
  const profile = profileForMatch(ownerId);
  const blocks = sourceBlocks(resume.text);
  let generated;
  if (process.env.AGENT_FAKE_MODE === 'true') generated = fakeGeneration(resume, app, profile);
  else {
    const result = await chatAgent({
      messages: [
        { role: 'system', content: `你是简历定向改写助手。输出严格 JSON，不要 Markdown。\n必须按 9 步处理：1 读取 JD；2 读取原简历；3 提取 JD 关键词/能力；4 按 block_id 理解简历；5 对齐；6 识别差距；7 输出四级分类；8 只基于原简历事实生成改写；9 输出报告。\n四级：supported_optimize=原文已有可优化；improvable=可提供更清晰表达；needs_user_fact=需要用户补充真实数字/职责，不能编造；unsupported_blocked=无证据，禁止写入。\n每个 block 只能使用原 block 的 block_id，不得创建新经历。没有证据的数字、公司、学历、项目一律不得输出。\nJSON 结构：\n{"jd_analysis":{"keywords":[],"requirements":[],"gaps":[]},"alignments":[{"block_id":"b1","alignment_type":"supported_optimize|improvable|needs_user_fact|unsupported_blocked","rewritten_text":"","reason":"","jd_evidence":"","needs_user_fact":false}],"report":{"keyword_coverage":0,"gaps":[],"risks":[]}}` },
        { role: 'user', content: JSON.stringify({ jd: jd.slice(0, 12000), profile: profile ? profilePayload(profile) : null, requirements: text(requirements, 1500), blocks: blocks.map((b) => ({ block_id: b.block_id, section: b.section, text: b.original_text })) }) }
      ],
      temperature: 0.1,
      maxTokens: 6500
    });
    try { generated = parseJson(result.content); } catch { throw new AppError(502, 'REWRITE_INVALID_RESPONSE', '简历改写结果无法解析，请重试', { retryable: true }); }
  }
  const built = buildRewriteBlocks(resume.text, generated.alignments, generated.report || {});
  const proposed = defaultName(resume, app);
  const draftId = newId('rwdraft');
  const now = nowIso();
  run(`INSERT INTO resume_rewrite_drafts
    (id, owner_id, source_resume_id, application_id, status, jd_analysis_json, alignment_json,
     blocks_json, report_json, proposed_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)`,
  [draftId, ownerId, resume.id, app.id, JSON.stringify(generated.jd_analysis || {}),
    JSON.stringify({ alignments: generated.alignments || [], blocked_blocks: built.blocked_blocks }),
    JSON.stringify(built.blocks), JSON.stringify(built.report), proposed, now, now]);
  return getRewriteDraft(ownerId, draftId);
}

function draftProjection(row, { includeRelations = true } = {}) {
  if (!row) return null;
  const resume = includeRelations && row.source_resume_id ? one('SELECT id, filename, status, parent_resume_id FROM resumes WHERE id = ? AND owner_id = ?', [row.source_resume_id, row.owner_id]) : null;
  const app = includeRelations && row.application_id ? one('SELECT id, company_name, job_title, location, status FROM applications WHERE id = ? AND owner_id = ?', [row.application_id, row.owner_id]) : null;
  return {
    id: row.id, status: row.status, source_resume_id: row.source_resume_id || null,
    application_id: row.application_id || null, source_resume: resume || null, application: app || null,
    jd_analysis: safeJsonParse(row.jd_analysis_json, {}) || {},
    alignment: safeJsonParse(row.alignment_json, {}) || {},
    blocks: safeJsonParse(row.blocks_json, []) || [],
    report: safeJsonParse(row.report_json, {}) || {},
    proposed_name: row.proposed_name || '', result_resume_id: row.result_resume_id || null,
    error_message: row.error_message || null, created_at: row.created_at, updated_at: row.updated_at
  };
}
export function getRewriteDraft(ownerId, id) {
  const row = one('SELECT * FROM resume_rewrite_drafts WHERE id = ? AND owner_id = ?', [String(id), ownerId]);
  if (!row) throw new AppError(404, 'REWRITE_DRAFT_NOT_FOUND', '简历改写草稿不存在');
  return draftProjection(row);
}
export function updateRewriteDraft(ownerId, id, body = {}) {
  const row = one('SELECT * FROM resume_rewrite_drafts WHERE id = ? AND owner_id = ?', [String(id), ownerId]);
  if (!row) throw new AppError(404, 'REWRITE_DRAFT_NOT_FOUND', '简历改写草稿不存在');
  if (row.status !== 'ready') throw new AppError(409, 'REWRITE_DRAFT_RESOLVED', '该改写草稿已处理');
  const blocks = Array.isArray(body.blocks) ? body.blocks.slice(0, 200).map((block) => ({
    ...block,
    block_id: text(block?.block_id, 80), original_text: text(block?.original_text, 4000),
    rewritten_text: text(block?.rewritten_text, 4000), reason: text(block?.reason, 600),
    jd_evidence: text(block?.jd_evidence, 600), alignment_type: ALIGNMENT_TYPES.includes(block?.alignment_type) ? block.alignment_type : 'improvable'
  })) : null;
  const proposed = body.proposed_name ? text(body.proposed_name, 180) : row.proposed_name;
  run('UPDATE resume_rewrite_drafts SET blocks_json = ?, proposed_name = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
    [JSON.stringify(blocks || safeJsonParse(row.blocks_json, [])), proposed, nowIso(), row.id, ownerId]);
  return getRewriteDraft(ownerId, id);
}
export function confirmRewriteDraft(ownerId, id, body = {}) {
  const row = one('SELECT * FROM resume_rewrite_drafts WHERE id = ? AND owner_id = ?', [String(id), ownerId]);
  if (!row) throw new AppError(404, 'REWRITE_DRAFT_NOT_FOUND', '简历改写草稿不存在');
  if (row.status !== 'ready') throw new AppError(409, 'REWRITE_DRAFT_RESOLVED', '该改写草稿已处理');
  const source = getResume(ownerId, row.source_resume_id, { includeText: true });
  const app = getApplication(ownerId, row.application_id);
  const blocks = safeJsonParse(row.blocks_json, []);
  const finalText = blocks.map((block) => block.rewritten_text || block.original_text).join('\n').trim();
  const name = text(body.name || row.proposed_name, 180) || defaultName(source, app || {});
  return transaction(() => {
    const created = createResumeVersionFromText({
      ownerId, text: finalText, filename: name, parentResumeId: source.id, targetApplicationId: row.application_id,
      setCurrent: body.set_current === true, rewriteSummary: { source: 'resume_rewrite_workbench', blocks: blocks.map((b) => ({ block_id: b.block_id, alignment_type: b.alignment_type })), report: safeJsonParse(row.report_json, {}) }
    });
    const docx = writeResumeDocx({ ownerId, resumeId: created.id, text: finalText, title: name });
    run('UPDATE resumes SET export_docx_path = ? WHERE id = ? AND owner_id = ?', [docx.relativePath, created.id, ownerId]);
    run("UPDATE resume_rewrite_drafts SET status='confirmed', result_resume_id=?, updated_at=? WHERE id=? AND owner_id=?", [created.id, nowIso(), row.id, ownerId]);
    const stored = getResume(ownerId, created.id);
    return { draft: getRewriteDraft(ownerId, row.id), resume: stored, download_url: `/api/v1/resumes/${created.id}/export.docx` };
  });
}
