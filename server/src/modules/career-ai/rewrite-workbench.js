import { all, one, run, transaction } from '../../db.js';
import { AppError, newId, nowIso, safeJsonParse } from '../../util.js';
import { getApplication } from '../../db.js';
import { getResume, createResumeVersionFromText } from './service.js';
import { applicationDetail } from '../../domain/ledger.js';
import { profileForMatch, profilePayload } from '../profile/service.js';
import { chatAgent } from '../agent/llm.js';
import { generateResumeDocx, verifySingleA4Docx, writeResumeDocx } from './docx-exporter.js';

const ALIGNMENT_TYPES = ['supported_optimize', 'improvable', 'needs_user_fact', 'unsupported_blocked'];
const BLOCK_ALIGNMENTS = new Set([...ALIGNMENT_TYPES, 'unchanged']);
const SECTION_NAMES = '基本信息|个人信息|教育背景|教育经历|工作经历|实习经历|项目经历|校园经历|技能|技能证书|证书|获奖|荣誉|荣誉\\s*[&＆与及]\\s*技能|自我评价|求职意向|个人总结|专业技能|研究经历|其他经历|其他|兴趣爱好|资格证书|获奖经历|志愿经历';
const SECTION_RE = new RegExp(`^(${SECTION_NAMES}|语言能力)$`);
const SECTION_PREFIX_RE = new RegExp(`^(${SECTION_NAMES})[：:]`);

