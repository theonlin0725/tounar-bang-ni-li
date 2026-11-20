/* 网易互娱 campus.game.163.com 四岗离线 DOM 回归：规则、模型候选、模型失败三条路径。
 * 不访问真实站点；fixture 由已渲染实页去除脚本/图片/二维码后固定保存。 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = ['4721', '4739', '4731', '4765'];
const EXPECTED = {
  '4721': ['游戏设计师（战斗策划）', '杭州、上海、广州', '游戏热爱'],
  '4739': ['图形开发工程师', '杭州、上海、广州', '实时光追'],
  '4731': ['游戏研发工程师（客户端/服务端）', '杭州、上海、广州', 'C++开发'],
  '4765': ['游戏技术美术工程师（PCG向）', '广州', 'PCG生成']
};
const checks = [];
let failed = 0;
function check(name, ok, detail = '') {
  const pass = Boolean(ok); if (!pass) failed += 1;
  checks.push({ name, ok: pass, detail: String(detail || '') });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: (await resolveChromiumExecutable())?.path, headless: true });
try {
  for (const mode of ['rules', 'model', 'model-fail']) {
    for (const id of FIXTURES) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const html = fs.readFileSync(path.join(ROOT, `tests/fixtures/sites/netease-game/${id}.html`), 'utf8');
      const expected = EXPECTED[id];
      await page.route('https://campus.game.163.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
      await page.addInitScript(({ mode, expected }) => {
        window.__captured = []; window.__models = [];
        window.chrome = {
          storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
          runtime: { lastError: null, sendMessage(message, callback) {
            if (message.type === 'jd_model_config') return callback?.({ ok: true, data: { enabled: mode !== 'rules' } });
            if (message.type === 'jd_model_extract') {
              window.__models.push({ text: message.text, candidates: message.title_candidates || [] });
              if (mode === 'model-fail') return callback?.({ ok: false, error: 'fixture model failure' });
              return callback?.({ ok: true, data: { job: {
                job_title: expected[0], company_name: '网易游戏（互娱）', location: expected[1],
                jd_text: '岗位描述\n模型返回的岗位职责。\n岗位要求\n模型返回的岗位要求。',
                jd_summary: '岗位职责 模型摘要', jd_status: 'complete',
                field_sources: { job_title: 'model_source_quote', company_name: 'model_source_quote', location: 'model_source_quote', jd_summary: 'model_source_quote' },
                field_confidence: { job_title: 'high', company_name: 'high', location: 'high', jd_summary: 'high' }
              } } });
            }
            if (message.type === 'enqueue_event') { window.__captured.push(message.event); return callback?.({ ok: true }); }
            return callback?.({ ok: true });
          }, onMessage: { addListener() {} } }
        };
      }, { mode, expected });
      await page.goto(`https://campus.game.163.com/app/detail/index?id=${id}&projectId=102`, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ path: path.join(ROOT, 'extension/content/adapters.js') });
      await page.addScriptTag({ path: path.join(ROOT, 'extension/content/tracker.js') });
      await page.waitForTimeout(12000);
      const state = await page.evaluate(() => ({ events: window.__captured, models: window.__models }));
      const event = state.events.find((item) => item.event_type === 'job_viewed');
      check(`${mode} / ${id} 同岗浏览事件`, !!event, `events=${state.events.length}`);
      if (event) {
        check(`${mode} / ${id} 公司、纯标题、全部城市`,
          event.payload.company_name === '网易游戏（互娱）'
          && event.payload.job_title === expected[0]
          && event.payload.location === expected[1]
          && !event.payload.job_title.includes(expected[2]),
          JSON.stringify({ company: event.payload.company_name, title: event.payload.job_title, location: event.payload.location }));
        check(`${mode} / ${id} JD 含当前岗职责与要求、摘要能区分岗位`,
          /岗位要求/.test(event.payload.jd_text || '') && /岗位描述|职位描述/.test(event.payload.jd_text || '')
          && (event.payload.jd_summary || '').includes('岗位职责')
          && !/网易互娱持续在不同领域推出爆款游戏，已创造/.test(event.payload.jd_summary || ''),
          String(event.payload.jd_summary || '').slice(0, 80));
        check(`${mode} / ${id} 逐字段来源可追溯`,
          ['company_name', 'job_title', 'location', 'jd_summary'].every((f) => !!event.payload.field_sources?.[f]),
          JSON.stringify(event.payload.field_sources));
      }
      if (mode === 'model') {
        const candidates = state.models[0]?.candidates || [];
        check(`${id} 模型候选只含独立名称，不含名称+标签父节点`,
          candidates.some((item) => item.text === expected[0])
          && !candidates.some((item) => item.text.includes(expected[2]) || item.text === `${expected[0]} ${expected[2]}`),
          JSON.stringify(candidates.map((item) => item.text)));
      }
      if (mode !== 'rules') check(`${mode} / ${id} 模型调用至少一次`, state.models.length >= 1, `models=${state.models.length}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`NETEASE-GAME-FIXTURES：${checks.length - failed}/${checks.length} 通过`);
if (failed) process.exitCode = 1;
