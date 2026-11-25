import crypto from 'node:crypto';
import { AppError } from '../../util.js';

export function jdDifyConfigured() {
  return Boolean(process.env.JD_DIFY_API_URL?.trim() && process.env.JD_DIFY_API_KEY?.trim());
}

export async function runJdWorkflow({ ownerId, inputs, fetchImpl, signal }) {
  const base = process.env.JD_DIFY_API_URL?.trim().replace(/\/+$/, '');
  const key = process.env.JD_DIFY_API_KEY?.trim();
  let endpoint;
  try {
    endpoint = new URL(base + '/workflows/run');
    if (!key || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw new Error();
  } catch {
    throw new AppError(503, 'JD_DIFY_CONFIG', '请检查岗位识别的 Dify API 地址和密钥');
  }
  let response;
  try {
    response = await fetchImpl(endpoint.href, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        inputs,
        response_mode: 'blocking',
        user: 'jd-' + crypto.createHmac('sha256', key).update(String(ownerId)).digest('hex').slice(0, 32)
      }),
      signal
    });
  } catch {
    throw new AppError(502, 'JD_DIFY_UNAVAILABLE', 'Dify 岗位识别暂时无法连接或已超时');
  }
  if (!response.ok) {
    throw new AppError(502, 'JD_DIFY_PROVIDER_ERROR', `Dify 岗位识别调用失败（HTTP ${response.status}）`);
  }
  let data;
  try { data = (await response.json()).data; } catch { /* Invalid response */ }
  if (data?.status !== 'succeeded' || typeof data.outputs?.extraction?.is_job !== 'boolean') {
    throw new AppError(502, 'JD_DIFY_INVALID_RESULT', 'Dify 工作流未成功返回可用岗位结果');
  }
  return data.outputs.extraction;
}
