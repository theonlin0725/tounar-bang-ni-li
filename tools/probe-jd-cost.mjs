#!/usr/bin/env node
// Synthetic examples only. Run with an env file that supplies AI_API_KEY.
import { extractJd } from '../server/src/modules/jd-extraction/service.js';

process.env.JD_AI_ENABLED = 'true';
process.env.JD_AI_API_KEY ||= process.env.AI_API_KEY || '';
process.env.JD_AI_API_URL ||= new URL('chat/completions', process.env.AI_API_URL || 'https://api.deepseek.com/').href;
process.env.JD_AI_MODEL ||= process.env.AI_MODEL || 'deepseek-flash';
if (!process.env.JD_AI_API_KEY) throw new Error('缺少模型密钥');

const samples = [
  {
    task: '新岗位页面提取',
    url: 'https://example.test/job/review-cost-1',
    text: '示例公司招聘：平台工程师\n工作地点：北京\n岗位职责\n1、设计和维护内部服务平台，保障服务稳定运行。\n2、与产品和数据团队协作，改进开发流程。\n任职要求\n1、熟悉 JavaScript 或 Python，具备后端开发经验。\n2、能够阅读技术文档并清晰沟通。'
  },
  {
    task: '已有 JD 整理',
    url: 'https://example.test/job/review-cost-2',
    text: '数据分析师\n示例公司\n上海\n负责整理业务指标、分析运营数据并制作报告。\n与产品团队沟通需求，提出可验证的改进建议。\n要求熟悉 SQL，具有良好的数据表达能力。'
  }
];

for (const sample of samples) {
  const result = await extractJd('synthetic-cost-probe', sample);
  console.log(JSON.stringify({
    task: sample.task,
    model: result.model,
    recognized: Boolean(result.job),
    usage: result.usage,
    estimated_cost_usd: result.estimated_cost,
    elapsed_ms: result.elapsed_ms
  }));
}
