import { newStateFunction } from './fixtures/console-state.mjs';
// 执行真实前端函数，以可控时钟、隔离账号文件验证自动保存及请求竞争。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS_SCHEMA_VERSION, defaultSettings, validateSettings, saveAutomationSettings, loadAutomationSettings, importAutomationSettings, exportAutomationSettings } from '../src/automation-settings.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-settings-autosave-'));
const script = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
const pageSource = fs.readFileSync(new URL('../src/page.mjs', import.meta.url), 'utf8');
const renderLoopSource = pageSource.slice(pageSource.indexOf('function renderLoop('), pageSource.indexOf('let loopReads = 0;'));
const section = (from, to) => {
  const start = script.indexOf(from), end = script.indexOf(to, start);
  assert(start >= 0 && end > start, from);
  return script.slice(start, end);
};
const sources = [
  section('// 游戏配置编辑器', 'function configGet('),
  section('function configGet(', 'function configRevealTab('),
  section('function configRevealSection(', 'function configRender()'),
  section('function configSyncRecovery(', 'async function configRefreshPlayers('),
  section('function configSave(', 'async function configExport('),
  section('async function configExport(', 'async function configPreview('),
  section('async function configPreview(', "$('config-form').onsubmit"),
].join('\n');
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let serial = 0, passed = 0;
async function test(name, run) { await run(); passed++; console.log('通过：' + name); }

function fixture({ catalog = {} } = {}) {
  const file = path.join(directory, 'settings-' + (++serial) + '.json');
  for (const id of ['a', 'b']) saveAutomationSettings(id, defaultSettings(), { file, revision: 0 });
  let now = 0, timerId = 0;
  const timers = new Map(), nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, childNodes: [], value: '', hidden: false, disabled: false,
      classList: { contains: () => true }, setAttribute() {}, removeAttribute() {}, append() {}, scrollIntoView() {},
    });
    return nodes.get(id);
  };
  const view = account => {
    const saved = loadAutomationSettings(account, { file });
    return { ...saved, catalog, rules: {}, tasks: [], usage: {}, pendingUsage: {}, running: false,
      recoveryToken: env.recovery[account] ? 'recovery:' + account + ':' + saved.revision : null,
      ...(env.recovery[account] ? { recovery: structuredClone(env.recovery[account]) } : {}) };
  };
  const env = {
    node, calls: [], downloads: [], renders: 0, focuses: 0, confirmations: 0, failPosts: 0, inFlight: 0, maxInFlight: 0, recovery: {}, confirmResult: false, stale: false,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    confirm() { env.confirmations++; return env.confirmResult; },
    async call(account, route, options) {
      const payload = options?.body ? JSON.parse(options.body) : null;
      env.calls.push({ account, route, payload });
      if (route === '/api/settings/validate') {
        const settings = payload.document ? importAutomationSettings(payload.document) : validateSettings(payload.settings);
        return { settings, document: exportAutomationSettings(settings) };
      }
      if (route === '/api/loop') return { controls: [] };
      assert(['/api/settings','/api/settings?fleets=1'].includes(route));
      if (!payload) { const data = view(account); await env.onGet?.(); return data; }
      env.inFlight++; env.maxInFlight = Math.max(env.maxInFlight, env.inFlight);
      try {
        if (env.failPosts-- > 0) throw new TypeError('模拟网络断开');
        await env.beforePost?.(payload);
        if (env.recovery[account] && payload.recoveryToken !== view(account).recoveryToken) throw Object.assign(new Error('配置已恢复，请重新载入'), { fields: { revision: '恢复标识已变化，请重新载入' } });
        saveAutomationSettings(account, payload.settings, { file, revision: payload.revision });
        delete env.recovery[account];
        const data = view(account);
        await env.onPost?.(payload);
        return data;
      } finally { env.inFlight--; }
    },
  };
  const api = newStateFunction('env', sources + `
    let current = 'a', loopSettingsRevision = 1, loopFieldDefaults = null, loopAccount = null, accountStatusRevision = 0, snapshot = {};
    stateActions.replaceAccounts([{id:'a',status:{}},{id:'b',status:{}}],'a');
    const accounts = [], $ = env.node, window = { confirm: env.confirm }, loopIntervalSaves = new Map();
    const document = { body: { append() {} }, createElement: () => ({ click() {}, remove() {} }) };
    window.document = document; window.cwConsoleVersion = { isStale: () => env.stale };
    const consoleDraftFormat = {format:'crazywaterworld-automation',version:${SETTINGS_SCHEMA_VERSION}};
    const URL = { createObjectURL(blob) { env.downloads.push(blob); return 'blob:settings-fixture'; }, revokeObjectURL() {} };
    const setTimeout = env.setTimeout, clearTimeout = env.clearTimeout;
    const call = (route, options) => env.call(current, route, options);
    const configRenderUsage = () => {}, configUpdateVisibility = () => env.updateVisibility?.();
    const configActivate = () => { env.focuses++; }, configActivateGroup = () => {};
    const configRender = () => { env.renders++; env.onRender?.(); };
    const resetWorldMap = () => {};
    const configWeeklyRankingReset = () => {};
    const configWeeklyRankingSync = () => {};
    const renderAutomationOverview = () => {}, renderPirateAdvance = () => {}, renderHostingControl = () => {}, paintConnection = () => {}, renderAccounts = () => {};
    const clear = node => node, el = () => ({});
    ${renderLoopSource}
    return {
      editor: configEditor, groups: configGroups, strategyFields: cityWarStrategyFields, set: configSet, load: configLoad, reload: configReload, save: configSave, flush: configFlush,
      message: configMessage, compatibilityMessage: configCompatibilityMessage,
      expire() { env.stale = true; configVersionStale(); }, preview: configPreview,
      renderLoop,
      dirty: configIsDirty, importFile: configImportFile, exportFile: configExport, mayChange: configMayChangeAccount,
      revision: () => loopSettingsRevision,
      setLoopRevision(revision) { loopSettingsRevision = revision; },
      intervalSaved: configIntervalSaved,
      compatibilityMessage: configCompatibilityMessage,
      intervalSaves: loopIntervalSaves,
      change(next) { current = next; configAccountChanged(); },
    };
  `)(env);
  return { ...api, env, node, file, view,
    posts: () => env.calls.filter(row => row.route === '/api/settings' && row.payload),
    async tick(ms) {
      const end = now + ms; let executions = 0;
      await settle();
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert(++executions < 100, '自动保存不能无界重试');
        const [id, timer] = next; timers.delete(id); now = timer.at; timer.callback(); await settle();
      }
      now = end; await settle();
    },
  };
}

await test('页面过期立即冻结自动保存并保留草稿，导入预览和flush不再发送请求', async () => {
  const f = fixture(); await f.load(); f.set('factory.keepStock', 321);
  const draft = structuredClone(f.editor.draft), calls = f.env.calls.length; f.expire();
  await f.tick(10000); assert.equal(await f.flush(), false); assert.equal(await f.save(), false);
  await f.importFile({target:{files:[{size:20,text:async()=>JSON.stringify(exportAutomationSettings(defaultSettings()))}]}});
  await f.preview(); await f.load(); await f.reload();
  assert.equal(f.env.calls.length, calls); assert.deepEqual(f.editor.draft, draft);
  assert.match(f.node('config-state').textContent, /页面已过期/); assert.match(f.node('config-message').textContent, /草稿.*保留/);
  assert.equal(f.node('config-import').disabled, true); assert.equal(f.node('config-preview').disabled, true);
  f.compatibilityMessage({compatibility:null}); assert.match(f.node('config-message').textContent, /页面已过期/);
  f.set('factory.keepStock', 654); await f.tick(10000); assert.equal(f.posts().length, 0);
});

