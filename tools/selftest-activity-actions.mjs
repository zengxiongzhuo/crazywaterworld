import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { activityEntries, runActivity } from '../src/activities.mjs';
import { createUsageLedger } from '../src/automation-settings.mjs';
import { classifyLog, LOG_CATEGORIES, LOG_GROUPS } from '../src/log-categories.mjs';

const initialTime = Date.UTC(2026, 10, 5, 4) / 1000;
const config = { tables: {
  LinkageLSREvilExpelTotalRewardCfg: { data: [{ totalCount: 10 }] },
  LinkageLSRCompassWheelScoreRewardCfg: { data: [{ id: 1, score: 100 }] },
  FishBaseCfg: { data: [] }, FishStageCfg: { data: [] },
  WeekLotteryTimesCfg: { data: [{ periodId: 5, rwdId: 1, reqTimes: 10 }] },
  WeekLotteryPackCfg: { data: [{ packId: 1, price: 0, limitedTimes: 1 }] },
} };

function fixture() {
  let time = initialTime;
  const calls = [];
  const festival = id => ({ activityId: id, startTime: time - 100, endTime: time + 100,
    subActivity: [28, 29, 30].map(subActivityType => ({ subActivityType, openTime: time - 50, closeTime: time + 50 })) });
  const client = {
    get serverClockOffsetMs() { return time * 1000 - Date.now(); },
    festivals: [festival(101), festival(202)],
    async request(name, body = {}) {
      calls.push([name, body]);
      if (name === 'WeekInfoRequest') return { activityTime: [] };
      if (name === 'EvilExpelInfoRequest') return { alive: 1, killTotal: 0, claimed: 0 };
      if (name === 'EvilExpelKillRequest') return { killTotal: 1 };
      throw new Error('Unexpected request: ' + name);
    },
  };
  return { client, calls, advance(seconds) { time += seconds; } };
}

{
  const { client } = fixture();
  client.newbieActivity = { startTime: initialTime - 100, loginDays: 2, loginRewardDay: [1] };
  const weekly = [{ type: 4, period: 5, startTime: initialTime - 100, endTime: initialTime + 100 }];
  const rows = activityEntries(client, weekly);
  assert.equal(new Set(rows.map(row => row.id)).size, 8);
  assert.deepEqual(rows[0].taskKeys, ['weekGift', 'weekTimes', 'weekLotterySpin']);
  assert.equal(rows[0].kind, 'weekly');
  assert.equal(rows[0].weekType, 4);
  assert(rows.filter(row => row.kind === 'limited').every(row => row.endTime > initialTime));
  assert(!rows.some(row => row.id.startsWith('festival:')), '联动已有独立玩法时不重复总入口');
  assert.equal(rows.find(row => row.id === 'linkage:101:30').taskKey, 'evilExpel');
  assert.equal(rows.at(-1).id, 'newbie:' + client.newbieActivity.startTime);
  assert.deepEqual(activityEntries(client, weekly), rows, '刷新前后活动实例标识稳定');
}

{
  const { client } = fixture();
  const window = { type: 5, period: 1001, startTime: initialTime - 100, endTime: initialTime + 100 };
  const rows = activityEntries(client, [window]);
  const merchant = rows.filter(row => row.weekType === 5);
  assert.equal(merchant.length, 1, '不差钱商人有独立活动入口');
  assert.equal(merchant[0].name, '不差钱商人');
  assert.equal(merchant[0].id, 'weekly:5:1001:' + window.startTime, '名称调整后沿用当前活动实例标识');
  assert.deepEqual(merchant[0].taskKeys, ['weekOrderFinal', 'weekOrderSubmit']);
  assert(!rows.some(row => row.name === '周订单'), '活动列表使用游戏中的活动名称');
  assert.equal(LOG_CATEGORIES.orders, '不差钱商人');
  assert(LOG_GROUPS['日常与活动'].includes('orders'));
  assert(!LOG_GROUPS['基地与资源'].includes('orders'));
  for (const message of ['不差钱商人', '商人订单提交', '周订单提交', 'FinishWeekOrderRequest']) {
    assert.equal(classifyLog(message), 'orders');
  }
  for (const message of ['超凡英雄', 'HeroRaidChallengeRequest', 'HeroRaidPrizeRequest']) {
    assert.equal(classifyLog(message), 'activity');
  }
}

