import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-guild-ship-settings-'));
const original = { data: process.env.CW_DATA_DIR, config: process.env.CW_CONFIG_PACK };
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { defaultSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
saveStore({ activeId: 'ship-a', accounts: ['ship-a', 'ship-b'].map(id => ({
  id, label: id, url: 'ws://invalid.invalid', login: {}, automation: { enabled: false },
})) });
const legacy = defaultSettings();
Object.assign(legacy.guildShip, { crew: true, captain: false, mode: 'small', disabledMaterials: ['木板'] });
fs.writeFileSync(path.join(directory, 'automation-settings.json'), JSON.stringify({ version: 1, accounts: {
  'ship-a': { settings: legacy, revision: 4, savedAt: 'legacy' },
} }));
const app = createConsole({ port: 0, protocol: {} });
const root = await app.listen();
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
async function api(route = 'guild-ship/settings', body, account = 'ship-a') {
  const response = await fetch(root + '/api/' + route + '?account=' + account, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, data: await response.json() };
}
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data; };
const change = (view, key, value) => ({ key, value, revision: view.revision, baseRevision: view.baseRevision, confirm: true });

try {
  await test('离线读取沿用已有商船配置及材料选择，独立于联盟设置', async () => {
    const view = ok(await api());
    assert.deepEqual(view.settings.guildShip, legacy.guildShip);
    assert.equal(view.settings.alliance, undefined);
    assert.equal(view.revision, 4);
    assert(Array.isArray(view.catalog.materials));
    assert(view.rules.numbers['guildShip.minCoinsSmall']);
    assert.equal(app.sessions.get('ship-a').client, null);
    assert.doesNotMatch(JSON.stringify(view), /invalid\.invalid|"login"|"token"/);
  });
  await test('按单字段保存各种策略，保留其他设置和另一账号，关闭总开关不清空细项', async () => {
    const before = ok(await api('settings'));
    const other = ok(await api('settings', undefined, 'ship-b'));
    const expected = structuredClone(before.settings);
    let view = ok(await api());
    for (const [key, value] of [['enabled', true], ['captain', true], ['mode', 'full'],
      ['minCoinsLarge', 70], ['rewardItems', ['木板', '橡胶圈']], ['disabledMaterials', ['木板']],
      ['redStartEnabled', true], ['redStartTime', '23:25'], ['enabled', false]]) {
      view = ok(await api('guild-ship/settings', change(view, 'guildShip.' + key, value)));
      expected.guildShip[key] = value;
      assert.deepEqual(view.settings.guildShip, expected.guildShip);
    }
    assert.deepEqual(ok(await api('settings')).settings, expected);
    assert.deepEqual(loadAutomationSettings('ship-a').settings, expected);
    assert.deepEqual(ok(await api('settings', undefined, 'ship-b')), other);
    assert.equal(app.sessions.get('ship-a').client, null);
    assert.equal(app.sessions.get('ship-a').loop.running, false);
  });
  await test('拒绝越界字段、错误类型、非法选项、时间及过期版本', async () => {
    const before = ok(await api());
    for (const [key, value] of [['alliance.enabled', true], ['guildShip.__proto__', {}],
      ['guildShip.unknown', true], ['guildShip.enabled', 'true'], ['guildShip.mode', 'invalid'],
      ['guildShip.redStartTime', '24:00'], ['guildShip.disabledMaterials', '木板'],
      ['guildShip.minCoinsSmall', -1], ['guildShip.minCoinsSmall', 1.5]]) {
      assert.equal((await api('guild-ship/settings', change(before, key, value))).status, 400, key);
    }
    assert.deepEqual(ok(await api()), before);
    const results = await Promise.all([true, false].map(value =>
      api('guild-ship/settings', change(before, 'guildShip.crew', value))));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
    const stale = await api('guild-ship/settings', change(before, 'guildShip.captain', false));
    assert.equal(stale.status, 400);
    assert(stale.data.fields.revision);
  });
  await test('未建立保存版本时也检查配置基线，暂停和生产同步不阻止预配置', async () => {
    const before = ok(await api('guild-ship/settings', undefined, 'ship-b'));
    assert.equal(before.revision, 0);
    assert.equal((await api('guild-ship/settings', { ...change(before, 'guildShip.crew', true), baseRevision: 'stale' }, 'ship-b')).status, 400);
    const session = app.sessions.get('ship-b');
    session.paused = true;
    session.syncingProduction = true;
    const saved = ok(await api('guild-ship/settings', change(before, 'guildShip.crew', true), 'ship-b'));
    assert.equal(saved.settings.guildShip.crew, true);
    assert.equal(session.paused, true);
    assert.equal(session.loop.running, false);
    assert.equal(session.client, null);
    session.syncingProduction = false;
  });
  console.log('联盟商船设置 HTTP 专项 ' + passed + '/' + passed + ' 通过');
} finally {
  await app.close();
  for (const [key, value] of [['CW_DATA_DIR', original.data], ['CW_CONFIG_PACK', original.config]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
