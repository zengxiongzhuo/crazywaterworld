import assert from 'node:assert/strict';
import { defaultSettings } from '../src/automation-settings.mjs';
import { buildProductionModel, planProduction } from '../src/production-planning.mjs';

const table = data => ({ data });
const config = { tables: {
  BuildingProduceCfg: table([{ itemId: '面包', buildType: '食品厂', unlockLevel: 1, produceTime: 60, costItem: [['小麦', 1]] }]),
  FarmlandPlantCfg: table([{ id: '小麦', time: 30, produceNum: 5, material: ['小麦种子', 1] }]),
}, materialName: id => id };

function fixture() {
  const settings = defaultSettings();
  settings.loop.world = true;
  Object.assign(settings.factory, { enabled: true, produce: true, demandFirst: true });
  Object.assign(settings.farm, { enabled: true, harvest: true, autoPlant: true });
  Object.assign(settings.building, { enabled: true, build: true, upgrade: true });
  settings.weekOrder.enabled = true;
  settings.factory.keepStock = 0;
  const snapshot = { serverNow: 1000, complete: true, missingReads: [], config: {},
    inventory: [{ id: '小麦', num: 10 }, { id: '小麦种子', num: 10 }], stockCap: 50,
    orders: [{ id: 'resident:1', source: 'resident', kind: 'order', requirements: [{ id: '面包', num: 2 }], metadata: { enabled: true } }],
    buildings: [{ id: '1食品厂', buildingId: '1食品厂', type: '食品厂', level: 1, factory: { factoryQ: [] } },
      { id: '1农田', buildingId: '1农田', type: '农田', level: 1 }],
    factories: [{ id: '1食品厂', type: '食品厂', level: 1, capacity: 6, enabled: true, queue: [], finished: [] }],
    farms: [{ id: '1农田', level: 1, enabled: true, productId: null }],
    recipes: [
      { id: '面包', productId: '面包', facilityType: '食品厂', costs: [{ id: '小麦', num: 1 }], output: 1, durationSeconds: 60, unlockLevel: 1, available: true },
      { id: '小麦', productId: '小麦', facilityType: '农田', costs: [{ id: '小麦种子', num: 1 }], output: 5, durationSeconds: 30, unlockLevel: 1, available: true },
    ],
    timing: { effects: { effects: [{ id: 1, value: 0 }, { id: 2, value: 0 }, { id: 11, value: 0 }] }, heroes: [], monthCards: { cardItem: [] } },
  };
  const plan = () => planProduction(snapshot, config, settings, { search: { maxMilliseconds: 200, maxNodes: 30000 } });
  return { snapshot, settings, plan };
}

let passed = 0;
function test(name, run) { run(); passed++; console.log('通过：' + name); }

test('关闭活动总开关后排程移除对应备料订单，其他订单继续参与', () => {
  const { snapshot, settings } = fixture();
  snapshot.orders.push(...['merchant', 'heroRaid'].map(source => ({
    ...snapshot.orders[0], id: source + ':1', source,
  })));
  settings.heroRaid.enabled = true;
  assert.equal(buildProductionModel(snapshot, config, settings).orderRows.length, 3);
  settings.heroRaid.enabled = settings.weekOrder.enabled = false;
  assert.deepEqual(buildProductionModel(snapshot, config, settings).orderRows.map(row => row.source), ['resident']);
});

test('共享库存只分配一次，现有队列按服务器时间贡献', () => {
  const { snapshot, plan } = fixture();
  snapshot.inventory.push({ id: '面包', num: 1 });
  snapshot.orders[0].requirements[0].num = 1;
  snapshot.orders.push({ ...snapshot.orders[0], id: 'resident:2' });
  snapshot.factories[0].queue = [{ id: 'q1', productId: '面包', num: 1, finishTime: 1020 }];
  snapshot.buildings[0].factory.factoryQ = [{ productId: '面包', finishTime: 1020 }];
  const result = plan();
  assert.equal(result.status, 'optimal');
  assert.equal(result.completionAt, 1020);
  assert.deepEqual(result.orders.map(order => order.completionAt).sort(), [1000, 1020]);
  assert.equal(result.timeline.filter(job => job.kind === 'production').length, 0);
});

