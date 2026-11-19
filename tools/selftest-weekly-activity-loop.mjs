// Exercise independent weekly and ordinary automation through the real loop.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-weekly-loop-'));
const previousDataDir = process.env.CW_DATA_DIR;
process.env.CW_DATA_DIR = directory;
const { runLoop } = await import('../src/loop.mjs');
const { defaultSettings, createUsageLedger, hasExtraWork } = await import('../src/automation-settings.mjs');

const protocol = createDeclaredProtocol([
  'CrossRankInfoRequest', 'CrossRankInfoResponse',
  'DailyTaskInfoRequest', 'DailyTaskInfoResponse',
  'AllItemRequest', 'AllItemResponse', 'OnWaterRequest', 'OnWaterResponse',
  'RecruitInfoRequest', 'RecruitInfoResponse', 'RecruitStartRequest', 'RecruitStartResponse',
  'GuildInfoRequest', 'GuildInfoResponse', 'GuildOrderRequest', 'GuildOrderResponse',
  'GuildCityInfoRequest', 'GuildCityInfoResponse', 'CounterInfoRequest', 'CounterInfoResponse',
  'AllResourceRequest', 'AllResourceResponse', 'EquipsRequest', 'EquipsResponse',
  'MonthCardRequest', 'MonthCardResponse', 'MakeEquipRequest',
]);
const nativeTasks = ['guildOrders', 'petCollect', 'petBreed', 'ticketRecruit'];
let serial = 0, passed = 0;
async function test(name, work) {
  await work(); passed++; console.log('通过：' + name);
}

function fixture({ master = true, selected = nativeTasks, state = {}, time = '2026-11-16T04:00:00Z' } = {}) {
  const id = ++serial;
  const settings = defaultSettings();
  for (const key of Object.keys(settings.schedule)) settings.schedule[key] = false;
  Object.assign(settings.loop, { tasks: false, world: false, heroes: false, dailies: true });
  settings.dailies.enabled = true;
  Object.assign(settings.weeklyActivity, { enabled: master, farmEnabled: true, petEnabled: true, heroEnabled: true });
  for (const key of nativeTasks) settings.schedule[key] = true;
  const before = structuredClone(settings);
  const player = { playerId: String(9900000 + id), worldId: 2000001, guildId: '7', level: 40 };
  const now = Date.parse(time) / 1000;
  const client = new EventEmitter();
  client.setMaxListeners(50);
  client.connected = true;
  client.serverClockOffsetMs = Date.parse(time) - Date.now();
  client.promptNames = {};
  const calls = [], writes = [], unexpected = [], reports = [], queriedTasks = [];
  let recruited = false;
  const handlers = {
    CrossRankInfoRequest: () => ({ grouping: true, subjectId: 6, roomLevel: 40, settleTime: now + 3600,
      rankList: [{ playerId: player.playerId, score: 0 }], ...state }),
    DailyTaskInfoRequest: () => ({ dailyTask: [{ id: 1002, progress: recruited ? 1 : 0, targetProgress: 1 }], dailyResetTime: now + 3600 }),
    AllItemRequest: () => ({ items: [{ itemId: '抽卡券', num: recruited ? 0 : 1 }] }),
    AllResourceRequest: () => ({ list: [{ res: 3, amount: 10000 }] }),
    OnWaterRequest: () => ({ building: [{ buildingId: '1广播站', level: 1 }], workerOrder: [] }),
    RecruitInfoRequest: () => ({ hero: { freeEndTimeSeconds: now + 3600 } }),
    RecruitStartRequest: body => {
      assert.equal(body.way, 2, '只恢复原来的用券单抽，免费次数尚未到期');
      recruited = true; writes.push(['RecruitStartRequest', body]);
      return { recruitData: { freeEndTimeSeconds: now + 3600 } };
    },
    GuildInfoRequest: () => ({ guild: { guildId: player.guildId } }),
    GuildOrderRequest: () => ({ order: { requirements: [], nextRefreshTime: now + 3600 } }),
    GuildCityInfoRequest: () => ({ cities: [] }),
    CounterInfoRequest: () => ({ counters: [] }),
  };
  client.request = async (name, body = {}, response) => {
    calls.push(name);
    if (!handlers[name]) { unexpected.push(name); throw Error('未预期请求 ' + name); }
    assert(protocol[name], name);
    for (const reply of [response].flat().filter(Boolean)) assert(protocol[reply], reply);
    return handlers[name](body);
  };
  client.sendWatch = async name => { unexpected.push(name); throw Error('未预期写请求 ' + name); };
  const config = { materialName: value => value, tables: {
    ModuleOpenCfg: { data: [{ moduleId: '每日跨服比拼', playerLevel: 20 }, { moduleId: '联盟', playerLevel: 1 }] },
    GuildOrderNumCfg: { data: [{ season: 2, playerLevel: 1, maxNum: 10 }] },
    BuildingUnlockCfg: { data: [{ buildingType: '宠物培育室', buildingId: '1宠物培育室', playerLevel: 1 }] },
  } };
  const ledger = createUsageLedger('weekly-loop-' + id, { file: path.join(directory, id + '.json') });
  return { settings, before, player, calls, writes, reports, queriedTasks,
    async run() {
      const selectedTasks = new Set(selected);
      const history = await runLoop(client, protocol, { config, player, rounds: 1, allowMutate: true,
        isEnabled: key => { queriedTasks.push(key); return selectedTasks.has(key); },
        getSettings: () => settings, usageLedger: ledger, onStep: entry => reports.push(entry) });
      assert.equal(history.history.length, 1);
      assert.deepEqual(unexpected, [], '不能因吞掉未知请求的错误而伪装成没有执行');
      assert.deepEqual(reports.filter(entry => entry.ok === false && !entry.skipped), [], '假客户端的合法等待状态不应报错');
      assert.deepEqual(settings, before, '周活动的独立执行不能改写用户保存的设置');
    },
  };
}

