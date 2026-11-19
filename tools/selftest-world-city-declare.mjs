import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCityDeclare, declareCity, readCityCancelDeclare, cancelCityDeclare, reconcileCityCancelDeclare } from '../src/world-city-declare.mjs';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'city-declare-'));
let cases = 0;
function fixture() {
  const player = { playerId: 12, guildId: 1001, worldId: 1000001, scenarioId: 1 };
  const target = { cityId: 2, scenarioId: 1, owner: 0, guildId: '1001' };
  const definition = { id: 2, guildIndex: 0, level: 3, name: '哨塔' };
  const pricing = { paramName: '取消宣战消耗', paramValue: 200 };
  const config = { tables: { '1_CityCfg': { data: [definition] }, '1_SeasonTaskCfg': { data: [{ season: 1, stage: 1, maxCityLevel: 3 }] },
    WorldParamCfg: { data: [pricing] } } };
  const world = { cities: [{ id: 1, guildIdx: 1 }, { id: 2, guildIdx: 0 }], blackWaterId: '' };
  const epoch = Math.floor(Date.now() / 1000);
  const war = { declarations: [], startTime: epoch - 86400, endTime: epoch - 80000 };
  const guild = { myTitle: 5, guild: { guildId: 1001 } };
  const stage = { stage: 1 }, fort = { forts: [] };
  const ruby = { res: 4, amount: 555 };
  const responses = { GuildInfoRequest: guild, WorldInfoRequest: world, WarDeclarationRequest: war,
    SeasonTaskStageRequest: stage, FortListRequest: fort, AllResourceRequest: { list: [ruby] } };
  const protocol = createDeclaredProtocol(['DeclareWarRequest', 'CancelDeclareWarRequest',
    ...Object.keys(responses).flatMap(name => [name, name.replace(/Request$/, 'Response')])]);
  const map = { cityInfo: { 2: { neighbors: [1] } }, pollutionData: [{ id: '黑潮1', citys: [1] }] };
  const options = { ledger: createUsageLedger('test-' + (++cases), { file: path.join(tmp, 'usage.json') }), mapLoader: async () => map };
  const writes = [];
  const declaration = { cityId: 2, attackGuildIdx: 1, defenceGuildIdx: 0 };
  const client = {
    async request(name, body, response) {
      assert.equal(response, name.replace(/Request$/, 'Response'));
      assert(Object.hasOwn(responses, name), name);
      return structuredClone(responses[name]);
    },
    async sendWatch(name, body) {
      assert.equal(name, 'DeclareWarRequest');
      assert.deepEqual(body, { cityId: 2 });
      writes.push(name);
      war.declarations.push(declaration);
    },
  };
  const read = () => readCityDeclare(client, protocol, config, player, target, options);
  const run = () => declareCity(client, protocol, config, player, target, options);
  const args = [client, protocol, config, player];
  const previewCancel = () => readCityCancelDeclare(...args, target, options);
  const cancel = quote => cancelCityDeclare(...args, { ...target, ...quote }, options);
  const reconcile = () => reconcileCityCancelDeclare(...args, target, options);
  return { definition, world, guild, war, fort, stage, map, options, writes, declaration, client, target, read, run,
    pricing, ruby, previewCancel, cancel, reconcile, player };
}

function cancelFixture() {
  const f = fixture(), now = Math.floor(Date.now() / 1000);
  f.war.declarations = [f.declaration, { ...f.declaration, cityId: 3 }];
  Object.assign(f.war, { startTime: now - 300, endTime: now + 3600 });
  f.client.sendWatch = async (name, body, options) => {
    options.beforeSend?.();
    assert.equal(name, 'CancelDeclareWarRequest');
    assert.deepEqual(body, { cityId: 2 });
    f.writes.push(name);
    f.ruby.amount -= f.pricing.paramValue;
    f.war.declarations = f.war.declarations.filter(row => row.cityId !== body.cityId);
  };
  return f;
}

