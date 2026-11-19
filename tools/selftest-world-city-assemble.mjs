import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleCity, readCityAssemble } from '../src/world-city-assemble.mjs';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-city-assemble-'));
let count = 0;
function fixture() {
  const ledger = createUsageLedger('集结' + (++count), { file: path.join(tmp, 'cases.json') });
  const player = { worldId: '1000001', playerId: '12', guildId: '1001', scenarioId: 1 };
  const cities = [1, 2, 3, 4].map((id, i) => ({ id, name: ['主城', '船坞', '码头', '哨塔'][i], guildIndex: id === 1 ? 1 : 0 }));
  const config = { tables: { '1_CityCfg': { data: cities } } };
  const guild = { myTitle: 5, guild: { guildId: player.guildId } };
  const world = { cities: [{ id: 1, guildIdx: 1 }, { id: 2, guildIdx: 2 }, { id: 3, guildIdx: 1 }, { id: 4, guildIdx: 0 }] };
  const now = Math.floor(Date.now() / 1000);
  const war = { assembleCityId: 0, startTime: now + 3600, endTime: now + 7200, declarations: [
    { cityId: 2, attackGuildIdx: 1, defenceGuildIdx: 2 }, { cityId: 3, attackGuildIdx: 2, defenceGuildIdx: 1 },
    { cityId: 4, attackGuildIdx: 2, defenceGuildIdx: 0 },
  ] };
  const responses = { GuildInfoRequest: guild, WorldInfoRequest: world, WarDeclarationRequest: war };
  const protocol = createDeclaredProtocol(['SetAssembleCityRequest',
    ...Object.keys(responses).flatMap(name => [name, name.replace(/Request$/, 'Response')])]);
  const writes = [];
  const client = {
    async request(name, body, response) {
      assert.equal(response, name.replace(/Request$/, 'Response'));
      assert(Object.hasOwn(responses, name), name);
      return structuredClone(responses[name]);
    },
    async sendWatch(name, body, { beforeSend }) {
      beforeSend?.();
      assert.equal(name, 'SetAssembleCityRequest'); assert.deepEqual(Object.keys(body), ['cityId']);
      writes.push(body.cityId); war.assembleCityId = body.cityId;
    },
  };
  const read = (cityId = 2, options = {}) => readCityAssemble(client, protocol, config, player, { cityId, scenarioId: 1 }, { ledger, ...options });
  const quote = async (cityId = 2) => {
    const { owner, guildId, role, currentCityId, available, reason } = await read(cityId);
    assert(available, reason);
    return { cityId, scenarioId: 1, owner, guildId, role, currentCityId };
  };
  const run = (target, overrides = {}) => assembleCity(client, protocol, config, player, target, { ledger, ...overrides });
  return { ledger, player, cities, guild, world, war, writes, client, read, quote, run };
}

try {
  for (const title of [4, 5]) {
    const f = fixture(); f.guild.myTitle = title;
    const first = await f.quote(); assert.equal(first.role, 'attack'); assert.equal(first.currentCityId, 0);
    assert.equal((await f.read(2)).currentName, '');
    assert.deepEqual(f.writes, []); assert.deepEqual(f.ledger.keyRecords(), {});
    assert.deepEqual(await f.run(first), { confirmed: true, message: '本盟集结目标已设为船坞' });
    await assert.rejects(f.run(first), /已是本盟集结/);
    f.war.startTime -= 7200;
    const second = await f.quote(3); assert.equal(second.role, 'defence');
    assert.equal(second.currentCityId, 2); assert.equal((await f.read(3)).currentName, '船坞');
    assert((await f.run(second)).confirmed);
    assert.deepEqual(f.writes, [2, 3]); assert.deepEqual(f.ledger.confirmedCounters(), {});
  }
  for (const title of [1, 2, 3, 6, null]) {
    const f = fixture(), target = await f.quote();
    f.guild.myTitle = title;
    assert.equal((await f.read()).visible, false); await assert.rejects(f.run(target), /仅盟主/);
    assert.deepEqual(f.writes, []);
  }
  {
    const f = fixture(), from = f.client.request;
    const read = await f.read(2, { request: async (...args) => {
      const value = await from(...args);
      return args[0] === 'WorldInfoRequest' ? Object.assign(Object.create({ myGuildTitle: 1 }), value) : value;
    } });
    assert(read.available, read.reason);
    assert.equal((await f.read(1)).visible, false);
    assert.equal((await f.read(4)).available, false);
    f.war.declarations.push({ attackGuildIdx: 1, defenceGuildIdx: 0, cityId: 4 });
    assert.equal((await f.read(4)).role, 'attack');
  }
  for (const [change, reason] of [
    [f => { f.guild.guild.guildId = '2001'; }, /联盟身份/],
    [f => { f.world.myGuildTitle = 2; }, /仅盟主/],
    [f => { f.player.scenarioId++; }, /场景/],
    [f => { f.war.assembleCityId = 3; }, /集结目标已变化/],
    [f => { f.war.declarations.shift(); }, /已宣战或正在受攻/],
    [f => { f.world.cities[1].guildIdx = 1; }, /已宣战或正在受攻/],
    [f => { f.cities[1].guildIndex = 2; }, /主城/],
    [f => { f.war.assembleCityId = -1; }, /未同步/],
  ]) {
    const f = fixture(), old = await f.quote(); change(f);
    await assert.rejects(f.run(old), reason);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.ledger.keyRecords(), {});
  }
  {
    const f = fixture(), old = await f.quote();
    f.client.sendWatch = async () => { throw Object.assign(Error('拒绝'), { prompt: {}, request: 'SetAssembleCityRequest' }); };
    await assert.rejects(f.run(old), /拒绝/); assert.deepEqual(f.ledger.keyRecords(), {});
    f.client.sendWatch = async () => { throw Object.assign(Error('已暂停'), { notSent: true }); };
    await assert.rejects(f.run(old), /已暂停/); assert.deepEqual(f.ledger.keyRecords(), {});
  }
  for (const resolve of ['changed', 'ended', 'nextWar']) {
    const f = fixture(), old = await f.quote(), send = f.client.sendWatch;
    f.client.sendWatch = async () => { f.writes.push(old.cityId); throw Error('网络中断'); };
    assert.equal((await f.run(old)).confirmed, false); assert.equal(f.ledger.snapshot().uncertain, 1);
    const saved = f.ledger.keyRecords(); await assert.rejects(f.run(old), /上次集结设置结果待确认/);
    assert.match((await f.read(3)).reason, /待确认/);
    if (resolve === 'changed') {
      f.war.assembleCityId = 2; assert.equal((await f.read(3)).available, true);
      f.war.assembleCityId = 0;
    } else if (resolve === 'ended') {
      const declaration = f.war.declarations.shift();
      assert.equal((await f.read(3)).available, true); f.war.declarations.push(declaration);
    } else {
      f.client.serverClockOffsetMs = 14400 * 1000; f.war.startTime += 86400; f.war.endTime += 86400;
    }
    const next = await f.quote(3); assert.deepEqual(f.ledger.keyRecords(), saved);
    f.client.sendWatch = send; assert((await f.run(next)).confirmed);
    assert.deepEqual(f.writes, [2, 3]); assert.equal(f.ledger.snapshot().uncertain, 0);
  }
  console.log('城池快捷集结 ' + count + ' 组通过');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
