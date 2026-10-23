// Diagnose the page actually displayed after SPA navigation, including HTTP-200
// error shells. A reachable URL alone never establishes a successful job probe.
export function pageIssue({ url, status, title = '', body = '' }) {
  if (!status || status < 200 || status >= 300) return 'invalid_http_response';
  let parsed;
  try { parsed = new URL(url); } catch { return 'invalid_navigation'; }
  if (!/^https?:$/.test(parsed.protocol)) return 'invalid_navigation';
  if (/\/(?:passport|captcha|security|verify)(?:[/.]|$)/i.test(parsed.pathname)) return 'verification_required';
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length < 10) return 'empty_page';
  if (/^(?:请稍候|请稍后|just a moment|access denied|安全验证|人机验证|身份验证|登录|login|sign in)(?:\s|[-—_|]|$)/i.test(title.trim())) return 'verification_or_loading_page';
  if (/访问链接出错|页面不存在|职位不存在|该职位已下线|招聘信息已过期|upstream connect error|access denied/i.test(text)) return 'unavailable_page';
  if (text.length < 250 && /正在加载|加载中|loading\.{0,3}|network error/i.test(text)) return 'loading_page';
  return null;
}

// Reports must not persist challenge tokens embedded in redirect queries.
export function reportUrl(raw) {
  try { const url = new URL(raw); return /^https?:$/.test(url.protocol) ? url.origin + url.pathname : null; }
  catch { return null; }
}
