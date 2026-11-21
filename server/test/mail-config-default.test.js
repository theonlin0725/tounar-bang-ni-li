import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const run = promisify(execFile);
async function configProbe(extra = {}) {
  const dir = path.join(ROOT, '.tmp', 'tests', `mail-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const script = `import { config } from './server/src/config.js'; console.log(JSON.stringify({ judge: config.mailIntakeJudge, auto: config.autoIntakeEnabled }));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dir, APP_ENV: 'test', JEV_API_KEY: '',
      AI_API_URL: 'http://127.0.0.1:1/v1', AI_API_KEY: 'test-ai', AI_MODEL: 'test-model',
      ...extra
    }
  });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

it('有 AI 网关且没有 Jev key 时，邮件自动判断默认 Flash 且启用自动入账', async () => {
  const result = await configProbe({ MAIL_INTAKE_JUDGE: '' });
  assert.equal(result.judge, 'flash');
  assert.equal(result.auto, true);
});

it('显式 MAIL_INTAKE_JUDGE=jev 仍可覆盖默认；缺 AI key 时不误启用', async () => {
  const jev = await configProbe({ MAIL_INTAKE_JUDGE: 'jev' });
  assert.equal(jev.judge, 'jev');
  assert.equal(jev.auto, false);
  const noAi = await configProbe({ AI_API_KEY: '', AI_API_URL: '', MAIL_INTAKE_JUDGE: '' });
  assert.equal(noAi.auto, false);
});
