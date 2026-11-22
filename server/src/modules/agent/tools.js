import { all, one } from '../../db.js';
import { AppError, safeJsonParse } from '../../util.js';
import { applicationDetail, ledgerResponse } from '../../domain/ledger.js';
import { currentResume, getResume, matchApplication, interviewQuestionsForReport } from '../career-ai/service.js';
import { generateResumeRewrite } from '../career-ai/rewrite.js';
import { createPendingAction } from './store.js';

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_jobs',
      description: '按公司、岗位或关键词搜索当前用户台账中的岗位。只读。',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'filter_applications',
      description: '按状态、来源、关键词、投递日期范围、长期无反馈天数筛选投递台账。只读。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['applied', 'assessment', 'interview', 'offer', 'rejected', 'closed', 'all'] },
          source: { type: 'string', enum: ['mail', 'plugin', 'manual', 'all'] },
          query: { type: 'string' },
          applied_from: { type: 'string', description: 'YYYY-MM-DD' },
          applied_to: { type: 'string', description: 'YYYY-MM-DD' },
          inactive_days: { type: 'integer', minimum: 1, maximum: 365, description: '超过 N 天没有新进展' },
          view: { type: 'string', enum: ['applied', 'viewed', 'archived'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_job_detail',
      description: '读取一个岗位的完整 JD、轮次、进展历史与来源。只读。',
      parameters: { type: 'object', properties: { application_id: { type: 'string' } }, required: ['application_id'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'compare_jobs',
      description: '对比 2–5 个岗位的详情、进展与已有匹配报告，返回结构化对比素材。只读。',
      parameters: { type: 'object', properties: { application_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 } }, required: ['application_ids'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_match',
      description: '对单个岗位运行或复用六维匹配分析。只读分析，会生成/复用 ai_reports。',
      parameters: { type: 'object', properties: { application_id: { type: 'string' }, resume_id: { type: 'string' }, force: { type: 'boolean' } }, required: ['application_id'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_interview_questions',
      description: '基于岗位匹配报告生成面试题与答题框架，并持久化到 ai_reports。',
      parameters: { type: 'object', properties: { application_id: { type: 'string' }, report_id: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_status',
      description: '创建修改投递状态的待确认操作；绝不直接写库，必须由用户确认。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object',
              properties: { application_id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'closed'] } },
              required: ['application_id', 'status']
            }
          },
          reason: { type: 'string' }
        },
        required: ['items']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_profile',
      description: '创建或更新六维求职画像待确认单（地点、薪资、工作方式、职业方向、行业偏好、企业偏好）；确认前不写库。',
      parameters: {
        type: 'object',
        properties: {
          preferred_locations: { type: 'array', items: { type: 'string' } },
          salary_expectation: { type: 'string' },
          work_mode: { type: 'string' },
          career_direction: { type: 'string' },
          industry_preferences: { type: 'array', items: { type: 'string' } },
          company_preferences: { type: 'array', items: { type: 'string' } },
          summary_text: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rewrite_resume',
      description: '按目标岗位 JD 与匹配缺口生成简历逐段改写方案，创建待确认操作；绝不覆盖原简历，确认后才新建版本。',
      parameters: {
        type: 'object',
        properties: { application_id: { type: 'string' }, resume_id: { type: 'string' }, requirements: { type: 'string' } },
        required: ['application_id']
      }
    }
  }
];

function clean(value, max = 500) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max); }
function appSummary(app) {
  return {
    id: app.id, company_name: app.company_name, job_title: app.job_title, status: app.status,
    status_label: app.status_label || app.status, has_applied: !!app.has_applied,
    location: app.location || null, recruitment_batch: app.recruitment_batch || null,
    applied_at: app.applied_at || null, last_progress_at: app.last_progress_at || null,
    round_label: app.round_label || null, job_url: app.job_url || null
  };
}
function latestMatchReport(ownerId, applicationId, resumeId = null) {
  const params = [ownerId, applicationId];
  const resumeClause = resumeId ? " AND json_extract(r.context_json, '$.resume.id') = ?" : '';
  if (resumeId) params.push(resumeId);
  return one(`SELECT * FROM ai_reports r WHERE r.owner_id = ? AND r.kind = 'match' AND r.status = 'ready'
    AND EXISTS (SELECT 1 FROM json_each(r.application_ids_json) e WHERE e.value = ?)${resumeClause}
    ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, params);
}
function reportSummary(row) {
  if (!row) return null;
  const result = safeJsonParse(row.result_json, null) || {};
  return {
    id: row.id, status: row.status, created_at: row.created_at,
    job: result.job || null, ability: result.ability || null,
    priority: result.priority || null, gaps: result.gaps || result.risks || result.shortcomings || null,
    result
  };
}
function toolError(message, code = 'VALIDATION_ERROR') { throw new AppError(400, code, message); }

export async function executeTool({ ownerId, sessionId, toolName, args = {}, contextApplicationId = null, contextResumeId = null }) {
  if (toolName === 'search_jobs') {
    const q = clean(args.query, 100).toLowerCase();
    if (!q) toolError('搜索关键词不能为空');
    const rows = all('SELECT * FROM applications WHERE owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC', [ownerId]);
    const limit = Math.max(1, Math.min(20, Number.parseInt(args.limit, 10) || 10));
    const matched = rows.filter((app) => `${app.company_name || ''} ${app.job_title || ''} ${app.location || ''} ${app.recruitment_batch || ''}`.toLowerCase().includes(q)).slice(0, limit);
    return { summary: `找到 ${matched.length} 个匹配岗位`, data: { items: matched.map(appSummary) }, refs: matched.map((app) => ({ type: 'application', id: app.id, label: `${app.company_name || '未命名'} · ${app.job_title || '岗位'}` })) };
  }
  if (toolName === 'filter_applications') {
    const view = ['applied', 'viewed', 'archived'].includes(args.view) ? args.view : 'applied';
    const status = args.status && args.status !== 'all' ? args.status : undefined;
    const source = args.source && args.source !== 'all' ? args.source : undefined;
    const ledger = ledgerResponse(ownerId, {
      view, status, source, q: args.query, applied_from: args.applied_from, applied_to: args.applied_to,
      inactive_days: args.inactive_days, limit: 50
    }).data;
    const items = ledger.items.slice(0, 30).map(appSummary);
    return {
      summary: `筛选到 ${ledger.filtered_total} 条岗位记录（显示 ${items.length} 条）`,
      data: { items, stats: ledger.stats, counts: ledger.counts, filtered_total: ledger.filtered_total, filters: ledger.filters },
      refs: items.map((app) => ({ type: 'application', id: app.id, label: `${app.company_name || '未命名'} · ${app.job_title || '岗位'}` }))
    };
  }
  if (toolName === 'get_job_detail') {
    const id = clean(args.application_id, 100) || contextApplicationId;
    if (!id) toolError('缺少 application_id');
    const detail = applicationDetail(ownerId, id).data;
    return {
      summary: `读取 ${detail.company_name || '岗位'} · ${detail.job_title || ''} 详情`,
      data: {
        ...appSummary(detail), jd_summary: detail.jd_summary || null, jd_text: detail.jd_text || null,
        history: (detail.history || []).slice(0, 20), field_confidence: detail.field_confidence || {},
        open_reviews: detail.open_reviews || []
      },
      refs: [{ type: 'application', id: detail.id, label: `${detail.company_name || '未命名'} · ${detail.job_title || '岗位'}` }]
    };
  }
  if (toolName === 'compare_jobs') {
    const ids = [...new Set((Array.isArray(args.application_ids) ? args.application_ids : []).map((x) => clean(x, 100)).filter(Boolean))];
    if (ids.length < 2 || ids.length > 5) toolError('请选择 2–5 个岗位');
    const items = ids.map((id) => {
      const detail = applicationDetail(ownerId, id).data;
      return { ...appSummary(detail), jd_excerpt: detail.jd_summary || String(detail.jd_text || '').slice(0, 800), match_report: reportSummary(latestMatchReport(ownerId, id)) };
    });
    return { summary: `读取 ${items.length} 个岗位进行对比`, data: { items }, refs: items.map((app) => ({ type: 'application', id: app.id, label: `${app.company_name} · ${app.job_title}` })) };
  }
  if (toolName === 'analyze_match') {
    const id = clean(args.application_id, 100);
    if (!id) toolError('缺少 application_id');
    const resume = args.resume_id
      ? getResume(ownerId, args.resume_id, { includeText: false })
      : (contextResumeId ? getResume(ownerId, contextResumeId, { includeText: false }) : currentResume(ownerId));
    if (!resume) toolError('请先上传并设置一份简历', 'RESUME_REQUIRED');
    const existing = !args.force ? one(`SELECT * FROM ai_reports r WHERE r.owner_id = ? AND r.kind='match' AND r.status='ready'
      AND r.resume_id = ? AND EXISTS (SELECT 1 FROM json_each(r.application_ids_json) e WHERE e.value = ?)
      AND json_extract(r.context_json, '$.resume.updated_at') = ?
      ORDER BY r.created_at DESC LIMIT 1`, [ownerId, resume.id, id, resume.updated_at]) : null;
    const report = existing ? { id: existing.id, status: existing.status, result: safeJsonParse(existing.result_json, null), report_version: existing.report_version } : await matchApplication({ ownerId, applicationId: id, resumeId: resume.id });
    return {
      summary: existing ? '已复用该岗位的六维匹配报告' : '已完成单岗位六维匹配',
      data: { report_id: report.id, status: report.status, result: report.result || null, report_version: report.report_version || null },
      refs: [{ type: 'report', id: report.id, label: '六维匹配报告', application_id: id }, { type: 'application', id, label: '匹配岗位' }]
    };
  }
  if (toolName === 'generate_interview_questions') {
    let reportId = clean(args.report_id, 100);
    const appId = clean(args.application_id, 100);
    if (!reportId && appId) {
      let report = latestMatchReport(ownerId, appId, contextResumeId);
      if (!report) {
        const created = await matchApplication({ ownerId, applicationId: appId });
        report = one('SELECT * FROM ai_reports WHERE id=? AND owner_id=?', [created.id, ownerId]);
      }
      reportId = report?.id || null;
    }
    if (!reportId) toolError('请先选择岗位或匹配报告');
    const questions = await interviewQuestionsForReport(ownerId, reportId);
    const reportRow = one('SELECT application_ids_json FROM ai_reports WHERE id = ? AND owner_id = ?', [reportId, ownerId]);
    const reportAppId = appId || safeJsonParse(reportRow?.application_ids_json, [])[0] || null;
    return { summary: '已生成面试题与答题框架', data: { report_id: reportId, questions }, refs: [{ type: 'report', id: reportId, label: '面试题报告', application_id: reportAppId }] };
  }
  if (toolName === 'update_status') {
    const items = (Array.isArray(args.items) ? args.items : []).slice(0, 20);
    if (!items.length) toolError('没有要修改的记录');
    const prepared = [];
    for (const item of items) {
      const app = one('SELECT * FROM applications WHERE id=? AND owner_id=? AND archived_at IS NULL', [clean(item.application_id, 100), ownerId]);
      if (!app) throw new AppError(404, 'NOT_FOUND', '待修改岗位不存在');
      const status = clean(item.status, 30);
      if (!['pending', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'closed'].includes(status)) toolError('状态无效');
      prepared.push({ application_id: app.id, company_name: app.company_name, job_title: app.job_title, from_status: app.status, status, expected_version: app.version });
    }
    const action = createPendingAction({
      ownerId, sessionId, actionType: 'update_status', payload: { items: prepared, reason: clean(args.reason, 240) },
      summary: { title: prepared.length > 1 ? '批量修改投递状态' : '修改投递状态', items: prepared, risk: prepared.some((item) => ['offer', 'rejected', 'closed'].includes(item.status)) ? '包含终态变更，请确认' : null }
    });
    return { summary: `已生成 ${prepared.length} 条状态修改待确认单`, data: { action }, refs: [{ type: 'action', id: action.id, label: '状态修改确认' }] };
  }
  if (toolName === 'update_profile') {
    const array = (value) => (Array.isArray(value) ? value : String(value || '').split(/[、,，;；\n]/)).map((item) => clean(item, 40)).filter(Boolean).slice(0, 12);
    const profile = {
      preferred_locations: array(args.preferred_locations),
      salary_expectation: clean(args.salary_expectation, 120),
      work_mode: clean(args.work_mode, 80),
      career_direction: clean(args.career_direction, 160),
      industry_preferences: array(args.industry_preferences),
      company_preferences: array(args.company_preferences),
      summary_text: clean(args.summary_text, 240)
    };
    if (!Object.values(profile).some((value) => Array.isArray(value) ? value.length : Boolean(value))) toolError('画像内容为空，请先收集至少一个维度');
    const action = createPendingAction({
      ownerId, sessionId, actionType: 'update_profile', payload: { profile },
      summary: {
        title: '保存求职画像', profile,
        fields: [
          ['职业发展方向', profile.career_direction], ['期望地点', profile.preferred_locations.join('、')],
          ['薪资期望', profile.salary_expectation], ['工作方式', profile.work_mode],
          ['行业偏好', profile.industry_preferences.join('、')], ['企业偏好', profile.company_preferences.join('、')]
        ].filter(([, value]) => value)
      }
    });
    return { summary: '已生成求职画像确认卡，等待确认保存', data: { action }, refs: [{ type: 'action', id: action.id, label: '求职画像确认' }] };
  }
  if (toolName === 'rewrite_resume') {
    const appId = clean(args.application_id, 100) || contextApplicationId;
    if (!appId) throw new AppError(409, 'APPLICATION_REQUIRED', '当前上下文是全部岗位，请先选择目标岗位，或点击下方岗位选择器后再改写简历', { retryable: false });
    const resume = args.resume_id
      ? getResume(ownerId, args.resume_id, { includeText: true })
      : (contextResumeId ? getResume(ownerId, contextResumeId, { includeText: true }) : currentResume(ownerId));
    if (!resume) toolError('请先上传并设置一份简历', 'RESUME_REQUIRED');
    const app = applicationDetail(ownerId, appId).data;
    const report = latestMatchReport(ownerId, appId);
    const rewrite = await generateResumeRewrite({ resume, application: app, report, requirements: args.requirements || '' });
    const action = createPendingAction({
      ownerId, sessionId, actionType: 'rewrite_resume',
      payload: {
        resume_id: resume.id, parent_resume_id: resume.id, application_id: appId, target_application_id: appId,
        version_label: rewrite.version_label, sections: rewrite.sections,
        full_rewritten_text: rewrite.full_rewritten_text, model: rewrite.model
      },
      summary: {
        title: '保存简历定向改写版本', application: `${app.company_name || ''} · ${app.job_title || ''}`, target_application_id: appId,
        source_resume: resume.filename, section_count: rewrite.sections.length,
        preview: rewrite.sections.slice(0, 3), version_label: rewrite.version_label
      }
    });
    return { summary: `已生成 ${rewrite.sections.length} 段简历改写方案，等待确认保存`, data: { action }, refs: [{ type: 'action', id: action.id, label: '简历改写确认' }, { type: 'application', id: appId, label: '目标岗位' }] };
  }
  throw new AppError(400, 'AGENT_TOOL_UNKNOWN', `未知工具：${toolName}`);
}
