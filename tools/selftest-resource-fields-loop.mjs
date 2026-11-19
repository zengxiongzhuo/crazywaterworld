import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resource-field-loop-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const { resourceFieldFixture } = await import('./fixtures/resource-fields.mjs');
const { installResourceFieldMap } = await import('./fixtures/resource-field-map.mjs');
const { defaultSettings, createUsageLedger } = await import('../src/automation-settings.mjs');
const { runLoop } = await import('../src/loop.mjs');
const originalNow = Date.now, base = originalNow();
let wall = base, sequence = 0, passed = 0;
Date.now = () => wall;
const cleanups = [];
function fixture(rounds = 1) {
  const f = resourceFieldFixture(); cleanups.push(installResourceFieldMap(f));
  let settings = defaultSettings(), queue = Promise.resolve(), queued = false;
  Object.assign(settings.resourceFields, { enabled: true, fleetIds: ['1远征船', '2远征船'], reserveFleetCount: 1, checkEverySeconds: 120 });
  const ledger = createUsageLedger('loop-' + ++sequence, { file: path.join(directory, sequence + '.json') });
  const stop = { aborted: false }, sleeps = [], reports = [];
  for (const name of ['request', 'sendWatch']) {
    const original = f.client[name];
    f.client[name] = async (...args) => { assert(queued, '协议必须在同账号队列内执行'); return original(...args); };
  }
  const schedule = work => {
    const job = queue.then(async () => { assert(!queued); queued = true; try { return await work(); } finally { queued = false; } });
    queue = job.catch(() => {}); return job;
  };
  return Object.assign(f, { stop, ledger, sleeps, reports, settings: () => settings,
    replace: next => { settings = next; }, sleepHook: null, reportHook: null,
    run: async () => runLoop(f.client, f.protocol, { config: f.config, player: f.player, rounds, everyMs: 3600000,
      allowMutate: true, isEnabled: () => false, getSettings: () => settings, usageLedger: ledger, stop, schedule,
      sleep: async ms => { assert(ms > 0); sleeps.push(ms); assert(sleeps.length < 20); if (f.sleepHook) await f.sleepHook(ms); else wall += ms; },
      onStep: row => { reports.push(row); f.reportHook?.(row); } }),
    clean: () => { assert.deepEqual(reports.filter(r => r.error && !r.skipped), []); assert.equal(f.client.listenerCount('automationSettingsChanged'), 0); },
  });
}
async function test(name, body) { wall = base; await body(); passed++; console.log('通过：' + name); }
try {
  await test('基地和原生功能关闭时资源田独立执行且每轮只派一队', async () => {
    const f = fixture(); await f.run();
    assert.equal(f.client.writes.length, 1); assert.equal(f.client.writes[0].name, 'ChallengeResFieldRequest');
    assert.equal(f.ledger.confirmedCounters().resourceFieldPetrol, 300); assert(f.reports.some(r => r.taskKey === 'resourceFields.enabled')); f.clean();
  });
  await test('关闭资源田开关不读取资源田也不派遣', async () => {
    const f = fixture(); f.settings().resourceFields.enabled = false; await f.run();
    assert(!f.client.reads.some(r => r.name === 'MyResFieldsRequest')); assert.equal(f.client.writes.length, 0); f.clean();
  });
  await test('主循环休眠时按照资源田检查间隔接续派遣', async () => {
    const f = fixture(2); f.state.fuel = 0;
    f.sleepHook = ms => { wall += ms; f.state.fuel = 6000; };
    f.reportHook = () => { if (f.client.writes.length) f.stop.aborted = true; };
    await f.run(); assert.deepEqual(f.sleeps, [120000]); assert.equal(f.client.writes.length, 1); f.clean();
  });
  await test('先占可用的低级种子田，下轮发现高级种子田后在满额下换田', async () => {
    const f = fixture(2);
    f.state.maxNum = 1;
    f.occupyImmediately = true;
    Object.assign(f.settings().resourceFields, { allocationMode: 'quota', quotas: { fuel: 0, seeds: 1, tech: 0 } });
    const highCity = f.state.cities.find(city => city.id === 1);
    highCity.guildIdx = 8;
    f.sleepHook = ms => {
      assert.deepEqual(f.state.fields.map(field => field.gridIdx), [21]);
      highCity.guildIdx = 7;
      wall += ms;
    };
    f.reportHook = () => { if (f.state.fields.some(field => field.gridIdx === 11)) f.stop.aborted = true; };
    await f.run();
    assert.deepEqual(f.sleeps, [120000]);
    assert.deepEqual(f.client.writes.map(({ name, body }) => [name, body.resFieldGridIdx]), [
      ['ChallengeResFieldRequest', 21], ['GiveUpResFieldRequest', 21], ['ChallengeResFieldRequest', 11],
    ]);
    assert.deepEqual(f.state.fields.map(field => field.gridIdx), [11]);
    f.clean();
  });
  await test('保存配置唤醒关闭模块，事件本身不执行协议', async () => {
    const f = fixture(2); f.settings().resourceFields.enabled = false;
    f.sleepHook = () => { wall += 1000; const next = structuredClone(f.settings()); next.resourceFields.enabled = true; f.replace(next);
      const reads = f.client.reads.length; f.client.emit('automationSettingsChanged'); assert.equal(f.client.reads.length, reads); };
    f.reportHook = () => { if (f.client.writes.length) f.stop.aborted = true; };
    await f.run(); assert.equal(wall - base, 1000); assert.equal(f.client.writes.length, 1); f.clean();
  });
  await test('等待时关闭开关不再检查资源田，保留策略选择', async () => {
    const f = fixture(2); f.state.fuel = 0; let before;
    f.sleepHook = ms => { if (before === undefined) { wall += 1000; before = f.client.reads.filter(r => r.name === 'MyResFieldsRequest').length;
      const next = structuredClone(f.settings()); next.resourceFields.enabled = false; f.replace(next); f.state.fuel = 6000; f.client.emit('automationSettingsChanged');
    } else wall += ms; };
    await f.run(); assert.equal(f.client.reads.filter(r => r.name === 'MyResFieldsRequest').length, before);
    assert.equal(f.client.writes.length, 0); assert.deepEqual(f.settings().resourceFields.fleetIds, ['1远征船', '2远征船']); f.clean();
  });
  console.log('资源田挂机循环 ' + passed + '/' + passed + ' 通过');
} finally {
  Date.now = originalNow; for (const cleanup of cleanups) cleanup();
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cw-resource-field-loop-')) throw Error('意外测试目录');
  fs.rmSync(directory, { recursive: true, force: true });
}