await test('过期页面可在本地下载当前未校验草稿，不依赖服务器validate', async () => {
  const f = fixture(); await f.load(); f.set('factory.keepStock', null); f.expire();
  const calls = f.env.calls.length; await f.exportFile();
  assert.equal(f.env.calls.length, calls); assert.equal(f.env.downloads.length, 1);
  const exported = JSON.parse(await f.env.downloads[0].text());
  assert.equal(exported.format, 'crazywaterworld-automation'); assert.equal(exported.version, SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(exported.settings, f.editor.draft); assert.equal(exported.settings.factory.keepStock, null);
  assert.match(f.node('config-message').textContent, /页面已过期.*\n.*未发送到服务器/s);
});

await test('保存成功响应晚于页面过期时不覆盖草稿基线也不显示同步成功', async () => {
  const f = fixture(); await f.load(); const baseline = structuredClone(f.editor.baseline);
  f.set('factory.keepStock', 321); const pending = deferred(); f.env.onPost = () => pending.promise;
  const save = f.save(); await settle(); f.expire(); f.set('factory.keepStock', 654);
  pending.resolve(); assert.equal(await save, false);
  assert.deepEqual(f.editor.baseline, baseline); assert.equal(f.editor.draft.factory.keepStock, 654);
  assert.match(f.node('config-state').textContent, /页面已过期/); assert.doesNotMatch(f.node('config-state').textContent, /配置已同步/);
  await f.tick(30000); assert.equal(f.posts().length, 1, '已过期不能重试或继续保存后一批');
});

await test('设置读取晚于版本变化时不把新服务配置套入旧页面', async () => {
  const f = fixture(); await f.load(); const old = structuredClone(f.editor.draft), pending = deferred();
  const changed = structuredClone(f.view('a').settings); changed.factory.keepStock = 789;
  saveAutomationSettings('a', changed, {file:f.file,revision:f.view('a').revision});
  f.env.onGet = () => pending.promise; const loading = f.load(); await settle(); f.expire(); pending.resolve(); await loading;
  assert.deepEqual(f.editor.draft, old); assert.match(f.node('config-state').textContent, /页面已过期/);
});

await test('配置丢失或损坏首次载入关闭默认值，恢复警告持续至重新配置保存', async () => {
  for (const reason of ['missing', 'corrupt']) {
    const f = fixture();
    f.env.recovery.a = { required: true, reason, message: '需要重新配置', ...(reason === 'corrupt' ? { backupFile: 'C:\\备份\\配置损坏.json' } : {}) };
    await f.load();
    assert.deepEqual(f.editor.draft, defaultSettings());
    assert.equal(f.editor.recoveryBlocked, false);
    assert.match(f.node('config-message').textContent, reason === 'missing' ? /配置丢失/ : /配置损坏/);
    assert.match(f.node('config-message').textContent, /已恢复关闭的默认配置.*自动挂机已停止.*重新配置并保存后手动启动/);
    if (reason === 'corrupt') assert(f.node('config-message').textContent.includes(f.env.recovery.a.backupFile));
    assert.match(f.node('config-state').textContent, /请重新配置保存/);
    f.message(''); f.compatibilityMessage({ compatibility: null });
    assert.equal(f.node('config-message').hidden, false); assert.equal(f.node('config-message').dataset.kind, 'error');
    f.set('factory.keepStock', 123);
    assert.match(f.node('config-message').textContent, /自动挂机已停止/);
    const recoveryToken = f.editor.data.recoveryToken;
    await f.tick(600);
    assert.equal(f.posts().length, 1); assert.equal(f.editor.data.recovery, undefined);
    assert.equal(f.posts()[0].payload.recoveryToken, recoveryToken); assert.equal(f.editor.data.recoveryToken, null);
    assert.equal(f.node('config-message').hidden, true);
    assert.equal(f.view('a').settings.factory.enabled, false);
    assert(f.env.calls.every(call => ['/api/settings', '/api/settings?fleets=1', '/api/loop'].includes(call.route)), '保存不会调用启动接口');
  }
});

await test('无未保存草稿时发现配置恢复，直接显示关闭的默认配置', async () => {
  const f = fixture(), old = f.view('a'); old.settings.factory.enabled = true;
  saveAutomationSettings('a', old.settings, { file: f.file, revision: old.revision }); await f.load();
  saveAutomationSettings('a', defaultSettings(), { file: f.file, revision: f.view('a').revision });
  f.env.recovery.a = { required: true, reason: 'missing', message: '重新配置' };
  await f.load();
  assert.equal(f.editor.draft.factory.enabled, false); assert.equal(f.editor.recoveryBlocked, false);
  assert.equal(f.editor.data.revision, f.view('a').revision); assert.equal(f.posts().length, 0);
  const g = fixture(); await g.load();
  g.env.recovery.a = { required: true, reason: 'missing' }; await g.load();
  assert.equal(g.editor.recoveryBlocked, false, '旧值恰好也是默认值时不强迫丢弃草稿');
  assert.match(g.node('config-state').textContent, /请重新配置保存/);
});

await test('配置恢复保留旧草稿但冻结自动保存，确认重新载入后才能保存新配置', async () => {
  const f = fixture(); await f.load(); f.set('factory.enabled', true);
  const old = structuredClone(f.editor.draft);
  saveAutomationSettings('a', defaultSettings(), { file: f.file, revision: f.view('a').revision });
  f.env.recovery.a = { required: true, reason: 'corrupt', message: '重新配置', backupFile: 'C:\\备份\\损坏.json' };
  await f.load();
  assert.deepEqual(f.editor.draft, old); assert.equal(f.editor.recoveryBlocked, true);
  assert.equal(f.editor.data.recoveryToken, f.view('a').recoveryToken);
  assert.match(f.node('config-message').textContent, /未生效的旧草稿.*自动保存已暂停/);
  assert.match(f.node('config-state').textContent, /旧草稿未生效/);
  assert.equal(f.editor.recoveryReloadButton.disabled, false);
  await f.tick(10000); assert.equal(f.posts().length, 0);
  f.set('factory.keepStock', 456); await f.tick(10000);
  assert.equal(await f.save(), false); assert.equal(await f.flush(), false); assert.equal(f.posts().length, 0);
  await f.load(); assert.equal(f.editor.recoveryBlocked, true, '再次读取同一恢复状态不解除保护');
  await f.reload(); assert.equal(f.env.confirmations, 1); assert.equal(f.editor.draft.factory.keepStock, 456);
  f.env.confirmResult = true; await f.reload();
  assert.equal(f.env.confirmations, 2); assert.equal(f.editor.recoveryBlocked, false); assert.deepEqual(f.editor.draft, defaultSettings());
  assert.match(f.node('config-message').textContent, /自动挂机已停止/);
  assert.doesNotMatch(f.node('config-message').textContent, /未生效的旧草稿/);
  const recoveryToken = f.editor.data.recoveryToken;
  f.set('factory.keepStock', 789); await f.tick(600);
  assert.equal(f.posts().length, 1); assert.equal(f.view('a').settings.factory.keepStock, 789);
  assert.equal(f.posts()[0].payload.recoveryToken, recoveryToken); assert.equal(f.editor.data.recoveryToken, null);
  assert.equal(f.view('a').settings.factory.enabled, false); assert.equal(f.node('config-message').hidden, true);
});

await test('恢复重载期间继续编辑保留草稿和保护，切换账号不沿用恢复警告', async () => {
  const f = fixture(); await f.load(); f.set('factory.keepStock', 123);
  f.env.recovery.a = { required: true, reason: 'missing' }; await f.load();
  f.env.confirmResult = true;
  const reading = deferred(); f.env.onGet = () => reading.promise;
  const reload = f.reload(); await settle(); f.set('factory.keepStock', 456);
  reading.resolve(); await reload;
  assert.equal(f.editor.draft.factory.keepStock, 456); assert.equal(f.editor.recoveryBlocked, true);
  await f.tick(2000); assert.equal(f.posts().length, 0);
  f.env.onGet = null; f.change('b'); await f.load();
  assert.equal(f.editor.recoveryBlocked, false); assert.equal(f.node('config-message').hidden, true);
  f.set('factory.keepStock', 789); await f.tick(600); assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].account, 'b');
});

await test('恢复标识变化仍冻结草稿，相同配置版本的旧页面不能确认恢复', async () => {
  const f = fixture(); await f.load(); f.set('factory.enabled', true);
  f.env.recovery.a = { required: true, reason: 'missing' };
  await f.tick(600);
  assert.equal(f.posts()[0].payload.recoveryToken, null);
  assert(f.editor.saveError.fields.revision); assert.equal(f.view('a').settings.factory.enabled, false);
  await f.load(); assert.equal(f.editor.recoveryBlocked, true); assert.equal(f.editor.data.recoveryToken, f.view('a').recoveryToken);
  f.env.confirmResult = true; await f.reload(); f.set('factory.keepStock', 123);
  const priorToken = f.editor.data.recoveryToken;
  saveAutomationSettings('a', defaultSettings(), { file: f.file, revision: f.view('a').revision });
  await f.load();
  assert.notEqual(f.editor.data.recoveryToken, priorToken); assert.equal(f.editor.recoveryBlocked, true);
  assert.equal(f.editor.draft.factory.keepStock, 123, '同一恢复原因的新事件仍保留旧草稿');
  await f.tick(600); assert.equal(f.posts().length, 1, '已获取新标识也不能绕过明确重载');
});

await test('不兼容版本或权限失败保留原文件，页面不声称已恢复默认配置', async () => {
  const f = fixture();
  const message = '配置版本高于当前程序；自动挂机已停止，原文件未覆盖，请使用兼容版本后重新配置。';
  f.env.recovery.a = { required: true, reason: 'unavailable', message }; await f.load();
  assert(f.node('config-message').textContent.startsWith(message));
  assert.doesNotMatch(f.node('config-message').textContent, /已恢复.*默认/);
  assert.match(f.node('config-state').textContent, /配置暂不可用/);
  f.set('factory.keepStock', 123); await f.tick(3000);
  assert.equal(f.posts().length, 0); assert.equal(await f.flush(), false);
  f.compatibilityMessage({ compatibility: null }); assert(f.node('config-message').textContent.startsWith(message));
});

