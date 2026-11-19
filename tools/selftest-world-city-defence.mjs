import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { readWorldCityDefence, runWorldCityRecruit, reconcileWorldCityRecruit } from '../src/world-city-defence.mjs';
import { beginOrderMaterialSpend, cancelOrderMaterialSpend, pendingOrderMaterialSpends } from '../src/order-reservations.mjs';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-city-defence-'));
const itemId = '联盟募兵令';
let actor = 100;
function fixture() {
  const player = { playerId: ++actor, guildId: 1007, worldId: 12345, scenarioId: 1, vip: { vipLevel: 10 } };
  const target = { cityId: 2, scenarioId: 1 };
  const config = { tables: {
    '1_CityCfg': { data: [{ id: 1, guildIndex: 7, name: '主城' }, { id: 2, guildIndex: 0, name: '海星港' },
      { id: 3, guildIndex: 0, name: '蓝湾' }] },
    GuildParamCfg: { data: [{ paramName: '募兵令增加守军数', paramValue: 10 }] },
    VipLevelCfg: { data: [{ level: 0, effects: [] }, { level: 10, effects: [['联盟高级募兵', 1]] }] },
  } };
  const inventory = { itemId, num: 2 }, city = { cityId: 2, defenceNum: 100 };
  const replies = {
    GuildInfoRequest: { guild: { guildId: player.guildId }, myTitle: 1 },
    WorldInfoRequest: { cities: [1, 2, 3].map(id => ({ id, guildIdx: 7 })) },
    GuildCityInfoRequest: { cities: [city, { cityId: 3, defenceNum: 50 }] },
    CityDefenceRequest: { fleets: [{ name: '船长甲', guildIdx: 7, power: 123 }, { isNpc: true, guildIdx: 7, multiple: 3, power: { high: 2100000, low: 1 } }] },
    AllItemRequest: { items: [inventory] },
  };
  const protocol = createDeclaredProtocol(['CityRecruitDefenceRequest', ...Object.keys(replies).flatMap(name => [name, name.replace(/Request$/, 'Response')])]);
  const openLedger = () => createUsageLedger('test-' + player.playerId, { file: path.join(tmp, 'usage.json') });
  const ledger = openLedger();
  const writes = [];
  const client = { connected: true,
    async request(name, body, response) {
      assert.equal(name.replace('Request', 'Response'), response);
      assert(protocol[name], name);
      if (name === 'CityDefenceRequest') assert.deepEqual(Object.keys(body), ['cityId']);
      return structuredClone(replies[name]);
    },
    async sendWatch(name, body, options) {
      options.beforeSend();
      assert.equal(name, 'CityRecruitDefenceRequest');
      assert.deepEqual(body, { cityId: 2 });
      writes.push(name); inventory.num--; city.defenceNum += 10;
    },
  };
  const args = [client, protocol, config, player];
  const preview = (extra = {}) => readWorldCityDefence(...args, { ...target, ...extra }, { ledger });
  const run = (quote, options = {}) => runWorldCityRecruit(...args, { ...target, ...quote.recruit }, { ledger, ...options });
  const reconcile = (options = {}) => reconcileWorldCityRecruit(...args, target, { ledger, ...options });
  return { args, client, config, target, player, replies, inventory, city, ledger, openLedger, writes, preview, run, reconcile };
}

