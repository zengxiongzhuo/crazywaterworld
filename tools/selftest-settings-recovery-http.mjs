// 配置损坏/删除的 HTTP 与运行态回归：所有账号、文件及游戏客户端均为隔离测试数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-settings-recovery-http-'));
const environment = ['CW_DATA_DIR', 'CW_CONFIG_PACK', 'CW_RESOURCE_DIR'];
const previousEnvironment = Object.fromEntries(environment.map(key => [key, process.env[key]]));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { GameClient } = await import('../src/client.mjs');
const { loadStore, saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { defaultSettings, loadAutomationSettings, saveAutomationSettings, settingsFile, usageFile,
  createUsageLedger, SETTINGS_SCHEMA_VERSION } = await import('../src/automation-settings.mjs');
const file = settingsFile(), connected = new Set(), states = new Map();
let connections = 0, app = null, root, sequence = 0, passed = 0;
const writes = [];

Object.defineProperty(GameClient.prototype, 'connected', { get() { return connected.has(this); } });
GameClient.prototype.connect = async function (login) {
  this.fixture = states.get(login.fixtureId);
  assert(this.fixture, '只允许隔离测试账号连接');
  connections++; this.fixture.logins++; this.stopping = false; connected.add(this);
  return { playerInfo: { playerId: 9001001, worldId: 9001, level: 5 } };
};
GameClient.prototype.send = function (name) { assert.equal(name, 'LoginFinishRequest'); };
GameClient.prototype.request = async function (name) {
  this.fixture.reads.push(name);
  if (name === 'EmailBoxRequest') {
    if (this.fixture.onMail) return this.fixture.onMail();
    return { email: [], total: 0 };
  }
  if (name === 'OnWaterRequest') return { building: [] };
  if (name === 'AllItemRequest') return { items: [] };
  if (name === 'AllResourceRequest') return { list: [] };
  if (name === 'MyFleetsRequest') return { fleets: [] };
  return {};
};
GameClient.prototype.sendWatch = async function (name, body) {
  writes.push({ name, body });
  throw new Error('配置异常后禁止继续发送游戏写操作');
};
GameClient.prototype.stop = function () { this.stopping = true; connected.delete(this); };

const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function waitFor(check, label, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return; await sleep(20); }
  assert.fail('等待超时：' + label);
}
async function close() {
  if (!app) return;
  const current = app; app = null;
  const jobs = [...current.sessions.values()].map(session => session.loop.job).filter(Boolean);
  current.server.closeAllConnections(); await current.close(); await Promise.allSettled(jobs);
}
async function open() { app = createConsole({ port: 0, protocol: {} }); root = await app.listen(); }
async function api(id, route, body) {
  const response = await fetch(root + '/api/' + route + '?account=' + encodeURIComponent(id), {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, ...body }) }),
    signal: AbortSignal.timeout(6000),
  });
  return { status: response.status, data: await response.json() };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
function runnableSettings() {
  const settings = defaultSettings();
  settings.schedule.mail = true;
  settings.loop.everySeconds = 60;
  return settings;
}
async function seed({ autoStart = true, configured = true, save = true, other = false } = {}) {
  await close();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const id = 'recovery-http-' + ++sequence, otherId = id + '-other';
  const state = { logins: 0, reads: [] }; states.set(id, state); states.set(otherId, { logins: 0, reads: [] });
  const account = (key, enabled, known) => ({ id: key, label: key, url: 'ws://invalid.invalid', login: { fixtureId: key },
    automation: { enabled, autoStart: enabled, ...(known ? { settingsConfigured: true } : {}) } });
  saveStore({ activeId: id, accounts: [account(id, autoStart, configured), ...(other ? [account(otherId, false, true)] : [])] });
  if (save) saveAutomationSettings(id, runnableSettings(), { revision: 0 });
  if (other) {
    const settings = runnableSettings(); settings.resources.diamondDailyLimit = 321;
    saveAutomationSettings(otherId, settings, { revision: 0 });
  }
  return { id, otherId, state };
}
function assertStopped(id) {
  const automation = loadStore().accounts.find(account => account.id === id).automation;
  assert.equal(automation.enabled, false, '运行开关必须关闭：' + JSON.stringify({ automation, recovery: app.sessions.get(id)?.settingsRecovery, error: app.sessions.get(id)?.loop.error }));
  assert.equal(automation.autoStart, false, '开机自启必须关闭');
  assert.equal(app.sessions.get(id)?.loop.running, false);
}
function assertRecovery(view, reason) {
  assert.equal(view.recovery?.required, true);
  assert.equal(view.recovery.reason, reason);
  assert.match(view.recovery.message, /默认/); assert.match(view.recovery.message, /重新配置/);
  assert.deepEqual(view.settings, defaultSettings());
}
function assertBackup(view, bytes) {
  assert(view.recovery.backupFile, '损坏原文件必须保留备份');
  assert.equal(path.dirname(path.resolve(view.recovery.backupFile)), path.resolve(directory));
  assert.deepEqual(fs.readFileSync(view.recovery.backupFile), bytes);
}

