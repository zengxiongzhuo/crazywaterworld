import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { automationTasks } from '../src/automation.mjs';

const script = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
const definitions = script.slice(0, script.indexOf('function configGet('));
const renderStart = script.indexOf('function configRender()');
const modelStart = script.indexOf('  const groups =', renderStart);
const modelEnd = script.indexOf('  const movedFields =', modelStart);
assert(modelStart > renderStart && modelEnd > modelStart);
const model = script.slice(modelStart, modelEnd);
const renderGroups = newStateFunction('data', definitions + '\nconfigEditor.data=data;\n' + model + '\nreturn groups;');
const retiredKeys = [
  'riverScore', 'riverPass', 'riverHelp', 'edictPass', 'compassDaily', 'compassAdGift', 'compassSpin',
  'festivalSign', 'festivalFreeGift', 'festivalActive', 'festivalGifts', 'snowballFree',
  'festivalActiveRewards', 'evilExpel', 'edict', 'compassReward',
];
const hiddenFields = [...retiredKeys.map(key => 'schedule.' + key), 'eventActions.compassThreshold', 'eventActions.compassDrawCount'];
const dataFor = (hidden = hiddenFields, tasks = automationTasks) => ({
  settings: { schedule: Object.fromEntries(retiredKeys.map(key => [key, true])), eventActions: { compassThreshold: 21, compassDrawCount: 5 } },
  tasks, rules: { hiddenFields: hidden, mappedTasks: [] }, catalog: {}, revision: 7, baseRevision: 'base-7',
  usage: { rounds: 0 }, pendingUsage: {},
});
const keysOf = groups => groups.flatMap(group => group.fields.map(field => field.key));
let tests = 0;
async function test(name, run) { await run(); tests++; console.log('通过：' + name); }

await test('军备竞赛合并为唯一页签，奖励开关唯一且广告紧随日常行动', () => {
  const data = dataFor(), before = structuredClone(data), groups = renderGroups(data);
  assert.equal(groups.find(group => group.id === 'weekly-activities').title, '军备竞赛');
  assert(!groups.some(group => group.id === 'military-week'));
  assert.equal(keysOf(groups).filter(key => key === 'schedule.armsRaceRewards').length, 1);
  assert(groups.find(group => group.id === 'weekly-activities').fields.some(field => field.key === 'schedule.armsRaceRewards'));
  assert.equal(groups.findIndex(group => group.id === 'ad-rewards'), groups.findIndex(group => group.id === 'daily-actions') + 1);
  assert.deepEqual(data, before);
});

await test('16 项联动开关及 2 个参数同时隐藏，静态与自动补齐不回流', () => {
  const data = dataFor(), before = structuredClone(data), groups = renderGroups(data), keys = keysOf(groups);
  for (const key of hiddenFields) assert(!keys.includes(key), key);
  assert(!groups.some(group => group.id === 'river-series'), '联动空组不进入标签或预览选项');
  assert(groups.every(group => group.fields.length), '不保留空组');
  assert.deepEqual(data, before, '过滤不得改变保存值、参数或任务定义');
});

await test('服务端已过滤任务时静态联动与广告入口仍隐藏', () => {
  const tasks = automationTasks.filter(task => !retiredKeys.includes(task.key));
  const groups = renderGroups(dataFor(hiddenFields, tasks));
  assert(!keysOf(groups).some(key => hiddenFields.includes(key)));
  assert(!groups.some(group => group.id === 'river-series'));
  assert(groups.find(group => group.id === 'ad-rewards').fields.some(field => field.key === 'schedule.adShop'));
});

await test('周期、新手及其他任务不受联动下线影响', () => {
  const keys = new Set(keysOf(renderGroups(dataFor())));
  for (const key of ['armsRaceRewards', 'newbieLogin', 'pirateRankRewards', 'warRankRewards']) {
    assert(keys.has('schedule.' + key), key);
  }
  assert(keys.has('building.enabled'));
});

await test('风采大赛细项归活动页，复开和动态补齐不恢复固定页签，原设置保留', () => {
  for (const data of [dataFor(), dataFor([])]) {
    Object.assign(data.settings.schedule, { beautyVotes: true, beautyGift: false });
    const before = structuredClone(data), groups = renderGroups(data);
    assert(!groups.some(group => group.id === 'beauty-contest'));
    for (const key of ['schedule.beautyVotes', 'schedule.beautyGift']) assert(!keysOf(groups).includes(key));
    assert.deepEqual(data, before);
  }
});

