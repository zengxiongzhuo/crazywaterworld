import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resource-field-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const { resourceFieldFixture } = await import('./fixtures/resource-fields.mjs');
const { installResourceFieldMap } = await import('./fixtures/resource-field-map.mjs');
const { defaultSettings, saveAutomationSettings, createUsageLedger } = await import('../src/automation-settings.mjs');
const { reserveDispatch, legacyFleetReservationReason, dispatchReservationReason } = await import('../src/fleet-availability.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const f = resourceFieldFixture(), cleanupMap = installResourceFieldMap(f);
f.config.tables.BuildingUnlockCfg = { data: [1, 2, 3].map(n => ({ buildingId: n + '远征船', buildingType: '远征船' })) };
let app, passed = 0;
const test = async (name, body) => { await body(); passed++; console.log('通过：' + name); };
async function waitForRead(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('确认操作未进入复核读取')), 5000); })]); }
  finally { clearTimeout(timer); }
}
try {
  fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(f.config.tables).map(([name, table], i) => [i, name, table])));
  const replacementAccounts = Array.from({ length: 40 }, (_, i) => 'replacement-' + (i + 1));
  saveStore({ activeId: 'one', accounts: ['one', 'two', ...replacementAccounts].map(id => ({ id, label: '占田测试' + id,
    url: 'wss://invalid.invalid', login: {}, automation: { paused: true, enabled: false } })) });
  app = createConsole({ port: 0, protocol: f.protocol }); const base = await app.listen();
  for (const id of ['one', 'two']) await fetch(base + '/api/settings?account=' + id);
  const session = app.sessions.get('one'); session.client = f.client; session.player = f.player; session.paused = false;
  const post = (route, body, account = 'one') => fetch(base + '/api/resource-fields/' + route + '?account=' + account,
    { method: 'POST', body: JSON.stringify(body) });
  const quote = async (gridIdx = 20) => { const res = await post('preview', { gridIdx }); assert(res.ok, await res.clone().text()); return res.json(); };
  const payload = q => ({ confirm: true, token: q.token, fleetId: '1远征船' });
  await test('策略草稿预览列出计划但不结算账本或改变舰队预留', async () => {
    const settings = defaultSettings(); Object.assign(settings.resourceFields, { enabled: true, fleetIds: ['2远征船'], reserveFleetCount: 0 });
    const ledger = createUsageLedger('one'), worldId = String(f.player.worldId);
    const ticket = ledger.reserve({ resourceFieldPetrol: 300 }, {}, {}, { uniqueKey: 'resource-field:' + worldId + ':10',
      details: { kind: 'resourceFieldDispatch', worldId, buildingId: '1远征船', gridIdx: 10, active: true } });
    Object.assign(f.state.fleets[0], { state: 2, targetGridIdx: 10 });
    reserveDispatch(f.client, 'maintenance', ['3远征船']);
    const bytes = fs.readFileSync(path.join(directory, 'automation-usage.json'));
    const held = dispatchReservationReason(f.client, settings, 'resourceFields', '3远征船');
    const legacy = legacyFleetReservationReason(f.client, '1远征船');
    const response = await fetch(base + '/api/settings/preview?account=one', { method: 'POST', body: JSON.stringify({ category: 'resourceFields', settings }) });
    assert(response.ok, await response.clone().text()); const data = await response.json();
    assert.equal(data.actions.length, 1); assert.equal(data.actions[0].kind, 'resourceFieldDispatch');
    assert.deepEqual(fs.readFileSync(path.join(directory, 'automation-usage.json')), bytes);
    assert.equal(dispatchReservationReason(f.client, settings, 'resourceFields', '3远征船'), held);
    assert.equal(legacyFleetReservationReason(f.client, '1远征船'), legacy);
    assert.equal(f.client.writes.length, 0);
    ledger.cancel(ticket); f.returnFleet('1远征船'); reserveDispatch(f.client, 'maintenance', []);
  });
  await test('总览与确认预览只读，快捷占领不要求开启自动策略', async () => {
    const response = await fetch(base + '/api/resource-fields/overview?account=one'); assert(response.ok);
    const data = await response.json(); assert.equal(data.count, 0); assert.equal(data.maxNum, 5); assert.equal(data.cost, 300);
    assert.equal(data.automatic, false); assert(data.candidates.length > 0);
    const q = await quote(10); assert(q.token); assert.equal(q.cost, 300); assert.equal(q.fleets[0].available, true);
    assert.equal(q.fleets[0].step, undefined); assert.equal(q.worldId, undefined); assert.equal(f.client.writes.length, 0);
    assert.equal((await post('action', { ...payload(q), confirm: false })).ok, false);
    assert.equal((await post('action', payload(q), 'two')).ok, false);
    assert.equal((await post('action', { ...payload(q), token: 'forged-token' })).ok, false);
  });
  let completed;
  await test('并发双击与重放使用同一结果，客户端不能修改目标或费用', async () => {
    completed = await quote(10);
    let enter, release; const entered = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    f.beforeRead = async name => { if (name === 'MyResFieldsRequest') { enter(); await gate; } };
    const first = post('action', { ...payload(completed), gridIdx: 30, cost: 0 }); await waitForRead(entered);
    const second = post('action', payload(completed)); await new Promise(resolve => setTimeout(resolve, 20)); release();
    const responses = await Promise.all([first, second]); assert(responses.every(r => r.ok));
    const bodies = await Promise.all(responses.map(r => r.json())); assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(bodies[0].status, 'confirmed'); assert.equal(f.client.writes.length, 1);
    assert.deepEqual(f.client.writes[0].body, { resFieldGridIdx: 10, fleetBuildingIds: ['1远征船'] });
    assert.equal(f.state.fuel, 5700); f.beforeRead = null; f.returnFleet('1远征船');
    assert.equal((await (await post('action', payload(completed))).json()).status, 'confirmed');
    assert.equal(f.client.writes.length, 1);
    assert.equal((await post('action', { ...payload(completed), fleetId: '2远征船' })).ok, false);
  });
  await test('确认后舰队忙碌或城池失守拒绝旧请求', async () => {
    const busy = await quote(); f.state.fleets[0].state = 3;
    assert.equal((await post('action', payload(busy))).ok, false); f.state.fleets[0].state = 1;
    const lost = await quote(); f.state.cities.find(c => c.id === 2).guildIdx = 8;
    assert.equal((await post('action', payload(lost))).ok, false); f.state.cities.find(c => c.id === 2).guildIdx = 7;
    assert.equal(f.client.writes.length, 1);
  });
  await test('过期、连接代次或身份切换让确认失效', async () => {
    const expired = await quote(); session.resourceFieldQuotes.get(expired.token).expiresAt = Date.now() - 1;
    assert.equal((await post('action', payload(expired))).ok, false);
    const changed = await quote(); session.generation++; assert.equal((await post('action', payload(changed))).ok, false);
    const identity = await quote(), previous = session.player; session.player = { ...previous };
    assert.equal((await post('action', payload(identity))).ok, false); session.player = previous;
    assert.equal(f.client.writes.length, 1);
  });
  await test('保存新配置后必须重新确认，清空会话后不能重用旧token', async () => {
    const q = await quote(), settings = defaultSettings(); settings.resourceFields.ratios.seeds = 2;
    saveAutomationSettings('one', settings, { revision: 0 });
    assert.equal((await post('action', payload(q))).ok, false);
    session.resourceFieldQuotes.clear(); assert.equal((await post('action', payload(completed))).ok, false);
    assert.equal(f.client.writes.length, 1);
  });
  await test('暂停或未连接账号不读取资源田、不隐式登录', async () => {
    session.paused = true;
    assert.equal((await post('preview', { gridIdx: 10 })).ok, false);
    assert.equal((await fetch(base + '/api/resource-fields/overview?account=one')).ok, false);
    assert.equal((await post('preview', { gridIdx: 10 }, 'two')).ok, false);
    assert.equal(app.sessions.get('two').client, null);
  });
  let replacementIndex = 0;
  async function replacementFixture() {
    const account = replacementAccounts[replacementIndex++], g = resourceFieldFixture();
    assert(account, '替换测试账号数量足够');
    g.player.scenarioId = f.player.scenarioId;
    g.state.maxNum = 2;
    g.state.fields = [{ gridIdx: 20, cityId: 2, type: 3 }, { gridIdx: 21, cityId: 2, type: 2 }];
    await fetch(base + '/api/settings?account=' + account);
    const scoped = app.sessions.get(account); scoped.client = g.client; scoped.player = g.player; scoped.paused = false;
    const send = (route, body, owner = account) => post(route, body, owner);
    const preview = async (intent = { gridIdx: 10, replaceGridIdx: 20 }) => {
      const response = await send('preview', intent); assert(response.ok, await response.clone().text()); return response.json();
    };
    return { ...g, fixture: g, account, session: scoped, send, preview };
  }
  await test('满额替换预览绑定旧田，确认并发与重放仅放弃一次且不接受改目标', async () => {
    const g = await replacementFixture(), q = await g.preview();
    assert(q.token); assert.equal(q.replaceGridIdx, 20); assert.equal(q.replacement.grid, 20);
    assert.equal(q.resourceId, '汽油'); assert(q.perHour > q.replacement.perHour);
    assert.equal(g.client.writes.length, 0); assert.equal(g.state.fields.length, 2);
    let enter, release; const entered = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    g.fixture.beforeRead = async name => { if (name === 'MyResFieldsRequest') { enter(); await gate; } };
    const first = g.send('action', { ...payload(q), replaceGridIdx: 21, gridIdx: 12, cost: 0 }); await waitForRead(entered);
    const second = g.send('action', payload(q)); await new Promise(resolve => setTimeout(resolve, 20)); release();
    const responses = await Promise.all([first, second]); assert(responses.every(response => response.ok));
    const bodies = await Promise.all(responses.map(response => response.json())); assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(bodies[0].ok, true); assert.equal(bodies[0].status, 'confirmed');
    assert.equal(bodies[0].released, true); assert.equal(bodies[0].partial, false);
    assert.deepEqual(g.client.writes.map(write => [write.name, write.body]), [
      ['GiveUpResFieldRequest', { resFieldGridIdx: 20 }],
      ['ChallengeResFieldRequest', { resFieldGridIdx: 10, fleetBuildingIds: ['1远征船'] }],
    ]);
    assert.deepEqual(g.state.fields.map(field => field.gridIdx), [21]); assert.equal(g.state.fuel, 5700);
    g.fixture.beforeRead = null;
    const replay = await g.send('action', payload(q)); assert(replay.ok); assert.deepEqual(await replay.json(), bodies[0]);
    assert.equal((await g.send('action', { ...payload(q), fleetId: '2远征船' })).ok, false);
    assert.equal(g.client.writes.length, 2);
  });
  await test('替换确认跨账号、过期、配置改变或条件失效均不放弃旧田', async () => {
    for (const kind of ['otherAccount', 'expired', 'settings', 'generation', 'paused', 'fleetBusy', 'cityLost', 'fuel']) {
      const g = await replacementFixture(), q = await g.preview(); assert(q.token, kind);
      if (kind === 'expired') g.session.resourceFieldQuotes.get(q.token).expiresAt = Date.now() - 1;
      if (kind === 'settings') { const settings = defaultSettings(); settings.resourceFields.allocationMode = 'quota'; saveAutomationSettings(g.account, settings, { revision: 0 }); }
      if (kind === 'generation') g.session.generation++;
      if (kind === 'paused') g.session.paused = true;
      if (kind === 'fleetBusy') g.state.fleets[0].state = 3;
      if (kind === 'cityLost') g.state.cities.find(city => city.id === 1).guildIdx = 8;
      if (kind === 'fuel') g.state.fuel = 0;
      const response = await g.send('action', payload(q), kind === 'otherAccount' ? 'two' : g.account);
      assert.equal(response.ok, false, kind); assert.equal(g.client.writes.length, 0, kind);
      assert.deepEqual(g.state.fields.map(field => field.gridIdx), [20, 21], kind);
    }
  });
  await test('替换的旧田必须仍归本人且新目标不能是已占田', async () => {
    const g = await replacementFixture();
    for (const intent of [{ gridIdx: 10, replaceGridIdx: 22 }, { gridIdx: 20, replaceGridIdx: 20 }, { gridIdx: 21, replaceGridIdx: 20 }]) {
      const response = await g.send('preview', intent);
      if (response.ok) assert.equal((await response.json()).token, null);
    }
    const q = await g.preview(); assert(q.token); g.state.fields = g.state.fields.filter(field => field.gridIdx !== 20);
    assert.equal((await g.send('action', payload(q))).ok, false); assert.equal(g.client.writes.length, 0);
  });
  await test('放弃结果未知不继续占领，重放确认也不重复放弃', async () => {
    const g = await replacementFixture(); g.fixture.unknownRequest = 'GiveUpResFieldRequest';
    const q = await g.preview(), response = await g.send('action', payload(q)); assert(response.ok);
    const result = await response.json(); assert.equal(result.ok, false); assert.equal(result.status, 'unknown');
    assert.equal(result.released, false); assert.equal(result.partial, false);
    assert.deepEqual(g.client.writes.map(write => write.name), ['GiveUpResFieldRequest']);
    assert.deepEqual(g.state.fields.map(field => field.gridIdx), [20, 21]);
    const replay = await g.send('action', payload(q)); assert(replay.ok); assert.deepEqual(await replay.json(), result);
    assert.equal(g.client.writes.length, 1);
  });
  await test('旧田已放弃而新田出征未知或拒绝必须报告部分完成', async () => {
    for (const failure of ['unknownRequest', 'rejectRequest']) {
      const g = await replacementFixture(); g.fixture[failure] = 'ChallengeResFieldRequest';
      const q = await g.preview(), response = await g.send('action', payload(q)); assert(response.ok);
      const result = await response.json(); assert.equal(result.ok, false); assert.equal(result.released, true); assert.equal(result.partial, true);
      assert.equal(result.status, failure === 'unknownRequest' ? 'unknown' : 'rejected');
      assert.deepEqual(g.client.writes.map(write => write.name), ['GiveUpResFieldRequest', 'ChallengeResFieldRequest']);
      assert.deepEqual(g.state.fields.map(field => field.gridIdx), [21]);
      const replay = await g.send('action', payload(q)); assert(replay.ok); assert.deepEqual(await replay.json(), result);
      assert.equal(g.client.writes.length, 2);
    }
  });
  await test('旧田放弃后舰队变忙时停止挑战并明确旧田已失去', async () => {
    const g = await replacementFixture();
    g.fixture.afterWrite = name => { if (name === 'GiveUpResFieldRequest') g.state.fleets[0].state = 3; };
    const q = await g.preview(), response = await g.send('action', payload(q)); assert(response.ok);
    const result = await response.json(); assert.equal(result.ok, false); assert.equal(result.released, true); assert.equal(result.partial, true);
    assert.deepEqual(g.client.writes.map(write => write.name), ['GiveUpResFieldRequest']);
    assert.deepEqual(g.state.fields.map(field => field.gridIdx), [21]);
  });
  const giveUpIntent = (gridIdx = 20) => ({ kind: 'giveUp', gridIdx });
  const giveUpPayload = q => ({ confirm: true, token: q.token });
  await test('零汽油且没有空闲舰队仍可单独放弃，自动化配置保持不变', async () => {
    const g = await replacementFixture(), settings = defaultSettings();
    Object.assign(settings.resourceFields, { enabled: true, fleetIds: ['1远征船'], ratios: { fuel: 0, seeds: 1, tech: 0 } });
    saveAutomationSettings(g.account, settings, { revision: 0 });
    g.state.fuel = 0; for (const fleet of g.state.fleets) fleet.state = 3;
    const q = await g.preview(giveUpIntent());
    assert(q.token); assert.equal(q.kind, 'giveUp'); assert.equal(q.available, true);
    assert.equal(q.cost, 0); assert.equal(q.field.grid, 20); assert.equal(q.automatic, true);
    assert.equal(g.client.writes.length, 0);
    const response = await g.send('action', giveUpPayload(q)); assert(response.ok);
    const result = await response.json(); assert.equal(result.kind, 'giveUp'); assert.equal(result.ok, true); assert.equal(result.status, 'confirmed');
    assert.deepEqual(g.client.writes.map(write => [write.name, write.body]), [['GiveUpResFieldRequest', { resFieldGridIdx: 20 }]]);
    assert.deepEqual(g.state.fields.map(field => field.gridIdx), [21]); assert.equal(g.state.fuel, 0);
    const saved = await (await fetch(base + '/api/settings?account=' + g.account)).json(); assert.deepEqual(saved.settings, settings);
  });
  await test('单田放弃token绑定动作与格子，并发重放只发送一次放弃', async () => {
    const g = await replacementFixture(), q = await g.preview(giveUpIntent()); assert(q.token);
    let enter, release; const entered = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    g.fixture.beforeRead = async name => { if (name === 'MyResFieldsRequest') { enter(); await gate; } };
    const first = g.send('action', { ...giveUpPayload(q), kind: 'occupy', gridIdx: 21, replaceGridIdx: 21, fleetId: '2远征船' }); await waitForRead(entered);
    const second = g.send('action', giveUpPayload(q)); await new Promise(resolve => setTimeout(resolve, 20)); release();
    const responses = await Promise.all([first, second]); assert(responses.every(response => response.ok));
    const results = await Promise.all(responses.map(response => response.json())); assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].kind, 'giveUp'); assert.equal(results[0].ok, true); assert.equal(results[0].status, 'confirmed');
    assert.deepEqual(g.client.writes.map(write => [write.name, write.body]), [['GiveUpResFieldRequest', { resFieldGridIdx: 20 }]]);
    assert.deepEqual(g.state.fields.map(field => field.gridIdx), [21]); g.fixture.beforeRead = null;
    const replay = await g.send('action', { ...giveUpPayload(q), kind: 'replace', gridIdx: 10 }); assert(replay.ok);
    assert.deepEqual(await replay.json(), results[0]); assert.equal(g.client.writes.length, 1);
  });
  await test('未占领田及失效、跨账号、暂停或配置改变的放弃确认不发送请求', async () => {
    const unowned = await replacementFixture(), invalid = await unowned.send('preview', giveUpIntent(10));
    if (invalid.ok) { const q = await invalid.json(); assert.equal(q.token, null); assert.equal(q.available, false); }
    assert.equal(unowned.client.writes.length, 0);
    for (const kind of ['forged', 'unconfirmed', 'otherAccount', 'expired', 'settings', 'generation', 'paused', 'notOwned']) {
      const g = await replacementFixture(), q = await g.preview(giveUpIntent()); assert(q.token, kind);
      if (kind === 'expired') g.session.resourceFieldQuotes.get(q.token).expiresAt = Date.now() - 1;
      if (kind === 'settings') { const settings = defaultSettings(); settings.resourceFields.ratios.tech = 4; saveAutomationSettings(g.account, settings, { revision: 0 }); }
      if (kind === 'generation') g.session.generation++;
      if (kind === 'paused') g.session.paused = true;
      if (kind === 'notOwned') g.state.fields = g.state.fields.filter(field => field.gridIdx !== 20);
      const body = { ...giveUpPayload(q), ...(kind === 'forged' ? { token: 'forged-giveup-token' } : {}), ...(kind === 'unconfirmed' ? { confirm: false } : {}) };
      assert.equal((await g.send('action', body, kind === 'otherAccount' ? 'two' : g.account)).ok, false, kind);
      assert.equal(g.client.writes.length, 0, kind);
    }
  });
  await test('单独放弃未知结果持久防重，后续真实移除才确认', async () => {
    const g = await replacementFixture(); g.fixture.unknownRequest = 'GiveUpResFieldRequest';
    const q = await g.preview(giveUpIntent()), response = await g.send('action', giveUpPayload(q)); assert(response.ok);
    const result = await response.json(); assert.equal(result.kind, 'giveUp'); assert.equal(result.ok, false); assert.equal(result.status, 'unknown');
    assert.deepEqual(g.state.fields.map(field => field.gridIdx), [20, 21]);
    assert.deepEqual(g.client.writes.map(write => write.name), ['GiveUpResFieldRequest']);
    const replay = await g.send('action', giveUpPayload(q)); assert(replay.ok); assert.deepEqual(await replay.json(), result);
    const ledger = createUsageLedger(g.account), unresolved = Object.entries(ledger.keyRecords()).filter(([, record]) => !record.confirmed).map(([key]) => key);
    assert(unresolved.length > 0, '未知放弃有持久化未确认记录');
    g.session.resourceFieldQuotes.clear(); g.session.generation++;
    // Reconnect with a new client identity so an in-memory WeakMap cannot be
    // the reason the second attempt is blocked; only persisted evidence remains.
    g.session.client = Object.assign(new EventEmitter(), { connected: true, serverClockOffsetMs: 0,
      request: g.client.request, sendWatch: g.client.sendWatch });
    assert.equal((await g.send('action', giveUpPayload(q))).ok, false);
    const blocked = await g.preview(giveUpIntent()); assert.equal(blocked.available, false); assert.equal(blocked.token, null);
    const persisted = createUsageLedger(g.account); assert(unresolved.every(key => persisted.keyRecords()[key]?.confirmed === false));
    g.state.fields = g.state.fields.filter(field => field.gridIdx !== 20);
    const overviewResponse = await fetch(base + '/api/resource-fields/overview?account=' + g.account); assert(overviewResponse.ok);
    const overview = await overviewResponse.json(); assert.equal(overview.count, 1);
    const reconciled = createUsageLedger(g.account).keyRecords(); assert(unresolved.every(key => !reconciled[key] || reconciled[key].confirmed));
    assert.equal(g.client.writes.length, 1); assert.equal(g.state.fuel, 6000);
  });
  await test('替换放弃未知与单独放弃未知相互阻止，不重复放弃同一田', async () => {
    for (const mode of ['replacement', 'giveUp']) {
      const g = await replacementFixture(); g.fixture.unknownRequest = 'GiveUpResFieldRequest';
      const replacement = await g.preview(), single = await g.preview(giveUpIntent()); assert(replacement.token); assert(single.token);
      const initial = mode === 'replacement' ? replacement : single;
      const response = await g.send('action', mode === 'replacement' ? payload(initial) : giveUpPayload(initial)); assert(response.ok);
      const result = await response.json(); assert.equal(result.ok, false); assert.equal(result.status, 'unknown');
      const staleResponse = await g.send('action', mode === 'replacement' ? giveUpPayload(single) : payload(replacement));
      if (staleResponse.ok) assert.equal((await staleResponse.json()).ok, false);
      const fresh = await g.preview(mode === 'replacement' ? giveUpIntent() : { gridIdx: 10, replaceGridIdx: 20 }); assert.equal(fresh.token, null);
      assert.deepEqual(g.client.writes.map(write => write.name), ['GiveUpResFieldRequest']);
      assert.deepEqual(g.state.fields.map(field => field.gridIdx), [20, 21]);
    }
  });
  console.log('资源田 HTTP 操作 ' + passed + '/' + passed + ' 通过');
} finally {
  if (app) { for (const session of app.sessions.values()) session.client = null; app.server.closeAllConnections(); await app.close(); }
  cleanupMap();
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cw-resource-field-http-')) throw Error('意外测试目录');
  fs.rmSync(directory, { recursive: true, force: true });
}
