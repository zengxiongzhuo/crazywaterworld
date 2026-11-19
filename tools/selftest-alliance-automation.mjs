import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-alliance-auto-'));
process.env.CW_DATA_DIR = root;
const { createUsageLedger } = await import('../src/automation-settings.mjs');
const { runAllianceAutomation, allianceRecruitDemand, readAllianceRecruitDemand, allianceExchangeMaterial } = await import('../src/alliance-automation.mjs');
const { guildMutualFixture } = await import('./fixtures/guild-mutual.mjs');
const { loadConfig } = await import('../src/config.mjs');
let serial = 0, passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('通过：' + name); };
const settings = () => ({ alliance: { enabled: true, recruit: false, recruitDailyLimit: 0, recruitProduction: false, mutual: true,
  mutualMode: 'custom', autoHelp: false, autoAsk: false, allowedMaterials: [], blockedMaterials: [], requestMaterials: [], memberKeywords: [],
  stockReserve: 0, helpDailyLimit: 20, askDailyLimit: 20, collectGifts: false, autoTech: false, techIds: [], techDailyLimit: 20 } });
function fixture() {
  const f = guildMutualFixture(), id = ++serial;
  f.player.playerId = String(9007199260000000n + BigInt(id));
  f.state.members[0].playerId = f.player.playerId;
  f.config.tables.CargoUnlockCfg = { data: [{ index: 1, playerLevel: 9 }] };
  f.state.workerOrder = []; f.state.before = null;
  const request = f.client.request;
  f.client.request = async (name, body, response) => {
    await f.state.before?.(name, body);
    if (name === 'OnWaterRequest') return { workerOrder: structuredClone(f.state.workerOrder), buildings: [] };
    if (name === 'WeekInfoRequest') return { activityTime: [] };
    if (name === 'CargoShipsRequest') return { ship: [] };
    return request(name, body, response);
  };
  f.settings = settings(); f.reports = []; f.file = path.join(root, id + '.json');
  f.ledger = createUsageLedger('fixture-' + id, { file: f.file });
  f.run = () => runAllianceAutomation(f.client, f.protocol, f.config, f.player, { getSettings: () => f.settings, ledger: f.ledger, enabled: () => true, report: row => f.reports.push(row) });
  f.gifts = () => f.state.writes.filter(row => row.name === 'GuildAidHelpRequest');
  f.asks = () => f.state.writes.filter(row => row.name === 'GuildAidAskRequest');
  return f;
}

function newSeasonRecruitFixture({ doneToday = 0, dailyLimit = 0, stock = 20 } = {}) {
  const f = fixture(), now = Math.floor(Date.now() / 1000);
  f.player.worldId = '2010000402';
  Object.assign(f.settings.alliance, { recruit: true, recruitProduction: true, recruitDailyLimit: dailyLimit, autoAsk: true, askDailyLimit: 1 });
  Object.assign(f.config.tables, {
    GuildOrderNumCfg: { data: [{ season: 1, playerLevel: 1, maxNum: -1 }, { season: 7, playerLevel: 1, maxNum: 2 }] },
    GuildOrderCfg: { data: [{ itemId: '木材' }] },
  });
  f.state.stock.木材 = stock; f.state.recruitCount = doneToday;
  const request = f.client.request;
  f.client.request = async (name, body, response) => {
    if (name === 'GuildOrderRequest') return { order: { requirements: [{ type: 0, id: '木材', num: 2 }], nextRefreshTime: now + 86400 } };
    if (name === 'GuildCityInfoRequest') return { cities: [{ cityId: 1, recommended: true }] };
    if (name === 'CounterInfoRequest') {
      const reply = await request(name, body, response);
      return { ...reply, counters: [...reply.counters, { type: 'DAILY_FINISH_GUILD_ORDER', num: f.state.recruitCount }] };
    }
    if (name === 'FinishGuildOrderRequest') {
      f.protocol[name].decode(f.protocol[name].encode(body).finish());
      f.state.writes.push({ name, body: structuredClone(body) });
      f.state.stock.木材 -= 2; f.state.recruitCount++;
      return { reward: { asset: [{ type: 1, id: '功勋', num: 10 }] } };
    }
    return request(name, body, response);
  };
  f.recruits = () => f.state.writes.filter(row => row.name === 'FinishGuildOrderRequest');
  f.demand = () => readAllianceRecruitDemand(f.client, f.protocol, f.config, f.player, f.settings, { ledger: f.ledger });
  return f;
}

