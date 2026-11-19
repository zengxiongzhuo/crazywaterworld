import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-lineup-lifecycle-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
const tables = {
  StageCfg: [{ stage: 1, playerLevel: 1 }],
  TrialRaidCfg: [{ raidId: 2, title: '测试副本' }],
  TrialRaidStageCfg: [{ raidId: 2, stageId: 2001, stageLevel: 1, openLevel: 1 }],
};
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(tables).map(([name, data], index) => [index, name, { data }])));
const { createConsole } = await import('./fixtures/console-server.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { withTemporaryLineup, readLineupRuntime } = await import('../src/lineup-runtime.mjs');
const { normalizeFormation } = await import('../src/saved-lineups.mjs');
const { createStageTask } = await import('../src/stages.mjs');
const { createTrialTask } = await import('../src/trials.mjs');
const { getConfig } = await import('../src/config.mjs');
saveStore({ activeId: 'a', accounts: ['a', 'b'].map(id => ({ id, label: id, url: 'ws://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false } })) });
const app = createConsole({ port: 0, protocol: {} });
const root = await app.listen();
const original = { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4 } }], petUid: '0' };
const target = { presetId: 7, heroPositions: [{ heroId: 'b', pos: { x: 5, y: 1 } }], petUid: '0' };
const player = { playerId: '11', bornWorldId: 31, worldId: 31, mainlineStage: 1, level: 20 };
const role = { playerId: '11', worldId: '31' };
let passed = 0;
let closed = false;
const gates = new Set();
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };

async function api(route, body, account = 'a') {
  const response = await fetch(root + '/api/' + route + '?account=' + account, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, data: await response.json() };
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < deadline, '等待测试状态超时'); await sleep(5); }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const gate = { promise, resolve: () => { gates.delete(gate); resolve(); } };
  gates.add(gate);
  return gate;
}

function holdLineup(session) {
  const gate = deferred();
  const job = gate.promise.finally(() => { if (session.lineupJob === job) session.lineupJob = null; });
  session.lineupJob = job;
  return gate;
}

function fixture(account = 'a') {
  const client = new EventEmitter();
  Object.assign(client, {
    connected: true, current: structuredClone(original), requests: [], failRestore: false, readGate: null,
    freeRecruitTimes: { hero: 0, antique: 0 },
    stop() { this.connected = false; this.stopping = true; this.stopped = true; },
    async request(name, body) {
      assert(this.connected, '阵容恢复完成前应保持连接');
      this.requests.push(name);
      if (name === 'GetFormationRequest') {
        await this.readGate?.promise;
        assert(this.connected, '读取阵容期间不应关闭连接');
        return { formation: structuredClone(this.current) };
      }
      if (name === 'SaveFormationRequest') {
        if (this.failRestore && body.formation.presetId === original.presetId) throw new Error('模拟恢复失败');
        this.current = normalizeFormation(body.formation, { allowEmpty: true });
        return { formation: structuredClone(this.current) };
      }
      if (name === 'TrialRaidInfoRequest') return { raid: { raidId: 2, passedStage: 0 } };
      throw new Error('意外游戏请求 ' + name);
    },
  });
  const session = app.sessions.get(account);
  Object.assign(session, { client, player: structuredClone(player), paused: false, connectionDrain: null });
  return { client, session };
}

async function leavePending(client) {
  client.failRestore = true;
  await assert.rejects(withTemporaryLineup(client, { accountId: 'a', role, formation: target }, async () => {}),
    error => error.lineupRestorePending === true);
  client.failRestore = false;
  return readLineupRuntime('a');
}

