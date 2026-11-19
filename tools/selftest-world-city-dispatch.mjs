import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { previewWorldCityDispatch, runWorldCityDispatch } from '../src/world-city-dispatch.mjs';
import { registerFleetReservations } from '../src/fleet-reservations.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-world-city-'));
let sequence = 0;
function fixture() {
  const ledger = createUsageLedger('模拟账号', { file: path.join(temp, ++sequence + '.json') });
  const player = { playerId: '101', guildId: '1001', worldId: '2003', scenarioId: 1 };
  const config = { tables: {
    '1_CityCfg': { data: [{ id: 1, guildIndex: 1 }, { id: 2, guildIndex: 0, name: '海星港' },
      { id: 3, guildIndex: 2 }, { id: 4, guildIndex: 0, name: '珍珠港' }] },
    '1_AttackCityConsumeCfg': { data: [{ dist: 0, cost: 1 }] },
  } };
  const now = Math.floor(Date.now() / 1000);
  const fleet = { buildingId: '1远征船', state: 1, curGridIdx: 0, cityId: 1, durability: 100, maxDura: 100, owner: { playerId: '101' } };
  const reads = {
    MyFleetsRequest: { fleets: [fleet] },
    WorldInfoRequest: { cities: [{ id: 1, guildIdx: 1 }, { id: 2, guildIdx: 1 }, { id: 3, guildIdx: 2 }, { id: 4, guildIdx: 2 }] },
    GuildInfoRequest: { guild: { guildId: '1001' } }, UniteWorldsPlanRequest: { worldIds: [] },
    WarDeclarationRequest: { startTime: now - 10, endTime: now + 100, declarations: [{ attackGuildIdx: 1, defenceGuildIdx: 2, cityId: 4 }] },
    AllItemRequest: { items: [{ itemId: '汽油', num: 40 }] },
    OnWaterRequest: { building: [{ buildingId: fleet.buildingId, level: 1, fleet: { formation: { heroPositions: [{ heroId: '甲' }] } } }] },
  };
  const writes = [];
  const client = { connected: true, request: async name => structuredClone(reads[name]),
    sendWatch: async (name, body) => {
      writes.push({ name, body }); Object.assign(fleet, { state: 2, targetCityId: body.cityId });
    } };
  const mapLoader = async () => ({ width: 8, tileWidth: 10, tileHeight: 50, cityInfo: { 1: { gridIdx: 0 }, 4: { gridIdx: 4 } } });
  const args = [client, { MoveFleetsToCityRequest: {}, CityState: { CTS_BATTLING: 2 } }, config, player, {}, ledger];
  const preview = (cityId = 2) => previewWorldCityDispatch(...args, { scenarioId: 1, cityId }, { mapLoader });
  const run = (view, opts) => runWorldCityDispatch(...args, { scenarioId: 1, buildingId: fleet.buildingId, ...view }, { mapLoader, ...opts });
  return { client, writes, reads, fleet, ledger, preview, run };
}