function text(value, max = 2000) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, max);
}
function norm(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
const HAS_DATE = /(?:\b(?:0?[1-9]|1[0-2])\/20\d{2}|\b20\d{2}[./年-]\s*\d{1,2})/;
const BULLET = /^(?:[·•●▪◦]|[-*]\s|\d+[.)、]\s|[①②③④⑤⑥⑦⑧⑨⑩])/;
const DESCRIPTION = /^(?:[^：:【】]{2,18}[：:]\s*\S)/;
const DATED_ENTRY = /\s+(?:\d{1,2}\/20\d{2}|20\d{2}[./-]\d{1,2})(?:\s*[-–—至]\s*(?:[\d./-]+|至今|今|Present))?$/i;
const EXPERIENCE = new Set(['实习经历', '项目经历']);
const ROLE_LINE = /^(?:[^，。；！？]{1,28}(?:实习生|实习|助理|工程师|顾问|专员|研究员))(?:\s*[｜|]\s*[^，。；！？]{1,25})?$/;
const INLINE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N}\s/&+·（）()_-]{0,23}[：:]\s*/u;
function descriptionParts(value) {
  const marker = (value.match(BULLET)?.[0] || '').length;
  const start = marker + (value.slice(marker).match(/^\s*/)?.[0].length || 0);
  const label = value.slice(start).match(INLINE_LABEL)?.[0] || '';
  const end = start + label.length;
  return { prefix: value.slice(0, end), label, body: value.slice(end) };
}
function sameContent(left, right) {
  const clean = (value) => String(value || '').replace(/[\s\p{P}]/gu, '');
  return clean(left) === clean(right);
}
function preserveDescription(block, value, bodyOnly = false, keepCosmetic = false) {
  const parts = descriptionParts(block.original_text);
  let body = text(value, 4000);
  if (!bodyOnly) {
    const incoming = descriptionParts(body);
    body = parts.label ? incoming.body : body.slice(incoming.prefix.length - incoming.label.length);
  }
  return body && (keepCosmetic || !sameContent(parts.body, body)) ? parts.prefix + body : block.original_text;
}
function editableBlock(block) {
  return EXPERIENCE.has(block.section) && !['heading', 'entry', 'subtitle'].includes(block.kind)
    && !/^(?:公司名称|公司|机构名称|机构|岗位名称|岗位|职位|项目名称|项目名|实习单位|实习时间|项目时间|项目链接|链接)\s*[：:]/.test(block.original_text)
    && !/(?:https?:\/\/|\bwww\.)/i.test(block.original_text)
    && (block.kind === 'bullet' || DESCRIPTION.test(block.original_text)
      || (block.original_text.length >= 22 && /[，。；！？]/.test(block.original_text)));
}
function isResumeBoundary(line) {
  return SECTION_RE.test(line) || SECTION_PREFIX_RE.test(line)
    || /^([·•●▪◦]|[-*]\s|\d+[.)、]\s?|[①②③④⑤⑥⑦⑧⑨⑩]\s?)/.test(line)
    || /^(20\d{2}[./年-]|[0-9]{4}[./-][0-9]{1,2}\s*[-–至])/.test(line)
    || /^[^：:]{2,24}[：:]$/.test(line);
}
function appendPdfLine(previous, next) {
  const left = String(previous || '').replace(/\s+$/, '');
  const right = String(next || '').replace(/^\s+/, '');
  if (!left) return right;
  if (!right) return left;
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? `${left} ${right}` : `${left}${right}`;
}
export function normalizeResumeBlocks(resumeText, { format } = {}) {
  const lines = String(resumeText || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let section = '基本信息';
  let current = null;
  const flush = () => {
    if (!current) return;
    blocks.push({ block_id: `b${blocks.length + 1}`, section: current.section, kind: current.kind, original_text: current.text });
    current = null;
  };
  for (const raw of lines) {
    const line = String(raw || '').replace(/[ \t]+/g, ' ').trim().replace(/^\uF0B7\s*/, '• ');
    if (!line) { flush(); continue; }
    const sectionMatch = line.match(SECTION_RE) || line.match(SECTION_PREFIX_RE);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1];
      const rest = line.slice(sectionMatch[0].length).trim();
      blocks.push({ block_id: `b${blocks.length + 1}`, section, kind: 'heading', original_text: rest ? sectionMatch[0] : line });
      if (rest) current = { section, kind: 'paragraph', text: rest };
      continue;
    }
    const entry = !BULLET.test(line) && DATED_ENTRY.test(line);
    const subtitle = /^【.+】$/.test(line) || (section === '实习经历' && !BULLET.test(line) && ROLE_LINE.test(line));
    const kind = entry ? 'entry' : subtitle ? 'subtitle' : BULLET.test(line) ? 'bullet' : 'paragraph';
    const declared = kind !== 'paragraph' || isResumeBoundary(line) || DESCRIPTION.test(line);
    const softWrap = format === 'pdf' && current && ['实习经历', '项目经历'].includes(section)
      && (current.kind === 'bullet' || (current.kind === 'paragraph' && DESCRIPTION.test(current.text)))
      && !declared && !HAS_DATE.test(line) && !/^(?:.*[｜|]\s*\S{1,10}|.*\s链接)\s*$/.test(line);
    if (!softWrap) {
      flush();
      current = { section, kind, text: line };
      continue;
    }
    current.text = appendPdfLine(current.text, line);
  }
  flush();
  // An undated project can still have an identifiable title, especially in Word and pasted text.
  for (const [index, block] of blocks.entries()) {
    const next = blocks[index + 1];
    if (EXPERIENCE.has(block.section) && block.kind === 'paragraph' && next?.section === block.section
      && (block.section === '项目经历' || next.kind === 'subtitle' || !DESCRIPTION.test(block.original_text))
      && (next.kind === 'bullet' || next.kind === 'subtitle' || DESCRIPTION.test(next.original_text))
      && !/^(?:项目背景|项目概述|核心功能|关键迭代|主要职责|项目成果|项目描述|负责|参与|使用|通过|基于|搭建|设计|实现|开发|构建|优化|主导|完成|针对|结合|采用)/.test(block.original_text)
      && !/[，。；！？]$/.test(block.original_text) && block.original_text.length <= 52
      && (!DESCRIPTION.test(block.original_text) || (next.kind === 'bullet' && !/[，。；！？]/.test(block.original_text)))) block.kind = 'entry';
  }
  return blocks;
}
function sourceBlocks(resumeText, layout) {
  return normalizeResumeBlocks(resumeText, { format: layout?.format });
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
function fakeJdAnalysis(profile) {
  return {
    hard_requirements: ['本科及以上学历'],
    core_competencies: ['数据分析', '用户研究', 'SQL'],
    plus_items: ['增长项目经验'],
    other_requirements: ['跨团队沟通'],
    keywords: ['数据分析', '用户研究', 'SQL'],
    core_keywords: ['用户增长', '数据分析', 'SQL', '项目复盘'],
    target_persona: '数据驱动的增长/运营人才',
    gaps: profile ? [] : ['求职画像未建立，偏好判断受限']
  };
}
function fakeGeneration(resume, application, profile) {
  const blocks = sourceBlocks(resume.text, resume.layout_meta);
  return {
    jd_analysis: fakeJdAnalysis(profile),
    alignments: blocks.filter(editableBlock).slice(0, 2).map((block, index, eligible) => ({
      block_id: block.block_id,
      alignment_type: index === 0 && eligible.length > 1 ? 'supported_optimize' : 'needs_user_fact',
      rewritten_text: index === 0 ? `${block.original_text}（突出与目标岗位相关的成果）` : block.original_text,
      reason: index === 0 ? '对齐目标岗位关键词' : '需要补充真实量化数据',
      jd_evidence: String(application.jd_text || application.jd_summary || '').slice(0, 120),
      needs_user_fact: index === 1
    })),
    report: { keyword_coverage: 62, gaps: ['需要补充量化结果'], risks: ['未补充事实的内容不会写入正文'] }
  };
}
function normalizeJdAnalysis(value) {
  const source = value && typeof value === 'object' ? value : {};
  const list = (v, max = 12) => (Array.isArray(v) ? v : []).map((item) => text(item, 300)).filter(Boolean).slice(0, max);
  return {
    hard_requirements: list(source.hard_requirements),
    core_competencies: list(source.core_competencies),
    plus_items: list(source.plus_items),
    other_requirements: list(source.other_requirements),
    keywords: list(source.keywords, 24),
    core_keywords: list(source.core_keywords, 24),
    target_persona: text(source.target_persona, 300),
    gaps: list(source.gaps)
  };
}
function editDistance(a, b) {
  const left = [...a]; const right = [...b];
  let prev = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= right.length; j += 1) {
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    prev = next;
  }
  return prev[right.length];
}
function nearlySameText(a, b) {
  const strip = (value) => String(value || '').replace(/[\s，。；：、,.!?！？（）()【】\[\]]/g, '').toLowerCase();
  const left = strip(a); const right = strip(b);
  if (left === right) return true;
  const max = Math.max(left.length, right.length);
  return max > 0 && editDistance(left, right) / max < 0.05;
}
async function askJson(messages, maxTokens = 6000) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await chatAgent({
        messages: attempt === 0 ? messages : [...messages, { role: 'user', content: '上次输出不是合法 JSON。请只返回紧凑、可解析的 JSON，不要 Markdown，不要解释。' }],
        temperature: 0.1, maxTokens, responseFormat: { type: 'json_object' }, timeoutMs: 120000, reasoningEffort: 'low'
      });
      return parseJson(result.content);
    } catch (error) {
      lastError = error;
    }
  }
  throw new AppError(502, 'REWRITE_INVALID_RESPONSE', '简历改写结果无法解析，请重试', { retryable: true, details: { reason: lastError?.code || 'JSON_PARSE' } });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function updateDraftProgress(ownerId, draftId, percent, label) {
  run('UPDATE resume_rewrite_drafts SET progress_percent = ?, progress_label = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
    [percent, text(label, 240), nowIso(), draftId, ownerId]);
}
async function processRewriteDraft({ ownerId, draftId, resume, app, jd, profile, requirements, blocks }) {
  try {
    updateDraftProgress(ownerId, draftId, 15, '步骤 1–2 · 正在读取目标岗位完整 JD 与原简历…');
    let jdAnalysis;
    let alignments = [];
    let report = {};
    if (process.env.AGENT_FAKE_MODE === 'true') {
      const generated = fakeGeneration(resume, app, profile);
      jdAnalysis = generated.jd_analysis;
      alignments = generated.alignments;
      report = generated.report;
      updateDraftProgress(ownerId, draftId, 40, '步骤 3–4 · 正在解析 JD 四类要求与整理简历整句…');
      await sleep(80);
      updateDraftProgress(ownerId, draftId, 75, '步骤 5–7 · 正在逐条对齐 JD 关键词并润色实习与项目描述…');
      await sleep(80);
      updateDraftProgress(ownerId, draftId, 95, '步骤 8–9 · 正在生成岗位专属草稿与改写报告…');
      await sleep(80);
    } else {
      const stage1 = await askJson([
        { role: 'system', content: `你是 JD 结构化分析助手。只输出 JSON：{"jd_analysis":{"hard_requirements":[],"core_competencies":[],"plus_items":[],"other_requirements":[],"keywords":[],"core_keywords":[],"target_persona":"","gaps":[]}}。要求：hard_requirements 只放明确硬性门槛；core_competencies 放直接决定录用的核心能力；plus_items 放优先/加分项；other_requirements 放沟通、出差等通用要求；core_keywords 放高频业务术语、方法论和工具名；target_persona 用一句话概括该岗位需要的核心人才画像。不得编造 JD 没有的内容。` },
        { role: 'user', content: JSON.stringify({ jd: jd.slice(0, 12000), profile: profile ? profilePayload(profile) : null, requirements: text(requirements, 1500) }) }
      ], 2600);
      jdAnalysis = normalizeJdAnalysis(stage1.jd_analysis || stage1);
      updateDraftProgress(ownerId, draftId, 40, '步骤 3–4 · 正在解析 JD 四类要求与整理简历整句…');
      const batchSize = 18;
      const batches = [];
      const editable = blocks.filter(editableBlock);
      for (let i = 0; i < editable.length; i += batchSize) batches.push(editable.slice(i, i + batchSize));
      for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        const stage2Messages = [
          { role: 'system', content: '仅改写输入的实习和项目描述正文。rewritten_text 只返回输入 text 对应的正文，不返回条目小标题或项目符号。每条保持一个段落，保留原有事实、数字及职责边界；没有原始指标不得补写。岗位要求不是候选人的事实。' },
          { role: 'system', content: `你是简历定向改写助手。只输出 JSON。执行 9 步中的第 5–9 步：对齐 JD、识别差距、逐条改写和报告。\nDelta 模式：只返回需要改写或标注的 block_id；原表述合适或与岗位无关则省略，不能为了凑数量换标点或同义词。\n四级：supported_optimize 突出原文中与 JD 相关的事实；improvable 提供更清楚的表达；needs_user_fact 保持原文并提示核实；unsupported_blocked 不写入正文。\n用原文已知目标、动作、方法、结果重组句式。只保留有原文依据的内容；有数字才能写数字，不补写痛点或扩大贡献。严禁输出“承接上一条”、标题或残句。每个 block_id 只能来自输入。JSON：{"alignments":[{"block_id":"b1","alignment_type":"supported_optimize|improvable|needs_user_fact|unsupported_blocked","rewritten_text":"","reason":"","jd_evidence":"","needs_user_fact":false}],"report":{"keyword_coverage":0,"gaps":[],"risks":[]}}` },
          { role: 'user', content: JSON.stringify({ jd: jd.slice(0, 12000), jd_analysis: jdAnalysis, profile: profile ? profilePayload(profile) : null, requirements: text(requirements, 1500), batch: i + 1, total_batches: batches.length, blocks: batch.map((b) => {
            const { body, label } = descriptionParts(b.original_text);
            return { block_id: b.block_id, section: b.section, label, text: body };
          }) }) }
        ];
        let stage2 = await askJson(stage2Messages, 6000);
        const alignmentById = new Map((Array.isArray(stage2.alignments) ? stage2.alignments : []).filter(Boolean).map((item) => [item.block_id, item]));
        const businessBlocks = batch.filter((block) => block.kind !== 'heading' && block.original_text.length >= 12);
        const changedBlocks = businessBlocks.filter((block) => {
          const item = alignmentById.get(block.block_id);
          if (!item || !['supported_optimize', 'improvable'].includes(item.alignment_type)) return false;
          return !nearlySameText(item.rewritten_text, descriptionParts(block.original_text).body);
        }).length;
        if (businessBlocks.length >= 3 && changedBlocks / businessBlocks.length < 0.3) {
          updateDraftProgress(ownerId, draftId, 84, `步骤 5–7 · 质量自检发现改写过浅，正在强化 JD 对齐（${i + 1}/${batches.length}）…`);
          stage2 = await askJson([...stage2Messages, { role: 'user', content: '质量自检：上一版改写与原文过于相似，几乎只改标点或个别词。请对每条有证据的经历做明显但仍忠于事实的句式重构，自然融入 target_persona 与 core_keywords；不要编造数字。' }], 6000);
        }
        alignments.push(...(Array.isArray(stage2.alignments) ? stage2.alignments.filter((item) => batch.some((b) => b.block_id === item?.block_id)).map((item) => ({ ...item, body_only: true })) : []));
        report = { ...report, ...(stage2.report || {}), gaps: [...(report.gaps || []), ...(stage2.report?.gaps || [])].slice(0, 20), risks: [...(report.risks || []), ...(stage2.report?.risks || [])].slice(0, 20) };
        updateDraftProgress(ownerId, draftId, batches.length === 1 ? 75 : Math.min(90, 55 + Math.round(((i + 1) / batches.length) * 35)), `步骤 5–7 · 正在润色实习与项目描述（${i + 1}/${batches.length}）…`);
      }
      updateDraftProgress(ownerId, draftId, 95, '步骤 8–9 · 正在生成岗位专属草稿与改写报告…');
    }
    const built = buildRewriteBlocks(resume.text, alignments, report || {}, resume.layout_meta);
    run(`UPDATE resume_rewrite_drafts SET jd_analysis_json=?, alignment_json=?, blocks_json=?, report_json=?,
      progress_percent=100, progress_label=?, status='ready', updated_at=? WHERE id=? AND owner_id=?`,
    [JSON.stringify(jdAnalysis || {}), JSON.stringify({ alignments, blocked_blocks: built.blocked_blocks }),
      JSON.stringify(built.blocks), JSON.stringify(built.report), built.report.optimized_count ? '生成完成！' : '未生成有效改写', nowIso(), draftId, ownerId]);
  } catch (error) {
    run("UPDATE resume_rewrite_drafts SET status='failed', progress_percent=100, progress_label=?, error_message=?, updated_at=? WHERE id=? AND owner_id=?",
      ['生成失败：' + (error?.message || '模型暂时不可用'), text(error?.message || '模型暂时不可用', 500), nowIso(), draftId, ownerId]);
  }
}
export function buildRewriteBlocks(resumeText, alignments = [], report = {}, layout = null) {
  const source = sourceBlocks(resumeText, layout);
  const byId = new Map((Array.isArray(alignments) ? alignments : []).map((item) => [String(item?.block_id || ''), item]));
  const blocked = [];
  const needs = [];
  const blocks = source.map((block) => {
    const editable = editableBlock(block);
    const item = editable ? byId.get(block.block_id) || {} : {};
    const hasDelta = Boolean(item.alignment_type);
    let alignment = BLOCK_ALIGNMENTS.has(item.alignment_type) ? item.alignment_type : (hasDelta ? 'improvable' : 'unchanged');
    let rewritten = editable ? preserveDescription(block, text(item.rewritten_text, 4000).replace(/\s*\n\s*/g, ' '), item.body_only === true) : block.original_text;
    if (alignment === 'unsupported_blocked') { blocked.push(block.block_id); rewritten = block.original_text; }
    if (alignment === 'needs_user_fact') { needs.push({ block_id: block.block_id, section: block.section, prompt: text(item.reason || '请补充真实指标或职责', 300) }); rewritten = block.original_text; }
    if (alignment === 'supported_optimize' || alignment === 'improvable') {
      if (rewritten === block.original_text) alignment = 'unchanged';
    }
    return {
      block_id: block.block_id, section: block.section, kind: block.kind, editable,
      original_text: block.original_text, rewritten_text: rewritten,
      ...(editable ? { description_prefix: descriptionParts(block.original_text).prefix } : {}),
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
  const blocks = sourceBlocks(resume.text, resume.layout_meta);
  if (blocks.some((block) => block.original_text.length > 220 && /(?:教育背景|实习经历|项目经历|荣誉\s*[&＆与及]\s*技能)/.test(block.original_text))
    && !blocks.some((block) => block.kind === 'entry')) {
    throw new AppError(422, 'RESUME_LAYOUT_UNAVAILABLE', '这份旧简历缺少可靠的段落边界。请重新上传原始 Word 或 PDF，再生成改写。');
  }
  const draftId = newId('rwdraft');
  const now = nowIso();
  const proposed = defaultName(resume, app);
  run(`INSERT INTO resume_rewrite_drafts
    (id, owner_id, source_resume_id, application_id, status, jd_analysis_json, alignment_json,
     blocks_json, report_json, proposed_name, progress_percent, progress_label, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ready', '{}', '{}', '[]', '{}', ?, 15, ?, ?, ?)`,
  [draftId, ownerId, resume.id, app.id, proposed, '步骤 1–2 · 正在读取目标岗位完整 JD 与原简历…', now, now]);
  queueMicrotask(() => { void processRewriteDraft({ ownerId, draftId, resume, app, jd, profile, requirements, blocks }); });
  return getRewriteDraft(ownerId, draftId);
}
function draftProjection(row, { includeRelations = true } = {}) {
  if (!row) return null;
  const resume = includeRelations && row.source_resume_id ? one('SELECT id, filename, status, parent_resume_id FROM resumes WHERE id = ? AND owner_id = ?', [row.source_resume_id, row.owner_id]) : null;
  const app = includeRelations && row.application_id ? one('SELECT id, company_name, job_title, location, status FROM applications WHERE id = ? AND owner_id = ?', [row.application_id, row.owner_id]) : null;
  const blocks = includeRelations ? protectedDraftBlocks(row) : [];
  const report = safeJsonParse(row.report_json, {}) || {};
  if (blocks.length) {
    report.optimized_count = blocks.filter((block) => block.editable && !sameContent(block.original_text, block.rewritten_text)).length;
    report.blocked_count = blocks.filter((block) => block.alignment_type === 'unsupported_blocked').length;
    report.needs_user_fact = blocks.filter((block) => block.needs_user_fact).map((block) => ({
      block_id: block.block_id, section: block.section, prompt: block.reason
    }));
    report.needs_user_fact_count = report.needs_user_fact.length;
  }
  return {
    id: row.id, status: row.status, source_resume_id: row.source_resume_id || null,
    application_id: row.application_id || null, source_resume: resume || null, application: app || null,
    photo: includeRelations && resume ? getResume(row.owner_id, resume.id, { includeText: true }).layout_meta?.photo || null : null,
    jd_analysis: safeJsonParse(row.jd_analysis_json, {}) || {},
    alignment: safeJsonParse(row.alignment_json, {}) || {},
    blocks, report,
    proposed_name: row.proposed_name || '', progress_percent: row.progress_percent == null ? 100 : Number(row.progress_percent), progress_label: row.progress_label || '', result_resume_id: row.result_resume_id || null,
    error_message: row.error_message || null, created_at: row.created_at, updated_at: row.updated_at
  };
}
function protectedDraftBlocks(row, edits = []) {
  const saved = safeJsonParse(row.blocks_json, []) || [];
  if (!saved.length) return [];
  if (row.status === 'confirmed' && saved.some((block) => typeof block.description_prefix === 'string')) return saved;
  const source = getResume(row.owner_id, row.source_resume_id, { includeText: true });
  const savedBySource = new Map(saved.map((block) => [JSON.stringify([block.section, block.original_text]), block]));
  const savedById = new Map(saved.map((block) => [block.block_id, block]));
  const links = new Map((source.layout_meta?.links || []).map(({ line, url }) => [norm(line), url]));
  const base = buildRewriteBlocks(source.text, [], {}, source.layout_meta).blocks;
  const byId = new Map(edits.map((block) => [block?.block_id, block]));
  return base.map((block) => {
    if (!block.editable) {
      const url = links.get(norm(block.original_text));
      return block.section === '项目经历' && /^https?:\/\//i.test(url || '') ? { ...block, link_url: url } : block;
    }
    const sameId = savedById.get(block.block_id);
    const prior = sameId?.original_text === block.original_text && sameId?.section === block.section ? sameId
      : savedBySource.get(JSON.stringify([block.section, block.original_text]));
    const edit = byId.get(block.block_id);
    const bodyOnly = typeof edit?.description_text === 'string';
    const requested = bodyOnly ? edit.description_text : edit?.rewritten_text;
    const priorBody = prior?.rewritten_text?.startsWith(block.description_prefix) ? prior.rewritten_text.slice(block.description_prefix.length) : null;
    return {
      ...block,
      rewritten_text: preserveDescription(block, requested ?? priorBody ?? prior?.rewritten_text, bodyOnly || (requested == null && priorBody != null), true),
      alignment_type: BLOCK_ALIGNMENTS.has(prior?.alignment_type) ? prior.alignment_type : 'unchanged',
      reason: text(prior?.reason, 600), jd_evidence: text(prior?.jd_evidence, 600),
      needs_user_fact: prior?.alignment_type === 'needs_user_fact'
    };
  });
}
export function listActiveRewriteDrafts(ownerId) {
  const cutoff = new Date(Date.now() - 10 * 60000).toISOString();
  return all(`SELECT * FROM resume_rewrite_drafts
    WHERE owner_id = ? AND ((status = 'ready' AND COALESCE(progress_percent, 100) < 100) OR updated_at >= ?)
    ORDER BY updated_at DESC LIMIT 10`, [ownerId, cutoff]).map((row) => {
    const { blocks, jd_analysis, report, alignment, ...summary } = draftProjection(row, { includeRelations: false });
    summary.source_resume = row.source_resume_id ? one('SELECT id, filename, status, parent_resume_id FROM resumes WHERE id=? AND owner_id=?', [row.source_resume_id, row.owner_id]) : null;
    summary.application = row.application_id ? one('SELECT id, company_name, job_title, location, status FROM applications WHERE id=? AND owner_id=?', [row.application_id, row.owner_id]) : null;
    return summary;
  });
}
export function getRewriteDraft(ownerId, id) {
  const row = one('SELECT * FROM resume_rewrite_drafts WHERE id = ? AND owner_id = ?', [String(id), ownerId]);
  if (!row) throw new AppError(404, 'REWRITE_DRAFT_NOT_FOUND', '简历改写草稿不存在');
  return draftProjection(row);
}
export function updateRewriteDraft(ownerId, id, body = {}) {
  const row = one('SELECT * FROM resume_rewrite_drafts WHERE id = ? AND owner_id = ?', [String(id), ownerId]);
  if (!row) throw new AppError(404, 'REWRITE_DRAFT_NOT_FOUND', '简历改写草稿不存在');
  if (row.status !== 'ready' || Number(row.progress_percent ?? 100) < 100) throw new AppError(409, 'REWRITE_DRAFT_RUNNING', '简历改写仍在生成中，请稍后编辑');
  const blocks = protectedDraftBlocks(row, Array.isArray(body.blocks) ? body.blocks : []);
  const proposed = body.proposed_name ? text(body.proposed_name, 180) : row.proposed_name;
  run('UPDATE resume_rewrite_drafts SET blocks_json = ?, proposed_name = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
    [JSON.stringify(blocks || safeJsonParse(row.blocks_json, [])), proposed, nowIso(), row.id, ownerId]);
  return getRewriteDraft(ownerId, id);
}
export function confirmRewriteDraft(ownerId, id, body = {}) {
  const row = one('SELECT * FROM resume_rewrite_drafts WHERE id = ? AND owner_id = ?', [String(id), ownerId]);
  if (!row) throw new AppError(404, 'REWRITE_DRAFT_NOT_FOUND', '简历改写草稿不存在');
  if (row.status !== 'ready' || Number(row.progress_percent ?? 100) < 100) throw new AppError(409, 'REWRITE_DRAFT_RUNNING', '简历改写尚未完成，不能保存');
  const source = getResume(ownerId, row.source_resume_id, { includeText: true });
  const app = getApplication(ownerId, row.application_id);
  const blocks = protectedDraftBlocks(row);
  const finalText = blocks.map((block) => block.rewritten_text || block.original_text).join('\n').trim();
  const name = text(body.name || row.proposed_name, 180) || defaultName(source, app || {});
  const photo = source.layout_meta?.photo || null;
  const buffer = generateResumeDocx(finalText, { title: name, blocks, photo });
  verifySingleA4Docx(buffer);
  return transaction(() => {
    const created = createResumeVersionFromText({
      ownerId, text: finalText, filename: name, parentResumeId: source.id, targetApplicationId: row.application_id,
      setCurrent: body.set_current === true, photo, links: source.layout_meta?.links || [],
      rewriteSummary: { source: 'resume_rewrite_workbench', blocks: blocks.map((b) => ({ block_id: b.block_id, alignment_type: b.alignment_type })), report: safeJsonParse(row.report_json, {}) }
    });
    const docx = writeResumeDocx({ ownerId, resumeId: created.id, buffer });
    run('UPDATE resumes SET export_docx_path = ? WHERE id = ? AND owner_id = ?', [docx.relativePath, created.id, ownerId]);
    run("UPDATE resume_rewrite_drafts SET status='confirmed', result_resume_id=?, blocks_json=?, updated_at=? WHERE id=? AND owner_id=?", [created.id, JSON.stringify(blocks), nowIso(), row.id, ownerId]);
    const stored = getResume(ownerId, created.id);
    return { draft: getRewriteDraft(ownerId, row.id), resume: stored, download_url: `/api/v1/resumes/${created.id}/export.docx` };
  });
}
