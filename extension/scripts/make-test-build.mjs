/*
 * 生成「测试版扩展」：把 extension/ 复制到 .tmp/extension-test，
 * 并注入仅用于本地 E2E 的权限与静态 content_scripts。
 *
 * 为什么需要它：
 * - 生产 manifest 刻意不写死任何站点/主机权限（optional_host_permissions + 用户显式授权 + scripting 注册）；
 * - 本地 E2E 需要让扩展在 http://127.0.0.1:<fixturePort> 上自动注入采集脚本，
 *   且 chrome.permissions.request 无法在自动化环境中由脚本代替用户点击授权，
 *   因此测试构建例外地声明 host_permissions 与静态 content_scripts；
 * - 该脚本会先断言「生产 manifest 不含测试主机」，避免测试权限被误提交进正式构建。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(ROOT, '..', '.tmp', 'extension-test');
const TEST_ORIGINS = ['http://127.0.0.1/*', 'http://localhost/*'];

export function buildTestExtension({ outDir = OUT } = {}) {
  const manifestPath = path.join(ROOT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const manifestText = JSON.stringify(manifest);
  for (const origin of TEST_ORIGINS) {
    const bare = origin.replace('/*', '');
    if (manifestText.includes(bare)) {
      throw new Error(`生产 manifest 不得包含测试主机 ${bare}，请检查 manifest.json`);
    }
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(ROOT, outDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}scripts`) && !src.includes('node_modules')
  });

  const testManifest = {
    ...manifest,
    host_permissions: TEST_ORIGINS,
    content_scripts: [
      {
        matches: TEST_ORIGINS,
        js: ['lib/learned.js', 'content/adapters.js', 'content/tracker.js'],
        run_at: 'document_idle'
      }
    ],
    // 测试构建同样在扩展页里允许直连本地后台
    description: `${manifest.description}（本地 E2E 测试构建）`
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(testManifest, null, 2));
  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dir = buildTestExtension();
  console.log(`测试扩展已生成：${dir}`);
}
