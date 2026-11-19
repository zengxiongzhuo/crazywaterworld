// Account-level recovery through HTTP with fake game sessions and isolated data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-login-recovery-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { GameClient } = await import('../src/client.mjs');
const { saveStore, loadStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { createDeclaredProtocol } = await import('./fixtures/declared-protocol.mjs');
const protocol = createDeclaredProtocol(['OnWaterRequest', 'OnWaterResponse', 'AllItemRequest', 'AllItemResponse', 'AllResourceRequest', 'AllResourceResponse']);
const { automationTasks } = await import('../src/automation.mjs');
const { createUsageLedger } = await import('../src/automation-settings.mjs');
const { beginOrderMaterialSpend, pendingOrderMaterialSpends, pendingFarmMaterialSpends } = await import('../src/order-reservations.mjs');
const { factoryProductionOperation } = await import('../src/spend-evidence.mjs');

const live = new Set(), states = new Map(), apps = new Set();
let sequence = 0, passed = 0;
const water = () => ({ building: [
  { buildingId: '1厨房', level: 1, factory: { factoryQ: [], finishedProducts: [] } },
  { buildingId: '1农田', level: 1, farm: {} },
] });

Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function (login) {
  const state = states.get(login.fixtureId);
  this.fixture = state;
  this.stopping = false;
  this.closeReason = null;
  state.clients.push(this);
  state.logins++;
  state.loginTimes.push(Date.now());
  state.events.push('login');
  if (state.loginError || state.failures > 0) {
    state.failures = Math.max(0, state.failures - 1);
    this.closeReason = state.loginError?.loginResponse ? 'login-rejected' : 'network';
    throw state.loginError ?? new Error('socket error during login');
  }
  if (state.loginGate) {
    this.cancelLogin = () => state.loginGate.reject(Object.assign(new Error('client stopped'), { recoverable: false }));
    try { await state.loginGate.promise; } finally { this.cancelLogin = null; }
  }
  live.add(this);
  return { result: 0, playerInfo: state.player };
};
GameClient.prototype.stop = function () {
  this.stopping = true;
  this.closeReason = 'stopped';
  live.delete(this);
  this.cancelLogin?.();
};
GameClient.prototype.send = function (name) {
  assert.equal(name, 'LoginFinishRequest');
  this.fixture.events.push(name);
};
GameClient.prototype.request = async function (name) {
  const state = this.fixture;
  state.events.push(name);
  if (name === 'OnWaterRequest') {
    await state.waterGate?.promise;
    if (state.waterFailures > 0) {
      state.waterFailures--;
      throw new Error('模拟工厂状态暂时不可读');
    }
    return water();
  }
  if (name === 'AllItemRequest') return { items: [
    { itemId: '生鱼片', num: 9 }, { itemId: '小麦种子', num: 9 },
  ] };
  if (name === 'EmailBoxRequest') return { total: state.mailPending == null ? 0 : 1,
    email: state.mailPending == null ? [] : [{ emailId: '1', status: state.mailPending ? 2 : 1, got: !state.mailPending }] };
  if (name === 'MyFleetsRequest') {
    if (state.kickOnFleet > 0) {
      state.kickOnFleet--;
      drop(this);
      throw new Error('账号在初始化尾段再次被顶号');
    }
    return { fleets: [] };
  }
  return {};
};
GameClient.prototype.sendWatch = async function (name) {
  const state = this.fixture;
  assert.equal(name, 'QuickGotReadEmailRequest');
  state.events.push(name);
  state.writes.push(name);
  state.mailPending = false;
  return {};
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function waitFor(check, label, timeout = 7000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail('等待超时：' + label);
}
function drop(client, reason = 'kicked') {
  client.closeReason = reason;
  live.delete(client);
  if (reason === 'kicked') client.emit('fatal', { reason: 'SCChannelExpired' });
  client.emit('close', { reason });
}

function addFakeAccount() {
  const id = 'login-recovery-' + ++sequence;
  const player = { playerId: 810000 + sequence, worldId: 9001, nickname: '登录恢复离线测试', level: 5 };
  const state = { player, clients: [], logins: 0, loginTimes: [], events: [], writes: [], failures: 0 };
  states.set(id, state);
  const store = loadStore();
  store.accounts.push({ id, url: 'ws://invalid.invalid', login: { fixtureId: id },
    automation: { enabled: false, tasks: Object.fromEntries(automationTasks.map(task => [task.key, task.key === 'mail'])) } });
  store.activeId = id;
  saveStore(store);
  return { id, player, state };
}

async function fixture({ delay = 140, realTime = false } = {}) {
  const { id, player, state } = addFakeAccount();
  let app, root;
  const launch = async () => {
    app = createConsole({ port: 0, protocol, ...(realTime ? {} : { recoveryDelayMs: () => delay }) });
    apps.add(app);
    root = await app.listen();
    await api('accounts');
  };
  const response = async (route, body = null, accountId = id) => {
    const result = await fetch(root + '/api/' + route + '?account=' + accountId, {
      ...(body === null ? {} : { method: 'POST', body: JSON.stringify({ confirm: true, ...body }) }),
      signal: AbortSignal.timeout(7000),
    });
    return { status: result.status, data: await result.json() };
  };
  const api = async (route, body = null, accountId = id) => {
    const result = await response(route, body, accountId);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const session = (accountId = id) => app.sessions.get(accountId);
  const saved = (accountId = id) => loadStore().accounts.find(account => account.id === accountId)?.automation;
  const configure = async (patch, accountId = id) => {
    const current = await api('login-settings', null, accountId);
    return api('login-settings', { revision: current.revision, settings: { ...current.settings,
      jitterSeconds: 0, ...patch, deep: { ...current.settings.deep, enabled: false, ...patch.deep } } }, accountId);
  };
  const stopApp = async () => {
    const loopJob = session()?.loop.job, recoveryJob = session()?.loginRecoveryJob;
    await app.close();
    await Promise.allSettled([loopJob, recoveryJob]);
    apps.delete(app);
  };
  const close = async () => {
    state.waterGate?.resolve();
    state.loginGate?.resolve();
    await stopApp();
    const current = loadStore();
    current.accounts = current.accounts.filter(account => account.id !== id);
    if (current.activeId === id) current.activeId = null;
    saveStore(current);
  };
  const pending = () => [...pendingOrderMaterialSpends(player), ...pendingFarmMaterialSpends(player)];
  const makePending = () => {
    const operation = factoryProductionOperation(water(), '1厨房', { sealed: true, attempted: [{ body: { productId: '鱼汤' } }] });
    beginOrderMaterialSpend(player, [{ id: '生鱼片', have: 10, need: 1 }], '未知排产', { operation });
    beginOrderMaterialSpend(player, [{ id: '小麦种子', have: 10, need: 1 }], '未知播种',
      { farm: { args: [{ buildingId: '1农田', productId: '小麦' }] } });
    return pending();
  };
  await launch();
  return { id, state, api, response, session, saved, configure, launch, stopApp, close, pending, makePending };
}
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
saveStore({ activeId: null, accounts: [] });

try {
  await test('未挂机账号异地登录后按设置自动恢复，网页查询不能提前登录', async () => {
    const f = await fixture({ delay: 300 });
    try {
      await f.configure({ reconnectEnabled: true, maxRetries: 3 });
      await f.api('connect', {});
      const records = f.makePending();
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'waiting', '账号重连等待');
      assert.equal(f.session().loop.running, false);
      assert.equal(f.saved().loginRecovery.attempts, 0);
      for (const route of ['overview', 'world']) assert.equal((await f.response(route)).status, 400);
      assert.equal(f.state.logins, 1);
      assert.deepEqual(f.pending(), records);
      await waitFor(() => f.state.logins === 2 && f.session().loginRecovery === null, '账号独立恢复完成');
      assert.equal(f.saved().loginRecovery, null);
      assert.equal(f.session().loginBlocked, false);
      assert.equal(f.saved().loginBlocked, false);
      assert.equal(f.pending().length, 0);
      assert.equal(f.state.writes.length, 0);
    } finally { await f.close(); }
  });

  await test('挂机自动重连先同步未知生产，再发送后续业务写请求', async () => {
    const f = await fixture(), gate = deferred();
    try {
      await f.configure({ reconnectEnabled: true });
      await f.api('loop/start', { rounds: 0, everySeconds: 3600 });
      await waitFor(() => f.session().loop.completed === 1, '首轮完成');
      const records = f.makePending();
      const ledger = createUsageLedger(f.id);
      ledger.reserve({ diamonds: 4 }, {}, {}, { uniqueKey: 'unknown-before-recovery' });
      const budget = ledger.keyRecords();
      f.state.mailPending = true;
      f.state.waterGate = gate;
      f.state.events = [];
      drop(f.session().client);
      await waitFor(() => f.state.events.includes('OnWaterRequest'), '恢复后读取生产状态');
      assert.deepEqual(f.pending(), records);
      assert.equal(f.state.writes.length, 0);
      gate.resolve();
      await waitFor(() => f.state.writes.length === 1 && f.session().loop.completed === 2, '同步后邮件领取并完成一轮');
      assert.equal(f.session().loginRecovery, null);
      assert.equal(f.pending().length, 0);
      assert(f.state.events.indexOf('AllItemRequest') < f.state.events.indexOf('QuickGotReadEmailRequest'));
      assert.deepEqual(ledger.keyRecords(), budget);
      assert.equal(ledger.pendingCounters().diamonds, 4);
    } finally { gate.resolve(); await f.close(); }
  });

  await test('首次生产读取失败继续按重试策略恢复，成功前保留未知记录', async () => {
    const f = await fixture({ delay: 200 });
    try {
      await f.configure({ reconnectEnabled: true, maxRetries: 3 });
      await f.api('connect', {});
      const records = f.makePending();
      f.state.waterFailures = 1;
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'waiting' && f.session().loginRecovery.attempts === 1, '同步失败后等待');
      assert.deepEqual(f.pending(), records);
      assert.equal((await f.response('overview')).status, 400);
      await waitFor(() => f.state.logins === 3 && f.session().loginRecovery === null, '同步自动重试成功');
      assert.equal(f.pending().length, 0);
    } finally { await f.close(); }
  });

  await test('重启保留下一次截止时间和已尝试次数，耗尽后网页读取不能重登', async () => {
    const f = await fixture({ delay: 2000 });
    try {
      await f.configure({ reconnectEnabled: true, maxRetries: 2 });
      await f.api('connect', {});
      f.state.failures = 10;
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'waiting' && f.session().loginRecovery.attempts === 1, '第一次失败后的等待');
      const before = structuredClone(f.saved().loginRecovery);
      await f.stopApp();
      assert.equal(f.saved().loginRecovery.nextAttemptAt, before.nextAttemptAt);
      await f.launch();
      assert.equal(f.session().loginRecovery.attempts, 1);
      assert.equal(f.session().loginRecovery.nextAttemptAt, before.nextAttemptAt);
      await waitFor(() => f.session().loginRecovery?.status === 'exhausted', '重试次数耗尽');
      assert.equal(f.state.logins, 3);
      assert.equal(f.saved().loginRecovery.attempts, 2);
      assert.equal((await f.response('overview')).status, 400);
      assert.equal(f.state.logins, 3);
    } finally { await f.close(); }
  });

  await test('持续挂机等待中重启沿用原截止时间，恢复后同步并完成一轮', async () => {
    const f = await fixture({ delay: 2000 });
    try {
      await f.configure({ reconnectEnabled: true });
      await f.api('loop/start', { rounds: 0, everySeconds: 3600 });
      await waitFor(() => f.session().loop.completed === 1, '重启前首轮完成');
      f.makePending();
      f.state.mailPending = true;
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'waiting', '持续挂机等待恢复');
      const before = structuredClone(f.saved().loginRecovery);
      await f.api('accounts/pause', { paused: false });
      assert.equal(f.state.logins, 1, '重复恢复托管不会提前登录');
      assert.equal(f.session().loginRecovery.nextAttemptAt, before.nextAttemptAt);
      await f.stopApp();
      await f.launch();
      assert.equal(f.session().loop.running, true);
      assert.equal(f.session().loginRecovery.nextAttemptAt, before.nextAttemptAt);
      assert.equal(f.session().loginRecovery.attempts, before.attempts);
      assert.equal(f.state.logins, 1);
      await waitFor(() => f.session().loop.completed === 1 && f.state.writes.length === 1, '重启后真实执行一轮');
      assert(f.state.loginTimes[1] >= before.nextAttemptAt);
      assert.equal(f.session().loginRecovery, null);
      assert.equal(f.saved().loginRecovery, null);
      assert.equal(f.pending().length, 0);
      assert.equal(f.session().loop.running, true);
    } finally { await f.close(); }
  });

  await test('真实秒数等待中延长间隔，从原等待起点重算截止时间', async () => {
    const f = await fixture({ realTime: true });
    try {
      await f.configure({ reconnectEnabled: true, baseDelaySeconds: 1 });
      await f.api('connect', {});
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'waiting', '真实一秒等待');
      const start = f.session().loginRecovery.waitStartedAt;
      await f.configure({ baseDelaySeconds: 2 });
      assert.equal(f.session().loginRecovery.waitStartedAt, start);
      assert.equal(f.session().loginRecovery.nextAttemptAt, start + 2000);
      await sleep(Math.max(1, start + 1200 - Date.now()));
      assert.equal(f.state.logins, 1, '不能按修改前的一秒提前登录');
      await waitFor(() => f.state.logins === 2 && f.session().loginRecovery === null, '按两秒截止恢复');
      assert(f.state.loginTimes[1] >= start + 1900);
    } finally { await f.close(); }
  });

  await test('真实秒数等待中缩短间隔，立即更新截止时间并唤醒旧等待', async () => {
    const f = await fixture({ realTime: true });
    try {
      await f.configure({ reconnectEnabled: true, baseDelaySeconds: 3 });
      await f.api('connect', {});
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'waiting', '真实三秒等待');
      const start = f.session().loginRecovery.waitStartedAt;
      await sleep(180);
      await f.configure({ baseDelaySeconds: 1 });
      assert.equal(f.session().loginRecovery.nextAttemptAt, start + 1000);
      await waitFor(() => f.state.logins === 2 && f.session().loginRecovery === null, '按新一秒截止恢复', 2300);
      assert(f.state.loginTimes[1] < start + 2500);
    } finally { await f.close(); }
  });

  await test('全天深夜配置采用深夜间隔并正确计算随机抖动和一秒下限', async () => {
    const f = await fixture({ realTime: true });
    const random = Math.random, realNow = Date.now;
    try {
      Math.random = () => 0;
      await f.configure({ reconnectEnabled: true, baseDelaySeconds: 30, jitterSeconds: 3,
        deep: { enabled: true, start: '00:00', end: '00:00', delaySeconds: 7 } });
      await f.api('connect', {});
      const frozenNow = realNow();
      Date.now = () => frozenNow;
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'waiting', '深夜等待');
      const start = f.session().loginRecovery.waitStartedAt;
      assert.equal(f.session().loginRecovery.nextAttemptAt, start + 4000);
      for (const [sample, quietDelay, expectedDelay] of [[0.5, 8, 8000], [0.999, 9, 12000], [0, 1, 1000]]) {
        Math.random = () => sample;
        await f.configure({ baseDelaySeconds: 30, jitterSeconds: 3,
          deep: { enabled: true, start: '00:00', end: '00:00', delaySeconds: quietDelay } });
        assert.equal(f.session().loginRecovery.waitStartedAt, start);
        assert.equal(f.session().loginRecovery.nextAttemptAt, start + expectedDelay);
        assert.equal(f.saved().loginRecovery.nextAttemptAt, start + expectedDelay);
      }
      assert.equal(f.state.logins, 1);
    } finally { Math.random = random; Date.now = realNow; await f.close(); }
  });

  await test('等待中降低最大次数，在下一次实际登录前执行新上限', async () => {
    const f = await fixture({ delay: 350 });
    try {
      await f.configure({ reconnectEnabled: true, maxRetries: 3 });
      await f.api('connect', {});
      f.state.failures = 1;
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'waiting' && f.session().loginRecovery.attempts === 1, '第二次重试前等待');
      await f.configure({ maxRetries: 1 });
      await waitFor(() => f.session().loginRecovery?.status === 'exhausted', '最新次数上限生效');
      await sleep(400);
      assert.equal(f.state.logins, 2, '初次登录和一次重试后停止');
    } finally { await f.close(); }
  });

  await test('等待中关闭重连立即停止，重新开启后重新安排恢复', async () => {
    const f = await fixture({ delay: 220 });
    try {
      await f.configure({ reconnectEnabled: true });
      await f.api('connect', {});
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'waiting', '关闭前等待');
      await f.configure({ reconnectEnabled: false });
      assert.equal(f.session().loginRecovery.status, 'disabled');
      await sleep(300);
      assert.equal(f.state.logins, 1);
      await f.configure({ reconnectEnabled: true });
      await waitFor(() => f.state.logins === 2 && f.session().loginRecovery === null, '重新开启后恢复');
    } finally { await f.close(); }
  });

  await test('关闭自动重连时挂机被顶号，随后开启配置恢复连接并继续挂机', async () => {
    const f = await fixture({ delay: 220 });
    try {
      await f.configure({ reconnectEnabled: false });
      await f.api('loop/start', { rounds: 0, everySeconds: 3600 });
      await waitFor(() => f.session().loop.completed === 1, '关闭重连的首轮完成');
      drop(f.session().client);
      await waitFor(() => !f.session().loop.running, '顶号后挂机停止');
      assert.equal(f.session().loginRecovery.status, 'disabled');
      await f.configure({ reconnectEnabled: true });
      await waitFor(() => f.state.logins === 2 && f.session().loginRecovery === null, '设置开启后账号恢复');
      assert.equal(f.session().client.connected, true);
      assert.equal(f.session().loop.running, true);
      assert.equal(f.session().loop.completed, 1);
      assert.equal(f.saved().autoStart, true);
    } finally { await f.close(); }
  });

  await test('删除等待恢复的账号后退出恢复任务并保持HTTP可响应', async () => {
    const f = await fixture({ delay: 220 });
    try {
      await f.configure({ reconnectEnabled: true });
      await f.api('connect', {});
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'waiting', '删除前等待');
      const removed = f.session(), recoveryJob = removed.loginRecoveryJob;
      await f.api('accounts/remove', { id: f.id });
      await recoveryJob;
      assert.equal(f.session(), undefined);
      assert.equal(f.saved(), undefined);
      assert.equal(removed.loginRecoveryJob, null);
      await sleep(300);
      assert.equal(f.state.logins, 1);
      assert.equal((await f.response('accounts')).status, 200);
    } finally { await f.close(); }
  });

  await test('重连初始化尾段再次顶号仍计入同轮重试并重新等待', async () => {
    const f = await fixture({ delay: 220 });
    try {
      await f.configure({ reconnectEnabled: true, maxRetries: 3 });
      await f.api('connect', {});
      const ledger = createUsageLedger(f.id);
      ledger.reserve({ diamonds: 4 }, {}, {}, { uniqueKey: 'world-boss:9001:fixture',
        details: { kind: 'worldBoss', buildingId: '1远征船', active: true } });
      const before = ledger.keyRecords();
      f.state.kickOnFleet = 1;
      drop(f.session().client);
      await waitFor(() => f.state.logins === 2 && f.session().loginRecovery?.status === 'waiting', '初始化尾段顶号后继续等待');
      assert.equal(f.session().loginRecovery.attempts, 1);
      assert.equal(f.session().loginBlocked, true);
      assert.equal((await f.response('overview')).status, 400);
      await waitFor(() => f.state.logins === 3 && f.session().loginRecovery === null, '再次恢复成功');
      assert.equal(f.session().client.connected, true);
      assert.equal(f.session().loginBlocked, false);
      assert.deepEqual(ledger.keyRecords(), before);
    } finally { await f.close(); }
  });

  for (const [route, body] of [['accounts/pause', { paused: true }], ['disconnect', {}], ['loop/stop', {}]]) {
    await test(route + '取消账号重连等待且重启后保持取消', async () => {
      const f = await fixture({ delay: 1500 });
      try {
        await f.configure({ reconnectEnabled: true });
        await f.api('connect', {});
        drop(f.session().client);
        await waitFor(() => f.session().loginRecovery?.status === 'waiting', '取消前等待');
        await f.api(route, body);
        assert.equal(f.saved().loginRecovery.status, 'cancelled');
        await f.stopApp();
        await f.launch();
        await sleep(1580);
        assert.equal(f.state.logins, 1);
        assert.equal(f.session().loginRecovery.status, 'cancelled');
      } finally { await f.close(); }
    });
  }

  await test('登录中暂停、断开、停止或关开关均中断旧连接，重新恢复可正常上线', async () => {
    for (const route of ['accounts/pause', 'disconnect', 'loop/stop', 'login-settings']) {
      const f = await fixture(), gate = deferred();
      try {
        await f.configure({ reconnectEnabled: true });
        await f.api('connect', {});
        const records = f.makePending();
        f.state.loginGate = gate;
        drop(f.session().client);
        await waitFor(() => f.state.logins === 2 && f.session().loginRecovery?.status === 'connecting', '重登请求进行中');
        const cancelledClient = f.session().client;
        if (route === 'login-settings') await f.configure({ reconnectEnabled: false });
        else await f.api(route, route === 'accounts/pause' ? { paused: true } : {});
        await waitFor(() => !f.session().loginRecoveryJob, '恢复请求退出');
        assert.equal(f.session().loginRecovery.status, route === 'login-settings' ? 'disabled' : 'cancelled', route);
        assert.deepEqual(f.pending(), records, route);
        assert.equal(cancelledClient.stopping, true, route);
        assert.equal(cancelledClient.closeReason, 'stopped', route);
        assert.equal(cancelledClient.connected, false, route);
        assert.equal(f.session().client?.connected ?? false, false, route);
        gate.resolve();
        f.state.loginGate = null;
        await sleep(200);
        assert.equal(f.state.logins, 2, route + '取消后不会继续登录');
        assert.equal(f.state.events.filter(name => name === 'LoginFinishRequest').length, 1, route);
        if (route === 'login-settings') await f.configure({ reconnectEnabled: true });
        else {
          if (route === 'accounts/pause') await f.api('accounts/pause', { paused: false });
          await f.api('connect', {});
        }
        await waitFor(() => f.state.logins === 3 && f.session().loginRecovery === null, route + '重新恢复');
        assert.equal(f.session().client.connected, true, route);
        assert.equal(f.pending().length, 0, route);
      } finally { gate.resolve(); await f.close(); }
    }
  });

  await test('同一服务的两个账号独立恢复，暂停一个账号保留其生产占用和预算', async () => {
    const f = await fixture({ delay: 1500 }), second = addFakeAccount();
    try {
      await f.configure({ reconnectEnabled: true });
      await f.configure({ reconnectEnabled: false }, second.id);
      await f.api('connect', {});
      await f.api('connect', {}, second.id);
      f.makePending();
      beginOrderMaterialSpend(second.player, [{ id: '小麦种子', have: 10, need: 1 }], '第二账号未知播种',
        { farm: { args: [{ buildingId: '1农田', productId: '小麦' }] } });
      const pendingSecond = pendingFarmMaterialSpends(second.player);
      const ledger = createUsageLedger(second.id);
      ledger.reserve({ diamonds: 4 }, {}, {}, { uniqueKey: 'second-account-unknown' });
      const budget = ledger.keyRecords();
      drop(f.session().client);
      drop(f.session(second.id).client);
      const deadline = f.session().loginRecovery.nextAttemptAt;
      assert.equal(f.session(second.id).loginRecovery.status, 'disabled');
      await f.api('accounts/pause', { paused: true }, second.id);
      assert.equal(f.session().loginRecovery.status, 'waiting');
      assert.equal(f.session().loginRecovery.nextAttemptAt, deadline);
      await waitFor(() => f.state.logins === 2 && f.session().loginRecovery === null, '第一个账号独立恢复');
      assert.equal(f.pending().length, 0);
      assert.equal(second.state.logins, 1);
      assert.equal(f.session(second.id).paused, true);
      assert.equal(f.session(second.id).loginRecovery.status, 'cancelled');
      assert.deepEqual(pendingFarmMaterialSpends(second.player), pendingSecond);
      assert.deepEqual(ledger.keyRecords(), budget);
      assert.equal(f.session().client.connected, true);
    } finally {
      await f.api('accounts/remove', { id: second.id });
      await f.close();
    }
  });

  await test('服务器拒绝登录后停止账号恢复并保留登录保护', async () => {
    const f = await fixture();
    try {
      await f.configure({ reconnectEnabled: true });
      await f.api('connect', {});
      f.state.loginError = Object.assign(new Error('login rejected'), { loginResponse: { result: 1 }, recoverable: false });
      drop(f.session().client);
      await waitFor(() => f.session().loginRecovery?.status === 'failed', '拒绝登录终止');
      assert.equal(f.state.logins, 2);
      assert.equal(f.session().loginBlocked, true);
      assert.equal((await f.response('overview')).status, 400);
    } finally { await f.close(); }
  });

  console.log('账号异地登录恢复专项 ' + passed + '/' + passed + ' 通过');
} finally {
  for (const state of states.values()) {
    state.waterGate?.resolve();
    state.loginGate?.resolve();
  }
  for (const app of apps) await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
