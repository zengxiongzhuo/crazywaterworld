import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hero-raid-settings-'));
const originalData = process.env.CW_DATA_DIR;
const originalPack = process.env.CW_CONFIG_PACK;
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { defaultSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
saveStore({ activeId: 'raid-a', accounts: ['raid-a', 'raid-b', 'raid-old'].map(id => ({
  id, label: id, url: 'ws://invalid.invalid', login: {}, automation: { enabled: false },
})) });
const legacy = defaultSettings();
legacy.heroRaid = { enabled: true, orders: true, rewards: false };
fs.writeFileSync(path.join(directory, 'automation-settings.json'), JSON.stringify({ version: 1, accounts: {
  'raid-old': { settings: legacy, revision: 4, savedAt: 'legacy' },
} }));
const app = createConsole({ port: 0, protocol: {} });
const root = await app.listen();
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function api(route, body, account = 'raid-a') {
  const response = await fetch(root + '/api/' + route + '?account=' + account, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, data: await response.json() };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const change = (view, key, value) => ({ key: 'heroRaid.' + key, value, revision: view.revision, baseRevision: view.baseRevision, confirm: true });

try {
  await test('未连接时可读取完整默认项，旧账号设置自动兼容', async () => {
    const defaults = ok(await api('hero-raid/settings'));
    assert.deepEqual(defaults.settings, { enabled: false, challenge: false, retryTimes: 10, orders: false, lottery: false, rewards: false });
    assert.equal(defaults.revision, 0);
    assert.equal(typeof defaults.baseRevision, 'string');
    const previous = ok(await api('hero-raid/settings', undefined, 'raid-old'));
    assert.deepEqual(previous.settings, { ...defaults.settings, enabled: true, orders: true, rewards: false });
    assert.equal(previous.revision, 4);
    assert.equal(app.sessions.get('raid-a').client, null);
    assert.equal(app.sessions.get('raid-old').client, null);
  });

  await test('六个字段逐项保存到同一配置，关闭总开关保留子项且账号隔离', async () => {
    const before = ok(await api('settings'));
    const other = ok(await api('settings', undefined, 'raid-b'));
    const expected = structuredClone(before.settings);
    let current = ok(await api('hero-raid/settings'));
    for (const [field, value] of [['enabled', true], ['challenge', true], ['retryTimes', 0], ['retryTimes', 100],
      ['orders', true], ['lottery', true], ['rewards', false], ['enabled', false]]) {
      const saved = ok(await api('hero-raid/settings', change(current, field, value)));
      expected.heroRaid[field] = value;
      assert.equal(saved.revision, current.revision + 1);
      assert.deepEqual(saved.settings, expected.heroRaid);
      assert.deepEqual(ok(await api('settings')).settings, expected);
      assert.deepEqual(loadAutomationSettings('raid-a').settings, expected);
      current = saved;
    }
    assert.deepEqual(ok(await api('settings', undefined, 'raid-b')), other);
    assert.equal(app.sessions.get('raid-a').loop.running, false);
    assert.equal(app.sessions.get('raid-a').client, null);
  });

  await test('严格拒绝非法字段、类型、重试次数、确认与过期版本', async () => {
    const before = ok(await api('hero-raid/settings'));
    const payload = change(before, 'challenge', false);
    for (const invalid of [null, [], { ...payload, key: '__proto__' }, { ...payload, key: 'heroRaid.unknown' },
      { ...payload, key: 'challenge' }, { ...payload, value: 1 }, { ...payload, value: 'false' },
      { ...payload, confirm: false }, { ...payload, enabled: false }, { ...payload, revision: String(before.revision) },
      ...[-1, 101, 0.5, null, '10'].map(value => change(before, 'retryTimes', value))]) {
      const result = await api('hero-raid/settings', invalid);
      assert.equal(result.status, 400, JSON.stringify(invalid));
    }
    assert.deepEqual(ok(await api('hero-raid/settings')), before);
    const after = ok(await api('hero-raid/settings', payload));
    const conflict = await api('hero-raid/settings', change(before, 'lottery', false));
    assert.equal(conflict.status, 400);
    assert(conflict.data.fields.revision);
    assert.deepEqual(ok(await api('hero-raid/settings')), after);
  });

  await test('首存检查旧挂机快照，其他配置页面更新也触发版本冲突', async () => {
    const before = ok(await api('hero-raid/settings', undefined, 'raid-b'));
    ok(await api('loop/task', { key: 'weekOrderSubmit', enabled: true, confirm: true }, 'raid-b'));
    const conflict = await api('hero-raid/settings', change(before, 'enabled', true), 'raid-b');
    assert.equal(conflict.status, 400);
    assert(conflict.data.fields.revision);
    const fresh = ok(await api('hero-raid/settings', undefined, 'raid-b'));
    ok(await api('hero-raid/settings', change(fresh, 'enabled', true), 'raid-b'));
    const stale = ok(await api('hero-raid/settings', undefined, 'raid-b'));
    const all = ok(await api('settings', undefined, 'raid-b'));
    all.settings.resources.keepAccelerators = 13;
    ok(await api('settings', { settings: all.settings, revision: all.revision, baseRevision: all.baseRevision }, 'raid-b'));
    const changed = await api('hero-raid/settings', change(stale, 'orders', true), 'raid-b');
    assert.equal(changed.status, 400);
    assert(changed.data.fields.revision);
    assert.equal(ok(await api('settings', undefined, 'raid-b')).settings.resources.keepAccelerators, 13);
  });

  await test('暂停和生产同步期间可编辑，更新运行中设置并保持连接状态', async () => {
    const session = app.sessions.get('raid-a');
    const client = new EventEmitter();
    let changes = 0;
    Object.assign(client, { connected: false, stop() {}, request() { throw Error('配置操作不应发送游戏请求'); } });
    client.on('automationSettingsChanged', () => changes++);
    session.client = client;
    session.paused = true;
    session.syncingProduction = true;
    try {
      const current = ok(await api('hero-raid/settings'));
      const saved = ok(await api('hero-raid/settings', change(current, 'retryTimes', 10)));
      assert.equal(saved.settings.retryTimes, 10);
      assert.equal(session.preferences.heroRaid.retryTimes, 10);
      assert.equal(changes, 1);
      assert.equal(session.paused, true);
      assert.equal(session.client, client);
      assert.equal(session.loop.running, false);
    } finally {
      session.syncingProduction = false;
      session.paused = false;
    }
  });

  await test('设置导出导入保留活动全部字段与旧配置显式选择', async () => {
    for (const account of ['raid-a', 'raid-old']) {
      const view = ok(await api('hero-raid/settings', undefined, account));
      const document = ok(await api('settings/export', undefined, account));
      const validated = ok(await api('settings/validate', { document }, account));
      assert.deepEqual(document.settings.heroRaid, view.settings);
      assert.deepEqual(validated.settings.heroRaid, view.settings);
    }
  });
  console.log('超凡英雄设置HTTP专项 ' + passed + '/' + passed + ' 通过');
} finally {
  await app.close();
  if (originalData === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = originalData;
  if (originalPack === undefined) delete process.env.CW_CONFIG_PACK; else process.env.CW_CONFIG_PACK = originalPack;
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