test('六个排队格遵守单生产位，队列成本已支付', () => {
  const { snapshot, plan } = fixture();
  snapshot.inventory = [{ id: '小麦', num: 1 }];
  snapshot.orders[0].requirements[0].num = 3;
  snapshot.factories[0].queue = [
    { id: 'q1', productId: '面包', num: 1, finishTime: 1020 },
    { id: 'q2', productId: '面包', num: 1, finishTime: null },
  ];
  snapshot.buildings[0].factory.factoryQ = [{ productId: '面包', finishTime: 1020 }, { productId: '面包' }];
  const result = plan();
  assert.equal(result.status, 'optimal');
  assert.equal(result.completionAt, 1140);
  assert.equal(result.estimated, true);
  assert.match(result.statusLabel, /估算/);
  assert.equal(result.timeline.filter(job => job.kind === 'production').length, 1);
});

test('单批五份按全部订单合并取整，并行农田按实际数量', () => {
  const { snapshot, plan } = fixture();
  snapshot.inventory = [{ id: '小麦种子', num: 2 }];
  snapshot.orders = [1, 2].map(id => ({ id: 'o' + id, source: 'resident', kind: 'order', requirements: [{ id: '小麦', num: 3 }], metadata: {} }));
  snapshot.farms.push({ ...snapshot.farms[0], id: '2农田' });
  const result = plan();
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 30);
  assert.equal(result.timeline.filter(job => job.kind === 'production').length, 2);
});

test('已建工厂升级期间继续已有生产，并在生产位释放时开工', () => {
  const { snapshot, plan } = fixture();
  snapshot.factories[0].upgradingUntil = 1050;
  snapshot.factories[0].queue = [{ id: 'q1', productId: '面包', num: 1, finishTime: 1020 }];
  snapshot.buildings[0].factory.factoryQ = [{ productId: '面包', finishTime: 1020 }];
  assert.equal(plan().completionAt, 1080);
});

test('升级中的农田仍需竣工才能播种', () => {
  const { snapshot, plan } = fixture();
  snapshot.inventory = [{ id: '小麦种子', num: 1 }];
  snapshot.orders[0].requirements = [{ id: '小麦', num: 1 }];
  snapshot.farms[0].upgradingUntil = 1050;
  assert.equal(plan().completionAt, 1080);
});

test('工厂按各自实测时长排产', () => {
  const { snapshot, plan } = fixture();
  snapshot.factories.push({ ...snapshot.factories[0], id: '2食品厂' });
  snapshot.buildings.push({ ...snapshot.buildings[0], id: '2食品厂', buildingId: '2食品厂' });
  snapshot.timing.observedDurations = [
    { buildingId: '1食品厂', productId: '面包', seconds: 20, samples: 1 },
    { buildingId: '2食品厂', productId: '面包', seconds: 100, samples: 1 },
  ];
  assert.equal(plan().upperBound, 40);
});

test('过期队列条目立即入库且不会提前释放仍在产的设施', () => {
  const { snapshot, settings } = fixture();
  snapshot.factories[0].queue = [
    { id: 'q1', productId: '面包', num: 1, finishTime: 1100 },
    { id: 'q2', productId: '面包', num: 1, finishTime: 990 },
  ];
  snapshot.buildings[0].factory.factoryQ = snapshot.factories[0].queue.map((job, idx) => ({ idx, productId: job.productId, finishTime: job.finishTime }));
  const model = buildProductionModel(snapshot, config, settings);
  assert.equal(model.input.machines.filter(machine => machine.id.startsWith('1食品厂:')).length, 1);
  assert.equal(model.input.machines[0].availableAt, 100);
  assert.deepEqual(model.input.incoming.map(job => job.readyAt).sort((a, b) => a - b), [0, 100]);
});

test('订单截止时间为硬约束', () => {
  const { snapshot, plan } = fixture();
  snapshot.orders[0].deadline = 1030;
  assert.equal(plan().status, 'infeasible');
  assert.match(plan().statusLabel, /估算模型/);
});

test('联盟刷新边界作为重新核验条件，越界方案保留待确认', () => {
  const { snapshot, plan } = fixture();
  snapshot.orders[0].source = 'guildRecruit';
  snapshot.orders[0].metadata.refreshAt = 1030;
  const result = plan();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.completionAt, null);
  assert.equal(result.lowerBound, null);
  assert.equal(result.upperBound, null);
  assert.equal(result.objectiveLowerBound, null);
  assert.equal(result.objectiveUpperBound, null);
  assert.ok(result.priorityBounds.every(bound => bound.lowerBound === null && bound.upperBound === null));
  assert.match(result.orders[0].reason, /刷新边界/);
});

