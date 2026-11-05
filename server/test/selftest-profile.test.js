import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveSelftestProfile } from '../scripts/selftest-profile.js';

test('固定自测库不会在配置丢失、环境错配或数据库被替换后静默回退', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-profile-'));
  try {
    assert.equal(resolveSelftestProfile(root).pinned, false);
    const dir = path.join(root, 'data/mail-selftest');
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(() => resolveSelftestProfile(root), /配置缺失/);
    fs.writeFileSync(path.join(root, 'data/mail-selftest-profile.json'), JSON.stringify({ version: 1, id: 'restored', data_dir: dir }));
    assert.throws(() => resolveSelftestProfile(root), /缺少 tounar.sqlite/);
    const db = new DatabaseSync(path.join(dir, 'tounar.sqlite'));
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES ('selftest_profile_id','restored');");
    db.close();
    fs.writeFileSync(path.join(dir, 'master.key'), 'test');
    fs.writeFileSync(path.join(dir, 'acceptance.env'), 'DATA_DIR=/wrong\nDB_PATH=/wrong/tounar.sqlite\n');
    assert.throws(() => resolveSelftestProfile(root), /不一致/);
    fs.writeFileSync(path.join(dir, 'acceptance.env'), `DATA_DIR=${JSON.stringify(dir)}\nDB_PATH=${JSON.stringify(path.join(dir, 'tounar.sqlite'))}\n`);
    assert.deepEqual(resolveSelftestProfile(root), { dir, pinned: true });
    const replaced = new DatabaseSync(path.join(dir, 'tounar.sqlite'));
    replaced.exec("UPDATE meta SET value='other'"); replaced.close();
    assert.throws(() => resolveSelftestProfile(root), /身份不匹配/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('固定自测库在预期插件设备缺失、撤销或过期时拒绝启动', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-profile-device-'));
  try {
    const dir = path.join(root, 'data/mail-selftest');
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'tounar.sqlite'));
    db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
      INSERT INTO meta VALUES ('selftest_profile_id','device-profile');
      CREATE TABLE users(id TEXT PRIMARY KEY, deletion_blocked INTEGER NOT NULL DEFAULT 0);
      INSERT INTO users VALUES ('usr_1',0);
      CREATE TABLE plugin_devices(id TEXT PRIMARY KEY, owner_id TEXT, server_revoked_at TEXT, expires_at TEXT);
      INSERT INTO plugin_devices VALUES ('dev_expected','usr_1',NULL,'2099-01-01T00:00:00.000Z');
    `);
    db.close();
    fs.writeFileSync(path.join(dir, 'master.key'), 'test');
    fs.writeFileSync(path.join(dir, 'acceptance.env'), `DATA_DIR=${JSON.stringify(dir)}\nDB_PATH=${JSON.stringify(path.join(dir, 'tounar.sqlite'))}\n`);
    fs.writeFileSync(path.join(root, 'data/mail-selftest-profile.json'), JSON.stringify({ version: 1, id: 'device-profile', data_dir: dir, expected_device_id: 'dev_expected' }));

    assert.deepEqual(resolveSelftestProfile(root), { dir, pinned: true });
    let changed = new DatabaseSync(path.join(dir, 'tounar.sqlite'));
    changed.exec("UPDATE plugin_devices SET server_revoked_at='2026-10-30T00:00:00.000Z'"); changed.close();
    assert.throws(() => resolveSelftestProfile(root), /已被撤销/);
    changed = new DatabaseSync(path.join(dir, 'tounar.sqlite'));
    changed.exec("UPDATE plugin_devices SET server_revoked_at=NULL, expires_at='2020-01-01T00:00:00.000Z'"); changed.close();
    assert.throws(() => resolveSelftestProfile(root), /已过期/);
    changed = new DatabaseSync(path.join(dir, 'tounar.sqlite'));
    changed.exec("DELETE FROM plugin_devices"); changed.close();
    assert.throws(() => resolveSelftestProfile(root), /缺少预期插件设备/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
