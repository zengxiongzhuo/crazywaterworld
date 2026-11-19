import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-wechat-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_CA_DIR = path.join(directory, 'certificates');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { createConsole } = await import('./fixtures/console-server.mjs');
const { loadStore, saveStore, upsertAccount, loginAccountId } = await import('../src/accounts.mjs');
const { GameClient } = await import('../src/client.mjs');
const originalMethods = Object.fromEntries(['connect', 'request', 'send', 'sendWatch', 'stop', 'connected', 'interleaveRead']
  .map(name => [name, Object.getOwnPropertyDescriptor(GameClient.prototype, name)]));
const liveClients = new Set();
const connections = [];
const reads = [];
const roleFailures = new Set();
const roleGates = new Map();
const defaultRoles = [
  { worldId: 3000000001, roleInfo: { id: 11, nickname: '海风船长', level: 28, power: 12345, worldId: 3000000010 } },
  { worldId: 3000000002, roleInfo: { id: 12, nickname: '星海船长', level: 42, power: 23456, worldId: 3000000002 } },
  { worldId: 4000000003, roleInfo: { id: { low: 2, high: 2097152, unsigned: false }, nickname: '灯塔守望', level: 50, power: 34567, worldId: 4000000003 } },
  { worldId: 3000000004 },
  { worldId: 3000000005, roleInfo: { id: 0, nickname: '空角色' } },
  { worldId: 3000000002, roleInfo: { id: 12, nickname: '重复角色' } },
];
const roleLists = new Map();
Object.defineProperty(GameClient.prototype, 'connected', { configurable: true, get() { return liveClients.has(this); } });
GameClient.prototype.connect = async function (login) {
  assert.equal(this.url, 'wss://fixture.invalid/gateway');
  this.login = login;
  this.stopping = false;
  connections.push({ client: this, login });
  liveClients.add(this);
  const roles = roleLists.get(login.eworldParams.openId) ?? defaultRoles;
  const role = (roles.find(row => row.worldId === login.worldId) ?? roles[0])?.roleInfo;
  return { result: 0, playerInfo: role && { ...role, playerId: role.id, nickname: role.nickname || '未命名角色' } };
};
GameClient.prototype.send = () => {};
GameClient.prototype.sendWatch = async () => ({});
GameClient.prototype.request = async function (name) {
  if (name === 'OnWaterRequest') return { building: [] };
  if (name === 'AllItemRequest') return { items: [] };
  if (name === 'EmailBoxRequest') return { email: [] };
  if (name !== 'GameWorldListRequest') return {};
  const id = this.login.eworldParams.openId;
  reads.push({ client: this, id });
  const gate = roleGates.get(id);
  if (gate) {
    gate.started.resolve();
    try {
      await new Promise((resolve, reject) => {
        this.cancelRoleRead = reject;
        gate.done.promise.then(resolve, reject);
      });
    } finally {
      this.cancelRoleRead = null;
    }
  }
  if (roleFailures.has(id)) throw new Error('模拟角色列表读取失败');
  return { recentWorlds: structuredClone(roleLists.get(id) ?? defaultRoles), latestGroupId: 1 };
};
GameClient.prototype.stop = function () {
  this.stopping = true;
  this.stopCount = (this.stopCount || 0) + 1;
  liveClients.delete(this);
  this.cancelRoleRead?.(new Error('角色列表读取已取消'));
};
GameClient.prototype.interleaveRead = async function (work) { return work(); };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function holdRoles(id) {
  const gate = { started: deferred(), done: deferred() };
  roleGates.set(id, gate);
  return gate;
}

function credential(openId = 'fixture-wechat-open-id', token = 'fixture-wechat-token') {
  return {
    source: 'wechat',
    capturedAt: new Date().toISOString(),
    url: 'wss://fixture.invalid/gateway',
    loginFrameHex: 'aabbccdd',
    login: {
      worldId: 3000000002,
      eworldParams: { openId, token, sign: 'fixture-wechat-sign', timestamp: '1234567890' },
      eworldClientInfo: { appId: 'fixture-wechat-app' },
    },
  };
}