try {
  for (const title of [4, 5]) {
    const f = fixture();
    f.guild.myTitle = title;
    const view = await f.read();
    assert.deepEqual([view.visible, view.available, view.count, view.limit], [true, true, 0, 3]);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(await f.run(), { confirmed: true, message: '已确认本盟向哨塔宣战' });
    const record = f.options.ledger.keyRecords();
    await assert.rejects(f.run(), /已向该城池宣战/);
    assert.deepEqual(f.options.ledger.keyRecords(), record);
    assert.equal(f.writes.length, 1);
  }
  // CityMenuPop checks the war window for moving an attacking fleet. Declaring
  // goes through its own button both before the battle and after it has begun.
  for (const startOffset of [3600, -1800]) {
    const f = fixture();
    f.war.startTime = Math.floor(Date.now() / 1000) + startOffset;
    f.war.endTime = f.war.startTime + 3600;
    assert((await f.read()).available);
    assert((await f.run()).confirmed);
  }
  for (const title of [1, 2, 3, 6, null]) {
    const f = fixture();
    assert((await f.read()).available);
    f.guild.myTitle = title;
    assert.equal((await f.read()).visible, false);
    await assert.rejects(f.run(), /仅盟主/);
    assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture();
    const read = f.client.request;
    f.client.request = async (...args) => {
      const value = await read(...args);
      // An omitted protobuf enum inherits BLACK=1 from the message prototype.
      return args[0] === 'WorldInfoRequest' ? Object.assign(Object.create({ myGuildTitle: 1 }), value) : value;
    };
    assert((await f.read()).available);
    f.world.myGuildTitle = 2;
    await assert.rejects(f.run(), /仅盟主/);
    assert.deepEqual(f.writes, []);
  }
  for (const [change, reason] of [
    [f => { f.world.cities[1].guildIdx = 1; }, /属于本盟/],
    [f => { f.definition.guildIndex = 3; }, /联盟主城/],
    [f => { f.world.cities[0].guildIdx = 2; }, /相邻/],
    [f => { f.world.blackWaterId = '黑潮1'; }, /非黑潮城池相邻/],
    [f => { f.world.blackWaterId = '黑潮1'; f.map.pollutionData[0].citys = [2]; }, /无法向黑潮城池/],
    [f => { f.war.declarations = [3, 4, 5].map(cityId => ({ cityId, attackGuildIdx: 1 })); }, /已有 3 个/],
    [f => { f.definition.level++; }, /阶段尚未解锁/],
    [f => { f.fort.forts.push({ cityId: 2, type: '干扰器' }); }, /有干扰器/],
    [f => { f.world.cities[1].guildIdx = 3; }, /归属或本盟身份已变化/],
    [f => { f.guild.guild.guildId = 2001; }, /联盟身份已变化/],
    [f => { f.options.validate = () => { throw new Error('已切号'); }; }, /已切号/],
  ]) {
    const f = fixture();
    assert((await f.read()).available);
    change(f);
    await assert.rejects(f.run(), reason);
    assert.deepEqual(f.writes, []);
  }
  for (const regain of ['observed', 'nextPeriod']) {
    const f = fixture();
    f.client.sendWatch = async () => { f.writes.push('send'); throw Error('连接中断'); };
    assert.equal((await f.run()).confirmed, false);
    const pending = f.options.ledger.keyRecords();
    assert.equal(f.options.ledger.snapshot().uncertain, 1);
    await assert.rejects(f.run(), /上次宣战结果待确认/);
    if (regain === 'observed') {
      f.war.declarations.push(f.declaration);
      assert.match((await f.read()).reason, /已向该城池宣战/);
      f.war.declarations = [];
    } else {
      f.war.startTime = f.war.endTime + 100;
      f.war.endTime += 86400;
    }
    assert.equal((await f.read()).available, true);
    assert.deepEqual(f.options.ledger.keyRecords(), pending);
    f.client.sendWatch = async () => { f.writes.push('send'); f.war.declarations.push(f.declaration); };
    assert.equal((await f.run()).confirmed, true);
    assert.deepEqual(f.writes, ['send', 'send']);
    assert.equal(f.options.ledger.snapshot().uncertain, 0);
  }
  {
    const f = fixture();
    f.client.sendWatch = async () => { throw Object.assign(Error('服务器拒绝'), { request: 'DeclareWarRequest', prompt: {} }); };
    await assert.rejects(f.run(), /服务器拒绝/);
    assert.deepEqual(f.options.ledger.keyRecords(), {});
  }
  for (const title of [4, 5]) {
    const f = cancelFixture();
    f.guild.myTitle = title;
    const quote = await f.previewCancel();
    assert.deepEqual([quote.visible, quote.available, quote.cost, quote.count, quote.pending], [true, true, 200, 2, false]);
    assert.deepEqual(f.writes, []);
    assert.equal((await f.cancel(quote)).confirmed, true);
    assert.equal(f.ruby.amount, 355);
    assert.equal(f.options.ledger.confirmedCounters().diamonds, 200);
    f.war.declarations.push(f.declaration);
    await assert.rejects(f.cancel(quote), /已变化/);
    const next = await f.previewCancel();
    assert(next.previousId);
    assert.equal((await f.cancel(next)).confirmed, true);
    assert.equal(f.writes.length, 2);
  }
  for (const [change, reason] of [
    [f => { f.guild.myTitle = 3; }, /仅盟主/],
    [f => { f.world.myGuildTitle = 1; }, /仅盟主/],
    [f => { f.war.declarations[1].attackGuildIdx = 3; }, /至少一个/],
    [f => { f.world.cities[1].guildIdx = 1; }, /非主城/],
    [f => { f.world.cities[1].guildIdx = 3; }, /不一致/],
    [f => { f.definition.guildIndex = 3; }, /非主城/],
    [f => { f.ruby.amount = 199; }, /钻石不足/],
    [f => { f.options.ledger.reserve({ diamonds: 400 }); }, /钻石不足/],
    [f => { f.pricing.paramValue = 210; }, /费用.*变化/],
    [f => { f.war.startTime--; }, /已变化/],
    [f => { f.options.validate = () => { throw Error('已暂停'); }; }, /已暂停/],
  ]) {
    const f = cancelFixture(), quote = await f.previewCancel();
    change(f);
    await assert.rejects(f.cancel(quote), reason);
    assert.deepEqual(f.writes, []);
  }
  {
    const f = cancelFixture(), quote = await f.previewCancel();
    f.client.sendWatch = async () => { throw Object.assign(Error('服务器拒绝'), { request: 'CancelDeclareWarRequest', prompt: {} }); };
    await assert.rejects(f.cancel(quote), /服务器拒绝/);
    assert.deepEqual(f.options.ledger.pendingCounters(), {});
    assert.deepEqual(f.options.ledger.keyRecords(), {});
  }
  {
    const f = cancelFixture(), quote = await f.previewCancel();
    f.client.sendWatch = async (_name, _body, { beforeSend }) => {
      f.client.serverClockOffsetMs = 3600001;
      try { beforeSend(); } catch (error) { throw Object.assign(error, { notSent: true }); }
      assert.fail('城战换期后不应使用原报价发出请求');
    };
    await assert.rejects(f.cancel(quote), /时段已结束/);
    assert.deepEqual(f.options.ledger.keyRecords(), {});
  }
  for (const kind of ['sameTarget', 'noDebit', 'ownerChanged', 'guildChanged', 'newWar', 'warExpired', 'lateRead']) {
    const f = cancelFixture(), quote = await f.previewCancel();
    const send = f.client.sendWatch;
    f.client.sendWatch = async (...args) => {
      await send(...args);
      if (kind === 'sameTarget') f.war.declarations.push(f.declaration);
      if (kind === 'noDebit' || kind === 'lateRead') f.ruby.amount += 200;
      if (kind === 'ownerChanged') f.world.cities[1].guildIdx = 9;
      if (kind === 'guildChanged') f.guild.guild.guildId = 2001;
      if (kind === 'newWar') { f.war.startTime += 86400; f.war.endTime += 86400; }
      if (kind === 'warExpired') f.client.serverClockOffsetMs = 3600001;
      throw Error('等待回执超时');
    };
    assert.equal((await f.cancel(quote)).confirmed, false, kind);
    const before = f.options.ledger.keyRecords();
    assert.equal((await f.previewCancel()).pending, true, kind);
    assert.deepEqual(f.options.ledger.keyRecords(), before, '预览只读');
    assert.equal(f.options.ledger.pendingCounters().diamonds, 200, kind);
    assert.equal(f.options.ledger.confirmedCounters().diamonds ?? 0, 0, kind);
    if (kind === 'lateRead') {
      f.ruby.amount -= 200;
      f.guild.myTitle = 2;
      assert.equal((await f.reconcile()).confirmed, true);
      assert.equal((await f.previewCancel()).pending, false);
      assert.equal(f.options.ledger.confirmedCounters().diamonds, 200);
    } else {
      assert.equal((await f.reconcile()).confirmed, false, kind);
      assert.deepEqual(f.options.ledger.keyRecords(), before);
    }
    await assert.rejects(f.cancel(quote));
    assert.equal(f.writes.length, 1, kind);
  }
  console.log('城池宣战与付费撤销 ' + cases + ' 组通过');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
