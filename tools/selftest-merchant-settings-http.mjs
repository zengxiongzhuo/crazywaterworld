import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merchant-settings-'));
const originalData = process.env.CW_DATA_DIR;
const originalPack = process.env.CW_CONFIG_PACK;
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { defaultSettings, loadAutomationSettings, settingsUiRules } = await import('../src/automation-settings.mjs');
const { watchMerchant } = await import('../src/merchant-monitor.mjs');
const { rewardSchedule } = await import('../src/reward-schedule.mjs');
const taskKeys = ['merchantTrade', 'merchantRewards', 'tradeTasks'];
saveStore({ activeId: 'trade-a', accounts: ['trade-a', 'trade-b', 'trade-old'].map(id => ({
  id, label: id, url: 'ws://invalid.invalid', login: {}, automation: { enabled: false },
})) });
const legacy = defaultSettings();
legacy.merchant = { autoShareIntel: false, autoSpeedUp: true, keepPointers: 12 };
legacy.schedule.merchantTrade = true;
legacy.schedule.merchantRewards = false;
legacy.schedule.tradeTasks = false;
fs.writeFileSync(path.join(directory, 'automation-settings.json'), JSON.stringify({ version: 1, accounts: {
  'trade-old': { settings: legacy, revision: 4, savedAt: 'legacy' },
} }));
const app = createConsole({ port: 0, protocol: {} });
const root = await app.listen();
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function api(route, body, account = 'trade-a') {
  const response = await fetch(root + '/api/' + route + '?account=' + account, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, data: await response.json() };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const change = (view, key, value) => ({ key, value, revision: view.revision, baseRevision: view.baseRevision, confirm: true });
const subset = settings => ({ merchant: settings.merchant,
  schedule: Object.fromEntries(taskKeys.map(key => [key, settings.schedule[key]])) });

try {
  await test('离线读取全部海商王配置及数字约束，旧账号选择继续使用', async () => {
    const defaults = ok(await api('merchant/settings'));
    assert.deepEqual(defaults.settings, subset(defaultSettings()));
    assert.deepEqual(defaults.rules.numbers, Object.fromEntries(Object.entries(settingsUiRules().numbers)
      .filter(([key]) => key.startsWith('merchant.'))));
    assert.equal(defaults.revision, 0);
    assert.equal(typeof defaults.baseRevision, 'string');
    const previous = ok(await api('merchant/settings', undefined, 'trade-old'));
    assert.deepEqual(previous.settings.merchant, { ...defaults.settings.merchant, ...legacy.merchant });
    assert.deepEqual(previous.settings.schedule, { merchantTrade: true, merchantRewards: false, tradeTasks: false });
    assert.equal(previous.revision, 4);
    assert.equal(app.sessions.get('trade-a').client, null);
    assert.equal(app.sessions.get('trade-old').client, null);
    assert.doesNotMatch(JSON.stringify(defaults), /invalid\.invalid|"login"|"token"/);
  });

  await test('各类型配置逐项写入原字段，关闭走商保留策略并隔离账号', async () => {
    const before = ok(await api('settings'));
    const other = ok(await api('settings', undefined, 'trade-b'));
    const expected = structuredClone(before.settings);
    let current = ok(await api('merchant/settings'));
    const changes = Object.entries(before.settings.merchant).map(([key, value]) => {
      let next = typeof value === 'boolean' ? !value : typeof value === 'number' ? value + 1 : value;
      if (key === 'speedUpMode') next = 'arrival';
      if (key === 'firstDepartureMode') next = 'time';
      if (key === 'firstDepartureTime') next = '23:59';
      return ['merchant.' + key, next];
    });
    changes.push(['schedule.merchantTrade', true], ['schedule.merchantRewards', false],
      ['schedule.tradeTasks', false], ['schedule.merchantTrade', false]);
    for (const [key, value] of changes) {
      const saved = ok(await api('merchant/settings', change(current, key, value)));
      const [group, field] = key.split('.');
      expected[group][field] = value;
      assert.equal(saved.revision, current.revision + 1);
      assert.deepEqual(saved.settings, subset(expected));
      assert.deepEqual(ok(await api('settings')).settings, expected);
      assert.deepEqual(loadAutomationSettings('trade-a').settings, expected);
      current = saved;
    }
    assert.deepEqual(ok(await api('settings', undefined, 'trade-b')), other);
    assert.equal(app.sessions.get('trade-a').loop.running, false);
    assert.equal(app.sessions.get('trade-a').client, null);
  });

  await test('拒绝越权字段、无效类型、时间和选项，校验失败不改保存值', async () => {
    const before = ok(await api('merchant/settings'));
    const payload = change(before, 'schedule.merchantTrade', true);
    const invalidPayloads = [null, [], { ...payload, key: '__proto__' }, { ...payload, key: 'merchant.__proto__' },
      { ...payload, key: 'merchant.constructor' }, { ...payload, key: 'merchant.unknown' },
      { ...payload, key: 'merchant.autoSpeedUp.extra' }, { ...payload, key: 'schedule.weekOrderSubmit' },
      { ...payload, key: 'resources.allowDiamonds' }, { ...payload, value: 'true' }, { ...payload, value: 1 },
      { ...payload, confirm: false }, { ...payload, enabled: false }, { ...payload, revision: String(before.revision) },
      change(before, 'merchant.autoSpeedUp', null), change(before, 'merchant.speedUpMode', 'fast'),
      change(before, 'merchant.firstDepartureMode', 'now'),
      ...['', '24:00', '10:60', '1:00', null, 1000].map(value => change(before, 'merchant.firstDepartureTime', value)),
    ];
    const missingValue = { ...payload }; delete missingValue.value; invalidPayloads.push(missingValue);
    for (const invalid of invalidPayloads) {
      const result = await api('merchant/settings', invalid);
      assert.equal(result.status, 400, JSON.stringify(invalid));
    }
    assert.deepEqual(ok(await api('merchant/settings')), before);
  });

  await test('所有数字参数遵守已有整数上下限', async () => {
    const before = ok(await api('merchant/settings'));
    for (const [key, rule] of Object.entries(before.rules.numbers)) {
      for (const value of [rule.min - 1, rule.max + 1, 1.5, null, String(rule.min)]) {
        const result = await api('merchant/settings', change(before, key, value));
        assert.equal(result.status, 400, key + '=' + value);
        assert(result.data.fields[key]);
      }
    }
    assert.deepEqual(ok(await api('merchant/settings')), before);
  });

  await test('相同版本并发保存仅一次成功，旧回包版本不能覆盖新值', async () => {
    const before = ok(await api('merchant/settings'));
    const results = await Promise.all([
      api('merchant/settings', change(before, 'merchant.keepPointers', 7)),
      api('merchant/settings', change(before, 'merchant.keepPointers', 9)),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
    const saved = results.find(result => result.status === 200).data;
    assert.equal(saved.revision, before.revision + 1);
    assert.deepEqual(ok(await api('merchant/settings')), saved);
    const stale = await api('merchant/settings', change(before, 'schedule.merchantRewards', true));
    assert.equal(stale.status, 400);
    assert(stale.data.fields.revision);
    assert.deepEqual(ok(await api('merchant/settings')), saved);
  });

  await test('首存核对挂机快照，跨页面更新触发冲突且保留其他配置', async () => {
    const before = ok(await api('merchant/settings', undefined, 'trade-b'));
    ok(await api('loop/task', { key: 'weekOrderSubmit', enabled: true, confirm: true }, 'trade-b'));
    const conflict = await api('merchant/settings', change(before, 'schedule.merchantTrade', true), 'trade-b');
    assert.equal(conflict.status, 400);
    assert(conflict.data.fields.revision);
    const fresh = ok(await api('merchant/settings', undefined, 'trade-b'));
    ok(await api('merchant/settings', change(fresh, 'schedule.merchantTrade', true), 'trade-b'));
    const stale = ok(await api('merchant/settings', undefined, 'trade-b'));
    const all = ok(await api('settings', undefined, 'trade-b'));
    all.settings.resources.keepAccelerators = 13;
    ok(await api('settings', { settings: all.settings, revision: all.revision, baseRevision: all.baseRevision }, 'trade-b'));
    const changed = await api('merchant/settings', change(stale, 'merchant.autoUpgrade', true), 'trade-b');
    assert.equal(changed.status, 400);
    assert(changed.data.fields.revision);
    assert.equal(ok(await api('settings', undefined, 'trade-b')).settings.resources.keepAccelerators, 13);
  });

  await test('暂停和生产同步期间可保存，唤醒商情及奖励调度并保留托管状态', async () => {
    const session = app.sessions.get('trade-a');
    const client = new EventEmitter();
    let changes = 0, invalidations = 0;
    Object.assign(client, { connected: false, stop() {}, request() { throw Error('配置操作不应发送游戏请求'); } });
    client.on('automationSettingsChanged', () => changes++);
    session.client = client;
    session.paused = true;
    session.syncingProduction = true;
    const monitor = watchMerchant(client);
    const unsubscribe = monitor.subscribe(() => invalidations++);
    monitor.defer(Math.floor(Date.now() / 1000) + 3600);
    const schedule = rewardSchedule(client);
    for (const key of taskKeys) schedule.defer(key, schedule.now() + 3600);
    try {
      const current = ok(await api('merchant/settings'));
      const saved = ok(await api('merchant/settings', change(current, 'merchant.monitorSeconds', 20)));
      assert.equal(saved.settings.merchant.monitorSeconds, 20);
      assert.equal(session.preferences.merchant.monitorSeconds, 20);
      assert.equal(changes, 1);
      assert.equal(invalidations, 1);
      assert(monitor.due());
      for (const key of taskKeys) assert(schedule.due(key), key);
      assert.equal(session.paused, true);
      assert.equal(session.client, client);
      assert.equal(session.loop.running, false);
    } finally {
      unsubscribe();
      session.syncingProduction = false;
      session.paused = false;
    }
  });

  await test('设置导出导入保留策略及三个旧任务开关', async () => {
    for (const account of ['trade-a', 'trade-old']) {
      const view = ok(await api('merchant/settings', undefined, account));
      const document = ok(await api('settings/export', undefined, account));
      const validated = ok(await api('settings/validate', { document }, account));
      assert.deepEqual(subset(document.settings), view.settings);
      assert.deepEqual(subset(validated.settings), view.settings);
    }
  });
  console.log('海商王设置HTTP专项 ' + passed + '/' + passed + ' 通过');
} finally {
  await app.close();
  if (originalData === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = originalData;
  if (originalPack === undefined) delete process.env.CW_CONFIG_PACK; else process.env.CW_CONFIG_PACK = originalPack;
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
