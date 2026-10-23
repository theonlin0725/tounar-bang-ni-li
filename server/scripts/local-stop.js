#!/usr/bin/env node
/*
 * 停止 npm run local:acceptance 起的本地验收服务。
 *
 * 只杀“确实由本仓库验收目录启动的 node server/src/index.js”：
 *   1. 在 ~/tounar-acceptance 下各副本的 state.json 里找匹配的实例（可按 --port / --data-dir 过滤）；
 *   2. 用 ps 核对 pid 的命令行含 server/src/index.js，避免 pid 复用误杀；
 *   3. SIGTERM → 等待退出 → 再确认端口已释放。
 * 不会动其它端口上的未知进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ACCEPTANCE_BASE = path.join(os.homedir(), 'tounar-acceptance');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`无法识别的参数：${key}`);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`${key} 需要一个值`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function commandOf(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function listeningOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .trim().split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(ACCEPTANCE_BASE)) {
  console.log('没有找到 ~/tounar-acceptance，说明本机还没用 local:acceptance 起过服务。');
  process.exit(0);
}

const candidates = [];
for (const entry of fs.readdirSync(ACCEPTANCE_BASE)) {
  const dir = path.join(ACCEPTANCE_BASE, entry);
  const stateFile = path.join(dir, 'state.json');
  if (!fs.existsSync(stateFile)) continue;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state.started || !state.pid) continue;
    if (args.port && Number(state.port) !== Number(args.port)) continue;
    if (args['data-dir'] && path.resolve(state.data_dir) !== path.resolve(args['data-dir'])) continue;
    candidates.push({ dir, state });
  } catch { /* 忽略损坏的 state */ }
}

if (!candidates.length) {
  console.log('没有匹配的验收实例（可能已停止，或 --port / --data-dir 过滤掉了）。');
  process.exit(0);
}

let stopped = 0;
for (const { dir, state } of candidates) {
  const { pid, port } = state;
  if (!alive(pid)) {
    console.log(`· ${dir}\n  pid ${pid} 已不在运行，端口 ${port}：${listeningOn(port).length ? '仍被其它进程占用' : '已释放'}`);
    continue;
  }
  const command = commandOf(pid);
  if (!command.includes('server/src/index.js')) {
    console.log(`· 跳过 pid ${pid}：命令行不像本项目（${command.slice(0, 80)}）`);
    continue;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (alive(pid)) {
    console.log(`· pid ${pid} 8 秒内没退出，未强杀；请手动检查：ps -p ${pid} -o command=`);
    continue;
  }
  stopped += 1;
  console.log(`· 已停止 pid ${pid}（端口 ${port}）\n  数据副本保留在 ${dir}`);
}

console.log(stopped ? `\n✅ 已停止 ${stopped} 个验收服务。重新启动：npm run local:acceptance` : '\n没有需要停止的进程。');
