import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, strongViewEvent } from './helpers.js';

const RESUME = `张明
数据产品实习生
熟悉 SQL、Python 与用户研究。
2026 年在星河科技担任数据产品实习生，负责指标体系和用户研究，推动留存提升。
优势：跨团队沟通与需求分析。`;

let fake, fakePort, server, cookie, peerCookie, deviceToken, failAnalyze = false;
let appliedAId = null, appliedBId = null;
const calls = [];
before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}');
    const system = payload.messages?.[0]?.content || '';
    const user = payload.messages?.[1]?.content || '';
    calls.push({ url: req.url, authorization: req.headers.authorization, system });
    res.setHeader('Content-Type', 'application/json');
    if (failAnalyze) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'fake failure' } })); return; }
    let answer;
    if (system.includes('简历结构化助手')) {
      answer = {
        summary: '数据产品方向实习生，具备 SQL、用户研究和跨团队沟通经验。',
        skills: [{ name: 'SQL', evidence: '熟悉 SQL' }, { name: '用户研究', evidence: '用户研究' }],
        experiences: [{ organization: '星河科技', role: '数据产品实习生', period: '2026', highlights: ['指标体系', '用户研究'], evidence: '2026 年在星河科技担任数据产品实习生' }],
        industries: [{ name: '数据产品', evidence: '数据产品实习生' }],
        strengths: [{ point: '跨团队沟通', evidence: '跨团队沟通与需求分析' }],
        constraints: []
      };
    } else if (system.includes('岗位比较助手')) {
      const input = JSON.parse(user);
      answer = {
        overview: '两个岗位都偏数据产品，第一个与简历更贴近。',
        jobs: input.jobs.map((j) => ({
          application_id: j.application_id, match_level: 'medium',
          strengths: ['SQL 与用户研究可迁移'], gaps: ['缺少行业深度'],
          evidence: [{ resume_evidence: '熟悉 SQL', jd_evidence: '数据分析' }],
          next_step: '补充行业项目案例'
        })),
        differences: ['岗位职责侧重不同'],
        ranking: input.jobs.map((j, i) => ({ application_id: j.application_id, rank: i + 1, reason: '相对匹配' })),
        limitations: ['仅基于现有 JD']
      };
    } else {
      const input = JSON.parse(user);
      answer = {
        summary: '优先准备第一梯队的未投递岗位。',
        recommendations: input.jobs.slice(0, 2).map((j, i) => ({
          application_id: j.application_id, rank: i + 1, match_level: 'high',
          reasons: ['技能有交叉'], strengths: ['数据与用户研究'], gaps: ['行业经验待补'], next_step: '先补行业研究'
        })),
        limitations: ['未连接外部招聘网站']
      };
    }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  fakePort = fake.address().port;
  server = await startTestServer({
    name: 'career-ai',
    env: {
      AI_API_URL: `http://127.0.0.1:${fakePort}/v1`,
      AI_API_KEY: 'test-key',
      AI_MODEL: 'fake-model',
      AI_PROVIDER: 'openai_compatible',
      AI_LLM_TIMEOUT_MS: '5000',
      CLOUD_LLM_ENABLED: 'false'
    }
  });
  cookie = (await server.login('demo@tounar.local')).cookie;
  peerCookie = (await server.login('peer@tounar.local')).cookie;
  deviceToken = (await server.pairDevice(cookie, 'AI 测试设备')).device_token;
});
after(async () => {
  await server?.stop();
  await new Promise((resolve) => fake?.close(resolve));
});

const post = (path, body, opts = {}) => server.request(path, { method: 'POST', cookie, body, ...opts });
const get = (path) => server.request(path, { cookie });
async function uploadResume() {
  const res = await post('/api/v1/resumes/text', { text: RESUME, filename: '测试简历.txt' });
  assert.equal(res.status, 201, res.text);
  return res.json.data;
}
async function createApp(body, key) {
  return server.request('/api/v1/applications/manual', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body
  });
}

it('模型配置可用；文本简历上传、结构化分析后画像有原文证据', async () => {
  const status = await get('/api/v1/ai/status');
  assert.equal(status.json.data.available, true);
  assert.equal(status.json.data.provider, 'openai_compatible');
  const resume = await uploadResume();
  assert.equal(resume.status, 'parsed');
  assert.ok(resume.text.includes('星河科技'));
  const analyzed = await post(`/api/v1/resumes/${resume.id}/analyze`, {});
  assert.equal(analyzed.status, 200, analyzed.text);
  assert.equal(analyzed.json.data.status, 'ready');
  assert.equal(analyzed.json.data.profile.skills[0].name, 'SQL');
  assert.equal(analyzed.json.data.profile.experiences[0].organization, '星河科技');
  assert.ok(calls.some((c) => c.system.includes('简历结构化助手')));
  const current = await get('/api/v1/resumes/current');
  assert.equal(current.json.data.id, resume.id);
  assert.equal(current.json.data.profile.grounded, true);
});