test('月卡位到期后现有排队任务转入常驻位，已启动任务保留服务器时刻', () => {
  const { snapshot, settings } = fixture();
  const cardConfig = { ...config, tables: { ...config.tables,
    MonthCardCfg: table([{ id: '普通月卡', effectList: [['第二生产位', 1]] }]) } };
  snapshot.timing.monthCards = { cardItem: [{ type: 1, endTime: 1030 }] };
  snapshot.factories[0].queue = [
    { id: 'q1', productId: '面包', num: 1, finishTime: 1010 },
    { id: 'q2', productId: '面包', num: 1, finishTime: 1020 },
    { id: 'q3', productId: '面包', num: 1, finishTime: null },
  ];
  snapshot.buildings[0].factory.factoryQ = snapshot.factories[0].queue.map((job, idx) => ({ idx, productId: job.productId, finishTime: job.finishTime ?? 0 }));
  const model = buildProductionModel(snapshot, cardConfig, settings);
  const queued = model.fixedTimeline.find(job => job.startAt > 1000);
  assert.equal(queued.machineId, '1食品厂:1');
  assert.equal(queued.startAt, 1020);
  assert.equal(queued.finishAt, 1080);
  assert.deepEqual(model.input.incoming.slice(0, 2).map(job => job.readyAt).sort(), [10, 20]);
  assert.equal(model.input.machines[1].availableUntil, 30);
});

test('升级中的空厂依据有效月卡同时开工两件，只有一件在产时第二位可立即接单', () => {
  const { snapshot, settings } = fixture();
  const cardConfig = { ...config, tables: { ...config.tables,
    MonthCardCfg: table([{ id: '普通月卡', effectList: [['第二生产位', 1]] }]) } };
  snapshot.factories[0].upgradingUntil = 2000;
  snapshot.timing.monthCards = { cardItem: [{ type: 1, endTime: 1500 }] };
  const plan = () => planProduction(snapshot, cardConfig, settings);
  const empty = plan();
  assert.equal(empty.completionAt, 1060);
  assert.deepEqual(empty.timeline.map(job => job.startAt), [1000, 1000]);
  assert.equal(new Set(empty.timeline.map(job => job.machineId)).size, 2);
  snapshot.timing.monthCards.cardItem[0].endTime = 1000;
  assert.equal(plan().completionAt, 1120);
  snapshot.timing.monthCards.cardItem[0].endTime = -1;
  snapshot.factories[0].queue = [{ id: 'q1', productId: '面包', num: 1, finishTime: 1020 }];
  snapshot.buildings[0].factory.factoryQ = [{ idx: 5, productId: '面包', finishTime: 1020 }];
  assert.equal(plan().completionAt, 1060);
});

test('其他配方限制继续给出对应订单的真实阻塞', () => {
  const { snapshot, plan } = fixture();
  snapshot.recipes[0].available = false;
  snapshot.recipes[0].reason = '配方活动未开放';
  const result = plan();
  assert.equal(result.status, 'infeasible');
  assert.equal(result.completionAt, null);
  assert.match(result.orders[0].reason, /配方活动未开放/);
});

test('等级不足的商人整单跳过，已有材料可供其他订单齐套', () => {
  const { snapshot, settings } = fixture();
  const extendedConfig = { ...config, tables: { ...config.tables,
    BuildingProduceCfg: table([...config.tables.BuildingProduceCfg.data,
      { itemId: '电路板', buildType: '电子厂', unlockLevel: 2, produceTime: 60, costItem: [['小麦', 1]] }]),
  } };
  snapshot.buildings.push({ id: '1电子厂', buildingId: '1电子厂', type: '电子厂', level: 1, factory: { factoryQ: [] } });
  snapshot.factories.push({ id: '1电子厂', type: '电子厂', level: 1, capacity: 6, enabled: true, queue: [], finished: [] });
  snapshot.recipes.push({ id: '电路板', productId: '电路板', facilityType: '电子厂', costs: [{ id: '小麦', num: 1 }],
    output: 1, durationSeconds: 60, unlockLevel: 2, available: false });
  snapshot.inventory = [{ id: '面包', num: 1 }];
  snapshot.orders[0].requirements[0].num = 1;
  snapshot.orders.push({ id: 'merchant:1', source: 'merchant', kind: 'order',
    requirements: [{ id: '面包', num: 1 }, { id: '电路板', num: 1 }], metadata: {} });
  settings.factory.demandPriority = ['merchant', 'resident'];
  const model = buildProductionModel(snapshot, extendedConfig, settings);
  assert.deepEqual(model.input.orders.map(order => order.id), ['resident:1']);
  assert.equal(model.skippedOrders.size, 1);
  const result = planProduction(snapshot, extendedConfig, settings);
  assert.equal(result.status, 'optimal');
  assert.equal(result.scope, 'feasible-orders');
  assert.equal(result.completionAt, snapshot.serverNow);
  assert.equal(result.orders.find(order => order.source === 'resident').completionAt, snapshot.serverNow);
  const merchant = result.orders.find(order => order.source === 'merchant');
  assert.equal(merchant.skipped, true);
  assert.equal(merchant.statusLabel, '已跳过排产');
  assert.match(merchant.reason, /电路板/);
  assert.equal(result.timeline.filter(job => job.kind === 'production').length, 0);
});