await test('运行状态轮询发现恢复时立即冻结已打开设置页的旧草稿，只读取一次新状态', async () => {
  const f = fixture(); await f.load(); f.node('tab-settings').classList.contains = () => false;
  f.set('factory.enabled', true);
  saveAutomationSettings('a', defaultSettings(), { file: f.file, revision: f.view('a').revision });
  f.env.recovery.a = { required: true, reason: 'missing' };
  const runtime = () => ({ settingsRecovery: f.env.recovery.a, settingsRevision: f.view('a').revision, everyMs: 60000, completed: 0, running: false });
  const reads = () => f.env.calls.filter(call => call.route === '/api/settings?fleets=1').length;
  const initialReads = reads(), pending = deferred(); f.env.onGet = () => pending.promise;
  f.renderLoop(runtime());
  assert.equal(f.editor.recoveryBlocked, true); assert.match(f.node('loop-hint').textContent, /配置丢失.*重新配置/);
  assert.match(f.node('config-message').textContent, /旧草稿.*自动保存已暂停/);
  await f.tick(3000); assert.equal(f.posts().length, 0, '读取未完成也必须先取消旧定时保存');
  f.renderLoop(runtime()); assert.equal(reads(), initialReads + 1, '轮询不能并发重复读取');
  pending.resolve(); await settle();
  assert.equal(f.editor.draft.factory.enabled, true); assert.equal(f.editor.recoveryBlocked, true);
  assert.notEqual(f.editor.data.revision, runtime().settingsRevision, '保留旧草稿版本，不替它领取新版本');
  f.renderLoop(runtime()); await settle(); f.renderLoop(runtime()); await settle();
  assert.equal(reads(), initialReads + 1, '已核对恢复状态不因旧草稿版本不同而反复读取');
  f.env.onGet = null;
  saveAutomationSettings('a', defaultSettings(), { file: f.file, revision: f.view('a').revision });
  f.renderLoop(runtime()); await settle(); assert.equal(reads(), initialReads + 2, '新的恢复版本仍需重新核对');
  f.env.recovery.a = { ...f.env.recovery.a, id: 'another-recovery' };
  f.renderLoop(runtime()); await settle(); assert.equal(reads(), initialReads + 3, '同版本的新恢复事件由独立标识区分');
  assert.equal(f.posts().length, 0);
});

await test('恢复同步读取失败可在下次轮询重试，隐藏设置页仅显示页头警告', async () => {
  const f = fixture(); await f.load(); f.node('tab-settings').classList.contains = () => false;
  f.set('factory.keepStock', 123); f.env.recovery.a = { required: true, reason: 'corrupt', backupFile: 'C:\\很长的备份目录\\'.repeat(20) + '损坏.json' };
  const runtime = { settingsRecovery: f.env.recovery.a, settingsRevision: f.view('a').revision, everyMs: 60000, completed: 0, running: false };
  f.env.onGet = () => { throw new Error('临时读取失败'); }; f.renderLoop(runtime); await settle();
  assert.equal(f.editor.recoveryBlocked, true); assert.match(f.node('config-message').textContent, /临时读取失败/);
  f.env.onGet = null; f.renderLoop(runtime); await settle();
  assert.equal(f.editor.data.recovery.reason, 'corrupt'); assert.equal(f.editor.recoverySync.complete, true);
  assert(f.node('config-message').textContent.includes(f.env.recovery.a.backupFile));
  assert(!f.node('loop-hint').textContent.includes(f.env.recovery.a.backupFile), '页头只保留短警告，备份详情留在配置页');
  const g = fixture(); await g.load(); const reads = g.env.calls.length;
  g.renderLoop(runtime); await settle();
  assert.equal(g.env.calls.length, reads, '设置页隐藏时不额外读取');
  assert.match(g.node('loop-hint').textContent, /配置损坏.*自动挂机已停止/);
});

await test('页头间隔保存同步配置版本，后续草稿保存保留新间隔', async () => {
  const f = fixture();
  await f.load();
  const prior = f.editor.data.revision;
  const next = structuredClone(f.view('a').settings);
  next.loop.everySeconds = 123;
  const saved = saveAutomationSettings('a', next, { file: f.file, revision: prior });
  f.intervalSaved('a', 123, prior, saved.revision);
  assert.equal(f.editor.data.revision, saved.revision);
  assert.equal(f.editor.data.settings.loop.everySeconds, 123);
  assert.equal(f.editor.baseline.loop.everySeconds, 123);
  assert.equal(f.editor.draft.loop.everySeconds, 123);
  assert.equal(f.dirty(), false);
  f.set('factory.keepStock', 124);
  await f.tick(600);
  assert.equal(f.view('a').settings.loop.everySeconds, 123);
  assert.equal(f.view('a').settings.factory.keepStock, 124);
  assert.equal(f.editor.saveError, null);
});

await test('旧版本和旧账号间隔响应不覆盖当前配置草稿', async () => {
  const f = fixture();
  await f.load();
  const before = structuredClone(f.editor.data);
  f.intervalSaved('b', 180, before.revision, before.revision + 1);
  assert.deepEqual(f.editor.data, before);
  f.intervalSaved('a', 180, before.revision - 1, before.revision);
  assert.deepEqual(f.editor.data, before);
  f.set('factory.keepStock', 200);
  f.intervalSaved('a', 180, before.revision, before.revision + 1);
  assert.equal(f.editor.draft.factory.keepStock, 200);
  assert.equal(f.editor.draft.loop.everySeconds, 180);
  assert.equal(f.dirty(), true);
});

await test('间隔提交期间的新草稿等待响应再按新版本保存', async () => {
  const f = fixture(), gate = deferred();
  await f.load();
  const prior = f.editor.data.revision;
  const next = structuredClone(f.view('a').settings);
  next.loop.everySeconds = 137;
  const saved = saveAutomationSettings('a', next, { file: f.file, revision: prior });
  f.intervalSaves.set('a', { writing: true, promise: gate.promise });
  f.set('factory.keepStock', 138);
  await f.tick(600);
  const flushing = f.flush();
  await settle();
  assert.equal(f.posts().length, 0);
  f.intervalSaved('a', 137, prior, saved.revision);
  f.intervalSaves.delete('a');
  gate.resolve(true);
  assert.equal(await flushing, true);
  assert.equal(f.posts().length, 1);
  assert.equal(f.posts()[0].payload.revision, saved.revision);
  assert.equal(f.view('a').settings.loop.everySeconds, 137);
  assert.equal(f.view('a').settings.factory.keepStock, 138);
  assert.equal(f.editor.saveError, null);
});

await test('间隔提交前的草稿保存继续执行，避免相互等待', async () => {
  const f = fixture(), gate = deferred();
  await f.load();
  f.intervalSaves.set('a', { writing: false, promise: gate.promise });
  f.set('factory.keepStock', 139);
  assert.equal(await f.flush(), true);
  assert.equal(f.view('a').settings.factory.keepStock, 139);
  f.intervalSaves.delete('a');
  gate.resolve(true);
});

await test('草稿无修改时任务操作仍等待间隔保存并使用新版本', async () => {
  const f = fixture(), gate = deferred();
  await f.load();
  const prior = f.editor.data.revision;
  f.intervalSaves.set('a', { writing: true, promise: gate.promise });
  let commandRevision = null;
  const command = f.flush().then(ready => { if (ready) commandRevision = f.revision(); return ready; });
  await settle();
  assert.equal(commandRevision, null);
  assert.equal(f.posts().length, 0);
  f.intervalSaved('a', 141, prior, prior + 1);
  f.setLoopRevision(prior + 1);
  f.intervalSaves.delete('a');
  gate.resolve(true);
  assert.equal(await command, true);
  assert.equal(commandRevision, prior + 1);
  assert.equal(f.posts().length, 0);
});

await test('等待间隔期间切号或间隔保存失败会阻止后续任务操作', async () => {
  for (const outcome of ['switched', 'failed']) {
    const f = fixture(), gate = deferred();
    await f.load();
    f.intervalSaves.set('a', { writing: true, promise: gate.promise });
    const flushing = f.flush();
    await settle();
    if (outcome === 'switched') { f.change('b'); await f.load(); }
    f.intervalSaves.delete('a');
    gate.resolve(outcome !== 'failed');
    assert.equal(await flushing, false);
    assert.equal(f.posts().length, 0);
  }
});

await test('等待间隔响应期间切号或重新载入会取消旧草稿提交', async () => {
  for (const change of ['account', 'reload']) {
    const f = fixture(), gate = deferred();
    await f.load();
    f.intervalSaves.set('a', { writing: true, promise: gate.promise });
    f.set('factory.keepStock', 140);
    const saving = f.save();
    if (change === 'account') { f.change('b'); await f.load(); }
    else await f.load(true);
    f.intervalSaves.delete('a');
    gate.resolve(true);
    assert.equal(await saving, false);
    assert.equal(f.posts().length, 0);
  }
});

await test('打开配置不写盘，连续输入只保存最终值并更新版本提示', async () => {
  const f = fixture(); await f.load(); await f.tick(1000);
  assert.equal(f.posts().length, 0);
  f.set('factory.keepStock', 10); await f.tick(400);
  f.set('factory.keepStock', 125); await f.tick(599);
  assert.equal(f.posts().length, 0);
  await f.tick(1);
  assert.equal(f.posts().length, 1); assert.equal(f.view('a').settings.factory.keepStock, 125);
  assert.equal(f.revision(), 2); assert(!f.dirty());
  assert.match(f.node('config-state').textContent, /配置已同步/);
  assert.equal(f.node('config-retry').hidden, true);
});

await test('连续自动保存只更新常驻状态，不显示成功横幅或重绘编辑区', async () => {
  const f = fixture(); await f.load(); const renders = f.env.renders;
  for (const value of [71, 72]) {
    const gate = deferred(); f.env.onPost = () => gate.promise;
    f.set('factory.keepStock', value);
    assert.equal(f.node('config-message').hidden, true);
    await f.tick(600);
    assert.match(f.node('config-state').textContent, /正在自动保存/);
    assert.equal(f.node('config-message').hidden, true);
    f.env.onPost = null; gate.resolve(); await settle();
    assert.match(f.node('config-state').textContent, /配置已同步/);
    assert.equal(f.node('config-message').hidden, true);
    assert.equal(f.view('a').settings.factory.keepStock, value);
  }
  assert.equal(f.env.renders, renders); assert.equal(f.env.focuses, 0);
});

