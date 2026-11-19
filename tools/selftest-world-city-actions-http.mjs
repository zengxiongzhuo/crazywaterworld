import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-world-city-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const { installResourceFieldMap } = await import('./fixtures/resource-field-map.mjs');
const { createConsole } = await import('../src/server.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const reads = [], writes = [];
const requests = ['GuildInfo', 'WorldInfo', 'UniteWorldsPlan', 'OnWater', 'MyFleets', 'WarDeclaration', 'SeasonTaskStage', 'FortList',
  'CityDefence', 'GuildCityInfo', 'AllItem', 'AllResource'];
const commands = ['DeclareWarRequest', 'MoveFleetsToCityRequest', 'SetAssembleCityRequest', 'CityRecruitDefenceRequest', 'CancelDeclareWarRequest'];
const protocol = createDeclaredProtocol([...requests.flatMap(name => [name + 'Request', name + 'Response']), ...commands]);
const player = { playerId: '10001', worldId: '1001001', guildId: '1007', level: 40, vip: { vipLevel: 6 } };
const cities = [{ id: 1, guildIdx: 7 }, { id: 2, guildIdx: 7 }, { id: 3, guildIdx: 8 }, { id: 4, guildIdx: 8 }];
const cityTable = { data: cities.map(city => ({ id: city.id, guildIndex: city.id === 1 ? 7 : 0, level: 1, name: '测试城' + city.id })) };
const config = { tables: { '1_CityCfg': cityTable, '1_ResFieldTypeCfg': { data: [] },
  VipLevelCfg: { data: [{ level: 6, effects: [['联盟高级募兵', 1]] }] },
  GuildParamCfg: { data: [{ paramName: '募兵令增加守军数', paramValue: 50 }] },
  WorldParamCfg: { data: [{ paramName: '取消宣战消耗', paramValue: 120 }] },
} };
const map = { width: 8, height: 8, cityInfo: { 1: { gridIdx: 1 }, 2: { gridIdx: 2 }, 3: { gridIdx: 3, neighbors: [2] } } };
const cleanupMap = installResourceFieldMap({ player, map, config, state: { mapFields: [] } });
const client = new EventEmitter(), buildingId = '1远征船';
const fleet = { buildingId, owner: { playerId: player.playerId, guildId: player.guildId }, cityId: 1, durability: 2000,
  maxDura: 2000, state: 1, curGridIdx: 0, treasureLootUid: 0 };
const declarations = [], now = Math.floor(Date.now() / 1000);
let title = 2, assembleCityId = 0, tokens = 3, defenceNum = 20, diamonds = 300;
let rosterUnavailable = false, delayRecruit = false, delayDiamond = false;
Object.assign(client, {
  connected: true, stop() { this.connected = false; },
  async request(name, body) {
    reads.push(name);
    if (name === 'CityDefenceRequest') {
      assert(cities.some(city => city.id === body.cityId));
      if (rosterUnavailable) throw Error('名单同步超时');
      return { fleets: [{ isNpc: true, multiple: 12, guildIdx: 7, power: 1200 }, { isNpc: false, name: '驻防玩家', guildIdx: 7, power: 300 }] };
    }
    const replies = {
      GuildInfoRequest: { guild: { guildId: player.guildId }, myTitle: title },
      WorldInfoRequest: { cities, myGuildTitle: title, blackWaterId: '' }, UniteWorldsPlanRequest: { worldIds: [] },
      OnWaterRequest: { building: [{ buildingId, level: 1, fleet: { formation: { heroPositions: [{ heroId: '船长' }] } } }] },
      MyFleetsRequest: { fleets: [fleet] }, WarDeclarationRequest: { declarations, assembleCityId, startTime: now - 10, endTime: now + 1000 },
      SeasonTaskStageRequest: { stage: 0 }, FortListRequest: { forts: [] },
      AllItemRequest: { items: [{ itemId: '联盟募兵令', num: tokens }] },
      AllResourceRequest: { list: [{ res: 4, amount: diamonds }] },
      GuildCityInfoRequest: { cities: [{ cityId: 2, defenceNum }] },
    };
    assert(Object.hasOwn(replies, name), '未声明的请求 ' + name);
    return structuredClone(replies[name]);
  },
  async sendWatch(name, body) {
    writes.push({ name, body });
    if (name === 'DeclareWarRequest') declarations.push({ cityId: body.cityId, attackGuildIdx: 7, defenceGuildIdx: 8 });
    else if (name === 'SetAssembleCityRequest') assembleCityId = body.cityId;
    else if (name === 'CityRecruitDefenceRequest') {
      assert.equal(body.cityId, 2);
      if (!delayRecruit) { tokens--; defenceNum += 50; }
    } else if (name === 'CancelDeclareWarRequest') {
      const index = declarations.findIndex(row => row.attackGuildIdx === 7 && row.cityId === body.cityId);
      assert(index >= 0);
      declarations.splice(index, 1);
      if (!delayDiamond) diamonds -= 120;
    } else {
      assert.equal(name, 'MoveFleetsToCityRequest');
      Object.assign(fleet, { state: 2, targetCityId: body.cityId, targetGridIdx: body.cityId });
    }
  },
});
let app;
try {
  fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(config.tables).map(([key, value], i) => [i, key, value])));
  saveStore({ activeId: 'a', accounts: ['a', 'b'].map(id => ({ id, label: id, url: 'ws://invalid.invalid', login: {}, automation: { paused: true } })) });
  app = createConsole({ port: 0, protocol });
  const base = await app.listen();
  await fetch(base + '/api/settings?account=a');
  const session = app.sessions.get('a');
  Object.assign(session, { client, player, paused: false });
  const url = base + '/api/world/city-actions?';
  const preview = async (id = 2) => {
    const response = await fetch(url + new URLSearchParams({ account: 'a', scenarioId: player.scenarioId, cityId: id }));
    assert(response.ok, await response.clone().text());
    return response.json();
  };
  const post = (body, account = 'a') => fetch(url + 'account=' + account, { method: 'POST', body: JSON.stringify(body) });
  const dispatch = token => ({ cityId: 2, action: 'dispatch', confirm: true, token, buildingId });
  const command = (view, cityId, action, extras = {}) => ({ confirm: true, token: view.token, cityId, action, ...extras });
  const successful = async payload => {
    const response = await post(payload);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };

  assert.equal((await fetch(url + 'account=a&scenarioId=1&cityId=2')).status, 400);
  const first = await preview();
  assert.equal(first.declare.visible, false);
  assert.equal(first.dispatch.cost, 0);
  assert.equal(first.dispatch.intent, 'relocate');
  assert(first.defence.synced);
  assert.deepEqual(first.defence.defenders.map(d => [d.name, d.npc, d.count, d.power]),
    [['测试城2守军', true, 12, 1200], ['驻防玩家', false, 1, 300]]);
  assert.equal(first.assemble.visible, false); assert(first.recruit.allowed);
  for (const action of ['checkRecruit', 'checkCancel', 'assemble'])
    assert.equal((await post(command(first, 2, action, { pending: true, allowed: true }))).status, 400);
  assert.deepEqual(first.dispatch.fleets.map(f => f.buildingId), [buildingId]);
  assert.equal(reads.filter(n => n === 'GuildInfoRequest').length, 1);
  const query = new URLSearchParams({ account: 'a', scenarioId: player.scenarioId, cityId: 2, includeDefenders: '0' });
  const startReads = reads.length;
  const compact = await (await fetch(url + query)).json();
  assert.deepEqual(compact.defence, { deferred: true });
  assert.deepEqual(compact.dispatch.fleets, first.dispatch.fleets);
  assert(!reads.slice(startReads).includes('CityDefenceRequest'));
  const beforeDefence = reads.length;
  const rosterResponse = await fetch(base + '/api/world/city-defence?' + query);
  assert.deepEqual(await rosterResponse.json(), first.defence);
  assert.deepEqual(reads.slice(beforeDefence), ['CityDefenceRequest']);

  // 移开鼠标时允许已在途的游戏读取收尾，后续读取应立即让出账号队列。
  const signal = AbortSignal.timeout(5000), outgoing = new AbortController();
  const seen = once(app.server, 'request', { signal }), firstRead = once(client, 'hover-read', { signal });
  const originalRequest = client.request;
  let finishFirstRead;
  const gate = new Promise(resolve => { finishFirstRead = resolve; });
  client.request = async function(...args) {
    client.emit('hover-read');
    await gate;
    return originalRequest.apply(this, args);
  };
  const beforeHover = reads.length, abandoned = fetch(url + query, { signal: outgoing.signal });
  const rejected = assert.rejects(abandoned, { name: 'AbortError' });
  try {
    const [, outgoingResponse] = await seen;
    const closed = once(outgoingResponse, 'close', { signal });
    await firstRead;
    outgoing.abort();
    await Promise.all([rejected, closed]);
  } finally {
    finishFirstRead();
    await session.queueTail;
    client.request = originalRequest;
  }
  assert.equal(reads.length - beforeHover, 1);
  rosterUnavailable = true;
  const partial = await preview(); assert.equal(partial.defence.synced, false); assert(partial.recruit.allowed);
  assert.equal(partial.dispatch.fleets.length, 1); rosterUnavailable = false;
  const body = dispatch(first.token);
  for (const change of [{ cityId: 3 }, { action: 'declare', buildingId: undefined }, { token: 'invalid' }, { confirm: false }, { buildingId: '99远征船' }])
    assert.equal((await post({ ...body, ...change })).status, 400);
  assert.equal((await post(body, 'b')).status, 400);
  fleet.state = 4;
  assert.equal((await post(body)).status, 400);
  fleet.state = 1;

  const queued = dispatch((await preview()).token);
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  session.queueTail = blocker;
  const waiting = post(queued);
  try {
    const deadline = Date.now() + 5000;
    while (session.queueTail === blocker && Date.now() < deadline) await delay(5);
    assert.notEqual(session.queueTail, blocker, '城池派遣应已进入账号队列');
    session.generation++;
  } finally { release(); }
  assert.equal((await waiting).status, 400);
  assert.equal(writes.length, 0);
  const peaceful = dispatch((await preview()).token);
  declarations.push({ cityId: 2, attackGuildIdx: 8, defenceGuildIdx: 7 });
  assert.equal((await post(peaceful)).status, 400, '受攻后不能用旧调动确认直接增援');
  const reinforcement = await preview();
  assert.equal(reinforcement.dispatch.intent, 'reinforce'); assert.equal(reinforcement.dispatch.cost, 0);
  const fresh = dispatch(reinforcement.token);
  const responses = await Promise.all([post(fresh), post(fresh)]);
  for (const response of responses) {
    const result = await response.json();
    assert.equal(result.status, 'confirmed'); assert.match(result.message, /增援防守/);
  }
  assert.deepEqual(writes, [{ name: 'MoveFleetsToCityRequest', body: { cityId: 2, buildingId: [buildingId] } }]);

  title = 4;
  const allowed = await preview(3);
  assert.equal(allowed.declare.allowed, true, JSON.stringify(allowed));
  const declare = { action: 'declare', cityId: 3, token: allowed.token, confirm: true };
  title = 2;
  assert.equal((await post(declare)).status, 400);
  assert.equal(writes.length, 1);
  title = 5;
  declare.token = (await preview(3)).token;
  assert.equal((await (await post(declare)).json()).confirmed, true);
  assert.equal((await (await post(declare)).json()).confirmed, true);
  assert.deepEqual(writes[1], { name: 'DeclareWarRequest', body: { cityId: 3 } });
  assert.equal(writes.length, 2);
  assert.equal((await preview(3)).declare.allowed, false);

  assert.equal((await preview(3)).cancelDeclare.allowed, false, '仅有一个进攻目标时不能撤销');
  declarations.push({ cityId: 4, attackGuildIdx: 7, defenceGuildIdx: 8 });
  const attack = await preview(3);
  assert.equal(attack.assemble.role, 'attack'); assert(attack.assemble.allowed);
  assembleCityId = 4;
  assert.equal((await post(command(attack, 3, 'assemble'))).status, 400, '旧预览不得覆盖新集结城');
  assert.equal(writes.length, 2);
  const defending = await preview(2);
  assert.equal(defending.assemble.role, 'defence'); assert.equal(defending.assemble.currentCityId, 4);
  assert((await successful(command(defending, 2, 'assemble', { currentCityId: 0, role: 'attack' }))).confirmed);
  assert.equal(assembleCityId, 2); assert.deepEqual(writes.at(-1), { name: 'SetAssembleCityRequest', body: { cityId: 2 } });
  assert.equal((await preview(2)).assemble.allowed, false);

  const cancelling = await preview(3);
  assert.equal(cancelling.cancelDeclare.allowed, true, cancelling.cancelDeclare.reason);
  assert.equal(cancelling.cancelDeclare.cost, 120);
  for (const extras of [{}, { confirmedCost: '120' }, { confirmedCost: 0, cost: 0 }])
    assert.equal((await post(command(cancelling, 3, 'cancelDeclare', extras))).status, 400);
  title = 2;
  assert.equal((await post(command(cancelling, 3, 'cancelDeclare', { confirmedCost: 120, myTitle: 5 }))).status, 400);
  title = 4;
  delayDiamond = true;
  const cancel = command(await preview(3), 3, 'cancelDeclare', { confirmedCost: 120, cost: 0, guildId: '伪造' });
  const cancellations = await Promise.all([successful(cancel), successful(cancel)]);
  assert(cancellations.every(result => result.confirmed === false)); // 城池宣战已撤销，个人钻石读回尚未扣款。
  assert.deepEqual(writes.filter(w => w.name === 'CancelDeclareWarRequest'), [{ name: 'CancelDeclareWarRequest', body: { cityId: 3 } }]);
  diamonds -= 120;
  const awaitingDebit = await preview(3); assert(awaitingDebit.cancelDeclare.pending); assert(!awaitingDebit.cancelDeclare.allowed);
  assert((await successful(command(awaitingDebit, 3, 'checkCancel'))).confirmed);
  assert.equal((await preview(3)).cancelDeclare.pending, false);

  title = 2;
  const recruited = await preview(2); assert(recruited.recruit.allowed, recruited.recruit.reason);
  assert.deepEqual([recruited.recruit.cost, recruited.recruit.gain, recruited.recruit.stock], [1, 50, 3]);
  for (const extras of [{}, { confirmedCost: 0 }, { confirmedCost: '1' }])
    assert.equal((await post(command(recruited, 2, 'recruit', extras))).status, 400);
  player.vip.vipLevel = 2;
  assert.equal((await post(command(recruited, 2, 'recruit', { confirmedCost: 1, vipLevel: 8 }))).status, 400);
  player.vip.vipLevel = 6;
  const recruit = command(await preview(2), 2, 'recruit', { confirmedCost: 1, cost: 0, gain: 9000 });
  for (const result of await Promise.all([successful(recruit), successful(recruit)])) assert.equal(result.status, 'confirmed');
  assert.equal(tokens, 2); assert.equal(defenceNum, 70);
  delayRecruit = true;
  const spending = command(await preview(2), 2, 'recruit', { confirmedCost: 1 });
  assert.equal((await successful(spending)).status, 'unknown'); assert.equal(tokens, 2);
  const pending = await preview(2); assert(pending.recruit.pending); assert(!pending.recruit.allowed);
  assert.equal((await post(command(pending, 2, 'recruit', { confirmedCost: 1 }))).status, 400);
  tokens--; defenceNum += 50;
  assert.equal((await successful(command(pending, 2, 'checkRecruit'))).status, 'confirmed');
  assert.equal((await preview(2)).recruit.pending, false);
  assert.equal(writes.filter(w => w.name === 'CityRecruitDefenceRequest').length, 2);
  console.log('通过：驻防名单与部分读取、城池派遣、宣战/集结权限、募兵和撤销费用、并发重放与待确认核对');
} finally {
  if (app) { app.server.closeAllConnections(); await app.close(); }
  cleanupMap();
  fs.rmSync(directory, { recursive: true, force: true });
}