// Execute the browser's order rendering and confirmation handlers with a small
// DOM fixture so naming changes also exercise the actual purchase/submit wiring.
const activityScript = fs.readFileSync(new URL('../src/ui/activities.js', import.meta.url), 'utf8');
const orderHandlersStart = activityScript.indexOf('function renderActivityOrder()');
const orderHandlersEnd = activityScript.indexOf('async function refreshActivities()', orderHandlersStart);
assert(orderHandlersStart >= 0 && orderHandlersEnd > orderHandlersStart);
const orderHandlers = activityScript.slice(orderHandlersStart, orderHandlersEnd);

function orderUiFixture(order) {
  const nodes = new Map(), confirmations = [], calls = [];
  const element = (tag, className = '', textContent = '') => ({
    tag, className, textContent, children: [],
    appendChild(child) { this.children.push(child); return child; },
  });
  let refreshes = 0;
  const context = {
    activitiesData: { order }, activitiesAccount: 'merchant-test', current: 'merchant-test',
    snapshot: { paused: false }, disconnected: new Set(), pendingActivities: new Set(),
    $(id) {
      if (!nodes.has(id)) nodes.set(id, element('div'));
      return nodes.get(id);
    },
    clear(node) { node.children = []; node.textContent = ''; return node; },
    el: element,
    smallButton: text => element('button', '', text),
    table: (headers, rows) => ({ tag: 'table', headers, rows }),
    openConfirm(title, details, accept) { confirmations.push({ title, details, accept }); },
    async call(url, options) { calls.push({ url, method: options.method, body: JSON.parse(options.body) }); return { message: '已确认' }; },
    async refreshActivities() { refreshes++; },
  };
  const handlers = vm.runInNewContext(orderHandlers + '\n({ renderActivityOrder, confirmWeekOrderAction });', context);
  return { ...handlers, nodes, confirmations, calls, context, get refreshes() { return refreshes; } };
}

{
  const order = { orderKey: 'merchant-order-key', finished: false, ready: false,
    materials: [{ id: '木板', name: '木板', required: 3, owned: 1, missing: 2, price: 10 }] };
  const ui = orderUiFixture(order);
  ui.renderActivityOrder();
  const children = ui.nodes.get('activities-order').children;
  assert.match(children[0].textContent, /商人订单.*缺材料/);
  assert(!children[0].textContent.includes('周订单'));
  assert.equal(children[1].disabled, true, '缺料时整单提交按钮不可用');
  const buy = children.find(child => child.tag === 'table').rows[0][6];
  assert.equal(buy.textContent, '20 钻');
  buy.onclick();
  assert.equal(ui.calls.length, 0, '购买前先显示确认内容');
  assert.equal(ui.confirmations[0].title, '钻石购买商人订单材料');
  assert.equal(ui.confirmations[0].details[0].textContent, '木板 ×2，共 20 钻石');
  await ui.confirmations[0].accept();
  assert.deepEqual(ui.calls, [{ url: '/api/week-order/buy?account=merchant-test', method: 'POST',
    body: { confirm: true, orderKey: order.orderKey, itemId: '木板', quantity: 2, cost: 20 } }]);
  assert.equal(ui.refreshes, 1);
  assert.equal(ui.context.pendingActivities.size, 0);
}

