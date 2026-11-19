import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createAutomationResults } from '../src/automation-results.mjs';
import { observeAutomationResults, receivedAssets } from '../src/automation-result-observer.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-results-'));
const file = path.join(directory, 'results.json');
let clock = Date.parse('2026-11-18T23:58:00+08:00'), passed = 0;
let reports = createAutomationResults({ file, now: () => clock, automatic: false });
const a = { id: 'role-a', loginId: 'login-a', label: '一区 · 航海员', world: '一区' };
const b = { id: 'role-b', loginId: 'login-a', label: '二区 · 航海员', world: '二区' };
const outsider = { id: 'role-x', loginId: 'login-x', label: '其他账号', world: '三区' };
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const view = (account = a, options = {}) => reports.view(account, options);
let visit;
try {
  await test('本次轮换多区服及多次进入同一区服合并，其他登录账号隔离', () => {
    visit = reports.begin(a, { kind: 'rotation', key: 'night-1' }); reports.online(visit.segmentId, true);
    reports.record(visit.runId, a.id, { id: 'gain-a', kind: 'assets', gains: { GOLD: 100 }, label: '居民订单' });
    clock += 60000; reports.endSegment(visit.segmentId);
    const second = reports.begin(b, { kind: 'rotation', key: 'night-1' }); assert.equal(second.runId, visit.runId);
    reports.online(second.segmentId, true); reports.record(second.runId, b.id, { kind: 'assets', gains: { GOLD: 70 } }); clock += 30000; reports.endSegment(second.segmentId);
    visit = reports.begin(a, { kind: 'rotation', key: 'night-1' }); reports.online(visit.segmentId, true);
    assert.equal(view().totals.gains.GOLD, 100); assert.equal(view(a, { scope: 'login' }).totals.gains.GOLD, 170);
    assert.equal(view(outsider).totals.gains.GOLD, undefined); assert.equal(view(a, { scope: 'login' }).roles.length, 2);
  });
  await test('跨午夜按北京时间分日，本次保留毛收益和实际消耗', () => {
    reports.record(visit.runId, a.id, { kind: 'assets', gains: { 木材: 100 }, costs: { RUBY: 10 } });
    clock = Date.parse('2026-11-19T00:00:30+08:00');
    reports.record(visit.runId, a.id, { kind: 'assets', costs: { 木材: 80 }, gains: { GOLD: 50 } });
    assert.equal(view().totals.gains.木材, 100); assert.equal(view().totals.costs.木材, 80);
    const today = view(a, { period: 'today' }); assert.equal(today.totals.gains.木材, undefined); assert.equal(today.totals.gains.GOLD, 50); assert.equal(today.totals.costs.木材, 80);
    assert.equal(today.totals.onlineMs, 30000);
  });
  await test('重复结果只记一次，等待与计划不记成功，确认操作解除待确认', () => {
    for (let i = 0; i < 2; i++) reports.record(visit.runId, a.id, { id: 'stable', kind: 'assets', gains: { RUBY: 5 } });
    reports.step(visit.runId, a.id, { skipped: true, label: '未开放' });
    reports.step(visit.runId, a.id, { planned: true, ok: true, label: '计划' });
    reports.step(visit.runId, a.id, { ok: true, status: 'unknown', label: '等待领取确认', taskKey: 'mail' });
    assert.equal(view().totals.pending, 1);
    reports.step(visit.runId, a.id, { ok: true, label: '邮件已确认领取', taskKey: 'mail', resultCategory: '日常领奖' });
    assert.equal(view().totals.pending, 0);
    reports.step(visit.runId, a.id, { status: 'unknown', round: 2, label: '新一轮邮件待确认', taskKey: 'mail' }); assert.equal(view().totals.pending, 1);
    reports.step(visit.runId, a.id, { skipped: true, status: 'empty', round: 3, taskKey: 'mail' }); assert.equal(view().totals.pending, 0);
    reports.step(visit.runId, a.id, { ok: true, label: '维修复查' });
    reports.step(visit.runId, a.id, { ok: true, label: '领取奖励', resultCategory: '日常领奖', operationId: 'step-1' });
    reports.step(visit.runId, a.id, { ok: true, label: '领取奖励', resultCategory: '日常领奖', operationId: 'step-1' });
    reports.operation(visit.runId, a.id, { operationId: 'op-1', phase: 'sent', label: '锻造' }); assert.equal(view().totals.pending, 1);
    reports.operation(visit.runId, a.id, { operationId: 'op-1', phase: 'confirmed' });
    reports.operation(visit.runId, a.id, { operationId: 'op-1', phase: 'unknown' }); assert.equal(view().totals.pending, 0);
    assert.equal(view().totals.completed, 2); assert.equal(view().totals.gains.RUBY, 5);
  });
  await test('普通掉线不拆战报，在线时长排除等待与程序退出时间', () => {
    const before = view().totals.onlineMs; reports.online(visit.segmentId, false); clock += 120000;
    assert.equal(view().totals.onlineMs, before); reports.online(visit.segmentId, true); clock += 10000;
    reports.close(); const end = clock; clock += 3600000;
    reports = createAutomationResults({ file, now: () => clock, automatic: false });
    assert.equal(view().totals.onlineMs, before + 10000);
    const resumed = reports.begin(a, { kind: 'rotation', key: 'night-1' }); assert.equal(resumed.runId, visit.runId);
    assert.equal(view().totals.onlineMs, before + 10000); reports.online(resumed.segmentId, true); clock += 1000;
    assert.equal(view().totals.onlineMs, before + 11000); assert(view().totals.elapsedMs < clock - end);
    visit = resumed;
  });
  await test('奖励包嵌套产出、资源枚举和英雄等实际奖励正常解码', () => {
    assert.deepEqual(receivedAssets({ reward: [{ buildingId: '1', product: { asset: [{ id: '木材', num: 2 }] } }], extReward: { asset: [{ id: 3, num: 4 }] } }), { 木材: 2, GOLD: 4 });
    assert.deepEqual(receivedAssets({ reward: { asset: [{ id: '木材', num: -1 }, { id: '石头', num: 2.5 }] } }), {});
    assert.equal(receivedAssets({ hero: [{ heroId: '水手', frag: false }], equipIds: ['a', 'a', 'b'] })['result:equipment'], 2);
  });
  await test('奖励回包与资产推送先后两种顺序均去重，快照和重复推送不算收益', async () => {
    const client = new EventEmitter(); client.request = async name => name === 'AllItemRequest' ? { items: [{ itemId: '石头', num: 10 }] } : { reward: { asset: [{ id: '石头', num: 5 }] } };
    const recorded = [], context = () => ({ runId: 'r', roleId: 'a' });
    observeAutomationResults(client, { context, record: (...args) => recorded.push(args[2]), now: () => clock });
    await client.request('AllItemRequest');
    await client.request('DrawTaskRewardRequest'); client.emit('message', { name: 'SCUpdateItem', seq: 1, body: { items: [{ itemId: '石头', num: 15 }] } });
    client.emit('message', { name: 'SCUpdateItem', seq: 1, body: { items: [{ itemId: '石头', num: 15 }] } });
    client.emit('message', { name: 'SCUpdateItem', seq: 2, body: { items: [{ itemId: '石头', num: 20 }] } }); await client.request('DrawTaskRewardRequest');
    client.emit('message', { name: 'SCUpdateItem', seq: 3, body: { items: [{ itemId: '石头', num: 13 }] } });
    assert.equal(recorded.reduce((sum, e) => sum + (e.gains.石头 ?? 0), 0), 10); assert.equal(recorded.reduce((sum, e) => sum + (e.costs.石头 ?? 0), 0), 7);
    await client.request('TaskInfoRequest'); assert.equal(recorded.length, 3, '任务预览奖励不能算实收');
  });
  await test('没有库存基线时不把整包数量算收益，重连快照不重复累计', async () => {
    const recorded = [], client = new EventEmitter(); client.request = async () => ({});
    observeAutomationResults(client, { context: () => ({ runId: 'r', roleId: 'a' }), record: (...args) => recorded.push(args[2]) });
    client.emit('message', { name: 'SCUpdateResource', seq: 1, body: { list: [{ res: 3, amount: 10000 }] } });
    client.emit('message', { name: 'AllResourceResponse', seq: 2, body: { list: [{ res: 3, amount: 9000 }] } });
    client.emit('message', { name: 'SCUpdateResource', seq: 3, body: { list: [{ res: 3, amount: 9100 }] } });
    assert.equal(recorded.length, 1); assert.equal(recorded[0].gains.GOLD, 100);
  });
  await test('已确认完整背包后首次获得新物品从零累计，重复数量不重复增加', async () => {
    const recorded = [], client = new EventEmitter(); client.request = async () => ({ items: [] });
    observeAutomationResults(client, { context: () => ({ runId: 'r', roleId: 'a' }), record: (...args) => recorded.push(args[2]) });
    await client.request('AllItemRequest');
    client.emit('message', { name: 'SCUpdateItem', seq: 1, body: { items: [{ itemId: '新材料', num: 50 }] } });
    client.emit('message', { name: 'SCUpdateItem', seq: 2, body: { items: [{ itemId: '新材料', num: 50 }] } });
    client.emit('message', { name: 'SCUpdateItem', seq: 3, body: { items: [{ itemId: '新材料', num: 30 }] } });
    assert.equal(recorded.length, 2); assert.equal(recorded[0].gains.新材料, 50); assert.equal(recorded[1].costs.新材料, 20);
  });
  await test('明细裁剪不丢失累计和收获来源，分页只返回当前页', () => {
    for (let i = 0; i < 2005; i++) reports.record(visit.runId, a.id, { kind: 'assets', label: '收获生产', gains: { 测试材料: 1 } });
    const data = view(); assert.equal(data.events.length, 50); assert.equal(data.retainedEvents, 2000);
    assert.equal(data.totals.gains.测试材料, 2005); assert.equal(data.totals.gainSources.测试材料.收获生产, 2005);
    assert.equal(view(a, { page: 40 }).events.length, 50);
  });
  await test('查看、分页和停止后的结果保留，新的手动挂机形成新战报', () => {
    reports.endLogin(a.loginId, '时段结束'); assert(view().run.endedAt);
    assert(view().totals.gains.GOLD > 0); const old = view().run.id;
    reports.begin(a); assert.notEqual(view().run.id, old); assert.equal(view().totals.completed, 0);
    assert.equal(view(a, { period: 'today' }).totals.gains.GOLD, 50);
  });
  await test('成果文件损坏只停用统计，不覆盖文件或阻止后台创建', () => {
    const badFile = path.join(directory, 'bad-results.json'); fs.writeFileSync(badFile, 'broken');
    const bad = createAutomationResults({ file: badFile, automatic: false });
    assert(bad.view(a).warning); assert.throws(() => bad.begin(a)); assert.equal(fs.readFileSync(badFile, 'utf8'), 'broken');
  });
  reports.close(); console.log('挂机成果核心验证通过：' + passed + '/' + passed);
} finally { reports.close(); assert(directory.startsWith(path.join(os.tmpdir(), 'cw-results-'))); fs.rmSync(directory, { recursive: true, force: true }); }
