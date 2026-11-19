// 军备竞赛榜单真实HTTP路径：只使用隔离账号和本地协议夹具，不连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-weekly-rank-http-'));
const previousData = process.env.CW_DATA_DIR, previousPack = process.env.CW_CONFIG_PACK;
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([
  [0, 'ModuleOpenCfg', { data: [{ moduleId: '每日跨服比拼', playerLevel: 20 }] }],
  [1, 'CrossRankParamCfg', { data: [{ paramName: '每日跨服比拼开启', paramValue: 8 }] }],
  [2, 'CrossRankSubjectCfg', { data: [{ subjectId: 4, name: '藏品培养' }] }],
]));
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { loadProtocol } = await import('../src/proto.mjs');
const { defaultSettings, createUsageLedger } = await import('../src/automation-settings.mjs');
const protocol = loadProtocol(), ids = ['rank-a', 'rank-b', 'rank-offline'];
saveStore({ activeId: ids[0], accounts: ids.map(id => ({ id, label: id, url: 'ws://invalid.invalid', login: {}, automation: { enabled: false, autoStart: false } })) });
fs.writeFileSync(path.join(directory, 'automation-settings.json'), JSON.stringify({ version: 1,
  accounts: Object.fromEntries(ids.map((id, index) => {
    const settings = defaultSettings(); settings.resources.keepAccelerators = 40 + index;
    return [id, { settings, revision: 3, savedAt: 'fixture' }];
  })),
}));
for (const id of ids) {
  const usage = createUsageLedger(id);
  usage.confirm(usage.reserve({ forgeStarts: 2 }, {}, {}, { uniqueKey: 'rank-read-sentinel:' + id }));
}
const app = createConsole({ port: 0, protocol });
const root = await app.listen();
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const api = async (account, suffix = 'activity-ranks/view?key=week-cross') => {
  const url = new URL('/api/' + suffix, root); url.searchParams.set('account', account);
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
};
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const error = result => { assert.notEqual(result.status, 200, JSON.stringify(result.body)); assert.equal(typeof result.body.error, 'string'); return result.body.error; };
const now = () => Math.floor(Date.now() / 1000);
const ownIds = ['9007199254740993', '9007199254740995'];
const rank = (playerId, placement, score) => ({ rank: placement, playerId, nickname: '角色' + placement, score, level: 40, avatar: {} });
function fixture(account, playerId) {
  const session = app.sessions.get(account), client = new EventEmitter(), calls = [];
  const state = { subjectId: 4, roomLevel: 3, grouping: false, settleTime: now() + 3600,
    rankList: [rank(ownIds[0], 2, '9007199254740993'), rank(ownIds[1], 1, 10000)] };
  const player = { playerId, worldId: '2000001', level: 40, worldOpenTime: now() - 20 * 86400 };
  Object.assign(client, { connected: true, serverClockOffsetMs: 0, stop() { this.connected = false; },
    async request(name, body, response) {
      assert.equal(name, 'CrossRankInfoRequest', '排名读取只能查询活动信息');
      assert.equal(response, 'CrossRankInfoResponse'); assert.deepEqual(body, {});
      calls.push(name); await client.beforeRead?.();
      if (client.failure) throw Error(client.failure);
      return protocol.CrossRankInfoResponse.decode(protocol.CrossRankInfoResponse.encode(state).finish());
    },
    sendWatch() { assert.fail('读取榜单不得发送游戏写操作'); },
  });
  session.client = client; session.player = player; session.paused = false;
  return { session, client, player, state, calls };
}
const persisted = () => ['automation-settings.json', 'automation-usage.json'].map(file => fs.readFileSync(path.join(directory, file), 'utf8'));

