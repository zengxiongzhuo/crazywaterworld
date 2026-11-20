import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger, defaultSettings, validateSettings } from '../src/automation-settings.mjs';
import { readResourceFieldState, readResourceFieldsOverview, previewResourceField, previewResourceFieldPlan, runResourceFieldShortcut, runResourceFields,
  previewResourceFieldGiveUp, runResourceFieldGiveUp } from '../src/resource-field-automation.mjs';
import { fleetRecordReason, reserveDispatch } from '../src/fleet-availability.mjs';
import { checkFleetSettlement, settleFleetSnapshot, outstandingFleets } from '../src/fleet-settlement.mjs';
import { pendingPetrol } from '../src/dispatch-preview.mjs';
import { resourceFieldFixture } from './fixtures/resource-fields.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resource-fields-'));
let sequence = 0; const results = [];
const setup = () => {
  const f = resourceFieldFixture(), settings = defaultSettings();
  const file = path.join(directory, String(++sequence) + '.json');
  const createLedger = () => createUsageLedger('虚构资源田账号', { file, now: () => Date.now() + f.client.serverClockOffsetMs });
  const ledger = createLedger(), options = { getSettings: () => settings, ledger, mapLoader: f.mapLoader, enabled: () => true };
  return { f, settings, ledger, options, createLedger, file };
};
const read = ({ f, options }) => readResourceFieldState(f.client, f.protocol, f.config, f.player, options);
const preview = ({ f, options }, gridIdx = 10) => previewResourceField(f.client, f.protocol, f.config, f.player, { gridIdx }, options);
const send = ({ f, options }, p, id = '1远征船') => runResourceFieldShortcut(f.client, f.protocol, f.config, f.player, p, id, options);
const run = ({ f, options }) => runResourceFields(f.client, f.protocol, f.config, f.player, options);
const automatic = test => Object.assign(test.settings.resourceFields, { enabled: true, fleetIds: ['1远征船'], allocationMode: 'ratio',
  ratios: { fuel: 1, seeds: 0, tech: 0 }, minLevel: 1, minDurabilityPercent: 50, reserveFleetCount: 0 });
const replacing = () => {
  const t = setup(); t.f.state.maxNum = 1; t.f.state.fields = [{ gridIdx: 20, cityId: 2, type: 3 }]; return t;
};
const replacePreview = ({ f, options }, gridIdx = 10, replaceGridIdx = 20) => previewResourceField(f.client, f.protocol, f.config, f.player, { gridIdx, replaceGridIdx }, options);
const giveUpPreview = ({ f, options }, gridIdx = 20) => previewResourceFieldGiveUp(f.client, f.protocol, f.config, f.player, { kind: 'giveUp', gridIdx }, options);
const giveUp = ({ f, options }, p) => runResourceFieldGiveUp(f.client, f.protocol, f.config, f.player, p, options);
const test = async (name, body) => {
  try { await body(); results.push(true); console.log('通过：' + name); }
  catch (error) { results.push(false); console.error('失败：' + name + '\n' + error.stack); }
};