test('禁用工厂但库存、在产或待收已覆盖需求时保留订单', () => {
  for (const source of ['inventory', 'queue', 'finished']) {
    const { snapshot, settings, plan } = fixture();
    settings.factory.disabledTypes = ['食品厂'];
    snapshot.factories[0].enabled = false;
    snapshot.recipes[0].available = false;
    if (source === 'inventory') snapshot.inventory.push({ id: '面包', num: 2 });
    if (source === 'finished') snapshot.factories[0].finished.push({ id: '面包', num: 2 });
    if (source === 'queue') {
      snapshot.factories[0].queue = [1, 2].map(index => ({ id: 'q' + index, productId: '面包', num: 1, finishTime: 1000 + index * 60 }));
      snapshot.buildings[0].factory.factoryQ = snapshot.factories[0].queue;
    }
    const result = plan();
    assert.equal(result.status, 'optimal', source);
    assert.equal(result.orders[0].skipped, false, source);
    assert.equal(result.timeline.filter(job => job.kind === 'production').length, 0, source);
    assert.equal(result.completionAt, source === 'queue' ? 1120 : 1000, source);
  }
});

test('上游加工品等级不足跳过整单，普通原料短缺继续保留阻塞', () => {
  const { snapshot, settings } = fixture();
  snapshot.inventory = [];
  const extendedConfig = { ...config, tables: { ...config.tables,
    BuildingProduceCfg: table([...config.tables.BuildingProduceCfg.data,
      { itemId: '小麦种子', buildType: '种子厂', unlockLevel: 2, produceTime: 10, costItem: [] }]),
  } };
  snapshot.buildings.push({ id: '1种子厂', buildingId: '1种子厂', type: '种子厂', level: 1, factory: { factoryQ: [] } });
  snapshot.factories.push({ id: '1种子厂', type: '种子厂', level: 1, capacity: 6, enabled: true, queue: [], finished: [] });
  snapshot.recipes.push({ id: '小麦种子', productId: '小麦种子', facilityType: '种子厂', costs: [],
    output: 1, durationSeconds: 10, unlockLevel: 2, available: false });
  const result = planProduction(snapshot, extendedConfig, settings);
  assert.equal(result.orders[0].skipped, true);
  assert.match(result.orders[0].reason, /小麦种子/);
  const ordinary = fixture();
  ordinary.snapshot.inventory = [];
  const blocked = ordinary.plan();
  assert.equal(blocked.status, 'infeasible');
  assert.equal(blocked.orders[0].skipped, false);
});

test('全部跳过明确展示，恢复工厂后自动重新纳入排产', () => {
  const { snapshot, settings, plan } = fixture();
  settings.factory.disabledTypes = ['1食品厂'];
  snapshot.factories[0].enabled = false;
  snapshot.recipes[0].available = false;
  const skipped = plan();
  assert.equal(skipped.orders[0].skipped, true);
  assert.match(skipped.statusLabel, /全部跳过排产/);
  assert.equal(skipped.completionAt, null);
  settings.factory.disabledTypes = [];
  snapshot.factories[0].enabled = true;
  snapshot.recipes[0].available = true;
  const restored = plan();
  assert.equal(restored.status, 'optimal');
  assert.equal(restored.orders[0].skipped, false);
  assert.equal(restored.completionAt, 1120);
});

