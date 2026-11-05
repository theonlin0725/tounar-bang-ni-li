#!/usr/bin/env node
/* 构建可手动加载的线上插件 ZIP：只打包 extension 运行文件，注入正式后台地址。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8'));
const version = manifest.version;
const serverRaw = process.env.BETA_SERVER_URL || 'https://bangnili.app.workbuddy.host';
const shareCode = process.env.SHARE_CODE || '';
const serverUrl = `${serverRaw.replace(/\/$/, '')}${shareCode ? `/?sharecode=${encodeURIComponent(shareCode)}` : ''}`;
const stage = path.join(ROOT, '.tmp', 'beta-plugin');
const outDir = path.join(ROOT, 'web', 'downloads');
const pkgRoot = path.join(stage, 'bangnili-extension');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(pkgRoot, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const include = ['manifest.json', 'background', 'content', 'icons', 'lib', 'popup'];
for (const item of include) {
  const src = path.join(ROOT, 'extension', item);
  if (!fs.existsSync(src)) throw new Error(`missing extension runtime file: ${item}`);
  fs.cpSync(src, path.join(pkgRoot, item), { recursive: true });
}
const commonPath = path.join(pkgRoot, 'lib/common.js');
let common = fs.readFileSync(commonPath, 'utf8');
const local = "serverUrl: 'http://127.0.0.1:4310'";
if (!common.includes(local)) throw new Error('extension default serverUrl marker missing');
common = common.replace(local, `serverUrl: ${JSON.stringify(serverUrl)}`);
fs.writeFileSync(commonPath, common);
const zipPath = path.join(outDir, `bangnili-extension-${version}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync('zip', ['-q', '-r', zipPath, 'bangnili-extension'], { cwd: stage, stdio: 'inherit' });
const sha = execFileSync('shasum', ['-a', '256', zipPath], { encoding: 'utf8' }).trim();
const files = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
const forbidden = files.filter((f) => /(^|\/)(\.env|data\/|node_modules\/|.*\.(sqlite|sqlite-wal|key|token|log))$/i.test(f));
if (forbidden.length) throw new Error(`forbidden files in zip: ${forbidden.join(',')}`);
console.log(JSON.stringify({ zip: path.relative(ROOT, zipPath), sha256: sha.split(/\s+/)[0], files: files.length, version, serverUrl: serverRaw + (shareCode ? '/?sharecode=…' : ''), top_level: 'bangnili-extension' }, null, 2));