await test('保存规范化补齐舰队任务后重绘一次，草稿与已保存配置同步', async () => {
  const f = fixture(); await f.load(); const renders = f.env.renders;
  const priority = f.editor.draft.fleetDispatch.priority.filter(key => !['worldBoss', 'follow'].includes(key));
  f.set('fleetDispatch.priority', priority);
  assert.equal(await f.save(null, { automatic: true }), true);
  const saved = f.view('a').settings;
  assert.deepEqual(f.posts()[0].payload.settings.fleetDispatch.priority, priority);
  assert(saved.fleetDispatch.priority.includes('worldBoss'));
  assert(saved.fleetDispatch.priority.includes('follow'));
  assert.deepEqual(f.editor.draft, saved); assert.deepEqual(f.editor.baseline, saved);
  assert.equal(f.env.renders, renders + 1); assert.equal(f.env.focuses, 0);
  assert.equal(f.editor.saveError, null); assert.deepEqual(f.editor.errors, {}); assert(!f.dirty());
  assert.equal(f.node('config-message').hidden, true);
  assert.match(f.node('config-state').textContent, /配置已同步/);
  await f.tick(10000);
  assert.equal(f.posts().length, 1); assert.equal(f.env.renders, renders + 1);
});

await test('多选、顺序、开关和互斥联动一起自动保存', async () => {
  const f = fixture(); await f.load();
  f.set('treasure.followNames', ['甲', '乙']);
  f.set('factory.demandPriority', [...f.editor.draft.factory.demandPriority].reverse());
  f.set('farm.customPlant', true); f.set('farm.crops', [{ id: '小麦', target: 12 }]);
  await f.tick(600);
  assert.equal(f.posts().length, 1);
  assert.deepEqual(f.view('a').settings, validateSettings(f.editor.draft));
  assert.equal(f.view('a').settings.farm.autoPlant, false);
});

await test('在途保存期间继续编辑，串行保存后一批而不覆盖输入', async () => {
  const f = fixture(); await f.load(); const gate = deferred(); f.env.onPost = () => gate.promise;
  f.set('factory.keepStock', 80); await f.tick(600);
  assert(f.editor.saving); assert.match(f.node('config-state').textContent, /正在自动保存/);
  f.set('factory.keepStock', 90); await f.tick(600);
  assert.equal(f.posts().length, 1);
  f.env.onPost = null; gate.resolve(); await settle();
  assert.equal(f.editor.draft.factory.keepStock, 90); assert(f.dirty());
  assert.equal(f.node('config-message').hidden, true);
  assert.match(f.node('config-state').textContent, /等待自动保存/);
  await f.tick(600);
  assert.equal(f.posts().length, 2); assert.equal(f.env.maxInFlight, 1);
  assert.equal(f.posts()[1].payload.revision, 2); assert.equal(f.view('a').settings.factory.keepStock, 90);
  assert.equal(f.node('config-message').hidden, true);
});

await test('在途保存时改回原值，仍把用户最后的值持久化', async () => {
  const f = fixture(); await f.load(); const original = f.editor.draft.factory.keepStock;
  const gate = deferred(); f.env.onPost = () => gate.promise;
  f.set('factory.keepStock', original + 1); await f.tick(600);
  f.set('factory.keepStock', original); assert(!f.dirty());
  f.env.onPost = null; gate.resolve(); await settle(); await f.tick(600);
  assert.equal(f.posts().length, 2); assert.equal(f.view('a').settings.factory.keepStock, original); assert(!f.dirty());
});

await test('数字输入为空时不提交、不抢焦点，补齐后自动保存', async () => {
  const f = fixture(); await f.load();
  const input = { checkValidity: () => Number.isInteger(f.editor.draft.ads.waitSeconds) && f.editor.draft.ads.waitSeconds >= 5,
    focus() { f.env.focuses++; }, reportValidity() { f.env.focuses++; } };
  f.editor.widgets.set('ads.waitSeconds', { row: { querySelectorAll: () => [input] }, control: { setAttribute() {} }, error: {}, clearError() {} });
  f.set('ads.waitSeconds', null); await f.tick(10000);
  assert.equal(f.posts().length, 0); assert.equal(f.env.focuses, 0); assert(f.dirty());
  f.set('ads.waitSeconds', 21); await f.tick(600);
  assert.equal(f.view('a').settings.ads.waitSeconds, 21); assert(!f.dirty());
});

await test('跨字段校验失败不会循环提交，修正后自动重试', async () => {
  const f = fixture(); await f.load();
  f.set('treasure.autoJoin', true);
  f.set('treasure.enabled', true); await f.tick(10000);
  assert.equal(f.posts().length, 1); assert.match(f.node('config-state').textContent, /请修正/);
  assert.equal(f.env.focuses, 0); assert.equal(f.view('a').settings.treasure.enabled, false);
  f.set('treasure.fleetIds', ['1远征船']); await f.tick(600);
  assert.equal(f.posts().length, 2); assert.equal(f.view('a').settings.treasure.enabled, true); assert(!f.dirty());
});

function followValidationView(f) {
  const key = 'treasure.followNames', attributes = new Map(), error = { hidden: true };
  let scrolls = 0;
  const control = { setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
    focus() { f.env.focuses++; } };
  f.editor.widgets.set(key, { row: { querySelectorAll: () => [], scrollIntoView() { scrolls++; } }, control, error,
    clearError() { error.hidden = true; control.removeAttribute('aria-invalid'); } });
  f.node('config-message').scrollIntoView = () => { scrolls++; };
  return {
    visible(label) {
      assert(f.editor.errors[key], label + '：跟随名单错误仍保留');
      assert.equal(error.hidden, false, label + '：字段提示持续显示');
      assert.equal(attributes.get('aria-invalid'), 'true', label);
      assert.equal(f.node('config-message').hidden, false, label + '：顶部错误提示持续显示');
      assert.equal(f.node('config-message').dataset.kind, 'error', label);
      assert.equal(f.env.focuses, 0, label + '：不抢焦点');
      assert.equal(scrolls, 0, label + '：不滚动页面');
    },
    cleared() {
      assert.deepEqual(f.editor.errors, {});
      assert.equal(error.hidden, true);
      assert.equal(attributes.has('aria-invalid'), false);
      assert.equal(f.node('config-message').hidden, true);
      assert.equal(f.env.focuses, 0);
      assert.equal(scrolls, 0);
    },
  };
}

await test('跟随名单仍为空时，连续修改其他配置及等待失败响应都不闪烁错误提示', async () => {
  const f = fixture(); await f.load(); const ui = followValidationView(f), renders = f.env.renders;
  f.set('treasure.follow', true); await f.tick(600); ui.visible('首次校验失败');
  const message = f.node('config-message').textContent;
  for (const [key, value] of [['treasure.repeatAttack', true], ['treasure.followMode', 'eachTime'],
    ['factory.keepStock', 61], ['treasure.qualities', ['ORANGE']]]) {
    const gate = deferred(); f.env.beforePost = () => gate.promise;
    const priorPosts = f.posts().length;
    f.set(key, value); ui.visible(key + ' 编辑后');
    f.compatibilityMessage(f.editor.data); ui.visible(key + ' 后台状态刷新后');
    if (key === 'treasure.repeatAttack') {
      const poll = deferred(); f.env.onGet = () => poll.promise;
      const loading = f.load(); ui.visible('保留草稿的后台配置读取中');
      f.env.onGet = null; poll.resolve(); await loading; ui.visible('后台配置读取完成');
    }
    await f.tick(599); ui.visible(key + ' 等待自动保存');
    assert.equal(f.posts().length, priorPosts);
    await f.tick(1); assert(f.editor.saving); ui.visible(key + ' 请求进行中');
    assert.equal(f.posts().length, priorPosts + 1);
    assert.equal(f.node('config-message').textContent, message);
    f.env.beforePost = null; gate.resolve(); await settle(); ui.visible(key + ' 再次校验失败');
  }
  assert.equal(f.env.renders, renders);
  assert.equal(f.view('a').settings.treasure.follow, false, '无效草稿不落盘');
  await f.tick(10000); assert.equal(f.posts().length, 5, '失败后等待输入，不循环请求');
});

await test('在失败请求中补齐昵称、角色ID或关闭跟随后，旧错误保留至新校验成功且不阻塞保存', async () => {
  for (const [key, value] of [['treasure.followNames', ['海上的风']], ['treasure.followPlayerIds', ['9007199254740999']], ['treasure.follow', false]]) {
    const f = fixture(); await f.load(); const ui = followValidationView(f);
    f.set('treasure.follow', true); await f.tick(600); ui.visible('首次校验失败');
    const failed = deferred(); f.env.beforePost = () => failed.promise;
    f.set('factory.keepStock', 62); await f.tick(600); assert(f.editor.saving); ui.visible('旧草稿校验进行中');
    f.set(key, value); assert(f.dirty(), '保留其他修改，不能通过还原基线绕过验证');
    ui.visible('修正后等待响应');
    const corrected = deferred(); f.env.beforePost = () => corrected.promise;
    failed.resolve(); await settle();
    assert.equal(f.editor.saveError, null, '迟到的旧草稿失败不能阻止新草稿自动保存');
    ui.visible('忽略旧失败结果');
    await f.tick(600); assert(f.editor.saving); ui.visible('新草稿校验进行中');
    assert.equal(f.posts().length, 3);
    f.env.beforePost = null; corrected.resolve(); await settle();
    assert(!f.dirty()); ui.cleared();
    assert.equal(f.editor.saveError, null);
    assert.deepEqual(f.view('a').settings, validateSettings(f.editor.draft));
    await f.tick(10000); assert.equal(f.posts().length, 3);
  }
});