test('禁用配方的有限库存按优先级只分配一次，跳过后续不足订单', () => {
  const { snapshot, settings, plan } = fixture();
  settings.factory.disabledTypes = ['食品厂'];
  settings.factory.demandPriority = ['merchant', 'resident'];
  snapshot.factories[0].enabled = false;
  snapshot.recipes[0].available = false;
  snapshot.inventory = [{ id: '面包', num: 1 }];
  snapshot.orders[0].requirements[0].num = 1;
  snapshot.orders.push({ ...snapshot.orders[0], id: 'merchant:1', source: 'merchant' });
  const result = plan();
  assert.equal(result.status, 'optimal');
  assert.equal(result.orders.find(order => order.source === 'merchant').skipped, false);
  assert.equal(result.orders.find(order => order.source === 'resident').skipped, true);
});

test('状态未读完整时保留待确认，避免用缺失设施跳过订单', () => {
  const { snapshot, plan } = fixture();
  snapshot.complete = false;
  snapshot.missingReads.push({ request: 'OnWaterRequest', reason: '未返回' });
  snapshot.buildings = snapshot.buildings.filter(building => building.type !== '食品厂');
  snapshot.factories = [];
  const result = plan();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.orders[0].skipped, false);
});

test('备货和未来候选不混入当前订单目标', () => {
  const { snapshot, plan } = fixture();
  snapshot.orders.push({ id: 'stock', source: 'factory', kind: 'stockTarget', requirements: [{ id: '未知', num: 50 }] });
  const result = plan();
  assert.equal(result.orders.length, 1);
  assert.equal(result.upperBound, 120);
});

test('未读库存、未知在产时刻与自动追加任务显式待确认', () => {
  for (const mode of ['missing', 'queue', 'native']) {
    const { snapshot, plan } = fixture();
    if (mode === 'missing') { snapshot.complete = false; snapshot.missingReads.push({ request: 'AllItemRequest', reason: '未返回' }); }
    if (mode === 'queue') snapshot.factories[0].queue = [{ id: 'q', productId: '面包', num: 1, finishTime: null }];
    if (mode === 'native') snapshot.factories[0].nativeAutoActive = true;
    const result = plan();
    assert.equal(result.status, 'incomplete');
    assert.equal(result.completionAt, null);
  }
});

test('关闭提交的订单独占材料，待确认扣款阻断相关排程', () => {
  const { snapshot, settings } = fixture();
  snapshot.orders[0].metadata.enabled = false;
  const model = buildProductionModel(snapshot, config, settings, { pendingMaterials: [{ scope: new Set(['小麦']), label: '上次开工' }] });
  assert.equal(model.input.orders[0].consumeOnCompletion, false);
  assert.equal(model.input.complete, false);
  assert.match(model.input.missingReads.join(), /上次开工/);
});

test('用于腾仓的候选配方同样遵守原料待确认扣款', () => {
  const { snapshot, settings } = fixture();
  snapshot.recipes.push({ id: '饼干', productId: '饼干', facilityType: '食品厂', costs: [{ id: '面包', num: 1 }, { id: '糖', num: 1 }],
    output: 1, durationSeconds: 60, unlockLevel: 1, available: true });
  const extendedConfig = { ...config, tables: { ...config.tables, BuildingProduceCfg: table([...config.tables.BuildingProduceCfg.data,
    { itemId: '饼干', buildType: '食品厂', unlockLevel: 1, produceTime: 60 }]) } };
  const model = buildProductionModel(snapshot, extendedConfig, settings, { pendingMaterials: [{ scope: new Set(['糖']), label: '腾仓材料未结算' }] });
  assert.equal(model.input.complete, false);
  assert.match(model.input.missingReads.join(), /腾仓材料未结算/);
});

test('零份待收成品不制造虚假未知任务，输入保持原样', () => {
  const { snapshot, plan } = fixture();
  snapshot.factories[0].finished.push({ id: '面包', num: 0 });
  const before = JSON.stringify(snapshot);
  assert.equal(plan().status, 'optimal');
  assert.equal(JSON.stringify(snapshot), before);
});

test('真实配置来源顺序传入模型，未列出的当前订单置于最后', () => {
  const { snapshot, settings } = fixture();
  settings.factory.demandPriority = ['building', 'cargo', 'resident'];
  snapshot.orders.push({ ...snapshot.orders[0], id: 'cargo:1', source: 'cargo' });
  snapshot.orders.push({ ...snapshot.orders[0], id: 'merchant:1', source: 'merchant' });
  const model = buildProductionModel(snapshot, config, settings);
  assert.deepEqual(model.input.orders.map(order => [order.source, order.priority]), [['cargo', 1], ['resident', 2], ['merchant', 3]]);
});