try {
  ok(await api('lineup-presets'));
  ok(await api('lineup-presets', undefined, 'b'));

  await test('暂停阻止新操作，快速恢复托管等待旧挑战恢复及断开完成', async () => {
    const { client, session } = fixture();
    const gate = holdLineup(session);
    let pausedDone = false, resumedDone = false;
    const pause = api('accounts/pause', { paused: true }).then(result => { pausedDone = true; return result; });
    await until(() => session.connectionDrain);
    const resume = api('accounts/pause', { paused: false }).then(result => { resumedDone = true; return result; });
    for (const [route, body] of [['connect', {}], ['lineups/apply', { confirm: true }], ['lineups', undefined]]) {
      const rejected = await api(route, body);
      assert.equal(rejected.status, 400);
      assert.match(rejected.data.error, /恢复阵容/);
    }
    assert.equal(pausedDone, false);
    assert.equal(resumedDone, false);
    assert.equal(client.stopped, undefined);
    assert.deepEqual(client.requests, []);
    gate.resolve();
    ok(await pause); ok(await resume);
    assert.equal(session.paused, false);
    assert.equal(client.stopped, true);
    assert.equal(session.client, null);
    assert.equal(session.connectionDrain, null);
  });

  await test('旧断开收尾仅关闭捕获客户端，代际变化保留新连接和新角色', async () => {
    const { client, session } = fixture();
    const gate = holdLineup(session);
    const disconnect = api('disconnect', {});
    await until(() => session.connectionDrain);
    const blocked = await api('connect', {});
    assert.equal(blocked.status, 400);
    const replacement = new EventEmitter();
    replacement.connected = true;
    replacement.stop = () => { replacement.connected = false; replacement.stopped = true; };
    const replacementPlayer = { ...player, playerId: '22' };
    session.generation++;
    session.client = replacement;
    session.player = replacementPlayer;
    gate.resolve();
    ok(await disconnect);
    assert.equal(client.stopped, true);
    assert.equal(replacement.stopped, undefined);
    assert.equal(session.client, replacement);
    assert.equal(session.player, replacementPlayer);
    replacement.stop();
  });

  await test('手动恢复已开始时暂停继续等待恢复任务，不提前停止连接', async () => {
    const { client, session } = fixture();
    const pending = await leavePending(client);
    client.readGate = deferred();
    const recovery = api('lineup-presets/recover', { confirm: true, resolution: 'auto', expectedTransactionId: pending.transactionId });
    await until(() => session.lineupJob);
    const pause = api('accounts/pause', { paused: true });
    await until(() => session.connectionDrain);
    assert.equal(client.stopped, undefined);
    client.readGate.resolve();
    ok(await recovery); ok(await pause);
    assert.deepEqual(client.current, original);
    assert.equal(readLineupRuntime('a').pending, false);
    assert.equal(client.stopped, true);
  });

  await test('持久化记录清理后主线、副本与挂机状态清除待恢复标记并要求重新开始', async () => {
    const { client, session } = fixture();
    const pending = await leavePending(client);
    const executeBattle = async () => { throw Object.assign(new Error('模拟恢复失败'), { lineupRestorePending: true }); };
    const context = { client, player: structuredClone(player), config: getConfig(), executeBattle };
    session.stages = createStageTask();
    session.stages.start({ maxFailures: 1 }, async () => context);
    const trial = createTrialTask(2);
    session.trials.set(2, trial);
    trial.start({ maxFailures: 1 }, async () => context);
    await until(() => !session.stages.view().running && !trial.view().running);
    session.loop.challengeRun = {
      mainline: { halted: true, wins: 2, lineupRestorePending: true, lineupPhase: 'pending', reason: '阵容待恢复' },
      trials: { 2: { halted: true, wins: 1, lineupRestorePending: true, lineupPhase: 'pending', reason: '阵容待恢复' } },
    };
    session.loop.controlStatus = new Map();
    assert.equal(ok(await api('stages')).lineupRestorePending, true);
    assert.equal(ok(await api('trials/tasks'))[2].lineupRestorePending, true);
    ok(await api('lineup-presets/recover', { confirm: true, resolution: 'auto', expectedTransactionId: pending.transactionId }));
    for (const state of [ok(await api('stages')), ok(await api('trials/tasks'))[2]]) {
      assert.equal(state.lineupRestorePending, false);
      assert.equal(state.lineupPhase, 'idle');
      assert.match(state.reason, /重新开始挑战/);
    }
    const loop = ok(await api('loop'));
    for (const state of [loop.challenges.mainline, loop.challenges.trials[2]]) {
      assert.equal(state.lineupRestorePending, false);
      assert.equal(state.lineupPhase, 'idle');
      assert.equal(state.halted, true);
      assert.match(state.reason, /重新开始挂机/);
      assert.doesNotMatch(state.reason, /待恢复/);
    }
    assert.equal(loop.challenges.mainline.wins, 2);
    assert.equal(loop.challenges.trials[2].wins, 1);
  });

  await test('控制台关闭同步停止各账号任务，各自完成恢复后才关闭连接', async () => {
    const first = fixture('a'), second = fixture('b');
    const firstGate = holdLineup(first.session), secondGate = holdLineup(second.session);
    const closing = app.close();
    await until(() => first.session.connectionDrain && second.session.connectionDrain);
    assert.equal(first.client.stopped, undefined);
    assert.equal(second.client.stopped, undefined);
    assert.equal((await api('connect', {})).status, 400);
    secondGate.resolve();
    await until(() => second.client.stopped);
    assert.equal(first.client.stopped, undefined);
    firstGate.resolve();
    await closing;
    closed = true;
    assert.equal(first.client.stopped, true);
  });
  console.log(`阵容生命周期 HTTP ${passed}/${passed} 通过`);
} finally {
  for (const gate of [...gates]) gate.resolve();
  if (!closed) await app.close();
  assert.equal(path.dirname(directory), temporaryRoot);
  assert(path.basename(directory).startsWith('cw-lineup-lifecycle-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
