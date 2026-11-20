import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cw-base-status-'));
const previousData = process.env.CW_DATA_DIR;
process.env.CW_DATA_DIR = temporary;
const { defaultSettings } = await import('../src/automation-settings.mjs');
const { planBaseAutomation, surveyBaseAutomation, observeBaseAutomationPlan } = await import('../src/base-automation.mjs');
const { rewardSchedule } = await import('../src/reward-schedule.mjs');
const { runtimeProgress, museumRuntimeStatus } = await import('../src/runtime-progress.mjs');
const { runLoop } = await import('../src/loop.mjs');
const { createDeclaredProtocol } = await import('./fixtures/declared-protocol.mjs');

let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };

function fixture() {
  const settings = defaultSettings();
  Object.assign(settings.loop, { world: true, dailies: true, tasks: false, heroes: false });
  Object.assign(settings.factory, { enabled: false, demandFirst: false, keepStock: 0 });
  settings.building.enabled = settings.resident.enabled = false;
  Object.assign(settings.museum, { runEnabled: true, enabled: true, achievements: true, upgrade: true });
  Object.assign(settings.pet, { enabled: true, breed: true, claim: true, species: ['1'], feed: false, advance: false });
  settings.events.enabled = settings.gold.enabled = true;
  const config = { tables: Object.fromEntries(Object.entries({
    BuildingCfg: [{ buildingType: '博物馆' }, { buildingType: '宠物培育室' }],
    BuildingUnlockCfg: [
      { buildingId: '1博物馆', buildingType: '博物馆', playerLevel: 28 },
      { buildingId: '1宠物培育室', buildingType: '宠物培育室', playerLevel: 23 },
    ],
    BuildingUpgradeCfg: [{ buildingType: '宠物培育室', level: 3, effect: [['培育队列', 3]] }],
    MuseumExpeditionTeamCfg: [{ playerLevel: 28, teamCount: 3 }],
    MuseumAreaIndicatorCfg: [{ areaId: 1, areaLevel: 1, level: 1, upgradeCost: ['木板', 5] }],
    OfflineParamCfg: [{ paramName: '点金价格', paramValue: 10 }, { paramName: '免费点金次数', paramValue: 1 }],
  }).map(([name, data]) => [name, { data }])) };
  const room = { buildingId: '1宠物培育室', type: '宠物培育室', level: 3,
    petBreed: { maxQLength: 3, breedQ: [{ idx: 1 }, { idx: 2 }, { idx: 3 }], maturePets: [] } };
  const stock = new Map([['木板', 100], ['RUBY', 100], ['博物馆加速', 5]]);
  const snapshot = {
    now: 1000, player: { playerId: '44001', level: 36, worldId: 1002001, guildId: 0 }, notes: [],
    world: { stock, have: id => stock.get(id) ?? 0, factories: [], stockCap: 1000, serverNow: 1000,
      buildings: [room, { buildingId: '1博物馆', type: '博物馆', level: 1 }] },
    museum: { exhibitions: [], exploreStages: [], popularity: 0, claimedAchievements: [] },
    gold: { info: { freeTimes: 1, paidTimes: 0, maxPaidTimes: 3 } }, pets: [], heroes: [], choices: [], choiceObserved: false,
  };
  return { settings, config, snapshot, room };
}

function observe(plan, settings) {
  const client = new EventEmitter();
  const rewards = rewardSchedule(client);
  observeBaseAutomationPlan(rewards, plan, settings, 30000);
  const text = key => rewards.status(key)?.text ?? '';
  const view = key => runtimeProgress({ key, enabled: true, blockedBy: [] }, rewards.status(key), {}, { connected: true, running: true });
  return { rewards, text, view };
}

function assertIsolated(observed, owner, pattern, others) {
  assert.match(observed.text(owner), pattern, owner + ' 必须显示自己的阻断原因');
  for (const key of others) assert.doesNotMatch(observed.text(key), pattern, key + ' 不应显示其他动作的阻断原因');
}