try {
  for (const account of ids) ok(await api(account, 'settings'));
  const a = fixture(ids[0], ownIds[0]), b = fixture(ids[1], ownIds[1]);
  const before = persisted();
  const preferences = ids.map(id => JSON.stringify(app.sessions.get(id).preferences));

  await test('HTTP按当前账号识别本人，精确返回超大ID和积分并按名次排序', async () => {
    const first = ok(await api(ids[0]));
    assert.equal(first.label, '军备竞赛'); assert.equal(first.status, 'active');
    assert.equal(first.subjectId, 4); assert.equal(first.subjectName, '藏品培养'); assert.equal(first.roomLevel, 3);
    assert.equal(first.settleTime, a.state.settleTime); assert.equal(first.endTime, a.state.settleTime);
    assert.deepEqual(first.rows.map(row => row.rank), [1, 2]);
    assert.equal(first.mine.playerId, ownIds[0]); assert.equal(first.mine.score, '9007199254740993');
    assert.equal(first.mine.scoreText, '9,007,199,254,740,993'); assert.equal(first.mine.own, true);
    assert.equal(first.mine.level, 40); assert.equal(first.mine.power, null);
    const second = ok(await api(ids[1]));
    assert.equal(second.mine.playerId, ownIds[1]); assert.equal(second.mine.score, 10000);
    assert.deepEqual(a.calls, ['CrossRankInfoRequest']); assert.deepEqual(b.calls, ['CrossRankInfoRequest']);
  });

  await test('空榜与分组、结算状态不沿用旧排名和本人积分', async () => {
    const list = a.state.rankList;
    a.state.rankList = [];
    const empty = ok(await api(ids[0])); assert.equal(empty.status, 'active'); assert.equal(empty.mine, null); assert.deepEqual(empty.rows, []);
    a.state.rankList = list; a.state.grouping = true;
    const grouping = ok(await api(ids[0])); assert.equal(grouping.status, 'grouping'); assert.equal(grouping.mine, null); assert.deepEqual(grouping.rows, []); assert.match(grouping.reason, /分组/);
    a.state.grouping = false; a.state.settleTime = now() - 1;
    const settled = ok(await api(ids[0])); assert.equal(settled.status, 'settled'); assert.equal(settled.mine, null); assert.deepEqual(settled.rows, []); assert.match(settled.reason, /结算|结束/);
    a.state.settleTime = now() + 3600;
  });

  await test('首赛季不足开放天数、低等级或未知区服不读取榜单', async () => {
    const original = { ...a.player }, count = a.calls.length;
    Object.assign(a.player, { worldId: '1000001', worldOpenTime: now() - 86400 });
    assert.match(error(await api(ids[0])), /未开放|暂不支持/);
    Object.assign(a.player, original, { level: 19 }); assert.match(error(await api(ids[0])), /未开放|暂不支持/);
    Object.assign(a.player, original, { worldId: '0' }); assert.match(error(await api(ids[0])), /未开放|暂不支持/);
    assert.equal(a.calls.length, count); Object.assign(a.player, original);
  });

  await test('未连接或暂停只提示连接状态，不自动登录和启动挂机', async () => {
    const offline = app.sessions.get(ids[2]);
    assert.equal(offline.client, null);
    assert.match(error(await api(ids[2])), /连接|登录|暂停/);
    assert.equal(offline.client, null); assert.equal(offline.connecting, null); assert.equal(offline.loop.running, false);
    const count = a.calls.length;
    a.session.paused = true; assert.match(error(await api(ids[0])), /连接|暂停/);
    a.session.paused = false; a.client.connected = false;
    assert.match(error(await api(ids[0])), /连接|登录/);
    assert.equal(a.session.client, a.client); assert.equal(a.session.connecting, null); assert.equal(a.calls.length, count);
    a.client.connected = true;
  });

  await test('单个账号请求失败不返回缓存榜单，也不影响另一个账号', async () => {
    a.client.failure = '模拟榜单读取失败';
    const failed = await api(ids[0]); assert.match(error(failed), /模拟榜单读取失败/);
    assert.equal(failed.body.mine, undefined); assert.equal(failed.body.rows, undefined);
    assert.equal(ok(await api(ids[1])).mine.playerId, ownIds[1]);
    delete a.client.failure;
    assert.equal(ok(await api(ids[0])).mine.playerId, ownIds[0]);
  });

  await test('读取期间账号连接代次变化后拒绝旧结果', async () => {
    a.client.beforeRead = () => { a.session.generation++; };
    const stale = await api(ids[0]); assert.match(error(stale), /连接|变化|暂停/);
    assert.equal(stale.body.mine, undefined); delete a.client.beforeRead;
    assert.equal(ok(await api(ids[1])).mine.playerId, ownIds[1]);
    assert.equal(ok(await api(ids[0])).mine.playerId, ownIds[0]);
  });

  await test('所有排名读取保持配置、用量账本与挂机状态不变', () => {
    assert.deepEqual(persisted(), before);
    assert.deepEqual(ids.map(id => JSON.stringify(app.sessions.get(id).preferences)), preferences);
    for (const id of ids) assert.equal(app.sessions.get(id).loop.running, false);
    assert([...a.calls, ...b.calls].every(name => name === 'CrossRankInfoRequest'));
  });
  console.log('军备竞赛排名HTTP专项 ' + passed + '/' + passed + ' 通过');
} finally {
  await app.close();
  if (previousData === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = previousData;
  if (previousPack === undefined) delete process.env.CW_CONFIG_PACK; else process.env.CW_CONFIG_PACK = previousPack;
  fs.rmSync(directory, { recursive: true, force: true });
}
