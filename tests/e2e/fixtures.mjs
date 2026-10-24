/*
 * 本地 fixture 招聘站点：只用于扩展 E2E（PLUGIN-E2E 门禁）。
 *
 * 覆盖契约（docs/C1-A1-CONTRACT.md）里可本地验证的两条采集路径：
 * 1) JSON-LD JobPosting（通用适配器）
 * 2) 显式 data-tounar-* 契约（成功标记、申请号、状态块）
 * 其余站点适配器仍是草案（G04 未验证），不在本地 fixture 里假装通过。
 */

const JOB_A_HTML = (base) => {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: '前端开发实习生',
    identifier: { '@type': 'PropertyValue', value: 'e2e-job-a' },
    url: `${base}/job-a`,
    datePosted: '2026-09-01',
    hiringOrganization: { '@type': 'Organization', name: '星河科技' },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: '杭州' } },
    description: '工作职责：\n1. 负责 React 前端页面开发与接口联调；\n2. 参与组件库建设与性能优化。\n\n任职要求：\n1. 熟悉 JavaScript/TypeScript；\n2. 了解 React 生态与工程化；\n3. 有良好的沟通与协作能力。'
  };
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>前端开发实习生 · 星河科技</title>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body>
<h1 class="job-title">前端开发实习生</h1>
<p class="company-name">星河科技</p>
<div class="job-detail">工作职责：
1. 负责 React 前端页面开发与接口联调；
2. 参与组件库建设与性能优化。

任职要求：
1. 熟悉 JavaScript/TypeScript；
2. 了解 React 生态与工程化；
3. 有良好的沟通与协作能力。</div>
<form id="apply-form" action="#">
  <input id="candidate-name" name="candidate_name" placeholder="姓名" autocomplete="off">
  <button type="button" id="submit-apply">提交申请</button>
</form>
<script>
  document.getElementById('submit-apply').addEventListener('click', function () {
    document.getElementById('apply-form').outerHTML =
      '<div data-tounar-submitted="true" data-tounar-application-id="APP-E2E-0001">投递成功，申请编号 APP-E2E-0001</div>';
  });
</script>
</body>
</html>`;
};

const JOB_B_HTML = (base) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>数据分析实习生 · 云图数据</title>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "数据分析实习生",
  "identifier": { "@type": "PropertyValue", "value": "e2e-job-b" },
  "url": "${base}/job-b",
  "hiringOrganization": { "@type": "Organization", "name": "云图数据" },
  "jobLocation": { "@type": "Place", "address": { "@type": "PostalAddress", "addressLocality": "上海" } },
  "description": "负责业务数据分析与看板维护。"
}
</script>
</head>
<body>
<h1 class="job-title">数据分析实习生</h1>
<p class="company-name">云图数据</p>
</body>
</html>`;

// 负样本：列表页有两个 JobPosting（multiple），且没有岗位详情标题选择器，
// 不应产生任何事件（避免"浏览列表即入库"的误采）。
const JOB_LIST_HTML = (base) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>校招岗位列表</title>
<script type="application/ld+json">
[
  {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": "岗位甲",
    "url": "${base}/job-list?x=1",
    "hiringOrganization": { "@type": "Organization", "name": "甲公司" }
  },
  {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": "岗位乙",
    "url": "${base}/job-list?x=2",
    "hiringOrganization": { "@type": "Organization", "name": "乙公司" }
  }
]
</script>
</head>
<body>
<p>共 2 个岗位</p>
<div class="card-title">岗位甲 · 甲公司</div>
<div class="card-title">岗位乙 · 乙公司</div>
</body>
</html>`;

const STATUS_HTML = (base) => `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>我的投递记录</title></head>
<body>
<p>投递记录</p>
<div
  id="record-1"
  data-tounar-status="面试中"
  data-tounar-company="星河科技"
  data-tounar-job-title="前端开发实习生"
  data-tounar-job-id="e2e-job-a"
  data-tounar-job-url="${base}/job-a"
  data-tounar-application-id="APP-E2E-0001"
  data-tounar-round="一面">面试中 · 星河科技 · 前端开发实习生</div>
</body>
</html>`;

export async function startFixtureServer({ port }) {
  const { createServer } = await import('node:http');
  const base = `http://127.0.0.1:${port}`;
  const pages = new Map([
    ['/job-a', JOB_A_HTML(base)],
    ['/job-b', JOB_B_HTML(base)],
    ['/job-list', JOB_LIST_HTML(base)],
    ['/status', STATUS_HTML(base)],
    ['/', `<a href="/job-a">job-a</a> <a href="/job-b">job-b</a> <a href="/job-list">job-list</a> <a href="/status">status</a>`]
  ]);
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, base).pathname;
    const body = pages.get(pathname);
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    base,
    port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
