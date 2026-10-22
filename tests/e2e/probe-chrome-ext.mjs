/* 探测 2：Chrome for Testing（本地已下载）能否在 Playwright 下加载 MV3 扩展。 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '../..');
const extDir = path.join(ROOT, '.tmp', 'extension-test');
const cft = path.join(ROOT, '.tmp', 'cft', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');

const variants = [
  { name: 'cft-plain', executablePath: cft, headless: true, args: [] },
  { name: 'cft-flag', executablePath: cft, headless: true, args: ['--disable-features=DisableLoadExtensionCommandLineSwitch'] },
  { name: 'chrome-plain', channel: 'chrome', headless: true, args: [] },
  { name: 'chrome-flag', channel: 'chrome', headless: true, args: ['--disable-features=DisableLoadExtensionCommandLineSwitch'] }
];

for (const v of variants) {
  const userDataDir = path.join(ROOT, '.tmp', `probe-${v.name}`);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  let ctx = null;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      ...(v.executablePath ? { executablePath: v.executablePath } : { channel: v.channel }),
      headless: v.headless,
      viewport: { width: 1024, height: 768 },
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...v.args
      ]
    });
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
    console.log(`${v.name}: service worker = ${sw ? sw.url() : 'NONE'}`);
  } catch (err) {
    console.log(`${v.name}: ERROR ${err.message.split('\n')[0]}`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}