await test('旧有效草稿保存成功时，仍有错误的新草稿保持提示直至重新校验或还原已保存值', async () => {
  const f = fixture(); await f.load(); const ui = followValidationView(f);
  f.set('treasure.follow', true); await f.tick(600); ui.visible('首次校验失败');
  const valid = deferred(); f.env.onPost = () => valid.promise;
  f.set('treasure.followNames', ['海上的风']); await f.tick(600);
  assert(f.editor.saving); assert.deepEqual(f.view('a').settings.treasure.followNames, ['海上的风']);
  ui.visible('有效草稿等待保存响应');
  f.set('treasure.followNames', []); ui.visible('等待期间再次清空名单');
  const invalid = deferred(); f.env.beforePost = () => invalid.promise;
  f.env.onPost = null; valid.resolve(); await settle();
  assert(f.dirty()); ui.visible('较早的成功响应不能清除当前错误');
  f.compatibilityMessage(f.editor.data); ui.visible('成功响应后的后台状态刷新');
  await f.tick(600); assert(f.editor.saving); ui.visible('最新无效草稿等待校验');
  assert.equal(f.posts().length, 3);
  f.env.beforePost = null; invalid.resolve(); await settle(); ui.visible('最新草稿校验失败');
  f.set('treasure.followNames', ['海上的风']);
  assert(!f.dirty(), '恢复为服务器最新保存的基线'); ui.cleared();
  await f.tick(10000); assert.equal(f.posts().length, 3, '恢复基线无需另发请求');
});

const conditionalCases = [
  ['进攻目标来源', {'cityWar.fleetIds':['1远征船'],'cityWar.enabled':true}, 'cityWar.targetMode', 'selected', 'cityWar.cityRefs'],
  ['防守目标来源', {'cityWar.fleetIds':['1远征船'],'cityWar.defenceFleetIds':['1远征船'],'cityWar.enabled':true}, 'cityWar.defenceTargetMode', 'selected', 'cityWar.defenceCityRefs'],
  ['巨轮跟随', {}, 'treasure.follow', true, 'treasure.followNames'],
  ['巨轮兜底', {'treasure.fallbackQualities':[]}, 'treasure.fallbackEnabled', true, 'treasure.fallbackQualities'],
  ['自定义种植', {'farm.autoPlant':false}, 'farm.customPlant', true, 'farm.crops'],
  ['海兽放生', {'pet.releaseQualities':[]}, 'pet.release', true, 'pet.releaseQualities'],
  ['装备分解', {'forge.decomposeQualities':[]}, 'forge.decompose', true, 'forge.decomposeQualities'],
  ['藏品激活', {'antique.activate':false,'antique.activateQualities':[]}, 'antique.activate', true, 'antique.activateQualities'],
  ['藏品升星', {'antique.star':false,'antique.starQualities':[]}, 'antique.star', true, 'antique.starQualities'],
  ['藏品套装', {'antique.suit':false,'antique.suitQualities':[]}, 'antique.suit', true, 'antique.suitQualities'],
  ['试炼副本', {'progression.raidIds':[]}, 'progression.trials', true, 'progression.raidIds'],
  ['海盗舰队', {}, 'pirateHunt.enabled', true, 'pirateHunt.fleetIds'],
  ['巨轮舰队', {'treasure.autoJoin':true}, 'treasure.enabled', true, 'treasure.fleetIds'],
  ['城战舰队', {}, 'cityWar.enabled', true, 'cityWar.fleetIds'],
  ['锻造配方', {}, 'forge.enabled', true, 'forge.recipeIds'],
];
await test('15类条件配置切换后改回已保存值，立即清除过期错误且不重复提交', async () => {
  for (const [label,prepare,key,invalid,errorKey] of conditionalCases) {
    const f=fixture();await f.load();
    for(const [field,value] of Object.entries(prepare))f.set(field,value);
    assert.equal(await f.flush(),true,label+' 初始配置有效');
    const initial=structuredClone(f.editor.draft),original=key.split('.').reduce((value,part)=>value[part],initial);
    const attributes=new Map(),error={hidden:true},control={setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k)};
    f.editor.widgets.set(errorKey,{row:{querySelectorAll:()=>[],scrollIntoView(){}},control,error,
      clearError(){error.hidden=true;control.removeAttribute('aria-invalid');}});
    f.set(key,invalid);await f.tick(600);
    assert(f.editor.errors[errorKey],label+' 应提示缺少必要配置');assert.equal(error.hidden,false,label);
    const submitted=f.posts().length;
    f.set(key,original);
    assert.deepEqual(f.editor.draft,initial,label+' 回到原草稿');assert.equal(f.dirty(),false,label);
    assert.deepEqual(f.editor.errors,{},label+' 不残留前一模式错误');assert.equal(error.hidden,true,label);
    assert.equal(attributes.has('aria-invalid'),false,label);assert.equal(f.node('config-message').hidden,true,label);
    await f.tick(10000);assert.equal(f.posts().length,submitted,label+' 无需再次保存原值');
  }
});

await test('切回原目标来源后迟到的失败响应不能恢复旧错误', async () => {
  const f=fixture();await f.load();f.set('cityWar.fleetIds',['1远征船']);f.set('cityWar.enabled',true);assert(await f.flush());
  const gate=deferred();f.env.beforePost=()=>gate.promise;
  f.set('cityWar.targetMode','selected');await f.tick(600);assert(f.editor.saving);
  f.set('cityWar.targetMode','alliance');assert(!f.dirty());
  f.env.beforePost=null;gate.resolve();await settle();await f.tick(1000);
  assert.deepEqual(f.editor.errors,{});assert.equal(f.editor.saveError,null);assert.equal(f.node('config-message').hidden,true);
  assert.equal(f.view('a').settings.cityWar.targetMode,'alliance');
});

await test('网络失败有界退避重试，恢复后自动保存', async () => {
  const f = fixture(); await f.load(); f.env.failPosts = 3;
  f.set('factory.keepStock', 91); await f.tick(8000);
  assert.equal(f.posts().length, 4); assert.equal(f.view('a').settings.factory.keepStock, 91); assert(!f.dirty());
});

await test('持续失败保留更改并显示重试入口，不误报已保存', async () => {
  const f = fixture(); await f.load(); f.env.failPosts = 10;
  f.set('factory.keepStock', 92); await f.tick(60000);
  assert.equal(f.posts().length, 4); assert(f.dirty()); assert.equal(f.node('config-retry').hidden, false);
  assert.match(f.node('config-state').textContent, /自动保存失败/);
  assert.equal(f.node('config-message').hidden, false); assert.equal(f.node('config-message').dataset.kind, 'error');
  f.env.failPosts = 0; await f.save();
  assert.equal(f.view('a').settings.factory.keepStock, 92); assert(!f.dirty());
});

await test('多页面版本冲突保留本地修改，不自动覆盖另一页的配置', async () => {
  const f = fixture(); await f.load();
  const external = f.view('a'); external.settings.factory.keepStock = 123;
  saveAutomationSettings('a', external.settings, { file: f.file, revision: external.revision });
  f.set('ads.waitSeconds', 22); await f.tick(10000);
  assert.equal(f.posts().length, 1); assert.match(f.node('config-state').textContent, /冲突/);
  assert.equal(f.node('config-message').hidden, false); assert.equal(f.node('config-message').dataset.kind, 'error');
  f.set('ads.waitSeconds', 23); await f.tick(10000);
  assert.equal(f.posts().length, 1); assert.equal(await f.flush(), false);
  assert.equal(f.editor.data.revision, 1); assert.equal(f.view('a').settings.factory.keepStock, 123);
  await f.load(true); assert(!f.dirty()); assert.equal(f.editor.saveError, null);
});

await test('开始任务前立即保存待提交内容，并等待在途修改全部完成', async () => {
  const f = fixture(); await f.load(); const gate = deferred(); f.env.onPost = () => gate.promise;
  f.set('factory.keepStock', 101);
  const flushed = f.flush(); await settle();
  assert.equal(f.posts().length, 1);
  f.set('factory.keepStock', 102); f.env.onPost = null; gate.resolve();
  assert.equal(await flushed, true);
  assert.equal(f.view('a').settings.factory.keepStock, 102); assert.equal(f.posts().length, 2);
  await f.tick(10000); assert.equal(f.posts().length, 2);
});

await test('切换账号先自动保存，无须确认；定时器不会写到新账号', async () => {
  const f = fixture(); await f.load(); f.set('factory.keepStock', 103);
  assert.equal(await f.mayChange('b'), true); assert.equal(f.env.confirmations, 0);
  f.change('b'); await f.load(); await f.tick(10000);
  assert.equal(f.view('a').settings.factory.keepStock, 103);
  assert.equal(f.view('b').settings.factory.keepStock, 50);
  assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].account, 'a');
});

