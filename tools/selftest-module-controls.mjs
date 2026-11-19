// Issue #33：挂机模块合并后，暂停不能清空细项或被旧入口绕过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-module-controls-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { defaultSettings, validateSettings, loadAutomationSettings, saveAutomationSettings, importAutomationSettings,
  exportAutomationSettings, settingsFromNative, nativeTaskValues, applyNativeTask, settingsUiRules, hasBaseWork, createUsageLedger } = await import('../src/automation-settings.mjs');
const { idleAutomationControls, automationControlView, setAutomationControl } = await import('../src/automation-controls.mjs');
const { nativePreferenceEnabled, createActionGuard } = await import('../src/automation-policy.mjs');
const { planBaseAutomation, runBaseAutomation } = await import('../src/base-automation.mjs');
const { runAllianceRadar } = await import('../src/alliance-radar.mjs');
const { pirateAdvanceFixture } = await import('./fixtures/pirate-advance.mjs');
const { loadProtocol } = await import('../src/proto.mjs');
const { planRadarPreview } = await import('../src/dispatch-preview.mjs');
const { fleetDispatchView, fleetRecordReason } = await import('../src/fleet-availability.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const pairs = { museum: ['enabled', 'upgrade'], radar: ['enabled', 'repairIdle'] };
const retired = { museum: ['museumCollect', 'museumExplore', 'museumRevenue', 'museumAchievements'], radar: ['radarAuto', 'radarRepair'] };
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
try {
  await check('博物馆与情报总开关各归属自己的配置，未配置提示保留', () => {
    const rules = settingsUiRules();
    for (const [group, keys] of Object.entries(pairs)) {
      assert.deepEqual(idleAutomationControls.filter(c => c.configTarget === group).map(c => c.key), [group + '.runEnabled']);
      assert.deepEqual(rules.moduleControls.filter(c => c.configTarget === group).map(c => c.key), [group + '.runEnabled']);
      assert(rules.controlFields.includes(group + '.runEnabled'));
      assert(!rules.controlFields.includes(group + '.enabled'));
      const defaults = defaultSettings();
      assert.equal(defaults[group].runEnabled, false);
      defaults[group].runEnabled = true;
      assert.match(automationControlView(defaults).find(c => c.key === group + '.runEnabled').configurationNote, /尚未选择执行动作/);
      defaults[group].enabled = defaults[group][keys[0]] = true;
      assert.equal(automationControlView(defaults).find(c => c.key === group + '.runEnabled').configurationNote, '');
    }
  });
  await check('开关往返保留细项，退役入口不可重开，阻断原因可见', () => {
    for (const [group, keys] of Object.entries(pairs)) {
      const s = defaultSettings(); s.loop.world = true; s[group].runEnabled = s[group].enabled = true; s[group][keys[0]] = false; s[group][keys[1]] = true;
      const original = structuredClone(s), off = setAutomationControl(s, group + '.runEnabled', false);
      assert.deepEqual(off, { ...original, [group]: { ...original[group], runEnabled: false } });
      assert.deepEqual(setAutomationControl(off, group + '.runEnabled', true), original);
      assert.deepEqual(s, original);
      for (const key of retired[group]) {
        assert.equal(nativeTaskValues(off, {})[key] ?? false, false);
        assert.deepEqual(applyNativeTask(off, key, true), off);
        assert.equal(nativePreferenceEnabled(off, key), false);
        assert.equal(nativePreferenceEnabled(s, key), false);
        assert.throws(() => setAutomationControl(off, 'schedule.' + key, true), /无效/);
      }
      const views = automationControlView(off);
      for (const key of [group + '.enabled', ...keys.map(k => group + '.' + k)])
        assert(views.find(c => c.key === key).blockedBy.some(label => label.includes('总开关')));
    }
  });
  await check('读取和导入保存当前细项且不再导出退役开关', () => {
    const saved = validateSettings(defaultSettings());
    saved.museum.enabled = true; saved.museum.upgrade = false;
    saved.radar.enabled = false; saved.radar.repairIdle = true;
    const file = path.join(directory, 'current.json');
    saveAutomationSettings('current', saved, { file, revision: 0 });
    const original = fs.readFileSync(file);
    const loaded = loadAutomationSettings('current', { file });
    assert.deepEqual(fs.readFileSync(file), original);
    const imported = importAutomationSettings(exportAutomationSettings(saved));
    for (const group of Object.keys(pairs)) {
      assert.deepEqual(loaded.settings[group], saved[group]);
      assert.deepEqual(imported[group], saved[group]);
      imported[group].runEnabled = true;
      assert.equal(importAutomationSettings(exportAutomationSettings(imported))[group].runEnabled, true);
      const invalid = defaultSettings(); invalid[group].runEnabled = 'false'; assert.throws(() => validateSettings(invalid));
      assert.equal(settingsFromNative({})[group].runEnabled, false);
      for (const key of retired[group]) assert(!Object.hasOwn(imported.schedule, key));
    }
    assert.deepEqual(imported.schedule, saved.schedule);
  });
  await check('暂停博物馆时无详细计划、补料或旧计划写入，结算后暂停也不继续领奖', async () => {
    const settings = defaultSettings(); settings.loop.world = settings.museum.runEnabled = settings.museum.enabled = settings.museum.achievements = true;
    const config = { tables: { MuseumAchievementCfg: { data: [{ score: 100 }] } } };
    const snapshot = { notes: [], choices: [], raids: [], world: { stock: new Map(), buildings: [], factories: [] }, now: 1000,
      player: { level: 35 }, heroes: [], museum: { popularity: 100, exploreStages: [], exhibitions: [] } };
    const plan = planBaseAutomation(snapshot, config, settings);
    assert.equal(plan.actions.length, 1); assert.equal(hasBaseWork(settings), true);
    settings.museum.runEnabled = false;
    assert.equal(hasBaseWork(settings), false);
    const paused = planBaseAutomation(snapshot, config, settings);
    assert.deepEqual(paused.actions, []); assert.deepEqual(paused.demands, []);
    const client = { connected: true, request() { assert.fail('已暂停不得发请求'); }, sendWatch() { assert.fail('已暂停不得写入'); } };
    const guard = createActionGuard(client, () => settings);
    await assert.rejects(guard.before(plan.actions[0]), /设置已关闭/);
    assert.deepEqual(await runBaseAutomation(client, { MuseumClaimAchievementRequest: {} }, config, plan, { getSettings: () => settings }), []);
    const f = pirateAdvanceFixture(); f.settings.loop.world = f.settings.museum.runEnabled = f.settings.museum.enabled = true;
    f.client.request = async name => {
      assert.equal(name, 'MuseumCompleteExploreRequest'); f.settings.museum.runEnabled = false; f.client.writes.push(name); return { grade: 1 };
    };
    await runBaseAutomation(f.client, loadProtocol(), config, { actions: [{ kind: 'museumComplete', scope: 'base', setting: 'museum.enabled',
      request: 'MuseumCompleteExploreRequest', response: 'MuseumCompleteExploreResponse', body: { stageId: 1 } }] }, { getSettings: () => f.settings });
    assert.deepEqual(f.client.writes, ['MuseumCompleteExploreRequest']);
  });
  await check('情报总开关关闭不读取，读取中关闭在派遣前拦截且不占预算', async () => {
    const f = pirateAdvanceFixture(), settings = f.settings;
    Object.assign(settings.radar, { enabled: true, runEnabled: false, fleetIds: ['1远征船'], petrolReserve: 0 });
    const ledger = createUsageLedger('radar', { file: path.join(directory, 'radar-usage.json') });
    const run = () => runAllianceRadar(f.client, f.config, f.player, { getSettings: () => settings, ledger, enabled: () => true, report() {} });
    await run(); assert.deepEqual(f.state.reads, []); assert.deepEqual(f.client.writes, []);
    f.player.guildId = '1001007';
    f.config.tables.ModuleOpenCfg.data.push({ moduleId: '联盟情报', playerLevel: 18 });
    f.config.tables.WorldParamCfg.data.push({ paramName: '情报事件消耗汽油', paramValue: 500 });
    const read = f.client.request; let scans = 0;
    f.client.request = async (name, ...args) => {
      if (name === 'RadarInfoRequest') {
        if (++scans === 2) settings.radar.runEnabled = false;
        return { radarInfo: { events: [{ uid: '9001', eventId: 10001, gridIdx: 101, state: 1, createTime: 10, pirate: { type: 1, level: 1 } }] } };
      }
      return read(name, ...args);
    };
    settings.radar.runEnabled = true; await run();
    assert.equal(scans, 2); assert.deepEqual(f.client.writes, []); assert.equal(ledger.snapshot().counters.radarPetrol ?? 0, 0);
  });
  await check('情报预览与调度意向跟随总开关，关闭后保留真实和未知出征占用', () => {
    const f = pirateAdvanceFixture(), settings = f.settings;
    Object.assign(settings.radar, { enabled: true, runEnabled: true, fleetIds: ['1远征船'], petrolReserve: 0 });
    const ledger = createUsageLedger('radar-preview', { file: path.join(directory, 'radar-preview-usage.json') });
    const snapshot = { world: '1001001', fuel: 3000, cost: 500, stock: new Map([['汽油', 3000]]), fleets: [f.fleet], buildings: [f.building],
      events: [{ uid: '9001', eventId: 10001, state: 1, createTime: 10, pirate: { type: 1, level: 1 } }, { uid: '9002', eventId: 10002, state: 4, createTime: 20 }] };
    const preview = () => planRadarPreview(snapshot, settings, ledger, f.client);
    const view = () => fleetDispatchView(f.client, settings, ledger, snapshot.fleets, snapshot.world)[0];
    assert.deepEqual(preview().actions.map(a => a.kind), ['radarSend', 'radarClaim']);
    assert(view().intents.some(row => row.key === 'radar'));
    settings.radar.runEnabled = false;
    const off = preview(); assert.deepEqual(off.actions, []);
    assert.match(off.notes.join('；'), /联盟情报总开关已关闭/);
    assert(off.fleets.every(fleet => /总开关已关闭/.test(fleet.reason)));
    assert(!view().intents.some(row => row.key === 'radar'));
    settings.radar.runEnabled = true;
    assert.deepEqual(preview().actions.map(a => a.kind), ['radarSend', 'radarClaim']);
    const ticket = ledger.reserve({ radarPetrol: 500 }, {}, {}, { uniqueKey: 'radar-send:1001001:9001', details: { kind: 'radarSend', buildingId: '1远征船', worldId: '1001001', active: true } });
    settings.radar.runEnabled = false;
    assert.match(fleetRecordReason(ledger.keyRecords(), '1远征船', '1001001'), /待确认/);
    assert.match(view().reason, /待确认/);
    ledger.confirm(ticket);
    assert.match(view().reason, /情报尚未结束/);
    assert(!view().intents.some(row => row.key === 'radar'));
  });
  await check('HTTP 聚合开关保存、重载与账号隔离，关闭期间编辑细项保持暂停', async () => {
    const { saveStore } = await import('../src/accounts.mjs');
    saveStore({ version: 1, activeId: 'module-a', accounts: ['module-a', 'module-b'].map(id => ({ id, label: '模块测试', url: 'ws://127.0.0.1:1', login: {}, automation: { paused: true } })) });
    const settings = validateSettings(defaultSettings()); settings.radar.repairIdle = settings.museum.enabled = true;
    saveAutomationSettings('module-a', settings, { revision: 0 });
    const { createConsole } = await import('./fixtures/console-server.mjs'); const app = createConsole({ port: 0 }); await app.listen();
    const api = async (route, body, account = 'module-a') => {
      const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/' + route + '?account=' + account,
        { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    try {
      const other = await api('settings', null, 'module-b');
      for (const group of Object.keys(pairs)) {
        const before = await api('settings');
        const off = await api('loop/control', { confirm: true, key: group + '.runEnabled', enabled: false, revision: before.data.revision });
        assert.equal(off.status, 200);
        const saved = await api('settings');
        assert.equal(loadAutomationSettings('module-a').settings[group].runEnabled, false);
        assert.deepEqual(saved.data.settings.schedule, settings.schedule);
        for (const field of pairs[group]) assert.equal(saved.data.settings[group][field], settings[group][field]);
        const updated = structuredClone(saved.data.settings); updated[group].enabled = true;
        const change = await api('settings', { confirm: true, settings: updated, revision: saved.data.revision });
        assert.equal(change.status, 200); assert.equal(change.data.settings[group].runEnabled, false);
        const on = await api('loop/control', { confirm: true, key: group + '.runEnabled', enabled: true, revision: change.data.revision });
        assert.equal(on.status, 200);
        assert.equal((await api('settings')).data.settings[group].enabled, true);
        assert.equal((await api('loop/control', { confirm: true, key: group + '.runEnabled', enabled: false, revision: before.data.revision })).status, 400);
      }
      assert.deepEqual((await api('settings', null, 'module-b')).data.settings, other.data.settings);
      assert(!app.sessions.get('module-a').client);
      const none = settingsFromNative(Object.fromEntries(automationTasks.map(task => [task.key, false])));
      none.radar.enabled = true; none.radar.runEnabled = false;
      const current = await api('settings');
      const changed = await api('settings', { confirm: true, settings: none, revision: current.data.revision });
      assert.equal(changed.status, 200);
      const session = app.sessions.get('module-a'); session.paused = false;
      assert(!Object.values(session.loop.tasks).some(Boolean));
      const start = await api('loop/start', { confirm: true, rounds: 1, everySeconds: 60 });
      assert.equal(start.status, 400); assert.match(start.data.error, /至少启用一个自动项目/);
      assert(!session.client, '无有效项目时不能先尝试登录');
      session.loop.running = true; session.loop.controller = new AbortController();
      const stop = await api('loop/task', { confirm: true, key: 'mail', enabled: false });
      assert.equal(stop.status, 200); assert.equal(session.loop.controller.signal.aborted, true);
      session.loop.running = false;
    } finally { await app.close(); }
  });
  console.log(`模块开关聚合专项 ${passed}/${passed} 通过`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