try {
  await test('新账号默认关闭，资源田设置通过统一验证', () => {
    const t = setup(); assert.equal(t.settings.resourceFields.enabled, false);
    automatic(t); assert.equal(validateSettings(t.settings).resourceFields.enabled, true);
  });
  await test('真实协议读取和预览不写游戏，只推荐本人未占的本盟城市', async () => {
    const t = setup(), state = await read(t);
    assert.equal(state.reason, ''); assert.equal(state.count, 0); assert.equal(state.remaining, 5);
    assert.equal(state.candidates.length, 6);
    assert(!state.candidates.some(row => [30, 40].includes(row.grid)));
    const p = await preview(t); assert.equal(p.cost, 300); assert(p.fleets.some(fleet => fleet.available));
    assert.equal(t.f.client.writes.length, 0); assert.equal(Object.keys(t.ledger.keyRecords()).length, 0);
  });
  await test('资源田总览返回超过 60 块的同类候选，包括低等级地块', async () => {
    const { f, options } = setup();
    f.state.mapFields = Array.from({ length: 64 }, (_, gridIdx) => ({
      gridIdx, cityId: gridIdx === 63 ? 2 : 1, resType: 1,
    }));
    const view = await readResourceFieldsOverview(f.client, f.protocol, f.config, f.player, options);
    assert.equal(view.candidateCount, 64);
    assert.equal(view.candidates.length, 64);
    assert(view.candidates.some(field => field.grid === 63 && field.level === 4));
  });
  await test('主城产量取联盟等级，推荐战力取1级；普通田取resLevel', async () => {
    const t = setup(), state = await read(t);
    const home = state.candidates.find(row => row.grid === 10), ordinary = state.candidates.find(row => row.grid === 20);
    assert.equal(home.level, 8); assert.equal(home.perHour, 780); assert.equal(home.recommendedPower, 25000);
    assert.equal(ordinary.level, 4); assert.equal(ordinary.perHour, 540); assert.equal(ordinary.recommendedPower, 140000);
  });
  await test('己方田、失效田和未知归属产量区别，失效不继续计收入', async () => {
    const t = setup(); t.f.state.fields = [
      { gridIdx: 10, cityId: 1, type: 3 }, { gridIdx: 30, cityId: 3, type: 3 }, { gridIdx: 21, cityId: 2, type: 2 },
    ];
    let state = await read(t); assert.equal(state.count, 3);
    assert.equal(state.totals.find(row => row.id === '汽油').perHour, 780);
    assert.equal(state.owned.find(row => row.grid === 30).active, false);
    assert(!state.candidates.some(row => row.grid === 10));
    t.f.state.cities = t.f.state.cities.filter(row => row.id !== 1); state = await read(t);
    assert.equal(state.totals.find(row => row.id === '汽油').perHour, null);
    assert.equal(state.totals.find(row => row.id === '种子').perHour, 540);
  });
  await test('缺联盟等级不猜主城产量，缺占领列表不误报0块', async () => {
    const t = setup(); t.f.state.guilds = []; let state = await read(t);
    assert(!state.candidates.some(row => row.cityId === 1));
    t.f.beforeRead = name => name === 'MyResFieldsRequest' ? {} : undefined;
    state = await read(t); assert.equal(state.count, null); assert.match(state.reason, /名额/);
    assert(state.totals.every(row => row.perHour === null));
  });
  await test('雷达事件格优先，真实radarInfo包装不会误阻断普通田', async () => {
    const t = setup(); t.f.beforeRead = name => name === 'RadarInfoRequest' ? { radarInfo: { events: [{ gridIdx: 10 }], fixedEvent: { gridIdx: 11 } } } : undefined;
    const state = await read(t); assert.equal(state.reason, '');
    assert(!state.candidates.some(row => [10, 11].includes(row.grid))); assert(state.candidates.some(row => row.grid === 12));
  });
  await test('忙碌、空编队、零耐久和外驻舰队不可快捷占领', async () => {
    const t = setup(); t.f.state.fleets[0].state = 2; t.f.state.fleets[1].durability = 0;
    t.f.state.buildings[2].fleet.formation.heroPositions = [];
    assert((await preview(t)).fleets.every(fleet => !fleet.available));
    t.f.state.buildings[2].fleet.formation.heroPositions = [{ heroId: '兰博' }]; t.f.state.fleets[2].curGridIdx = 12;
    assert((await preview(t)).fleets.every(fleet => !fleet.available));
  });
  await test('其他任务持久锁和城战预留禁止抢队', async () => {
    const t = setup(); t.ledger.reserve({}, {}, {}, { uniqueKey: 'other-operation', details: { kind: 'radarSend', worldId: '1001001', buildingId: '1远征船', active: true } });
    reserveDispatch(t.f.client, 'maintenance', ['2远征船']); const p = await preview(t);
    assert(!p.fleets.find(row => row.id === '1远征船').available);
    assert(!p.fleets.find(row => row.id === '2远征船').available);
    assert(p.fleets.find(row => row.id === '3远征船').available);
  });
  await test('占田上限与其他任务待确认汽油都会阻止派遣', async () => {
    const t = setup(); t.f.state.maxNum = 0; assert((await preview(t)).fleets.every(fleet => !fleet.available));
    t.f.state.maxNum = 5; t.f.state.fuel = 500;
    t.ledger.reserve({ radarPetrol: 300 }, {}, {}, { uniqueKey: 'pending-fuel' });
    assert((await preview(t)).fleets.every(fleet => !fleet.available)); assert.equal(t.f.client.writes.length, 0);
  });
  await test('派遣确认只证明出征，保留舰队与目标直到占领和返航', async () => {
    const t = setup(), result = await send(t, await preview(t));
    assert.equal(result.status, 'confirmed'); assert.equal(t.f.state.fields.length, 0); assert.equal(t.f.state.fuel, 5700);
    assert.equal(t.ledger.snapshot().counters.resourceFieldPetrol, 300);
    assert.match(fleetRecordReason(t.ledger.keyRecords(), '1远征船', '1001001'), /资源田/);
    const state = await read(t); assert.equal(state.remaining, 4); assert.equal(state.pending.length, 1);
    t.f.finish(10, true); const done = await read(t); assert.equal(done.count, 1); assert.equal(done.pending.length, 0);
    assert.equal(fleetRecordReason(t.ledger.keyRecords(), '1远征船', '1001001'), '');
  });
  await test('重复确认同一目标不二次扣汽油', async () => {
    const t = setup(), p = await preview(t); await send(t, p);
    await assert.rejects(() => send(t, p), /等待|占领|任务/); assert.equal(t.f.client.writes.length, 1);
  });
  await test('即时占领回包也能确认，无需等再次观察行军', async () => {
    const t = setup(); t.f.occupyImmediately = true; const result = await send(t, await preview(t));
    assert.equal(result.status, 'confirmed'); assert.equal((await read(t)).count, 1);
    assert.equal(pendingPetrol(t.ledger), 0);
  });
  await test('未知结果跨日和账本重载保留汽油、名额和舰队锁', async () => {
    const t = setup(); t.f.unknown = true; automatic(t); const first = await run(t);
    assert.equal(first[0].status, 'unknown'); assert.equal(pendingPetrol(t.ledger), 300);
    assert.equal((await read(t)).remaining, 4); assert.equal(t.f.state.fleets[0].state, 1);
    t.f.client.serverClockOffsetMs += 86400000; t.options.ledger = t.createLedger();
    await run(t); assert.equal(t.f.client.writes.length, 1); assert.equal(pendingPetrol(t.options.ledger), 300);
  });
  await test('明确服务端拒绝释放未消费预算，未知超时不能释放', async () => {
    const t = setup(); t.f.reject = true; const result = await send(t, await preview(t));
    assert.equal(result.status, 'rejected'); assert.equal(pendingPetrol(t.ledger), 0);
    assert.equal(t.ledger.snapshot().uncertain, 0); assert.equal((await read(t)).remaining, 5);
  });
  await test('提交前城市变敌盟或涨价停止，不能沿用旧预览', async () => {
    const t = setup(), p = await preview(t); t.f.state.cities[0].guildIdx = 8;
    await assert.rejects(() => send(t, p), /本盟/); assert.equal(t.f.client.writes.length, 0);
    t.f.state.cities[0].guildIdx = 7; t.f.config.tables.WorldParamCfg.data[0].paramValue = 301;
    await assert.rejects(() => send(t, p), /变化/); assert.equal(t.f.client.writes.length, 0);
  });
  await test('关闭自动化不派遣，开启后按相对权重占领种子高等级田', async () => {
    const t = setup(); await run(t); assert.equal(t.f.client.writes.length, 0);
    automatic(t).ratios = { fuel: 0, seeds: 2, tech: 0 }; await run(t);
    assert.equal(t.f.client.writes[0].body.resFieldGridIdx, 11); assert.equal(t.f.client.writes.length, 1);
  });
  await test('自动策略遵守战力、耐久、最低等级和闲置舰队保留', async () => {
    for (const change of [t => { t.f.state.fleets[0].power = 1; }, t => { t.f.state.fleets[0].durability = 1; },
      t => { t.settings.resourceFields.minLevel = 9; }, t => { t.settings.resourceFields.reserveFleetCount = 3; }]) {
      const t = setup(); automatic(t); change(t); await run(t); assert.equal(t.f.client.writes.length, 0);
    }
  });
  await test('关闭失守补位仍可首次占田，旧田消失后只预留对应类型的一个名额', async () => {
    const t = setup(), state = t.f.state;
    const policy = Object.assign(automatic(t), { refillAfterLoss: false, allocationMode: 'quota', quotas: { fuel: 2, seeds: 0, tech: 0 } });
    t.f.occupyImmediately = true;
    await run(t); await run(t); await run(t);
    assert.deepEqual(state.fields.map(field => field.gridIdx), [10, 20]);

    // 模拟重启后首次发现失守；额外开放的汽油田允许核对按名额抑制而非按格子绕过。
    t.options.ledger = t.createLedger();
    state.fields = state.fields.filter(field => field.gridIdx !== 20);
    state.mapFields.push({ gridIdx: 23, cityId: 2, resType: 3 }, { gridIdx: 24, cityId: 2, resType: 3 });
    t.f.beforeRead = name => name === 'RadarInfoRequest' ? { radarInfo: { events: [{ gridIdx: 20 }] } } : undefined;
    await run(t);
    assert.equal(t.f.client.writes.length, 2, '同类型其他空田不能填补已失守的那一个名额');
    t.options.ledger = t.createLedger();
    t.f.client.serverClockOffsetMs += 86400000;
    await run(t);
    assert.equal(t.f.client.writes.length, 2, '跨日重新打开账本仍记得失守');

    Object.assign(policy.quotas, { fuel: 3, seeds: 1 });
    await run(t); await run(t); await run(t);
    assert.deepEqual(state.fields.map(field => field.type).sort(), [2, 3, 3], '新增一个汽油配额与种子配额都可使用');
    assert.equal(t.f.client.writes.length, 4);
    policy.refillAfterLoss = true;
    await run(t); await run(t);
    assert.deepEqual(state.fields.map(field => field.type).sort(), [2, 3, 3, 3]);
    assert.equal(t.f.client.writes.length, 5);
    policy.refillAfterLoss = false;
    policy.quotas.fuel = 4;
    state.mapFields.push({ gridIdx: 25, cityId: 2, resType: 3 });
    await run(t);
    assert.equal(state.fields.filter(field => field.type === 3).length, 4, '再次关闭后不会沿用已补齐的旧缺口');
  });
  await test('城市失守且原田仍在列表时可独立关闭或开启替换', async () => {
    for (const refillAfterLoss of [false, true]) {
      const t = setup(), state = t.f.state;
      Object.assign(automatic(t), { refillAfterLoss });
      state.maxNum = 1;
      state.fields = [{ gridIdx: 10, cityId: 1, type: 3 }];
      t.f.occupyImmediately = true;
      await run(t);
      state.cities.find(city => city.id === 1).guildIdx = 8;
      await run(t); await run(t);
      const writes = t.f.client.writes.map(({ name, body }) => [name, body.resFieldGridIdx]);
      assert.deepEqual(writes, refillAfterLoss ? [['GiveUpResFieldRequest', 10], ['ChallengeResFieldRequest', 20]] : []);
      assert.deepEqual(state.fields.map(field => field.gridIdx), [refillAfterLoss ? 20 : 10]);
      if (!refillAfterLoss) {
        state.maxNum = 2;
        await run(t);
        assert.deepEqual(state.fields.map(field => field.gridIdx), [10, 20], '失效田仍占一个位置，新增名额可以使用');
        state.fields = state.fields.filter(field => field.gridIdx !== 10);
        state.mapFields.push({ gridIdx: 23, cityId: 2, resType: 3 });
        await run(t);
        assert.deepEqual(state.fields.map(field => field.gridIdx), [20], '原田从列表移除后，继续保留其失守名额');
        state.maxNum = 3;
        await run(t);
        assert.deepEqual(state.fields.map(field => field.gridIdx), [20, 23], '同一块田从失效到移除只计一次');
      }
    }
  });
  await test('失守的同一格重新出现在本人列表后恢复该类型的正常名额', async () => {
    const t = setup(), state = t.f.state;
    const policy = Object.assign(automatic(t), { refillAfterLoss: false, allocationMode: 'quota', quotas: { fuel: 1, seeds: 0, tech: 0 } });
    const original = { gridIdx: 10, cityId: 1, type: 3 };
    state.fields = [original];
    await run(t); state.fields = []; await run(t);
    assert.equal(t.f.client.writes.length, 0);
    state.fields = [original];
    policy.quotas.fuel = 2;
    await run(t);
    assert.deepEqual(t.f.client.writes.map(w => w.body.resFieldGridIdx), [20]);
  });
  await test('当天已占领并归队后失守，开启补位的只读预览和实际派遣都选原高级田', async () => {
    const t = setup(), policy = automatic(t);
    policy.refillAfterLoss = false; t.f.state.maxNum = 1;
    await run(t); t.f.finish(10, true); await run(t);
    assert.deepEqual(t.f.state.fields.map(field => field.gridIdx), [10]);
    assert.equal(t.ledger.confirmedCounters().resourceFieldPetrol, 300);
    t.f.state.fields = [];
    await run(t);
    assert.equal(t.f.client.writes.length, 1);
    policy.refillAfterLoss = true;
    const before = fs.readFileSync(t.file);
    const p = await previewResourceFieldPlan(t.f.client, t.f.protocol, t.f.config, t.f.player, t.options);
    assert.deepEqual(fs.readFileSync(t.file), before, '预览不清理或改写已结算记录与失守记录');
    assert.equal(p.actions.length, 1); assert.match(p.actions[0].label, /（10）/);
    assert.equal(t.f.client.writes.length, 1);
    await run(t); await run(t);
    assert.deepEqual(t.f.client.writes.map(write => [write.name, write.body.resFieldGridIdx]),
      [['ChallengeResFieldRequest', 10], ['ChallengeResFieldRequest', 10]]);
    t.f.finish(10, true); await run(t);
    assert.equal(t.f.client.writes.length, 2);
    assert.equal(t.ledger.confirmedCounters().resourceFieldPetrol, 600);
    assert.equal(t.f.state.fuel, 5400);
  });
  await test('两块同类田失效且配额降到一块时只换回一块有效田', async () => {
    const t = setup(), state = t.f.state;
    const policy = Object.assign(automatic(t), { refillAfterLoss: true, allocationMode: 'quota', quotas: { fuel: 2, seeds: 0, tech: 0 } });
    state.maxNum = 2; state.fuel = 0;
    state.mapFields.push({ gridIdx: 23, cityId: 2, resType: 3 }, { gridIdx: 13, cityId: 1, resType: 3 });
    state.fields = [20, 23].map(gridIdx => ({ gridIdx, cityId: 2, type: 3 }));
    t.f.occupyImmediately = true;
    await run(t);
    state.cities.find(city => city.id === 2).guildIdx = 8;
    policy.quotas.fuel = 1; state.fuel = 6000;
    await run(t); await run(t); await run(t);
    assert.deepEqual(t.f.client.writes.map(write => write.name), ['GiveUpResFieldRequest', 'ChallengeResFieldRequest']);
    assert.equal(state.fields.filter(field => field.cityId === 1).length, 1);
    assert.equal(state.fields.filter(field => field.cityId === 2).length, 1);
  });
  await test('原有空位或新增配额可用时，关闭补位会跳过等级最高的失守旧格', async () => {
    for (const initialQuota of [1, 2]) {
      const t = setup(), state = t.f.state;
      const policy = Object.assign(automatic(t), { refillAfterLoss: false, allocationMode: 'quota', quotas: { fuel: initialQuota, seeds: 0, tech: 0 } });
      state.fields = [{ gridIdx: 10, cityId: 1, type: 3 }];
      state.fuel = 0; t.f.occupyImmediately = true;
      await run(t);
      state.fields = [];
      state.fuel = 6000;
      await run(t);
      policy.quotas.fuel = 2;
      await run(t); await run(t); await run(t);
      assert.deepEqual(t.f.client.writes.map(w => [w.name, w.body.resFieldGridIdx]), [['ChallengeResFieldRequest', 20]]);
      assert.deepEqual(state.fields.map(field => field.gridIdx), [20]);
      policy.refillAfterLoss = true;
      await run(t);
      assert.deepEqual(state.fields.map(field => field.gridIdx), [20, 10]);
    }
  });
  await test('主动放弃已记录的田不计入失守，关闭失守补位也可继续按目标派遣', async () => {
    const t = setup();
    Object.assign(automatic(t), { refillAfterLoss: false });
    t.f.state.maxNum = 1; t.f.state.fields = [{ gridIdx: 10, cityId: 1, type: 3 }];
    await run(t);
    const result = await giveUp(t, await giveUpPreview(t, 10));
    assert.equal(result.status, 'confirmed');
    await run(t);
    assert.deepEqual(t.f.client.writes.map(write => write.name), ['GiveUpResFieldRequest', 'ChallengeResFieldRequest']);
  });
  await test('没有参与舰队时预览仍显示依据实际容量与比例算出的三个目标', async () => {
    const t = setup();
    Object.assign(automatic(t), { ratios: { fuel: 0, seeds: 1, tech: 3 }, fleetIds: [] });
    const p = await previewResourceFieldPlan(t.f.client, t.f.protocol, t.f.config, t.f.player, t.options);
    assert.equal(p.actions.length, 0); assert(p.notes.some(line => /上限 5 块.*汽油 0 块、种子 1 块、科技点 4 块/.test(line)));
  });
  await test('多轮按相对比例填满实际名额，零权重跳过、余下名额归高权重', async () => {
    const t = setup(); automatic(t).ratios = { fuel: 0, seeds: 1, tech: 2 };
    t.f.state.maxNum = 4; t.f.occupyImmediately = true;
    t.f.state.mapFields.push({ gridIdx: 23, cityId: 2, resType: 1 });
    for (let i = 0; i < 5; i++) await run(t);
    assert.deepEqual(t.f.state.fields.map(f => f.type).sort(), [1, 1, 1, 2]);
    assert.equal(t.f.client.writes.length, 4);
  });
  await test('出征后归队未占领时暂停当日自动化，不能换格无限撞守军', async () => {
    const t = setup(); automatic(t); await run(t); t.f.finish(10, false);
    await run(t); await run(t); assert.equal(t.f.client.writes.length, 1);
    const state = await read(t); assert.equal(state.count, 0); assert.equal(state.pending.length, 0);
  });
  await test('合服前世界关闭时段停止派遣', async () => {
    const t = setup(); automatic(t); t.f.state.merge.worldIds = [1001001, 1001002];
    t.f.state.merge.executeTs = Math.floor(Date.now() / 1000) + 1800;
    await run(t); assert.equal(t.f.client.writes.length, 0);
  });
  await test('自动化关闭且不刷新资源田页面，公共结算仍释放手动占田返航锁', async () => {
    const t = setup(); assert.equal(t.settings.resourceFields.enabled, false);
    await send(t, await preview(t)); t.f.finish(10, true);
    const before = t.f.client.reads.length;
    const changes = await checkFleetSettlement(t.f.client, t.f.player, t.ledger);
    assert(changes.length > 0);
    assert.deepEqual(t.f.client.reads.slice(before).map(row => row.name).sort(), ['MyFleetsRequest', 'MyResFieldsRequest']);
    const record = t.ledger.keyRecords()['resource-field:1001001:10'];
    assert.equal(record.details.active, false); assert.equal(record.details.occupied, true);
    assert(Number.isSafeInteger(record.details.returnedAt)); assert.equal(record.confirmed, true);
    assert.equal(t.ledger.confirmedCounters().resourceFieldPetrol, 300);
    assert.equal(fleetRecordReason(t.ledger.keyRecords(), '1远征船', '1001001'), '');
    assert.equal(outstandingFleets(t.ledger.keyRecords(), '1001001').length, 0);
    assert.equal(t.f.client.writes.length, 1);
  });
  await test('公共结算保留返航未占的当日记录，不触发自动重复出征', async () => {
    const t = setup(); await send(t, await preview(t)); t.f.finish(10, false);
    await checkFleetSettlement(t.f.client, t.f.player, t.ledger);
    const record = t.ledger.keyRecords()['resource-field:1001001:10'];
    assert.equal(record.details.active, false); assert.equal(record.details.occupied, false);
    automatic(t); await run(t); assert.equal(t.f.client.writes.length, 1);
  });
  await test('公共结算遇未知占田且舰队空闲，跨日仍保留预算和占用', async () => {
    const t = setup(); t.f.unknown = true; await send(t, await preview(t));
    t.f.client.serverClockOffsetMs += 86400000;
    const changes = await checkFleetSettlement(t.f.client, t.f.player, t.ledger);
    assert.equal(changes.length, 0); assert.equal(pendingPetrol(t.ledger), 300);
    const record = t.ledger.keyRecords()['resource-field:1001001:10'];
    assert.equal(record.confirmed, false); assert.equal(record.details.active, true);
  });
  await test('公共结算能补认目标行军及最终本人占领，不能用其他目标确认', async () => {
    const t = setup(); t.f.unknown = true; await send(t, await preview(t));
    Object.assign(t.f.state.fleets[0], { state: 2, targetGridIdx: 20 });
    await checkFleetSettlement(t.f.client, t.f.player, t.ledger);
    assert.equal(t.ledger.keyRecords()['resource-field:1001001:10'].confirmed, false);
    t.f.state.fleets[0].targetGridIdx = 10;
    await checkFleetSettlement(t.f.client, t.f.player, t.ledger);
    assert.equal(t.ledger.keyRecords()['resource-field:1001001:10'].confirmed, true);
    t.f.finish(10, true); await checkFleetSettlement(t.f.client, t.f.player, t.ledger);
    assert.equal(t.ledger.keyRecords()['resource-field:1001001:10'].details.active, false);
    const u = setup(); u.f.unknown = true; await send(u, await preview(u)); u.f.finish(10, true);
    await checkFleetSettlement(u.f.client, u.f.player, u.ledger);
    assert.equal(u.ledger.keyRecords()['resource-field:1001001:10'].confirmed, true);
    assert.equal(u.ledger.keyRecords()['resource-field:1001001:10'].details.active, false);
  });
  await test('公共结算缺资源田快照或收到重复格子不能误释放已确认出征', async () => {
    for (const response of [{}, { info: {} }, { info: { fields: [{ gridIdx: 10, cityId: 1, type: 3 }, { gridIdx: 10, cityId: 1, type: 3 }] } }]) {
      const t = setup(); await send(t, await preview(t)); t.f.finish(10, true);
      t.f.beforeRead = name => name === 'MyResFieldsRequest' ? response : undefined;
      await checkFleetSettlement(t.f.client, t.f.player, t.ledger);
      assert.equal(t.ledger.keyRecords()['resource-field:1001001:10'].details.active, true);
    }
  });
  await test('资源田公共结算不串世界，迟到快照不释放新记录', async () => {
    const t = setup(); await send(t, await preview(t)); t.f.finish(10, true);
    const key = 'resource-field:1001001:10', baseline = t.ledger.keyRecords();
    const before = t.f.client.reads.length;
    await checkFleetSettlement(t.f.client, { ...t.f.player, worldId: '2001001' }, t.ledger);
    assert.equal(t.f.client.reads.length, before); assert.equal(t.ledger.keyRecords()[key].details.active, true);
    const changed = { ...baseline, [key]: { ...baseline[key], id: 'older-reservation' } };
    assert.deepEqual(settleFleetSnapshot(t.ledger, { worldId: '1001001', fleets: t.f.state.fleets,
      resourceFields: t.f.state.fields, now: Math.floor(Date.now() / 1000), baseline: changed }), []);
    assert.equal(t.ledger.keyRecords()[key].details.active, true);
  });
  await test('总览读取期间新增的派遣记录不能被此前快照确认', async () => {
    const t = setup(); let added = false;
    t.f.beforeRead = name => {
      if (name === 'MyResFieldsRequest' && !added) {
        added = true;
        t.ledger.reserve({ resourceFieldPetrol: 300 }, {}, {}, { uniqueKey: 'resource-field:1001001:10', details: {
          kind: 'resourceFieldDispatch', worldId: '1001001', buildingId: '1远征船', gridIdx: 10, active: true,
        } });
        Object.assign(t.f.state.fleets[0], { state: 2, targetGridIdx: 10 });
      }
    };
    await read(t);
    assert.equal(t.ledger.keyRecords()['resource-field:1001001:10'].confirmed, false);
    t.f.beforeRead = null; await read(t);
    assert.equal(t.ledger.keyRecords()['resource-field:1001001:10'].confirmed, true);
  });
  await test('满额手动替换先确认旧田移除再派遣，新旧产量明确，跨资源也可选择', async () => {
    for (const grid of [10, 11]) {
      const t = replacing(), p = await replacePreview(t, grid);
      assert.equal(p.replaceGridIdx, 20); assert.equal(p.replacement.grid, 20);
      assert.equal(p.replacement.effectivePerHour, 540); assert.equal(p.perHour, 780);
      assert.equal(p.resourceId, grid === 10 ? '汽油' : '种子'); assert.equal(p.level, 8);
      const result = await send(t, p); assert.equal(result.status, 'confirmed'); assert.equal(result.released, true); assert.equal(result.partial, false);
      assert.deepEqual(t.f.client.writes.map(write => [write.name, write.body.resFieldGridIdx]), [['GiveUpResFieldRequest', 20], ['ChallengeResFieldRequest', grid]]);
      assert.equal(t.f.state.fields.length, 0); assert.equal(t.ledger.confirmedCounters().resourceFieldPetrol, 300);
      assert.equal(t.ledger.hasKey('resource-field-replace:1001001:20'), false);
      await assert.rejects(() => send(t, p)); assert.equal(t.f.client.writes.length, 2);
    }
  });
  await test('替换旧田必须是不同且本人已占的田，未知收益不默认允许', async () => {
    const t = replacing(); await assert.rejects(() => replacePreview(t, 10, 10), /旧田/);
    assert((await replacePreview(t, 10, 30)).fleets.every(row => !row.available));
    t.f.state.cities = t.f.state.cities.filter(row => row.id !== 2);
    assert((await replacePreview(t)).fleets.every(row => !row.available));
    assert.equal(t.f.client.writes.length, 0);
  });
  await test('自动升级替换已满的低级田，手动确认中的旧田不能被客户端换掉', async () => {
    const t = replacing(), p = await replacePreview(t); automatic(t);
    await assert.rejects(() => send(t, { ...p, replaceGridIdx: 21 }), /失效/);
    const planned = await previewResourceFieldPlan(t.f.client, t.f.protocol, t.f.config, t.f.player, t.options);
    assert.match(planned.actions[0].label, /替换旧田 20/); assert.equal(t.f.client.writes.length, 0);
    assert.equal((await run(t))[0].status, 'confirmed');
    assert.deepEqual(t.f.client.writes.map(w => w.body.resFieldGridIdx), [20, 10]);
    t.f.finish(10, true); await run(t); assert.equal(t.f.client.writes.length, 2);
  });
  await test('种子不足时按配额替换超额汽油，同级汽油也能换种子', async () => {
    const t = replacing(); t.f.state.fields = [{ gridIdx: 10, cityId: 1, type: 3 }];
    Object.assign(automatic(t), { allocationMode: 'quota', quotas: { fuel: 0, seeds: 1, tech: 0 } });
    await run(t); assert.deepEqual(t.f.client.writes.map(w => w.body.resFieldGridIdx), [10, 11]);
    t.f.finish(11, true); await run(t); assert.equal(t.f.client.writes.length, 2);
  });
  await test('在途计入固定配额；旧账本只留格子、所属城市易主也不多派', async () => {
    const t = setup();
    Object.assign(automatic(t), { fleetIds: ['1远征船','2远征船'], allocationMode: 'quota', quotas: { fuel: 1, seeds: 0, tech: 0 } });
    await run(t);
    const key = 'resource-field:1001001:10', { resourceId, ...details } = t.ledger.keyRecords()[key].details;
    assert.equal(resourceId, '汽油'); t.ledger.updateKeyDetails(key, details);
    t.f.state.cities[0].guildIdx = 8;
    await run(t); assert.equal(t.f.client.writes.length, 1);
  });
  await test('高等级田超出舰队战力时占下一级，战力不足以升级时保留旧田', async () => {
    const t = setup(); automatic(t).refillAfterLoss = false; t.f.state.maxNum = 1;
    t.f.config.tables['1_ResFieldTypeCfg'].data.find(r => r.type === 3 && r.level === 1).suggestPower = 300000;
    await run(t); assert.deepEqual(t.f.client.writes.map(w => w.body.resFieldGridIdx), [20]);
    t.f.finish(20, true); await run(t); assert.equal(t.f.client.writes.length, 1);
    t.f.state.fleets[0].power = 350000; await run(t);
    assert.deepEqual(t.f.client.writes.map(w => w.body.resFieldGridIdx), [20, 20, 10]);
  });
  await test('固定配额达标时即使有空位也保持数量，只替换更低级的同类田', async () => {
    const t = replacing(); t.f.state.maxNum = 5;
    Object.assign(automatic(t), { allocationMode: 'quota', quotas: { fuel: 1, seeds: 0, tech: 0 } });
    await run(t); t.f.finish(10, true); await run(t);
    assert.deepEqual(t.f.client.writes.map(w => w.body.resFieldGridIdx), [20, 10]);
    assert.equal(t.f.state.fields.length, 1);
  });
  await test('配额超过总容量且无多占类型时不为其他类型来回换田，同级也不换', async () => {
    const t = replacing(); t.f.state.fields = [{ gridIdx: 10, cityId: 1, type: 3 }];
    t.f.state.mapFields.push({ gridIdx: 13, cityId: 1, resType: 3 });
    Object.assign(automatic(t), { allocationMode: 'quota', quotas: { fuel: 1, seeds: 1, tech: 0 } });
    await run(t); assert.equal(t.f.client.writes.length, 0);
  });
  await test('自动替换放弃前重读，守军或耐久不再符合时保留旧田', async () => {
    const t = replacing(); automatic(t); let reads = 0;
    t.f.beforeRead = name => {
      if (name === 'MyResFieldsRequest' && ++reads === 3) t.f.state.fleets[0].durability = 1;
    };
    assert.equal((await run(t))[0].status, 'cancelled');
    assert.equal(t.f.client.writes.length, 0); assert.equal(t.f.state.fields[0].gridIdx, 20);
  });
  await test('自动替换确认旧田已放弃后再次检查配额，新田已达标不继续派遣', async () => {
    const t = replacing(); t.f.state.maxNum = 3;
    Object.assign(automatic(t), { allocationMode: 'quota', quotas: { fuel: 1, seeds: 0, tech: 0 } });
    t.f.afterWrite = name => { if (name === 'GiveUpResFieldRequest') t.f.state.fields.push({ gridIdx: 31, cityId: 2, type: 3 }); };
    const result = (await run(t))[0]; assert.equal(result.status, 'cancelled'); assert.equal(result.released, true);
    assert.deepEqual(t.f.client.writes.map(w => w.body.resFieldGridIdx), [20]);
  });
  await test('替换前实时阻止归属、舰队、汽油与新旧收益恶化，旧田完整保留', async () => {
    for (const change of [
      t => { t.f.state.cities[0].guildIdx = 8; },
      t => { t.f.state.fleets[0].state = 3; },
      t => { t.f.state.fuel = 1; },
      t => { t.f.config.tables.WorldParamCfg.data[0].paramValue = 301; },
      t => { t.f.config.tables['1_ResFieldTypeCfg'].data.find(row => row.type === 3 && row.level === 8).product[1] = 779; },
      t => { t.f.config.tables['1_ResFieldTypeCfg'].data.find(row => row.type === 3 && row.level === 4).product[1] = 541; },
    ]) {
      const t = replacing(), p = await replacePreview(t); change(t);
      await assert.rejects(() => send(t, p)); assert.equal(t.f.client.writes.length, 0); assert.equal(t.f.state.fields[0].gridIdx, 20);
    }
    const t = replacing(); t.f.state.cities[1].guildIdx = 8; const p = await replacePreview(t);
    assert.equal(p.replacement.effectivePerHour, 0); t.f.state.cities[1].guildIdx = 7;
    await assert.rejects(() => send(t, p), /损失增加/); assert.equal(t.f.client.writes.length, 0);
  });
  await test('建立替换锁后再次检查旧田，迟到旧预览不会重复放弃', async () => {
    const t = replacing(), p = await replacePreview(t); let reads = 0;
    t.f.beforeRead = name => { if (name === 'MyResFieldsRequest' && ++reads === 2) t.f.state.fields = []; };
    const result = await send(t, p); assert.equal(result.status, 'cancelled'); assert.equal(result.released, false);
    assert.equal(t.f.client.writes.length, 0); assert.equal(Object.keys(t.ledger.keyRecords()).length, 0);
  });
  await test('放弃明确拒绝时不出征，取消原子旧田锁和未花汽油', async () => {
    const t = replacing(), p = await replacePreview(t); t.f.rejectRequest = 'GiveUpResFieldRequest';
    const result = await send(t, p); assert.equal(result.status, 'rejected'); assert.equal(result.released, false);
    assert.deepEqual(t.f.client.writes.map(write => write.name), ['GiveUpResFieldRequest']);
    assert.equal(t.f.state.fields[0].gridIdx, 20); assert.equal(pendingPetrol(t.ledger), 0); assert.equal(t.ledger.snapshot().uncertain, 0);
  });
  await test('放弃未知跨账本重载仍锁同一旧田、舰队和名额，不换新目标重发', async () => {
    const t = replacing(), p = await replacePreview(t); t.f.unknownRequest = 'GiveUpResFieldRequest';
    const result = await send(t, p); assert.equal(result.status, 'unknown'); assert.equal(result.released, false);
    assert.equal(pendingPetrol(t.ledger), 300); assert.equal(t.f.state.fields[0].gridIdx, 20);
    t.options.ledger = t.createLedger(); assert((await replacePreview(t, 11)).fleets.every(row => !row.available));
    await checkFleetSettlement(t.f.client, t.f.player, t.options.ledger);
    assert.equal(t.options.ledger.keyRecords()['resource-field:1001001:10'].confirmed, false);
    automatic(t); await run(t); assert.equal(t.f.client.writes.length, 1);
    assert.equal((await read(t)).remaining, 0);
  });
  await test('已结束放弃未知后来确认旧田消失可恢复，留下partial提示且不自动续发', async () => {
    const t = replacing(), p = await replacePreview(t); t.f.unknownRequest = 'GiveUpResFieldRequest'; await send(t, p);
    t.f.state.fields = []; const state = await read(t);
    assert.equal(pendingPetrol(t.ledger), 0); assert.equal(state.remaining, 1);
    assert.equal(t.ledger.hasKey('resource-field-replace:1001001:20'), false);
    assert.equal(t.ledger.hasKey('resource-field:1001001:10'), false);
    assert(state.notes.some(note => /旧田 20 已放弃.*未继续/.test(note)));
    automatic(t); await run(t); assert.equal(t.f.client.writes.length, 1);
    assert((await preview(t)).fleets.some(row => row.available));
  });
  await test('放弃执行中并发概览与公共结算不能释放事务或误认占领', async () => {
    const t = replacing(), p = await replacePreview(t);
    t.f.afterWrite = async name => {
      if (name !== 'GiveUpResFieldRequest') return;
      await read(t); await checkFleetSettlement(t.f.client, t.f.player, t.ledger);
      const record = t.ledger.keyRecords()['resource-field:1001001:10'];
      assert.equal(record.details.phase, 'givingUp'); assert.equal(record.confirmed, false);
      assert.equal(record.details.active, true); assert.equal(pendingPetrol(t.ledger), 300);
    };
    assert.equal((await send(t, p)).status, 'confirmed'); assert.equal(t.f.client.writes.length, 2);
  });
  await test('放弃确认后出征明确拒绝返回partial，汽油未花且旧田不假恢复', async () => {
    const t = replacing(), p = await replacePreview(t); t.f.rejectRequest = 'ChallengeResFieldRequest';
    const result = await send(t, p); assert.equal(result.status, 'rejected'); assert.equal(result.released, true); assert.equal(result.partial, true);
    assert.match(result.reason, /旧田已放弃.*未出征/); assert.equal(t.f.state.fields.length, 0); assert.equal(t.f.state.fuel, 6000);
    assert.equal(pendingPetrol(t.ledger), 0); assert.equal(t.ledger.hasKey('resource-field-replace:1001001:20'), false);
    automatic(t); await run(t); assert.equal(t.f.client.writes.length, 2);
  });
  await test('放弃确认后出征未知持续保留锁，空闲和旧田消失不能核销派遣', async () => {
    const t = replacing(), p = await replacePreview(t); t.f.unknownRequest = 'ChallengeResFieldRequest';
    const result = await send(t, p); assert.equal(result.status, 'unknown'); assert.equal(result.released, true); assert.equal(result.partial, true);
    t.f.client.serverClockOffsetMs += 86400000; await read(t); await checkFleetSettlement(t.f.client, t.f.player, t.ledger);
    assert.equal(t.ledger.keyRecords()['resource-field:1001001:10'].details.phase, 'dispatching');
    assert.equal(pendingPetrol(t.ledger), 300); assert.equal((await read(t)).remaining, 0);
    assert.equal(t.f.client.writes.length, 2);
  });
  await test('放弃后舰队、库存、容量变化会停止出征并报告partial', async () => {
    for (const change of [
      t => { t.f.state.fleets[0].state = 3; }, t => { t.f.state.fuel = 0; },
      t => { t.f.state.maxNum = 0; }, t => { t.f.state.cities[0].guildIdx = 8; },
    ]) {
      const t = replacing(), p = await replacePreview(t);
      t.f.afterWrite = name => { if (name === 'GiveUpResFieldRequest') change(t); };
      const result = await send(t, p); assert.equal(result.ok, false); assert.equal(result.released, true); assert.equal(result.partial, true);
      assert.equal(t.f.client.writes.length, 1); assert.equal(t.f.state.fields.length, 0); assert.equal(pendingPetrol(t.ledger), 0);
    }
  });
  await test('放弃后的读回期间切身份不能用新角色空列表确认旧田已放弃', async () => {
    const t = replacing(), p = await replacePreview(t);
    t.f.beforeRead = name => {
      if (name === 'MyResFieldsRequest' && t.f.client.writes.some(write => write.name === 'GiveUpResFieldRequest')) {
        t.f.player.playerId = '9007199254999999'; return { info: { fields: [], maxNum: 10 } };
      }
    };
    const result = await send(t, p); assert.equal(result.status, 'unknown'); assert.equal(result.released, false);
    assert.match(result.reason, /放弃结果待确认.*尚未出征新田/); assert.equal(t.f.client.writes.length, 1);
    assert.equal(pendingPetrol(t.ledger), 300); assert.equal(t.ledger.hasKey('resource-field-replace:1001001:20'), true);
    assert.equal(t.ledger.keyRecords()['resource-field:1001001:10'].details.phase, 'givingUp');
  });
  await test('放弃后配置代次改变先保留未知，后续同账号读取可恢复未出征记录', async () => {
    const t = replacing(); let settings = t.settings; t.options.getSettings = () => settings;
    const p = await replacePreview(t); t.f.afterWrite = name => { if (name === 'GiveUpResFieldRequest') settings = { ...t.settings }; };
    const result = await send(t, p); assert.equal(result.status, 'unknown'); assert.equal(result.released, false);
    assert.equal(t.f.client.writes.length, 1); assert.equal(pendingPetrol(t.ledger), 300);
    const state = await read(t); assert.equal(state.remaining, 1); assert.equal(pendingPetrol(t.ledger), 0);
  });
  await test('主记录预留失败时取消先建立的旧田原子锁，不留下幽灵占用', async () => {
    const t = replacing(), p = await replacePreview(t), base = t.ledger;
    t.options.ledger = { ...base, reserve: (...args) => {
      if (args[3]?.uniqueKey === 'resource-field:1001001:10') throw Error('模拟主记录预留失败');
      return base.reserve(...args);
    } };
    await assert.rejects(() => send(t, p), /预留失败/);
    assert.equal(t.f.client.writes.length, 0); assert.equal(Object.keys(base.keyRecords()).length, 0);
    base.reserve({}, {}, {}, { uniqueKey: 'resource-field-replace:1001001:20', details: { replacementLock: true,
      worldId: '1001001', targetKey: 'resource-field:1001001:10', leaseUntil: Math.floor(Date.now() / 1000) + 120 } });
    await read(t); assert.equal(base.hasKey('resource-field-replace:1001001:20'), true);
    t.f.client.serverClockOffsetMs += 121000; await read(t);
    assert.equal(base.hasKey('resource-field-replace:1001001:20'), false);
  });
  await test('长时间读取跨过替换租期不继续出征，已放弃部分明确可见', async () => {
    const t = replacing(), p = await replacePreview(t);
    t.f.afterWrite = name => { if (name === 'GiveUpResFieldRequest') t.f.client.serverClockOffsetMs += 121000; };
    const result = await send(t, p); assert.equal(result.released, true); assert.equal(result.partial, true);
    assert.equal(result.status, 'cancelled'); assert.equal(t.f.client.writes.length, 1); assert.equal(pendingPetrol(t.ledger), 0);
  });
  await test('并发恢复取消本记录或旧锁后执行器不能无账本继续发出挑战', async () => {
    const t = replacing(), p = await replacePreview(t);
    t.f.afterWrite = name => {
      if (name !== 'GiveUpResFieldRequest') return;
      const current = t.ledger.keyRecords()['resource-field:1001001:10'];
      t.ledger.cancel({ id: current.id }); t.ledger.cancel({ id: current.details.replacement.lock.id });
    };
    const result = await send(t, p); assert.equal(result.released, true); assert.equal(result.partial, true);
    assert.equal(t.f.client.writes.length, 1); assert.equal(pendingPetrol(t.ledger), 0);
  });
  await test('单个放弃只需要本人田地，不要求汽油、闲队、地图、雷达或世界开放等级', async () => {
    const t = replacing(); t.f.state.fuel = 0; t.f.state.fleets = []; t.f.state.buildings = [];
    t.f.player.level = 1; t.options.mapLoader = async () => { throw Error('地图不可用'); };
    const p = await giveUpPreview(t); assert.equal(p.kind, 'giveUp'); assert.equal(p.available, true); assert.equal(p.cost, 0);
    assert.equal(p.field.grid, 20); assert.equal(p.field.effectivePerHour, 540);
    assert.equal(t.f.client.writes.length, 0);
    assert.equal((await giveUp(t, p)).status, 'confirmed'); assert.equal(t.f.state.fields.length, 0);
    assert.deepEqual(t.f.client.writes.map(write => [write.name, write.body.resFieldGridIdx]), [['GiveUpResFieldRequest', 20]]);
    assert(t.f.client.reads.every(read => ['MyResFieldsRequest', 'AllGuildAbstractionRequest', 'WorldInfoRequest'].includes(read.name)));
    assert.equal(pendingPetrol(t.ledger), 0);
  });
  await test('单个放弃允许未知产量明确确认，但未知变已同步或损失增加须重新预览', async () => {
    const t = replacing(); t.f.config.tables['1_ResFieldTypeCfg'].data = [];
    t.f.beforeRead = name => name === 'WorldInfoRequest' ? {} : undefined;
    const p = await giveUpPreview(t); assert.equal(p.available, true); assert.equal(p.field.perHour, null);
    assert.equal((await giveUp(t, p)).status, 'confirmed');
    const u = replacing(); u.f.beforeRead = name => name === 'WorldInfoRequest' ? {} : undefined;
    const unknown = await giveUpPreview(u); assert.equal(unknown.field.effectivePerHour, null); u.f.beforeRead = null;
    await assert.rejects(() => giveUp(u, unknown), /损失已变化/); assert.equal(u.f.client.writes.length, 0);
    const v = replacing(), known = await giveUpPreview(v);
    v.f.config.tables['1_ResFieldTypeCfg'].data.find(row => row.type === 3 && row.level === 4).product[1]++;
    await assert.rejects(() => giveUp(v, known), /损失已变化/); assert.equal(v.f.client.writes.length, 0);
  });
  await test('单个放弃仅本人当前格，自动化调用及旧田身份变化均零写入', async () => {
    const t = replacing(); assert.equal((await giveUpPreview(t, 10)).available, false);
    const p = await giveUpPreview(t);
    await assert.rejects(() => giveUp({ ...t, options: { ...t.options, automatic: true } }, p), /只在替换时放弃/);
    t.f.state.fields[0].type = 2;
    await assert.rejects(() => giveUp(t, p), /类型已变化/); assert.equal(t.f.client.writes.length, 0);
  });
  await test('单个放弃拒绝释放旧锁，未知跨日重载保持且不误称成功', async () => {
    const t = replacing(), p = await giveUpPreview(t); t.f.rejectRequest = 'GiveUpResFieldRequest';
    const refused = await giveUp(t, p); assert.equal(refused.status, 'rejected'); assert.equal(refused.released, false);
    assert.equal(Object.keys(t.ledger.keyRecords()).length, 0);
    t.f.rejectRequest = null; t.f.unknownRequest = 'GiveUpResFieldRequest';
    const unknown = await giveUp(t, p); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.released, false);
    t.f.client.serverClockOffsetMs += 86400000; t.options.ledger = t.createLedger();
    assert.equal((await giveUpPreview(t)).available, false); assert.equal((await giveUp(t, p)).status, 'unknown');
    assert.equal(t.f.client.writes.length, 2); assert.equal((await read(t)).owned[0].giveUpReason.length > 0, true);
    assert.equal(t.options.ledger.hasKey('resource-field-replace:1001001:20'), true);
  });
  await test('单个放弃和替换共享旧田锁，预先获取的另一个确认不能绕过未知操作', async () => {
    for (const first of ['giveUp', 'replace']) {
      const t = replacing(), p = await giveUpPreview(t), replacement = await replacePreview(t);
      t.f.unknownRequest = 'GiveUpResFieldRequest';
      if (first === 'giveUp') { await giveUp(t, p); await assert.rejects(() => send(t, replacement)); }
      else { await send(t, replacement); await assert.rejects(() => giveUp(t, p)); }
      assert.equal(t.f.client.writes.length, 1);
    }
  });
  await test('单个放弃未知后真实移除由总览确认，成功后正常恢复已保存自动占领策略', async () => {
    const t = replacing(), p = await giveUpPreview(t); t.f.unknownRequest = 'GiveUpResFieldRequest'; await giveUp(t, p);
    const key = Object.keys(t.ledger.keyRecords()).find(key => key.startsWith('resource-field-giveup:'));
    t.f.state.fields = []; t.f.unknownRequest = null; const state = await read(t);
    assert.equal(t.ledger.keyRecords()[key].confirmed, true); assert.equal(t.ledger.hasKey('resource-field-replace:1001001:20'), false);
    assert.equal(state.remaining, 1); assert.equal(state.autoStopReason, '');
    automatic(t); await run(t); assert.equal(t.f.client.writes[1].name, 'ChallengeResFieldRequest');
  });
  await test('同格重新拥有后新预览可再次放弃，旧预览永久返回旧结果不再发写', async () => {
    const t = replacing(), first = await giveUpPreview(t); assert.equal((await giveUp(t, first)).status, 'confirmed');
    t.f.state.fields = [{ gridIdx: 20, cityId: 2, type: 3 }];
    assert.equal((await giveUp(t, first)).status, 'confirmed'); assert.equal(t.f.state.fields.length, 1); assert.equal(t.f.client.writes.length, 1);
    const second = await giveUpPreview(t); assert.notEqual(second.operationId, first.operationId); assert.equal(second.available, true);
    assert.equal((await giveUp(t, second)).status, 'confirmed'); assert.equal(t.f.client.writes.length, 2);
  });
  await test('单个放弃后读回切身份不核销，新角色列表不能释放旧角色未知记录', async () => {
    const t = replacing(), p = await giveUpPreview(t);
    t.f.beforeRead = name => {
      if (name === 'MyResFieldsRequest' && t.f.client.writes.length) { t.f.player.playerId = '9007199254998888'; return { info: { fields: [], maxNum: 1 } }; }
    };
    const result = await giveUp(t, p); assert.equal(result.status, 'unknown'); assert.equal(result.released, false);
    t.f.beforeRead = null; await read(t);
    const record = Object.values(t.ledger.keyRecords()).find(record => record.details?.kind === 'resourceFieldGiveUp');
    assert.equal(record.confirmed, false); assert.equal(t.ledger.hasKey('resource-field-replace:1001001:20'), true);
  });
  await test('单个放弃确认后崩溃残留旧锁可清理，原始已确认结果保持不变', async () => {
    const t = replacing(), p = await giveUpPreview(t); t.f.unknownRequest = 'GiveUpResFieldRequest'; await giveUp(t, p);
    const [key, record] = Object.entries(t.ledger.keyRecords()).find(([, record]) => record.details?.kind === 'resourceFieldGiveUp');
    t.ledger.resolveKey(key, true, { ...record.details, active: false, phase: 'completed' });
    assert.equal(t.ledger.hasKey('resource-field-replace:1001001:20'), true);
    assert.equal((await giveUpPreview(t)).available, true); assert.equal(t.ledger.hasKey('resource-field-replace:1001001:20'), false);
  });
  await test('同世界确认前角色或联盟身份原地改变，放弃、占领与替换预览都失效', async () => {
    for (const change of [t => { t.f.player.playerId = '9007199254997777'; }, t => { t.f.player.guildId = '2007'; }]) {
      const t = replacing(), p = await giveUpPreview(t), replacement = await replacePreview(t); change(t);
      await assert.rejects(() => giveUp(t, p), /失效/); await assert.rejects(() => send(t, replacement), /失效/);
      assert.equal(t.f.client.writes.length, 0);
      const u = setup(), occupying = await preview(u); change(u);
      await assert.rejects(() => send(u, occupying), /失效/); assert.equal(u.f.client.writes.length, 0);
    }
  });
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(`资源田离线验证 ${results.filter(Boolean).length}/${results.length} 通过`);
if (results.includes(false)) process.exitCode = 1;
