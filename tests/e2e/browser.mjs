/* 共享浏览器解析：优先本地 Chrome for Testing（npmmirror 镜像），回退 Playwright 自带 chromium。
   背景：Playwright 官方 CDN 在本机实测约 34KB/s；npmmirror 的 chrome-for-testing 实测 ~11MB/s。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const CFT_VERSION = '156.0.8078.4';
const CFT_DIR = path.join(ROOT, '.tmp', 'cft');
export const CFT_EXE = path.join(CFT_DIR, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');

export async function resolveChromiumExecutable() {
  if (process.env.E2E_BROWSER === 'playwright') {
    try {
      const bundled = chromium.executablePath();
      if (bundled && fs.existsSync(bundled)) return { path: bundled, source: 'playwright 自带 chromium（E2E_BROWSER=playwright）' };
    } catch { /* fall through */ }
  }
  if (fs.existsSync(CFT_EXE)) return { path: CFT_EXE, source: `chrome-for-testing ${CFT_VERSION}（npmmirror 镜像）` };
  if (process.platform === 'darwin') {
    try {
      const url = `https://registry.npmmirror.com/-/binary/chrome-for-testing/${CFT_VERSION}/mac-arm64/chrome-mac-arm64.zip`;
      console.log(`· 本地缺少 Chrome for Testing，从 npmmirror 下载 ${CFT_VERSION} …`);
      fs.mkdirSync(CFT_DIR, { recursive: true });
      const zip = path.join(CFT_DIR, 'chrome-mac-arm64.zip');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      execFileSync('unzip', ['-q', '-o', zip, '-d', CFT_DIR], { stdio: 'inherit' });
      fs.rmSync(zip, { force: true });
      if (fs.existsSync(CFT_EXE)) return { path: CFT_EXE, source: `chrome-for-testing ${CFT_VERSION}（npmmirror 镜像）` };
    } catch (err) {
      console.warn(`· Chrome for Testing 获取失败（${err.message}），回退 Playwright 自带浏览器`);
    }
  }
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return { path: bundled, source: 'playwright 自带 chromium' };
  } catch { /* ignore */ }
  return null;
}
