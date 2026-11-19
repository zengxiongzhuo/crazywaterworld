import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProductionTiming, watchProductionTimings } from '../src/production-timing.mjs';

// DispFactoryJob's generated protobuf prototype supplies these defaults when
// fields are absent from a decoded message. Keep this fixture bundle-independent.
const factoryJobPrototype = { idx: 0, productId: '', finishTime: 0 };
const config = { tables: {
  BuildingProduceCfg: { data: [
    { itemId: '小麦种子', buildType: '种子厂', produceTime: 1800 },
    { itemId: '面包', buildType: '食品厂', produceTime: 5400 },
  ] },
  MonthCardCfg: { data: [
    { id: '普通月卡', effectList: [['第二生产位', 1]] },
    { id: '高级月卡', effectList: [] },
  ] },
} };
const seed = config.tables.BuildingProduceCfg.data[0];
const effects = { effects: [{ id: 1, value: 0 }, { id: 2, value: 1231 }, { id: 11, value: 394 }] };
const job = (idx, finishTime, productId = '小麦种子') => ({ idx, productId,
  ...(finishTime === undefined ? {} : { finishTime }) });
const building = (queue = [], buildingId = '1种子厂', extra = {}) => ({ buildingId, level: 1,
  factory: { factoryQ: queue }, ...extra });
const timing = extra => createProductionTiming({ config, effects, serverNow: 1000, monthCards: [], ...extra });
let passed = 0;
function test(name, work) {
  work();
  passed++;
  console.log('通过：' + name);
}

function fixture() {
  const client = new EventEmitter();
  client.connected = true;
  client.serverClockOffsetMs = 2000;
  client.request = client.sendWatch = () => { throw new Error('耗时观察器只能监听已有流量'); };
  const clock = { wall: 998000, monotonic: 10000 };
  const source = structuredClone(config);
  const watcher = watchProductionTimings(client, () => source,
    { now: () => clock.wall, monotonicNow: () => clock.monotonic });
  const message = (name, body) => client.emit('message', { name, body });
  const push = (queue, buildingId, extra = {}) => message('SCUpdateWaterBuilding', {
    building: [building(queue, buildingId, extra)],
  });
  const advance = seconds => { clock.wall += seconds * 1000; clock.monotonic += seconds * 1000; };
  const measure = (buildingId = '1种子厂') => {
    const serverNow = (clock.wall + client.serverClockOffsetMs) / 1000;
    const end = Math.ceil(serverNow + 100);
    push([job(0, end), job(1), job(2)], buildingId);
    advance(end - serverNow + 0.2);
    push([job(1, end + 570), job(2)], buildingId);
  };
  return { client, clock, source, watcher, message, push, advance, measure };
}

test('全局工厂减时采用客户端公式并保留估算标签', () => {
  const result = timing().factory(seed, { building: building() });
  assert.equal(result.seconds, 569);
  assert.equal(result.source, 'effects-estimate');
  assert.equal(result.estimated, true);
  assert(result.reasons.some(reason => reason.includes('尚未完整核验')));
  const boosted = timing({ effects: [{ id: 1, value: 0.5 }, { id: 2, value: 600 }] });
  assert.equal(boosted.factory(seed).seconds, 800);
});

test('同厂同配方实测优先，跨厂和跨配方保持独立', () => {
  const observedDurations = [
    { buildingId: '1种子厂', productId: '小麦种子', seconds: 570, samples: 2 },
    { buildingId: '2种子厂', productId: '小麦种子', seconds: 322, samples: 1 },
    { buildingId: '1种子厂', productId: '面包', seconds: 4170, samples: 1 },
  ];
  const value = timing({ observedDurations });
  const result = value.factory(seed, { building: building() });
  assert.equal(result.seconds, 570);
  assert.equal(result.source, 'observed');
  assert.equal(result.estimated, false);
  assert.equal(result.samples, 2);
  assert.equal(value.factory(seed, { building: building([], '2种子厂') }).seconds, 322);
  assert.equal(value.factory(seed, { building: building([], '3种子厂') }).source, 'effects-estimate');
  assert.equal(value.factory(seed).source, 'effects-estimate');
});

test('实测差异按最长有效值安排，无效样本不参与', () => {
  const observedDurations = [570, 571, -10, 0, 1.5, NaN, Infinity].map(seconds => ({
    buildingId: '1种子厂', productId: '小麦种子', seconds,
  }));
  observedDurations.push({ buildingId: '1种子厂', productId: '小麦种子', seconds: 9999, samples: 0 });
  const result = timing({ observedDurations }).factory(seed, { building: building() });
  assert.equal(result.seconds, 571);
  assert.equal(result.samples, 2);
  assert(result.reasons.some(reason => reason.includes('最长耗时')));
});