await test('账号被外部移除或切换后，旧请求回复不污染新账号', async () => {
  const f = fixture(); await f.load(); const gate = deferred(); f.env.onPost = () => gate.promise;
  f.set('factory.keepStock', 104); await f.tick(600);
  f.change('b'); await f.load();
  f.env.onPost = null; gate.resolve(); await settle(); await f.tick(10000);
  assert.equal(f.editor.owner, 'b'); assert.equal(f.editor.data.revision, 1);
  assert.equal(f.editor.draft.factory.keepStock, 50); assert.equal(f.posts().length, 1);
});

await test('重新载入取消尚未提交的修改，载入期间新输入不会丢失', async () => {
  const f = fixture(); await f.load(); f.set('factory.keepStock', 105);
  await f.load(true); await f.tick(10000);
  assert.equal(f.posts().length, 0); assert.equal(f.editor.draft.factory.keepStock, 50);
  const gate = deferred(); f.env.onGet = () => gate.promise;
  const pending = f.load(true); f.set('factory.keepStock', 106); await f.tick(600);
  f.env.onGet = null; gate.resolve(); await pending; await f.tick(600);
  assert.equal(f.view('a').settings.factory.keepStock, 106);
});

await test('导入校验通过后自动保存，不需要额外点击按钮', async () => {
  const f = fixture(); await f.load(); const settings = defaultSettings(); settings.ads.waitSeconds = 24;
  const document = JSON.stringify(exportAutomationSettings(settings));
  await f.importFile({ target: { value: 'fixture.json', files: [{ size: document.length, text: async () => document }] } });
  await f.tick(600);
  assert.equal(f.posts().length, 1); assert.equal(f.view('a').settings.ads.waitSeconds, 24); assert(!f.dirty());
});

await test('草稿导出使用后端当前版本且不提前保存用户修改', async () => {
  const f = fixture(); await f.load(); f.set('factory.keepStock', 129);
  await f.exportFile();
  assert.equal(f.env.downloads.length, 1);
  const document = JSON.parse(await f.env.downloads[0].text());
  assert.equal(document.version, SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(document), ['format', 'version', 'settings']);
  assert.equal(document.settings.factory.keepStock, 129);
  assert.equal(importAutomationSettings(document).factory.keepStock, 129);
  assert.equal(f.posts().length, 0);
  assert.equal(f.view('a').settings.factory.keepStock, 50);
});

await test('三支硅矿舰队独立编辑自动保存，刷新和切号保留各自字段', async () => {
  const f = fixture(); await f.load();
  f.set('silicon.fleets.0.enabled', true); f.set('silicon.fleets.0.tier', 'PURPLE');
  f.set('silicon.fleets.1.safePlayers', ['甲']); f.set('silicon.fleets.2.dailyAttackLimit', 7);
  f.set('guildShip.redStartTime', '21:30'); await f.tick(600);
  assert.equal(f.posts().length, 1); assert(Array.isArray(f.view('a').settings.silicon.fleets));
  await f.load(true);
  assert.equal(f.editor.draft.silicon.fleets[0].tier, 'PURPLE');
  assert.deepEqual(f.editor.draft.silicon.fleets[1].safePlayers, ['甲']);
  assert.equal(f.editor.draft.silicon.fleets[2].dailyAttackLimit, 7);
  assert.equal(f.editor.draft.guildShip.redStartTime, '21:30');
  assert.equal(f.view('b').settings.silicon.fleets[0].enabled, false);
});

await test('城战逐队职责自动保存，取消参与同时移除防守职责，新队默认进攻', async () => {
  const f = fixture(); await f.load();
  f.set('cityWar.fleetIds', ['1远征船', '2远征船']);
  f.set('cityWar.defenceFleetIds', ['2远征船']); await f.tick(600);
  assert.deepEqual(f.view('a').settings.cityWar.defenceFleetIds, ['2远征船']);
  await f.load(true);
  assert.deepEqual(f.editor.draft.cityWar.defenceFleetIds, ['2远征船']);
  f.set('cityWar.fleetIds', ['1远征船', '3远征船']); await f.tick(600);
  assert.deepEqual(f.view('a').settings.cityWar.fleetIds, ['1远征船', '3远征船']);
  assert.deepEqual(f.view('a').settings.cityWar.defenceFleetIds, []);
  assert.deepEqual(f.view('b').settings.cityWar.fleetIds, []);
  f.set('cityWar.fleetIds', []); await f.tick(600);
  assert.deepEqual(f.view('a').settings.cityWar.defenceFleetIds, []);
});

await test('逐队策略首次编辑继承旧值，独立保存且取消参与、切换职责和账号不丢失', async () => {
  const f = fixture(); await f.load();
  f.set('cityWar.cityRefs', ['1:2']); f.set('cityWar.targetMode', 'selected');
  f.set('cityWar.defenceCityRefs', ['1:3']); f.set('cityWar.fleetIds', ['1远征船', '2远征船']);
  f.set('cityWar.fleetStrategies.1远征船.targetPriority', 'original');
  f.set('cityWar.fleetStrategies.2远征船.targetMode', 'alliance');
  await f.tick(600);
  const policies = f.view('a').settings.cityWar.fleetStrategies;
  assert.deepEqual(policies['1远征船'].cityRefs, ['1:2']);
  assert.deepEqual(policies['1远征船'].defenceCityRefs, ['1:3']);
  assert.equal(policies['1远征船'].targetMode, 'selected');
  assert.equal(policies['1远征船'].targetPriority, 'original');
  assert.equal(policies['2远征船'].targetMode, 'alliance');
  assert.equal(policies['2远征船'].targetPriority, 'fewestAllied');
  f.set('cityWar.fleetStrategies.1远征船.cityRefs', ['1:4']);
  f.set('cityWar.defenceFleetIds', ['1远征船']); f.set('cityWar.fleetIds', ['2远征船']);
  await f.tick(600); await f.load(true);
  assert.deepEqual(f.editor.draft.cityWar.fleetStrategies['1远征船'].cityRefs, ['1:4']);
  assert.deepEqual(f.editor.draft.cityWar.fleetStrategies['2远征船'].cityRefs, ['1:2']);
  assert.deepEqual(f.editor.draft.cityWar.cityRefs, ['1:2']);
  f.set('cityWar.fleetIds', ['1远征船', '2远征船']); await f.tick(600);
  assert.equal(await f.mayChange('b'), true); f.change('b'); await f.load();
  assert.deepEqual(f.editor.draft.cityWar.fleetStrategies, {});
  assert.equal(await f.mayChange('a'), true); f.change('a'); await f.load();
  assert.deepEqual(f.editor.draft.cityWar.fleetStrategies['1远征船'].cityRefs, ['1:4']);
});

await test('城战职责控件逐队切换，参与名单变化即刷新且不改英雄编队', () => {
  const draft = defaultSettings(), catalog = { expeditionFleets: [{ value: '1远征船', label: '远征舰队 1 队' }, { value: '2远征船', label: '远征舰队 2 队' }] };
  draft.cityWar.fleetIds = ['1远征船', '2远征船'];
  const node = (tag, className, textContent = '') => ({ tag, className, textContent, children: [], attributes: {}, dataset: {}, value: '',
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }, focus() {},
    append(...items) { this.children.push(...items); }, setAttribute(key, value) { this.attributes[key] = value; } });
  const clear = root => { root.children = []; return root; };
  const read = newStateFunction('configEditor', section('function configGet(', 'function configClearErrors(') + '\nreturn configGet;')({ draft });
  const writes = [];
  const write = (key, value) => { writes.push(key); draft.cityWar.defenceFleetIds = value; root.refresh(); };
  const render = newStateFunction('el', 'clear', 'configGet', 'configSet', 'configEditor',
    'const cityWarStrategyFields = [], configRenderFields = () => {}, configField = (key,label,kind,options) => ({key,label,kind,...options}), document = { activeElement: null };\n' + section('function configCityWarRoles(', 'function configMultiselect(') + '\nreturn configCityWarRoles;')(node, clear, read, write, { draft, data: { catalog }, errors: {}, widgets: new Map() });
  const root = render({ key: 'cityWar.defenceFleetIds', label: '各舰队城战职责' }, 'roles');
  const selects = () => root.children.filter(branch => !branch.hidden).flatMap(branch => branch.children.flatMap(row => row.children)).filter(child => child.tag === 'select');
  assert.deepEqual(selects().map(select => select.value), ['attack', 'attack']);
  assert.equal(selects()[1].attributes['aria-label'], '远征舰队 2 队城战职责');
  selects()[1].value = 'defence'; selects()[1].onchange();
  assert.deepEqual(draft.cityWar.defenceFleetIds, ['2远征船']);
  assert.deepEqual(selects().map(select => select.value), ['attack', 'defence']);
  selects()[1].value = 'attack'; selects()[1].onchange();
  assert.deepEqual(draft.cityWar.defenceFleetIds, []);
  draft.cityWar.fleetIds = ['2远征船']; root.refresh();
  assert.equal(selects().length, 1); assert.equal(selects()[0].value, 'attack');
  draft.cityWar.fleetIds = []; root.refresh();
  assert.equal(selects().length, 0); assert.match(root.children.find(child => child.tag === 'p').textContent, /先选择城战参与舰队/);
  assert(writes.every(key => key === 'cityWar.defenceFleetIds'));
});

