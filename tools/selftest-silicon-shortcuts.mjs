import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-silicon-shortcuts-'));
process.env.CW_DATA_DIR = directory; process.env.CW_CONFIG_PACK = path.join(directory, 'config.json'); process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const { siliconFixture } = await import('./fixtures/silicon.mjs');
const { previewSiliconShortcut, runSiliconShortcut } = await import('../src/silicon-mining.mjs');
const { defaultSettings, createUsageLedger, saveAutomationSettings } = await import('../src/automation-settings.mjs');
const { reserveDispatch } = await import('../src/fleet-availability.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
let sequence = 0, passed = 0, app;
function fixture() {
  const f = siliconFixture(); f.settings = defaultSettings();
  f.ledgerFile = path.join(directory, 'ledger-' + ++sequence + '.json');
  f.ledger = createUsageLedger('shortcut', { file: f.ledgerFile });
  f.options = { getSettings: () => f.settings, ledger: f.ledger, enabled: () => f.client.connected };
  return f;
}
const dispatch = (gridId = 5000, index = 0) => ({ kind: 'dispatch', gridId, index });
const retreat = (fleetId = '1远征船', gridId = 5000) => ({ kind: 'retreat', fleetId, gridId });
const preview = (f, intent = dispatch()) => previewSiliconShortcut(f.client, f.protocol, f.config, f.player, intent, f.options);
const run = (f, quote, fleet = '1远征船') => runSiliconShortcut(f.client, f.protocol, f.config, f.player, quote, fleet, f.options);
const test = async (name, body) => { await body(); passed++; console.log('通过：' + name); };
try {
  await test('自动化与队伍开关全关仍可手动预览，费用真实且不消耗资源', async () => {
    const f = fixture(), settings = JSON.stringify(f.settings), quote = await preview(f);
    assert.equal(quote.cost, 500); assert.equal(quote.fleets.filter(row => row.step).length, 3);
    assert.equal(quote.automatic, false); assert.deepEqual(f.client.writes, []); assert.deepEqual(f.ledger.snapshot().counters, {});
    assert.equal(JSON.stringify(f.settings), settings);
  });
  await test('只派遣选定舰队至指定空位，真实确认后计入共享汽油预算', async () => {
    const f = fixture(), quote = await preview(f, dispatch(4000, 2)), settings = JSON.stringify(f.settings);
    assert.equal((await run(f, quote, '2远征船')).status, 'confirmed');
    assert.deepEqual(f.client.writes.map(row => [row.name, row.body]), [['ChipMineSendFleetRequest', { gridId: 4000, index: 2, fleetId: '2远征船' }]]);
    assert.equal(f.ledger.confirmedCounters().siliconPetrol, 500); assert.equal(f.state.fuel, 49500);
    assert.equal(JSON.stringify(f.settings), settings);
  });
  await test('己方矿位首奖后可撤回，零费用，自动化开关保持关闭', async () => {
    const f = fixture(); f.occupy('1远征船', 5000, 1, 0);
    assert.match((await preview(f, retreat())).fleets[0].reason, /首奖/);
    f.state.positions[5000][0].player.rewardTimes = 1;
    const quote = await preview(f, retreat()); assert.equal(quote.cost, 0);
    assert.equal((await run(f, quote)).status, 'confirmed'); assert.equal(f.client.writes[0].name, 'ChipMineRetreatRequest');
    assert.equal(f.state.fuel, 50000); assert.deepEqual(f.ledger.snapshot().counters, {}); assert.equal(f.settings.silicon.enabled, false);
  });
  await test('初等矿使用个人展示空位索引，服务器稀疏占位索引也能确认并撤回', async () => {
    const f = fixture(); f.occupy('2远征船', 3000, 123, 2);
    assert((await preview(f, dispatch(3000, 0))).fleets.every(row => !row.step));
    const quote = await preview(f, dispatch(3000, 1));
    f.afterWrite = name => { if (name === 'ChipMineSendFleetRequest') f.occupy('1远征船', 3000, 345, 1); };
    assert.equal((await run(f, quote)).status, 'confirmed');
    assert.equal((await run(f, await preview(f, retreat('1远征船', 3000)))).status, 'confirmed');
  });
  await test('已占位、同盟位或本人矿位不能通过快捷派遣变成攻击', async () => {
    for (const guild of [7, 8]) {
      const f = fixture(); f.enemy(0, '占领者', 1, guild); f.settings.silicon.fleets[0].emptyOnly = false;
      const quote = await preview(f); assert(quote.fleets.every(row => !row.step)); await assert.rejects(() => run(f, quote)); assert.deepEqual(f.client.writes, []);
    }
  });
  await test('确认后矿位被占、费用上涨或舰队忙碌时不发送旧请求', async () => {
    for (const change of [f => f.enemy(0), f => { f.config.tables.WorldParamCfg.data[0].paramValue = 600; }, f => { f.state.fleets[0].state = 3; }]) {
      const f = fixture(), quote = await preview(f); change(f); await assert.rejects(() => run(f, quote)); assert.deepEqual(f.client.writes, []);
    }
  });
  await test('实际汽油、共享周期额度和自定日奖励上限仍生效', async () => {
    for (const change of [f => { f.state.fuel = 499; },
      f => { f.state.reward.myRewardTimes = 100; }, f => { f.settings.silicon.dailyRewardLimit = 3; f.state.reward.myRewardTimes = 3; }]) {
      const f = fixture(); change(f); const quote = await preview(f); assert(quote.fleets.every(row => !row.step)); assert.deepEqual(f.client.writes, []);
    }
  });
  await test('待确认汽油、其他任务锁和舰队耐久阻止误派', async () => {
    const f = fixture(); f.ledger.reserve({ radarPetrol: 49900 }); assert((await preview(f)).fleets.every(row => !row.step));
    const g = fixture(); reserveDispatch(g.client, 'maintenance', ['1远征船']); g.state.fleets[1].durability = 0;
    g.state.fleets[2].owner.playerId = '999'; assert((await preview(g)).fleets.every(row => !row.step));
  });
  await test('结果未知保留持久化费用和舰队锁，重载账本后也不能重复派遣', async () => {
    const f = fixture(); f.unknown = true; const quote = await preview(f);
    assert.equal((await run(f, quote)).status, 'unknown'); assert.equal(f.ledger.pendingCounters().siliconPetrol, 500);
    f.ledger = createUsageLedger('shortcut', { file: f.ledgerFile }); f.options.ledger = f.ledger;
    const next = await preview(f); assert.match(next.fleets[0].reason, /待确认/); await assert.rejects(() => run(f, next));
    assert.equal(f.client.writes.length, 1);
  });
  await test('明确拒绝取消预留，允许重新预览；不会假报操作成功', async () => {
    const f = fixture(); f.reject = true;
    assert.equal((await run(f, await preview(f))).status, 'rejected'); assert.equal(f.ledger.pendingCounters().siliconPetrol ?? 0, 0);
    assert.equal(f.ledger.snapshot().counters.siliconPetrol ?? 0, 0); assert((await preview(f)).fleets[0].step);
  });
  await test('明确未发出的请求退还预留，结果标为取消而非未知', async () => {
    const f = fixture(); f.client.sendWatch = async name => { throw Object.assign(Error('连接关闭，明确未发送'), { request: name, notSent: true }); };
    assert.equal((await run(f, await preview(f))).status, 'cancelled'); assert.equal(f.ledger.pendingCounters().siliconPetrol ?? 0, 0);
    assert.equal(f.ledger.snapshot().counters.siliconPetrol ?? 0, 0);
  });
  await test('手动采矿归港后预览可清理已完成锁，再次派遣，无需打开挂机', async () => {
    const f = fixture(); assert.equal((await run(f, await preview(f))).status, 'confirmed');
    f.returnFleet('1远征船'); const quote = await preview(f, dispatch(5000, 1)); assert(quote.fleets[0].step);
    assert.equal((await run(f, quote)).status, 'confirmed'); assert.equal(f.client.writes.length, 2);
  });
  await test('撤回前矿位或产奖周期发生变化必须重新确认', async () => {
    const f = fixture(); f.occupy('1远征船', 5000, 0, 2); const quote = await preview(f, retreat());
    f.state.fleets[0].chipWar.rewardTs += 900;
    await assert.rejects(() => run(f, quote), /进度已变化/); assert.deepEqual(f.client.writes, []);
  });
  await test('发送前连接失效或区服切换不消费，发送后失效保持未知', async () => {
    const f = fixture(), quote = await preview(f); f.options.enabled = () => false; await assert.rejects(() => run(f, quote)); assert.deepEqual(f.client.writes, []);
    const g = fixture(), next = await preview(g); g.afterWrite = () => { g.options.enabled = () => false; g.client.connected = false; };
    assert.equal((await run(g, next)).status, 'unknown'); assert.equal(g.ledger.pendingCounters().siliconPetrol, 500);
  });

  const f = fixture(); fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(f.config.tables).map(([name, table], i) => [i, name, table])));
  saveStore({ activeId: 'one', accounts: ['one', 'two'].map(id => ({ id, label: '快捷操作测试' + id, url: 'wss://invalid.invalid', login: {}, automation: { paused: true, enabled: false } })) });
  app = createConsole({ port: 0, protocol: f.protocol }); const base = await app.listen();
  for (const id of ['one', 'two']) await fetch(base + '/api/settings?account=' + id);
  const session = app.sessions.get('one'); session.client = f.client; session.player = f.player; session.paused = false;
  const post = (route, body, account = 'one') => fetch(base + '/api/silicon/' + route + '?account=' + account, { method: 'POST', body: JSON.stringify(body) });
  const getQuote = async () => { const res = await post('preview', dispatch()); assert(res.ok); return res.json(); };
  const payload = quote => ({ confirm: true, token: quote.token, fleetId: '1远征船' });
  await test('HTTP 预览提供费用和一次性确认，客户端不能改矿位或伪造价格', async () => {
    const q = await getQuote(); assert(q.token); assert.equal(q.cost, 500); assert.equal(q.fleets[0].available, true);
    assert.equal(q.fleets[0].step, undefined); assert.equal(f.client.writes.length, 0);
    assert.equal((await post('action', { ...payload(q), confirm: false })).ok, false);
    assert.equal((await post('action', payload(q), 'two')).ok, false);
  });
  let completedQuote;
  await test('并发双击同一确认只发送一次，归港后重放旧确认也不再派遣', async () => {
    const q = await getQuote(); completedQuote = q;
    let started, release; const entered = new Promise(resolve => { started = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    f.beforeRead = async name => { if (name === 'ChipMineListRequest') { started(); await gate; } };
    const a = post('action', { ...payload(q), gridId: 3000, index: 2, cost: 0 }); await entered;
    const b = post('action', payload(q)); await new Promise(resolve => setTimeout(resolve, 20)); release();
    const results = await Promise.all([a, b]); assert(results.every(r => r.ok)); const bodies = await Promise.all(results.map(r => r.json()));
    assert.deepEqual(bodies[0], bodies[1]); assert.equal(bodies[0].status, 'confirmed'); assert.equal(f.client.writes.length, 1);
    assert.equal(f.client.writes[0].body.gridId, 5000); f.beforeRead = null; f.returnFleet('1远征船');
    assert.equal((await (await post('action', payload(q))).json()).status, 'confirmed'); assert.equal(f.client.writes.length, 1);
    assert.equal((await post('action', { ...payload(q), fleetId: '2远征船' })).ok, false);
  });
  await test('过期确认和连接代次变更拒绝发送', async () => {
    const expired = await getQuote(); session.siliconShortcutQuotes.get(expired.token).expiresAt = Date.now() - 1;
    assert.equal((await post('action', payload(expired))).ok, false);
    const changed = await getQuote(); session.generation++; assert.equal((await post('action', payload(changed))).ok, false); assert.equal(f.client.writes.length, 1);
  });
  await test('修改配置后原确认失效，清空会话后旧确认不能恢复执行', async () => {
    const q = await getQuote(), settings = defaultSettings(); settings.silicon.dailyRewardLimit = 20; saveAutomationSettings('one', settings, { revision: 0 });
    assert.equal((await post('action', payload(q))).ok, false);
    session.siliconShortcutQuotes.clear(); assert.equal((await post('action', payload(completedQuote))).ok, false); assert.equal(f.client.writes.length, 1);
  });
  await test('暂停或未连接的账号不能预览或自动登录', async () => {
    session.paused = true; assert.equal((await post('preview', dispatch())).ok, false);
    assert.equal((await post('preview', dispatch(), 'two')).ok, false); assert.equal(app.sessions.get('two').client, null);
  });
  console.log('硅矿快捷操作 ' + passed + '/' + passed + ' 通过');
} finally {
  if (app) { for (const session of app.sessions.values()) session.client = null; app.server.closeAllConnections(); await app.close(); }
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cw-silicon-shortcuts-')) throw Error('拒绝清理意外目录');
  fs.rmSync(directory, { recursive: true, force: true });
}
