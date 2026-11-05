import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';

// 恢复后的服务必须使用已确认的数据；缺失时停止，不能回退到旧基线。
export function resolveSelftestProfile(root) {
  const file = path.join(root, 'data/mail-selftest-profile.json');
  if (!fs.existsSync(file)) {
    if (fs.existsSync(path.join(root, 'data/mail-selftest'))) throw new Error('持久自测数据存在，但启动配置缺失。请恢复 mail-selftest-profile.json；不会创建替代数据库。');
    return { dir: path.join(root, '.tmp/mail-selftest'), pinned: false };
  }
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (profile.version !== 1 || !profile.id || !path.isAbsolute(profile.data_dir || '')) throw new Error('自测启动配置无效，请从备份恢复。');
  const dir = profile.data_dir;
  for (const name of ['tounar.sqlite', 'master.key', 'acceptance.env']) {
    if (!fs.existsSync(path.join(dir, name))) throw new Error(`固定自测数据缺少 ${name}；不会回退或重新复制，请从备份恢复。`);
  }
  const env = parseEnv(fs.readFileSync(path.join(dir, 'acceptance.env'), 'utf8'));
  if (env.DATA_DIR !== dir || env.DB_PATH !== path.join(dir, 'tounar.sqlite')) throw new Error('自测环境与固定数据库不一致，已停止启动。');
  const db = new DatabaseSync(path.join(dir, 'tounar.sqlite'), { readOnly: true });
  try {
    if (db.prepare("SELECT value FROM meta WHERE key='selftest_profile_id'").get()?.value !== profile.id) throw new Error('固定数据库身份不匹配，已停止启动。');
    if (profile.expected_device_id) {
      const device = db.prepare(`SELECT d.id, d.server_revoked_at, d.expires_at, u.deletion_blocked
        FROM plugin_devices d JOIN users u ON u.id = d.owner_id WHERE d.id = ?`).get(profile.expected_device_id);
      if (!device) throw new Error('固定自测库缺少预期插件设备，已停止启动；不会用其他库顶替。');
      if (device.server_revoked_at) throw new Error('固定自测库中的预期插件设备已被撤销，已停止启动。');
      if (Date.parse(device.expires_at) <= Date.now()) throw new Error('固定自测库中的预期插件设备已过期，请重新配对并更新 profile。');
      if (device.deletion_blocked) throw new Error('预期插件设备所属账号正在删除数据，已停止启动。');
    }
  } finally { db.close(); }
  return { dir, pinned: true };
}
