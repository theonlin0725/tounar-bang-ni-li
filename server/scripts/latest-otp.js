import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

const files = fs.existsSync(config.outboxDir)
  ? fs.readdirSync(config.outboxDir).filter((f) => f.endsWith('.json')).sort().reverse()
  : [];
let found = null;
for (const file of files) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(config.outboxDir, file), 'utf8'));
    if (record.kind === 'otp' && record.metadata?.dev_code) {
      found = { file, email: record.to, code: record.metadata.dev_code, created_at: record.created_at };
      break;
    }
  } catch { /* ignore malformed */ }
}
if (!found) {
  console.log(JSON.stringify({ found: false, message: '没有找到开发 outbox 中的验证码；生产 SMTP 模式不会写 outbox，也不会打印验证码。' }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(found, null, 2));
}
