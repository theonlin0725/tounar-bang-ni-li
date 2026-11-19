/* 验证 Gemini API（OpenAI 兼容层）连通性，并检查 career-ai 依赖的 JSON 模式。
 * 用法：
 *   1) 在 .env 写入 AI_API_URL / AI_API_KEY / AI_MODEL（参考 .env.example 第 90 行）
 *   2) npm run probe:gemini
 */
const base = String(process.env.AI_API_URL || '').replace(/\/$/, '');
const apiKey = process.env.AI_API_KEY || process.env.GEMINI_API_KEY || '';
const model = process.env.AI_MODEL || 'gemini-4-hydrogen';

if (!base || !apiKey) {
  console.error('未配置 AI_API_URL / AI_API_KEY。请在 .env 中填写后再运行：');
  console.error('  AI_API_URL=https://generativelanguage.googleapis.com/v1beta/openai');
  console.error('  AI_API_KEY=你的 Gemini key');
  console.error('  AI_MODEL=gemini-4-hydrogen');
  process.exit(1);
}

const url = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
console.log(`endpoint: ${url}`);
console.log(`model:    ${model}`);

const startedAt = Date.now();
let response;
try {
  response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '只输出 JSON，不要 Markdown，不要解释。' },
        { role: 'user', content: '返回 {"ok":true,"purpose":"probe"}' }
      ]
    }),
    signal: AbortSignal.timeout(60000)
  });
} catch (err) {
  console.error(`连接失败：${err?.message || err}`);
  console.error('检查网络/DNS/代理，以及 AI_API_URL 是否正确。');
  process.exit(1);
}

const elapsed = Date.now() - startedAt;
const raw = await response.text();
let payload = null;
try { payload = JSON.parse(raw); } catch { /* 保留原始文本用于报错 */ }

if (!response.ok) {
  console.error(`HTTP ${response.status}（${elapsed}ms）`);
  const hints = {
    400: '请求参数或地区不被支持：确认模型名、AI_API_URL，以及账号所在地区是否支持 Gemini API。',
    401: 'key 无效或已删除：重新在 aistudio.google.com/api-keys 复制。',
    402: 'Prepay 余额为 0：去 aistudio.google.com/billing 充值或开 auto-reload。',
    403: '权限/地区限制：确认 key 属于该项目、账号地区支持 Gemini API；旧的无限制标准 key 也会被拒绝，去 AI Studio 加限制或新建 key。',
    404: 'URL 或模型名错误：AI_API_URL 应为 https://generativelanguage.googleapis.com/v1beta/openai。',
    429: '限流或额度用尽：免费层有 RPM/RPD 限制，或本月额度已用完。'
  };
  if (hints[response.status]) console.error(hints[response.status]);
  console.error(raw.slice(0, 1200));
  process.exit(1);
}

const content = payload?.choices?.[0]?.message?.content ?? '';
let json = null;
try {
  json = JSON.parse(String(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
} catch { /* 交给下面的校验报错 */ }

console.log(`HTTP ${response.status}（${elapsed}ms）`);
console.log(`usage: ${JSON.stringify(payload?.usage ?? {})}`);
console.log(`content: ${String(content).slice(0, 300)}`);

if (!json || json.ok !== true) {
  console.error('返回不是预期的 JSON —— career-ai 依赖 JSON 模式，需要调整模型或请求参数。');
  process.exit(1);
}
console.log('OK：Gemini API 可用，JSON 模式正常');
