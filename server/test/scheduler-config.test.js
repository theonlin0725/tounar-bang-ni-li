import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

async function status(env) {
  const dir = path.join(ROOT, '.tmp', 'tests', `scheduler-config-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const script = "import { schedulerStatus } from './server/src/jobs/scheduler.js'; console.log(JSON.stringify(schedulerStatus()));";
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir, ENABLE_SCHEDULER: 'false', ...env }
    });
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

it('收信与提醒发信可独立开启，不被旧的 ENABLE_SCHEDULER 一起关掉', async () => {
  const mailOnly = await status({ ENABLE_MAIL_SCHEDULER: 'true', ENABLE_REMINDER_SCHEDULER: 'false' });
  assert.equal(mailOnly.mail_enabled, true);
  assert.equal(mailOnly.reminder_enabled, false);
  const reminderOnly = await status({ ENABLE_MAIL_SCHEDULER: 'false', ENABLE_REMINDER_SCHEDULER: 'true' });
  assert.equal(reminderOnly.mail_enabled, false);
  assert.equal(reminderOnly.reminder_enabled, true);
  const off = await status({ ENABLE_MAIL_SCHEDULER: 'false', ENABLE_REMINDER_SCHEDULER: 'false' });
  assert.equal(off.mail_enabled, false);
  assert.equal(off.reminder_enabled, false);
});