it('岗位对比使用当前账号的真实岗位、标记已投递并返回相对排序', async () => {
  const resume = (await get('/api/v1/resumes/current')).json.data;
  assert.equal(resume.status, 'ready');
  const a = await createApp({
    company_name: '星河科技', job_title: '数据产品实习生', has_applied: true, status: 'applied',
    applied_date: '2026-10-01', jd_summary: '数据分析、用户研究', job_url: 'https://jobs.example.com/a'
  }, 'career-a');
  const b = await createApp({
    company_name: '云杉数据', job_title: '数据产品经理', has_applied: true, status: 'applied',
    applied_date: '2026-10-02', jd_summary: '指标体系、SQL 数据分析', job_url: 'https://jobs.example.com/b'
  }, 'career-b');
  assert.equal(a.status, 201, a.text); assert.equal(b.status, 201, b.text);
  appliedAId = a.json.data.id; appliedBId = b.json.data.id;
  const compared = await post('/api/v1/ai/compare', { application_ids: [a.json.data.id, b.json.data.id] });
  assert.equal(compared.status, 200, compared.text);
  const report = compared.json.data;
  assert.equal(report.status, 'ready');
  assert.equal(report.result.jobs.length, 2);
  assert.ok(report.result.jobs.every((j) => j.has_applied === true));
  assert.ok(report.result.ranking.length === 2);
  assert.ok(report.result.overview);
});

it('自动推荐只读取未投递岗位，JD 不足单独列出，不改变岗位状态', async () => {
  const pendingBatch = await server.eventBatch(deviceToken, [strongViewEvent({
    event_type: 'job_viewed',
    payload: {
      company_name: '青禾网络', job_title: '用户研究实习生', site_job_id: 'ai-pending-1',
      job_url: 'https://jobs.example.com/pending-1', location: '上海',
      jd_text: '岗位职责\n负责用户访谈、问卷设计、数据分析与研究报告撰写，推动产品体验优化；与产品、设计和研发团队协作，持续跟踪核心指标并输出洞察。\n任职要求\n熟悉 SQL、Python 与用户研究方法，具备跨团队沟通能力，能够独立完成从问题定义到研究结论的闭环。',
      jd_summary: '用户访谈、问卷设计、数据分析与研究报告'
    }
  })]);
  const pendingId = pendingBatch.json.results[0].application_id;
  assert.ok(pendingId, JSON.stringify(pendingBatch.json));
  const noJdBatch = await server.eventBatch(deviceToken, [strongViewEvent({
    event_type: 'job_discovered',
    payload: {
      company_name: '列表公司', job_title: '列表采到的岗位', site_job_id: 'ai-no-jd-1',
      job_url: 'https://jobs.example.com/no-jd', jd_status: 'missing', jd_summary: null
    }
  })]);
  const noJdId = noJdBatch.json.results[0].application_id;
  assert.ok(noJdId, JSON.stringify(noJdBatch.json));
  const res = await post('/api/v1/ai/recommend', {});
  assert.equal(res.status, 200, res.text);
  const result = res.json.data.result;
  assert.ok(result.recommendations.length >= 1);
  assert.ok(result.recommendations.every((r) => r.application_id !== undefined));
  assert.ok(result.insufficient.some((x) => x.application_id === noJdId));
  assert.ok(!result.recommendations.some((r) => [appliedAId, appliedBId].includes(r.application_id)));
  for (const id of [pendingId, noJdId]) {
    const detail = await get(`/api/v1/applications/${id}`);
    assert.equal(detail.json.data.status, 'pending');
    assert.equal(detail.json.data.has_applied, 0);
  }
});

const PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2OCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDcyIDcyMCBUZCAoSGVsbG8gUmVzdW1lIFNRTCBQeXRob24gVXNlciBSZXNlYXJjaCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNTkgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjkKJSVFT0YK';
const DOCX_B64 = 'UEsDBBQAAAAIAHEBYV2Rzx8FvQAAACkBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QvQ7CMAyEXyXKiqgLAwNqywCswMALWKlbIpofJebv7XEBMTAw2t/d+eRqdXeDulLKNvhaz4pSr5rq+IiUlRCfa31ijkuAbE7kMBchkhfSheSQZUw9RDRn7AnmZbkAEzyT5ymPGbqpNtThZWC1vcv6fUXsWq3fuvFUrTHGwRpkwTBSaKq9lEq2JXXAxDt0ooJbSC20wVycOIv/MVff/nSdhq6zhr7+MS2mYChn63s3FF/i0PrJpwe8ntE8AVBLAwQUAAAACABxAWFdXzOVUpUAAAAHAQAACwAAAF9yZWxzLy5yZWxzjc87DsIwDAbgq0Q+QJ0yMKCmXVi6Ii4QJW5T0TzkhNftycBAEQOjf//6LHfDw6/iRpyXGBS0jYSh70606lKD7JaURW2ErMCVkg6I2TjyOjcxUaibKbLXpY48Y9LmomfCnZR75E8DtqYYrQIebQvi/Ez0jx2naTF0jObqKZQfJ74aVdY8U1Fwj2zRvuOmsoB9h5sX+xdQSwMEFAAAAAgAcQFhXcMse9edAAAAywAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOOw7CMBBEr7LyAeJAQRHlI0RKJH4NrUlMYinetbyGkNtjh4LmjVYzmp2y+dgJ3tqzIazEJstFU5dz0VP3shoDRBu5mCsxhuAKKbkbtVWckdMYvSd5q0I8/SBn8r3z1Glmg4Od5DbPd9IqgyJVPqhfkroEnxDq9nS4w1Vz/AW3yxHOSxgJoVVBwR7VtLDhUqZkol/pVv7a5H9p/QVQSwECFAMUAAAACABxAWFdkc8fBb0AAAApAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAHEBYV1fM5VSlQAAAAcBAAALAAAAAAAAAAAAAACAAe4AAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAHEBYV3DLHvXnQAAAMsAAAARAAAAAAAAAAAAAACAAawBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAAB4AgAAAAA=';