{
  const order = { orderKey: 'merchant-ready-key', finished: false, ready: true,
    materials: [{ id: '木板', name: '木板', required: 3, owned: 3, missing: 0, price: 10 }] };
  const ui = orderUiFixture(order);
  ui.renderActivityOrder();
  const children = ui.nodes.get('activities-order').children;
  assert.match(children[0].textContent, /商人订单材料已齐/);
  assert(!children[0].textContent.includes('周订单'));
  assert.equal(children[1].disabled, false);
  children[1].onclick();
  assert.equal(ui.calls.length, 0, '提交前显示整单材料确认');
  assert.match(ui.confirmations[0].title, /商人订单/);
  assert(!ui.confirmations[0].title.includes('周订单'));
  assert.equal(ui.confirmations[0].details[0].textContent, '木板 ×3');
  await ui.confirmations[0].accept();
  assert.deepEqual(ui.calls, [{ url: '/api/week-order/submit?account=merchant-test', method: 'POST',
    body: { confirm: true, orderKey: order.orderKey } }]);
  assert.equal(ui.refreshes, 1);
  assert.equal(ui.context.pendingActivities.size, 0);
}

for (const [order, message] of [
  [null, '不差钱商人活动未开放'],
  [{ materials: [], finished: true, finalReady: true }, '本期商人订单已全部交付，可领取最终奖励。'],
  [{ materials: [], finished: true }, '本期商人订单已完成'],
]) {
  const ui = orderUiFixture(order);
  ui.renderActivityOrder();
  assert.equal(ui.nodes.get('activities-order').textContent, message);
  assert.equal(ui.calls.length, 0);
}

{
  const { client, calls } = fixture();
  const result = await runActivity(client, config, { activityId: 'linkage:101:30', taskKey: 'evilExpel' });
  assert(result.results.some(row => row.ok));
  assert.deepEqual(calls.map(([name, body]) => [name, body.activityId]), [
    ['EvilExpelInfoRequest', 101], ['EvilExpelKillRequest', 101],
  ], '只执行选中实例的选中玩法');
  calls.length = 0;
  await assert.rejects(runActivity(client, config, { activityId: 'linkage:101:30', taskKey: 'edict' }), /不支持/);
  await assert.rejects(runActivity(client, config, { activityId: 'festival:101', taskKey: 'evilExpel' }), /已结束|尚未开放/);
  assert.deepEqual(calls, [], '无效操作不能触发游戏请求');
}

{
  const { client, calls, advance } = fixture();
  advance(51);
  await assert.rejects(runActivity(client, config, { activityId: 'linkage:101:30', taskKey: 'evilExpel' }), /已结束/);
  assert.deepEqual(calls, [], '子活动到期后不能执行，即使联动整体仍开放');
}

for (const stop of ['pause', 'expire']) {
  const { client, calls, advance } = fixture();
  let enabled = true;
  const request = client.request;
  client.request = async function (name, body) {
    const result = await request(name, body);
    if (stop === 'pause') enabled = false;
    else advance(51);
    return result;
  };
  await runActivity(client, config, { activityId: 'linkage:101:30', taskKey: 'evilExpel', enabled: () => enabled });
  assert.deepEqual(calls.map(([name]) => name), ['EvilExpelInfoRequest'], '读取后暂停或过期不能继续写入');
}

{
  const { client, calls } = fixture();
  client.request = async (name, body = {}) => {
    calls.push([name, body]);
    if (name === 'EdictInfoRequest') return { cost: { id: '活动26捞尸人_入场券', num: 1 } };
    if (name === 'AllItemRequest') return { items: [{ itemId: '活动26捞尸人_入场券', num: 10 }] };
    if (name === 'EdictStartRequest') return { session: { rune: [1, 2, 3, 4] } };
    if (name === 'EdictGuessRequest') return { success: true, patience: 2, score: 10 };
    throw new Error(name);
  };
  await runActivity(client, config, { activityId: 'linkage:101:29', taskKey: 'edict' });
  assert.equal(calls.filter(([name]) => name === 'EdictStartRequest').length, 1, '单次执行最多开局一次');
  assert(calls.filter(([name]) => name.startsWith('Edict')).every(([, body]) => body.activityId === 101));
}

