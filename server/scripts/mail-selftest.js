#!/usr/bin/env node
// 优先使用已固定的持久自测库，防止服务重启后丢失现有插件身份。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { parseEnv } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { resolveSelftestProfile } from './selftest-profile.js';

const root = path.resolve(import.meta.dirname, '../..');
let profile;
try { profile = resolveSelftestProfile(root); }
catch (err) { console.error('无法启动邮件自测：'+err.message); process.exit(1); }
const { dir } = profile;
const envFile = path.join(dir, 'acceptance.env');
const stateFile = path.join(dir, 'selftest-state.json');
const action = process.argv[2] || 'start';
const sourceFile = path.join(root, '.env');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readState = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
function command(pid) { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function isManaged(state) {
  if (!state?.pid || !alive(state.pid)) return false;
  const cmd = command(state.pid);
  // 某些沙箱禁止 ps；此时只信 0600 state 文件 + PID 存活，停止命令还会再校验健康检查。
  if (cmd) return cmd.includes(envFile) && cmd.includes('server/src/index.js');
  return true;
}
function health(port, pathname = '/api/v1/health') {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname, agent: false, timeout: 1500 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function listener(port) { try { return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); } catch { return ''; } }
function printReady(env) {
  console.log(`已就绪：http://127.0.0.1:${env.PORT}/?panel=mail-admin\n发信模式：SMTP 真实发信（只有你点击获取验证码或发送测试邮件时触发）\n管理员：${env.ADMIN_EMAILS}\n管理员本机验证码：在登录页输入上述管理员邮箱，获取验证码会直接显示，不发邮件\n测试收件人：${env.TEST_MAIL_RECIPIENTS}\n副本与模板版本：${dir}\n停止：npm run mail:selftest:stop\n自测指南：http://127.0.0.1:${env.PORT}/mail-selftest.html`);
}
try {
  if (action === 'stop') {
    const state = readState();
    if (!isManaged(state) || !(await health(state.port))) { console.log('邮件自测服务已停止；副本保留。'); process.exit(0); }
    process.kill(state.pid, 'SIGTERM');
    for (let i=0; i<40 && isManaged(state); i++) await sleep(100);
    if (isManaged(state)) throw new Error('服务尚未退出，未强制终止，请检查本机进程。');
    console.log('邮件自测服务已停止；测试数据和模板版本保留。'); process.exit(0);
  }
  if (!['start','status'].includes(action)) throw new Error('用法：mail-selftest.js start | stop | status');
  const previous = readState();
  if (previous && isManaged(previous) && await health(previous.port) && await health(previous.port, '/')) { printReady(parseEnv(fs.readFileSync(envFile, 'utf8'))); process.exit(0); }
  if (action === 'status') { console.log('邮件自测服务未运行。执行 npm run mail:selftest 启动。'); process.exit(0); }
  if (!fs.existsSync(sourceFile)) throw new Error('缺少项目 .env，请先配置 SMTP_URL、MAIL_FROM、ALLOWED_EMAILS。');
  const source = parseEnv(fs.readFileSync(sourceFile, 'utf8'));
  if (!source.SMTP_URL || !source.MAIL_FROM) throw new Error('请在项目 .env 配置 SMTP_URL 和 MAIL_FROM；不要把凭据发到聊天中。');
  const allowed = (source.ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const saved = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const admins = source.ADMIN_EMAILS || saved.ADMIN_EMAILS || allowed[0];
  const recipients = source.TEST_MAIL_RECIPIENTS || saved.TEST_MAIL_RECIPIENTS || allowed.join(',');
  const email = x => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(x);
  if (!admins || !recipients || [...admins.split(','), ...recipients.split(',')].some(x => !email(x.trim()))) throw new Error('请配置有效的管理员与测试邮箱；默认管理员为 ALLOWED_EMAILS 第一项，测试收件人为其全部邮箱。');
  if (admins.split(',').some(x => !allowed.includes(x.trim().toLowerCase()))) throw new Error('ADMIN_EMAILS 中的邮箱也必须包含在 ALLOWED_EMAILS 登录白名单中。');
  const port = Number(source.MAIL_SELFTEST_PORT || 4311);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MAIL_SELFTEST_PORT 必须是 1024～65535 的端口号。');
  if (listener(port)) throw new Error(`端口 ${port} 已被其他服务占用；请停止原测试服务或修改 MAIL_SELFTEST_PORT。不会停止未知进程。`);
  if (!fs.existsSync(envFile)) {
    if (profile.pinned) throw new Error('固定自测环境缺失，不能重新复制数据库。');
    execFileSync(process.execPath, [path.join(root, 'server/scripts/local-acceptance.js'), '--mail-mode', 'smtp', '--data-dir', dir, '--port', String(port), '--no-start'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const modelKeys = [
    'AI_API_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_PROVIDER', 'AI_LLM_TIMEOUT_MS',
    'JEV_API_URL', 'JEV_API_KEY', 'JEV_MODEL', 'JEV_TIMEOUT_MS',
    'DIFY_API_URL', 'DIFY_API_KEY', 'DIFY_USER_ID', 'DIFY_TIMEOUT_MS',
    'AUTO_INTAKE_MIN_PROGRESS', 'AUTO_INTAKE_MIN_EVIDENCE', 'AUTO_INTAKE_MIN_STATUS',
    'AUTO_INTAKE_MIN_CANDIDATE', 'AUTO_INTAKE_MIN_TERMINAL', 'AUTO_INTAKE_RETRY_MINUTES'
  ];
  const modelEnv = Object.fromEntries(modelKeys.filter((k) => source[k]).map((k) => [k, source[k]]));
  const autoIntake = source.AUTO_INTAKE_ENABLED
    || (source.AI_API_URL && source.AI_API_KEY && source.JEV_API_KEY ? 'true' : 'false');
  const env = { ...parseEnv(fs.readFileSync(envFile, 'utf8')), ...modelEnv, HOST: '127.0.0.1', PORT: String(port), APP_BASE_URL: `http://127.0.0.1:${port}`, APP_ENV: 'development', ENABLE_SCHEDULER: 'false', CLOUD_LLM_ENABLED: 'false', AUTO_INTAKE_ENABLED: autoIntake, MAIL_MODE: 'smtp', SMTP_URL: source.SMTP_URL, MAIL_FROM: source.MAIL_FROM, ALLOWED_EMAILS: allowed.join(','), ADMIN_EMAILS: admins, TEST_MAIL_RECIPIENTS: recipients, ENABLE_MAIL_BUSINESS_TEST: 'true', ENABLE_SELFTEST_LOGIN: 'true' };
  fs.writeFileSync(envFile, Object.entries(env).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join('\n')+'\n', { mode: 0o600 });
  const log = fs.openSync(path.join(dir, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['--env-file', envFile, path.join(root, 'server/src/index.js')], { cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', log, log] });
  child.unref(); fs.closeSync(log);
  const state = { pid: child.pid, port, started_at: new Date().toISOString(), data_dir: dir };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  for (let i=0; i<60; i++) { if (await health(port) && await health(port, '/')) { printReady(env); process.exit(0); } await sleep(200); }
  if (isManaged(state)) process.kill(state.pid, 'SIGTERM');
  throw new Error(`服务未就绪，请查看 ${path.join(dir, 'server.log')}。`);
} catch (err) { console.error('无法启动邮件自测：'+(err.stderr ? '准备测试副本失败，请检查本地数据与环境配置。' : err.message)); process.exitCode = 1; }