it('PDF、DOCX 文件可解析为文本，不支持格式明确拒绝', async () => {
  const pdf = await post('/api/v1/resumes', { filename: 'resume.pdf', mime: 'application/pdf', data_base64: PDF_B64 });
  assert.equal(pdf.status, 201, pdf.text);
  assert.ok(pdf.json.data.text.includes('Hello Resume SQL'));
  const docx = await post('/api/v1/resumes', { filename: 'resume.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data_base64: DOCX_B64 });
  assert.equal(docx.status, 201, docx.text);
  assert.ok(docx.json.data.text.includes('DOCX Resume SQL'));
  const unsupported = await post('/api/v1/resumes', { filename: 'resume.doc', mime: 'application/msword', data_base64: Buffer.from('old doc').toString('base64') });
  assert.equal(unsupported.status, 415);
  assert.equal(unsupported.json.error.code, 'RESUME_UNSUPPORTED');
});

it('数据隔离：不能读取他人简历或用他人岗位发起对比', async () => {
  const demoResume = (await get('/api/v1/resumes/current')).json.data;
  const crossResume = await server.request(`/api/v1/resumes/${demoResume.id}`, { cookie: peerCookie });
  assert.equal(crossResume.status, 404);
  const peerUpload = await server.request('/api/v1/resumes/text', {
    method: 'POST', cookie: peerCookie, body: { text: REsuMEFallback() }
  });
  assert.equal(peerUpload.status, 201, peerUpload.text);
  const peerAnalyzed = await server.request(`/api/v1/resumes/${peerUpload.json.data.id}/analyze`, { method: 'POST', cookie: peerCookie, body: {} });
  assert.equal(peerAnalyzed.status, 200, peerAnalyzed.text);
  const crossCompare = await server.request('/api/v1/ai/compare', {
    method: 'POST', cookie: peerCookie, body: { application_ids: [appliedAId, appliedBId] }
  });
  assert.equal(crossCompare.status, 404, crossCompare.text);
  const peerStatus = await server.request('/api/v1/ai/status', { cookie: peerCookie });
  assert.equal(peerStatus.json.data.resume_ready, true);
});

it('AI 失败会保留失败状态，重试成功后可用；无候选时返回真实空状态', async () => {
  const peerResume = await server.request('/api/v1/resumes/text', {
    method: 'POST', cookie: peerCookie, body: { text: REsuMEFallback() }
  });
  assert.equal(peerResume.status, 201, peerResume.text);
  failAnalyze = true;
  const failed = await server.request(`/api/v1/resumes/${peerResume.json.data.id}/analyze`, { method: 'POST', cookie: peerCookie, body: {} });
  assert.equal(failed.status, 503, failed.text);
  const failedCurrent = await server.request('/api/v1/resumes/current', { cookie: peerCookie });
  assert.equal(failedCurrent.json.data.status, 'failed');
  assert.equal(failedCurrent.json.data.error_code, 'AI_UNAVAILABLE');
  failAnalyze = false;
  const retried = await server.request(`/api/v1/resumes/${peerResume.json.data.id}/analyze`, { method: 'POST', cookie: peerCookie, body: {} });
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.data.status, 'ready');
  const empty = await server.request('/api/v1/ai/recommend', { method: 'POST', cookie: peerCookie, body: {} });
  assert.equal(empty.status, 200, empty.text);
  assert.equal(empty.json.data.result.recommendations.length, 0);
  assert.equal(empty.json.data.result.insufficient.length, 0);
});

function REsuMEFallback() {
  return `李雷\n数据分析实习生\n熟悉 SQL 与数据可视化。\n2026 年在青禾网络担任数据分析实习生，负责报表和用户研究。`;
}