try {
  await test('新账号未保存配置时使用关闭的默认值，不误报损坏或创建恢复文件', async () => {
    const { id } = await seed({ autoStart: false, configured: false, save: false });
    const before = connections; await open();
    const view = ok(await api(id, 'settings'));
    assert.equal(view.revision, 0); assert(!view.recovery?.required);
    assert.deepEqual(view.settings, defaultSettings()); assert.equal(fs.existsSync(file), false);
    assert.equal(connections, before);
  });

  await test('已配置账号丢失整个文件时恢复默认并关闭开机自启，重建服务仍要求重新配置', async () => {
    const { id } = await seed(); fs.unlinkSync(file);
    const before = connections; await open();
    let view = ok(await api(id, 'settings')); assertRecovery(view, 'missing');
    assertStopped(id); assert.equal(connections, before);
    const stored = loadAutomationSettings(id); assert.equal(stored.recovery.required, true);
    const revision = view.revision;
    assert.equal((await api(id, 'loop/start', { rounds: 1 })).status, 400);
    assert.equal((await api(id, 'loop/auto-start', { autoStart: true })).status, 400);
    assertStopped(id);
    assert.equal(connections, before, '恢复确认前不可隐式登录');
    await close(); await open();
    view = ok(await api(id, 'settings')); assertRecovery(view, 'missing');
    assert.equal(view.revision, revision, '同一次恢复跨重启不应反复改写'); assertStopped(id);
    assert.equal(connections, before);
    const staleSave = await api(id, 'settings', { settings: runnableSettings(), revision: view.revision, baseRevision: view.baseRevision });
    assert.equal(staleSave.status, 400, '旧页面无恢复令牌时不能自动覆盖恢复的默认配置');
    assert.equal(loadAutomationSettings(id).recovery.required, true);
    for (const [route, payload] of [
      ['login-settings', { settings: view.settings.login, revision: view.revision }],
      ['loop/control', { key: 'cityWar.enabled', enabled: true, revision: view.revision }],
      ['loop/fishing-reserve', { fishingGoldReserve: 100 }],
    ]) {
      const refused = await api(id, route, payload);
      assert.equal(refused.status, 400, route + ' 不能绕过完整配置的恢复确认');
      assert.match(refused.data.error, /重新配置|恢复|默认/);
      const pending = loadAutomationSettings(id);
      assert.equal(pending.recovery.required, true); assert.equal(pending.revision, view.revision);
      assertStopped(id); assert.equal(connections, before);
    }
    assert.equal(typeof view.recoveryToken, 'string'); assert(view.recoveryToken);
    const saved = ok(await api(id, 'settings', { settings: runnableSettings(), revision: view.revision,
      baseRevision: view.baseRevision, recoveryToken: view.recoveryToken }));
    assert(!saved.recovery?.required); assert(!loadAutomationSettings(id).recovery?.required);
    assertStopped(id); assert.equal(connections, before, '保存有效配置不会自动开机');
    await close(); await open();
    ok(await api(id, 'settings')); assertStopped(id); assert.equal(connections, before);
    ok(await api(id, 'loop/start', { rounds: 1 }));
    await waitFor(() => !app.sessions.get(id).loop.running, '用户明确开始的一轮完成');
    assert.equal(connections, before + 1, '手动开始后才允许连接隔离客户端');
  });

  await test('仅删除一个账号的配置时恢复该账号，保留其他账号设置及用量账本', async () => {
    const { id, otherId } = await seed({ other: true });
    const store = JSON.parse(fs.readFileSync(file)), otherEntry = structuredClone(store.accounts[otherId]);
    delete store.accounts[id]; fs.writeFileSync(file, JSON.stringify(store));
    const ledger = createUsageLedger(id); ledger.confirm(ledger.reserve({ diamonds: 17 }, { diamonds: 100 }));
    const usage = fs.readFileSync(usageFile()), before = connections;
    await open(); const view = ok(await api(id, 'settings')); assertRecovery(view, 'missing'); assertStopped(id);
    assert.equal(connections, before);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).accounts[otherId], otherEntry);
    const otherView = ok(await api(otherId, 'settings')); assert(!otherView.recovery?.required);
    assert.deepEqual(otherView.settings, otherEntry.settings); assert.deepEqual(fs.readFileSync(usageFile()), usage);
  });

  await test('JSON损坏先保留原字节备份，再提供默认配置和持久恢复提示', async () => {
    const { id } = await seed(), bytes = Buffer.from('{"version":13,"accounts":{ broken\n');
    fs.writeFileSync(file, bytes); const before = connections; await open();
    const view = ok(await api(id, 'settings')); assertRecovery(view, 'corrupt'); assertBackup(view, bytes);
    assertStopped(id); assert.equal(connections, before);
    const again = ok(await api(id, 'settings'));
    assert.equal(again.revision, view.revision); assert.equal(again.recovery.backupFile, view.recovery.backupFile);
  });

  await test('单账号字段非法只恢复受影响配置，其他账号仍可读取', async () => {
    const { id, otherId } = await seed({ other: true });
    const store = JSON.parse(fs.readFileSync(file)), otherEntry = structuredClone(store.accounts[otherId]);
    store.accounts[id].settings.resources.diamondDailyLimit = -1;
    fs.writeFileSync(file, JSON.stringify(store)); const bytes = fs.readFileSync(file), before = connections;
    await open(); const view = ok(await api(id, 'settings')); assertRecovery(view, 'corrupt'); assertBackup(view, bytes);
    assertStopped(id); assert.equal(connections, before);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).accounts[otherId], otherEntry);
    assert.deepEqual(ok(await api(otherId, 'settings')).settings, otherEntry.settings);
  });

  await test('运行中删除配置无需访问设置页即停止挂机，并阻止重启后恢复旧内存', async () => {
    const { id, state } = await seed({ autoStart: false }); await open();
    ok(await api(id, 'settings')); ok(await api(id, 'loop/start', { rounds: 0 }));
    await waitFor(() => state.reads.includes('EmailBoxRequest'), '挂机首次读取');
    assert.equal(app.sessions.get(id).loop.running, true, '删除前应仍在挂机：' + app.sessions.get(id).loop.error);
    const count = connections; fs.unlinkSync(file);
    // 此处不调用任何 HTTP 查询，确保不是设置页读取才触发保护。
    await waitFor(() => !app.sessions.get(id).loop.running, '文件监听关闭挂机');
    assertStopped(id); assertRecovery(ok(await api(id, 'settings')), 'missing');
    await close(); await open();
    assertRecovery(ok(await api(id, 'settings')), 'missing'); assertStopped(id); assert.equal(connections, count);
  });

  await test('读取期间配置损坏时，后续游戏写入前立即复核并取消旧动作', async () => {
    const { id, state } = await seed({ autoStart: false });
    state.onMail = () => {
      fs.writeFileSync(file, '{broken during mailbox read');
      state.onMail = null;
      return { total: 1, email: [{ emailId: 12345, status: 2, attachment: true, got: false }] };
    };
    await open(); ok(await api(id, 'settings')); const before = writes.length;
    ok(await api(id, 'loop/start', { rounds: 1 }));
    await waitFor(() => !app.sessions.get(id).loop.running, '损坏导致本轮退出');
    assert.equal(state.reads.includes('EmailBoxRequest'), true); assert.equal(writes.length, before);
    assertRecovery(ok(await api(id, 'settings')), 'corrupt'); assertStopped(id);
  });

  await test('高版本但内容兼容的配置可读取、保存和挂机，版本与原选择保留', async () => {
    const { id, otherId, state } = await seed({ autoStart: false, other: true });
    const store = JSON.parse(fs.readFileSync(file)), version = SETTINGS_SCHEMA_VERSION + 1;
    store.version = version; store.accounts[id].settingsVersion = version;
    const settings = store.accounts[id].settings;
    settings.loop.everySeconds = 77;
    settings.resources.diamondDailyLimit = 3210;
    settings.treasure.followMode = 'eachTime';
    const otherEntry = structuredClone(store.accounts[otherId]);
    fs.writeFileSync(file, JSON.stringify(store));
    const bytes = fs.readFileSync(file), before = connections; await open();
    const view = ok(await api(id, 'settings'));
    assert(!view.recovery?.required); assert.deepEqual(view.settings, settings);
    assert.deepEqual(fs.readFileSync(file), bytes, '兼容读取不应改写文件');
    assert.equal(connections, before);
    const edited = structuredClone(view.settings); edited.loop.everySeconds = 83;
    const saved = ok(await api(id, 'settings', { settings: edited, revision: view.revision, baseRevision: view.baseRevision }));
    assert(!saved.recovery?.required); assert.deepEqual(saved.settings, edited);
    const persisted = JSON.parse(fs.readFileSync(file));
    assert.equal(persisted.version, version); assert.equal(persisted.accounts[id].settingsVersion, version);
    assert.deepEqual(persisted.accounts[id].settings, edited); assert.deepEqual(persisted.accounts[otherId], otherEntry);
    ok(await api(id, 'loop/start', { rounds: 1 }));
    await waitFor(() => !app.sessions.get(id).loop.running, '兼容配置的单轮挂机完成');
    assert.equal(connections, before + 1); assert(state.reads.includes('EmailBoxRequest'));
    const after = ok(await api(id, 'settings'));
    assert(!after.recovery?.required); assert.equal(after.settings.schedule.mail, true);
    assert.equal(after.settings.resources.diamondDailyLimit, 3210);
    assert.equal(after.settings.treasure.followMode, 'eachTime'); assert.equal(after.settings.loop.everySeconds, 83);
    const finalStore = JSON.parse(fs.readFileSync(file));
    assert.equal(finalStore.version, version); assert.equal(finalStore.accounts[id].settingsVersion, version);
    assert.deepEqual(finalStore.accounts[otherId], otherEntry);
  });

  await test('高版本含实际不兼容字段时提示具体位置，不覆盖配置或连接游戏', async () => {
    const { id } = await seed({ autoStart: false });
    const store = JSON.parse(fs.readFileSync(file)); store.version = SETTINGS_SCHEMA_VERSION + 1;
    store.accounts[id].settingsVersion = SETTINGS_SCHEMA_VERSION + 1;
    store.accounts[id].settings.resources.futureBudgetRule = 'new-rule';
    fs.writeFileSync(file, JSON.stringify(store));
    const bytes = fs.readFileSync(file), before = connections; await open();
    const view = ok(await api(id, 'settings'));
    assert.equal(view.recovery?.required, true); assert.equal(view.recovery.reason, 'unavailable');
    assert.match(view.recovery.message, /resources\.futureBudgetRule/);
    const start = await api(id, 'loop/start', { rounds: 1 });
    assert.equal(start.status, 400); assert.match(start.data.error, /resources\.futureBudgetRule/);
    const save = await api(id, 'settings', { settings: runnableSettings(), revision: view.revision,
      baseRevision: view.baseRevision, recoveryToken: view.recoveryToken });
    assert.equal(save.status, 400); assert.match(save.data.error, /resources\.futureBudgetRule/);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(connections, before);
  });

  assert.deepEqual(writes, [], '异常恢复测试全程不能发送游戏写入');
  console.log(`配置异常恢复 HTTP 专项 ${passed}/${passed} 通过（隔离客户端，零真实游戏请求）`);
} finally {
  await close();
  for (const key of environment) {
    if (previousEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[key];
  }
  assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
  assert(path.basename(directory).startsWith('cw-settings-recovery-http-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