try {
  {
    const f = fixture(), building = f.reads.OnWaterRequest.building[0];
    const add = (n, changes, parts = {}) => {
      const buildingId = n + '远征船';
      f.reads.MyFleetsRequest.fleets.unshift({ ...f.fleet, buildingId, ...changes });
      f.reads.OnWaterRequest.building.push({ ...building, buildingId, ...parts });
    };
    add(2, { state: 2 }); add(3, { state: 3 }); add(4, { state: 4 }); add(5, { state: 5 });
    add(6, { curGridIdx: 8 }); add(7, { cityId: 2 }); add(8, {}, { fleet: {} });
    add(9, { owner: { playerId: '999' } }); add(10, {}, { level: 0 });
    add(11, { durability: 0 }); add(12, { state: 99 }); add(13, {});
    add(14, { treasureLootUid: 42 }); add(15, { chipWar: { rewardTs: 42 } }); add(16, {});
    registerFleetReservations(f.client, 'test', id => id === '13远征船');
    f.ledger.reserve({}, {}, {}, { uniqueKey: 'cityWar:2003:16', details: { kind: 'cityDispatch', buildingId: '16远征船' } });
    const view = await f.preview();
    assert.deepEqual(view.fleetChoices.map(choice => [parseInt(choice.buildingId, 10), choice.status]), [
      [1, '空闲'], [2, '行军中'], [3, '战斗中'], [4, '维修中'], [5, '排队中'], [6, '驻守在外'],
      [7, '已在此城'], [8, '未编队'], [11, '耐久不足'], [12, '未知'], [13, '已预留'],
      [14, '货轮任务中'], [15, '矿场任务中'], [16, '任务占用'],
    ]);
    assert.deepEqual(view.fleetChoices.filter(choice => choice.available).map(choice => choice.buildingId), ['1远征船']);
    assert.deepEqual(view.fleets.map(choice => choice.buildingId), ['1远征船']);
    await assert.rejects(f.run({ ...view, buildingId: '2远征船' }), /无法派遣/);
    assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture();
    f.reads.WarDeclarationRequest = null;
    f.reads.AllItemRequest = null;
    const view = await f.preview();
    assert.deepEqual([view.role, view.intent, view.cost, view.fleets.length], ['defence', 'relocate', 0, 1]);
    assert.equal((await f.preview(1)).fleets.length, 0, '不能发送到当前城');
    assert.deepEqual(await f.run(view), { status: 'confirmed', message: '远征舰队 1 队已派往海星港' });
    assert.deepEqual(f.writes, [{ name: 'MoveFleetsToCityRequest', body: { buildingId: ['1远征船'], cityId: 2 } }]);
    assert.equal((await f.preview(1)).fleets.length, 0, '行军不占第二个城市');
    Object.assign(f.fleet, { state: 1, cityId: 2, targetCityId: 0 });
    const saved = f.ledger.keyRecords();
    const home = await f.preview(1);
    assert.equal(home.fleets.length, 1, '调往己城后空闲可再次选择');
    assert.deepEqual(f.ledger.keyRecords(), saved, '预览不得释放已返港的锁');
    assert.equal((await f.run(home)).status, 'confirmed', '下次手动调动实际释放旧记录');
  }
  {
    const f = fixture();
    const peace = await f.preview();
    f.reads.WarDeclarationRequest.declarations.push({ cityId: 2, attackGuildIdx: 2, defenceGuildIdx: 1 });
    f.reads.WarDeclarationRequest.startTime += 300;
    await assert.rejects(f.run(peace), /攻防状态/);
    const reinforcement = await f.preview();
    assert.deepEqual([reinforcement.intent, reinforcement.cost], ['reinforce', 0]);
    f.reads.WarDeclarationRequest.declarations.pop();
    await assert.rejects(f.run(reinforcement), /攻防状态/);
    f.reads.WorldInfoRequest.cities[1].state = 2;
    assert.match((await f.run(reinforcement)).message, /增援防守/);
  }
  {
    const f = fixture(), view = await f.preview(4);
    assert.deepEqual([view.role, view.cost, view.owner], ['attack', 40, 2]);
    assert.match((await f.preview(3)).reason, /主城/);
    f.reads.WorldInfoRequest.cities[3].guildIdx = 0;
    f.reads.WarDeclarationRequest.declarations[0].defenceGuildIdx = 0;
    await assert.rejects(f.run(view), /归属/);
    f.reads.WorldInfoRequest.cities[3].guildIdx = f.reads.WarDeclarationRequest.declarations[0].defenceGuildIdx = 2;
    f.reads.WarDeclarationRequest.endTime -= 105;
    assert.match((await f.preview(4)).reason, /城战时段/);
    f.reads.WarDeclarationRequest.declarations = [];
    assert.match((await f.preview(4)).reason, /尚未.*宣战/);
    assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture(), view = await f.preview(4);
    f.ledger.reserve({ radarPetrol: 1 });
    await assert.rejects(f.run(view), /汽油不足/);
    assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture();
    Object.assign(f.fleet, { durability: 1, autoFight: { isOn: true, todayTimes: 0 } });
    const view = await f.preview(4);
    assert.equal((await f.run(view)).status, 'confirmed');
    assert.deepEqual(f.writes.map(write => write.name), ['MoveFleetsToCityRequest']);
  }
  {
    const f = fixture();
    f.fleet.durability = 0;
    f.reads.WorldInfoRequest.cities[0].state = 2;
    const view = await f.preview(4);
    assert.equal(view.fleets.length, 1, '允许空闲的零耐久舰队从交战城调离');
    f.reads.WorldInfoRequest.cities[0].state = 1;
    await assert.rejects(f.run(view), /空闲舰队/);
    assert.equal(f.writes.length, 0);
  }
  for (const changes of [{ state: 2 }, { state: 3 }, { state: 4 }, { state: 5 }, { curGridIdx: 1 },
    { chipWar: { rewardTs: 42 } }, { treasureLootUid: 44 }, { owner: { playerId: '303' } }, { durability: 0 }]) {
    const f = fixture(), view = await f.preview();
    Object.assign(f.fleet, changes);
    await assert.rejects(f.run(view), /空闲舰队/);
    assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture(), view = await f.preview();
    await assert.rejects(f.run(view, { validate() { throw Error('派遣已取消'); } }), /取消/);
    registerFleetReservations(f.client, 'test', () => true);
    await assert.rejects(f.run(view), /空闲舰队/);
    assert.deepEqual(f.ledger.keyRecords(), {});
  }
  {
    const f = fixture(), view = await f.preview(4);
    f.client.sendWatch = async () => { throw Object.assign(Error('拒绝'), { request: 'MoveFleetsToCityRequest', prompt: {} }); };
    assert.equal((await f.run(view)).status, 'rejected');
    assert.deepEqual(f.ledger.keyRecords(), {});
    f.client.sendWatch = async () => {};
    assert.equal((await f.run(view)).status, 'unknown');
    assert.equal(f.ledger.pendingCounters().cityWarPetrol, 40);
    assert.match((await f.preview(2)).reason, /空闲/);
    await assert.rejects(f.run(view));
    Object.assign(f.fleet, { state: 1, curGridIdx: 0, cityId: 4 });
    const relocated = await f.preview(2);
    assert.equal(relocated.fleets.length, 1, '迟到后已在目标城空闲是直接到达证据');
    assert.equal(f.ledger.pendingCounters().cityWarPetrol, 40, '预览维持持久汽油记录');
    f.client.sendWatch = async () => { Object.assign(f.fleet, { cityId: 2 }); };
    assert.equal((await f.run(relocated)).status, 'confirmed');
    assert.equal(f.ledger.pendingCounters().cityWarPetrol ?? 0, 0);
    assert.equal(f.ledger.confirmedCounters().cityWarPetrol, 40);
  }
  console.log('世界地图手动城池派遣离线验证通过');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