await test('攻守目标控件独立显示、校验和自动保存，刷新及切号保留各自目标', async () => {
  const f = fixture({ catalog: { cityTargets: [
    { value: '1:2', label: '城市甲' }, { value: '1:3', label: '城市乙' }, { value: '1:4', label: '城市丙' },
  ] } });
  await f.load();
  f.set('cityWar.fleetIds', ['1远征船', '2远征船']);
  f.set('cityWar.defenceFleetIds', ['2远征船']);
  f.set('cityWar.enabled', true);
  const node = (tag, className = '', textContent = '') => ({
    tag, className, textContent, childNodes: [], attributes: {}, dataset: {}, value: '', hidden: false,
    classList: { add() {}, remove() {} },
    append(...items) { this.childNodes.push(...items); },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    querySelectorAll() { return []; }, focus() {}, scrollIntoView() {},
  });
  const clear = element => { element.childNodes = []; return element; };
  const renderer = newStateFunction('configEditor', 'configSet', 'el', 'clear', 'makeHelpTip', 'configPlacePanel', `
    const configGet = key => key.split('.').reduce((value, part) => value[part], configEditor.draft);
    ${section('function configUpdateVisibility(', 'function configRender(')}
    ${section('function configRenderField(', 'function configRenderUsage(')}
    ${section('function configMultiselect(', 'function configPriorityEditor(')}
    return { render: configRenderField, updateVisibility: configUpdateVisibility };
  `)(f.editor, f.set, node, clear, () => node('span'), () => {});
  const keys = ['targetMode', 'targetPriority', 'cityRefs', 'defenceTargetMode', 'defenceTargetPriority', 'defenceCityRefs'];
  const fields = f.strategyFields.filter(field => keys.includes(field.key.split('.')[1]));
  assert.equal(fields.length, 6);
  assert.deepEqual(fields.map(field => field.label), ['进攻目标来源', '进攻目标优先', '指定进攻城市', '防守目标来源', '防守目标优先', '指定防守城市']);
  for (const field of fields) renderer.render(field);
  f.env.updateVisibility = renderer.updateVisibility;
  renderer.updateVisibility();
  const widget = key => f.editor.widgets.get('cityWar.' + key);
  const choose = (key, value) => { const select = widget(key).control; select.value = value; select.onchange(); };
  const checkCity = (key, name, checked = true) => {
    const control = widget(key).control; control.open = true; control.ontoggle();
    const list = control.childNodes[1].childNodes[1];
    const option = list.childNodes.find(label => label.childNodes[1]?.textContent === name);
    assert(option, name);
    const input = option.childNodes[0]; input.checked = checked; input.onchange();
  };
  assert.equal(widget('cityRefs').row.hidden, true);
  assert.equal(widget('defenceCityRefs').row.hidden, true);
  choose('targetMode', 'selected');
  assert.equal(widget('cityRefs').row.hidden, false);
  assert.equal(widget('defenceCityRefs').row.hidden, true);
  checkCity('cityRefs', '城市甲');
  choose('targetPriority', 'original');
  choose('defenceTargetMode', 'selected');
  assert.equal(widget('defenceCityRefs').row.hidden, false);
  await f.tick(600);
  assert(f.editor.errors['cityWar.defenceCityRefs']);
  assert.equal(widget('defenceCityRefs').error.hidden, false);
  assert.deepEqual(f.view('a').settings.cityWar.cityRefs, []);
  checkCity('defenceCityRefs', '城市乙');
  assert.equal(widget('defenceCityRefs').error.hidden, false, '继续显示校验错误，等待修改后的草稿通过校验');
  await f.tick(600);
  assert.equal(widget('defenceCityRefs').error.hidden, true);
  const saved = f.view('a').settings.cityWar;
  assert.equal(saved.targetMode, 'selected'); assert.equal(saved.defenceTargetMode, 'selected');
  assert.equal(saved.targetPriority, 'original'); assert.equal(saved.defenceTargetPriority, 'fewestAllied');
  assert.deepEqual(saved.cityRefs, ['1:2']); assert.deepEqual(saved.defenceCityRefs, ['1:3']);
  assert.equal(widget('cityRefs').control.childNodes[0].textContent, '城市甲');
  assert.equal(widget('defenceCityRefs').control.childNodes[0].textContent, '城市乙');

  choose('targetMode', 'alliance');
  assert.equal(widget('cityRefs').row.hidden, true);
  assert.equal(widget('defenceCityRefs').row.hidden, false);
  checkCity('defenceCityRefs', '城市丙');
  choose('defenceTargetPriority', 'original');
  await f.tick(600); await f.load(true);
  assert.equal(f.editor.draft.cityWar.targetMode, 'alliance');
  assert.deepEqual(f.editor.draft.cityWar.cityRefs, ['1:2']);
  assert.deepEqual(f.editor.draft.cityWar.defenceCityRefs, ['1:3', '1:4']);
  assert.equal(f.editor.draft.cityWar.defenceTargetPriority, 'original');

  assert.equal(await f.mayChange('b'), true); f.change('b'); await f.load();
  assert.deepEqual(f.editor.draft.cityWar.defenceCityRefs, []);
  assert.equal(await f.mayChange('a'), true); f.change('a'); await f.load();
  assert.equal(f.editor.draft.cityWar.defenceTargetMode, 'selected');
  assert.deepEqual(f.editor.draft.cityWar.defenceCityRefs, ['1:3', '1:4']);
  assert.deepEqual(f.editor.draft.cityWar.cityRefs, ['1:2']);
});

function lineupPickerFixture(f, { boss = false } = {}) {
  const node = (tag, className = '', textContent = '') => ({
    tag, className, textContent, children: [], attributes: {}, dataset: {}, value: '', disabled: false,
    append(...items) { this.children.push(...items); },
    setAttribute(key, value) { this.attributes[key] = value; },
  });
  const viewed = [];
  const render = newStateFunction('configEditor', 'configGet', 'configSet', 'el', 'configButton', 'openSavedLineupViewer', `
    const current = configEditor.owner;
    ${section('function configLineupPicker(', 'function configRenderUsage(')}
    return configLineupPicker;
  `)(f.editor, key => key.split('.').reduce((value, part) => value[part], f.editor.draft), f.set, node,
    (text, onclick) => Object.assign(node('button', '', text), { onclick }),
    (account, id) => viewed.push({ account, id }));
  const fields = boss ? f.groups.find(group => group.id === 'worldBoss').fields.filter(field => field.kind === 'fleetLineups')
    : f.groups.find(group => group.id === 'progression').fields.filter(field => field.key.startsWith('lineups.'));
  if (!boss) {
    assert.deepEqual(fields.map(field => field.key), ['lineups.mainlinePresetId', 'lineups.trialPresets']);
    assert.deepEqual(fields.map(field => field.parent), ['progression.mainline', 'progression.trials']);
  }
  const roots = fields.map(field => render(field, 'config-field-' + field.key.replaceAll('.', '-')));
  const controls = roots.flatMap(root => root.children.flatMap(row => row.children));
  const select = binding => controls.find(control => control.dataset.lineupBinding === binding);
  const button = binding => controls.find(control => control.dataset.lineupView === binding);
  return { roots, select, button, viewed, choose(binding, id) { const control = select(binding); control.value = id; control.onchange(); } };
}

const lineupPresets = [
  { id: 'first', name: '主线队', formation: { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4 } }], petUid: '0' } },
  { id: 'second', name: '副本队', formation: { presetId: 7, heroPositions: [{ heroId: 'b', pos: { x: 5, y: 1 } }], petUid: '9007199254740993' } },
];
const lineupCatalog = { trialRaids: [{ value: '1', label: '金币副本' }, { value: '2', label: '强化石副本' }, { value: '3', label: '藏品副本' }] };

await test('世界Boss逐队阵容跟随舰队勾选显隐，保存刷新与切号保留独立选择', async () => {
  const f = fixture({ catalog: { expeditionFleets: [1, 2, 3].map(id => ({ value: id + '远征船', label: '舰队' + id })) } });
  const initial = f.view('a'); initial.settings.lineups.presets = structuredClone(lineupPresets);
  initial.settings.worldBoss.fleetIds = ['1远征船', '2远征船'];
  saveAutomationSettings('a', initial.settings, { file: f.file, revision: initial.revision });
  await f.load();
  const picker = lineupPickerFixture(f, { boss: true }), root = picker.roots[0];
  const row = id => root.children.find(node => node.children.includes(picker.select('fleet:' + id + '远征船')));
  assert.equal(row(1).hidden, false); assert.equal(row(2).hidden, false); assert.equal(row(3).hidden, true);
  picker.choose('fleet:1远征船', 'first'); picker.choose('fleet:2远征船', 'second');
  picker.button('fleet:2远征船').onclick(); assert.deepEqual(picker.viewed, [{ account: 'a', id: 'second' }]);
  f.set('worldBoss.fleetIds', ['2远征船']); root.refresh();
  assert.equal(row(1).hidden, true); assert.equal(picker.select('fleet:1远征船').value, 'first');
  await f.tick(600); await f.load(true);
  assert.deepEqual(f.view('a').settings.worldBoss.fleetPresets, [{ buildingId: '1远征船', presetId: 'first' }, { buildingId: '2远征船', presetId: 'second' }]);
  assert.equal(f.view('a').settings.worldBoss.enabled, false, '配置阵容不自动启用派遣');
  f.set('worldBoss.fleetIds', []); root.refresh(); assert.equal(root.children.at(-1).hidden, false);
  await f.tick(600);
  assert.equal(await f.mayChange('b'), true); f.change('b'); await f.load();
  assert.deepEqual(f.editor.draft.worldBoss.fleetPresets, []);
  assert.equal(await f.mayChange('a'), true); f.change('a'); await f.load();
  assert.equal(f.editor.draft.worldBoss.fleetPresets.length, 2);
});

