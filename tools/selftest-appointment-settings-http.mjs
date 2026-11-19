import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-appointment-settings-'));
const originalData = process.env.CW_DATA_DIR;
const originalPack = process.env.CW_CONFIG_PACK;
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { defaultSettings, loadAutomationSettings, validateSettings, importAutomationSettings, exportAutomationSettings } = await import('../src/automation-settings.mjs');
const { APPOINTMENT_PRIORITIES, DEFAULT_APPOINTMENT_PRIORITIES } = await import('../src/appointment-priorities.mjs');
saveStore({ activeId: 'appoint-a', accounts: ['appoint-a', 'appoint-b', 'appoint-old'].map(id => ({
  id, label: id, url: 'ws://invalid.invalid', login: {}, automation: { enabled: false },
})) });
const legacy = validateSettings(defaultSettings());
delete legacy.appointments;
legacy.heroes.skill = false;
fs.writeFileSync(path.join(directory, 'automation-settings.json'), JSON.stringify({ version: 1, accounts: {
  'appoint-old': { settings: legacy, revision: 4, savedAt: 'legacy' },
} }));
const app = createConsole({ port: 0, protocol: {} });
const root = await app.listen();
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function api(route, body, account = 'appoint-a') {
  const response = await fetch(root + '/api/' + route + '?account=' + account, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, data: await response.json() };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const change = (view, settings) => ({ settings, revision: view.revision, baseRevision: view.baseRevision });

try {
  await test('离线读取默认七项，旧账号与导入补全且保留原设置', async () => {
    const defaults = ok(await api('appointments/settings'));
    assert.deepEqual(defaults.settings, { enabled: false, priorities: DEFAULT_APPOINTMENT_PRIORITIES });
    assert.deepEqual(defaults.options, APPOINTMENT_PRIORITIES.map(({ id, label }) => ({ value: id, label })));
    assert.equal(defaults.revision, 0);
    assert.equal(typeof defaults.baseRevision, 'string');
    const previous = ok(await api('appointments/settings', undefined, 'appoint-old'));
    assert.deepEqual(previous.settings, defaults.settings);
    assert.equal(previous.revision, 4);
    const imported = importAutomationSettings({ format: 'crazywaterworld-automation', version: 1, settings: legacy });
    assert.deepEqual(imported.appointments, defaults.settings);
    delete imported.appointments;
    assert.deepEqual(imported, legacy);
    assert.equal(app.sessions.get('appoint-a').client, null);
    assert.equal(app.sessions.get('appoint-old').client, null);
  });

  await test('切换开关与排序按账号持久化，关闭后保留顺序', async () => {
    const before = ok(await api('settings'));
    const other = ok(await api('settings', undefined, 'appoint-b'));
    const priorities = [...DEFAULT_APPOINTMENT_PRIORITIES].reverse();
    const expected = structuredClone(before.settings);
    let current = ok(await api('appointments/settings'));
    for (const enabled of [true, false]) {
      const settings = { enabled, priorities };
      const saved = ok(await api('appointments/settings', change(current, settings)));
      expected.appointments = settings;
      assert.equal(saved.revision, current.revision + 1);
      assert.deepEqual(saved.settings, settings);
      assert.deepEqual(ok(await api('settings')).settings, expected);
      assert.deepEqual(loadAutomationSettings('appoint-a').settings, expected);
      current = saved;
    }
    assert.deepEqual(ok(await api('settings', undefined, 'appoint-b')), other);
    assert.equal(app.sessions.get('appoint-a').loop.running, false);
    assert.equal(app.sessions.get('appoint-a').client, null);
    const document = ok(await api('settings/export'));
    assert.deepEqual(importAutomationSettings(document).appointments, expected.appointments);
  });

  await test('有效旧列表补齐建造速度，校验拒绝重复、未知及非法类型', async () => {
    const settings = defaultSettings();
    settings.appointments = { enabled: true, priorities: ['锻造时间', '生产时间'] };
    const normalized = validateSettings(settings).appointments;
    assert.deepEqual(normalized.priorities, ['锻造时间', '生产时间', ...DEFAULT_APPOINTMENT_PRIORITIES.filter(id => !['锻造时间', '生产时间'].includes(id))]);
    const six = defaultSettings();
    six.appointments.priorities = DEFAULT_APPOINTMENT_PRIORITIES.filter(id => id !== '建造速度');
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(six)).appointments.priorities, [...six.appointments.priorities, '建造速度']);
    const before = ok(await api('appointments/settings'));
    const payload = change(before, before.settings);
    for (const invalid of [null, [], { ...payload, revision: String(before.revision) }, { ...payload, unknown: true },
      ...[null, [], {}, { ...before.settings, extra: true }, { ...before.settings, enabled: 1 },
        { ...before.settings, enabled: 'false' },
        ...[null, '生产时间', [1], ['不存在'], ['生产时间', '生产时间']].map(priorities => ({ ...before.settings, priorities })),
      ].map(settings => ({ ...payload, settings }))]) {
      const result = await api('appointments/settings', invalid);
      assert.equal(result.status, 400, JSON.stringify(invalid));
    }
    assert.deepEqual(ok(await api('appointments/settings')), before);
  });

  await test('首存检查旧开关快照，并发版本冲突保留较新配置', async () => {
    const before = ok(await api('appointments/settings', undefined, 'appoint-b'));
    ok(await api('loop/task', { key: 'weekOrderSubmit', enabled: true, confirm: true }, 'appoint-b'));
    const conflict = await api('appointments/settings', change(before, { ...before.settings, enabled: true }), 'appoint-b');
    assert.equal(conflict.status, 400);
    assert(conflict.data.fields.revision);
    const fresh = ok(await api('appointments/settings', undefined, 'appoint-b'));
    ok(await api('appointments/settings', change(fresh, { ...fresh.settings, enabled: true }), 'appoint-b'));
    const stale = ok(await api('appointments/settings', undefined, 'appoint-b'));
    const all = ok(await api('settings', undefined, 'appoint-b'));
    all.settings.resources.keepAccelerators = 13;
    ok(await api('settings', { settings: all.settings, revision: all.revision, baseRevision: all.baseRevision }, 'appoint-b'));
    const changed = await api('appointments/settings', change(stale, { ...stale.settings, enabled: false }), 'appoint-b');
    assert.equal(changed.status, 400);
    assert(changed.data.fields.revision);
    const after = ok(await api('settings', undefined, 'appoint-b'));
    assert.equal(after.settings.resources.keepAccelerators, 13);
    assert.equal(after.settings.appointments.enabled, true);
  });

  await test('暂停与生产同步时可保存，并通知运行中挂机使用新设置', async () => {
    const session = app.sessions.get('appoint-a');
    const client = new EventEmitter();
    let changes = 0;
    Object.assign(client, { connected: false, stop() {}, request() { throw Error('设置不应发送游戏请求'); } });
    client.on('automationSettingsChanged', () => changes++);
    session.client = client;
    session.paused = true;
    session.syncingProduction = true;
    try {
      const current = ok(await api('appointments/settings'));
      const settings = { ...current.settings, enabled: true };
      const saved = ok(await api('appointments/settings', change(current, settings)));
      assert.deepEqual(saved.settings, settings);
      assert.deepEqual(session.preferences.appointments, settings);
      assert.equal(changes, 1);
      assert.equal(session.paused, true);
      assert.equal(session.client, client);
      assert.equal(session.loop.running, false);
    } finally {
      session.syncingProduction = false;
      session.paused = false;
    }
  });
  console.log('英雄委任设置HTTP专项 ' + passed + '/' + passed + ' 通过');
} finally {
  await app.close();
  if (originalData === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = originalData;
  if (originalPack === undefined) delete process.env.CW_CONFIG_PACK; else process.env.CW_CONFIG_PACK = originalPack;
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