function forgeFixture({ ordinary = false, subjectId = 2, reached = false } = {}) {
  const id = ++serial, now = Math.floor(Date.now() / 1000);
  const settings = defaultSettings();
  for (const key of Object.keys(settings.schedule)) settings.schedule[key] = false;
  Object.assign(settings.loop, { tasks: false, world: false, heroes: false, dailies: false });
  settings.resident.rewards = settings.dailies.enabled = false;
  Object.assign(settings.weeklyActivity, { enabled: true, forgeEnabled: true, forgeStop: 'score', forgeScore: 100 });
  Object.assign(settings.forge, { enabled: ordinary, collect: ordinary, craft: ordinary,
    buildingIds: ['1装备厂'], recipeIds: ['1002', '1001'] });
  const before = structuredClone(settings);
  const player = { playerId: String(9910000 + id), worldId: '2000001', level: 40, forgeLevel: 1 };
  const factory = { buildingId: '1装备厂', level: 1, auto: false };
  const materials = { 蓝武器材料: 40, 紫武器材料: 40 };
  let gold = 10000;
  const config = { materialName: value => value, tables: {
    ModuleOpenCfg: { data: [{ moduleId: '每日跨服比拼', playerLevel: 20 }] },
    BuildingUnlockCfg: { data: [{ buildingId: factory.buildingId, buildingType: '装备厂', playerLevel: 17 }] },
    BuildingEquipMakeCfg: { data: [
      { makeId: 1001, type: '武器', season: 1, seconds: 1800, libId: 1001, costItem: [['蓝武器材料', 40], ['GOLD', 2000]] },
      { makeId: 1002, type: '武器', season: 1, seconds: 1800, libId: 1002, costItem: [['紫武器材料', 40], ['GOLD', 5000]] },
    ] },
    ItemCfg: { data: [{ id: '蓝武器材料', quality: 'BLUE' }, { id: '紫武器材料', quality: 'PURPLE' }] },
  } };
  const calls = [], writes = [], reports = [], unexpected = [];
  const client = new EventEmitter(); client.setMaxListeners(50);
  Object.assign(client, { connected: true, serverClockOffsetMs: 0, connectionEpoch: 1, promptNames: {} });
  const handlers = {
    CrossRankInfoRequest: () => ({ subjectId, grouping: false, roomLevel: 40, settleTime: now + 3600,
      rankList: [{ playerId: player.playerId, score: reached ? 100 : 0 }] }),
    OnWaterRequest: () => ({ building: [factory] }),
    AllItemRequest: () => ({ items: Object.entries(materials).map(([itemId, num]) => ({ itemId, num })) }),
    AllResourceRequest: () => ({ list: [{ res: 3, amount: gold }] }),
    EquipsRequest: () => ({ equip: [] }),
    MonthCardRequest: () => ({ cardItem: [] }),
  };
  client.request = async (name, body = {}, response) => {
    calls.push(name);
    if (!handlers[name]) { unexpected.push(name); throw Error('未预期请求 ' + name); }
    assert(protocol[name]);
    for (const reply of [response].flat().filter(Boolean)) assert(protocol[reply], reply);
    return structuredClone(handlers[name](body));
  };
  client.sendWatch = async (name, body) => {
    if (name !== 'MakeEquipRequest') { unexpected.push(name); throw Error('未预期写请求 ' + name); }
    assert(!factory.equipMaking, '游戏工厂忙碌时不能重复制造');
    const recipe = config.tables.BuildingEquipMakeCfg.data.find(row => row.makeId === body.makeId);
    assert(recipe, '必须使用已声明的配方');
    const [material, cost] = recipe.costItem;
    assert(materials[material[0]] >= material[1] && gold >= cost[1], '不能重复消费已用完的材料');
    materials[material[0]] -= material[1]; gold -= cost[1];
    factory.equipMaking = { makeId: recipe.makeId, finishTime: now + recipe.seconds };
    writes.push({ name, body: structuredClone(body) });
  };
  const ledger = createUsageLedger('weekly-forge-loop-' + id, { file: path.join(directory, 'forge-' + id + '.json') });
  return { settings, calls, writes, reports, ledger,
    async run(stop = { aborted: false }) {
      await runLoop(client, protocol, { config, player, rounds: 1, allowMutate: true,
        isEnabled: () => false, getSettings: () => settings, usageLedger: ledger, stop,
        onStep: entry => reports.push(entry) });
      assert.deepEqual(unexpected, [], '不能用吞掉请求错误来掩盖重复或缺失执行');
      assert.deepEqual(reports.filter(entry => entry.ok === false && !entry.skipped), []);
      assert.deepEqual(settings, before, '活动临时开启动作后不得修改普通开关');
    },
  };
}