await test('商人三个开关在活动页编辑，静态配置与任务补齐不会生成重复入口', () => {
  const merchantFields = ['schedule.weekOrderSubmit', 'weekOrder.allowDiamonds', 'schedule.weekOrderFinal'];
  const merchantTasks = new Set(['weekOrderSubmit', 'weekOrderFinal']);
  for (const data of [dataFor(), dataFor([]), dataFor([], automationTasks.filter(task => !merchantTasks.has(task.key)))]) {
    data.settings.weekOrder = { allowDiamonds: true };
    data.settings.schedule.weekOrderSubmit = true;
    data.settings.schedule.weekOrderFinal = false;
    const before = structuredClone(data), groups = renderGroups(data), keys = keysOf(groups);
    assert(!groups.some(group => group.id === 'rich-merchant'));
    for (const field of merchantFields) assert(!keys.includes(field), field);
    assert.deepEqual(data, before, '移动编辑入口保留原账号设置与任务定义');
  }
});

await test('超凡英雄配置集中在活动页，游戏配置保留原账号数据且没有重复入口', () => {
  const data = dataFor([]);
  data.settings.heroRaid = { enabled: true, challenge: false, retryTimes: 10, orders: true, lottery: false, rewards: true };
  const before = structuredClone(data), groups = renderGroups(data);
  assert(!groups.some(group => group.id === 'hero-raid'));
  assert(!keysOf(groups).some(key => key.startsWith('heroRaid.')));
  assert.deepEqual(data, before);
});

await test('海商王全部参数与三个任务开关集中到活动页，动态补齐保留其他任务', () => {
  for (const data of [dataFor(), dataFor([]), dataFor([], automationTasks.filter(task => task.key !== 'merchantTrade'))]) {
    data.settings.merchant = { autoSpeedUp: true, profitLimit: 12345 };
    Object.assign(data.settings.schedule, { merchantTrade: true, merchantRewards: false, tradeTasks: true });
    const before = structuredClone(data), groups = renderGroups(data), keys = keysOf(groups);
    assert(!groups.some(group => group.id === 'merchant-week'));
    assert(!keys.some(key => key.startsWith('merchant.')));
    for (const key of ['merchantTrade', 'merchantRewards', 'tradeTasks']) assert(!keys.includes('schedule.' + key));
    assert(keys.includes('schedule.armsRaceRewards'));
    assert.deepEqual(data, before);
  }
});

await test('复开后全部入口和参数恢复，原配置定义未被过滤污染', () => {
  const hidden = renderGroups(dataFor());
  const reopened = renderGroups(dataFor([])), keys = new Set(keysOf(reopened));
  for (const key of hiddenFields) assert(keys.has(key), key);
  assert(reopened.some(group => group.id === 'river-series'));
  assert(!hidden.some(group => group.id === 'river-series'));
});

const loadSource = script.slice(script.indexOf('async function configLoad('), script.indexOf('async function configMayChangeAccount('));
const versionSource = script.slice(script.indexOf('function configPageStale('), script.indexOf('function configHasDraft('));
const saveSource = script.slice(script.indexOf('function configSave('), script.indexOf('async function configImportFile('));
const clearErrorsSource = script.slice(script.indexOf('function configClearErrors('), script.indexOf('function configSet('));
const dirtySource = script.slice(script.indexOf('function configIsDirty('), script.indexOf('function configVisible('));
const compatibilitySource = script.slice(script.indexOf('function configCompatibilityMessage('), script.indexOf('function configBusy('));
const page = fs.readFileSync(new URL('../src/page.mjs', import.meta.url), 'utf8');
const toggleSource = page.slice(page.indexOf('async function toggleAutoTask('), page.indexOf('async function saveLoopInterval('));
function loadFixture(initial = dataFor([])) {
  const state = { next: structuredClone(initial), renders: [], usageRenders: 0, messages: [], calls: [] };
  const api = newStateFunction('state', 'renderGroups', definitions + '\n' + clearErrorsSource + '\n' + dirtySource + '\n' + compatibilitySource + '\n' + versionSource + '\n' + loadSource + '\n' + saveSource + '\n' + toggleSource + `
    const current = 'isolated-account', accounts = [];
    const savingTasks = new Set(), loopIntervalSaves = new Map();
    let loopVersion = 0, loopSettingsRevision = 7;
    const setTaskSwitch = (input, value) => { input.checked = value; };
    const refreshLoop = () => {};
    const reportError = error => { throw error; };
    const $ = () => ({});
    const call = async route => { state.calls.push(route); return route.split('?')[0] === '/api/settings' ? structuredClone(state.next) : { controls: [] }; };
    const configBusy = value => { configEditor.busy = value; };
    const configMessage = (...args) => state.messages.push(args);
    const configUpdateState = () => {};
    const configUpdateVisibility = () => {};
    const configCheckForm = () => true;
    const configErrors = error => { throw error; };
    const configRenderUsage = () => { state.usageRenders++; };
    const configRender = () => state.renders.push({ groups: renderGroups(configEditor.data), draft: structuredClone(configEditor.draft) });
    const configWeeklyRankingSync = () => {};
    return { editor: configEditor, load: configLoad, save: configSave, dirty: configIsDirty, toggle: toggleAutoTask };
  `)(state, renderGroups);
  return { state, ...api };
}