try {
  await test('总开关关闭无游戏读取，分项关闭仍领取已有援助', async () => {
    const f = fixture(); f.settings.alliance.enabled = false; await f.run(); assert.equal(f.state.reads.length, 0);
    f.settings.alliance.enabled = true;
    f.state.own = [{ reqId: '123', reqItemId: '橡胶圈', endTime: Math.floor(Date.now() / 1000) + 30, helper: { playerId: f.friend, nickname: '盟友' } }];
    await f.run(); assert.equal(f.state.stock.橡胶圈, 2); assert.equal(f.gifts().length + f.asks().length, 0);
  });
  await test('实际协议大整数ID、大小写昵称、允许/禁止材料与库存保留共同筛选', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true; f.settings.alliance.memberKeywords = ['ALICE'];
    f.state.members[1].nickname = 'Alice-盟友'; f.settings.alliance.allowedMaterials = ['橡胶圈'];
    f.settings.alliance.stockReserve = 1; await f.run(); assert.equal(f.gifts().length, 0);
    f.settings.alliance.stockReserve = 0; f.settings.alliance.blockedMaterials = ['橡胶圈']; await f.run(); assert.equal(f.gifts().length, 0);
    f.settings.alliance.blockedMaterials = []; await f.run(); assert.equal(f.gifts().length, 1);
    assert.equal(f.gifts()[0].id, '9007199254750000'); assert.equal(f.ledger.snapshot().counters.guildAidGifts, 1);
  });
  await test('居民订单的同材料需求优先保留，不挪用帮助盟友', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true;
    f.state.workerOrder = [{ index: 1, requirements: [{ type: 0, id: '橡胶圈', num: 1 }] }];
    await f.run(); assert.equal(f.gifts().length, 0); assert.match(f.reports.at(-1).reason, /订单预留/);
  });
  await test('人工互助与自动互助共享当日上限，切换模式不重置', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true; f.settings.alliance.helpDailyLimit = 1;
    f.ledger.confirm(f.ledger.reserve({ guildAidGifts: 1 })); await f.run(); assert.equal(f.gifts().length, 0);
    f.settings.alliance.mutualMode = 'exchange'; await f.run(); assert.equal(f.gifts().length, 0);
  });
  await test('求助当轮连续发布到每日20次，无需领取，重复轮与重启不重复发布', async () => {
    const f = fixture(); f.settings.alliance.autoAsk = true; f.settings.alliance.requestMaterials = ['橡胶圈'];
    await f.run(); assert.equal(f.asks().length, 20); assert.equal(f.state.askUsed, 20);
    assert.equal(f.state.own.length, 20); assert.ok(f.state.own.every(row => !row.helper), '尚未收到任何回赠也应完成求助目标');
    assert.equal(f.ledger.snapshot().counters.guildAidAsks, 20);
    await f.run(); assert.equal(f.asks().length, 20);
    f.ledger = createUsageLedger('fixture-' + serial, { file: f.file });
    await f.run(); assert.equal(f.asks().length, 20);
  });
  await test('求助每日目标遵守游戏上限，手动已用次数只补差额，0禁用', async () => {
    for (const { target, gameLimit, used, expected } of [
      { target: 3, gameLimit: 20, used: 0, expected: 3 },
      { target: 25, gameLimit: 20, used: 0, expected: 20 },
      { target: 20, gameLimit: 8, used: 0, expected: 8 },
      { target: 5, gameLimit: 20, used: 2, expected: 3 },
      { target: 20, gameLimit: 20, used: 17, expected: 3 },
      { target: 2, gameLimit: 20, used: 4, expected: 0 },
      { target: 0, gameLimit: 20, used: 0, expected: 0 },
    ]) {
      const f = fixture(); Object.assign(f.settings.alliance, { autoAsk: true, requestMaterials: ['橡胶圈'], askDailyLimit: target });
      f.config.tables.GuildParamCfg.data[0].paramValue = gameLimit; f.state.askUsed = used;
      await f.run(); assert.equal(f.asks().length, expected, JSON.stringify({ target, gameLimit, used }));
      assert.equal(f.state.askUsed, used + expected);
      await f.run(); assert.equal(f.asks().length, expected, '每日目标不是每轮新增次数');
    }
  });
  await test('跨日重新计算求助与赠送额度，不沿用昨日已完成次数', async () => {
    const f = fixture(); Object.assign(f.settings.alliance, { autoAsk: true, autoHelp: true, requestMaterials: ['橡胶圈'], askDailyLimit: 3, helpDailyLimit: 2 });
    f.state.stock.橡胶圈 = 10;
    f.ledger = createUsageLedger('fixture-' + serial, { file: f.file, now: () => Date.now() + f.client.serverClockOffsetMs });
    const firstDay = f.ledger.snapshot().day;
    await f.run(); assert.equal(f.asks().length, 3); assert.equal(f.gifts().length, 2);
    f.client.serverClockOffsetMs = 86400000; f.state.askUsed = 0; f.state.own = [];
    for (const row of f.state.requests) row.endTime = Math.floor((Date.now() + f.client.serverClockOffsetMs) / 1000) + 3600;
    assert.notEqual(f.ledger.snapshot().day, firstDay);
    await f.run(); assert.equal(f.asks().length, 6); assert.equal(f.gifts().length, 4);
    assert.equal(f.ledger.snapshot().counters.guildAidAsks, 3); assert.equal(f.ledger.snapshot().counters.guildAidGifts, 2);
    await f.run(); assert.equal(f.asks().length, 6); assert.equal(f.gifts().length, 4);
  });
  await test('未选择求助材料只请求当前缺料，关闭赠送不影响求助', async () => {
    const f = fixture(); f.settings.alliance.autoAsk = true; await f.run(); assert.equal(f.asks().length, 0);
    f.state.stock.橡胶圈 = 0; f.state.workerOrder = [{ index: 1, requirements: [{ type: 0, id: '橡胶圈', num: 1 }] }];
    await f.run(); assert.equal(f.asks().length, 20); assert.equal(f.gifts().length, 0);
  });
  await test('贡献模式固定当前赛季材料，未开放时不回退；材料自定义原值保留', async () => {
    const f = fixture(); f.settings.alliance.autoAsk = true; f.settings.alliance.mutualMode = 'exchange'; f.settings.alliance.requestMaterials = ['木材'];
    assert.equal(allianceExchangeMaterial(f.player), '橡胶圈'); await f.run(); assert.equal(f.asks()[0].body.reqItemId, '橡胶圈');
    const g = fixture(); g.settings.alliance.autoAsk = true; g.settings.alliance.mutualMode = 'exchange'; g.player.worldId = '3002001';
    assert.equal(allianceExchangeMaterial(g.player), '珍珠胸针'); await g.run(); assert.equal(g.asks().length, 0);
    assert.deepEqual(f.settings.alliance.requestMaterials, ['木材']);
  });
  await test('主动求助不受赠送白黑名单限制，贡献帮助忽略隐藏白名单但仍守禁用和昵称', async () => {
    const f = fixture(); Object.assign(f.settings.alliance, { autoAsk: true, autoHelp: true, allowedMaterials: ['木材'], blockedMaterials: ['橡胶圈'], requestMaterials: ['橡胶圈'] });
    await f.run(); assert.equal(f.asks().length, 20); assert.equal(f.gifts().length, 0);
    const g = fixture(); Object.assign(g.settings.alliance, { mutualMode: 'exchange', autoAsk: true, autoHelp: true, allowedMaterials: ['木材'], requestMaterials: ['木材'], blockedMaterials: ['橡胶圈'] });
    await g.run(); assert.equal(g.asks()[0].body.reqItemId, '橡胶圈'); assert.equal(g.gifts().length, 0);
    g.settings.alliance.blockedMaterials = []; g.settings.alliance.memberKeywords = ['不存在']; await g.run(); assert.equal(g.gifts().length, 0);
    g.settings.alliance.memberKeywords = []; await g.run(); assert.equal(g.gifts().length, 1);
    assert.deepEqual(g.settings.alliance.allowedMaterials, ['木材']); assert.deepEqual(g.settings.alliance.requestMaterials, ['木材']);
  });
  await test('求助未知跨重启阻断，实际计数与新增请求到达后恢复', async () => {
    const f = fixture(); f.settings.alliance.autoAsk = true; f.settings.alliance.requestMaterials = ['橡胶圈']; f.state.failure = 'askUnknown';
    await f.run(); assert.equal(f.asks().length, 1); f.state.failure = ''; f.ledger = createUsageLedger('fixture-' + serial, { file: f.file });
    await f.run(); assert.equal(f.asks().length, 1);
    f.state.askUsed = 1; f.state.own.push({ reqId: '1001', reqItemId: '橡胶圈', endTime: Math.floor(Date.now() / 1000) + 60 });
    await f.run(); assert.equal(f.asks().length, 20); assert.equal(f.state.askUsed, 20); assert.equal(f.ledger.snapshot().uncertain, 0);
    await f.run(); assert.equal(f.asks().length, 20);
  });
  await test('求助已发布但回包未知，重启核实后仅补剩余次数', async () => {
    const f = fixture(); Object.assign(f.settings.alliance, { autoAsk: true, requestMaterials: ['橡胶圈'], askDailyLimit: 4 });
    f.state.failure = 'askAcceptedUnknown'; await f.run(); assert.equal(f.asks().length, 1); assert.equal(f.state.askUsed, 1);
    assert.equal(f.ledger.snapshot().uncertain, 1);
    f.state.failure = ''; f.ledger = createUsageLedger('fixture-' + serial, { file: f.file });
    await f.run(); assert.equal(f.asks().length, 4); assert.equal(f.state.askUsed, 4); assert.equal(f.ledger.snapshot().uncertain, 0);
    await f.run(); assert.equal(f.asks().length, 4);
  });
  await test('求助结果未知即使跨日重启也保留阻断，不借额度重置重复发送', async () => {
    const f = fixture(); Object.assign(f.settings.alliance, { autoAsk: true, requestMaterials: ['橡胶圈'] });
    f.state.failure = 'askUnknown'; await f.run(); assert.equal(f.asks().length, 1);
    f.client.serverClockOffsetMs = 86400000; f.state.failure = '';
    f.ledger = createUsageLedger('fixture-' + serial, { file: f.file, now: () => Date.now() + f.client.serverClockOffsetMs });
    await f.run(); assert.equal(f.asks().length, 1); assert.equal(f.ledger.snapshot().uncertain, 1);
  });
  await test('赠送未知与明确拒绝分别保留/释放持久预算', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true; f.state.failure = 'giftUnknown'; await f.run();
    assert.equal(f.gifts().length, 1); assert.equal(f.ledger.snapshot().counters.guildAidGifts, 1);
    f.state.failure = ''; f.ledger = createUsageLedger('fixture-' + serial, { file: f.file }); await f.run(); assert.equal(f.gifts().length, 1);
    const g = fixture(); g.settings.alliance.autoHelp = true; g.state.failure = 'giftReject'; await g.run(); assert.equal(g.ledger.snapshot().counters.guildAidGifts, 0);
    g.state.failure = ''; await g.run(); assert.equal(g.gifts().length, 2);
  });
  await test('读取期间改变参数或退出联盟时不继续发送', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true;
    f.state.before = name => { if (name === 'CounterInfoRequest') f.settings.alliance.stockReserve = 100; };
    await f.run(); assert.equal(f.gifts().length, 0);
    const g = fixture(); g.settings.alliance.autoAsk = true; g.settings.alliance.requestMaterials = ['橡胶圈'];
    g.state.before = name => { if (name === 'CounterInfoRequest') g.player.guildId = '999'; }; await g.run(); assert.equal(g.asks().length, 0);
  });
  await test('白天连续赠送，仍遵守材料、昵称筛选及库存保留', async () => {
    const f = fixture(); Object.assign(f.settings.alliance, { autoHelp: true, helpDailyLimit: 20, allowedMaterials: ['橡胶圈'] });
    const midnight = Math.floor((Date.now() + 28800000) / 86400000) * 86400000 - 28800000;
    const noon = midnight + 12 * 3600 * 1000;
    f.client.serverClockOffsetMs = noon - Date.now();
    f.ledger = createUsageLedger('fixture-' + serial, { file: f.file, now: () => Date.now() + f.client.serverClockOffsetMs });
    for (const row of f.state.requests) row.endTime = Math.floor(noon / 1000) + 3600;
    f.state.requests[0].reqItemId = '木材'; f.state.requests[1].asker.playerId = f.other;
    f.state.members[1].nickname = 'Alice-盟友'; f.state.members[2].nickname = '其他盟友';
    const expectedIds = f.state.requests.slice(2, 5).map(row => row.reqId);
    f.state.stock.橡胶圈 = 5; f.settings.alliance.stockReserve = 2;
    f.settings.alliance.memberKeywords = ['不匹配']; await f.run(); assert.equal(f.gifts().length, 0);
    f.settings.alliance.memberKeywords = ['ALICE']; await f.run(); assert.equal(f.gifts().length, 3); assert.equal(f.state.stock.橡胶圈, 2);
    assert.deepEqual(f.gifts().map(row => row.id), expectedIds); assert.equal(f.state.stock.木材, 20);
    await f.run(); assert.equal(f.gifts().length, 3);
  });
  await test('批量赠送到每日上限或候选用完，已赠送次数计入目标', async () => {
    for (const { target, used, candidates, expected } of [
      { target: 20, used: 0, candidates: 20, expected: 20 },
      { target: 5, used: 2, candidates: 20, expected: 3 },
      { target: 20, used: 0, candidates: 2, expected: 2 },
      { target: 0, used: 0, candidates: 20, expected: 0 },
    ]) {
      const f = fixture(); Object.assign(f.settings.alliance, { autoHelp: true, helpDailyLimit: target });
      f.state.stock.橡胶圈 = 25; f.state.requests = f.state.requests.slice(0, candidates);
      if (used) f.ledger.confirm(f.ledger.reserve({ guildAidGifts: used }));
      await f.run(); assert.equal(f.gifts().length, expected, JSON.stringify({ target, used, candidates }));
      assert.equal(f.state.stock.橡胶圈, 25 - expected);
      assert.equal(f.ledger.snapshot().counters.guildAidGifts ?? 0, used + expected);
      f.ledger = createUsageLedger('fixture-' + serial, { file: f.file });
      await f.run(); assert.equal(f.gifts().length, expected, '重启不重置每日赠送额度');
    }
  });
  await test('批量赠送逐次保留居民订单物料，不因连续发送耗尽预留', async () => {
    const f = fixture(); f.settings.alliance.autoHelp = true; f.state.stock.橡胶圈 = 5;
    f.state.workerOrder = [{ index: 1, requirements: [{ type: 0, id: '橡胶圈', num: 2 }] }];
    await f.run(); assert.equal(f.gifts().length, 3); assert.equal(f.state.stock.橡胶圈, 2);
    await f.run(); assert.equal(f.gifts().length, 3);
  });
  await test('批量执行中关闭求助或赠送开关立即停止，已发送首条留待下轮核销', async () => {
    const f = fixture(); Object.assign(f.settings.alliance, { autoAsk: true, requestMaterials: ['橡胶圈'] });
    f.state.before = name => { if (name === 'CounterInfoRequest' && f.asks().length === 1) f.settings.alliance.autoAsk = false; };
    await f.run(); assert.equal(f.asks().length, 1); assert.equal(f.state.askUsed, 1);
    assert.equal(f.ledger.snapshot().uncertain, 1);
    await f.run(); assert.equal(f.asks().length, 1); assert.equal(f.ledger.snapshot().uncertain, 0);
    const g = fixture(); g.settings.alliance.autoHelp = true; g.state.stock.橡胶圈 = 20;
    g.state.onGift = () => { g.settings.alliance.autoHelp = false; };
    await g.run(); assert.equal(g.gifts().length, 1); assert.equal(g.state.stock.橡胶圈, 19);
    assert.equal(g.ledger.snapshot().uncertain, 1);
    await g.run(); assert.equal(g.gifts().length, 1); assert.equal(g.ledger.snapshot().uncertain, 0);
  });
  await test('批量求助中调低每日目标，后续发送立即遵守新目标', async () => {
    const f = fixture(); Object.assign(f.settings.alliance, { autoAsk: true, requestMaterials: ['橡胶圈'] });
    f.state.before = name => { if (name === 'CounterInfoRequest' && f.asks().length === 2) f.settings.alliance.askDailyLimit = 2; };
    await f.run(); assert.equal(f.asks().length, 2); assert.equal(f.state.askUsed, 2);
  });
  await test('募兵需求到用户上限或游戏上限即停止，缺料补产只准备当前订单', async () => {
    const s = settings(); Object.assign(s.alliance, { recruit: true, recruitProduction: true, recruitDailyLimit: 2 });
    const view = { doneToday: 1, day: 1, cityId: 1, maxNum: 10, nextRefreshTime: 200, checkedAt: 100, requirements: [{ id: '木材', need: 3, reserved: 2 }] };
    assert.deepEqual(allianceRecruitDemand(view, s), [{ source: 'guildRecruit', requirements: [{ id: '木材', num: 3 }], reserved: [{ id: '木材', num: 2 }] }]);
    assert.deepEqual(allianceRecruitDemand({ ...view, doneToday: 2 }, s), []);
    assert.deepEqual(allianceRecruitDemand({ ...view, maxNum: 1 }, s), []);
    assert.deepEqual(allianceRecruitDemand(view, s, { counters: { guildRecruit: 2 } }), []);
    s.alliance.recruitDailyLimit = 0; assert.equal(allianceRecruitDemand(view, s).length, 1);
    assert.deepEqual(allianceRecruitDemand({ ...view, nextRefreshTime: 50 }, s), []);
  });
  await test('S10缺少专属配置时自动募兵、备料和默认缺料求助共用旧赛季额度', async () => {
    const ready = newSeasonRecruitFixture();
    await ready.run();
    assert.deepEqual(ready.recruits().map(row => row.body), [{ cityId: 1 }]);
    assert.equal(ready.ledger.snapshot().counters.guildRecruit, 1);
    assert.equal(ready.asks().length, 0, '材料充足时不因募兵产生求助');
    assert.ok(ready.reports.every(row => !row.error));

    const missing = newSeasonRecruitFixture({ stock: 0 });
    assert.deepEqual(await missing.demand(), [{ source: 'guildRecruit', requirements: [{ id: '木材', num: 2 }], reserved: [{ id: '木材', num: 0 }] }]);
    await missing.run();
    assert.equal(missing.recruits().length, 0, '缺料时只备料和求助，不提交募兵');
    assert.equal(missing.asks().length, 1);
    assert.equal(missing.asks()[0].body.reqItemId, '木材', '未指定材料时沿用当前募兵缺料');
    assert.ok(missing.reports.every(row => !row.error));
  });
  await test('S10回退额度仍限制自动募兵、备料和默认缺料求助', async () => {
    for (const options of [{ doneToday: 2 }, { doneToday: 1, dailyLimit: 1 }]) {
      const f = newSeasonRecruitFixture(options);
      assert.deepEqual(await f.demand(), [], JSON.stringify(options));
      await f.run();
      assert.equal(f.recruits().length, 0, '材料充足也不能超出游戏或用户额度');
      assert.ok(f.reports.some(row => /上限/.test(row.reason ?? '')));
      f.state.stock.木材 = 0;
      assert.deepEqual(await f.demand(), []);
      await f.run();
      assert.equal(f.asks().length, 0, '达到额度后不为下一次募兵求助');
      assert.equal(f.recruits().length, 0);
      assert.ok(f.reports.every(row => !row.error));
    }
  });
  await test('S10联盟募兵未知请求在重建账本后阻止写入和备料，服务端计数可核销', async () => {
    const f = fixture(), now = Math.floor(Date.now() / 1000);
    f.player.worldId = '2010000402';
    Object.assign(f.settings.alliance, { recruit: true, recruitProduction: true, mutual: false });
    Object.assign(f.config.tables, { GuildOrderNumCfg: { data: [{ season: 2, playerLevel: 1, maxNum: 10 }] }, GuildOrderCfg: { data: [{ itemId: '木材' }] } });
    let count = 0, writes = 0, unknown = true;
    const request = f.client.request;
    f.client.request = async (name, body, response) => {
      if (name === 'GuildOrderRequest') return { order: { requirements: [{ type: 0, id: '木材', num: 2 }], nextRefreshTime: now + 86400 } };
      if (name === 'GuildCityInfoRequest') return { cities: [{ cityId: 1, recommended: true }] };
      if (name === 'CounterInfoRequest') return { counters: [{ type: 'DAILY_FINISH_GUILD_ORDER', num: count }] };
      if (name === 'FinishGuildOrderRequest') { f.protocol[name].decode(f.protocol[name].encode(body).finish()); writes++; if (unknown) throw Error('回包未知'); count++; return { reward: { asset: [{ type: 1, id: '功勋', num: 10 }] } }; }
      return request(name, body, response);
    };
    await f.run(); assert.equal(writes, 1); assert.equal(f.ledger.snapshot().counters.guildRecruit, 1);
    f.ledger = createUsageLedger('fixture-' + serial, { file: f.file }); await f.run(); assert.equal(writes, 1);
    assert.deepEqual(await readAllianceRecruitDemand(f.client, f.protocol, f.config, f.player, f.settings, { ledger: f.ledger }), []);
    count = 1; unknown = false; await f.run(); await f.run(); assert.equal(writes, 2);
  });
  await test('科技自动升级遵守选择、单级回执、持久日上限与未发送释放', async () => {
    const f = fixture(), actual = loadConfig(); f.settings.alliance.mutual = false; f.settings.alliance.autoTech = true;
    f.settings.alliance.techIds = ['2010102']; f.settings.alliance.techDailyLimit = 1;
    for (const name of ['GuildTechCfg', 'TechUnlockCfg', 'AdditionAttrOverviewCfg']) f.config.tables[name] = actual.tables[name];
    let level = 0, writes = 0;
    const request = f.client.request;
    f.client.request = async (name, body, response) => {
      if (name === 'GuildTechInfoRequest') return { tech: [{ techId: 2010101, level: 10 }, { techId: 2010102, level }] };
      if (name === 'SeasonTaskStageRequest') return { stage: 0 };
      if (name === 'AllItemRequest') return { items: [{ itemId: '公会科技点', num: 1000000 }, { itemId: '联盟职级科技点', num: 1000000 }] };
      if (name === 'UpgradeGuildTechRequest') { f.protocol[name].decode(f.protocol[name].encode(body).finish()); writes++; level++; return { tech: { techId: body.techId, level } }; }
      return request(name, body, response);
    };
    await f.run(); assert.equal(writes, 1); await f.run(); assert.equal(writes, 1); assert.equal(f.ledger.snapshot().counters.allianceTech, 1);
    f.settings.alliance.techDailyLimit = 2;
    const connected = f.client.request;
    f.client.request = async (name, ...args) => { if (name === 'UpgradeGuildTechRequest') throw Object.assign(Error('尚未发送'), { notSent: true }); return connected(name, ...args); };
    await f.run(); assert.equal(f.ledger.snapshot().counters.allianceTech, 1); assert.equal(f.ledger.snapshot().uncertain, 0);
  });
  console.log(`${passed}/${passed} 联盟自动化测试通过`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
