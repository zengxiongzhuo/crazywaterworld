// Exercise automatic startup through HTTP with isolated storage and fake game clients.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-auto-start-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { GameClient } = await import('../src/client.mjs');
const { loadStore, saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { loadAutomationSettings, saveAutomationSettings, settingsFromNative } = await import('../src/automation-settings.mjs');

const live = new Set();
const states = new Map();
const protocol = Object.fromEntries(['OnWaterRequest', 'OnWaterResponse', 'AllItemRequest', 'AllItemResponse', 'GotAchievementRewardRequest']
  .map(name => [name, true]));
const tasks = Object.fromEntries(automationTasks.map(task => [task.key, task.key === 'mail']));
let app, root, capturedLogin, sequence = 0, passed = 0;

Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function (login) {
  const state = states.get(login.fixtureId);
  assert(state, '每个登录都必须使用离线测试账号');
  this.fixture = state;
  this.stopping = false;
  this.closeReason = null;
  state.logins++;
  if (state.loginError) throw state.loginError;
  if (state.loginFailures > 0) {
    state.loginFailures--;
    this.closeReason = 'network';
    throw new Error('socket error during login');
  }
  live.add(this);
  return { result: 0, playerInfo: state.player };
};
GameClient.prototype.send = () => {};
GameClient.prototype.sendWatch = async function (name, body) {
  if (name === 'GotAchievementRewardRequest') {
    assert.equal(body.id, this.fixture.achievement.id);
    this.fixture.achievement.rewardClaimed = true;
  }
  return {};
};
GameClient.prototype.request = async function (name) {
  this.fixture.requests.push(name);
  if (name === 'EmailBoxRequest') {
    await this.fixture.mailGate;
    return { email: [] };
  }
  if (name === 'OnWaterRequest') return { building: [] };
  if (name === 'AllItemRequest') return { items: [] };
  if (name === 'AchievementInfoRequest') return { task: this.fixture.achievement ? [this.fixture.achievement] : [] };
  return {};
};
GameClient.prototype.stop = function () { this.stopping = true; live.delete(this); };

function account(automation = {}) {
  const id = 'auto-start-' + ++sequence;
  const state = { logins: 0, requests: [], player: { playerId: 910000 + sequence, worldId: 9001, level: 5 } };
  states.set(id, state);
  const row = { id, url: 'ws://invalid.invalid', login: { fixtureId: id, eworldParams: { openId: id } },
    automation: { tasks, everySeconds: 3600, ...automation } };
  return { id, state, row };
}

async function launch(accounts, { recoveryDelayMs = 25 } = {}) {
  if (accounts) saveStore({ activeId: accounts[0]?.id ?? null, accounts: accounts.map(entry => entry.row) });
  app = createConsole({ port: 0, protocol, recoveryDelayMs: () => recoveryDelayMs,
    captureController: {
      inspectCaptureRecovery: () => ({ pending: false }),
      captureState: () => ({ running: false }),
      startCapture: async options => { capturedLogin = options.onLogin; },
    },
  });
  root = await app.listen();
}

async function shutdown() {
  if (!app) return;
  const jobs = [...app.sessions.values()].flatMap(session => [session.loop.job, session.loginRecoveryJob]);
  await app.close();
  await Promise.allSettled(jobs);
  app = null;
}

async function response(id, route, body) {
  const result = await fetch(root + '/api/' + route + '?account=' + encodeURIComponent(id), {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify({ confirm: true, ...body }) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: result.status, data: await result.json() };
}

async function api(id, route, body) {
  const result = await response(id, route, body);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

const session = id => app.sessions.get(id);
const saved = id => loadStore().accounts.find(entry => entry.id === id)?.automation;
async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail('等待超时：' + label);
}

async function running(id) {
  try {
    await waitFor(() => session(id)?.loop.running && session(id).loop.completed >= 1, '自动开始并完成首轮');
  } catch (error) {
    throw new Error(error.message + '\n' + JSON.stringify({ autoStart: saved(id)?.autoStart, error: session(id)?.loop.error,
      log: session(id)?.log.slice(-5) }), { cause: error });
  }
}

async function stop(id) {
  const job = session(id)?.loop.job;
  await api(id, 'loop/stop', {});
  await job;
  assert.equal(session(id).loop.running, false);
}

async function configureReconnect(id, enabled) {
  const current = await api(id, 'login-settings');
  await api(id, 'login-settings', { revision: current.revision, settings: { ...current.settings,
    reconnectEnabled: enabled, baseDelaySeconds: 1, jitterSeconds: 0,
    deep: { ...current.settings.deep, enabled: false } } });
}

function kick(id) {
  const client = session(id).client;
  client.closeReason = 'kicked';
  live.delete(client);
  client.emit('fatal', { reason: 'SCChannelExpired' });
  client.emit('close', { reason: 'kicked' });
}

async function test(name, work) {
  try {
    await work();
    passed++;
    console.log('通过：' + name);
  } finally {
    await shutdown();
    saveStore({ activeId: null, accounts: [] });
  }
}

try {
  await test('未保存启停状态的账号读取和重启均不挂机，明确开启后才持续运行', async () => {
    const f = account({ everySeconds: 37, rounds: 8 });
    await launch([f]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const idle = await api(f.id, 'loop');
      await api(f.id, 'settings');
      assert.equal(idle.autoStart, false);
      assert.equal(idle.running, false);
      assert.equal(saved(f.id).autoStart, false);
      assert.equal(f.state.logins, 0);
      await shutdown();
      await launch();
    }
    await api(f.id, 'accounts/pause', { paused: false, start: true });
    await running(f.id);
    const view = await api(f.id, 'loop');
    assert.equal(view.autoStart, true);
    assert.equal(view.rounds, 0);
    assert.equal(view.everyMs, 37000);
    assert.equal(saved(f.id).autoStart, true);
    assert.equal(saved(f.id).enabled, true);
    assert.equal(f.state.logins, 1);
  });

  await test('旧账号显式关闭和新配置关闭均保持停止，账号间设置独立', async () => {
    const legacy = account({ enabled: false });
    const disabled = account({ enabled: true, autoStart: false });
    const enabled = account({ enabled: false, autoStart: true });
    await launch([legacy, disabled, enabled]);
    await running(enabled.id);
    for (const f of [legacy, disabled]) {
      const view = await api(f.id, 'loop');
      assert.equal(view.autoStart, false);
      assert.equal(view.running, false);
      assert.equal(f.state.logins, 0);
    }
    await stop(enabled.id);
    assert.equal(saved(legacy.id).enabled, false);
    assert.equal(saved(disabled.id).autoStart, false);
  });

  await test('开启自动挂机立即运行，重复设置与页面读取共用同一个循环', async () => {
    const f = account({ enabled: false });
    await launch([f]);
    await api(f.id, 'loop/auto-start', { autoStart: true });
    await running(f.id);
    const job = session(f.id).loop.job;
    await api(f.id, 'loop/auto-start', { autoStart: true });
    const connected = await response(f.id, 'connect', {});
    assert.equal(connected.status, 400);
    assert.match(connected.data.error, /已经连上/);
    await api(f.id, 'loop');
    await api(f.id, 'settings');
    assert.equal(session(f.id).loop.job, job);
    assert.equal(session(f.id).loop.completed, 1);
    assert.equal(f.state.logins, 1);
    assert.equal(saved(f.id).autoStart, true);
    const invalid = await response(f.id, 'loop/auto-start', { autoStart: 'true' });
    assert.equal(invalid.status, 400);
    assert.equal(saved(f.id).autoStart, true);
  });

  await test('关闭自动启动保留当前循环，重启后沿用关闭状态', async () => {
    const f = account({ autoStart: true });
    await launch([f]);
    await running(f.id);
    const job = session(f.id).loop.job;
    const view = await api(f.id, 'loop/auto-start', { autoStart: false });
    assert.equal(view.autoStart, false);
    assert.equal(session(f.id).loop.job, job);
    assert.equal(session(f.id).loop.running, true);
    await shutdown();
    await launch();
    assert.equal((await api(f.id, 'loop')).running, false);
    assert.equal(f.state.logins, 1);
  });

  await test('自动挂机偏好和间隔跨重启恢复，手动停止后持久关闭', async () => {
    const f = account({ autoStart: true, everySeconds: 43 });
    await launch([f]);
    await running(f.id);
    await shutdown();
    await launch();
    await running(f.id);
    assert.equal(f.state.logins, 2);
    assert.equal((await api(f.id, 'loop')).everyMs, 43000);
    await stop(f.id);
    assert.equal(saved(f.id).autoStart, false);
    assert.equal(saved(f.id).enabled, false);
    await shutdown();
    await launch();
    assert.equal((await api(f.id, 'loop')).running, false);
    assert.equal(f.state.logins, 2);
  });

  await test('暂停托管保留自动挂机偏好，恢复托管后自动接续', async () => {
    const f = account({ autoStart: true });
    await launch([f]);
    await running(f.id);
    const job = session(f.id).loop.job;
    await api(f.id, 'accounts/pause', { paused: true });
    await job;
    assert.equal(saved(f.id).autoStart, true);
    await shutdown();
    await launch();
    assert.equal((await api(f.id, 'loop')).running, false);
    assert.equal(f.state.logins, 1);
    await api(f.id, 'accounts/pause', { paused: false });
    await running(f.id);
    assert.equal(f.state.logins, 2);
  });

  await test('暂停挂机保留连接和手动操作，暂停托管断开连接，重启保持挂机停止', async () => {
    const f = account({ autoStart: false });
    await launch([f]);
    const started = await api(f.id, 'loop/start', {});
    assert.equal(started.running, true);
    assert.equal(started.status.looping, true);
    assert.equal(started.status.paused, false);
    assert.equal(started.status.loopStopping, false);
    await running(f.id);
    const active = session(f.id), client = active.client, generation = active.generation;
    const job = active.loop.job;
    let releaseManual;
    const manualGate = new Promise((resolve, reject) => { releaseManual = () => reject(new Error('离线手动任务结束')); });
    active.pirateAdvance.start({ fleetIds: ['1'] }, () => manualGate);
    try {
      const stopped = await api(f.id, 'loop/stop', {});
      assert.equal(stopped.ok, true);
      assert.equal(stopped.status.paused, false);
      assert.equal(stopped.status.connected, true);
      assert.equal(stopped.status.looping, stopped.running);
      assert.equal(stopped.status.loopStopping, stopped.running);
      await job;
      assert.equal(active.loop.running, false);
      assert.equal(active.paused, false);
      assert.equal(active.client, client);
      assert.equal(client.connected, true);
      assert.equal(active.generation, generation);
      assert.equal(active.pirateAdvance.view().running, true);
      assert.equal(active.pirateAdvance.view().stopping, false);
      assert.equal(saved(f.id).enabled, false);
      assert.equal(saved(f.id).autoStart, false);

      f.state.achievement = { id: 123, progress: 1, targetProgress: 1, rewardClaimed: false };
      const manual = await api(f.id, 'tasks/run', {});
      assert.equal(manual.results.length, 1);
      assert.equal(manual.results[0].ok, true);
      assert.equal(f.state.achievement.rewardClaimed, true);
      assert.equal(active.loop.running, false);
      assert.equal(f.state.logins, 1);

      const paused = await api(f.id, 'accounts/pause', { paused: true });
      assert.equal(paused.paused, true);
      assert.equal(paused.connected, false);
      assert.equal(paused.loopStopping, false);
      assert.equal(client.connected, false);
      assert.equal(active.pirateAdvance.view().stopping, true);
      const blocked = await response(f.id, 'tasks/run', {});
      assert.equal(blocked.status, 400);
      assert.match(blocked.data.error, /账号已暂停/);
      await api(f.id, 'accounts/pause', { paused: false });
      assert.equal(active.loop.running, false);
      await shutdown();
      await launch();
      assert.equal((await api(f.id, 'loop')).running, false);
      assert.equal(saved(f.id).autoStart, false);
      assert.equal(f.state.logins, 1);
    } finally {
      releaseManual();
      await waitFor(() => !active.pirateAdvance.view().running, '手动海盗任务退出');
    }
  });

  await test('未运行时手动停止也保存关闭，暂停账号中开启配置等待恢复托管', async () => {
    const f = account({ paused: true, autoStart: true });
    await launch([f]);
    await stop(f.id);
    assert.equal(saved(f.id).autoStart, false);
    await api(f.id, 'loop/auto-start', { autoStart: true });
    assert.equal(session(f.id).loop.running, false);
    assert.equal(f.state.logins, 0);
    assert.equal(saved(f.id).autoStart, true);
    await api(f.id, 'accounts/pause', { paused: false });
    await running(f.id);
  });

  await test('页头开始托管忽略旧账号有限轮数并持续运行，重复开始共用循环', async () => {
    const f = account({ enabled: false, rounds: 2 });
    await launch([f]);
    const started = await api(f.id, 'accounts/pause', { paused: false, start: true });
    assert.equal(started.paused, false);
    assert.equal(started.looping, true);
    await running(f.id);
    const job = session(f.id).loop.job;
    assert.equal(session(f.id).loop.rounds, 0);
    assert.equal(saved(f.id).autoStart, true);
    await api(f.id, 'accounts/pause', { paused: false, start: true });
    assert.equal(session(f.id).loop.job, job);
    assert.equal(f.state.logins, 1);
  });

  await test('页头恢复托管改为持续运行，普通恢复继续遵循自动开始偏好', async () => {
    const finite = account({ paused: true, autoStart: true, rounds: 3 });
    const stopped = account({ paused: true, autoStart: false });
    await launch([finite, stopped]);
    await api(finite.id, 'accounts/pause', { paused: false, start: true });
    await running(finite.id);
    assert.equal(session(finite.id).loop.rounds, 0);
    assert.equal(saved(finite.id).autoStart, true);
    const resumed = await api(stopped.id, 'accounts/pause', { paused: false });
    assert.equal(resumed.looping, false);
    assert.equal(stopped.state.logins, 0);
    await api(stopped.id, 'accounts/pause', { paused: false, start: true });
    await running(stopped.id);
    assert.equal(session(stopped.id).loop.rounds, 0);
    assert.equal(saved(stopped.id).autoStart, true);
  });

  await test('网页开始挂机覆盖已保存的有限轮数，连续执行至手动暂停且暂停后重启不续跑', async () => {
    const f = account({ autoStart: false, rounds: 1 });
    saveAutomationSettings(f.id, settingsFromNative(tasks, { rounds: 1, everySeconds: 1 }), { revision: 0 });
    await launch([f]);
    await api(f.id, 'loop/start', {});
    await waitFor(() => session(f.id).loop.completed >= 2, '超过旧设置的一轮上限');
    assert.equal(session(f.id).loop.running, true);
    assert.equal(session(f.id).loop.rounds, 0);
    assert.equal(loadAutomationSettings(f.id).settings.loop.rounds, 0);
    assert.equal(saved(f.id).autoStart, true);
    await stop(f.id);
    assert.equal(saved(f.id).autoStart, false);
    await shutdown(); await launch();
    assert.equal((await api(f.id, 'loop')).running, false);
    assert.equal(f.state.logins, 1, '手动暂停后重启不自动登录或继续挂机');
  });

  await test('页头恢复等待旧循环退出，等待期间再次暂停优先生效', async () => {
    for (const pauseAgain of [false, true]) {
      const f = account({ autoStart: false });
      let release;
      f.state.mailGate = new Promise(resolve => { release = resolve; });
      await launch([f]);
      await api(f.id, 'accounts/pause', { paused: false, start: true });
      await waitFor(() => f.state.requests.includes('EmailBoxRequest'), '旧循环邮件请求进入等待');
      const previousJob = session(f.id).loop.job;
      await api(f.id, 'accounts/pause', { paused: true });
      const resumed = api(f.id, 'accounts/pause', { paused: false, start: true });
      await waitFor(() => !session(f.id).paused, '恢复请求等待旧循环');
      assert.equal(session(f.id).loop.job, previousJob);
      if (pauseAgain) await api(f.id, 'accounts/pause', { paused: true });
      release();
      const result = await resumed;
      assert.equal(result.paused, pauseAgain);
      assert.equal(result.looping, !pauseAgain);
      if (pauseAgain) assert.equal(f.state.logins, 1);
      else {
        await running(f.id);
        assert.notEqual(session(f.id).loop.job, previousJob);
        assert.equal(f.state.logins, 2);
      }
      await shutdown();
    }
  });

  await test('页头开始清除顶号阻塞并报告无任务的启动错误', async () => {
    const blocked = account({ autoStart: false, loginBlocked: true });
    const empty = account({ autoStart: false, tasks: Object.fromEntries(Object.keys(tasks).map(key => [key, false])) });
    await launch([blocked, empty]);
    const started = await api(blocked.id, 'accounts/pause', { paused: false, start: true });
    assert.equal(started.loginBlocked, false);
    await running(blocked.id);
    assert.equal(saved(blocked.id).loginBlocked, false);
    const failed = await response(empty.id, 'accounts/pause', { paused: false, start: true });
    assert.equal(failed.status, 400);
    assert.match(failed.data.error, /至少启用一个自动项目/);
    assert.equal(session(empty.id).loop.running, false);
    assert.equal(empty.state.logins, 0);
    assert.equal((await response(empty.id, 'accounts/pause', { paused: true, start: true })).status, 400);
    assert.equal(session(empty.id).paused, false);
  });

  await test('页头间隔按账号保存且保持暂停状态，刷新与重启读取新值', async () => {
    const f = account({ paused: true, autoStart: false, rounds: 4 });
    const other = account({ paused: true, autoStart: false });
    await launch([f, other]);
    const current = await api(f.id, 'settings');
    const updated = await api(f.id, 'loop/interval', { everySeconds: 47, revision: current.revision });
    assert.equal(updated.everyMs, 47000);
    assert.equal(updated.rounds, 4);
    assert.equal(updated.settingsRevision, current.revision + 1);
    const stored = loadAutomationSettings(f.id);
    assert.equal(stored.settings.loop.everySeconds, 47);
    assert.equal(stored.settings.loop.rounds, 4);
    assert.equal(stored.settings.schedule.mail, true);
    assert.equal(saved(f.id).autoStart, false);
    assert.equal(session(f.id).paused, true);
    assert.equal(f.state.logins, 0);
    assert.equal((await api(other.id, 'loop')).everyMs, 3600000);
    await shutdown();
    await launch();
    assert.equal((await api(f.id, 'loop')).everyMs, 47000);
    assert.equal((await api(f.id, 'loop')).running, false);
    assert.equal(f.state.logins, 0);
  });

  await test('运行中保存间隔沿用当前循环、进度和挑战计数', async () => {
    const f = account({ autoStart: true });
    await launch([f]);
    await running(f.id);
    const loop = session(f.id).loop;
    const job = loop.job, challengeRun = loop.challengeRun, completed = loop.completed;
    const current = await api(f.id, 'settings');
    const updated = await api(f.id, 'loop/interval', { everySeconds: 53, revision: current.revision });
    assert.equal(updated.everyMs, 53000);
    assert.equal(loop.job, job);
    assert.equal(loop.challengeRun, challengeRun);
    assert.equal(loop.completed, completed);
    assert.equal(f.state.logins, 1);
    assert.equal(saved(f.id).autoStart, true);
  });

  await test('页头间隔拒绝无效整数与过期版本，保持最新已保存值', async () => {
    const f = account({ autoStart: false });
    await launch([f]);
    const current = await api(f.id, 'settings');
    for (const everySeconds of [0, 86401, 1.5, '60', null]) {
      const result = await response(f.id, 'loop/interval', { everySeconds, revision: current.revision });
      assert.equal(result.status, 400);
      assert.equal(session(f.id).loop.everyMs, 3600000);
    }
    const savedInterval = await api(f.id, 'loop/interval', { everySeconds: 86400, revision: current.revision });
    const stale = await response(f.id, 'loop/interval', { everySeconds: 2, revision: current.revision });
    assert.equal(stale.status, 400);
    assert.ok(stale.data.fields.revision);
    assert.equal(session(f.id).loop.everyMs, 86400000);
    await api(f.id, 'loop/interval', { everySeconds: 1, revision: savedInterval.settingsRevision });
    assert.equal(session(f.id).loop.everyMs, 1000);
    assert.equal(f.state.logins, 0);
  });

  await test('停止账号的配置读取、保存、预览与明确连接保持停止', async () => {
    const f = account({ autoStart: false });
    await launch([f]);
    const current = await api(f.id, 'settings');
    current.settings.loop.everySeconds = 29;
    await api(f.id, 'settings', { settings: current.settings, revision: current.revision, baseRevision: current.baseRevision });
    await api(f.id, 'settings/preview', { category: 'runtime' });
    await api(f.id, 'loop');
    assert.equal(f.state.logins, 0);
    await api(f.id, 'connect', {});
    assert.equal(f.state.logins, 1);
    assert.equal(session(f.id).loop.running, false);
    assert.equal(saved(f.id).autoStart, false);
  });

  await test('手动有限轮数保存参数并关闭自动续跑，完成后重启保持停止', async () => {
    const f = account({ enabled: false });
    await launch([f]);
    await api(f.id, 'loop/start', { rounds: 1, everySeconds: 19 });
    await waitFor(() => session(f.id).loop.completed === 1 && !session(f.id).loop.running, '有限轮完成');
    assert.equal(saved(f.id).autoStart, false);
    assert.equal(saved(f.id).rounds, 1);
    assert.equal(saved(f.id).everySeconds, 19);
    await shutdown();
    await launch();
    const view = await api(f.id, 'loop');
    assert.equal(view.running, false);
    assert.equal(view.rounds, 1);
    assert.equal(f.state.logins, 1);
  });

  await test('初始化异常保留自动挂机偏好，明确连接或重启后自动恢复', async () => {
    for (const recovery of ['connect', 'restart']) {
      const f = account({ autoStart: true });
      f.state.loginError = Object.assign(new Error('模拟初始化异常'), { recoverable: false });
      await launch([f]);
      await waitFor(() => session(f.id)?.loop.error && !session(f.id).loop.running, '异常退出');
      assert.equal(saved(f.id).autoStart, true);
      assert.equal(saved(f.id).enabled, false);
      f.state.loginError = null;
      if (recovery === 'connect') await api(f.id, 'connect', {});
      else { await shutdown(); await launch(); }
      await running(f.id);
      assert.equal(f.state.logins, 2);
      assert.equal(saved(f.id).autoStart, true);
      await shutdown();
    }
  });

  await test('异常停止后再次手动停止会清除偏好并阻止重启续跑', async () => {
    const f = account({ autoStart: true });
    f.state.loginError = Object.assign(new Error('模拟初始化异常'), { recoverable: false });
    await launch([f]);
    await waitFor(() => session(f.id)?.loop.error && !session(f.id).loop.running, '异常退出');
    await stop(f.id);
    assert.equal(saved(f.id).autoStart, false);
    f.state.loginError = null;
    await shutdown();
    await launch();
    assert.equal((await api(f.id, 'loop')).running, false);
    assert.equal(f.state.logins, 1);
  });

  await test('顶号停止后保留挂机选择，开启重连恢复连接时自动再开始', async () => {
    const f = account({ autoStart: true });
    await launch([f]);
    await running(f.id);
    await configureReconnect(f.id, false);
    const job = session(f.id).loop.job;
    kick(f.id);
    await job;
    assert.equal(session(f.id).loop.running, false);
    assert.equal(saved(f.id).autoStart, true);
    await configureReconnect(f.id, true);
    await waitFor(() => f.state.logins === 2 && session(f.id).loop.running && session(f.id).loop.completed >= 1, '重连后自动挂机');
    assert.equal(session(f.id).loginBlocked, false);
    assert.equal(saved(f.id).autoStart, true);
  });

  await test('新采集账号默认停止，手动开启后运行，暂停与刷新凭证保留关闭选择', async () => {
    const f = account();
    saveAutomationSettings(f.id, settingsFromNative(tasks, { everySeconds: 3600 }), { revision: 0 });
    await launch([]);
    await api('', 'capture/start', {});
    await capturedLogin({ url: f.row.url, body: f.row.login });
    assert.equal(saved(f.id).autoStart, false);
    assert.equal(saved(f.id).enabled, false);
    assert.equal(session(f.id).loop.running, false);
    assert.equal(f.state.requests.includes('EmailBoxRequest'), false);
    await shutdown();
    const metadataLogins = f.state.logins;
    await launch();
    assert.equal((await api(f.id, 'loop')).running, false);
    assert.equal(f.state.logins, metadataLogins);
    await api('', 'capture/start', {});
    await api(f.id, 'accounts/pause', { paused: false, start: true });
    await running(f.id);
    assert.equal(saved(f.id).autoStart, true);
    await stop(f.id);
    await capturedLogin({ url: f.row.url, body: f.row.login });
    assert.equal(session(f.id).loop.running, false);
    assert.equal(saved(f.id).autoStart, false);
  });

  await test('新采集账号资料读取失败不自动挂机，明确开启后才重试连接', async () => {
    const f = account();
    f.state.loginFailures = 1;
    saveAutomationSettings(f.id, settingsFromNative(tasks, { everySeconds: 3600 }), { revision: 0 });
    await launch([]);
    await api('', 'capture/start', {});
    await capturedLogin({ url: f.row.url, body: f.row.login });
    await sleep(100);
    assert.equal(f.state.logins, 1);
    assert.equal(saved(f.id).autoStart, false);
    assert.equal(session(f.id).loop.running, false);
    await api(f.id, 'accounts/pause', { paused: false, start: true });
    await running(f.id);
    assert.equal(f.state.logins, 2);
    assert.equal(saved(f.id).autoStart, true);
  });

  await test('顶号停止后采集到新凭证自动恢复挂机并解除旧登录保护', async () => {
    const f = account({ autoStart: true });
    await launch([f]);
    await running(f.id);
    await configureReconnect(f.id, false);
    const job = session(f.id).loop.job;
    kick(f.id);
    await job;
    assert.equal(saved(f.id).loginBlocked, true);
    await api(f.id, 'capture/start', {});
    await capturedLogin({ url: f.row.url, body: f.row.login });
    await running(f.id);
    assert.equal(f.state.logins, 2);
    assert.equal(saved(f.id).loginBlocked, false);
    assert.equal(saved(f.id).autoStart, true);
  });

  await test('刷新凭证遵守托管暂停和已安排的顶号重连时间', async () => {
    const f = account({ autoStart: true });
    await launch([f], { recoveryDelayMs: 250 });
    await running(f.id);
    const firstJob = session(f.id).loop.job;
    await api(f.id, 'accounts/pause', { paused: true });
    await firstJob;
    await api(f.id, 'capture/start', {});
    await capturedLogin({ url: f.row.url, body: f.row.login });
    assert.equal(session(f.id).loop.running, false);
    assert.equal(session(f.id).paused, true);
    assert.equal(f.state.logins, 1);
    assert.equal(saved(f.id).autoStart, true);
    await api(f.id, 'accounts/pause', { paused: false });
    await running(f.id);
    await configureReconnect(f.id, true);
    const secondJob = session(f.id).loop.job;
    kick(f.id);
    const deadline = session(f.id).loginRecovery.nextAttemptAt;
    await capturedLogin({ url: f.row.url, body: f.row.login });
    assert.equal(session(f.id).loginRecovery.nextAttemptAt, deadline);
    assert.equal(session(f.id).loop.job, secondJob);
    assert.equal(f.state.logins, 2);
    await waitFor(() => f.state.logins === 3 && session(f.id).loop.completed === 2, '原重连等待结束后继续挂机');
    assert.equal(session(f.id).loop.job, secondJob);
  });

  console.log(`默认自动挂机专项 ${passed}/${passed} 通过`);
} finally {
  await shutdown();
  assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true });
}