test('高优先建筑需求及上游材料继承顺序，其他设备保持并行', () => {
  const { snapshot, settings } = fixture();
  settings.building.supply = true;
  settings.factory.demandPriority = ['building', 'resident'];
  snapshot.inventory = [{ id: '小麦种子', num: 3 }];
  snapshot.orders[0].requirements = [{ id: '小麦', num: 5 }];
  snapshot.orders.push({ id: 'building:1', source: 'building', kind: 'consumption',
    requirements: [{ id: '面包', num: 1 }], metadata: { buildingId: '1民居', level: 2 } });
  const result = planProduction(snapshot, config, settings, { search: { maxMilliseconds: 1000, maxNodes: 100000 } });
  assert.equal(result.objective, 'priority-makespan');
  assert.equal(result.scope, 'configured-demands');
  assert.equal(result.status, 'optimal');
  assert.equal(result.orders.find(order => order.source === 'building').completionAt, 1090);
  const wheat = result.timeline.filter(job => job.itemId === '小麦');
  assert.equal(wheat[0].priority, 0);
  assert.equal(wheat[0].inheritedPriority, true);
  assert.match(wheat[0].priorityLabel, /建筑备料/);
  const bread = result.timeline.find(job => job.itemId === '面包');
  assert(wheat.some(job => job.startAt === bread.startAt), '余下作物与建筑所需的面包在独立设施并行');
});

test('建筑备料关闭时不加入目标，开启后保护已经齐套的建筑材料', () => {
  const { snapshot, settings } = fixture();
  settings.factory.demandPriority = ['building', 'resident'];
  snapshot.inventory = [{ id: '小麦', num: 1 }, { id: '小麦种子', num: 1 }];
  snapshot.orders[0].requirements[0].num = 1;
  snapshot.orders.push({ id: 'building:1', source: 'building', kind: 'consumption',
    requirements: [{ id: '小麦', num: 1 }], metadata: { buildingId: '1民居', level: 2, ready: true } });
  assert.equal(buildProductionModel(snapshot, config, settings).input.orders.length, 1);
  settings.building.supply = true;
  const model = buildProductionModel(snapshot, config, settings);
  assert.equal(model.input.orders[0].consumeOnCompletion, false);
  const result = planProduction(snapshot, config, settings, { search: { maxMilliseconds: 1000, maxNodes: 100000 } });
  assert.equal(result.orders.find(order => order.source === 'building').completionAt, 1000);
  assert.equal(result.orders.find(order => order.source === 'resident').completionAt, 1090);
});

test('交换用户来源优先级后共享库存分配与完成次序随之改变', () => {
  const { snapshot, settings } = fixture();
  snapshot.inventory = [{ id: '面包', num: 1 }, { id: '小麦', num: 1 }];
  snapshot.orders[0].requirements[0].num = 1;
  snapshot.orders.push({ ...snapshot.orders[0], id: 'cargo:1', source: 'cargo' });
  for (const sources of [['cargo', 'resident'], ['resident', 'cargo']]) {
    settings.factory.demandPriority = sources;
    const result = planProduction(snapshot, config, settings, { search: { maxMilliseconds: 1000, maxNodes: 100000 } });
    assert.equal(result.orders.find(order => order.source === sources[0]).completionAt, 1000);
    assert.equal(result.orders.find(order => order.source === sources[1]).completionAt, 1060);
    assert.equal(result.priorityBounds[0].upperBound, 0);
    assert.equal(result.priorityBounds[1].upperBound, 60);
  }
});

test('自定义农田读取作物对象和水位，自动种植开关关闭时仍可按自定义种植', () => {
  const { snapshot, settings } = fixture();
  settings.farm.autoPlant = false;
  settings.farm.customPlant = true;
  settings.farm.crops = [{ id: '小麦', target: 5 }];
  snapshot.inventory = [{ id: '小麦种子', num: 1 }];
  snapshot.orders[0].requirements = [{ id: '小麦', num: 5 }];
  const model = buildProductionModel(snapshot, config, settings);
  assert.deepEqual(model.input.recipes.find(recipe => recipe.itemId === '小麦').machineIds, ['1农田']);
  assert.equal(model.input.stockCaps['小麦'], 5);
  assert.equal(planProduction(snapshot, config, settings).upperBound, 30);
  settings.farm.crops[0].target = 0;
  assert.equal(buildProductionModel(snapshot, config, settings).input.recipes.find(recipe => recipe.itemId === '小麦').enabled, false);
});

console.log(`生产排程适配测试 ${passed}/${passed} 通过`);
