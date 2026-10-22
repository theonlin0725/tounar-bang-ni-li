/* 验证 WorkBuddy 云端大模型链路：模型列表 → 一次真实识别调用。
 * 用法：npm run probe:llm
 */
import { cloudLlmAvailable, llmClassifyMail, llmExtractPageLead } from '../server/src/cloud/llm.js';
import { config } from '../server/src/config.js';

if (!cloudLlmAvailable()) {
  console.error('云端大模型未配置：请检查 .env 里的 CLOUD_ENDPOINT / CLOUD_PUBLISHABLE_KEY / CLOUD_LLM_ENABLED');
  process.exit(1);
}
console.log(`endpoint: ${config.cloudEndpoint}`);

const sample = {
  subject: '【美团】2027校园招聘 面试邀请：产品经理岗',
  bodyText: '亲爱的同学：恭喜你通过初筛，邀请你参加产品经理岗的一面，时间 2026-10-25 14:00，线上进行。'
};
const result = await llmClassifyMail(sample);
console.log('邮件识别结果:', JSON.stringify(result, null, 2));
if (!result || result.relevant !== true) {
  console.error('识别失败或未判为招聘邮件');
  process.exit(1);
}

const page = await llmExtractPageLead({ text: '字节跳动 校园招聘 前端开发工程师-抖音 职位描述：负责抖音 Web 端业务开发……' });
console.log('页面提取结果:', JSON.stringify(page, null, 2));
console.log('OK：云端大模型链路可用');