try {
  for (const scenario of [
    { label: '活动正在分组', state: {}, reason: /分组/ },
    { label: '今日为城战主题', state: { grouping: false, subjectId: 7 }, reason: /城战/ },
    { label: '服务器已结算', state: { grouping: false, settleTime: Date.parse('2026-11-16T03:59:59Z') / 1000 }, reason: /结算/ },
    { label: '本人积分已达目标', state: { grouping: false, rankList: [{ playerId: 'replace', score: 500 }] }, score: 500, reason: /已达目标积分/ },
  ]) {
    await test(scenario.label + '时，周活动等待不阻止普通自动招募', async () => {
      const f = fixture({ state: scenario.state });
      if (scenario.score) {
        Object.assign(f.settings.weeklyActivity, { farmStop: 'score', farmScore: scenario.score });
        scenario.state.rankList[0].playerId = f.player.playerId;
      }
      Object.assign(f.before.weeklyActivity, f.settings.weeklyActivity);
      await f.run();
      assert(f.calls.includes('CrossRankInfoRequest'));
      assert.deepEqual(f.writes, [['RecruitStartRequest', { way: 2 }]]);
      assert(f.reports.some(entry => entry.taskKey === 'weeklyActivity' && scenario.reason.test(entry.reason ?? '')));
      for (const key of nativeTasks) assert.equal(f.settings.schedule[key], true, key + ' 原配置仍为 true');
    });
  }

  await test('旧窄窗口不阻止全天参与，真实 runner 在窗口外仍读取农田和活动募兵状态', async () => {
    const f = fixture({ state: { grouping: false } });
    Object.assign(f.settings.weeklyActivity, { farmStart: '13:00', farmEnd: '13:01', farmStop: 'allDay' });
    Object.assign(f.before.weeklyActivity, f.settings.weeklyActivity);
    await f.run();
    assert(f.calls.includes('CrossRankInfoRequest'));
    assert(f.calls.includes('OnWaterRequest'), '北京时间12点仍应进入农田计划');
    assert(f.calls.includes('GuildOrderRequest'), '北京时间12点仍应进入活动募兵检查');
    assert(f.calls.includes('DailyTaskInfoRequest'), '种田活动不应关闭日常用券招募');
    assert.deepEqual(f.writes, [['RecruitStartRequest', { way: 2 }]]);
    assert(f.reports.some(entry => entry.taskKey === 'weeklyActivity' && entry.reason === '当前没有可提交的联盟募兵物资需求'));
  });

  await test('只启用周活动即可进入真实 runner，即使所有原生任务 callback 均返回 false', async () => {
    const f = fixture({ selected: [] });
    f.settings.loop.dailies = f.before.loop.dailies = false;
    assert.equal(hasExtraWork(f.settings), true);
    await f.run();
    assert.deepEqual(f.calls, ['CrossRankInfoRequest']);
    assert(f.reports.some(entry => entry.taskKey === 'weeklyActivity' && /分组/.test(entry.reason ?? '')));
    assert.deepEqual(f.writes, []);
  });

  await test('关闭周活动总开关不影响普通任务，已退役联盟订单和海兽入口保持移除', async () => {
    const f = fixture({ master: false });
    await f.run();
    assert(!f.calls.includes('CrossRankInfoRequest'));
    for (const request of ['DailyTaskInfoRequest', 'RecruitInfoRequest', 'OnWaterRequest']) {
      assert(f.calls.includes(request), '关闭活动后恢复原入口 ' + request);
    }
    assert.deepEqual(f.writes, [['RecruitStartRequest', { way: 2 }]]);
    assert(!f.reports.some(entry => ['guildOrders', 'petCollect', 'petBreed'].includes(entry.key ?? entry.taskKey)), '残留旧开关不能恢复已退役入口');
    assert(!f.calls.includes('GuildInfoRequest') && !f.calls.includes('GuildOrderRequest'), '关闭活动后不恢复旧联盟订单入口');
  });

  await test('非打造日完全尊重普通锻造开关，勾选周活动不再阻止普通制造', async () => {
    for (const ordinary of [false, true]) {
      const f = forgeFixture({ ordinary, subjectId: 4 }); await f.run();
      assert.equal(f.writes.length, ordinary ? 1 : 0);
      if (ordinary) assert.equal(f.writes[0].body.makeId, 1002, '非活动日沿用普通配方顺序');
    }
  });

  await test('打造日普通总控、领取和续产均关闭时，周活动独立制造并保留原开关', async () => {
    const f = forgeFixture(); await f.run();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].body.makeId, 1001, '使用周活动从低到高的品质顺序');
    assert(f.reports.some(entry => entry.category === '周活动' && entry.step?.kind === 'forgeStart' && entry.ok));
    assert.equal(f.ledger.snapshot().counters.forgeStarts, 1);
  });

  await test('两入口同时开启时先按活动品质制造，普通路径重读忙碌工厂且不重复扣款', async () => {
    const f = forgeFixture({ ordinary: true }); await f.run();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].body.makeId, 1001, '活动计划优先于普通配方顺序');
    assert.equal(f.ledger.snapshot().counters.forgeStarts, 1);
    assert.equal(f.ledger.snapshot().counters.forgeGold, 2000);
  });

  await test('活动积分达标仅停止活动，普通锻造是否继续由自己的开关决定', async () => {
    for (const ordinary of [false, true]) {
      const f = forgeFixture({ ordinary, reached: true }); await f.run();
      assert.equal(f.writes.length, ordinary ? 1 : 0);
      if (ordinary) assert.equal(f.writes[0].body.makeId, 1002, '达标后普通制造沿用原配方顺序');
      assert(f.reports.some(entry => /已达目标积分/.test(entry.reason ?? '')));
    }
  });

  await test('总挂机停止时，单独开启军备竞赛也不发出任何游戏请求', async () => {
    const f = forgeFixture(); await f.run({ aborted: true });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
  });
} finally {
  if (previousDataDir === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = previousDataDir;
  assert(path.resolve(directory).startsWith(temporaryRoot + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('周活动真实挂机接线测试 ' + passed + '/' + passed + ' 通过');
