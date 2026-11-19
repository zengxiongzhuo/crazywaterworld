import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lineup-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
const tables = {
  HeroCfg: [{ id: 'a', name: '英雄甲', career: '坦克' }, { id: 'b', name: '英雄乙', career: '射手' }, { id: 'c', name: '英雄丙' }],
  FormationHeroNumCfg: [{ mainlineStage: 0, heroNum: 2 }],
  FormationTypePositionCfg: [{ id: 1, position: [4, 4] }, { id: 1, position: [1, 3] }, { id: 7, position: [5, 1] }],
  FormationTypeUnlockCfg: [{ id: 7, name: '攻速增强', activeDesc: '攻速+{0}', activeDescParams: ['15%'],
    unlockDesc: '生命+{0}', unlockDescParams: ['3%'] }],
  PetBreedCfg: [{ petId: 'p', spId: 1, quality: 'BLUE' }],
  PetSpeciesCfg: [{ spId: 1, name: '声波海豚' }],
  StageCfg: [{ stage: 1, playerLevel: 1 }],
  TrialRaidCfg: [{ raidId: 2, title: '强化石副本' }],
  TrialRaidStageCfg: [{ raidId: 2, stageId: 2001, stageLevel: 1, openLevel: 1, power: 100, reward: [], sweepReward: [] }],
};
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(tables).map(([name, data], index) => [index, name, { data }])));
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, validateSettings, importAutomationSettings } = await import('../src/automation-settings.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { getConfig } = await import('../src/config.mjs');
const { normalizeFormation } = await import('../src/saved-lineups.mjs');
const { withTemporaryLineup, readLineupRuntime } = await import('../src/lineup-runtime.mjs');
const { createLineupExecutor, selectedSavedLineup, lineupRole } = await import('../src/lineup-execution.mjs');
const original = { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4 } }], petUid: '0' };
const target = { presetId: 7, heroPositions: [{ heroId: 'b', pos: { x: 5, y: 1 } }], petUid: '9007199254740993' };
const player = { playerId: '9007199254740995', bornWorldId: 31, worldId: 99, mainlineStage: 1, level: 20 };
const old = validateSettings(defaultSettings());
delete old.lineups;
old.heroes.skill = false;
saveStore({ activeId: 'a', accounts: ['a', 'b', 'old'].map(id => ({ id, label: id, url: 'ws://invalid.invalid', login: {}, automation: { enabled: false, autoStart: false } })) });
fs.writeFileSync(path.join(directory, 'automation-settings.json'), JSON.stringify({ version: 1, accounts: { old: { settings: old, revision: 4 } } }));
const app = createConsole({ port: 0, protocol: {} });
const root = await app.listen();
const streams = new Set();
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function api(route, body, account = 'a') {
  const response = await fetch(root + '/api/' + route + '?account=' + account, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, data: await response.json() };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const payload = (view, fields) => ({ confirm: true, revision: view.revision, ...fields });
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < deadline, '等待测试状态超时'); await sleep(10); }
}
function subscribe(query) {
  return new Promise((resolve, reject) => {
    const stream = { events: [], request: null, response: null };
    streams.add(stream);
    stream.request = http.get(root + '/api/events' + query, response => {
      stream.response = response;
      if (response.statusCode !== 200) { reject(new Error('SSE HTTP ' + response.statusCode)); return; }
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const lines = buffer.slice(0, end).split('\n'); buffer = buffer.slice(end + 2);
          const data = lines.find(line => line.startsWith('data: '));
          if (data) stream.events.push({ type: lines.find(line => line.startsWith('event: '))?.slice(7) || 'log', data: JSON.parse(data.slice(6)) });
        }
      });
      resolve(stream);
    });
    stream.request.on('error', reject);
  });
}
function closeStream(stream) {
  stream.request?.destroy(); stream.response?.destroy(); streams.delete(stream);
}
const lineupEvents = stream => stream.events.filter(event => event.type === 'lineup-changed').map(event => event.data);
const routineLineupLog = /^(正在切换挑战阵容|使用所选阵容挑战|使用游戏当前阵容挑战|正在恢复原阵容|阵容核对完成)/;
function fixture(account = 'a') {
  const client = new EventEmitter();
  Object.assign(client, {
    connected: true, current: structuredClone(original), writes: [], requests: [], passedStage: 0, failRestore: false,
    onBattle: null, unlocked: [7], pets: [{ uid: { low: 1, high: 2097152 }, petId: 'p', star: 2, level: 10 }],
    stop() { this.connected = false; this.stopped = true; },
    async request(name, body) {
      assert(this.connected, '停止连接前完成恢复');
      this.requests.push(name);
      if (name === 'GetFormationRequest') return { formation: structuredClone(this.current) };
      if (name === 'SaveFormationRequest') {
        if (this.failRestore && body.formation.presetId === original.presetId) throw new Error('模拟阵容恢复失败');
        this.current = normalizeFormation(body.formation, { allowEmpty: true });
        this.writes.push(structuredClone(this.current));
        return { formation: structuredClone(this.current) };
      }
      if (name === 'AllHeroRequest') return { heroes: [{ heroId: 'a' }, { heroId: 'b' }] };
      if (name === 'MyFormationPresetRequest') return { ids: this.unlocked };
      if (name === 'AllPetRequest') return { pets: this.pets };
      if (name === 'TrialRaidInfoRequest') return { raid: { raidId: 2, passedStage: this.passedStage, buySweepTimes: 0 } };
      if (name === 'TrialRaidChallengeRequest' || name === 'ChallengeStageRequest') {
        assert.deepEqual(this.current, target, '真实挑战入口应使用所选预设');
        assert.equal(readLineupRuntime(account).phase, 'battling');
        await this.onBattle?.();
        if (name === 'TrialRaidChallengeRequest') { this.passedStage = body.stageId; return { ...body }; }
        return { initialData: { mainlineStage: body.stage }, stats: { isLeftWin: true } };
      }
      throw new Error('意外游戏请求 ' + name);
    },
  });
  const session = app.sessions.get(account);
  session.client = client; session.player = structuredClone(player); session.paused = false;
  session.loop.tasks.afk = false;
  return { client, session };
}

