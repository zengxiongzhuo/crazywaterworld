import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cw-role-rotation-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
const { loadStore, saveStore, upsertAccount } = await import('../src/accounts.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { createUsageLedger } = await import('../src/automation-settings.mjs');
const { createRoleRotationManager, rotationWindow, defaultRotationSettings, ROLE_ROTATION_PATH } = await import('../src/role-rotation.mjs');
const tasks = Object.fromEntries(automationTasks.map(task => [task.key, task.key === 'mail']));
const protocol = { OnWaterRequest: true, OnWaterResponse: true, AllItemRequest: true, AllItemResponse: true };
const live = new Set(), logins = [];
let clock = Date.parse('2026-11-18T22:59:00+08:00'), failWorld = null, networkFailures = 0, initializationDrops = 0, gate = null, app, root, passed = 0;
const time = text => { clock = Date.parse(text + '+08:00'); };
Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function(login) {
  assert.equal([...live].filter(client => client.login.eworldParams.openId === login.eworldParams.openId).length, 0, '一个登录账号不能同时连接两个区服');
  this.login = login; this.stopping = false; this.closeReason = null; logins.push({ login, at: clock });
  if (gate?.worldId === login.worldId) {
    this.cancelLogin = () => gate.reject(Object.assign(new Error('模拟登录已取消'), { recoverable: false }));
    try { await gate.promise; } finally { this.cancelLogin = null; }
  }
  if (this.stopping) throw new Error('连接已取消');
  if (failWorld === login.worldId) throw Object.assign(new Error('模拟此区服无法登录'), { recoverable: false });
  if (login.worldId === 100 && networkFailures > 0) {
    networkFailures--; this.closeReason = 'network';
    throw new Error('socket error during login');
  }
  live.add(this); this.state = 'READY';
  return { result: 0, playerInfo: { playerId: String(login.worldId), bornWorldId: login.worldId, worldId: login.worldId,
    nickname: login.worldId === 100 ? '轮换甲' : login.worldId === 200 ? '轮换乙' : '独立账号', level: 5 } };
};
GameClient.prototype.stop = function() { this.stopping = true; this.state = 'STOPPED'; this.closeReason = 'stopped'; live.delete(this); this.cancelLogin?.(); };
GameClient.prototype.send = function(name) {
  if (name === 'LoginFinishRequest' && this.login.worldId === 100 && initializationDrops > 0) {
    initializationDrops--; drop(this);
  }
  if (!this.connected) throw new Error('not connected');
};
GameClient.prototype.request = async function(name) {
  assert(this.connected, '停止的区服不能继续发送请求');
  if (name === 'OnWaterRequest') return { building: [] };
  if (name === 'AllItemRequest') return { items: [] };
  if (name === 'EmailBoxRequest') return { email: [] };
  return {};
};
GameClient.prototype.sendWatch = async function() { assert(this.connected); return {}; };
GameClient.prototype.interleaveRead = work => work();
const store = { version: 2, accounts: [], activeId: null, selectedRoles: {} };
function add(loginId, worldId) {
  const { account } = upsertAccount(store, { url: 'ws://fixture.invalid', source: 'mitm', login: { worldId, eworldParams: { openId: loginId } } },
    { role: { id: String(worldId), bornWorldId: worldId, worldId, nickname: worldId === 100 ? '轮换甲' : worldId === 200 ? '轮换乙' : '独立账号', level: 5 } });
  account.automation = { autoStart: false, enabled: false, tasks, everySeconds: 3600 };
  return account.id;
}
const first = add('shared', 100), second = add('shared', 200), other = add('other', 500);
saveStore(store);
async function launch() { app = createConsole({ port: 0, protocol, rotationNow: () => clock, rotationAutomatic: false }); root = await app.listen(); }
async function close() { if (app) { app.server.closeAllConnections(); await app.close(); } }
async function api(route, body, id = first) {
  const result = await fetch(root + '/api/' + route + '?account=' + encodeURIComponent(id), {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify({ confirm: true, ...body }) }), signal: AbortSignal.timeout(15000),
  });
  return { status: result.status, data: await result.json() };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const group = () => app.roleRotations.view().find(group => group.loginId === 'shared');
