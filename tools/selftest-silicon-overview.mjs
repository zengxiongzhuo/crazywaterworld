// 隔离账号、真实 protobuf 往返；概览不得登录真实账号、派遣或改变账本。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-silicon-overview-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const { siliconFixture } = await import('./fixtures/silicon.mjs');
const { readSiliconOverview } = await import('../src/silicon-overview.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { PAGE } = await import('../src/page.mjs');
let passed = 0, app;
const read = (f, options) => readSiliconOverview(f.client, f.protocol, f.config, f.player, options);
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
try {
  await test('总览独立于自动化配置，只读取硅矿、舰队和联盟摘要', async () => {
    const f = siliconFixture(); f.state.fuel = 0; f.state.merge.matchMaking = true;
    const data = await read(f);
    assert.equal(data.mines.length, 3); assert.equal(data.fleets.length, 3); assert.equal(data.reason, '');
    assert.deepEqual([...new Set(f.client.reads.map(row => row.name))].sort(), ['AllGuildAbstractionRequest', 'ChipMineListRequest', 'ChipMineRequest', 'ChipMineRewardRequest', 'MyFleetsRequest']);
    assert.deepEqual(f.client.writes, []);
  });
  await test('真实联盟名称按64位联盟ID对应编号，无联盟和未同步分别展示', async () => {
    const f = siliconFixture(); f.occupy('1远征船'); f.enemy(1, '其他船长', 900, 8); f.enemy(2, '独行船长', 900, 0);
    const data = await read(f);
    assert.deepEqual(data.mines[2].positions.map(row => row.player.guildName), ['潮汐联盟', '深海联盟', '无联盟']);
    f.state.guilds[1].name = '';
    assert.equal((await read(f)).mines[2].positions[1].player.guildName, null);
  });
  await test('联盟空名或摘要缺项时使用当前场景主城默认名，自定义名优先', async () => {
    const f = siliconFixture(); f.occupy('1远征船'); f.enemy(1, '其他船长', 900, 8); f.enemy(2, '独行船长', 900, 0);
    f.config.tables['1_CityCfg'] = { data: [{ guildIndex: 7, name: '旧主城' }, { guildIndex: 8, name: '旧港口' }] };
    f.config.tables['2_CityCfg'] = { data: [{ guildIndex: 7, name: '新主城' }, { guildIndex: 8, name: '新港口' }] };
    f.player.scenarioId = 2; f.state.guilds[1].name = '   ';
    const players = (await read(f)).mines[2].positions.map(row => row.player);
    assert.deepEqual(players.map(p => p.guildName), ['潮汐联盟', '新港口', '无联盟']);
    assert.deepEqual(players.map(p => p.guildDefaultName), [false, true, false]);
    assert.deepEqual(players.map(p => p.relation), ['self', 'other', 'other']);
    f.state.guilds = [];
    assert.deepEqual((await read(f)).mines[2].positions.map(row => row.player.guildName), ['新主城', '新港口', '无联盟']);
    f.player.scenarioId = 0;
    assert.equal((await read(f)).mines[2].positions[1].player.guildName, '旧港口');
    f.player.scenarioId = 3;
    assert.equal((await read(f)).mines[2].positions[1].player.guildName, null, '不套用其他场景的主城名');
    assert.deepEqual(f.client.writes, []);
  });
  await test('联盟摘要失败或编号冲突仍可显示已知默认名，未知编号保留未同步', async () => {
    const f = siliconFixture(); f.enemy(0); f.enemy(1, '未知联盟船长', 900, 9);
    f.config.tables['1_CityCfg'] = { data: [{ guildIndex: 8, name: '默认港口' }] };
    f.beforeRead = name => { if (name === 'AllGuildAbstractionRequest') throw Error('模拟联盟读取失败'); };
    const data = await read(f);
    assert.equal(data.mines[2].positions[0].player.guildName, '默认港口');
    assert.equal(data.mines[2].positions[0].player.guildDefaultName, true);
    assert.equal(data.mines[2].positions[1].player.guildName, null);
    assert(data.notes.some(note => note.includes('联盟名称未同步')));
    f.beforeRead = null; f.state.guilds.push({ id: '8008', name: '同编号其他联盟' });
    assert.equal((await read(f)).mines[2].positions[0].player.guildName, '默认港口');
    assert.deepEqual(f.client.writes, []);
  });
  await test('联盟名称读取失败不影响矿位，重叠编号不猜测名称', async () => {
    const f = siliconFixture(); f.enemy(0);
    f.beforeRead = name => { if (name === 'AllGuildAbstractionRequest') throw Error('模拟联盟读取失败'); };
    const data = await read(f); assert.equal(data.mines[2].positions[0].player.guildName, null);
    assert.equal(data.mines[2].positions[0].player.guildIdx, 8); assert(data.notes.some(note => note.includes('联盟名称未同步')));
    f.beforeRead = null; f.state.guilds.push({ id: '8008', name: '同编号其他联盟' });
    assert.equal((await read(f)).mines[2].positions[0].player.guildName, null); assert.deepEqual(f.client.writes, []);
  });
  await test('初等矿按客户端三个个人位展示，原始大索引不当作个人位下标', async () => {
    const f = siliconFixture(); f.occupy('1远征船', 3000, 123, 2);
    const data = await read(f), mine = data.mines[0];
    assert.equal(mine.personal, true); assert.equal(mine.positionCount, 3); assert.equal(mine.empty, 2);
    assert.equal(mine.positions[0].index, 123); assert.equal(mine.positions[0].displayIndex, 0);
    assert.equal(data.fleets[0].slot, 1); assert.equal(data.fleets[0].retreatAllowed, true);
  });
  await test('公共矿占位、同盟和自己明确区分，奖励与抢占保留真实共享上限', async () => {
    const f = siliconFixture(); f.occupy('1远征船', 5000, 0, 4); f.enemy(1, '盟友', 5000, 7); f.enemy(2, '其他船长', 12000, 8);
    Object.assign(f.state.reward, { myRewardTimes: 20, maxRewardTimes: 130 }); f.state.fightTimes = 7; f.state.maxFightTimes = 40;
    const data = await read(f), mine = data.mines[2];
    assert.deepEqual(mine.positions.map(row => row.player.relation), ['self', 'ally', 'other']); assert.equal(mine.empty, 0);
    assert.equal(data.reward.remaining, 110); assert.deepEqual(data.fights, { used: 7, max: 40, remaining: 33 });
    assert.equal(data.fleets[0].endAt, f.state.fleets[0].chipWar.rewardTs); assert.equal(data.fleets[0].collected, 4);
  });
  await test('未完成首奖不能标为可撤回；抵达和维修使用各自服务器时间', async () => {
    const f = siliconFixture(); f.occupy('1远征船'); const now = Math.floor(Date.now() / 1000);
    Object.assign(f.state.fleets[1], { state: 2, targetGridIdx: 4000, moveEndTs: now + 300 });
    Object.assign(f.state.fleets[2], { state: 4, repairing: { startTs: now, endTs: now + 100, endDura: 2000 } });
    const data = await read(f);
    assert.equal(data.fleets[0].retreatAllowed, false);
    assert.equal(data.fleets[1].status, '前往硅矿'); assert.equal(data.fleets[1].timerKind, 'arrival'); assert.equal(data.fleets[1].endAt, now + 300);
    assert.equal(data.fleets[2].timerKind, 'repair'); assert.equal(data.fleets[2].endAt, now + 100);
  });
  await test('从游戏配置读取宝箱产出，不假设各矿奖励相同', async () => {
    const f = siliconFixture(); f.config.tables.ChipMineCfg.data[2].reward = [['紫芯片宝箱', 1], ['白芯片宝箱', 5]];
    const data = await read(f); assert.deepEqual(data.mines[2].rewards, [{ name: '紫芯片宝箱', num: 1 }, { name: '白芯片宝箱', num: 5 }]);
  });
  await test('矿位与舰队位置不同步时不推断可撤回', async () => {
    const f = siliconFixture(); f.occupy('1远征船', 5000, 0, 3); f.state.fleets[0].curGridIdx = 4000;
    assert.equal((await read(f)).fleets[0].retreatAllowed, null);
  });
  await test('矿区详情逐个读取，一个矿失败不抹掉其他矿和舰队', async () => {
    const f = siliconFixture(); let active = false;
    f.beforeRead = async (name, body) => {
      if (name !== 'ChipMineRequest') return;
      assert.equal(active, false); active = true; await new Promise(resolve => setTimeout(resolve, 5)); active = false;
      if (body.gridId === 4000) throw Error('模拟矿区超时');
    };
    const data = await read(f); assert.match(data.mines[1].reason, /模拟矿区超时/); assert.equal(data.mines[1].empty, null);
    assert.equal(data.mines[2].empty, 3); assert.equal(data.fleets.length, 3);
  });
  await test('奖励接口失败可由矿区详情补足；舰队失败不伪造空闲舰队', async () => {
    const f = siliconFixture(); f.beforeRead = name => { if (['ChipMineRewardRequest', 'MyFleetsRequest'].includes(name)) throw Error('模拟未同步'); };
    const data = await read(f); assert.equal(data.reward.max, 100); assert.equal(data.fleetsSynced, false); assert.deepEqual(data.fleets, []);
  });
  await test('读取期间跨奖励周期标为未同步，不拼接两周期计数', async () => {
    const f = siliconFixture(); f.beforeRead = (name, body) => { if (name === 'ChipMineRequest' && body.gridId === 4000) f.state.reward.rewardResetTime += 86400 * 3; };
    const data = await read(f); assert.equal(data.reward, null); assert(data.notes.some(note => note.includes('周期发生变化')));
  });
  await test('占领数不一致及超出安全整数的战力不被显示为空位或精确数值', async () => {
    const f = siliconFixture(); f.enemy(0, '大整数玩家', '9007199254740993');
    const data = await read(f); assert.match(data.mines[2].reason, /信息不完整/); assert.equal(data.mines[2].empty, null);
  });
  await test('未开放赛季不请求矿区；中途断连不再继续读取', async () => {
    const f = siliconFixture(); f.player.worldId = 1001001;
    assert.match((await read(f)).reason, /尚未开放/); assert.equal(f.client.reads.length, 0);
    f.player.worldId = 3001001; f.beforeRead = name => { if (name === 'ChipMineRequest') f.client.connected = false; };
    await assert.rejects(() => read(f), /账号连接/);
    assert.equal(f.client.reads.filter(row => row.name === 'ChipMineRequest').length, 1);
  });
  await test('概览位于世界概览之后，内嵌脚本均可解析', () => {
    assert(PAGE.indexOf('硅矿概览') > PAGE.indexOf('世界概览'));
    assert(PAGE.includes('id="silicon-refresh"')); assert(PAGE.includes('非今日收益'));
    for (const match of PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  });
  const f = siliconFixture();
  fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(f.config.tables).map(([name, table], index) => [index, name, table])));
  saveStore({ activeId: 'silicon-view', accounts: [{ id: 'silicon-view', label: '硅矿概览隔离测试', url: 'wss://invalid.invalid', login: {}, automation: { paused: true, enabled: false } }] });
  app = createConsole({ port: 0, protocol: f.protocol }); const base = await app.listen();
  await fetch(base + '/api/settings?account=silicon-view'); const session = app.sessions.get('silicon-view');
  const url = base + '/api/silicon/overview?account=silicon-view';
  await test('未连接或暂停时拒绝读取，不自动登录', async () => {
    assert.equal((await fetch(url)).ok, false); assert.equal(session.client, null);
    session.client = f.client; session.player = f.player;
    assert.equal((await fetch(url)).ok, false); assert.equal(f.client.reads.length, 0);
    session.paused = false;
  });
  await test('HTTP 重复刷新合并为一个读取，且响应不泄露玩家身份或凭证', async () => {
    let entered; const started = new Promise(resolve => { entered = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; });
    f.beforeRead = async name => { if (name === 'ChipMineListRequest') { entered(); await gate; } };
    const first = fetch(url); await started; const second = fetch(url); await new Promise(resolve => setTimeout(resolve, 30)); release();
    const responses = await Promise.all([first, second]); assert(responses.every(response => response.ok));
    const [a, b] = await Promise.all(responses.map(response => response.json())); assert.deepEqual(a, b);
    assert.equal(f.client.reads.filter(row => row.name === 'ChipMineListRequest').length, 1);
    assert(!JSON.stringify(a).includes(String(f.player.playerId))); assert.deepEqual(f.client.writes, []); f.beforeRead = null;
  });
  await test('HTTP 读取中连接代次变化，丢弃旧结果并释放合并请求', async () => {
    f.beforeRead = name => { if (name === 'ChipMineListRequest') session.generation++; };
    assert.equal((await fetch(url)).ok, false); assert.equal(session.siliconOverviewRead, null); f.beforeRead = null;
  });
  console.log('硅矿概览专项 ' + passed + '/' + passed + ' 通过');
} finally {
  if (app) { for (const session of app.sessions.values()) session.client = null; app.server.closeAllConnections(); await app.close(); }
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cw-silicon-overview-')) throw Error('拒绝清理意外目录');
  fs.rmSync(directory, { recursive: true, force: true });
}