test('缺失和重复加成采用原始配置，非法配方显式不可用', () => {
  for (const incomplete of [undefined, {}, [], [{ id: 2, value: 1231 }],
    [{ id: 1, value: 0 }, { id: 1, value: 0 }, { id: 2, value: 1231 }],
    [{ id: 1, value: -1 }, { id: 2, value: 1231 }]]) {
    const result = timing({ effects: incomplete }).factory(seed);
    assert.equal(result.seconds, 1800);
    assert.equal(result.source, 'config-estimate');
    assert.equal(result.estimated, true);
  }
  for (const produceTime of [0, -1, 0.5, NaN, Infinity]) {
    const result = timing().factory({ ...seed, produceTime });
    assert.equal(result.seconds, null);
    assert.equal(result.source, 'unavailable');
  }
  assert.equal(createProductionTiming().factory().seconds, null);
  assert.equal(timing({ observedDurations: [null, {}] }).factory().seconds, null);
});

test('农田使用农田减时，工厂样本与农田样本分别匹配', () => {
  const crop = { id: '小麦', time: 1800 };
  assert.equal(timing().farm(crop).seconds, 1406);
  assert.equal(timing().farm(crop).estimated, true);
  const observedDurations = [{ kind: 'farm', productId: '小麦', seconds: 1406, samples: 2 },
    { kind: 'factory', productId: '小麦', buildingId: '1种子厂', seconds: 500, samples: 1 }];
  assert.equal(timing({ observedDurations }).farm(crop).source, 'observed');
  const instant = timing({ effects: [{ id: 11, value: 2000 }] }).farm(crop);
  assert.equal(instant.seconds, 1);
  assert.equal(instant.estimated, true);
});

test('六格排队且只有一个计时项时只使用一个生产位', () => {
  const value = timing().lanes(building([job(0, 1100), ...[1, 2, 3, 4, 5].map(idx => job(idx))]));
  assert.equal(value.count, 1);
  assert.equal(value.source, 'observed');
  assert.equal(value.estimated, false);
  assert.equal(value.expiresAt, null);
});

test('月卡第二生产位在空厂或只有一件在产时也可用', () => {
  const value = timing({ monthCards: { cardItem: [{ type: 1, endTime: 5000 }] } });
  for (const queue of [[], [job(0, 1100)], [job(0, 1100), job(1, 1200), job(2)]]) {
    const lanes = value.lanes(building(queue));
    assert.equal(lanes.count, 2);
    assert.equal(lanes.estimated, false);
    assert.equal(lanes.expiresAt, 5000);
    assert.equal(lanes.afterExpiry, 1);
  }
  assert.equal(timing({ monthCards: [{ type: 2, endTime: -1 }] }).lanes(building()).count, 1);
  assert.equal(timing({ monthCards: [{ type: 1, endTime: 1000 }] }).lanes(building()).count, 1);
  assert.equal(timing({ monthCards: [{ type: 1, endTime: -1 }, { type: 2, endTime: -1 }] }).lanes(building()).count, 2);
});

test('永久月卡保留双位，过期与未知权益禁止延续额外生产位', () => {
  const parallel = building([job(0, 1100), job(1, 1200)]);
  const permanent = timing({ monthCards: [{ type: 1, endTime: -1 }] }).lanes(parallel);
  assert.equal(permanent.count, 2);
  assert.equal(permanent.expiresAt, null);
  assert.equal(permanent.estimated, false);
  for (const monthCards of [undefined, [], [{ type: 1, endTime: 1000 }],
    [{ type: 1, endTime: 2000 }, { type: 1, endTime: 3000 }]]) {
    const result = timing({ monthCards }).lanes(parallel);
    assert.equal(result.count, 2);
    assert.equal(result.expiresAt, 1000);
    assert.equal(result.estimated, true);
  }
});

test('失效计时和未读取服务端时间不会增加并行数量', () => {
  assert.equal(timing().lanes(building([job(0, 900), job(1, 1000)])).count, 1);
  const result = timing({ serverNow: undefined }).lanes(building([job(0, 1100), job(1, 1200)]));
  assert.equal(result.count, 1);
  assert.equal(result.estimated, true);
  assert.equal(timing({ monthCards: undefined }).lanes(building()).source, 'default-estimate');
  assert.equal(timing().lanes(building([job(0, 1100), job(0, 1200)])).count, 1);
  assert.equal(timing().lanes(building([{ idx: 0, finishTime: 1100 }, job(1, 1200)])).count, 1);
});