await test('保存版本和配置未变化时，下线与复开均即时刷新展示', async () => {
  const f = loadFixture(); await f.load();
  assert(f.state.renders[0].groups.some(group => group.id === 'river-series'));
  f.state.next.rules.hiddenFields = [...hiddenFields];
  await f.load();
  assert.equal(f.state.renders.length, 2);
  assert(!f.state.renders[1].groups.some(group => group.id === 'river-series'));
  assert.equal(f.editor.data.revision, 7);
  f.state.next.rules.hiddenFields = [];
  await f.load();
  assert.equal(f.state.renders.length, 3);
  assert(f.state.renders[2].groups.some(group => group.id === 'river-series'));
  assert(!f.dirty());
});

await test('未保存草稿保留，活动刷新不覆盖编辑或推进冲突版本', async () => {
  const f = loadFixture(); await f.load();
  f.editor.draft.schedule.riverScore = false;
  f.editor.draft.eventActions.compassThreshold = 88;
  const draft = f.editor.draft, baseline = f.editor.baseline, oldDataSettings = f.editor.data.settings;
  f.state.next = dataFor(); f.state.next.revision = 8; f.state.next.baseRevision = 'base-8';
  f.state.next.settings.eventActions.compassThreshold = 33;
  await f.load();
  assert.equal(f.state.renders.length, 2);
  assert(!f.state.renders[1].groups.some(group => group.id === 'river-series'));
  assert.equal(f.editor.draft, draft);
  assert.equal(f.editor.baseline, baseline);
  assert.equal(f.editor.data.settings, oldDataSettings);
  assert.equal(f.editor.draft.eventActions.compassThreshold, 88);
  assert.equal(f.editor.draft.schedule.riverScore, false);
  assert.equal(f.editor.data.revision, 7);
  assert.equal(f.editor.data.baseRevision, 'base-7');
  assert(f.dirty());
  f.state.next.rules.hiddenFields = [];
  await f.load();
  assert(f.state.renders[2].groups.some(group => group.id === 'river-series'));
  assert.equal(f.editor.draft.eventActions.compassThreshold, 88);
  assert.equal(f.editor.baseline, baseline);
});

await test('规则不变的后台刷新只更新运行数据，不反复重绘编辑器', async () => {
  const f = loadFixture(); await f.load();
  f.editor.draft.eventActions.compassThreshold = 42;
  f.state.next.usage.rounds = 9;
  await f.load();
  assert.equal(f.state.renders.length, 1);
  assert.equal(f.state.usageRenders, 1);
  assert.equal(f.editor.data.usage.rounds, 9);
  assert.equal(f.editor.draft.eventActions.compassThreshold, 42);
});

await test('挂机开关保存期间开始编辑，随后刷新保留同账号草稿和原冲突版本', async () => {
  const f = loadFixture(); await f.load();
  const owner = f.editor.owner;
  f.state.next.revision = 8;
  const input = { dataset: { autoTask: 'building.collect' }, checked: true, getAttribute() { return String(this.checked); } };
  const pending = f.toggle(input);
  f.editor.draft.eventActions.compassThreshold = 88;
  await pending;
  assert.equal(f.editor.owner, owner, '快捷开关不能让草稿失去账号归属');
  await f.load();
  assert.equal(f.editor.draft.eventActions.compassThreshold, 88);
  assert.equal(f.editor.data.revision, 7, '保留版本冲突保护，不能用旧草稿覆盖新开关');
  assert(f.dirty());
});

await test('只改变任务清单也更新动态配置入口', async () => {
  const f = loadFixture(); await f.load();
  f.state.next.tasks = f.state.next.tasks.filter(task => task.key !== 'festivalActive');
  await f.load();
  assert.equal(f.state.renders.length, 2);
  assert(!keysOf(f.state.renders[1].groups).includes('schedule.festivalActive'));
});

await test('保存回复带回新的下线规则时同步重绘，避免后续刷新误判展示未变', async () => {
  const f = loadFixture(); await f.load();
  f.editor.draft.schedule.riverScore = false;
  f.state.next.settings.schedule.riverScore = false;
  f.state.next.rules.hiddenFields = [...hiddenFields];
  f.state.next.running = true;
  await f.save();
  assert.equal(f.state.renders.length, 2);
  assert(!f.state.renders[1].groups.some(group => group.id === 'river-series'));
  assert(!keysOf(f.state.renders[1].groups).some(key => hiddenFields.includes(key)));
  assert.equal(f.editor.draft.eventActions.compassThreshold, 21);
  assert(!f.dirty());
});

newStateFunction(script);
console.log('活动配置界面专项 ' + tests + '/' + tests + ' 通过');