await test('推关与试炼逐项选择阵容并查看，合并自动保存保留预设、其他副本和普通配置', async () => {
  const f = fixture({ catalog: lineupCatalog });
  const initial = f.view('a');
  initial.settings.lineups = { presets: structuredClone(lineupPresets), mainlinePresetId: '',
    trialPresets: [{ raidId: '2', presetId: 'second' }, { raidId: '3', presetId: 'first' }] };
  saveAutomationSettings('a', initial.settings, { file: f.file, revision: initial.revision });
  await f.load();
  let controls = lineupPickerFixture(f);
  assert.equal(controls.select('mainline').children[0].textContent, '使用游戏当前阵容');
  assert.equal(controls.button('mainline').disabled, true);
  controls.button('mainline').onclick();
  assert.deepEqual(controls.viewed, []);
  assert.equal(controls.select('trial:2').value, 'second');
  assert.equal(controls.select('trial:3').value, 'first');
  assert.equal(controls.button('trial:1').disabled, true);
  controls.choose('mainline', 'first');
  controls.choose('trial:1', 'second');
  controls.choose('trial:2', '');
  assert.equal(controls.button('mainline').disabled, false);
  assert.equal(controls.button('trial:2').disabled, true);
  controls.button('mainline').onclick();
  controls.button('trial:1').onclick();
  assert.deepEqual(controls.viewed, [{ account: 'a', id: 'first' }, { account: 'a', id: 'second' }]);
  f.set('factory.keepStock', 123);
  await f.tick(600);
  assert.equal(f.posts().length, 1);
  const saved = f.view('a').settings;
  assert.equal(saved.factory.keepStock, 123);
  assert.deepEqual(saved.lineups.presets, lineupPresets);
  assert.equal(saved.lineups.mainlinePresetId, 'first');
  assert.deepEqual(saved.lineups.trialPresets, [{ raidId: '3', presetId: 'first' }, { raidId: '1', presetId: 'second' }]);
  assert(f.env.calls.every(call => ['/api/settings','/api/settings?fleets=1', '/api/loop'].includes(call.route)));
  await f.load(true);
  controls = lineupPickerFixture(f);
  assert.equal(controls.select('mainline').value, 'first');
  assert.equal(controls.select('trial:1').value, 'second');
  assert.equal(controls.select('trial:2').value, '');
  assert.equal(await f.mayChange('b'), true);
  f.change('b'); await f.load();
  controls = lineupPickerFixture(f);
  assert.equal(controls.select('mainline').children.length, 1);
  assert.equal(controls.button('mainline').disabled, true);
  assert.equal(controls.button('trial:1').disabled, true);
  assert.deepEqual(f.editor.draft.lineups.presets, []);
});

await test('阵容选择与在途普通设置共用串行保存，外部管理修改刷新后沿用版本冲突保护', async () => {
  const f = fixture({ catalog: lineupCatalog });
  const initial = f.view('a'); initial.settings.lineups.presets = structuredClone(lineupPresets);
  saveAutomationSettings('a', initial.settings, { file: f.file, revision: initial.revision });
  await f.load();
  const controls = lineupPickerFixture(f), gate = deferred();
  f.env.onPost = () => gate.promise;
  f.set('factory.keepStock', 124); await f.tick(600);
  controls.choose('mainline', 'second'); controls.choose('trial:2', 'first'); await f.tick(600);
  assert.equal(f.posts().length, 1);
  f.env.onPost = null; gate.resolve(); await settle(); await f.tick(600);
  assert.equal(f.posts().length, 2); assert.equal(f.env.maxInFlight, 1);
  assert.equal(f.view('a').settings.factory.keepStock, 124);
  assert.equal(f.view('a').settings.lineups.mainlinePresetId, 'second');
  assert.deepEqual(f.view('a').settings.lineups.trialPresets, [{ raidId: '2', presetId: 'first' }]);
  const managed = f.view('a'); managed.settings.lineups.presets[0].name = '管理页改名';
  saveAutomationSettings('a', managed.settings, { file: f.file, revision: managed.revision });
  await f.load();
  assert.equal(lineupPickerFixture(f).select('mainline').children[1].textContent, '管理页改名');
  f.set('lineups.mainlinePresetId', 'first');
  const newer = f.view('a'); newer.settings.lineups.presets[1].name = '另一页改名';
  saveAutomationSettings('a', newer.settings, { file: f.file, revision: newer.revision });
  await f.load();
  assert.equal(f.editor.draft.lineups.mainlinePresetId, 'first');
  await f.tick(600);
  assert(f.editor.saveError?.fields?.revision);
  assert.equal(f.view('a').settings.lineups.mainlinePresetId, 'second');
  assert.equal(f.view('a').settings.lineups.presets[1].name, '另一页改名');
});

await test('配置曾打开后经真实管理保存流程新增、改名和删除，返回配置重绘选择且自动保存保留最新阵容', async () => {
  const f = fixture({ catalog: lineupCatalog });
  let controls;
  f.env.onRender = () => { controls = lineupPickerFixture(f); };
  await f.load();
  assert.equal(controls.select('mainline').children.length, 1);
  const managerSource = fs.readFileSync(new URL('../src/lineup-editor.js', import.meta.url), 'utf8');
  const managerSection = (from, to) => {
    const start = managerSource.indexOf(from), end = managerSource.indexOf(to, start);
    assert(start >= 0 && end > start, from);
    return managerSource.slice(start, end);
  };
  const managerView = () => { const view = f.view('a'); return { ...view.settings.lineups, revision: view.revision }; };
  const state = { saved: managerView(), readSerial: 0, saving: false };
  let nextId = 0;
  const mutate = newStateFunction('env', `
    const current = 'a';
    const savedLineupState = () => env.state;
    const renderSavedLineups = () => {}, redrawLineupEditor = () => {}, updateManualLineupSelects = () => {};
    const lineupRequest = env.request;
    ${managerSection('function adoptSavedLineups(', 'async function refreshSavedLineups(')}
    ${managerSection('async function mutateSavedLineups(', 'async function captureSavedLineup(')}
    return mutateSavedLineups;
  `)({ state, async request(route, account, payload) {
    assert.equal(account, 'a');
    const prior = f.view(account), settings = structuredClone(prior.settings);
    if (route.endsWith('/save')) {
      const preset = { id: payload.id || 'managed-' + ++nextId, name: payload.name, formation: payload.formation };
      const index = settings.lineups.presets.findIndex(item => item.id === preset.id);
      if (index < 0) settings.lineups.presets.push(preset); else settings.lineups.presets[index] = preset;
    } else {
      assert(route.endsWith('/delete'));
      settings.lineups.presets = settings.lineups.presets.filter(item => item.id !== payload.id);
      if (settings.lineups.mainlinePresetId === payload.id) settings.lineups.mainlinePresetId = '';
      settings.lineups.trialPresets = settings.lineups.trialPresets.filter(item => item.presetId !== payload.id);
    }
    saveAutomationSettings(account, settings, { file: f.file, revision: payload.revision });
    return managerView();
  } });

  assert.equal(await f.flush(), true);
  assert(await mutate('a', '/api/lineup-presets/save', { name: '新建队伍', formation: lineupPresets[0].formation }));
  await f.load();
  assert.deepEqual(controls.select('mainline').children.map(option => option.textContent), ['使用游戏当前阵容', '新建队伍']);
  controls.choose('mainline', 'managed-1'); controls.choose('trial:1', 'managed-1');
  await f.tick(600);
  assert.equal(f.view('a').settings.lineups.presets[0].name, '新建队伍');
  assert.equal(f.view('a').settings.lineups.mainlinePresetId, 'managed-1');

  state.saved = managerView();
  assert.equal(await f.flush(), true);
  assert(await mutate('a', '/api/lineup-presets/save', { id: 'managed-1', name: '重命名队伍', formation: lineupPresets[0].formation }));
  await f.load();
  assert.equal(controls.select('mainline').children[1].textContent, '重命名队伍');
  assert.equal(controls.select('mainline').value, 'managed-1');
  assert.equal(controls.select('trial:1').value, 'managed-1');
  f.set('factory.keepStock', 125); await f.tick(600);
  assert.equal(f.view('a').settings.lineups.presets[0].name, '重命名队伍');

  state.saved = managerView();
  assert.equal(await f.flush(), true);
  assert(await mutate('a', '/api/lineup-presets/delete', { id: 'managed-1' }));
  await f.load();
  assert.equal(controls.select('mainline').children.length, 1);
  assert.equal(controls.select('mainline').value, '');
  assert.equal(controls.select('trial:1').value, '');
  assert.equal(controls.button('mainline').disabled, true);
  assert.equal(controls.button('trial:1').disabled, true);
  f.set('factory.keepStock', 126); await f.tick(600);
  assert.deepEqual(f.view('a').settings.lineups, { presets: [], mainlinePresetId: '', trialPresets: [] });
  assert.equal(f.view('a').settings.factory.keepStock, 126);
  assert.equal(f.env.maxInFlight, 1);
  assert.equal(f.editor.saveError, null);
});

console.log('配置自动保存专项 ' + passed + '/' + passed + ' 通过');