function createController() {
  let current = null;
  const controller = {
    starts: 0,
    cancellations: 0,
    reads: 0,
    closes: 0,
    startError: null,
    startGate: null,
    startEntered: null,
    cancelError: null,
    async start() {
      controller.starts++;
      if (controller.startError) throw controller.startError;
      current = {
        id: 'fixture-scan-' + controller.starts,
        phase: 'waiting',
        qrImage: 'data:image/png;base64,ZmFrZS1xci1pbWFnZQ==',
        expiresAt: Date.now() + 300_000,
        error: null,
      };
      controller.startEntered?.resolve();
      await controller.startGate?.promise;
      return controller.status();
    },
    status(id) {
      if (id && current?.id !== id) throw new Error('扫码会话已失效，请重新扫码');
      if (!current) return { id: null, phase: 'idle', qrImage: null, expiresAt: null, error: null };
      if (current.expiresAt <= Date.now()) current.phase = 'expired';
      const { credential: capturedCredential, ...publicState } = current;
      return { ...publicState };
    },
    capture(capturedCredential = credential()) {
      assert.ok(current, '先启动扫码会话');
      current.phase = 'captured';
      current.credential = capturedCredential;
      current.qrImage = null;
    },
    expire() {
      assert.ok(current, '先启动扫码会话');
      current.expiresAt = Date.now() - 1;
    },
    setExpiry(expiresAt) { current.expiresAt = expiresAt; },
    takeCredential(id) {
      controller.reads++;
      const state = controller.status(id);
      if (state.phase !== 'captured') throw new Error('扫码结果尚未就绪或已过期，请重新扫码');
      return structuredClone(current.credential);
    },
    async cancel(id) {
      controller.cancellations++;
      if (controller.cancelError) throw controller.cancelError;
      if (!id || current?.id === id) current = null;
      return controller.status();
    },
    async close() {
      controller.closes++;
      current = null;
    },
  };
  return controller;
}