const tick = () => app.roleRotations.tick('shared');
const connectedShared = () => [...live].filter(client => client.login.eworldParams.openId === 'shared');
function drop(client, reason = 'network') { client.closeReason = reason; live.delete(client); client.emit('close', { reason }); }
const settings = () => ({ ...defaultRotationSettings(), enabled: true, roles: [{ id: first, enabled: true, minutes: 1 }, { id: second, enabled: true, minutes: 2 }] });
const save = async value => ok(await api('role-rotations/save', { loginId: 'shared', revision: group().revision, settings: value })).group;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function until(check) { const deadline = Date.now() + 6000; while (!check()) { assert(Date.now() < deadline, '等待模拟轮换超时'); await sleep(10); } }

try {
  await launch();
  await test('北京时间跨午夜时段的起止边界与全天连续窗口', async () => {
    const value = settings();
    assert.equal(rotationWindow(value, Date.parse('2026-11-18T14:59:59Z')).active, false);
    const window = rotationWindow(value, Date.parse('2026-11-18T15:00:00Z'));
    assert.equal(window.active, true);
    assert.equal(window.end, Date.parse('2026-11-18T22:00:00Z'));
    assert.equal(rotationWindow(value, Date.parse('2026-11-18T21:59:59Z')).key, window.key);
    assert.equal(rotationWindow(value, Date.parse('2026-11-18T22:00:00Z')).active, false);
    assert.equal(rotationWindow({ ...value, allDay: true }, clock).key, 'all-day');
    assert.equal(rotationWindow({ ...value, start: '09:00', end: '18:00' }, Date.parse('2026-11-18T10:00:00+08:00')).active, true);
  });
  await test('配置校验拒绝跨账号、重复角色、小数时长及空运行列表，旧配置保持原样', async () => {
    for (const value of [
      { ...settings(), roles: [{ id: other, enabled: true, minutes: 2 }] },
      { ...settings(), roles: [settings().roles[0], settings().roles[0]] },
      { ...settings(), roles: [{ id: first, enabled: true, minutes: 0.5 }] },
      { ...settings(), roles: [] }, { ...settings(), start: '06:00', end: '06:00' },
      ...[0, 1.5, 1001, '3'].map(maxRetries => ({ ...settings(), reconnect: { enabled: true, maxRetries, intervalSeconds: 10 } })),
      ...[0, 1.5, 86401, '10'].map(intervalSeconds => ({ ...settings(), reconnect: { enabled: true, maxRetries: 3, intervalSeconds } })),
      { ...settings(), reconnect: { enabled: 'true', maxRetries: 3, intervalSeconds: 10 } },
    ]) {
      assert.equal((await api('role-rotations/save', { loginId: 'shared', revision: 0, settings: value })).status, 400);
      assert.equal(group().revision, 0);
    }
  });
  await test('未启用时保存轮换草稿不影响手动挂机，启用后时段外停止并保留原自动挂机偏好', async () => {
    ok(await api('loop/start', { rounds: 0, everySeconds: 3600 }));
    await until(() => app.sessions.get(first)?.client?.connected);
    const client = app.sessions.get(first).client;
    await save({ ...settings(), enabled: false });
    assert(client.connected);
    const legacy = JSON.parse(fs.readFileSync(ROLE_ROTATION_PATH, 'utf8'));
    delete legacy.plans.shared.settings.reconnect;
    fs.writeFileSync(ROLE_ROTATION_PATH, JSON.stringify(legacy));
    assert.deepEqual(group().settings.reconnect, { enabled: true, maxRetries: 3, intervalSeconds: 10 }, '旧轮换配置补齐重连默认值');
    await save(settings());
    assert.equal(connectedShared().length, 0);
    assert.equal(group().runtime.phase, 'waiting');
    assert.equal(loadStore().accounts.find(account => account.id === first).automation.autoStart, true);
    assert.equal((await api('overview')).status, 400, '页面轮询不能在时段外触发登录');
    await close(); await launch(); await app.roleRotations.tickAll();
    assert.equal(connectedShared().length, 0, '重启不能绕过轮换时段自动登录');
  });
  await test('到23点自动挂机，按1分钟与2分钟交接并循环，其他登录账号和页面选择保持独立', async () => {
    ok(await api('connect', {}, other));
    ok(await api('accounts/active', { id: other }));
    const independent = app.sessions.get(other).client;
    time('2026-11-18T23:00:00'); await tick();
    assert.equal(group().runtime.currentId, first);
    assert.equal(group().runtime.endsAt, clock + 60000);
    assert(app.sessions.get(first).loop.running);
    const firstClient = app.sessions.get(first).client;
    time('2026-11-18T23:00:59'); await tick(); assert(firstClient.connected);
    time('2026-11-18T23:01:00'); await tick();
    assert.equal(group().runtime.currentId, second);
    assert.equal(group().runtime.endsAt, clock + 120000);
    assert.equal(firstClient.connected, false);
    assert.equal(connectedShared().length, 1);
    assert.equal(loadStore().accounts.find(account => account.id === second).automation.autoStart, false);
    time('2026-11-18T23:03:00'); await tick(); assert.equal(group().runtime.currentId, first);
    assert(independent.connected); assert.equal(loadStore().activeId, other);
  });
  await test('跨午夜保持同一运行窗口，窗口内重启继续当前区服剩余时间', async () => {
    time('2026-11-19T00:00:00'); await tick();
    assert.equal(group().runtime.currentId, second);
    const deadline = group().runtime.endsAt, windowKey = group().runtime.windowKey;
    time('2026-11-19T00:01:00'); await close(); await launch(); await tick();
    assert.equal(group().runtime.currentId, second);
    assert.equal(group().runtime.endsAt, deadline, '重启不能重新发放完整时长');
    assert.equal(group().runtime.windowKey, windowKey);
    time('2026-11-19T00:02:00'); await tick(); assert.equal(group().runtime.currentId, first);
  });
  await test('到早上6点提前停止并断开，次日晚间从首个区服开始', async () => {
    time('2026-11-19T05:59:30'); await tick();
    assert.equal(group().runtime.endsAt, Date.parse('2026-11-19T06:00:00+08:00'));
    const before = logins.length;
    time('2026-11-19T06:00:00'); await tick();
    assert.equal(connectedShared().length, 0);
    assert.equal(group().runtime.phase, 'waiting');
    assert.equal((await api('overview', undefined, second)).status, 400);
    assert.equal(logins.length, before);
    time('2026-11-19T23:00:00'); await tick(); assert.equal(group().runtime.currentId, first);
  });
  await test('单区服登录失败后释放连接并尝试下一个区服，过期保存版本不覆盖配置', async () => {
    failWorld = 200;
    time('2026-11-19T23:01:00'); await tick();
    assert.equal(group().runtime.phase, 'error'); assert.equal(connectedShared().length, 0);
    assert.match(group().runtime.error, /模拟此区服/);
    time('2026-11-19T23:01:30'); await tick(); assert.equal(group().runtime.currentId, first);
    failWorld = null;
    const revision = group().revision;
    assert.equal((await api('role-rotations/save', { loginId: 'shared', revision: revision - 1, settings: settings() })).status, 400);
    assert.equal(group().revision, revision); assert.equal(group().runtime.currentId, first);
  });
  await test('截止时间到达时取消尚未返回的登录，不留下迟到挂机或第二个连接', async () => {
    time('2026-11-20T05:59:59');
    let resolve, reject; gate = { worldId: 100, promise: new Promise((done, fail) => { resolve = done; reject = fail; }), reject: error => reject(error) };
    const saving = save(settings());
    await until(() => group().runtime.phase === 'connecting' && app.sessions.get(first)?.client?.cancelLogin);
    time('2026-11-20T06:00:00'); await tick();
    await saving; resolve(); gate = null;
    assert.equal(connectedShared().length, 0);
    assert.equal(group().runtime.phase, 'waiting');
    assert.equal(app.sessions.get(first).loop.running, false);
  });
  await test('手动切区暂停轮换，暂停跨重启保留，继续时重新按时段接管', async () => {
    time('2026-11-20T23:00:00'); await tick();
    ok(await api('accounts/active', { id: second, connect: true }));
    assert.equal(group().runtime.paused, true);
    const manual = app.sessions.get(second).client, before = logins.length;
    time('2026-11-20T23:10:00'); await tick(); assert(manual.connected); assert.equal(logins.length, before);
    await close(); await launch(); await tick(); assert.equal(connectedShared().length, 0);
    assert.equal(group().runtime.paused, true);
    ok(await api('role-rotations/pause', { loginId: 'shared', paused: false }));
    assert.equal(group().runtime.phase, 'running'); assert.equal(connectedShared().length, 1);
    await save({ ...settings(), enabled: false }); assert.equal(connectedShared().length, 0);
  });

  await test('网络断线按配置间隔重试同一区服，成功后保留原交接时间与用量，稳定一轮后重置次数', async () => {
    time('2026-11-21T23:00:00');
    await save({ ...settings(), reconnect: { enabled: true, maxRetries: 2, intervalSeconds: 5 } });
    await until(() => app.sessions.get(first).loop.completed > 0);
    const originalEnd = group().runtime.endsAt, originalStart = group().runtime.startedAt;
    const ticket = createUsageLedger(first).reserve({ diamonds: 2 }, {});
    const pending = createUsageLedger(first).pendingCounters(), before = logins.length;
    networkFailures = 1;
    drop(app.sessions.get(first).client);
    await until(() => group().runtime.phase === 'retrying' && !app.sessions.get(first).loop.running);
    assert.equal(group().runtime.retryAt, clock + 5000);
    assert.equal(group().runtime.currentId, first);
    assert.equal((await api('overview')).status, 400, '等待重试期间页面读取不能提前登录');
    clock += 4999; await tick(); assert.equal(logins.length, before);
    clock += 1; await tick();
    assert.equal(group().runtime.phase, 'retrying');
    assert.equal(group().runtime.reconnectAttempts, 1);
    assert.equal(group().runtime.retryAt, clock + 5000);
    clock += 5000; await tick();
    assert.equal(group().runtime.currentId, first);
    assert.equal(group().runtime.phase, 'running');
    assert.equal(group().runtime.endsAt, originalEnd);
    assert.equal(group().runtime.startedAt, originalStart);
    assert.deepEqual(logins.slice(before).map(entry => entry.login.worldId), [100, 100]);
    assert.equal(connectedShared().length, 1);
    assert.deepEqual(createUsageLedger(first).pendingCounters(), pending);
    await until(() => group().runtime.reconnectAttempts === 0);
    createUsageLedger(first).cancel(ticket);
  });
  await test('重试次数及等待跨重启保留，达到上限后停止本区服并交接下一区服', async () => {
    time('2026-11-21T23:10:00');
    await save({ ...settings(), reconnect: { enabled: true, maxRetries: 2, intervalSeconds: 1 } });
    await until(() => app.sessions.get(first).loop.completed > 0);
    const before = logins.length;
    networkFailures = 3;
    drop(app.sessions.get(first).client, 'heartbeat-timeout');
    await until(() => group().runtime.phase === 'retrying' && !app.sessions.get(first).loop.running);
    clock += 1000; await tick();
    assert.equal(group().runtime.reconnectAttempts, 1);
    const retryAt = group().runtime.retryAt, end = group().runtime.endsAt;
    await close(); await launch(); await tick();
    assert.equal(group().runtime.retryAt, retryAt);
    assert.equal(group().runtime.reconnectAttempts, 1);
    assert.equal(group().runtime.endsAt, end);
    assert.equal(logins.length, before + 1, '重启不提前重试或重新发放重试次数');
    clock += 1000; await tick();
    assert.equal(group().runtime.phase, 'error');
    assert.match(group().runtime.error, /达到 2 次/);
    assert.equal(connectedShared().length, 0);
    assert.equal(logins.length, before + 2);
    networkFailures = 0;
    clock += 30000; await tick();
    assert.equal(group().runtime.currentId, second);
    assert.equal(connectedShared().length, 1);
  });
  await test('关闭断线重连后不重试，主动暂停取消等待和迟到重连', async () => {
    time('2026-11-21T23:20:00');
    await save({ ...settings(), reconnect: { enabled: false, maxRetries: 3, intervalSeconds: 5 } });
    const before = logins.length;
    drop(app.sessions.get(first).client);
    await until(() => group().runtime.phase === 'error');
    assert.match(group().runtime.error, /重连已关闭/);
    clock += 5000; await tick(); assert.equal(logins.length, before);
    await save({ ...settings(), reconnect: { enabled: true, maxRetries: 3, intervalSeconds: 5 } });
    drop(app.sessions.get(first).client);
    await until(() => group().runtime.phase === 'retrying');
    ok(await api('role-rotations/pause', { loginId: 'shared', paused: true }));
    const pausedLogins = logins.length;
    clock += 30000; await tick();
    assert.equal(group().runtime.paused, true);
    assert.equal(group().runtime.retryAt, null);
    assert.equal(logins.length, pausedLogins);
    assert.equal(connectedShared().length, 0);
  });
  await test('重试等待超过本区服交接时间时转到下一服，每日时段结束时取消等待', async () => {
    time('2026-11-21T23:30:00');
    await save({ ...settings(), reconnect: { enabled: true, maxRetries: 3, intervalSeconds: 5 } });
    clock += 59000;
    drop(app.sessions.get(first).client);
    await until(() => group().runtime.phase === 'retrying');
    const before = logins.length;
    clock += 1000; await tick();
    assert.equal(group().runtime.currentId, second);
    assert.deepEqual(logins.slice(before).map(entry => entry.login.worldId), [200]);
    time('2026-11-22T05:59:59');
    await save(settings());
    drop(app.sessions.get(first).client);
    await until(() => group().runtime.phase === 'retrying');
    const last = logins.length;
    clock += 1000; await tick();
    assert.equal(group().runtime.phase, 'waiting');
    assert.equal(group().runtime.retryAt, null);
    assert.equal(connectedShared().length, 0);
    assert.equal(logins.length, last);
  });
  await test('重连登录尚未完成时到交接时间，取消旧登录，不延长本区服时长', async () => {
    time('2026-11-22T23:00:00');
    await save({ ...settings(), reconnect: { enabled: true, maxRetries: 2, intervalSeconds: 1 } });
    clock += 58000;
    drop(app.sessions.get(first).client);
    await until(() => group().runtime.phase === 'retrying' && !app.sessions.get(first).loop.running);
    let resolve, reject;
    gate = { worldId: 100, promise: new Promise((done, fail) => { resolve = done; reject = fail; }), reject };
    clock += 1000; const retry = tick();
    await until(() => app.sessions.get(first)?.client?.cancelLogin);
    clock += 1000; await tick(); await retry; resolve(); gate = null;
    assert.equal(connectedShared().length, 0);
    assert.equal(group().runtime.phase, 'waiting');
    await tick(); assert.equal(group().runtime.currentId, second);
  });
  await test('全天轮换首次登录遭遇网络错误时也重试同一区服', async () => {
    time('2026-11-22T22:00:00'); networkFailures = 1;
    await save({ ...settings(), allDay: true, reconnect: { enabled: true, maxRetries: 2, intervalSeconds: 2 } });
    assert.equal(group().runtime.phase, 'retrying');
    assert.equal(group().runtime.currentId, first);
    const before = logins.length;
    clock += 2000; await tick();
    assert.equal(group().runtime.phase, 'running');
    assert.equal(group().runtime.currentId, first);
    assert.equal(logins.length, before + 1);
    assert.equal(group().runtime.endsAt, clock + 60000);
    initializationDrops = 1;
    await save({ ...settings(), allDay: true, reconnect: { enabled: true, maxRetries: 2, intervalSeconds: 2 } });
    assert.equal(group().runtime.phase, 'retrying', '连接初始化时的断线也进入重试');
    const initializing = logins.length;
    clock += 2000; await tick();
    assert.equal(group().runtime.currentId, first);
    assert.equal(group().runtime.phase, 'running');
    assert.equal(logins.length, initializing + 1);
    await save({ ...settings(), enabled: false });
  });

  if (process.argv.includes('--browser')) await test('桌面和手机可配置顺序、时长及跨夜时段，草稿保留，暂停继续和校验正常', async () => {
    time('2026-11-21T22:00:00'); await save(settings());
    const { chromium } = await import('playwright-core');
    const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
    assert(executablePath, '未找到验收浏览器');
    const browser = await chromium.launch({ executablePath, headless: true });
    const output = path.resolve('output/role-rotation'); fs.mkdirSync(output, { recursive: true });
    try {
      for (const width of [1280, 360]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 768 });
        const page = await context.newPage(), errors = []; page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
        await page.goto(root); await page.locator('#tabs [data-tab="account"]').click();
        await page.locator('#rotation-login option').filter({ hasText: '轮换甲' }).waitFor({ state: 'attached' });
        await page.locator('#rotation-login').selectOption('shared');
        assert.equal(await page.locator('#rotation-roles [data-rotation-role]').count(), 2);
        const rows = page.locator('#rotation-roles [data-rotation-role]');
        await rows.nth(0).locator('[data-rotation-minutes]').fill('12');
        await page.locator('#rotation-reconnect-retries').fill('7');
        await page.locator('#rotation-reconnect-interval').fill('12');
        await page.locator('#rotation-login').selectOption('other'); await page.locator('#rotation-login').selectOption('shared');
        assert.equal(await rows.nth(0).locator('[data-rotation-minutes]').inputValue(), '12');
        assert.equal(await page.locator('#rotation-reconnect-retries').inputValue(), '7');
        assert.equal(await page.locator('#rotation-reconnect-interval').inputValue(), '12');
        await page.locator('#rotation-reconnect-enabled').uncheck();
        assert.equal(await page.locator('#rotation-reconnect-retries').isDisabled(), true);
        await page.locator('#rotation-reconnect-enabled').check();
        await rows.nth(0).getByRole('button', { name: /下移/ }).click();
        await page.locator('#rotation-enabled').check(); await page.locator('#rotation-start').fill('23:00'); await page.locator('#rotation-end').fill('06:00');
        await page.locator('#rotation-save').click(); await page.locator('#rotation-notice').filter({ hasText: '轮换配置已保存' }).waitFor();
        assert.equal(group().settings.roles[1].minutes, 12);
        assert.equal(group().settings.start, '23:00'); assert.equal(group().settings.end, '06:00');
        assert.deepEqual(group().settings.reconnect, { enabled: true, maxRetries: 7, intervalSeconds: 12 });
        assert.equal(connectedShared().length, 0);
        await page.locator('#rotation-pause').click(); await page.locator('#rotation-status').filter({ hasText: '轮换已暂停' }).waitFor();
        await page.locator('#rotation-pause').click(); await page.locator('#rotation-status').filter({ hasText: '等待每日运行时段' }).waitFor();
        const revision = group().revision;
        await page.locator('#rotation-reconnect-retries').fill('0'); await page.locator('#rotation-save').click();
        await page.locator('#rotation-notice').filter({ hasText: '1–1000' }).waitFor(); assert.equal(group().revision, revision);
        await page.locator('#rotation-reconnect-retries').fill('7');
        await rows.nth(0).locator('[data-rotation-minutes]').fill('0'); await page.locator('#rotation-save').click();
        await page.locator('#rotation-notice').filter({ hasText: '1–1440' }).waitFor(); assert.equal(group().revision, revision);
        await page.locator('#rotation-reload').click(); await page.waitForFunction(() => !document.querySelector('#rotation-roles [data-rotation-minutes]')?.value.includes('0'));
        time('2026-11-21T23:00:00'); await tick();
        drop(app.sessions.get(group().runtime.currentId).client);
        await page.locator('#rotation-status').filter({ hasText: '意外断线' }).waitFor();
        assert.match(await page.locator('#rotation-status').textContent(), /第 1\/7 次/);
        time('2026-11-21T22:00:00'); await tick();
        await page.locator('#rotation-status').filter({ hasText: '等待每日运行时段' }).waitFor();
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('.rotation-times input')].every(input => {
          const bounds = input.getBoundingClientRect(), parent = input.parentElement.getBoundingClientRect();
          return bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1;
        })), true, '时间输入不能越过各自的表单列');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(output, 'rotation-' + width + '.png'), fullPage: true });
        assert.deepEqual(errors, []); await context.close();
      }
    } finally { await browser.close(); }
  });
  await test('保存等待旧连接结束时，后来点击的暂停优先生效，不会迟到启动挂机', async () => {
    let resolve;
    const stopping = new Promise(done => { resolve = done; });
    let starts = 0;
    const raceAccount = { id: 'race', loginAccountId: 'race', roleId: '1', login: { eworldParams: { openId: 'race' } } };
    const manager = createRoleRotationManager({ accounts: () => [raceAccount], now: () => Date.parse('2026-11-21T23:00:00+08:00'), automatic: false,
      startRole: async () => { starts++; }, stopLogin: async () => stopping, isRunning: () => false });
    const saving = manager.configure('race', { ...defaultRotationSettings(), enabled: true, roles: [{ id: 'race', enabled: true, minutes: 10 }] }, 0);
    const pausing = manager.pause('race');
    resolve(); await saving; await pausing;
    assert.equal(manager.entryFor('race').runtime.paused, true);
    assert.equal(starts, 0);
    await manager.close();
  });
  await test('后台定时器无需网页轮询，在每日截止时间自动停止', async () => {
    let running = false, starts = 0;
    const began = Date.now(), end = Date.parse('2026-11-21T06:00:00+08:00');
    const timerAccount = { id: 'timer', loginAccountId: 'timer', roleId: '2', login: { eworldParams: { openId: 'timer' } } };
    const manager = createRoleRotationManager({ accounts: () => [timerAccount], now: () => end - 1000 + Date.now() - began,
      startRole: async () => { running = true; starts++; }, stopLogin: async () => { running = false; }, isRunning: () => running });
    try {
      await manager.configure('timer', { ...defaultRotationSettings(), enabled: true, roles: [{ id: 'timer', enabled: true, minutes: 10 }] }, 0);
      assert.equal(starts, 1);
      manager.start();
      await until(() => manager.entryFor('timer').runtime.phase === 'waiting' && !running);
      assert.equal(starts, 1);
    } finally { await manager.close(); }
  });
  await test('后台定时器无需网页轮询，按间隔完成连续网络重试', async () => {
    let running = false, starts = 0;
    const account = { id: 'retry-timer', roleId: '3', login: { eworldParams: { openId: 'retry-timer' } } };
    const manager = createRoleRotationManager({ accounts: () => [account],
      startRole: async () => { starts++; if (starts === 2) throw Object.assign(new Error('模拟网络波动'), { recoverable: true }); running = true; },
      stopLogin: async () => { running = false; }, isRunning: () => running });
    try {
      await manager.configure(account.id, { ...defaultRotationSettings(), enabled: true, allDay: true,
        reconnect: { enabled: true, maxRetries: 2, intervalSeconds: 1 }, roles: [{ id: account.id, enabled: true, minutes: 10 }] }, 0);
      manager.start();
      const originalEnd = manager.entryFor(account.id).runtime.endsAt;
      await manager.disconnected(account, Object.assign(new Error('模拟网络断线'), { recoverable: true }), manager.entryFor(account.id).runtime.lease);
      await until(() => starts === 3 && running && manager.entryFor(account.id).runtime.phase === 'running');
      assert.equal(manager.entryFor(account.id).runtime.endsAt, originalEnd);
      assert.equal(manager.entryFor(account.id).runtime.reconnectAttempts, 2);
    } finally { await manager.close(); }
  });
  assert.equal(JSON.parse(fs.readFileSync(ROLE_ROTATION_PATH, 'utf8')).version, 1);
  console.log(`区服轮换专项 ${passed}/${passed} 通过`);
} finally { gate?.reject(new Error('测试收尾')); gate = null; await close(); fs.rmSync(directory, { recursive: true, force: true }); }
