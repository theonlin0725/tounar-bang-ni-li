/* WorkBuddy 云服务 · 免密钥大模型（D09 第一阶段）
 *
 * 用途：当规则解析拿不准时（识别不出公司/岗位、或判断不了是不是招聘邮件），
 * 把「主题 + 正文摘要」发给云端大模型做兜底识别。
 *
 * 安全边界（与 D08 冻结决策一致）：
 * - LLM 的结果只用于「补充线索、改善待确认摘要」，置信度封顶 0.88，
 *   永远进待确认队列，绝不自动判定状态、绝不自动写终态。
 * - 任何云端失败（配额、超时、网络）都静默回退到纯规则结果，不影响主流程。
 */
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import { config } from '../config.js';

let client = null;
let modelIdPromise = null;

export function cloudLlmAvailable() {
  return !!(config.cloudLlmEnabled && config.cloudEndpoint && config.cloudPublishableKey);
}

function getClient() {
  if (!client) {
    client = createWorkBuddyCloud({
      endpoint: config.cloudEndpoint,
      publishableKey: config.cloudPublishableKey
    });
  }
  return client;
}

async function pickModelId() {
  const models = await getClient().llm.models.list();
  const model = (models || []).find((m) => m.disabled !== true);
  if (!model) throw new Error('cloud llm: no available model');
  return model.id;
}

async function chatJson(systemPrompt, userPrompt) {
  if (!modelIdPromise) modelIdPromise = pickModelId();
  const model = await modelIdPromise;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.cloudLlmTimeoutMs);
  try {
    let answer = '';
    for await (const chunk of getClient().llm.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      stream: true,
      response_format: { type: 'json_object' },
      signal: controller.signal
    })) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) answer += delta;
    }
    return JSON.parse(answer);
  } finally {
    clearTimeout(timer);
  }
}

const MAIL_SYSTEM = `你是招聘邮件识别助手。用户会把一封邮件的主题和正文摘要给你。
判断它是否与「求职投递进度」相关（投递确认、笔试/测评、面试邀请、offer、拒信、流程进展都算；
广告、订阅推广、与求职无关的邮件不算）。
只输出 JSON，不要输出任何其他文字。字段：
{
  "relevant": true/false,
  "category": "applied|assessment|interview|offer|rejection|progress|irrelevant 之一",
  "company_name": "公司名，识别不出给 null",
  "job_title": "岗位名，识别不出给 null",
  "confidence": 0到1的小数
}`;

/* 邮件兜底识别。输入主题与正文（已截断），输出统一结构的识别结果；失败返回 null。 */
export async function llmClassifyMail({ subject, bodyText }) {
  if (!cloudLlmAvailable()) return null;
  try {
    const clipped = String(bodyText || '').slice(0, 1500);
    const result = await chatJson(MAIL_SYSTEM, `主题：${subject || '(无主题)'}\n\n正文：\n${clipped || '(无正文)'}`);
    if (!result || typeof result !== 'object') return null;
    const confidence = Math.min(0.88, Math.max(0, Number(result.confidence) || 0));
    return {
      relevant: result.relevant === true,
      category: typeof result.category === 'string' ? result.category : null,
      company_name: typeof result.company_name === 'string' && result.company_name.trim() ? result.company_name.trim() : null,
      job_title: typeof result.job_title === 'string' && result.job_title.trim() ? result.job_title.trim() : null,
      confidence,
      source: 'cloud_llm'
    };
  } catch {
    return null; // 静默回退：云端失败绝不影响规则解析主流程
  }
}

const PAGE_SYSTEM = `你是招聘信息提取助手。用户会给你一段招聘网页的文本。
提取公司名和岗位名。只输出 JSON：{"company_name": "...", "job_title": "..."}，识别不出的字段给 null。`;

/* 页面文本兜底提取（插件扫描场景预留）。失败返回 null。 */
export async function llmExtractPageLead({ text }) {
  if (!cloudLlmAvailable()) return null;
  try {
    const clipped = String(text || '').slice(0, 2000);
    if (!clipped.trim()) return null;
    const result = await chatJson(PAGE_SYSTEM, clipped);
    if (!result || typeof result !== 'object') return null;
    const company = typeof result.company_name === 'string' && result.company_name.trim() ? result.company_name.trim() : null;
    const title = typeof result.job_title === 'string' && result.job_title.trim() ? result.job_title.trim() : null;
    if (!company && !title) return null;
    return { company_name: company, job_title: title, source: 'cloud_llm' };
  } catch {
    return null;
  }
}