{
  const { client, calls } = fixture();
  let period = 5, scheduleReads = 0;
  client.request = async (name, body = {}) => {
    calls.push([name, body]);
    if (name === 'WeekInfoRequest') {
      if (++scheduleReads > 1) period++;
      return { activityTime: [{ type: 4, period, startTime: initialTime - 100, endTime: initialTime + 100 }] };
    }
    throw new Error(name);
  };
  await assert.rejects(runActivity(client, config, { activityId: `weekly:4:5:${initialTime - 100}`, taskKey: 'weekGift' }), /换期/);
  assert.deepEqual(calls.map(([name]) => name), ['WeekInfoRequest', 'WeekInfoRequest'], '执行前换期不能领取另一期奖励');
}

{
  const { client, calls } = fixture();
  let claimed = false;
  const week = { type: 4, period: 5, startTime: initialTime - 100, endTime: initialTime + 100 };
  client.request = async (name, body = {}) => {
    calls.push([name, body]);
    if (name === 'WeekInfoRequest') return { activityTime: [week] };
    if (name === 'WeekLotteryInfoRequest') return { gift: [{ giftId: 1, gotTimes: Number(claimed) }] };
    throw new Error(name);
  };
  client.sendWatch = async name => { assert.equal(name, 'WeekLotteryFreePackRequest'); calls.push([name, {}]); claimed = true; };
  await runActivity(client, config, { activityId: activityEntries(client, [week])[0].id, taskKey: 'weekGift' });
  assert(claimed);
  assert(!calls.some(([name]) => name === 'WeekLotteryTimesRewardRequest'), '领奖按钮不执行相邻任务');
}

{
  const { client, calls } = fixture();
  client.request = async name => {
    calls.push(name);
    assert.equal(name, 'WeekInfoRequest');
    return { activityTime: [5, 6].map(period => ({ type: 4, period, startTime: initialTime - 100, endTime: initialTime + 100 })) };
  };
  await assert.rejects(runActivity(client, config, { activityId: `weekly:4:5:${initialTime - 100}`, taskKey: 'weekGift' }), /期次不唯一/);
  assert.deepEqual(calls, ['WeekInfoRequest']);
}

{
  const { client, calls } = fixture();
  let claimed = 0;
  client.request = async name => {
    calls.push(name);
    if (name === 'FishEncyclopediaRequest') return { fishList: [1], rewardId: claimed };
    assert.equal(name, 'DrawFishRewardRequest');
    return { rewardId: ++claimed };
  };
  const fishConfig = { tables: { FishBaseCfg: { data: [{ fishId: 1, name: '鱼', score: 10 }] },
    FishStageCfg: { data: [{ stage: 1, star: 10 }] } } };
  const result = await runActivity(client, fishConfig, { activityId: 'fish', taskKey: 'fishBook' });
  assert(result.results.some(row => row.ok));
  assert.equal(claimed, 1);
  assert(!calls.includes('WeekInfoRequest'), '图鉴领取不会读取无关活动');
}

{
  const { client, calls } = fixture();
  client.newbieActivity = { startTime: initialTime - 100, loginDays: 2, loginRewardDay: [1] };
  client.request = async (name, body = {}) => { calls.push([name, body]); return {}; };
  await runActivity(client, config, { activityId: 'newbie:' + client.newbieActivity.startTime, taskKey: 'newbieLogin' });
  assert.deepEqual(calls, [['DrawNewbieLoginRewardRequest', { day: 2 }]]);
  await runActivity(client, config, { activityId: 'newbie:' + client.newbieActivity.startTime, taskKey: 'newbieLogin' });
  assert.equal(calls.length, 1, '已领取的新手奖励不会重复提交');
}