function advanceFixture() {
  const f = fixture();
  const { config, settings, snapshot, room } = f;
  Object.assign(settings.factory, { enabled: true, demandFirst: true, demandPriority: ['petAdvance', 'museum', 'petFeed'] });
  Object.assign(settings.pet, { advance: true, feed: true, breed: false });
  config.tables.PetAdvancedCfg = { data: [{ grade: 0, level: 0 }, { grade: 1, level: 5 }] };
  config.tables.PetFeedAttrCfg = { data: [0, 1].map(level => ({ level, attrCounts: [2] })) };
  snapshot.world.stock.set('木板', 5);
  snapshot.museum.exhibitions = [{ exhibitionId: 1, level: 1, keywordLevels: [0, 0, 0] }];
  room.petBreed.breedQ = [{ idx: 1, finishTime: snapshot.now + 1000, feedRequirements: [{ id: '木板', num: 5 }] }];
  snapshot.pets = [{ uid: '101', petId: '红宠物4', level: 5, profFeed: [{ attrFeed: [{ times: 0 }] }] }];
  snapshot.world.buildings.push({ buildingId: '值守建筑', petServe: { petUid: '101',
    upgradeRequirements: [{ id: '木板', num: 2 }, { id: '木板', num: 3 }] } });
  return f;
}