try {
  let saved;
  await test('旧配置补齐阵容组，离线读取及保存按账号隔离', async () => {
    const legacy = ok(await api('lineup-presets', undefined, 'old'));
    assert.deepEqual(legacy.presets, []);
    assert.equal(legacy.revision, 4);
    const imported = importAutomationSettings({ format: 'crazywaterworld-automation', version: 1, settings: old });
    assert.deepEqual(imported.lineups, { presets: [], mainlinePresetId: '', trialPresets: [] });
    assert.equal(imported.heroes.skill, false);
    const view = ok(await api('lineup-presets'));
    saved = ok(await api('lineup-presets/save', payload(view, { name: '攻速队', formation: target })));
    assert.equal(saved.presets[0].formation.petUid, '9007199254740993');
    assert.equal(saved.savedId, saved.presets[0].id);
    assert.equal(app.sessions.get('a').client, null);
    assert.deepEqual(ok(await api('lineup-presets', undefined, 'b')).presets, []);
  });

  await test('离线查看返回英雄与阵型目录，读取不联网且不依赖账号拥有状态', async () => {
    const before = ok(await api('lineup-presets'));
    assert.equal(app.sessions.get('a').client, null, '未连接账号查看保存阵容不创建连接');
    assert.deepEqual(before.catalog.heroes.map(hero => hero.heroId), ['a', 'b', 'c']);
    assert.equal(before.catalog.heroes.find(hero => hero.heroId === 'c').name, '英雄丙');
    const preset = before.catalog.formations.find(formation => formation.presetId === 7);
    assert.deepEqual(preset.positions, [{ x: 5, y: 1 }]);
    assert.equal(preset.effect, '攻速+15%');
    assert.equal(preset.unlockEffect, '生命+3%');
    assert.equal(Object.hasOwn(preset, 'unlocked'), false);
    assert.deepEqual(before.presets, saved.presets);
    assert.deepEqual(before.presets[0].formation, target, '保留已保存英雄站位及海兽UID');
    const { client, session } = fixture();
    client.connected = false;
    client.unlocked = [];
    client.pets = [];
    const disconnected = ok(await api('lineup-presets'));
    assert.deepEqual(disconnected.catalog, before.catalog);
    assert.equal(client.requests.length, 0, '离线查看不读取英雄、海兽或阵型状态');
    assert.equal(client.writes.length, 0);
    session.client = null;
    session.player = null;
    const availableConfig = process.env.CW_CONFIG_PACK;
    const unavailableConfig = path.join(directory, 'unreadable-config.json');
    fs.writeFileSync(unavailableConfig, '{');
    process.env.CW_CONFIG_PACK = unavailableConfig;
    try {
      const withoutConfig = ok(await api('lineup-presets'));
      assert.deepEqual(withoutConfig.catalog, { heroes: [], formations: [] });
      assert.deepEqual(withoutConfig.presets, before.presets, '配置不可读时仍可查看保存的站位');
      assert.equal(app.sessions.get('a').client, null);
    } finally { process.env.CW_CONFIG_PACK = availableConfig; }
  });

  await test('保存校验站位与引用，旧版本并发保存保留新内容', async () => {
    const before = saved;
    saved = ok(await api('lineup-presets/save', payload(saved, { id: saved.savedId, name: '推关队', formation: target })));
    const stale = await api('lineup-presets/save', payload(before, { name: '旧页面', formation: original }));
    assert.equal(stale.status, 400); assert(stale.data.fields.revision);
    for (const fields of [
      { name: '', formation: target }, { name: '无英雄', formation: { ...target, heroPositions: [] } },
      { name: '站位错误', formation: { ...target, presetId: 1 } }, { id: 'missing', name: '已删除', formation: target },
      { name: '未知字段', formation: { ...target, extra: true } },
    ]) assert.equal((await api('lineup-presets/save', payload(saved, fields))).status, 400);
    assert.deepEqual(ok(await api('lineup-presets')).presets, saved.presets);
  });

  await test('主线与副本绑定持久化，导出只含设置并保留精确海兽编号', async () => {
    saved = ok(await api('lineup-presets/bind', payload(saved, { mainlinePresetId: saved.presets[0].id, trialPresets: [{ raidId: '2', presetId: saved.presets[0].id }] })));
    const exported = ok(await api('settings/export'));
    assert.deepEqual(importAutomationSettings(exported).lineups.presets, saved.presets);
    assert(!JSON.stringify(exported).includes('transactionId'));
    assert.equal((await api('lineup-presets/bind', payload(saved, { mainlinePresetId: 'missing', trialPresets: [] }))).status, 400);
    assert.equal((await api('lineup-presets/bind', payload(saved, { mainlinePresetId: '', trialPresets: [{ raidId: '99', presetId: saved.presets[0].id }] }))).status, 400);
  });

  await test('编辑器读取真实数据结构，采集当前阵容只写本地设置', async () => {
    const { client } = fixture();
    const editor = ok(await api('lineup-editor'));
    assert.equal(editor.capacity, 2); assert.equal(editor.pets[0].uid, target.petUid);
    assert.deepEqual(editor.formation, original);
    saved = ok(await api('lineup-presets/capture', payload(saved, { name: '原搭配' })));
    assert.deepEqual(saved.presets[1].formation, original);
    assert.equal(client.writes.length, 0);
  });

  await test('自动执行器按模式选预设，执行前检查拥有英雄、阵型与海兽', async () => {
    const { client } = fixture();
    const settings = ok(await api('settings')).settings;
    const execute = createLineupExecutor(client, { accountId: 'a', getPlayer: () => player, getSettings: () => settings, getConfig });
    for (const context of [{ mode: 'mainline' }, { mode: 'trial', raidId: 2 }]) {
      await execute(async () => assert.deepEqual(client.current, target), context);
      assert.deepEqual(client.current, original);
    }
    assert.equal(selectedSavedLineup(settings, { mode: 'mainline', presetId: '' }), null);
    assert.throws(() => selectedSavedLineup(settings, { presetId: 'deleted' }), /已删除/);
    assert.deepEqual(lineupRole(player), { playerId: player.playerId, worldId: '31' });
    client.unlocked = [];
    await assert.rejects(execute(() => assert.fail('锁定阵型不能挑战'), { mode: 'mainline' }), /尚未解锁/);
    client.unlocked = [7]; client.pets = [];
    await assert.rejects(execute(() => assert.fail('失效海兽不能挑战'), { mode: 'mainline' }), /已不存在/);
    assert.equal(client.writes.length, 4);
  });

  await test('正常试炼保留挑战结果但不输出阵容过程日志，独立SSE按账号更新状态', async () => {
    const { client, session } = fixture();
    const connections = await Promise.all(['?scope=all', '?account=a', '?account=b', ''].map(subscribe));
    const [all, scoped, other, system] = connections;
    const logStart = session.log.length;
    try {
      const result = ok(await api('trials/challenge', { raidId: 2, stageId: 2001, lineupId: saved.presets[0].id }));
      assert.match(result.message, /已通关/);
      assert.deepEqual(client.writes, [target, original]);
      assert.equal(readLineupRuntime('a').pending, false);
      const marker = app.emit(null, 'info', '阵容静默日志验收完成');
      await until(() => connections.every(stream => stream.events.some(event => event.type === 'log' && event.data.id === marker.id)));
      const expected = ['switching', 'battling', 'restoring', 'idle'].map(phase => ({ account: 'a', phase }));
      assert.deepEqual(lineupEvents(all), expected);
      assert.deepEqual(lineupEvents(scoped), expected);
      assert.deepEqual(lineupEvents(other), []);
      assert.deepEqual(lineupEvents(system), []);
      const logs = session.log.slice(logStart);
      assert(logs.some(entry => entry.message === result.message), '最终挑战结果仍保留在运行日志');
      assert(!logs.some(entry => routineLineupLog.test(entry.message)), '正常阵容过程不能占用业务日志容量');
      assert(!all.events.some(event => event.type === 'log' && routineLineupLog.test(event.data.message)), '正常阵容过程不能作为日志发送到网页');
      assert.equal(session.lineupState.phase, 'idle');
    } finally { connections.forEach(closeStream); }
  });

  await test('阵容恢复失败仍保留警告原因与状态通知', async () => {
    const { client, session } = fixture();
    const stream = await subscribe('?account=a'), logStart = session.log.length;
    client.onBattle = () => { client.failRestore = true; };
    try {
      const result = await api('trials/challenge', { raidId: 2, stageId: 2001, lineupId: saved.presets[0].id });
      assert.equal(result.status, 400);
      assert.match(result.data.error, /模拟阵容恢复失败/);
      await until(() => lineupEvents(stream).some(event => event.phase === 'pending'));
      assert(session.log.slice(logStart).some(entry => entry.level === 'warn' && /模拟阵容恢复失败/.test(entry.message)), '恢复失败不能被正常过程日志降噪隐藏');
      assert.equal(session.lineupState.phase, 'pending');
      client.failRestore = false;
      const recovery = ok(await api('lineup-presets')).recovery;
      ok(await api('lineup-presets/recover', { confirm: true, resolution: 'restore', expectedTransactionId: recovery.transactionId }));
      assert.deepEqual(client.current, original);
      assert.equal(readLineupRuntime('a').pending, false);
    } finally { closeStream(stream); }
  });

  await test('连续主线和连续试炼均绑定本次选择并逐场恢复', async () => {
    let { client, session } = fixture();
    ok(await api('stages/start', { confirm: true, maxFailures: 1, lineupId: saved.presets[0].id }));
    await until(() => !session.stages.view().running);
    assert.equal(session.stages.view().wins, 1);
    assert.deepEqual(client.writes, [target, original]);
    ({ client, session } = fixture());
    const logStart = session.log.length;
    ok(await api('trials/start', { confirm: true, raidId: 2, maxFailures: 1, lineupId: saved.presets[0].id }));
    await until(() => !session.trials.get(2).view().running);
    assert.equal(session.trials.get(2).view().wins, 1);
    assert.deepEqual(client.writes, [target, original]);
    const messages = session.log.slice(logStart).filter(entry => entry.message.startsWith('试炼 · 强化石副本：')).map(entry => entry.message);
    assert(messages.some(message => /通关|通过1关/.test(message)), '连续试炼仍保留通关结果');
    assert.equal(new Set(messages).size, messages.length, '阵容阶段更新不能重复输出同一试炼结果');
  });

  await test('断开连接等待在途战报及恢复完成后关闭客户端', async () => {
    const { client, session } = fixture();
    let release;
    client.onBattle = () => new Promise(resolve => { release = resolve; });
    ok(await api('stages/start', { confirm: true, maxFailures: 1, lineupId: saved.presets[0].id }));
    await until(() => !!release);
    const disconnected = api('disconnect', {});
    await until(() => session.stages.view().stopping);
    assert.equal(client.stopped, undefined);
    release();
    ok(await disconnected);
    assert.deepEqual(client.current, original);
    assert.equal(client.stopped, true);
    assert.equal(readLineupRuntime('a').pending, false);
  });

  await test('断线记录在下次操作前恢复，第三套阵容需显式处理', async () => {
    const { client, session } = fixture();
    const makePending = () => withTemporaryLineup(client, { accountId: 'a', role: lineupRole(player), formation: target }, async () => { client.connected = false; });
    await assert.rejects(makePending(), error => error.lineupRestorePending);
    client.connected = true;
    ok(await api('lineup-editor'));
    assert.deepEqual(client.current, original);
    assert.equal(readLineupRuntime('a').pending, false);
    await assert.rejects(makePending(), error => error.lineupRestorePending);
    client.connected = true;
    client.current = { ...original, heroPositions: [{ heroId: 'c', pos: { x: 4, y: 4 } }] };
    assert.equal((await api('lineup-editor')).status, 400);
    const pending = ok(await api('lineup-presets')).recovery;
    assert.equal(pending.phase, 'conflict');
    assert(session.log.some(entry => entry.level === 'warn' && /游戏阵容已被其他操作修改/.test(entry.message)), '阵容冲突仍需显示明确原因');
    assert.equal((await api('lineup-presets/recover', { confirm: true, resolution: 'restore', expectedTransactionId: 'old' })).status, 400);
    const kept = ok(await api('lineup-presets/recover', { confirm: true, resolution: 'keep', expectedTransactionId: pending.transactionId }));
    assert.equal(kept.recovery.pending, false);
    assert.equal(client.current.heroPositions[0].heroId, 'c');
  });

  await test('恢复操作核对角色区服，显式恢复也不能写入其他角色', async () => {
    const { client, session } = fixture();
    await assert.rejects(withTemporaryLineup(client, { accountId: 'a', role: lineupRole(player), formation: target }, async () => {
      client.connected = false;
    }), error => error.lineupRestorePending);
    client.connected = true;
    const pending = readLineupRuntime('a');
    session.player = { ...player, playerId: '100', bornWorldId: 22 };
    for (const resolution of ['auto', 'restore', 'keep']) {
      const response = await api('lineup-presets/recover', { confirm: true, resolution, expectedTransactionId: pending.transactionId });
      assert.equal(response.status, 400);
      assert.match(response.data.error, /其他角色或区服/);
    }
    assert.equal(client.writes.length, 1);
    session.player = structuredClone(player);
    ok(await api('lineup-presets/recover', { confirm: true, resolution: 'restore', expectedTransactionId: pending.transactionId }));
    assert.deepEqual(client.current, original);
    assert.equal(readLineupRuntime('a').pending, false);
  });

  await test('删除预设同步移除自动绑定，保留其他阵容与配置', async () => {
    const configView = ok(await api('settings'));
    configView.settings.worldBoss.fleetPresets = configView.settings.lineups.presets.map((preset, index) => ({ buildingId: (index + 1) + '远征船', presetId: preset.id }));
    ok(await api('settings', { confirm: true, revision: configView.revision, settings: configView.settings }));
    saved = ok(await api('lineup-presets'));
    const after = ok(await api('lineup-presets/delete', payload(saved, { id: saved.presets[0].id })));
    assert.equal(after.mainlinePresetId, ''); assert.deepEqual(after.trialPresets, []);
    assert.equal(after.presets.length, 1); assert.equal(after.presets[0].name, '原搭配');
    assert.deepEqual(ok(await api('settings')).settings.worldBoss.fleetPresets,
      [{ buildingId: '2远征船', presetId: after.presets[0].id }], '仅清除已删除预设的舰队绑定');
    assert.deepEqual(ok(await api('lineup-presets', undefined, 'b')).presets, []);
  });
  console.log('保存阵容HTTP与执行器专项 ' + passed + '/' + passed + ' 通过');
} finally {
  for (const stream of streams) closeStream(stream);
  await app.close();
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