for (const unconfirmed of ['task', 'reward']) {
  const { client, calls } = fixture();
  const week = { type: 1, period: 1, startTime: initialTime - 100, endTime: initialTime + 100 };
  const passConfig = { tables: {
    WeekPassTaskCfg: { data: [{ taskId: 1, target: 1, desc: '任务' }] },
    WeekBattlePassCfg: { data: [{ periodId: 1, rwdId: 1, reqScore: 10, freeReward: [['木材', 1]] }] },
  } };
  client.request = async name => {
    calls.push(name);
    if (name === 'WeekInfoRequest') return { activityTime: [week] };
    if (name === 'WeekBattlePassInfoRequest') return {
      score: unconfirmed === 'task' ? 0 : 10,
      task: unconfirmed === 'task' ? [{ taskId: 1, progress: 1, isGot: false }] : [],
      got: [],
    };
    if (name === 'WeekBattlePassFinishTaskRequest') return { score: 10 };
    assert.equal(name, 'WeekBattlePassGotRewardRequest');
    return { got: [{ stage: 1, freeGot: true }] };
  };
  const result = await runActivity(client, passConfig, {
    activityId: activityEntries(client, [week])[0].id, taskKey: 'weekPass',
  });
  assert(!result.results.some(row => row.ok), '领取回包成功而回读未确认时不能报告成功');
  assert(result.results.some(row => /领取状态尚未确认/.test(row.error)));
  if (unconfirmed === 'task') assert(!calls.includes('WeekBattlePassGotRewardRequest'), '任务领取未确认时停止后续领奖');
}