test('月卡到期前排队的短任务不能越过等常驻位的长任务', () => {
  const value = timing({ effects: [], monthCards: [{ type: 1, endTime: 3200 }] });
  const queue = [job(47, 1200), job(48, undefined, '面包'), job(49)];
  const { jobs, finishes } = value.factoryQueue(building(queue));
  assert.deepEqual(jobs.map(entry => entry.start), [1000, 1200, 1200]);
  assert.deepEqual(finishes, [6600, 3000]);
});

test('从连续队头完成时刻差取实测，重复推送不会重复计样', () => {
  const f = fixture();
  f.measure();
  const sample = f.watcher.snapshot()[0];
  assert.deepEqual(sample, { kind: 'factory', buildingId: '1种子厂', productId: '小麦种子',
    seconds: 570, samples: 1, observedAt: 1100.2 });
  f.push([job(1, 1670), job(2)]);
  assert.equal(f.watcher.snapshot()[0].samples, 1);
  f.advance(570);
  f.push([job(2, 2240)]);
  assert.equal(f.watcher.snapshot()[0].samples, 2);
  const copy = f.watcher.snapshot();
  copy[0].seconds = 9999;
  assert.equal(f.watcher.snapshot()[0].seconds, 570);
  f.watcher.dispose();
});

test('protobuf原型缺省finishTime为0的交接推送可保留连续性', () => {
  const f = fixture();
  f.push([job(0, 1100), job(1), job(2)]);
  f.advance(100);
  const pending = [job(1), job(2)].map(fields => Object.assign(Object.create(factoryJobPrototype), fields));
  assert.equal(Object.hasOwn(pending[0], 'finishTime'), false);
  assert.equal(pending[0].finishTime, 0);
  const body = { building: [building(pending)] };
  f.message('SCUpdateWaterBuilding', body);
  f.advance(0.2);
  f.push([job(1, 1670), job(2)]);
  assert.equal(f.watcher.snapshot()[0].seconds, 570);
  f.watcher.dispose();
});

test('过期队头的延迟快照保留已完成的实测记录', () => {
  const f = fixture();
  f.measure();
  f.advance(571);
  f.push([job(1, 1670), job(2)]);
  assert.equal(f.watcher.snapshot()[0].samples, 1);
  f.push([job(2, 2240)]);
  assert.equal(f.watcher.snapshot()[0].samples, 2);
  f.watcher.dispose();
});

test('跳过任务、提前换头和过长间隔均不生成样本', () => {
  for (const [next, elapsed] of [[job(2, 1670), 100], [job(1, 1670), 50], [job(1, 2903), 100]]) {
    const f = fixture();
    f.push([job(0, 1100), job(1), job(2)]);
    f.advance(elapsed);
    f.push([next]);
    assert.deepEqual(f.watcher.snapshot(), []);
    f.watcher.dispose();
  }
});

test('加速、取消、建筑变更请求按目标工厂清除校准', () => {
  for (const name of ['SpeedUpFactoryProduceRequest', 'CancelFactoryProduceRequest',
    'SetFactoryAutoProduceRequest', 'CancelFactoryAutoProduceRequest', 'UpgradeBuildingRequest',
    'FinishUpgradeBuildingRequest', 'SpeedUpUpgradeBuildingRequest', 'ApplyBuildingSkinRequest']) {
    const f = fixture();
    f.measure('1种子厂');
    f.measure('2种子厂');
    f.client.emit('frame', { dir: 'out', name, body: { buildingId: '1种子厂' } });
    assert.deepEqual(f.watcher.snapshot().map(row => row.buildingId), ['2种子厂']);
    f.watcher.dispose();
  }
});

test('同任务完成时间、建筑等级、皮肤或原生目标变化清除校准', () => {
  const cases = [
    { queue: [job(1, 1600), job(2)], extra: {} },
    { queue: [job(1, 1670), job(2)], extra: { level: 2 } },
    { queue: [job(1, 1670), job(2)], extra: { skinId: '加速皮肤' } },
    { queue: [], extra: { factory: { factoryQ: [job(1, 1670), job(2)], autoProductId: '小麦种子' } } },
  ];
  for (const { queue, extra } of cases) {
    const f = fixture();
    f.measure();
    f.push(queue, '1种子厂', extra);
    assert.deepEqual(f.watcher.snapshot(), []);
    f.watcher.dispose();
  }
});

test('并行交接、非法队列或不在队首的计时项清除该厂样本', () => {
  for (const queue of [[job(1, 1670), job(2, 1800)], [job(1, 1670), job(1)],
    [job(1), job(2, 1670)], [job(1, -10)], [{ idx: 1, finishTime: 1670 }]]) {
    const f = fixture();
    f.measure();
    f.push(queue);
    assert.deepEqual(f.watcher.snapshot(), []);
    f.watcher.dispose();
  }
});

