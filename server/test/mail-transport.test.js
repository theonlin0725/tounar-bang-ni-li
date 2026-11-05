import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

it('SMTP 受理、拒绝和超时分别记账，错误不泄露认证信息（本地模拟，无外发）', () => {
  const dir = path.resolve('.tmp/tests/mail-transport');
  const script = `
    import assert from 'node:assert/strict';
    import nodemailer from 'nodemailer';
    let reply={accepted:['test@example.com'],messageId:'fake-local-id'}, error=null;
    nodemailer.createTransport=()=>({sendMail:async()=>{if(error)throw error;return reply;}});
    const {sendMail}=await import('./server/src/modules/mail-push/mailer.js');
    const {all,closeDb}=await import('./server/src/db.js');
    const message={to:'test@example.com',subject:'测试',text:'测试',html:'<p>测试</p>'};
    const accepted=await sendMail(message);assert.equal(accepted.status,'accepted');
    reply={accepted:[],messageId:'rejected-local-id'};
    await assert.rejects(sendMail(message),{code:'RECIPIENT_REJECTED'});
    error=Object.assign(new Error('ETIMEDOUT secret-auth-dont-log'),{code:'ETIMEDOUT'});
    await assert.rejects(sendMail(message));
    const rows=all('SELECT status,error_message FROM mail_deliveries ORDER BY rowid DESC LIMIT 3');
    assert.deepEqual(rows.map(x=>x.status),['delivery_unknown','failed','accepted']);
    assert.ok(!JSON.stringify(rows).includes('secret-auth-dont-log'));
    closeDb();
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, DB_PATH: path.join(dir,'tounar.sqlite'), MAIL_MODE: 'smtp', SMTP_URL: 'smtp://fake:fake@localhost:465', ENABLE_SCHEDULER: 'false' }, stdio: 'pipe' }));
});