// Exercise the real HTTP queue with fake accounts and a fake game; no game sockets.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-activity-actions-'));
{
  const { client, calls } = fixture();
  client.festivals = [{ activityId: 303, type: '独立走江活动', startTime: initialTime - 100,
    endTime: initialTime + 100, subActivity: [{ subActivityType: 27 }] }];
  const rows = activityEntries(client);
  assert.equal(rows.length, 1, '独立走江活动也有唯一玩法入口');
  assert.equal(rows[0].taskKey, 'riverScore');
  assert.deepEqual(rows[0].taskKeys, ['riverScore', 'riverPass', 'riverHelp', 'snowballFree']);
  const riverConfig = { tables: {
    SnowBallScoreRewardCfg: { data: [{ id: 1, score: 10 }] },
    SnowBallBattlePassCfg: { data: [{ rwdId: 1, reqScore: 10, freeReward: [['木材', 1]] }] },
    SnowBallGiftCfg: { data: [{ packId: 1, price: 0, limitCount: 1 }] },
  } };
  let score = 0, pass = false, gift = 0;
  const reward = { reward: { asset: [{ id: '木材', num: 1 }] } };
  client.request = async (name, body = {}) => {
    calls.push([name, body]);
    if (name === 'SnowballDetailRequest') return { totalScore: 10, claimedTier: score, giftBuy: [{ packId: 1, bought: gift }] };
    if (name === 'SnowballClaimRewardRequest') return { ...reward, claimedTier: ++score };
    if (name === 'BattlePassRequest') {
      assert.equal(body.type, 10);
      return { score: 10, endTime: initialTime + 100, activePay: false, got: pass ? [{ id: 1, freeGot: true }] : [] };
    }
    if (name === 'BattlePassGotRewardRequest') { assert.equal(body.type, 10); pass = true; return reward; }
    assert.equal(name, 'SnowballClaimGiftRequest');
    assert.equal(body.packId, 1); gift++; return reward;
  };
  const ledger = createUsageLedger('river-test', { file: path.join(dir, 'river-usage.json') });
  for (const taskKey of ['riverScore', 'riverPass', 'riverHelp']) {
    const result = await runActivity(client, riverConfig, { activityId: rows[0].id, taskKey, ledger });
    assert(result.results.some(row => row.ok), '走江单次操作应接入统一的季节活动服务：' + taskKey);
  }
  await runActivity(client, riverConfig, { activityId: rows[0].id, taskKey: 'riverScore', ledger });
  assert.equal(calls.filter(([name]) => name === 'SnowballClaimRewardRequest').length, 1, '已领取积分不能重复发送');
}
process.env.CW_DATA_DIR = dir;
process.env.CW_CONFIG_PACK = path.join(dir, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(config.tables).map(([name, table], index) => [index + 1, name, table])));
const { PAGE } = await import('../src/page.mjs');
assert.match(PAGE, /<button\b[^>]*data-tab="activities"[^>]*aria-label="活动"/);
assert(!PAGE.includes('data-resource-tab="activities"'), '活动独立为顶级导航');
assert(!PAGE.includes('材料与订单'), '活动页使用活动名称');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
saveStore({ activeId: 'activity-test', accounts: [{ id: 'activity-test', url: 'ws://invalid.invalid', login: {}, automation: { enabled: false } }] });
const app = createConsole({ port: 0 });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = promise => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP fixture timed out')), 5000); })])
    .finally(() => clearTimeout(timer));
};
try {
  await app.listen();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const request = async (route, body) => {
    const res = await fetch(base + '/api/' + route + '?account=activity-test', {
      method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
    });
    return { status: res.status, data: await res.json() };
  };
  await request('loop');
  const session = app.sessions.get('activity-test');
  const fixtureGame = fixture();
  const game = new EventEmitter();
  Object.defineProperty(game, 'serverClockOffsetMs', { get: () => fixtureGame.client.serverClockOffsetMs });
  Object.assign(game, { connected: true, festivals: fixtureGame.client.festivals, stop() { this.connected = false; } });
  session.client = game;
  session.player = { level: 20 };
  const savedTasks = { ...session.loop.tasks };
  let block, kills = 0;
  game.request = async (name, body) => {
    if (name === 'WeekInfoRequest') return { activityTime: [] };
    if (name === 'FishEncyclopediaRequest') return {};
    if (name === 'EvilExpelInfoRequest') {
      if (block) { block.enter.resolve(); await bounded(block.release.promise); }
      return { alive: kills ? 0 : 1, killTotal: kills, claimed: 0 };
    }
    assert.equal(name, 'EvilExpelKillRequest');
    assert.equal(body.activityId, 101);
    return { killTotal: ++kills };
  };
  const view = await request('activities');
  assert.equal(view.status, 200);
  assert.equal(view.data.activities.filter(row => row.id.startsWith('linkage:')).length, 6);
  assert(view.data.eventTasks.some(row => row.key === 'fishBook'));
  const payload = { activityId: 'linkage:101:30', taskKey: 'evilExpel', confirm: true };
  assert.equal((await request('activities/run', { ...payload, confirm: false })).status, 400);
  assert.equal(kills, 0);
  block = { enter: gate(), release: gate() };
  const first = request('activities/run', payload);
  await bounded(block.enter.promise);
  const received = gate();
  const observe = req => {
    if (req.url.startsWith('/api/activities/run')) req.on('end', () => { app.server.off('request', observe); setImmediate(received.resolve); });
  };
  app.server.on('request', observe);
  const duplicate = request('activities/run', payload);
  try { await bounded(received.promise); } finally { block.release.resolve(); }
  assert.equal((await first).status, 200);
  assert.equal((await duplicate).status, 200);
  assert.equal(kills, 1, '两个并发点击共享同一个队列任务');
  assert.deepEqual(session.loop.tasks, savedTasks, '手动执行不改变自动任务开关');

  const queued = gate();
  session.queueTail = queued.promise;
  const pendingReceived = gate();
  const observePending = req => {
    if (req.url.startsWith('/api/activities/run')) req.on('end', () => { app.server.off('request', observePending); setImmediate(pendingReceived.resolve); });
  };
  app.server.on('request', observePending);
  const pending = request('activities/run', payload);
  try {
    await bounded(pendingReceived.promise);
    session.paused = true;
    session.generation++;
  } finally { queued.resolve(); }
  assert.equal((await pending).status, 400, '暂停账号会取消尚未开始的单次执行');
  assert.equal(kills, 1);
} finally {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('activity action tests passed');
