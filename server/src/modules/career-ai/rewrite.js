import { AppError, safeJsonParse } from '../../util.js';
import { chatAgent } from '../agent/llm.js';

const SYSTEM = `你是严谨的简历定向改写助手。只基于用户提供的原简历、目标岗位 JD 和已有匹配缺口优化表达，不得编造学历、公司、项目、时间、技能或成果。
只输出 JSON，不要 Markdown。结构：
{
  "version_label": string,
  "sections": [
    {"section_name": string, "original_excerpt": string, "rewritten_excerpt": string, "reason": string, "jd_evidence": string}
  ],
  "full_rewritten_text": string
}
要求：逐段对比只列出原简历中确实存在的段落；保留事实和数字；只做结构重排、关键词对齐、表达压缩和成果量化；缺失信息不要补造。`;

function text(value, max = 2000) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, max);
}
function normalized(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function parseJson(raw) {
  const value = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(value); } catch { /* extract */ }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
  throw new Error('not json');
}

export async function generateResumeRewrite({ resume, application, report = null, requirements = '' }) {
  if (!resume?.text || resume.text.trim().length < 20) throw new AppError(422, 'RESUME_TEXT_TOO_SHORT', '原简历文本不足以改写');
  if (!application) throw new AppError(400, 'VALIDATION_ERROR', '请选择目标岗位');
  if (process.env.AGENT_FAKE_MODE === 'true') {
    const full = `${resume.text}\n\n（针对 ${application.company_name || ''} ${application.job_title || ''} 的定向表达优化版）`;
    return {
      version_label: `${resume.filename || '简历'} · ${application.company_name || ''}${application.job_title || ''}定向版`,
      sections: [{
        section_name: '项目经历', original_excerpt: String(resume.text).slice(0, 120),
        rewritten_excerpt: '突出与目标岗位相关的项目职责、动作和量化结果。',
        reason: '对齐 JD 关键词，保留原事实', jd_evidence: String(application.jd_text || application.jd_summary || '').slice(0, 80)
      }],
      full_rewritten_text: full, model: 'agent-fake', usage: null
    };
  }
  const jd = [application.jd_text, application.jd_summary, application.job_title, application.company_name].filter(Boolean).join('\n');
  if (String(application.jd_text || application.jd_summary || '').trim().length < 20) {
    throw new AppError(409, 'JD_REQUIRED', '目标岗位缺少足够的 JD，无法定向改写');
  }
  const result = await chatAgent({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({
        original_resume: text(resume.text, 18000),
        target_application: {
          company_name: application.company_name, job_title: application.job_title,
          location: application.location, recruitment_batch: application.recruitment_batch,
          jd: jd.slice(0, 12000)
        },
        match_report: report ? safeJsonParse(report.result_json, null) : null,
        user_requirements: text(requirements, 2000)
      }) }
    ],
    temperature: 0.15,
    maxTokens: 6000
  });
  let raw;
  try { raw = parseJson(result.content); } catch { throw new AppError(502, 'AGENT_INVALID_RESPONSE', '简历改写结果无法解析', { retryable: true }); }
  const full = text(raw?.full_rewritten_text, 60000);
  if (full.length < 20) throw new AppError(502, 'AGENT_INVALID_RESPONSE', '模型没有返回完整的改写简历', { retryable: true });
  const originalLength = normalized(resume.text).length;
  if (originalLength >= 500 && normalized(full).length < Math.min(600, originalLength * 0.25)) {
    throw new AppError(502, 'AGENT_INVALID_RESPONSE', '模型返回的改写稿明显短于原简历，已拒绝保存', { retryable: true });
  }
  const resumeHaystack = normalized(resume.text);
  const sections = (Array.isArray(raw?.sections) ? raw.sections : []).map((section) => ({
    section_name: text(section?.section_name, 120),
    original_excerpt: text(section?.original_excerpt, 2000),
    rewritten_excerpt: text(section?.rewritten_excerpt, 2000),
    reason: text(section?.reason, 1000),
    jd_evidence: text(section?.jd_evidence, 1000)
  })).filter((section) => section.section_name && section.rewritten_excerpt
    && (!section.original_excerpt || resumeHaystack.includes(normalized(section.original_excerpt)))).slice(0, 16);
  if (!sections.length) throw new AppError(502, 'AGENT_INVALID_RESPONSE', '模型没有返回逐段改写对比', { retryable: true });
  return {
    version_label: text(raw?.version_label, 160) || `${resume.filename || '简历'} · ${application.company_name || ''}${application.job_title || ''}定向版`,
    sections,
    full_rewritten_text: full,
    model: result.model,
    usage: result.usage
  };
}
