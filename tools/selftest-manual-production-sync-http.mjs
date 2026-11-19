// 手动接管后的同步接口：真实 HTTP，隔离账号、假游戏连接，不访问真实账号。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-manual-production-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([
  [0, 'ModuleOpenCfg', { data: [{ moduleId: '英雄装备', playerLevel: 16 }] }],
  [1, 'TrialRaidCfg', { data: [] }],
]));
const { GameClient } = await import('../src/client.mjs');
const { saveStore, loadStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { beginOrderMaterialSpend, pendingOrderMaterialSpends, pendingFarmMaterialSpends } = await import('../src/order-reservations.mjs');
const { factoryProductionOperation } = await import('../src/spend-evidence.mjs');
const { createUsageLedger } = await import('../src/automation-settings.mjs');

const live = new Set(), states = new Map(), apps = new Set();
let sequence = 0, passed = 0;
const water = () => ({ building: [
  { buildingId: '1厨房', level: 1, factory: { factoryQ: [], finishedProducts: [] } },
  { buildingId: '1农田', level: 1, farm: {} },
  { buildingId: '1装备厂', level: 1, auto: false },
] });
Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function (login) {
  this.fixture = states.get(login.fixtureId);
  this.fixture.logins++; this.fixture.clients.push(this); this.stopping = false;
  this.connectionEpoch++;
  this.fixture.events.push('login'); live.add(this);
  return { result: 0, playerInfo: this.fixture.player };
};
GameClient.prototype.send = function (name) {
  this.fixture.sends.push(name);
  assert.equal(name, 'LoginFinishRequest', '同步不能发送生产、领取或其他消费请求');
};
GameClient.prototype.sendWatch = async function (name) { assert.fail('不应发送写请求：' + name); };
GameClient.prototype.request = async function (name) {
  // 保留真实只读门控，覆盖登录同步与并发页面读取之间的等待关系。
  if (this.heldByRead()) {
    await this.readGate;
    return this.request(name);
  }
  const state = this.fixture;
  state.requests.push(name); state.events.push(name);
  if (name === 'OnWaterRequest') {
    await state.readGate?.promise;
    if (state.readError) throw new Error('离线读取失败');
    return structuredClone(state.water);
  }
  if (name === 'AllItemRequest') {
    if (state.networkOnInventory > 0) {
      state.networkOnInventory--;
      this.closeReason = 'network'; live.delete(this); this.emit('close', { reason: 'network' });
      throw new Error('游戏连接已断开');
    }
    if (state.inventoryError) throw new Error('库存读取失败');
    return { items: [{ itemId: '生鱼片', num: 9 }, { itemId: '小麦种子', num: 9 }] };
  }
  if (name === 'EquipsRequest') {
    if (state.equipmentError) throw new Error('装备库存读取失败');
    return { equip: [] };
  }
  if (name === 'AllResourceRequest') {
    if (state.resourcesError) throw new Error('资源库存读取失败');
    return { list: [{ res: 3, amount: 100000 }] };
  }
  if (name === 'EmailBoxRequest') return { email: [] };
  return {};
};
GameClient.prototype.stop = function () { this.stopping = true; live.delete(this); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function waitFor(check, label) {
  for (let i = 0; i < 300; i++) { if (check()) return; await sleep(10); }
  assert.fail('等待超时：' + label);
}
async function fixture() {
  const id = 'manual-sync-' + ++sequence;
  const player = { playerId: 700000 + sequence, worldId: 9001, level: 5, nickname: '手动同步离线测试' };
  const state = { player, logins: 0, clients: [], events: [], requests: [], sends: [], water: water() };
  states.set(id, state);
  const store = loadStore();
  store.accounts.push({ id, url: 'ws://invalid.invalid', login: { fixtureId: id }, automation: { enabled: false,
    tasks: Object.fromEntries(automationTasks.map(task => [task.key, task.key === 'mail'])) } });
  store.activeId = id; saveStore(store);
  let app = createConsole({ port: 0, recoveryDelayMs: () => 25 }); apps.add(app);
  let root = await app.listen();
  const response = async (route, body = null) => {
    const result = await fetch(root + '/api/' + route + '?account=' + id, { ...(body === null ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(6000) });
    return { status: result.status, data: await result.json() };
  };
  const api = async (route, body = null) => {
    const result = await response(route, body);
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
  };
  await api('accounts');
  const session = () => app.sessions.get(id);
  const saved = () => loadStore().accounts.find(account => account.id === id).automation;
  const pending = () => [...pendingOrderMaterialSpends(player), ...pendingFarmMaterialSpends(player)];
  const makePending = () => {
    const operation = factoryProductionOperation(water(), '1厨房', { sealed: true, attempted: [{ body: { productId: '鱼汤' } }] });
    beginOrderMaterialSpend(player, [{ id: '生鱼片', have: 10, need: 1 }], '手动操作前排产', { operation });
    beginOrderMaterialSpend(player, [{ id: '小麦种子', have: 10, need: 1 }], '手动操作前播种', { farm: { args: [{ buildingId: '1农田', productId: '小麦' }] } });
    return pending();
  };
  const makeForge = ({ confirmed = false } = {}) => {
    const ledger = createUsageLedger(id);
    const key = 'forge:' + player.worldId + ':1';
    const now = Math.floor(Date.now() / 1000);
    const ticket = ledger.reserve({ forgeStarts: 1, forgeGold: 2000 }, {}, {}, {
      uniqueKey: key,
      details: {
        kind: 'forgeStart', buildingId: '1装备厂', makeId: 1001,
        playerId: String(player.playerId), worldId: String(player.worldId),
        beforeFinishTime: 0, beforeUids: [], sentAt: now - 60, finishTime: now - 1,
        costs: [{ id: 'GOLD', num: 2000 }, { id: '蓝武器材料', num: 40 }],
      },
    });
    if (confirmed) ledger.confirm(ticket);
    return { ledger, key, ticket, record: ledger.keyRecords()[key], budget: ledger.snapshot().counters };
  };
  const close = async () => {
    state.readGate?.resolve();
    const job = session().loop.job;
    await app.close(); await job; apps.delete(app);
  };
  const restart = async () => {
    await close();
    app = createConsole({ port: 0, recoveryDelayMs: () => 25 }); apps.add(app);
    root = await app.listen();
    await api('accounts');
  };
  return { id, state, get app() { return app; }, api, response, session, saved, pending, makePending, makeForge, close, restart };
}
function assertForgeSynchronized(forge) {
  assert.equal(forge.ledger.hasKey(forge.key), false, '当前工厂应释放旧阻塞记录');
  assert.deepEqual(forge.ledger.snapshot().counters, forge.budget, '同步保留原锻造用量');
  const history = forge.ledger.keyRecords()['forgeHistory:' + forge.ticket.id];
  if (forge.record.confirmed) {
    assert.equal(history, undefined);
    assert.equal(forge.ledger.confirmedCounters().forgeGold, 2000);
    assert.equal(forge.ledger.pendingCounters().forgeGold ?? 0, 0);
  } else {
    assert.equal(history.id, forge.record.id);
    assert.equal(history.confirmed, false);
    assert.equal(history.details.archivedFrom, forge.key);
    assert.equal(history.details.disposition, 'manual-handoff-sync');
    assert.equal(forge.ledger.pendingCounters().forgeGold, 2000);
    assert.equal(forge.ledger.pendingCounters().forgeStarts, 1);
    assert.equal(forge.ledger.confirmedCounters().forgeGold ?? 0, 0);
  }
}
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
saveStore({ activeId: null, accounts: [] });
try {
  await test('恢复托管自动等待旧操作退出再同步手动生产，不增加额外点击且预算不变', async () => {
    const f = await fixture(), gate = deferred();
    try {
      await f.api('connect', {});
      const oldClient = f.session().client;
      const ledger = createUsageLedger(f.id);
      ledger.reserve({ diamonds: 3 }, {}, {}, { uniqueKey: 'unconfirmed-manual-handoff' });
      const budget = ledger.keyRecords();
      f.session().queueTail = gate.promise.then(() => { f.makePending(); f.state.events.push('old-finished'); });
      await f.api('accounts/pause', { paused: true });
      assert.equal(f.saved().productionSyncRequired, true);
      await f.api('accounts/pause', { paused: false });
      const pending = f.response('connect', {});
      await waitFor(() => f.session().syncingProduction, '自动开始同步');
      assert.equal(f.session().paused, false);
      assert.equal(oldClient.connected, false);
      assert.equal(f.state.logins, 1, '旧操作未退出不能登录新会话');
      assert.equal((await f.response('loop/start', { confirm: true })).status, 400, '同步中不能提前发送经营请求');
      gate.resolve();
      const result = await pending;
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(f.state.logins, 2);
      assert(f.state.events.indexOf('old-finished') < f.state.events.lastIndexOf('login'));
      assert(f.state.events.lastIndexOf('login') < f.state.events.indexOf('OnWaterRequest'));
      assert.equal(f.pending().length, 0);
      assert.equal(f.session().paused, false); assert.equal(f.session().loop.running, false);
      assert.equal(f.session().syncingProduction, null);
      assert.equal(f.saved().productionSyncRequired, false);
      assert.equal(f.saved().enabled, false); assert.equal(f.saved().paused, false);
      assert.deepEqual(ledger.keyRecords(), budget, '同步不能核销未知预算');
    } finally { gate.resolve(); await f.close(); }
  });

  await test('库存读取失败保留全部旧记录和同步屏障，后续页面读取自动重试', async () => {
    const f = await fixture();
    try {
      const records = f.makePending(); f.state.inventoryError = true;
      await f.api('accounts/pause', { paused: true });
      await f.api('accounts/pause', { paused: false });
      const result = await f.response('connect', {});
      assert.equal(result.status, 400);
      assert.deepEqual(f.pending(), records);
      assert.equal(f.saved().productionSyncRequired, true);
      assert.equal(f.saved().enabled, false); assert.equal(f.session().client.connected, false);
      assert.deepEqual(f.state.sends, ['LoginFinishRequest']);
      assert.equal(f.session().syncingProduction, null);
      f.state.inventoryError = false;
      await f.api('overview');
      assert.equal(f.pending().length, 0);
      assert.equal(f.saved().productionSyncRequired, false);
    } finally { await f.close(); }
  });

  await test('主动断开后自行操作，再连接时同样自动同步生产状态', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      f.makePending();
      await f.api('disconnect', {});
      assert.equal(f.saved().productionSyncRequired, true);
      await f.api('connect', {});
      assert.equal(f.state.logins, 2);
      assert.equal(f.pending().length, 0);
      assert.equal(f.saved().productionSyncRequired, false);
      assert.equal(f.session().loop.running, false);
    } finally { await f.close(); }
  });

  await test('暂停恢复托管通过新登录同步锻造，未知结果归档且已确认记录释放并保留预算', async () => {
    for (const confirmed of [false, true]) {
      const f = await fixture();
      try {
        await f.api('connect', {});
        const oldClient = f.session().client;
        const forge = f.makeForge({ confirmed });
        await f.api('accounts/pause', { paused: true });
        assert.equal(f.saved().productionSyncRequired, true);
        await f.api('accounts/pause', { paused: false });
        await f.api('connect', {});

        assert.equal(f.state.logins, 2);
        assert.notEqual(f.session().client, oldClient);
        assert.equal(oldClient.connected, false);
        assert.equal(f.saved().productionSyncRequired, false);
        assert.equal(f.session().productionSyncRequired, false);
        assert.equal(f.session().loop.running, false);
        assert(f.state.requests.includes('EquipsRequest'));
        assert(f.state.requests.includes('AllResourceRequest'));
        assertForgeSynchronized(forge);
        assert.deepEqual(f.state.sends, ['LoginFinishRequest', 'LoginFinishRequest']);
      } finally { await f.close(); }
    }
  });

  await test('装备或金币读取失败保留锻造记录与同步标记，页面读取自动重新登录重试', async () => {
    for (const errorField of ['equipmentError', 'resourcesError']) {
      const f = await fixture();
      try {
        const forge = f.makeForge();
        const records = forge.ledger.keyRecords();
        f.state[errorField] = true;
        await f.api('accounts/pause', { paused: true });
        await f.api('accounts/pause', { paused: false });
        const response = await f.response('connect', {});
        assert.equal(response.status, 400);
        assert.deepEqual(forge.ledger.keyRecords(), records);
        assert.deepEqual(forge.ledger.snapshot().counters, forge.budget);
        assert.equal(forge.ledger.pendingCounters().forgeGold, 2000);
        assert.equal(f.saved().productionSyncRequired, true);
        assert.equal(f.session().productionSyncRequired, true);
        assert.equal(f.session().client.connected, false);
        assert.equal(f.session().syncingProduction, null);
        assert.deepEqual(f.state.sends, ['LoginFinishRequest']);

        f.state[errorField] = false;
        await f.api('overview');
        assert.equal(f.state.logins, 2);
        assert.equal(f.saved().productionSyncRequired, false);
        assert.equal(f.session().client.connected, true);
        assertForgeSynchronized(forge);
        assert.deepEqual(f.state.sends, ['LoginFinishRequest', 'LoginFinishRequest']);
      } finally { await f.close(); }
    }
  });

  await test('待同步锻造标记持久保存，控制台重建后连接自动恢复且预算仍保留', async () => {
    for (const confirmed of [false, true]) {
      const f = await fixture();
      try {
        await f.api('connect', {});
        const forge = f.makeForge({ confirmed });
        await f.api('accounts/pause', { paused: true });
        await f.api('accounts/pause', { paused: false });
        const previousSession = f.session();
        assert.equal(f.saved().productionSyncRequired, true);
        await f.restart();
        assert.notEqual(f.session(), previousSession);
        assert.equal(f.session().productionSyncRequired, true);
        assert.equal(f.saved().productionSyncRequired, true);
        assert.equal(createUsageLedger(f.id).hasKey(forge.key), true);

        await f.api('connect', {});
        assert.equal(f.state.logins, 2);
        assert.equal(f.saved().productionSyncRequired, false);
        assert.equal(f.session().syncingProduction, null);
        assertForgeSynchronized(forge);
        assert.deepEqual(f.state.sends, ['LoginFinishRequest', 'LoginFinishRequest']);
      } finally { await f.close(); }
    }
  });

  await test('顶号后明确连接已通过认证，仅同步读失败时允许页面重试且始终保留写屏障', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      const records = f.makePending(), client = f.session().client;
      client.closeReason = 'kicked'; live.delete(client); client.emit('fatal', { reason: 'SCChannelExpired' }); client.emit('close', { reason: 'kicked' });
      assert.equal(f.session().loginBlocked, true);
      f.state.inventoryError = true;
      assert.equal((await f.response('connect', {})).status, 400);
      assert.deepEqual(f.pending(), records);
      assert.equal(f.session().productionSyncRequired, true);
      assert.equal(f.session().loginBlocked, false, '明确授权且认证成功后可自动重试同步');
      assert.equal(f.session().client.connected, false, '未同步完整时不能保持可写连接');
      assert.deepEqual(f.state.sends, ['LoginFinishRequest', 'LoginFinishRequest']);
      f.state.inventoryError = false;
      await f.api('overview');
      assert.equal(f.state.logins, 3);
      assert.equal(f.pending().length, 0);
      assert.equal(f.saved().productionSyncRequired, false);
    } finally { await f.close(); }
  });

  await test('游戏顶号后明确恢复连接自动同步锻造，旧未知用量保持待确认', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      const forge = f.makeForge(), client = f.session().client;
      client.closeReason = 'kicked'; live.delete(client);
      client.emit('fatal', { reason: 'SCChannelExpired' }); client.emit('close', { reason: 'kicked' });
      assert.equal(f.session().loginBlocked, true);
      assert.equal(f.saved().productionSyncRequired, true);
      assert.equal(forge.ledger.hasKey(forge.key), true);

      await f.api('connect', {});
      assert.equal(f.state.logins, 2);
      assert.equal(f.session().loginBlocked, false);
      assert.equal(f.saved().productionSyncRequired, false);
      assertForgeSynchronized(forge);
      assert.deepEqual(f.state.sends, ['LoginFinishRequest', 'LoginFinishRequest']);
    } finally { await f.close(); }
  });

  await test('等待旧操作或读取新状态时再次暂停及断开均取消同步，旧记录保持原样', async () => {
    for (const phase of ['drain', 'read']) for (const cancel of ['accounts/pause', 'disconnect']) {
      const f = await fixture(), gate = deferred();
      try {
        const records = f.makePending();
        const forge = f.makeForge();
        const forgeRecords = forge.ledger.keyRecords();
        if (phase === 'drain') f.session().queueTail = gate.promise;
        else f.state.readGate = gate;
        await f.api('accounts/pause', { paused: true });
        await f.api('accounts/pause', { paused: false });
        const pending = f.response('connect', {});
        await waitFor(() => phase === 'drain' ? f.session().syncingProduction : f.state.requests.includes('OnWaterRequest'), phase);
        await f.api(cancel, cancel === 'accounts/pause' ? { paused: true } : {});
        gate.resolve();
        const result = await pending;
        assert.equal(result.status, 400, phase + cancel);
        assert.deepEqual(f.pending(), records);
        assert.deepEqual(forge.ledger.keyRecords(), forgeRecords);
        assert.deepEqual(forge.ledger.snapshot().counters, forge.budget);
        assert.equal(f.session().paused, cancel === 'accounts/pause');
        assert.equal(f.saved().productionSyncRequired, true);
        assert.equal(f.saved().enabled, false);
        assert.equal(f.session().client, null);
        assert.equal(f.state.logins, phase === 'drain' ? 0 : 1);
      } finally { gate.resolve(); await f.close(); }
    }
  });

  await test('普通网络自动恢复不触发手动同步，不清除旧生产记录', async () => {
    const f = await fixture();
    try {
      const records = f.makePending();
      const forge = f.makeForge();
      const forgeRecords = forge.ledger.keyRecords();
      await f.api('loop/start', { confirm: true, rounds: 0, everySeconds: 3600 });
      await waitFor(() => f.session().loop.completed === 1, '首轮完成');
      const client = f.session().client;
      client.closeReason = 'network'; live.delete(client); client.emit('close', { reason: 'network' });
      await waitFor(() => f.state.logins === 2 && f.session().loop.completed === 2, '网络恢复');
      assert.deepEqual(f.pending(), records);
      assert.deepEqual(forge.ledger.keyRecords(), forgeRecords, '普通网络恢复必须保留原工厂锻造锁');
      assert.deepEqual(forge.ledger.snapshot().counters, forge.budget);
      assert.equal(forge.ledger.pendingCounters().forgeGold, 2000);
      assert.equal(f.state.requests.includes('OnWaterRequest'), false, '仅开启邮件不应读取基地同步状态');
      assert.equal(f.session().syncingProduction, null);
      await f.api('loop/stop', { confirm: true });
    } finally { await f.close(); }
  });
  await test('同步期间并发总览和队列只读查询不会建立相互等待的读取门', async () => {
    for (const route of ['overview', 'trials']) {
      const f = await fixture(), gate = deferred();
      try {
        f.makePending(); f.state.readGate = gate;
        await f.api('accounts/pause', { paused: true });
        await f.api('accounts/pause', { paused: false });
        const first = f.response('equipment');
        await waitFor(() => f.state.requests.includes('OnWaterRequest'), '排队读取触发生产同步');
        const firstQueue = f.session().queueTail;
        const second = f.response(route);
        const completed = Promise.all([first, second]);
        completed.catch(() => {});
        await waitFor(() => route === 'overview' ? f.session().overviewRead : f.session().queueTail !== firstQueue, '并发查询已进入处理');
        assert.equal(f.session().client.readGate, null, '初始化尚未完成，不能用只读门等待同一个连接');
        gate.resolve();
        const results = await completed;
        for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.data));
        assert(f.state.requests.includes('AllItemRequest'), '同步后续库存读取应立即继续');
        assert.equal(f.saved().productionSyncRequired, false);
        assert.equal(f.session().client.readGate, null);
        assert.equal(f.state.logins, 1, '并发查询共用同一个初始化过程');
      } finally { gate.resolve(); await f.close(); }
    }
  });
  await test('已授权顶号恢复自动同步，读取中再次网络掉线也自动重试，不自等待loop.job', async () => {
    const f = await fixture();
    try {
      const records = f.makePending();
      const login = await f.api('login-settings');
      await f.api('login-settings', { revision: login.revision, settings: { ...login.settings, reconnectEnabled: true } });
      await f.api('loop/start', { confirm: true, rounds: 0, everySeconds: 3600 });
      await waitFor(() => f.session().loop.completed === 1, '首轮完成');
      assert.deepEqual(f.pending(), records);
      f.state.networkOnInventory = 1;
      const client = f.session().client;
      client.closeReason = 'kicked'; live.delete(client); client.emit('fatal', { reason: 'SCChannelExpired' }); client.emit('close', { reason: 'kicked' });
      await waitFor(() => f.state.logins === 3 && f.session().loop.completed === 2, '同步读断线后再次恢复');
      assert.equal(f.pending().length, 0);
      assert.equal(f.saved().productionSyncRequired, false);
      assert.equal(f.session().loop.running, true);
      assert.equal(f.session().syncingProduction, null);
      await f.api('loop/stop', { confirm: true });
    } finally { await f.close(); }
  });
  console.log('手动生产同步 HTTP 专项 ' + passed + '/' + passed + ' 通过');
} finally {
  for (const state of states.values()) state.readGate?.resolve();
  for (const app of apps) await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