try {
  await test('同一批库存按海兽进阶、培育投喂和博物馆优先级使用，能反转也能关闭', () => {
    const { config, settings, snapshot } = advanceFixture();
    const plan = () => planBaseAutomation(snapshot, config, settings);
    const steps = result => result.actions.filter(step => step.costs?.some(cost => cost.id === '木板'));
    const advance = steps(plan());
    assert.deepEqual(advance.map(step => step.kind), ['petAdvanceFeed']);
    assert.deepEqual(advance[0].costs, [{ id: '木板', num: 5 }]);
    for (const [source, kind] of [['petFeed', 'petFeed'], ['museum', 'museumKeyword']]) {
      settings.factory.demandPriority = [source, 'petAdvance'];
      const result = plan();
      assert.deepEqual(steps(result).map(step => step.kind), [kind]);
      assert.match(result.notesBySetting['pet.advance'].join(''), /木板需要 5，库存 5，本轮已安排 5，可用 0/);
    }
    settings.factory.demandPriority = ['petAdvance'];
    settings.factory.demandFirst = false;
    assert.deepEqual(steps(plan()).map(step => step.kind), ['museumKeyword']);
  });

  await test('提高投喂优先级只作用于已有队列，新开培育、领取仍排在博物馆之后', () => {
    const { config, settings, snapshot, room } = advanceFixture();
    settings.factory.demandPriority = ['petFeed', 'museum', 'petAdvance'];
    Object.assign(settings.pet, { feed: false, breed: true });
    room.petBreed.breedQ = [];
    config.tables.PetBreedCfg = { data: [{ spId: 1, petId: '蓝宠物1', season: 1, quality: 'BLUE',
      cost: [['专属基因', 1], ['GOLD', 5]] }] };
    config.tables.MuseumAreaIndicatorCfg.data[0].upgradeCost = ['GOLD', 5];
    snapshot.world.stock.set('专属基因', 1);
    const kinds = () => planBaseAutomation(snapshot, config, settings).actions.map(step => step.kind);
    snapshot.world.stock.set('GOLD', 5);
    assert(kinds().includes('museumKeyword'));
    assert(!kinds().includes('petBreed'));
    snapshot.world.stock.set('GOLD', 10);
    assert.deepEqual(kinds().filter(kind => ['museumKeyword', 'petBreed'].includes(kind)), ['museumKeyword', 'petBreed']);
    room.petBreed.maturePets = [{ petId: '蓝宠物1' }];
    assert.deepEqual(kinds().filter(kind => ['museumKeyword', 'petClaim'].includes(kind)), ['museumKeyword', 'petClaim']);
  });

  await test('海兽进阶区分真实库存不足、设置保留和库存读取失败', () => {
    const { config, settings, snapshot } = advanceFixture();
    const plan = () => planBaseAutomation(snapshot, config, settings);
    snapshot.world.stock.set('木板', 4);
    assert.match(plan().notesBySetting['pet.advance'].join(''), /木板需要 5，库存 4，可用 4/);
    snapshot.world.buildings.at(-1).petServe.upgradeRequirements = [{ id: '加速器', num: 2 }];
    snapshot.world.stock.set('加速器', 2);
    settings.resources.keepAccelerators = 1;
    assert.match(plan().notesBySetting['pet.advance'].join(''), /加速器需要 2，库存 2，设置保留 1，可用 1/);
    snapshot.world.stockKnown = false;
    const missing = plan();
    assert.match(missing.notesBySetting['pet.advance'].join(''), /未能读取完整库存/);
    assert(!missing.actions.some(step => step.kind === 'petAdvanceFeed'));
    snapshot.world.stockKnown = true;
    snapshot.world.resourceStockKnown = false;
    settings.resources.keepAccelerators = 0;
    assert(plan().actions.some(step => step.kind === 'petAdvanceFeed'));
  });

  await test('投喂满后按等级进阶，最高阶可继续投喂直至本阶进度满', () => {
    const { config, settings, snapshot } = advanceFixture();
    const pet = snapshot.pets[0];
    const actions = () => planBaseAutomation(snapshot, config, settings).actions.filter(step => step.setting === 'pet.advance').map(step => step.kind);
    pet.profFeed[0].attrFeed[0].times = 2;
    pet.level = 4;
    assert.deepEqual(actions(), []);
    pet.level = 5;
    assert.deepEqual(actions(), ['petAdvance']);
    pet.grade = 1;
    pet.profFeed[0].attrFeed[0].times = 1;
    assert.deepEqual(actions(), ['petAdvanceFeed']);
    pet.profFeed[0].attrFeed[0].times = 2;
    assert.deepEqual(actions(), []);
  });

  await test('博物馆各行不混入海兽满队列、随机事件与点金条件', () => {
    const f = fixture();
    const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
    const observed = observe(plan, f.settings);
    for (const key of ['museum.runEnabled', 'museum.enabled', 'museum.upgrade']) {
      const view = observed.view(key);
      assert.doesNotMatch(view.progress + view.condition, /海兽|3\/3|随机事件|付费点金/);
    }
    assertIsolated(observed, 'pet.enabled', /海兽培育队列已满（3\/3）/, ['museum.runEnabled', 'events.enabled', 'gold.enabled']);
    assertIsolated(observed, 'pet.breed', /海兽培育队列已满（3\/3）/, ['pet.claim']);
    assertIsolated(observed, 'events.enabled', /随机事件/, ['museum.enabled', 'pet.enabled', 'gold.enabled']);
    assertIsolated(observed, 'gold.enabled', /付费点金/, ['museum.enabled', 'pet.enabled', 'events.enabled']);
    assert.match(plan.notes.join('\n'), /海兽培育队列已满（3\/3）/);
    assert.match(plan.notes.join('\n'), /随机事件/);
    assert.match(plan.notes.join('\n'), /付费点金/);
    assert.match(plan.notesBySetting['pet.breed'].join('\n'), /3\/3/);
  });

  await test('博物馆总开关汇总探宝、指南和升级，探宝汇总指南', () => {
    const f = fixture();
    Object.assign(f.settings.museum, { useGuide: true, dailyGuideLimit: 1 });
    f.snapshot.museum.exploreStages = [
      { stageId: 1, expedition: { endTime: 999, heroIds: [] } },
      { stageId: 2, expedition: { endTime: 4600, heroIds: [] } },
    ];
    f.snapshot.museum.exhibitions = [{ exhibitionId: 1, level: 1, keywordLevels: [0, 0, 0] }];
    const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
    assert.deepEqual(plan.actions.map(step => step.kind), ['museumComplete', 'museumGuide', 'museumKeyword']);
    const observed = observe(plan, f.settings);
    assert.match(observed.text('museum.runEnabled'), /本次计划 3 项/);
    assert.match(observed.text('museum.enabled'), /本次计划 2 项/);
    assert.match(observed.text('museum.useGuide'), /本次计划 1 项/);
    assert.match(observed.text('museum.upgrade'), /本次计划 1 项/);
    assert(observed.rewards.nextCheck('museum.runEnabled') > observed.rewards.now());
  });

  await test('材料不足仅出现在对应升级动作与博物馆总状态', () => {
    const f = fixture();
    f.snapshot.world.stock.set('木板', 0);
    f.snapshot.museum.exhibitions = [{ exhibitionId: 1, level: 1, keywordLevels: [0, 0, 0] }];
    const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
    const observed = observe(plan, f.settings);
    assertIsolated(observed, 'museum.upgrade', /现有材料不足或需保留/, ['museum.enabled', 'pet.enabled', 'events.enabled', 'gold.enabled']);
    assert.match(observed.text('museum.runEnabled'), /现有材料不足或需保留/);
    assert.match(plan.notes.join('\n'), /现有材料不足或需保留/);
    assert(!plan.actions.some(step => step.setting === 'museum.upgrade'));
  });

  await test('预算拒绝保留动作归属，报告继续保留全部提示', () => {
    const f = fixture();
    f.config.tables.MuseumAreaIndicatorCfg.data[0].upgradeCost = ['RUBY', 5];
    f.snapshot.museum.exhibitions = [{ exhibitionId: 1, level: 1, keywordLevels: [0, 0, 0] }];
    const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
    const observed = observe(plan, f.settings);
    assertIsolated(observed, 'museum.upgrade', /会超过今日使用上限/, ['museum.enabled', 'pet.enabled', 'events.enabled', 'gold.enabled']);
    assert.match(observed.text('museum.runEnabled'), /会超过今日使用上限/);
    assert.match(plan.notesBySetting['museum.upgrade'].join('\n'), /会超过今日使用上限/);
    assert.match(plan.notes.join('\n'), /会超过今日使用上限/);
    assert.match(plan.notes.join('\n'), /海兽培育队列已满/);
  });

  await test('读取英雄失败只影响博物馆探宝及总状态', async () => {
    const f = fixture();
    const client = new EventEmitter();
    client.request = async name => {
      if (name === 'MuseumInfoRequest') return f.snapshot.museum;
      if (name === 'ClickGoldInfoRequest') return f.snapshot.gold;
      if (name === 'AllHeroRequest') throw new Error('controlled read failure');
      assert.fail('意外读取 ' + name);
    };
    const protocol = createDeclaredProtocol(['MuseumInfoRequest', 'MuseumInfoResponse', 'AllHeroRequest', 'AllHeroResponse', 'ClickGoldInfoRequest', 'ClickGoldInfoResponse']);
    const snapshot = await surveyBaseAutomation(client, protocol, f.config, f.snapshot.player, f.settings, f.snapshot.world);
    const plan = planBaseAutomation(snapshot, f.config, f.settings);
    const observed = observe(plan, f.settings);
    assertIsolated(observed, 'museum.enabled', /AllHeroRequest/, ['museum.upgrade', 'pet.enabled', 'events.enabled', 'gold.enabled']);
    assert.match(observed.text('museum.runEnabled'), /AllHeroRequest/);
    assert.match(plan.notes.join('\n'), /AllHeroRequest/);
  });

  await test('缺少博物馆协议只影响博物馆模块', async () => {
    const f = fixture();
    const client = new EventEmitter();
    client.request = async name => {
      if (name === 'AllHeroRequest') return { heroes: [] };
      if (name === 'ClickGoldInfoRequest') return f.snapshot.gold;
      assert.fail('意外读取 ' + name);
    };
    const protocol = createDeclaredProtocol(['AllHeroRequest', 'AllHeroResponse', 'ClickGoldInfoRequest', 'ClickGoldInfoResponse']);
    const snapshot = await surveyBaseAutomation(client, protocol, f.config, f.snapshot.player, f.settings, f.snapshot.world);
    const plan = planBaseAutomation(snapshot, f.config, f.settings);
    const observed = observe(plan, f.settings);
    for (const key of ['museum.runEnabled', 'museum.enabled', 'museum.upgrade']) assert.match(observed.text(key), /MuseumInfoRequest/);
    for (const key of ['pet.enabled', 'events.enabled', 'gold.enabled']) assert.doesNotMatch(observed.text(key), /MuseumInfoRequest|博物馆/);
    assert.match(plan.notes.join('\n'), /MuseumInfoRequest/);
  });

  await test('25级未解锁博物馆显示28级条件并隔离海兽状态', () => {
    const f = fixture();
    f.snapshot.player.level = 25;
    f.snapshot.world.buildings = [f.room];
    const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
    const observed = observe(plan, f.settings);
    for (const key of ['museum.runEnabled', 'museum.enabled', 'museum.upgrade']) {
      assert.match(observed.text(key), /博物馆：角色达到 28 级后解锁/);
      assert.doesNotMatch(observed.text(key), /海兽|随机事件|付费点金/);
    }
    assert.doesNotMatch(observed.text('pet.enabled'), /28 级|博物馆/);
    assert.match(plan.notes.join('\n'), /博物馆：角色达到 28 级后解锁/);
  });

  await test('旧快照的未归属提示保留在报告，暂停模块不刷新已检查状态', () => {
    const f = fixture();
    f.snapshot.notes.push('未归属的历史读取提示');
    const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
    assert(plan.notes.includes('未归属的历史读取提示'));
    const observed = observe(plan, f.settings);
    for (const key of ['museum.runEnabled', 'pet.enabled', 'events.enabled', 'gold.enabled']) assert.doesNotMatch(observed.text(key), /历史读取提示/);
    f.settings.museum.runEnabled = false;
    f.settings.pet.enabled = false;
    f.settings.loop.world = false;
    f.settings.loop.dailies = false;
    const paused = observe(planBaseAutomation(f.snapshot, f.config, f.settings), f.settings);
    for (const key of ['museum.runEnabled', 'museum.enabled', 'museum.upgrade', 'pet.enabled', 'pet.breed', 'events.enabled', 'gold.enabled']) {
      assert.equal(paused.rewards.status(key), null, key + ' 暂停时不应标成已检查');
    }
    f.settings.museum.runEnabled = f.settings.pet.enabled = f.settings.loop.dailies = true;
    const dailyOnly = observe(planBaseAutomation(f.snapshot, f.config, f.settings), f.settings);
    for (const key of ['museum.runEnabled', 'museum.enabled', 'museum.upgrade', 'pet.enabled', 'events.enabled']) {
      assert.equal(dailyOnly.rewards.status(key), null, key + ' 基地暂停时不应标成已检查');
    }
    assert.match(dailyOnly.text('gold.enabled'), /付费点金/);
  });

  await test('基地暂停时不显示退役任务或历史模块状态', () => {
    const f = fixture();
    f.settings.loop.world = false;
    f.settings.museum.enabled = f.settings.museum.upgrade = false;
    f.settings.schedule.museumCollect = f.settings.schedule.museumExplore = true;
    const statuses = {
      museumCollect: { text: '旧领奖已完成', state: 'ok', checkedAt: 1000 },
      museumExplore: { text: '旧派遣等待英雄', state: 'waiting', checkedAt: 1001 },
      'museum.runEnabled': { text: '过期的详细模块状态', state: 'waiting', checkedAt: 900 },
    };
    const deadlines = { museumCollect: 1060, museumExplore: 1030, 'museum.runEnabled': 1002 };
    const result = museumRuntimeStatus(f.settings, { status: key => statuses[key] ?? null, nextCheck: key => deadlines[key] ?? null });
    assert.deepEqual(result, { observation: null, nextCheck: null });
  });

  await test('博物馆仅升级时也使用统一汇总并忽略退役任务记录', () => {
    const f = fixture();
    f.settings.museum.enabled = false;
    f.settings.museum.achievements = false;
    f.settings.schedule.museumCollect = true;
    f.settings.schedule.museumExplore = false;
    const statuses = {
      museumCollect: { text: '旧领奖结果待确认', state: 'pending', checkedAt: 1000 },
      museumExplore: { text: '已关闭的旧派遣错误', state: 'error', checkedAt: 1003 },
      'museum.runEnabled': { text: '升级结果待确认', state: 'pending', checkedAt: 1002 },
    };
    const deadlines = { museumCollect: 1060, museumExplore: 1005, 'museum.runEnabled': 1040 };
    const result = museumRuntimeStatus(f.settings, { status: key => statuses[key] ?? null, nextCheck: key => deadlines[key] ?? null });
    assert.match(result.observation.text, /升级结果待确认/);
    assert.doesNotMatch(result.observation.text, /旧领奖|旧派遣/);
    assert.equal(result.observation.state, 'pending');
    assert.equal(result.nextCheck, 1040);
  });

  await test('独立营收、人气奖励和上架也展示博物馆统一状态', () => {
    for (const action of ['revenue', 'achievements', 'display']) {
      const settings = defaultSettings(); settings.loop.world = true;
      settings.museum.runEnabled = true; settings.museum[action] = true;
      const summary = { text: action + ' 已核对', state: 'ok', checkedAt: 1000 };
      const result = museumRuntimeStatus(settings, { status: key => key === 'museum.runEnabled' ? summary : null, nextCheck: () => 1060 });
      assert.deepEqual(result, { observation: summary, nextCheck: 1060 });
      settings.museum.runEnabled = false;
      assert.deepEqual(museumRuntimeStatus(settings, { status: () => summary, nextCheck: () => 1060 }), { observation: null, nextCheck: null });
    }
  });

  await test('探宝总开关使用本轮汇总并排除退役任务记录', () => {
    const f = fixture();
    f.settings.schedule.museumCollect = f.settings.schedule.museumExplore = true;
    const summary = { text: '本次计划 3 项', state: 'waiting', checkedAt: 1002 };
    const result = museumRuntimeStatus(f.settings, {
      status: key => key === 'museum.runEnabled' ? summary : { text: '旧规则错误', state: 'error', checkedAt: 1003 },
      nextCheck: key => key === 'museum.runEnabled' ? 1060 : 1030,
    });
    assert.deepEqual(result.observation, summary);
    assert.equal(result.nextCheck, 1060);
  });

  await test('博物馆总开关暂停后忽略历史状态', () => {
    const f = fixture();
    f.settings.museum.runEnabled = false;
    f.settings.schedule.museumCollect = f.settings.schedule.museumExplore = true;
    const result = museumRuntimeStatus(f.settings, {
      status: () => ({ text: '历史状态', state: 'ok', checkedAt: 1000 }),
      nextCheck: () => 1060,
    });
    assert.equal(result.observation, null);
    assert.equal(result.nextCheck, null);
  });

  await test('挂机正常入口使用隔离状态并保留本轮汇总提示', async () => {
    const f = fixture();
    f.settings.dailies.enabled = true;
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const client = new EventEmitter();
    client.setMaxListeners(100);
    client.connected = true;
    const replies = {
      DailyTaskInfoRequest: { dailyResetTime: reset, dailyTask: [{ id: 1006, progress: 3, targetProgress: 3, rewardClaimed: true }] },
      OnWaterRequest: { building: f.snapshot.world.buildings, workerOrder: [] },
      AllItemRequest: { items: [] }, AllResourceRequest: { list: [] },
      MuseumInfoRequest: f.snapshot.museum, AllHeroRequest: { heroes: [] }, ClickGoldInfoRequest: f.snapshot.gold,
    };
    const reads = [];
    client.request = async name => {
      assert(Object.hasOwn(replies, name), '意外读取 ' + name);
      reads.push(name);
      return structuredClone(replies[name]);
    };
    client.sendWatch = async name => assert.fail('状态验证禁止写请求 ' + name);
    const protocol = createDeclaredProtocol(Object.keys(replies).flatMap(name => [name, name.replace(/Request$/, 'Response')]));
    const result = await runLoop(client, protocol, {
      config: f.config, player: f.snapshot.player, rounds: 1, allowMutate: true,
      getSettings: () => f.settings, isEnabled: key => ['freeGold', 'paidGold'].includes(key),
    });
    const rewards = rewardSchedule(client);
    assert.match(rewards.status('freeGold')?.text ?? '', /3\/3/);
    assert.equal(rewards.nextCheck('freeGold'), reset);
    assert.equal(rewards.status('paidGold'), null);
    assert.equal(rewards.nextCheck('paidGold'), null);
    assert.match(rewards.status('gold.enabled')?.text ?? '', /付费点金/);
    assert(rewards.nextCheck('gold.enabled') < reset);
    assert(reads.includes('MuseumInfoRequest'), '正常挂机入口必须读取博物馆状态');
    assert.match(rewards.status('pet.enabled')?.text ?? '', /海兽培育队列已满/);
    for (const key of ['museum.runEnabled', 'museum.enabled', 'museum.upgrade']) {
      assert(rewards.status(key), key + ' 应经过正常挂机入口发布状态');
      assert.doesNotMatch(rewards.status(key).text, /海兽|随机事件|付费点金/);
    }
    assert.match(result.history[0].world.notes.join('\n'), /海兽培育队列已满/);
    assert.match(result.history[0].world.notes.join('\n'), /随机事件/);
  });

  await test('HTTP运行状态展示统一博物馆状态，基地暂停后忽略退役任务记录', async () => {
    const previousConfig = process.env.CW_CONFIG_PACK;
    process.env.CW_CONFIG_PACK = path.join(temporary, 'config.json');
    fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
    const { saveStore } = await import('../src/accounts.mjs');
    const { saveAutomationSettings } = await import('../src/automation-settings.mjs');
    const { createConsole } = await import('./fixtures/console-server.mjs');
    saveStore({ version: 1, activeId: 'base-detailed', accounts: ['base-detailed', 'base-legacy'].map(id => ({
      id, label: '基地状态隔离测试', url: 'ws://127.0.0.1:1', login: {}, automation: { paused: true },
    })) });
    const detailed = fixture(), legacy = fixture();
    legacy.settings.loop.world = false;
    legacy.settings.museum.enabled = legacy.settings.museum.upgrade = false;
    saveAutomationSettings('base-detailed', detailed.settings, { revision: 0 });
    saveAutomationSettings('base-legacy', legacy.settings, { revision: 0 });
    const app = createConsole({ port: 0, protocol: createDeclaredProtocol(['MuseumInfoRequest', 'MuseumInfoResponse']) });
    try {
      const address = await app.listen();
      const read = async account => {
        const response = await fetch(address + '/api/loop?account=' + account);
        assert.equal(response.status, 200);
        return response.json();
      };
      const clients = new Map();
      for (const id of ['base-detailed', 'base-legacy']) {
        await read(id);
        const session = app.sessions.get(id), client = new EventEmitter();
        client.connected = true;
        client.request = async name => assert.fail('HTTP状态验证禁止游戏请求 ' + name);
        client.stop = () => { client.connected = false; };
        session.client = client;
        session.paused = false;
        session.loop.running = true;
        clients.set(id, client);
      }
      const current = Math.floor(Date.now() / 1000);
      app.sessions.get('base-detailed').loop.controlStatus = new Map([['museum.runEnabled', {
        text: '昨天的海兽满队列提示', state: 'waiting', checkedAt: current - 86400,
      }]]);
      const detailedRewards = rewardSchedule(clients.get('base-detailed'));
      detailedRewards.observe('paidGold', '3/3 · 今日目标已完成');
      detailedRewards.defer('paidGold', current + 3600);
      observeBaseAutomationPlan(detailedRewards,
        planBaseAutomation(detailed.snapshot, detailed.config, detailed.settings), detailed.settings, 30000);
      const detailedView = await read('base-detailed');
      const gold = detailedView.controls.find(row => row.key === 'gold.enabled');
      assert.match(gold.observation.text, /付费点金/);
      assert.equal(gold.nextCheck, detailedRewards.nextCheck('gold.enabled'));
      assert.equal(detailedView.tasks.find(row => row.key === 'paidGold').nextCheck, gold.nextCheck);
      for (const key of ['museum.runEnabled', 'museum.enabled', 'museum.upgrade']) {
        const control = detailedView.controls.find(row => row.key === key);
        assert.match(control.observation.text, /已核对/);
        assert.doesNotMatch(control.progress + control.condition, /海兽|3\/3|随机事件|付费点金/);
        assert(control.nextCheck > current);
      }
      const pet = detailedView.controls.find(row => row.key === 'pet.enabled');
      assert.match(pet.progress + pet.condition, /海兽培育队列已满/);

      const legacyRewards = rewardSchedule(clients.get('base-legacy'));
      legacyRewards.observe('museumCollect', '旧领奖结果待确认', 'pending');
      legacyRewards.observe('museumExplore', '旧派遣等待英雄', 'waiting');
      legacyRewards.observe('museum.runEnabled', '切换前的详细模块提示');
      legacyRewards.expect('museumCollect', current + 90);
      legacyRewards.expect('museumExplore', current + 30);
      legacyRewards.expect('museum.runEnabled', current + 5);
      const legacyView = await read('base-legacy');
      const museum = legacyView.controls.find(row => row.key === 'museum.runEnabled');
      assert.doesNotMatch(museum.condition, /旧领奖|旧派遣|详细模块提示|海兽/);
      assert.equal(museum.observation.state, 'unseen');
      assert.equal(museum.observation.checkedAt, null);
      assert.equal(museum.nextCheck, null);
    } finally {
      app.server.closeAllConnections();
      await app.close();
      if (previousConfig === undefined) delete process.env.CW_CONFIG_PACK;
      else process.env.CW_CONFIG_PACK = previousConfig;
    }
  });

  console.log(`基地状态归属 ${passed}/${passed} 通过`);
} finally {
  if (previousData === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = previousData;
  assert.equal(path.dirname(temporary), fs.realpathSync(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
}