function holdQueue(session) {
  let release;
  let accepted;
  const entered = new Promise(resolve => { accepted = resolve; });
  let tail = new Promise(resolve => { release = resolve; });
  Object.defineProperty(session, 'queueTail', {
    configurable: true,
    get: () => tail,
    set(value) {
      tail = value;
      if (value) accepted();
    },
  });
  return {
    release,
    async wait(request) {
      let timeout;
      try {
        await Promise.race([
          entered,
          request.then(result => { throw new Error('保存未进入账号队列，HTTP ' + result.status); }),
          new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('等待账号保存队列超时')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
    restore() {
      Object.defineProperty(session, 'queueTail', { configurable: true, writable: true, value: null });
    },
  };
}

const controller = createController();
const app = createConsole({
  port: 0,
  protocol: { OnWaterRequest: true, OnWaterResponse: true, AllItemRequest: true, AllItemResponse: true },
  wechatLoginController: controller,
  captureController: { inspectCaptureRecovery: () => ({ pending: false }) },
});
let closed = false;
try {
  const root = await app.listen();
  async function request(route, body) {
    const response = await fetch(root + '/api/accounts/wechat-login' + route, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, data: await response.json() };
  }
  const start = () => request('/start', { confirm: true });
  const status = id => request('/status?id=' + encodeURIComponent(id));
  const save = (id, choiceId) => request('/save', { confirm: true, id, choiceId });
  async function waitForLoop(id, worldId) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const session = app.sessions.get(id);
      if (session?.loop.running && session.loop.completed >= 1 && session.client?.login.worldId === worldId) return session;
      await sleep(10);
    }
    const session = app.sessions.get(id);
    assert.fail('等待微信所选角色自动挂机超时 ' + JSON.stringify({ running: session?.loop.running, completed: session?.loop.completed,
      stopping: session?.loop.controller?.signal.aborted, error: session?.loop.error, login: session?.client?.login.worldId,
      log: session?.log.slice(-8) }));
  }
  async function disconnect(id) {
    const job = app.sessions.get(id)?.loop.job;
    const result = await fetch(root + '/api/disconnect?account=' + encodeURIComponent(id), {
      method: 'POST', body: JSON.stringify({ confirm: true }),
    });
    assert.equal(result.status, 200);
    await job;
  }
  async function preview(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await status(id);
      assert.equal(result.status, 200);
      if (result.data.phase !== 'reading-roles') return result.data;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('等待角色列表超时');
  }
  async function capture(value = credential()) {
    const started = await start();
    assert.equal(started.status, 200);
    controller.capture(value);
    const reading = await status(started.data.id);
    assert.equal(reading.data.phase, 'reading-roles');
    return preview(started.data.id);
  }

  assert.equal((await request('/status')).data.phase, 'idle');
  assert.equal(controller.starts, 0, '查询状态不启动浏览器');
  assert.equal((await request('/start', {})).status, 400);
  assert.equal(controller.starts, 0, '启动沿用写接口确认约定');
  controller.startError = new Error('模拟浏览器启动失败');
  const failedStart = await start();
  assert.equal(failedStart.status, 400);
  assert.match(failedStart.data.error, /模拟浏览器启动失败/);
  controller.startError = null;

  const waiting = await start();
  assert.equal(waiting.status, 200);
  assert.ok(waiting.data.id);
  assert.equal(waiting.data.phase, 'waiting');
  assert.match(waiting.data.qrImage, /^data:image\/png;base64,/);
  assert.equal((await save(waiting.data.id)).status, 400, '扫码完成前不能保存');
  assert.equal(loadStore().accounts.length, 0);
  assert.equal((await request('/cancel', { id: waiting.data.id })).status, 200);
  assert.equal((await save(waiting.data.id)).status, 400, '已取消的扫码结果不能保存');

  // 同名微信身份保留，微信角色使用独立账号 ID。
  const initialStore = loadStore();
  upsertAccount(initialStore, { ...credential(), source: 'mitm' }, { label: '原微信账号' });
  saveStore(initialStore);
  const first = await capture();
  assert.equal(first.phase, 'captured');
  assert.equal(first.choices.length, 3);
  assert.equal(first.choices[0].accountId, 'fixture-wechat-open-id');
  assert.equal(first.choices[0].nickname, '海风船长');
  assert.equal(first.choices[0].worldName, '海港1服');
  assert.equal(first.choices[0].roleWorldName, '海港10服');
  assert.equal(first.choices[2].nickname, '灯塔守望');
  assert.equal(first.choices[2].worldName, '海灯3服');
  assert.equal(first.roleError, null);
  assert.equal(loadStore().accounts.length, 1, '扫码和读取角色均不保存账号');
  assert.equal(liveClients.size, 0, '临时查询客户端完成后关闭');
  assert.equal(connections.at(-1).login.worldId, 0, '保存所选角色前仅登录最近区服读取列表');
  const firstReads = reads.length;
  await status(first.id);
  await status(first.id);
  assert.equal(reads.length, firstReads, '轮询不重复读取已完成的角色列表');
  assert.doesNotMatch(JSON.stringify(first), /fixture-wechat-token|fixture-wechat-sign|eworldParams|loginFrameHex/);
  assert.equal((await request('/save', { id: first.id, choiceId: first.choices[1].id })).status, 400);
  assert.equal((await save(first.id)).status, 400, '多个角色必须选择');
  assert.equal((await save(first.id, 'forged-choice')).status, 400);
  assert.equal((await request('/save', { confirm: true, id: first.id, worldId: 123 })).status, 400);
  assert.equal((await request('/save', { confirm: true, id: first.id, choiceId: first.choices[1].id, worldId: 123 })).status, 400);
  const beforeSaveConnections = connections.length;
  const saved = await save(first.id, first.choices[1].id);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.account.source, 'wechat');
  assert.equal(saved.data.account.active, true);
  assert.equal(saved.data.selectedRole.nickname, '星海船长');
  assert.equal(saved.data.selectedRole.worldId, 3000000002);
  assert.match(saved.data.account.title, /星海船长/);
  assert.match(saved.data.account.title, /海港2服/);
  const idOfAccount = saved.data.account.id;
  assert.equal(loadStore().accounts.find(row => row.id === idOfAccount).automation.autoStart, false);
  assert.equal(app.sessions.get(idOfAccount).loop.running, false);
  assert.equal(connections.length, beforeSaveConnections, '新账号保存后不启动挂机连接');
  const settingsUrl = root + '/api/settings?account=' + encodeURIComponent(idOfAccount);
  const configured = await fetch(settingsUrl).then(response => response.json());
  configured.settings.schedule.mail = true;
  const configuredResponse = await fetch(settingsUrl, {
    method: 'POST', body: JSON.stringify({ settings: configured.settings, revision: configured.revision, baseRevision: configured.baseRevision }),
  });
  assert.equal(configuredResponse.status, 200);
  const started = await fetch(root + '/api/accounts/pause?account=' + encodeURIComponent(idOfAccount), {
    method: 'POST', body: JSON.stringify({ confirm: true, paused: false, start: true }),
  });
  assert.equal(started.status, 200);
  const initialSession = await waitForLoop(idOfAccount, 3000000002);
  assert.equal(connections.length, beforeSaveConnections + 1, '明确开始后连接所选角色');
  assert.equal(initialSession.loop.rounds, 0);
  assert.equal(loadStore().accounts.find(row => row.id === idOfAccount).automation.autoStart, true);
  let store = loadStore();
  assert.equal(store.accounts.length, 3, '微信扫码保留三个区服角色，旧电脑微信记录原位更新');
  assert.equal(new Set(store.accounts.map(loginAccountId)).size, 1, '各区服共用同一微信登录身份');
  assert.equal(store.selectedRoles[loginAccountId(store.accounts[0])], idOfAccount);
  assert.equal(store.activeId, idOfAccount);
  assert.equal(store.accounts.find(account => account.id === 'fixture-wechat-open-id').label, '原微信账号');
  assert.equal(store.accounts.find(account => account.id === idOfAccount).lastSeen.nickname, '星海船长');
  assert.equal((await save(first.id, first.choices[1].id)).status, 400);

  // 第三个角色也可独立选中，刷新扫码后旧 choiceId 失效。
  const third = await capture(credential(undefined, 'third-role-token'));
  assert.equal((await save(third.id, first.choices[2].id)).status, 400);
  const thirdSaved = await save(third.id, third.choices[2].id);
  assert.equal(thirdSaved.status, 200);
  assert.equal(thirdSaved.data.selectedRole.nickname, '灯塔守望');
  store = loadStore();
  const thirdId = thirdSaved.data.account.id;
  assert.notEqual(thirdId, idOfAccount, '选择其他区服保留独立角色 ID');
  assert.equal(store.accounts.length, 3, '重复扫码不会重复新增区服');
  assert.equal(store.accounts.find(account => account.id === thirdId).login.worldId, 4000000003);
  assert.equal(store.accounts.find(account => account.id === thirdId).lastSeen.worldId, 4000000003);
  assert.equal(store.accounts.find(account => account.id === thirdId).automation.autoStart, false, '其他区服不继承已启用角色的挂机偏好');
  assert.equal(app.sessions.get(thirdId).loop.running, false);
  assert.equal(store.accounts.find(account => account.id === idOfAccount).label, '原微信账号');
  assert.equal(store.accounts.find(account => account.id === idOfAccount).automation.autoStart, true);
  assert.equal(store.accounts.find(account => account.id === idOfAccount).login.worldId, 3000000002, '旧角色保留自己的入口区服');
  assert(store.accounts.every(account => account.login.eworldParams.token === 'third-role-token'), '刷新凭据同步所有区服');
  await disconnect(idOfAccount);
  store = loadStore();

  // 在线账号复用已有连接查询，保存时维持重扫码停止旧任务与连接的约定。
  const session = app.sessions.get(idOfAccount);
  const activeClient = new GameClient({ url: credential().url, protocol: {} });
  activeClient.login = credential().login;
  liveClients.add(activeClient);
  session.client = activeClient;
  let worldStops = 0;
  session.worldClient = { stop() { worldStops++; } };
  session.player = { playerId: 12, nickname: '星海船长', worldId: 3000000002 };
  session.loop.running = true;
  session.loop.controller = new AbortController();
  const previousGeneration = session.generation;
  store.selectedRoles[loginAccountId(store.accounts[0])] = idOfAccount;
  store.activeId = idOfAccount;
  store.accounts.find(account => account.bornWorldId === 3000000001).label = '我的微信账号';
  saveStore(store);
  const beforeReuse = connections.length;
  const merged = await capture(credential(undefined, 'merged-role-token'));
  assert.equal(connections.length, beforeReuse);
  assert.equal(reads.at(-1).client, activeClient, '按 wechat 前缀账号找到在线会话');
  assert.equal(activeClient.connected, true);
  assert.equal(merged.choices[0].matched, true);
  const mergedSaved = await save(merged.id, merged.choices[0].id);
  assert.equal(mergedSaved.status, 200);
  assert.equal(mergedSaved.data.selectedRole.worldId, 3000000001);
  assert.equal(mergedSaved.data.selectedRole.roleWorldId, 3000000010);
  assert.equal(activeClient.stopCount, 1);
  assert.equal(worldStops, 1);
  assert.equal(session.loop.controller.signal.aborted, true);
  assert.ok(session.generation > previousGeneration);
  assert.equal(session.productionSyncRequired, true);
  session.loop.running = false;
  session.loop.controller = null;
  store = loadStore();
  const mergedId = mergedSaved.data.account.id;
  assert.notEqual(mergedId, idOfAccount);
  let account = store.accounts.find(row => row.id === mergedId);
  const selectedSession = app.sessions.get(mergedId);
  assert.equal(account.login.worldId, 3000000001, '连接保存合服前入口区服');
  assert.equal(account.lastSeen.worldId, 3000000010, '展示保存合服后的实际区服');
  assert.equal(account.lastSeen.nickname, '海风船长');
  assert.equal(account.label, '我的微信账号', '人工备注保持');
  assert.equal(account.automation.enabled, false);
  assert.equal(account.automation.autoStart, false);
  assert.equal(Boolean(account.automation.productionSyncRequired), false, '新选区服不继承旧区服待同步状态');
  assert.match(mergedSaved.data.account.title, /海港1服.*我的微信账号.*海风船长/);
  assert.equal(mergedSaved.data.account.lastSeen.worldName, '海港10服', '合服后的当前区服单独展示');

  // 暂停状态允许临时查询和更新，保留用户暂停选择。
  selectedSession.paused = true;
  account.automation.paused = true;
  saveStore(store);
  const paused = await capture(credential(undefined, 'paused-token'));
  assert.equal(liveClients.size, 0);
  const pausedSaved = await save(paused.id, paused.choices[0].id);
  assert.equal(pausedSaved.status, 200);
  assert.equal(selectedSession.paused, true);
  assert.equal(pausedSaved.data.account.status.paused, true);
  store = loadStore();
  account = store.accounts.find(row => row.id === mergedId);
  assert.equal(account.automation.paused, true);
  assert.equal(account.login.eworldParams.token, 'paused-token');
  assert.notEqual(store.accounts.find(row => row.id === idOfAccount).automation.paused, true, '暂停选择按区服独立保存');
  selectedSession.paused = false;
  account.automation.paused = false;
  saveStore(store);

  // 同角色重扫码也停止旧连接。
  const sameClient = new GameClient({ url: credential().url, protocol: {} });
  sameClient.login = credential().login;
  liveClients.add(sameClient);
  selectedSession.client = sameClient;
  selectedSession.player = { playerId: 11, nickname: '海风船长', worldId: 3000000010 };
  const same = await capture(credential(undefined, 'same-role-token'));
  assert.equal((await save(same.id, same.choices[0].id)).status, 200);
  assert.equal(sameClient.stopCount, 1);

  // 无角色与读取失败均可展示，保存始终只接受已读取的角色。
  roleLists.set('empty-account', []);
  const empty = await capture(credential('empty-account'));
  assert.deepEqual(empty.choices, []);
  assert.equal(empty.roleError, null);
  assert.equal((await save(empty.id)).status, 400);
  assert.equal(loadStore().accounts.some(row => row.id === 'empty-account'), false);
  roleFailures.add('retry-account');
  const failed = await capture(credential('retry-account'));
  assert.match(failed.roleError, /模拟角色列表读取失败/);
  assert.deepEqual(failed.choices, []);
  assert.equal((await save(failed.id)).status, 400);
  assert.equal((await request('/roles', { id: failed.id })).status, 400);
  roleFailures.delete('retry-account');
  const retry = await request('/roles', { confirm: true, id: failed.id });
  assert.equal(retry.data.phase, 'reading-roles');
  const retried = await preview(failed.id);
  assert.equal(retried.choices.length, 3);
  assert.equal(retried.roleError, null);
  assert.equal(retried.expiresAt, failed.expiresAt, '重试不延长扫码有效期');
  const oldChoice = retried.choices[0].id;
  await request('/roles', { confirm: true, id: failed.id });
  const refreshedRoles = await preview(failed.id);
  assert.notEqual(refreshedRoles.choices[0].id, oldChoice);
  assert.equal((await save(failed.id, oldChoice)).status, 400);

  // 一个角色可省略 choiceId，空昵称按游戏角色回填。
  roleLists.set('single-account', [{ worldId: 3000000008, roleInfo: { id: 88, worldId: 3000000008 } }]);
  const single = await capture(credential('single-account'));
  assert.equal(single.choices[0].nickname, '未命名角色');
  assert.equal((await save(single.id)).status, 200);
  assert.equal(loadStore().accounts.find(row => row.id === 'single-account').lastSeen.nickname, '未命名角色');
  assert.equal(loadStore().accounts.find(row => row.id === 'single-account').label, '未命名角色');
  assert.equal(app.sessions.get('single-account').loop.running, false);
  assert.equal(loadStore().accounts.find(row => row.id === 'single-account').automation.autoStart, false);
  await disconnect('single-account');

  // 查询并发共用同一请求，取消、过期、刷新都丢弃旧结果并关闭临时连接。
  for (const action of ['cancel', 'expire', 'refresh']) {
    const openId = action + '-during-read';
    const gate = holdRoles(openId);
    const started = await start();
    controller.capture(credential(openId));
    assert.equal((await status(started.data.id)).data.phase, 'reading-roles');
    await gate.started.promise;
    const before = reads.length;
    const concurrent = await Promise.all([status(started.data.id), request('/roles', { confirm: true, id: started.data.id })]);
    assert.ok(concurrent.every(result => result.data.phase === 'reading-roles'));
    assert.equal(reads.length, before);
    assert.equal((await save(started.data.id)).status, 400);
    const readingClient = reads.at(-1).client;
    if (action === 'cancel') await request('/cancel', { id: started.data.id });
    if (action === 'expire') {
      controller.expire();
      assert.equal((await status(started.data.id)).data.phase, 'expired');
    }
    if (action === 'refresh') assert.equal((await start()).data.phase, 'waiting');
    gate.done.resolve();
    roleGates.delete(openId);
    assert.equal(readingClient.connected, false);
    assert.equal((await save(started.data.id, 'late-choice')).status, 400);
    assert.equal(loadStore().accounts.some(row => row.id === '' + openId), false);
    assert.equal(liveClients.size, 0);
  }

  // 新扫码启动尚未返回时，旧角色查询已被中止。
  const replacingGate = holdRoles('replacing-account');
  const replacing = await start();
  controller.capture(credential('replacing-account'));
  await status(replacing.data.id);
  await replacingGate.started.promise;
  const replacingClient = reads.at(-1).client;
  controller.startGate = deferred();
  controller.startEntered = deferred();
  const startingReplacement = start();
  await controller.startEntered.promise;
  assert.equal(replacingClient.connected, false, '开始新扫码时立即取消旧查询');
  controller.startGate.resolve();
  assert.equal((await startingReplacement).data.phase, 'waiting');
  controller.startGate = controller.startEntered = null;
  replacingGate.done.resolve();
  roleGates.delete('replacing-account');

  // 浏览器取消失败也停止查询，随后的轮询不会重启已取消会话的读取。
  const cancellingGate = holdRoles('cancel-failure-account');
  const cancelling = await start();
  controller.capture(credential('cancel-failure-account'));
  await status(cancelling.data.id);
  await cancellingGate.started.promise;
  const cancellingClient = reads.at(-1).client;
  const beforeCancelReads = reads.length;
  controller.cancelError = new Error('模拟浏览器关闭失败');
  assert.equal((await request('/cancel', { id: cancelling.data.id })).status, 400);
  assert.equal(cancellingClient.connected, false);
  cancellingGate.done.resolve();
  assert.equal((await status(cancelling.data.id)).data.phase, 'cancelled');
  assert.equal(reads.length, beforeCancelReads);
  assert.equal((await save(cancelling.data.id)).status, 400);
  controller.cancelError = null;
  roleGates.delete('cancel-failure-account');

  // 浏览器端停止轮询后，服务端的有效期定时器仍清理正在读取的临时连接。
  const timedGate = holdRoles('timed-account');
  const timed = await start();
  controller.capture(credential('timed-account'));
  controller.setExpiry(Date.now() + 80);
  await status(timed.data.id);
  await timedGate.started.promise;
  const timedClient = reads.at(-1).client;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(timedClient.connected, false);
  timedGate.done.resolve();
  assert.equal((await status(timed.data.id)).data.phase, 'expired');
  roleGates.delete('timed-account');

  // 已过期凭证不会查询角色。
  const expired = await start();
  controller.capture(credential('expired-account'));
  controller.expire();
  const beforeExpiredReads = reads.length;
  assert.equal((await status(expired.data.id)).data.phase, 'expired');
  assert.equal((await save(expired.data.id)).status, 400);
  assert.equal(reads.length, beforeExpiredReads);

  // 排队期间重复保存被拒绝，取消与过期均在真正写入前复查。
  for (const action of ['cancel', 'expire']) {
    const queued = await capture(credential(undefined, action + '-queued-token'));
    const tokenBefore = loadStore().accounts.find(row => row.id === idOfAccount).login.eworldParams.token;
    const queue = holdQueue(selectedSession);
    let queuedSave;
    try {
      queuedSave = save(queued.id, queued.choices[2].id);
      await queue.wait(queuedSave);
      assert.equal((await save(queued.id, queued.choices[2].id)).status, 400);
      assert.equal((await request('/roles', { confirm: true, id: queued.id })).status, 400);
      if (action === 'cancel') await request('/cancel', { id: queued.id });
      else controller.expire();
      queue.release();
      assert.equal((await queuedSave).status, 400);
      assert.equal(loadStore().accounts.find(row => row.id === idOfAccount).login.eworldParams.token, tokenBefore);
    } finally {
      queue.release();
      await queuedSave?.catch(() => {});
      queue.restore();
    }
  }

  // 已保存时清理失败仍返回保存成功，已消费标记阻止重复写入。
  const cleanup = await capture(credential('cleanup-account', 'cleanup-token'));
  controller.cancelError = new Error('模拟浏览器关闭失败');
  const cleanupSaved = await save(cleanup.id, cleanup.choices[1].id);
  assert.equal(cleanupSaved.status, 200);
  assert.equal(cleanupSaved.data.account.id, 'cleanup-account');
  assert.equal(app.sessions.get('cleanup-account').loop.running, false);
  assert.equal(loadStore().accounts.find(row => row.id === 'cleanup-account').automation.autoStart, false);
  await disconnect('cleanup-account');
  assert.equal((await save(cleanup.id, cleanup.choices[1].id)).status, 400);
  assert.equal((await status(cleanup.id)).data.phase, 'cancelled');
  controller.cancelError = null;

  // 控制台关闭中止正在进行的角色预览。
  const closingGate = holdRoles('closing-account');
  const closingScan = await start();
  controller.capture(credential('closing-account'));
  assert.equal((await status(closingScan.data.id)).data.phase, 'reading-roles');
  await closingGate.started.promise;
  await app.close();
  closed = true;
  closingGate.done.resolve();
  assert.equal(controller.closes, 1);
  assert.equal(liveClients.size, 0);
  assert.equal(loadStore().accounts.some(row => row.id === 'closing-account'), false);
  console.log('selftest-wechat-login-http: ok');
} finally {
  for (const gate of roleGates.values()) gate.done.resolve();
  if (!closed) await app.close();
  for (const [name, descriptor] of Object.entries(originalMethods)) {
    if (descriptor) Object.defineProperty(GameClient.prototype, name, descriptor);
    else delete GameClient.prototype[name];
  }
  assert.equal(path.dirname(directory), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true });
}