try {
  {
    const f = fixture(), q = await f.preview();
    assert(q.synced && q.recruit.allowed); assert.equal(q.recruit.stock, 2);
    assert.deepEqual(q.defenders.map(row => [row.name, row.power, row.count]), [['船长甲', 123, 1], ['海星港守军', String(2100000n * 2n**32n + 1n), 3]]);
    assert.equal((await f.run(q)).status, 'confirmed');
    assert.equal(f.inventory.num, 1); assert.equal(f.city.defenceNum, 110);
    await assert.rejects(f.run(q), /库存/);
    assert.equal((await f.run(await f.preview())).status, 'confirmed');
    assert.equal(f.ledger.confirmedCounters().manualCityRecruitTokens, 2);
    assert.equal((await f.preview()).recruit.allowed, false);
    assert.equal(f.writes.length, 2);
  }
  {
    const f = fixture();
    delete f.replies.CityDefenceRequest;
    const q = await f.preview(); assert(!q.synced && q.recruit.allowed);
    f.replies.AllItemRequest.items.push({ itemId: '木材', num: -1 });
    assert.equal((await f.preview()).recruit.allowed, true, '无关道具缺损不阻止募兵');
    f.replies.AllItemRequest.items.push({ ...f.inventory });
    assert.equal((await f.preview()).recruit.allowed, false, '重复的募兵令记录不报价');
    f.replies.AllItemRequest.items.pop();
    const old = f.replies.GuildCityInfoRequest;
    f.replies.CityDefenceRequest = { fleets: [] }; f.replies.GuildCityInfoRequest = null;
    const roster = await f.preview();
    assert(roster.synced && !roster.recruit.allowed);
    f.replies.GuildCityInfoRequest = old;
    f.player.vip.vipLevel = 9;
    assert.match((await f.preview()).recruit.reason, /VIP10/); await assert.rejects(f.run(q), /VIP10/);
    f.player.vip.vipLevel = 7; assert.equal((await f.preview()).recruit.visible, false);
    f.player.vip.vipLevel = 10; assert.equal((await f.preview({ cityId: 1 })).recruit.visible, false);
    f.replies.WorldInfoRequest.cities[1].guildIdx = 8;
    assert.equal((await f.preview()).synced, true);
    await assert.rejects(f.run(q), /本盟/);
    assert.equal(f.writes.length, 0);
  }
  for (const change of [f => { f.replies.GuildCityInfoRequest.cities = []; },
    f => { f.config.tables.GuildParamCfg.data[0].paramValue++; },
    f => { f.replies.GuildInfoRequest.guild.guildId++; },
    f => { f.inventory.num = 0; }]) {
    const f = fixture(), q = await f.preview();
    change(f); await assert.rejects(f.run(q)); assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture(), q = await f.preview();
    const debit = beginOrderMaterialSpend(f.player, [{ id: itemId, have: 2, need: 1 }], '测试占用', { operation: {} });
    try {
      assert.equal((await f.preview()).recruit.allowed, false);
      await assert.rejects(f.run(q), /扣款/);
    } finally { cancelOrderMaterialSpend(debit); }
    assert.deepEqual(f.ledger.keyRecords(), {}); assert.equal(f.writes.length, 0);
    f.client.sendWatch = async () => { throw Object.assign(Error('明确拒绝'), { request: 'CityRecruitDefenceRequest', prompt: {} }); };
    await assert.rejects(f.run(q), /明确拒绝/); assert.deepEqual(f.ledger.keyRecords(), {});
  }
  {
    const f = fixture(), q = await f.preview();
    f.client.sendWatch = async () => { f.writes.push('send'); f.city.defenceNum += 10; };
    assert.equal((await f.run(q)).status, 'unknown', '其他盟友同城募兵不能单独证明本人的操作');
    assert.equal((await f.preview()).recruit.pending, true); await assert.rejects(f.run(q), /请核对/);
    assert.equal((await f.preview({ cityId: 3 })).recruit.allowed, false);
    assert.equal((await f.reconcile()).status, 'unknown');
    f.city.defenceNum -= 10; f.inventory.num--;
    assert.equal((await f.reconcile()).status, 'unknown', '只有个人道具扣减不能确认目标城');
    f.city.defenceNum += 10;
    const [client, ...rest] = f.args;
    assert.equal((await reconcileWorldCityRecruit({ ...client }, ...rest, f.target, { ledger: f.openLedger() })).status, 'confirmed');
    assert.equal(f.writes.length, 1);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0, '重连核对后同时释放本地材料占用');
    assert.deepEqual(f.ledger.keyRecords(), {}); assert.equal((await f.preview()).recruit.allowed, true);
  }
  {
    const f = fixture(), q = await f.preview(), sendWatch = f.client.sendWatch;
    f.client.sendWatch = async () => {};
    assert.equal((await f.run(q)).status, 'unknown');
    // 模拟另一进程已查到两项证据，核销同一个持久票据；当前进程还留有旧材料句柄。
    f.city.defenceNum += 10; f.inventory.num--;
    const ledger = f.openLedger(), [[key, record]] = Object.entries(ledger.keyRecords());
    ledger.confirm({ id: record.id }); ledger.releaseCompletedKey(key);
    const next = await f.preview(); assert(next.recruit.allowed);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 1, '预览维持原材料句柄');
    f.client.sendWatch = sendWatch;
    assert.equal((await f.run(next)).status, 'confirmed'); assert.equal(f.writes.length, 1);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  }
  console.log('通过：守军列表、城池归属、募兵令库存与 VIP、占用和回读核对');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