test('完整效果响应比较所有效果值，数组换序保持样本', () => {
  const f = fixture();
  f.message('GameEffectResponse', effects);
  f.measure();
  f.message('GameEffectResponse', { effects: [...effects.effects].reverse() });
  assert.equal(f.watcher.snapshot().length, 1);
  f.message('GameEffectResponse', { effects: [...effects.effects, { id: 99, value: 1 }] });
  assert.deepEqual(f.watcher.snapshot(), []);
  f.watcher.dispose();
});

test('效果和英雄推送清除样本', () => {
  for (const name of ['SCGameEffectUpdate', 'SCUpdateHero']) {
    const f = fixture();
    f.measure();
    f.message(name, { effect: { id: 99, value: 1 } });
    assert.deepEqual(f.watcher.snapshot(), []);
    f.watcher.dispose();
  }
});

test('英雄、任命、月卡和环境皮肤读取变化清除样本', () => {
  for (const name of ['AllHeroResponse', 'AppointInfoResponse', 'MonthCardResponse', 'EnvSkinListResponse']) {
    const f = fixture();
    f.message(name, { value: 1 });
    f.measure();
    f.message(name, { value: 1 });
    assert.equal(f.watcher.snapshot().length, 1);
    f.message(name, { value: 2 });
    assert.deepEqual(f.watcher.snapshot(), []);
    f.watcher.dispose();
  }
});

test('英雄技能、任命与皮肤变更请求清除样本', () => {
  for (const name of ['AutoAppointRequest', 'UnAppointHeroRequest', 'HeroSkillLevelUpRequest',
    'HeroStarUpRequest', 'SwitchHeroSkinRequest', 'UpdateEnvSkinRequest']) {
    const f = fixture();
    f.measure();
    f.client.emit('frame', { dir: 'out', name, body: {} });
    assert.deepEqual(f.watcher.snapshot(), []);
    f.watcher.dispose();
  }
});

test('时钟偏移、墙钟回拨和向前跳变清除样本', () => {
  for (const change of [
    f => { f.client.serverClockOffsetMs += 2000; f.client.emit('pong'); },
    f => { f.client.serverClockOffsetMs += 2000; },
    f => { f.clock.wall -= 2000; },
    f => { f.clock.wall += 2000; },
    f => { f.clock.monotonic -= 2000; },
    f => { f.clock.wall = NaN; },
  ]) {
    const f = fixture();
    f.measure();
    change(f);
    f.push([job(1, 1670), job(2)]);
    assert.deepEqual(f.watcher.snapshot(), []);
    f.watcher.dispose();
  }
});

test('配方耗时变化及配置读取失败清除样本', () => {
  const f = fixture();
  f.measure();
  f.source.tables.BuildingProduceCfg.data[0].produceTime = 2000;
  f.push([job(1, 1670), job(2)]);
  assert.deepEqual(f.watcher.snapshot(), []);
  f.watcher.dispose();
  const client = new EventEmitter();
  const watcher = watchProductionTimings(client, () => { throw new Error('配置未就绪'); });
  assert.doesNotThrow(() => client.emit('message', { name: 'OnWaterResponse', body: { building: [building()] } }));
  assert.deepEqual(watcher.snapshot(), []);
  watcher.dispose();
});

test('普通出入消息和正常收取保持已有样本', () => {
  const f = fixture();
  f.measure();
  f.client.emit('frame', { dir: 'in', name: 'SpeedUpFactoryProduceRequest', body: {} });
  f.client.emit('frame', { dir: 'out', name: 'GainFactoryProduceRequest', body: { buildingId: '1种子厂' } });
  f.message('UnrelatedResponse', {});
  f.push([]);
  assert.equal(f.watcher.snapshot().length, 1);
  f.watcher.dispose();
});

test('断开、重新登录与释放观察器清理状态，重复挂载复用实例', () => {
  const f = fixture();
  assert.equal(watchProductionTimings(f.client, config), f.watcher);
  f.measure();
  f.client.connected = false;
  assert.deepEqual(f.watcher.snapshot(), []);
  f.client.connected = true;
  f.client.emit('close');
  assert.deepEqual(f.watcher.snapshot(), []);
  f.measure();
  f.client.emit('login');
  assert.deepEqual(f.watcher.snapshot(), []);
  f.watcher.dispose();
  f.watcher.dispose();
  assert.equal(f.client.eventNames().length, 0);
  const fresh = watchProductionTimings(f.client, config);
  assert.notEqual(fresh, f.watcher);
  fresh.dispose();
});

console.log('生产耗时校准自测通过，共 ' + passed + ' 项');
