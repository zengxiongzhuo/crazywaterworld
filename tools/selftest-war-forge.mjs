import os from 'node:os';
// 城战与锻造专项：隔离目录、虚构账号、真实协议编解码，无真实游戏连接。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { warForgeFixture, warForgeSettings } from './fixtures/war-forge.mjs';
import { defaultSettings, validateSettings, importAutomationSettings, createUsageLedger, saveAutomationSettings, loadAutomationSettings } from '../src/automation-settings.mjs';
import { cityPetrolCost, readCityWar, planCityWar, runCityWar } from '../src/city-war.mjs';
import { readEquipmentForge, planEquipmentForge, releaseStaleEquipmentForge, runEquipmentForge } from '../src/equipment-forge.mjs';
import { readTreasureLoot, planTreasureLoot, runTreasureLoot } from '../src/treasure-loot.mjs';
import { runLoop } from '../src/loop.mjs';
import { exactAutomationId } from '../src/automation-policy.mjs';

const parent = path.join(os.tmpdir(),'cw-war-forge-test-runs');
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, 'run-')); process.env.CW_DATA_DIR = directory;
const results = []; let sequence = 0;
const ledger = (options = {}) => createUsageLedger('模拟账号', { file: path.join(directory, 'usage-' + (++sequence) + '.json'), ...options });
const check = async (name, action) => {
  try { await action(); results.push({ name, passed: true }); console.log('通过：' + name); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); }
};
const warRead = (f, s) => readCityWar(f.client, f.protocol, f.config, f.player, s.cityWar, { mapLoader: f.mapLoader });
const warPlan = async (f, s, usage = ledger()) => planCityWar(await warRead(f, s), s, { usage: usage.snapshot(), keys: usage.keyRecords(), pendingPetrol: (usage.pendingCounters().cityWarPetrol ?? 0) + (usage.pendingCounters().treasurePetrol ?? 0) });
const warRun = (f, s, usage = ledger(), options = {}) => runCityWar(f.client, f.protocol, f.config, f.player, { getSettings: () => s, ledger: usage, mapLoader: f.mapLoader, ...options });
const forgeRead = f => readEquipmentForge(f.client, f.protocol, f.config, f.player);
const forgePlan = async (f, s, usage = ledger()) => planEquipmentForge(await forgeRead(f), f.config, s, { usage: usage.snapshot(), keys: usage.keyRecords() });
const forgeRun = (f, s, usage = ledger(), options = {}) => runEquipmentForge(f.client, f.protocol, f.config, f.player, { getSettings: () => s, ledger: usage, ...options });

await check('场景2独立读取主城和费用，不回退场景1或通用表', async () => {
  const f=warForgeFixture(),s=warForgeSettings();f.player.scenarioId=2;
  f.config.tables['2_CityCfg']=structuredClone(f.config.tables['1_CityCfg']);
  f.config.tables['2_AttackCityConsumeCfg']={data:[{dist:1,cost:0.7}]};
  f.mapLoader=async scenario=>{assert.equal(scenario,2);return f.map;};
  const snapshot=await warRead(f,s),plan=await warPlan(f,s);
  assert.equal(snapshot.reason,'');assert.equal(snapshot.homeCityId,1);
  assert.equal(snapshot.targets[0].ref,'2:2');assert.equal(snapshot.targets[0].petrol,70);
  assert.equal(plan.actions.length,2);assert.equal(f.client.writes.length,0);
});
await check('缺少场景表时指出表名和同步办法，预览与执行均不派遣', async () => {
  for(const table of ['1_CityCfg','1_AttackCityConsumeCfg']) {
    const f=warForgeFixture(),s=warForgeSettings();
    f.config.tables[table.replace('1_','')]=f.config.tables[table];
    delete f.config.tables[table];
    const snapshot=await warRead(f,s);
    assert(snapshot.reason.includes(table),snapshot.reason);
    assert.match(snapshot.reason,/npm run sync-config/);
    assert.equal((await warPlan(f,s)).actions.length,0);
    await warRun(f,s);assert.equal(f.client.writes.length,0);
  }
});
await check('主城缺失明确区分场景和联盟编号，不冒用其他联盟主城', async () => {
  const f=warForgeFixture(),s=warForgeSettings();
  f.config.tables['1_CityCfg'].data[0].guildIndex=1;
  const snapshot=await warRead(f,s);
  assert.match(snapshot.reason,/场景 1.*联盟编号 7/);
  assert.match(snapshot.reason,/1_CityCfg/);
  assert.equal((await warPlan(f,s)).actions.length,0);
  await warRun(f,s);assert.equal(f.client.writes.length,0);
});
await check('补齐场景2配置后恢复计划和派遣，费用与结果仍回读确认', async () => {
  const f=warForgeFixture(),s=warForgeSettings();f.player.scenarioId=2;s.cityWar.fleetIds=['1远征船'];
  await warRun(f,s);assert.equal(f.client.writes.length,0);
  assert.match((await warRead(f,s)).reason,/2_CityCfg/);
  f.config.tables['2_CityCfg']=structuredClone(f.config.tables['1_CityCfg']);
  f.config.tables['2_AttackCityConsumeCfg']=structuredClone(f.config.tables['1_AttackCityConsumeCfg']);
  const usage=ledger(),result=await warRun(f,s,usage);
  assert.equal(result.results[0]?.status,'confirmed');
  assert.equal(f.client.writes.length,1);assert.equal(f.client.writes[0].name,'MoveFleetsToCityRequest');
  assert.equal(usage.snapshot().counters.cityWarDispatches,1);
  assert.equal(usage.snapshot().counters.cityWarPetrol,40);
});
await check('持续挂机在下一轮取得新费用配置，已开始的轮次保留原快照', async () => {
  const originalNow=Date.now;let time=originalNow();Date.now=()=>time;
  try {
    const f=warForgeFixture(),s=warForgeSettings();s.forge.enabled=false;s.cityWar.fleetIds=['1远征船'];
    const next={...f.config,tables:structuredClone(f.config.tables)};
    next.tables['1_AttackCityConsumeCfg'].data.forEach(row=>{row.cost*=2;});
    let current=f.config,reads=0;const costs=[];
    await runLoop(f.client,f.protocol,{config:f.config,refreshConfig:()=>{
      if(++reads===2){time+=15001;f.returnFleet('1远征船');f.state.fleets[0].durability=2000;}
      return current;
    },player:f.player,
      rounds:2,everyMs:60000,allowMutate:true,getSettings:()=>s,usageLedger:ledger(),isEnabled:()=>false,
      sleep:async ms=>{time+=Math.max(1,ms);},onRound:summary=>{
        costs.push(...summary.world.results.filter(entry=>entry.step?.kind==='cityDispatch').map(entry=>entry.step.cost));
        current=next;
      }});
    assert.equal(reads,2);assert.equal(costs.length,2);assert(costs[1]>costs[0],JSON.stringify(costs));
    assert.equal(f.config.tables['1_AttackCityConsumeCfg'].data[0].cost,0.4);
  } finally {Date.now=originalNow;}
});

await check('默认关闭、旧设置和版本1导入兼容且不写旧文件', () => {
  const original = defaultSettings(); delete original.cityWar; delete original.forge;
  const file = path.join(directory, 'old.json'); fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { a: { revision: 9, settings: original } } }));
  const before = fs.readFileSync(file); const loaded = loadAutomationSettings('a', { file });
  assert.equal(loaded.revision, 9); assert.equal(loaded.settings.cityWar.enabled, false); assert.equal(loaded.settings.forge.enabled, false);
  assert.deepEqual(loaded.settings.treasure, original.treasure); assert.deepEqual(fs.readFileSync(file), before);
  const imported = importAutomationSettings({ format: 'crazywaterword-automation', version: 1, settings: original });
  assert.equal(imported.cityWar.enabled, false); assert.equal(imported.forge.enabled, false);
  const bad = warForgeSettings(); bad.cityWar.fleetIds = []; assert.throws(() => validateSettings(bad), /舰队/);
  const badForge = warForgeSettings(); badForge.forge.recipeIds = []; assert.throws(() => validateSettings(badForge), /配方/);
  badForge.forge.recipeIds = ['1001']; badForge.forge.dailyLimit = 0; assert.throws(() => validateSettings(badForge), /1–1000/);
});
await check('关闭两功能不产生任何游戏请求', async () => {
  const f = warForgeFixture(), s = defaultSettings(); await warRun(f, s); await forgeRun(f, s);
  assert.equal(f.calls.length, 0); assert.equal(f.client.writes.length, 0);
});
await check('城战汽油按客户端错列坐标距离及场景档位计算', () => {
  const f = warForgeFixture(); assert.equal(cityPetrolCost(f.map, 1, 2, [{ dist: 1, cost: .4 }]), 40);
  assert.equal(cityPetrolCost(f.map, 1, 3, [{ dist: 1, cost: .4 }]), 25);
  assert.equal(cityPetrolCost(f.map, 1, 2, [{ dist: 1, cost: .4 }, { dist: 100, cost: .5 }]), 50);
  assert.equal(cityPetrolCost(f.map, 1, 99, [{ dist: 1, cost: .4 }]), null);
});
await check('城战读取期间新出现的首杀占用不能被旧空闲快照释放', async () => {
  const f = warForgeFixture(), s = warForgeSettings(), usage = ledger();
  s.cityWar.fleetIds = ['1远征船'];
  const key = 'pirate-first:' + f.player.worldId + ':1:1:201';
  const request = f.client.request;
  f.client.request = async (...args) => {
    const response = await request(...args);
    if (args[0] === 'MyFleetsRequest' && !usage.hasKey(key)) {
      const ticket = usage.reserve({ piratePetrol: 300 }, {}, {}, { uniqueKey: key,
        details: { kind: 'pirateFirst', world: String(f.player.worldId), buildingId: '1远征船', outcome: 'started' } });
      usage.confirm(ticket);
    }
    return response;
  };
  await warRun(f, s, usage);
  assert.notEqual(usage.keyRecords()[key].details.active, false);
  assert.equal(f.client.writes.length, 0);
});
await check('真实登录协议VIP额度动态读取，未用完不接续，不硬编码4', async () => {
  const f = warForgeFixture(), s = warForgeSettings();
  assert.equal((await warRead(f, s)).nativeLimit, 4); assert.equal((await warPlan(f, s)).actions.length, 2);
  f.player.vip.vipLevel = 4;
  assert.equal((await warRead(f, s)).nativeLimit, 6); assert.equal((await warPlan(f, s)).actions.length, 0);
  await warRun(f, s); assert.equal(f.client.writes.length, 0);
  for (const fleet of f.state.fleets) fleet.autoFight.todayTimes = 6;
  assert.equal((await warPlan(f, s)).actions.length, 2);
  delete f.player.vip;
  assert.equal((await warPlan(f, s)).actions.length, 0);
});
await check('原生委任设为0时关闭所选舰队开关再立即接续', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.cityWar.fleetIds=['1远征船'];s.cityWar.nativeCommissionLimit=0;
  f.state.fleets[0].autoFight={isOn:true,todayTimes:0};
  const plan=await warPlan(f,s);assert.deepEqual(plan.nativeOffFleetIds,['1远征船']);assert.equal(plan.actions.length,0);
  const result=await warRun(f,s,u);
  assert.deepEqual(f.client.writes.map(row=>row.name),['SetFleetAutoFightRequest','MoveFleetsToCityRequest']);
  assert.equal(f.state.fleets[0].autoFight.isOn,false);assert.equal(result.results[0].status,'confirmed');
  assert.match(result.notes.join(' '),/已关闭原生委任/);
});
await check('原生委任设为N时先用满N次再关闭开关接续，超过VIP额度按VIP', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.cityWar.fleetIds=['1远征船'];s.cityWar.nativeCommissionLimit=2;
  f.state.fleets[0].autoFight={isOn:true,todayTimes:1};
  let plan=await warPlan(f,s);assert.equal(plan.actions.length,0);assert.deepEqual(plan.nativeOffFleetIds,[]);
  assert.match(plan.fleets[0].reason,/尚余 1 次/);await warRun(f,s,u);assert.equal(f.client.writes.length,0);
  f.state.fleets[0].autoFight.todayTimes=2;plan=await warPlan(f,s);assert.deepEqual(plan.nativeOffFleetIds,['1远征船']);
  await warRun(f,s,u);assert.deepEqual(f.client.writes.map(row=>row.name),['SetFleetAutoFightRequest','MoveFleetsToCityRequest']);
  const g=warForgeFixture();s.cityWar.fleetIds=['1远征船'];s.cityWar.nativeCommissionLimit=99;
  g.state.fleets[0].autoFight={isOn:true,todayTimes:0};
  assert.match((await warPlan(g,s)).fleets[0].reason,/尚余 4 次/);assert.equal((await warPlan(g,s)).nativeOffFleetIds.length,0);
});
await check('原生委任关闭结果未确认时不派舰队', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.cityWar.fleetIds=['1远征船'];s.cityWar.nativeCommissionLimit=0;
  f.state.fleets[0].autoFight={isOn:true,todayTimes:0};f.ignoreNativeOff=true;
  const result=await warRun(f,s,u);
  assert.deepEqual(f.client.writes.map(row=>row.name),['SetFleetAutoFightRequest']);
  assert.match(result.notes.join(' '),/原生委任关闭结果待确认/);assert.equal(f.state.fleets[0].autoFight.isOn,true);
});
await check('原生委任设为0时不依赖VIP额度', async () => {
  const f=warForgeFixture(),s=warForgeSettings();s.cityWar.fleetIds=['1远征船'];s.cityWar.nativeCommissionLimit=0;
  delete f.player.vip;f.state.fleets[0].autoFight={isOn:true,todayTimes:0};
  assert.equal((await warRead(f,s)).nativeLimit,null);
  const plan=await warPlan(f,s);assert.deepEqual(plan.nativeOffFleetIds,['1远征船']);assert.equal(plan.actions.length,0);
  const result=await warRun(f,s,ledger());
  assert.equal(result.results[0]?.status,'confirmed');
  assert.deepEqual(f.client.writes.map(row=>row.name),['SetFleetAutoFightRequest','MoveFleetsToCityRequest']);
});
await check('城战时间、开服、合服、联盟和有效宣战目标均需满足', async () => {
  const changes = [
    f => { f.state.war.startTime += 10000; f.state.war.endTime += 10000; },
    f => { f.state.war.endTime = Math.floor(Date.now()/1000) - 1; f.state.war.startTime -= 10000; },
    f => { f.player.worldOpenTime = Math.floor(Date.now()/1000); },
    f => { f.state.merge.matchMaking = true; }, f => { f.state.guild.guild.guildId = '9007199254741008'; },
    f => { f.state.war.declarations = []; }, f => { f.state.cities[1].guildIdx = 7; }, f => { f.state.cities[1].guildIdx = 9; },
  ];
  for (const change of changes) { const f = warForgeFixture(), s = warForgeSettings(); change(f); await warRun(f, s); assert.equal(f.client.writes.length, 0); }
});
await check('联盟集结目标优先，指定城市不能越过场景或宣战范围', async () => {
  const f = warForgeFixture(), s = warForgeSettings();
  s.cityWar.targetPriority = 'original';
  f.state.war.declarations.push({ attackGuildIdx: 7, defenceGuildIdx: 8, cityId: 3 });
  assert((await warPlan(f, s)).actions.every(row => row.cityId === 2));
  s.cityWar.targetMode = 'selected'; s.cityWar.cityRefs = ['1:3'];
  assert((await warPlan(f, s)).actions.every(row => row.cityId === 3));
  s.cityWar.cityRefs = ['2:2']; assert.equal((await warPlan(f, s)).actions.length, 0);
});
await check('不抢占行军战斗维修排队巨轮驻外矿场或其他角色舰队', async () => {
  const changes = [f=>{f.state.fleets[0].state=2;}, f=>{f.state.fleets[0].state=3;}, f=>{f.state.fleets[0].state=4;}, f=>{f.state.fleets[0].state=5;},
    f=>{f.state.fleets[0].treasureLootUid=71;}, f=>{f.state.fleets[0].curGridIdx=20;}, f=>{f.state.fleets[0].chipWar={rewardTs:10};},
    f=>{f.state.fleets[0].owner.playerId='9007199254741999';}, f=>{f.state.buildings[0].fleet.formation.heroPositions=[];}];
  for (const change of changes) { const f=warForgeFixture(),s=warForgeSettings();s.cityWar.fleetIds=['1远征船'];change(f);await warRun(f,s);assert.equal(f.client.writes.length,0); }
});
await check('完整维修只检查实际汽油，旧保留/单次/每日限制不再拦截', async () => {
  const f=warForgeFixture(),s=warForgeSettings();s.cityWar.fleetIds=['1远征船'];f.state.fleets[0].durability=1000;
  const plan=await warPlan(f,s);assert.equal(plan.actions[0].request,'RepairFleetRequest');assert.equal(plan.actions[0].cost,2000);
  s.cityWar.maxRepairCost=1999;assert.equal((await warPlan(f,s)).actions.length,1);
  s.cityWar.maxRepairCost=3000;s.cityWar.dailyPetrolLimit=1999;assert.equal((await warPlan(f,s)).actions.length,1);
  s.cityWar.dailyPetrolLimit=5000;s.cityWar.petrolReserve=49000;assert.equal((await warPlan(f,s)).actions.length,1);
  f.state.fuel=1999;assert.equal((await warPlan(f,s)).actions.length,0);f.state.fuel=2000;assert.equal((await warPlan(f,s)).actions.length,1);
  s.cityWar.petrolReserve=0;s.cityWar.autoRepair=false;assert.equal((await warPlan(f,s)).actions.length,0);
});
await check('城战派遣确认、防重复与返航后继续接续', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.cityWar.fleetIds=['1远征船'];
  assert.equal((await warRun(f,s,u)).results[0].status,'confirmed');
  await warRun(f,s,u);assert.equal(f.client.writes.length,1);
  f.returnFleet('1远征船');await warRun(f,s,u);assert.equal(f.client.writes.length,2);assert.equal(u.snapshot().counters.cityWarDispatches,2);
  assert(f.client.writes.every(row=>row.name==='MoveFleetsToCityRequest'));
});
await check('维修确认后等待完成，完成后出战且不篡改委任开关', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.cityWar.fleetIds=['1远征船'];f.state.fleets[0].durability=900;
  assert.equal((await warRun(f,s,u)).results[0].status,'confirmed');await warRun(f,s,u);assert.equal(f.client.writes.length,1);
  f.finishRepair('1远征船');await warRun(f,s,u);assert.deepEqual(f.client.writes.map(row=>row.name),['RepairFleetRequest','MoveFleetsToCityRequest']);
  assert.equal(f.state.fleets[0].autoFight.isOn,true);
});
await check('城战未知结果跨重建与换日保留预算和舰队锁定', async () => {
  let now=Date.UTC(2026,10,3,15,59,59);const file=path.join(directory,'war-midnight.json');
  const f=warForgeFixture(),s=warForgeSettings();s.cityWar.fleetIds=['1远征船'];f.unknown=true;
  let u=createUsageLedger('a',{file,now:()=>now});await warRun(f,s,u);assert.equal(u.snapshot().uncertain,1);
  now+=3000;u=createUsageLedger('a',{file,now:()=>now});await warRun(f,s,u);
  assert.equal(f.client.writes.length,1);assert.equal(u.pendingCounters().cityWarPetrol,40);
  assert.equal(u.snapshot().counters.cityWarDispatches??0,0);
  f.state.fleets[0].state=2;f.state.fleets[0].targetCityId=2;await warRun(f,s,u);assert.equal(u.snapshot().uncertain,0);
});
await check('城战明确拒绝释放预约，暂停或目标变化时不发送', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.cityWar.fleetIds=['1远征船'];f.reject=true;
  assert.equal((await warRun(f,s,u)).results[0].status,'rejected');assert.equal(u.pendingCounters().cityWarPetrol??0,0);
  await warRun(f,s,u);assert.equal(f.client.writes.length,1,'明确拒绝后不立即重复打同一目标');
  const g=warForgeFixture();await warRun(g,s,ledger(),{enabled:()=>false});assert.equal(g.calls.length,0);
  let reads=0;g.beforeRead=name=>{if(name==='WarDeclarationRequest'&&++reads===2)g.state.war.declarations=[];};
  await warRun(g,s);assert.equal(g.client.writes.length,0);
});
await check('城战与巨轮共用舰队锁定及未知汽油预算', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.cityWar.fleetIds=['1远征船'];f.unknown=true;await warRun(f,s,u);
  Object.assign(s.treasure,{enabled:true,autoJoin:true,fleetIds:['1远征船','2远征船'],petrolReserve:0});
  const snap=await readTreasureLoot(f.client,f.protocol,f.config,f.player);
  const plan=planTreasureLoot(snap,f.config,s,{keys:u.keyRecords(),pendingFuel:u.pendingCounters().cityWarPetrol});
  assert.equal(plan.actions.length,1);assert.equal(plan.actions[0].body.fleetBuildingIds[0],'2远征船');
  const war=await warPlan(f,s,u);assert(war.reservedFleetIds.includes('1远征船'));
});
await check('巨轮未知结果反向阻止同队城战出征与维修，包括发送前新出现的锁', async () => {
  for (const durability of [2000, 900]) {
    const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.cityWar.fleetIds=['1远征船'];f.state.fleets[0].durability=durability;
    u.reserve({treasureDispatches:1,treasurePetrol:500},{},{},{uniqueKey:'treasure:1001001:71:1'});
    const plan=await warPlan(f,s,u);assert.equal(plan.actions.length,0);assert.match(plan.fleets[0].reason,/巨轮派遣结果待确认/);
    await warRun(f,s,u);assert.equal(f.client.writes.length,0);
  }
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.cityWar.fleetIds=['1远征船'];let reads=0;
  f.beforeRead=name=>{if(name==='MyFleetsRequest'&&++reads===2)u.reserve({treasurePetrol:500},{},{},{uniqueKey:'treasure:1001001:71:1'});};
  await warRun(f,s,u);assert.equal(f.client.writes.length,0);
});
await check('读取期间城战结束或VIP额度增加时，不沿用旧窗口和旧额度出征', async () => {
  for(const change of ['time','vip']){
    const f=warForgeFixture(),s=warForgeSettings();s.cityWar.fleetIds=['1远征船'];let reads=0;
    f.beforeRead=name=>{if(name==='MyFleetsRequest'&&++reads===2){if(change==='time')f.client.serverClockOffsetMs=7200000;else f.player.vip.vipLevel=4;}};
    await warRun(f,s);assert.equal(f.client.writes.length,0,change);
  }
});
await check('锻造真实协议材料金币与配方赛季校验', async () => {
  const f=warForgeFixture(),s=warForgeSettings();let plan=await forgePlan(f,s);
  assert.equal(plan.actions.length,1);assert.deepEqual(plan.actions[0].costs,[{id:'GOLD',num:2000},{id:'蓝武器材料',num:40}]);
  s.forge.recipeIds=['1002'];assert.equal((await forgePlan(f,s)).actions.length,0);
  s.forge.recipeIds=['1001'];f.state.gold=1999;assert.equal((await forgePlan(f,s)).actions.length,0);
  f.state.gold=100000;s.forge.materialReserve=370;assert.equal((await forgePlan(f,s)).actions.length,0);
});
await check('万能材料仅补不足，不能绕过普通材料保留量', async () => {
  const f=warForgeFixture(),s=warForgeSettings();f.state.materials.蓝武器材料=30;
  assert.equal((await forgePlan(f,s)).actions.length,0);s.forge.universal=true;
  const plan=await forgePlan(f,s);assert(plan.actions[0].body.universal);assert.deepEqual(plan.actions[0].costs.at(-1),{id:'蓝装材料自选包',num:10});
  s.forge.materialReserve=1;assert.equal((await forgePlan(f,s)).actions.length,0);
  s.forge.materialReserve=0;s.forge.universalReserve=95;assert.equal((await forgePlan(f,s)).actions.length,0);
});
await check('锻造开始确认，制作中不重复，入库后才继续下一件', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();
  assert.equal((await forgeRun(f,s,u)).results.at(-1).status,'confirmed');await forgeRun(f,s,u);assert.equal(f.client.writes.length,1);
  f.finishForge();assert.equal(f.state.equipment.length,1,'时间推进本身不能生成仓库装备');
  const next=await forgeRun(f,s,u);assert(next.results.some(row=>row.step.kind==='forgeClaim'&&row.status==='confirmed'));
  assert.deepEqual(f.client.writes.map(row=>row.name),['MakeEquipRequest','PickMadeEquipRequest','MakeEquipRequest']);
  assert.equal(f.state.equipment.length,2);
  assert.equal(u.snapshot().counters.forgeStarts,2);assert.equal(u.snapshot().counters.forgeGold,4000);
});
await check('锻造次数预算、金币预算、原生自动和工厂占用均约束', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.forge.dailyLimit=1;
  await forgeRun(f,s,u);f.finishForge();await forgeRun(f,s,u);
  assert.deepEqual(f.client.writes.map(row=>row.name),['MakeEquipRequest','PickMadeEquipRequest'],'每日下单上限不阻断已完成装备领取');
  const g=warForgeFixture();s.forge.dailyLimit=5;s.forge.dailyGoldLimit=1999;assert.equal((await forgePlan(g,s)).actions.length,0);
  s.forge.dailyGoldLimit=100000;g.state.factory.auto=true;assert.equal((await forgePlan(g,s)).actions.length,0);
  g.state.factory.auto=false;g.state.factory.level=0;assert.equal((await forgePlan(g,s)).actions.length,0);
});
await check('锻造未知结果跨重建不重发，明确拒绝释放预算', async () => {
  const file=path.join(directory,'forge-unknown.json');const f=warForgeFixture(),s=warForgeSettings();f.unknown=true;
  await forgeRun(f,s,createUsageLedger('a',{file}));await forgeRun(f,s,createUsageLedger('a',{file}));
  assert.equal(f.client.writes.length,1);assert.equal(createUsageLedger('a',{file}).pendingCounters().forgeGold,2000);
  const g=warForgeFixture(),u=ledger();g.reject=true;await forgeRun(g,s,u);assert.equal(u.pendingCounters().forgeGold??0,0);assert.equal(u.snapshot().counters.forgeStarts??0,0);
});
await check('暂停或设置变更发生在锻造复核中时不发送', async () => {
  const f=warForgeFixture(),s=warForgeSettings();let read=0;
  f.beforeRead=name=>{if(name==='OnWaterRequest'&&++read===2)s.forge.enabled=false;};
  await forgeRun(f,s);assert.equal(f.client.writes.length,0);
  const g=warForgeFixture();s.forge.enabled=true;await forgeRun(g,s,ledger(),{enabled:()=>false});assert.equal(g.calls.length,0);
});
await check('真实协议超大或负库存拒绝锻造，不把Long转为不精确数量', async () => {
  for (const amount of ['9007199254740993','-1']) {const f=warForgeFixture(),s=warForgeSettings();f.state.materials.蓝武器材料=amount;assert.equal((await forgePlan(f,s)).actions.length,0);await forgeRun(f,s);assert.equal(f.client.writes.length,0);}
});
await check('同账号并发运行合并为一轮，不重复出战或下单', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.cityWar.fleetIds=['1远征船'];
  await Promise.all([warRun(f,s,u),warRun(f,s,u)]);assert.equal(f.client.writes.length,1);
  await Promise.all([forgeRun(f,s,u),forgeRun(f,s,u)]);assert.equal(f.client.writes.filter(row=>row.name==='MakeEquipRequest').length,1);
});
await check('开始时未揭示随机产出仍可确认任务，旧同款装备不冒充新产出', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();
  f.state.equipment[0].equipId='测试武器';f.state.equipment[0].star=2;
  const send=f.client.sendWatch;f.client.sendWatch=async(name,body)=>{await send(name,body);if(name==='MakeEquipRequest')f.state.factory.equipMaking.equipId='';};
  assert.equal((await forgeRun(f,s,u)).results.at(-1).status,'confirmed');
  f.finishForge();f.claimStale=true;
  await forgeRun(f,s,u);assert.equal(f.client.writes.length,2,'只发领取，不用旧同款UID冒充产出后下单');
  assert.equal(u.snapshot().uncertain,1);
  f.deliverForge();await forgeRun(f,s,u);
  assert.deepEqual(f.client.writes.map(row=>row.name),['MakeEquipRequest','PickMadeEquipRequest','MakeEquipRequest']);
});
await check('开工回读缺少星级后由外部领取，仍能用新装备UID核销锻造记录', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();
  const send=f.client.sendWatch;
  f.client.sendWatch=async (name, body) => {
    await send(name, body);
    if (name === 'MakeEquipRequest') f.state.factory.equipMaking.star = -1;
  };
  await forgeRun(f,s,u);
  const started=u.keyRecords()['forge:1001001:1'];
  assert.equal(started.confirmed,true);
  assert.equal(started.details.equipId,'测试武器','即使星级缺失也应保留已知产出类型');
  assert.equal(Number.isSafeInteger(started.details.star),false);
  f.finishForge();
  f.state.equipment.push({uid:'9007199254743001',equipId:'测试武器',star:2,level:0});
  f.state.factory.equipMaking=null;
  await forgeRun(f,s,u);
  const restarted=u.keyRecords()['forge:1001001:1'];
  assert(restarted && restarted.id !== started.id,'外部领取后的新UID应先释放旧记录，再创建新的锻造记录');
  assert(restarted.details.beforeUids.includes('9007199254743001'));
  assert.equal(f.client.writes.filter(row=>row.name==='MakeEquipRequest').length,2,'核销后应能继续安排下一件');
});
await check('开工未返回产出字段时，唯一新装备UID仍可核销外部领取', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();
  const send=f.client.sendWatch;
  f.client.sendWatch=async (name, body) => {
    await send(name, body);
    if (name === 'MakeEquipRequest') {
      f.state.factory.equipMaking.equipId = '';
      f.state.factory.equipMaking.star = -1;
    }
  };
  await forgeRun(f,s,u);
  const started=u.keyRecords()['forge:1001001:1'];
  assert.equal(started.confirmed,true);
  assert.equal(started.details.equipId,undefined);
  f.finishForge();
  f.state.equipment.push({uid:'9007199254743002',equipId:'测试武器',star:2,level:0});
  f.state.factory.equipMaking=null;
  await forgeRun(f,s,u);
  const restarted=u.keyRecords()['forge:1001001:1'];
  assert(restarted && restarted.id !== started.id,'唯一新装备应核销旧记录后继续锻造');
  assert(restarted.details.beforeUids.includes('9007199254743002'));
});
await check('空闲且产物已在工具外处理时，用户确认可解除旧锻造记录', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();
  await forgeRun(f,s,u);
  const active=await forgeRead(f);
  assert.throws(() => releaseStaleEquipmentForge(active,u,'1装备厂'),/仍有锻造批次/);
  f.finishForge();
  f.state.factory.equipMaking=null;
  const result=releaseStaleEquipmentForge(await forgeRead(f),u,'1装备厂');
  assert.equal(result.status,'released');
  assert.equal(u.keyRecords()['forge:1001001:1'],undefined);
  assert.equal(u.snapshot().counters.forgeStarts,1);
  assert.equal(u.snapshot().counters.forgeGold,2000);
});
await check('游戏内部分加速改变完成时间后，自动领取并继续下一件', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  await forgeRun(f, settings, usage);
  const original = usage.keyRecords()['forge:1001001:1'];
  assert.equal(original.confirmed, true);
  f.state.factory.equipMaking.finishTime -= 5;
  f.finishForge();

  const result = await forgeRun(f, settings, usage);
  assert(result.results.some(row => row.step.kind === 'forgeClaim' && row.status === 'confirmed'));
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest', 'PickMadeEquipRequest', 'MakeEquipRequest']);
  assert.notEqual(usage.keyRecords()['forge:1001001:1'].id, original.id);
  assert.equal(usage.snapshot().counters.forgeStarts, 2);
  assert.equal(usage.snapshot().counters.forgeGold, 4000);
});
await check('已确认产物在游戏内领取分解后，重建账本仍按空闲工厂接续并保留消耗', async () => {
  const file = path.join(directory, 'forge-external-disposed.json');
  const f = warForgeFixture(), settings = warForgeSettings();
  let usage = createUsageLedger('a', { file });
  await forgeRun(f, settings, usage);
  const original = usage.keyRecords()['forge:1001001:1'];
  f.finishForge();
  // 外部领取并分解后，新产物已经消失，完整仓库与开工前相同。
  f.state.factory.equipMaking = null;
  usage = createUsageLedger('a', { file });

  const result = await forgeRun(f, settings, usage);
  assert.equal(result.results.at(-1).status, 'confirmed');
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest', 'MakeEquipRequest']);
  assert.notEqual(usage.keyRecords()['forge:1001001:1'].id, original.id);
  assert.equal(usage.snapshot().counters.forgeStarts, 2);
  assert.equal(usage.snapshot().counters.forgeGold, 4000);
  assert.equal(usage.confirmedCounters().forgeGold, 4000);
  assert.equal(f.state.equipment.length, 1);
});
await check('游戏内领取旧产物后重开不同配方，工具领取当前批次并按配置续产', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  f.config.tables.BuildingEquipMakeCfg.data.push({
    ...f.config.tables.BuildingEquipMakeCfg.data[0], makeId: 1003, type: '护甲',
  });
  await forgeRun(f, settings, usage);
  f.finishForge();
  // 旧产物已在游戏内处理，现在看到的是另一件已完成的装备。
  f.state.factory.equipMaking = {
    makeId: 1003,
    finishTime: Math.floor((Date.now() + f.client.serverClockOffsetMs) / 1000) - 1,
    equipId: '测试护甲',
    star: 3,
  };

  const result = await forgeRun(f, settings, usage);
  assert(result.results.some(row => row.step.kind === 'forgeClaim' && row.step.makeId === 1003 && row.status === 'confirmed'));
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest', 'PickMadeEquipRequest', 'MakeEquipRequest']);
  assert.equal(f.client.writes.at(-1).body.makeId, 1001);
  assert(f.state.equipment.some(row => row.equipId === '测试护甲' && row.star === 3));
  assert.equal(usage.snapshot().counters.forgeStarts, 2);
  assert.equal(usage.snapshot().counters.forgeGold, 4000);
});
await check('游戏内原生自动处理旧批次期间工具等待，关闭原生自动后接续', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  await forgeRun(f, settings, usage);
  f.finishForge();
  f.state.factory.auto = true;
  f.state.factory.equipMaking = null;
  const native = await forgeRun(f, settings, usage);
  assert(native.notes.some(note => note.includes('游戏原生自动锻造已开启')));
  assert.equal(f.client.writes.length, 1);
  assert.equal(usage.snapshot().counters.forgeGold, 2000);

  f.state.factory.auto = false;
  await forgeRun(f, settings, usage);
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest', 'MakeEquipRequest']);
  assert.equal(usage.snapshot().counters.forgeStarts, 2);
  assert.equal(usage.snapshot().counters.forgeGold, 4000);
});
await check('真实协议省略星级时不记录默认0，兼容已保存默认0的外部领取记录', async () => {
  for (const legacy of [false, true]) {
    const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
    const sendWatch = f.client.sendWatch;
    f.client.sendWatch = async (name, body) => {
      await sendWatch(name, body);
      if (name === 'MakeEquipRequest') delete f.state.factory.equipMaking.star;
    };
    await forgeRun(f, settings, usage);
    const original = usage.keyRecords()['forge:1001001:1'];
    const state = await forgeRead(f);
    assert.equal(Object.hasOwn(state.buildings[0].equipMaking, 'star'), false);
    assert.equal(state.buildings[0].equipMaking.star, 0);
    assert.equal(Number.isSafeInteger(original.details.star), false, '原型默认值不能成为已知产物星级');
    if (legacy) usage.updateKeyDetails('forge:1001001:1', { ...original.details, star: 0 });

    f.finishForge();
    f.state.equipment.push({ uid: '9007199254743001', equipId: '测试武器', star: 2, level: 0 });
    f.state.factory.equipMaking = null;
    await forgeRun(f, settings, usage);
    assert.notEqual(usage.keyRecords()['forge:1001001:1'].id, original.id);
    assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest', 'MakeEquipRequest']);
    assert.equal(usage.snapshot().counters.forgeGold, 4000);
  }
});
await check('未知开工不凭超时或单次空闲恢复，跨断线和账本重建仍保留预算', async () => {
  const file = path.join(directory, 'forge-unknown-idle-reconnect.json');
  const f = warForgeFixture(), settings = warForgeSettings();
  let usage = createUsageLedger('a', { file });
  f.unknown = true;
  await forgeRun(f, settings, usage);
  const original = usage.keyRecords()['forge:1001001:1'];
  assert.equal(original.confirmed, false);
  assert.equal(f.state.factory.equipMaking, undefined);
  f.unknown = false;
  await forgeRun(f, settings, usage);
  f.client.connected = false;
  f.client.serverClockOffsetMs = 48 * 60 * 60 * 1000;
  usage = createUsageLedger('a', { file });
  f.client.connected = true;
  await forgeRun(f, settings, usage);
  await forgeRun(f, settings, usage);

  assert.equal(usage.keyRecords()['forge:1001001:1'].id, original.id);
  assert.equal(usage.keyRecords()['forge:1001001:1'].confirmed, false);
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest']);
  assert.equal(usage.pendingCounters().forgeStarts, 1);
  assert.equal(usage.pendingCounters().forgeGold, 2000);
  assert.equal(usage.snapshot().counters.forgeGold, 2000);
});
await check('外部已处理批次接续时暂停阻止发送，恢复后的并发只开工一次', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  await forgeRun(f, settings, usage);
  f.finishForge();
  f.state.factory.equipMaking = null;
  let reads = 0, enabled = true;
  f.beforeRead = name => {
    if (name === 'OnWaterRequest' && ++reads === 2) enabled = false;
  };
  await forgeRun(f, settings, usage, { enabled: () => enabled });
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest']);
  assert.equal(usage.snapshot().counters.forgeGold, 2000);

  f.beforeRead = null;
  await Promise.all([forgeRun(f, settings, usage), forgeRun(f, settings, usage)]);
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest', 'MakeEquipRequest']);
  assert.equal(usage.snapshot().counters.forgeStarts, 2);
  assert.equal(usage.snapshot().counters.forgeGold, 4000);
});
await check('领取前已有完成批次也可收取，金币预算不足仍不阻断免费领取', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();s.forge.dailyGoldLimit=1;
  f.state.factory.equipMaking={makeId:1001,finishTime:Math.floor(Date.now()/1000)-5,equipId:'测试武器',star:2};
  const result=await forgeRun(f,s,u);
  assert.equal(result.results[0].status,'confirmed');assert.deepEqual(f.client.writes.map(row=>row.name),['PickMadeEquipRequest']);
  assert.equal(u.snapshot().counters.forgeStarts??0,0);assert.equal(u.snapshot().counters.forgeGold??0,0);
});
await check('领取未知跨午夜和重建不重发，后续新UID确认后才继续下单', async () => {
  let now=Date.UTC(2026,10,3,15,59,59);const file=path.join(directory,'forge-claim-midnight.json');
  const f=warForgeFixture(),s=warForgeSettings();let u=createUsageLedger('a',{file,now:()=>now});
  await forgeRun(f,s,u);f.finishForge();f.claimStale=true;await forgeRun(f,s,u);assert.equal(u.snapshot().uncertain,1);
  now+=3000;u=createUsageLedger('a',{file,now:()=>now});await forgeRun(f,s,u);assert.equal(f.client.writes.filter(row=>row.name==='PickMadeEquipRequest').length,1);
  f.deliverForge();await forgeRun(f,s,u);assert.equal(u.snapshot().uncertain,0);assert.equal(f.client.writes.filter(row=>row.name==='MakeEquipRequest').length,2);
  assert.equal(u.snapshot().counters.forgeStarts,1,'前一天已确认的下单不重计到新一天');
});
await check('领取空回包需真实入库证据，明确拒绝不撤销已花的锻造预算', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();await forgeRun(f,s,u);f.finishForge();f.omitClaimReply=true;
  assert((await forgeRun(f,s,u)).results.some(row=>row.step.kind==='forgeClaim'&&row.status==='confirmed'));
  const g=warForgeFixture(),v=ledger();await forgeRun(g,s,v);g.finishForge();g.reject=true;
  assert.equal((await forgeRun(g,s,v)).results[0].status,'rejected');assert.equal(v.snapshot().counters.forgeStarts,1);assert.equal(v.snapshot().counters.forgeGold,2000);
  assert.equal(v.snapshot().uncertain,0);await forgeRun(g,s,v);assert.equal(g.client.writes.filter(row=>row.name==='PickMadeEquipRequest').length,1);
});
await check('另一世界未决锻造不扣减当前世界材料和金币', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  const otherKey = 'forge:2001001:1';
  usage.reserve({ forgeStarts: 1, forgeGold: 2000 }, {}, {}, { uniqueKey: otherKey,
    details: { kind: 'forgeStart', buildingId: '1装备厂', costs: [{ id: '蓝武器材料', num: 400 }, { id: 'GOLD', num: 100000 }] } });
  const other = usage.keyRecords()[otherKey];
  const preview = await forgePlan(f, settings, usage);
  assert.equal(preview.actions.length, 1, JSON.stringify(preview.notes));
  assert.equal((await forgeRun(f, settings, usage)).results.at(-1).status, 'confirmed');
  assert.deepEqual(usage.keyRecords()[otherKey], other);
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest']);
});
await check('同世界其他角色未决开工保留原键，当前角色使用独立键且重建账本不重复开工', async () => {
  const file = path.join(directory, 'forge-same-world-roles.json');
  const previous = warForgeFixture(), current = warForgeFixture(), settings = warForgeSettings();
  let usage = createUsageLedger('shared-account', { file });
  previous.unknown = true;
  await forgeRun(previous, settings, usage);
  const legacyKey = 'forge:1001001:1';
  const foreignRecord = usage.keyRecords()[legacyKey];
  assert.equal(foreignRecord.confirmed, false);
  assert.equal(foreignRecord.details.playerId, exactAutomationId(previous.player.playerId));
  assert.equal(exactAutomationId(previous.player.worldId), exactAutomationId(current.player.worldId));

  await forgeRun(current, settings, usage);
  const scopedKey = legacyKey + ':' + exactAutomationId(current.player.playerId);
  const currentRecord = usage.keyRecords()[scopedKey];
  assert.equal(currentRecord.confirmed, true);
  assert.equal(currentRecord.details.playerId, exactAutomationId(current.player.playerId));
  assert.deepEqual(usage.keyRecords()[legacyKey], foreignRecord);
  assert.equal(usage.pendingCounters().forgeGold, 2000);
  assert.equal(usage.confirmedCounters().forgeGold, 2000);
  assert.equal(usage.snapshot().counters.forgeGold, 4000);

  usage = createUsageLedger('shared-account', { file });
  await forgeRun(current, settings, usage);
  assert.deepEqual(usage.keyRecords()[legacyKey], foreignRecord);
  assert.equal(usage.keyRecords()[scopedKey].id, currentRecord.id);
  assert.deepEqual(current.client.writes.map(row => row.name), ['MakeEquipRequest']);
  previous.unknown = false;
  const returned = await forgeRun(previous, settings, usage);
  assert(returned.notes.some(note => note.includes('上次下单结果待确认')));
  assert.deepEqual(usage.keyRecords()[legacyKey], foreignRecord);
  assert.equal(usage.keyRecords()[scopedKey].id, currentRecord.id);
  assert.deepEqual(previous.client.writes.map(row => row.name), ['MakeEquipRequest']);
  assert.equal(usage.pendingCounters().forgeGold, 2000);
  assert.equal(usage.snapshot().counters.forgeGold, 4000);
});
await check('同世界其他角色待确认领取保留，当前角色用独立领取键完成领取和续产', async () => {
  const previous = warForgeFixture(), current = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  await forgeRun(previous, settings, usage);
  previous.finishForge();
  previous.claimStale = true;
  await forgeRun(previous, settings, usage);
  const foreignStartKey = 'forge:1001001:1', foreignClaimKey = 'forgeClaim:1001001:1';
  const foreignStart = usage.keyRecords()[foreignStartKey], foreignClaim = usage.keyRecords()[foreignClaimKey];
  assert.equal(foreignStart.confirmed, true);
  assert.equal(foreignClaim.confirmed, false);
  current.state.factory.equipMaking = {
    makeId: 1001, finishTime: Math.floor(Date.now() / 1000) - 5, equipId: '测试武器', star: 2,
  };
  const playerId = exactAutomationId(current.player.playerId);
  const scopedClaimKey = foreignClaimKey + ':' + playerId;
  let observedScopedClaim = false;
  current.beforeSend = name => {
    if (name !== 'PickMadeEquipRequest') return;
    assert.equal(usage.keyRecords()[scopedClaimKey].details.playerId, playerId);
    assert.deepEqual(usage.keyRecords()[foreignClaimKey], foreignClaim);
    observedScopedClaim = true;
  };

  const result = await forgeRun(current, settings, usage);
  assert(observedScopedClaim);
  assert(result.results.some(row => row.step.uniqueKey === scopedClaimKey && row.status === 'confirmed'));
  assert.deepEqual(current.client.writes.map(row => row.name), ['PickMadeEquipRequest', 'MakeEquipRequest']);
  assert.equal(usage.hasKey(scopedClaimKey), false);
  assert.equal(usage.keyRecords()[foreignStartKey + ':' + playerId].confirmed, true);
  assert.deepEqual(usage.keyRecords()[foreignStartKey], foreignStart);
  assert.deepEqual(usage.keyRecords()[foreignClaimKey], foreignClaim);
  assert.equal(usage.snapshot().uncertain, 1);
  assert.equal(usage.snapshot().counters.forgeStarts, 2);
  assert.equal(usage.snapshot().counters.forgeGold, 4000);
  assert.equal(usage.confirmedCounters().forgeGold, 4000);
});
await check('返回同世界原角色仍核对原始锻造键，领取续产不改其他角色独立记录', async () => {
  const previous = warForgeFixture(), current = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  await forgeRun(previous, settings, usage);
  const legacyKey = 'forge:1001001:1';
  const previousRecord = usage.keyRecords()[legacyKey];
  await forgeRun(current, settings, usage);
  const scopedKey = legacyKey + ':' + exactAutomationId(current.player.playerId);
  const currentRecord = usage.keyRecords()[scopedKey];
  previous.finishForge();

  const result = await forgeRun(previous, settings, usage);
  assert(result.results.some(row => row.step.kind === 'forgeClaim' && row.step.uniqueKey === 'forgeClaim:1001001:1' && row.status === 'confirmed'));
  assert.deepEqual(previous.client.writes.map(row => row.name), ['MakeEquipRequest', 'PickMadeEquipRequest', 'MakeEquipRequest']);
  assert.notEqual(usage.keyRecords()[legacyKey].id, previousRecord.id);
  assert.equal(usage.keyRecords()[legacyKey].details.playerId, exactAutomationId(previous.player.playerId));
  assert.equal(usage.hasKey(legacyKey + ':' + exactAutomationId(previous.player.playerId)), false);
  assert.deepEqual(usage.keyRecords()[scopedKey], currentRecord);
  assert.deepEqual(current.client.writes.map(row => row.name), ['MakeEquipRequest']);
  assert.equal(usage.snapshot().counters.forgeStarts, 3);
  assert.equal(usage.snapshot().counters.forgeGold, 6000);
});
await check('领取写请求明确未发送时释放领取键，下一轮可重新领取', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  await forgeRun(f, settings, usage);
  f.finishForge();
  const request = f.client.request;
  f.client.request = async (name, ...args) => {
    if (name === 'PickMadeEquipRequest') throw Object.assign(new Error('领取明确未发送'), { notSent: true });
    return request(name, ...args);
  };
  const attempt = await forgeRun(f, settings, usage);
  assert.equal(attempt.results[0].status, 'cancelled');
  assert.equal(usage.hasKey('forgeClaim:1001001:1'), false);
  assert.equal(usage.keyRecords()['forge:1001001:1'].confirmed, true);
  assert.equal(usage.snapshot().counters.forgeGold, 2000);
  f.client.request = request;
  const retried = await forgeRun(f, settings, usage);
  assert(retried.results.some(row => row.step.kind === 'forgeClaim' && row.status === 'confirmed'));
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest', 'PickMadeEquipRequest', 'MakeEquipRequest']);
});
await check('领取已发送后的回读明确未发送仍保留领取键，恢复后凭产出核销', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  await forgeRun(f, settings, usage);
  f.finishForge();
  const request = f.client.request;
  let claimed = false;
  f.client.request = async (name, ...args) => {
    if (claimed && name === 'OnWaterRequest') throw Object.assign(new Error('回读明确未发送'), { notSent: true });
    const reply = await request(name, ...args);
    if (name === 'PickMadeEquipRequest') claimed = true;
    return reply;
  };
  const attempt = await forgeRun(f, settings, usage);
  assert.equal(attempt.results[0].status, 'unknown');
  assert.equal(usage.hasKey('forgeClaim:1001001:1'), true);
  assert.equal(usage.snapshot().counters.forgeGold, 2000);
  f.client.request = request;
  await forgeRun(f, settings, usage);
  assert.equal(usage.hasKey('forgeClaim:1001001:1'), false);
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest', 'PickMadeEquipRequest', 'MakeEquipRequest']);
});
await check('领取复核期间暂停阻止领取，并发检查只领取一次', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();await forgeRun(f,s,u);f.finishForge();let reads=0,active=true;
  f.beforeRead=name=>{if(name==='OnWaterRequest'&&++reads===2)active=false;};
  await forgeRun(f,s,u,{enabled:()=>active});assert.equal(f.client.writes.length,1);
  f.beforeRead=null;await Promise.all([forgeRun(f,s,u),forgeRun(f,s,u)]);
  assert.equal(f.client.writes.filter(row=>row.name==='PickMadeEquipRequest').length,1);
});
await check('未知锻造跨午夜保留金币及材料预算，不因日额度重置而重发', async () => {
  let now=Date.UTC(2026,10,3,15,59,59);const file=path.join(directory,'forge-midnight.json');
  const f=warForgeFixture(),s=warForgeSettings();f.unknown=true;
  await forgeRun(f,s,createUsageLedger('a',{file,now:()=>now}));now+=3000;
  const u=createUsageLedger('a',{file,now:()=>now});await forgeRun(f,s,u);
  assert.equal(f.client.writes.length,1);assert.equal(u.pendingCounters().forgeGold,2000);assert.equal(u.snapshot().counters.forgeStarts??0,0);
});
await check('轮间15秒检查在原生额度耗尽后接续，暂停立即阻止后续动作', async () => {
  const original=Date.now;let clock=original();Date.now=()=>clock;
  try {
    const f=warForgeFixture(),s=warForgeSettings(),u=ledger(),stop={aborted:false};s.forge.enabled=false;s.cityWar.fleetIds=['1远征船'];
    f.state.fleets[0].autoFight.todayTimes=3;
    const start=clock;
    await runLoop(f.client,f.protocol,{config:f.config,player:f.player,rounds:2,allowMutate:true,getSettings:()=>s,usageLedger:u,isEnabled:()=>false,stop,
      sleep:async ms=>{clock+=ms;if(clock-start>=15000)f.state.fleets[0].autoFight.todayTimes=4;},
      onStep:entry=>{if(entry.step?.kind==='cityDispatch')stop.aborted=true;}});
    assert.equal(clock-start,15000);assert.equal(f.client.writes.length,1);assert.equal(f.client.writes[0].name,'MoveFleetsToCityRequest');
  } finally {Date.now=original;}
});
await check('锻造随每轮挂机检查，旧独立间隔不跳过短轮次或触发轮间检查', async () => {
  const originalNow = Date.now;
  try {
    for (const [everyMs, legacySeconds] of [[1000, 300], [60000, 10]]) {
      const base = Date.UTC(2026, 10, 18, 4);
      let clock = base;
      Date.now = () => clock;
      const f = warForgeFixture(), settings = warForgeSettings();
      settings.cityWar.enabled = false;
      settings.forge.checkEverySeconds = legacySeconds;
      // 保持工厂生产中，每次读取都应确认状态，不产生领取或新下单。
      f.state.factory.equipMaking = { makeId: 1001, finishTime: base / 1000 + 3600, equipId: '测试武器', star: 2 };
      const reads = [], waits = [];
      f.beforeRead = name => { if (name === 'EquipsRequest') reads.push(clock - base); };
      await runLoop(f.client, f.protocol, {
        config: f.config, player: f.player, rounds: 3, everyMs, allowMutate: true,
        getSettings: () => settings, usageLedger: ledger(), isEnabled: () => false,
        sleep: async ms => { waits.push(ms); clock += ms; },
      });
      assert.deepEqual(reads, [0, everyMs, everyMs * 2], '每轮读取一次，旧锻造间隔为 ' + legacySeconds + ' 秒');
      assert.deepEqual(waits, [everyMs, everyMs], '轮间只等待主循环间隔');
      assert.equal(f.client.writes.length, 0, '生产中不重复下单或提前领取');
    }
  } finally { Date.now = originalNow; }
});
await check('仅开启装备自动锻造即可跨轮领取续产，达到下单上限仍领取完工装备', async () => {
  const originalNow = Date.now;
  let clock = Date.UTC(2026, 10, 18, 4);
  Date.now = () => clock;
  try {
    const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
    settings.cityWar.enabled = false;
    settings.forge.dailyLimit = 2;
    assert.equal(settings.schedule.equipmentCollect, false);
    assert.equal(settings.schedule.equipmentCraft, false);
    const rounds = [];
    await runLoop(f.client, f.protocol, {
      config: f.config, player: f.player, rounds: 3, everyMs: 15000, allowMutate: true,
      getSettings: () => settings, usageLedger: usage, isEnabled: key => settings.schedule[key] === true,
      sleep: async ms => { clock += ms; },
      onRound: () => rounds.push(f.client.writes.map(row => row.name)),
    });
    assert.deepEqual(rounds, [
      ['MakeEquipRequest'],
      ['MakeEquipRequest', 'PickMadeEquipRequest', 'MakeEquipRequest'],
      ['MakeEquipRequest', 'PickMadeEquipRequest', 'MakeEquipRequest', 'PickMadeEquipRequest'],
    ]);
    assert(f.client.writes.filter(row => row.name === 'MakeEquipRequest').every(row =>
      row.body.buildingId === '1装备厂' && row.body.makeId === 1001));
    assert.equal(f.state.equipment.length, 3, '两件完工装备均回读确认入库');
    assert.equal(f.state.factory.equipMaking, null, '达到下单次数上限后仍可收取最后一件');
    assert.equal(usage.snapshot().counters.forgeStarts, 2);
    assert.equal(usage.snapshot().counters.forgeGold, 4000);
  } finally { Date.now = originalNow; }
});
await check('装备自动锻造关闭时旧领取续产开关不再执行隐藏任务', async () => {
  const f = warForgeFixture(), settings = warForgeSettings();
  settings.cityWar.enabled = settings.forge.enabled = false;
  settings.schedule.equipmentCollect = settings.schedule.equipmentCraft = true;
  await runLoop(f.client, f.protocol, {
    config: f.config, player: f.player, rounds: 1, allowMutate: true,
    getSettings: () => settings, usageLedger: ledger(), isEnabled: key => settings.schedule[key] === true,
  });
  assert.equal(f.calls.length, 0, '旧开关不能触发装备厂读取或制造');
  assert.equal(f.client.writes.length, 0);
});
await check('独立于基地开关的完整挂机链路，城战优先保护巨轮舰队', async () => {
  const f=warForgeFixture(),s=warForgeSettings(),u=ledger();
  Object.assign(s.treasure,{enabled:true,autoJoin:true,fleetIds:['1远征船','2远征船']});
  await runLoop(f.client,f.protocol,{config:f.config,player:f.player,rounds:1,allowMutate:true,getSettings:()=>s,usageLedger:u,isEnabled:()=>false});
  assert(f.client.writes.some(row=>row.name==='MakeEquipRequest'));
  assert(f.client.writes.some(row=>row.name==='MoveFleetsToCityRequest'));
  assert(!f.client.writes.some(row=>row.name==='TreasureLootSendFleetsRequest'));
});
await check('城战窗口内无有效目标不阻断巨轮，跨入有效窗口时发送前仍保留', async () => {
  const f=warForgeFixture(),s=warForgeSettings();s.forge.enabled=false;s.cityWar.fleetIds=['1远征船'];f.state.war.declarations=[];
  Object.assign(s.treasure,{enabled:true,autoJoin:true,fleetIds:['1远征船']});
  await runLoop(f.client,f.protocol,{config:f.config,player:f.player,rounds:1,allowMutate:true,getSettings:()=>s,usageLedger:ledger(),isEnabled:()=>false});
  assert(f.client.writes.some(row=>row.name==='TreasureLootSendFleetsRequest'));
  const g=warForgeFixture();g.state.war.startTime=Math.floor(Date.now()/1000)+5;let mapReads=0;
  g.beforeRead=name=>{if(name==='WorldInfoRequest'&&++mapReads===2)g.client.serverClockOffsetMs=10000;};
  await runLoop(g.client,g.protocol,{config:g.config,player:g.player,rounds:1,allowMutate:true,getSettings:()=>s,usageLedger:ledger(),isEnabled:()=>false});
  assert.equal(g.client.writes.length,0,'读取期间跨入有效城战窗口仍不能把保留舰队派往巨轮');
});

fs.writeFileSync(path.join(directory,'accounts.json'),JSON.stringify({version:1,activeId:'a',accounts:['a','b'].map(id=>({id,label:'城战锻造模拟'+id,url:'ws://127.0.0.1:1',login:{},automation:{enabled:false,paused:true}}))}));
const { createConsole } = await import('./fixtures/console-server.mjs');const app=createConsole({port:0});await app.listen();
const base='http://127.0.0.1:'+app.server.address().port;
const api=async(route,account='a',body)=>{const response=await fetch(base+'/api/'+route+'?account='+account,{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()};};
try {
  await check('旧装备任务不再暴露为配置或挂机入口，旧控制请求拒绝且不改变配置', async () => {
    const before = (await api('settings', 'b')).data;
    const runtime = (await api('loop', 'b')).data;
    for (const key of ['equipmentCollect', 'equipmentCraft']) {
      const field = 'schedule.' + key;
      assert(!before.tasks.some(task => task.key === key));
      assert(before.rules.mappedTasks.includes(key), '旧任务不能被动态补回配置');
      assert(!before.rules.moduleControls.some(control => control.key === field));
      assert(!before.rules.controlFields.includes(field));
      assert(!runtime.tasks.some(task => task.key === key));
      assert(!runtime.controls.some(control => control.key === field || control.fields.includes(field)));
      const response = await api('loop/task', 'b', { confirm: true, key, enabled: true });
      assert.equal(response.status, 400);
      assert.match(response.data.error, /装备领取与续产已统一/);
    }
    const after = (await api('settings', 'b')).data;
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.settings, before.settings);
    assert(!app.sessions.get('b').client, '旧任务请求不能连接游戏');
  });
  await check('新设置API按账号隔离、保存不启动、只读预览不写游戏',async()=>{
    const before=fs.readFileSync(path.join(directory,'accounts.json'));const a=(await api('settings')).data;
    assert.equal(a.settings.cityWar.enabled,false);assert.equal(a.settings.forge.enabled,false);
    const s=warForgeSettings();const saved=await api('settings','a',{settings:s,revision:a.revision,baseRevision:a.baseRevision});assert.equal(saved.status,200,JSON.stringify(saved.data));
    assert.equal((await api('settings','b')).data.settings.cityWar.enabled,false);assert.equal(app.sessions.get('a').loop.running,false);
    const f=warForgeFixture(),session=app.sessions.get('a');f.alignScenarioOne();session.client=f.client;session.player=f.player;session.paused=false;
    const war=await api('settings/preview','a',{category:'cityWar'}),forge=await api('settings/preview','a',{category:'forge'});
    assert.equal(war.status,200,JSON.stringify(war.data));assert.equal(forge.status,200,JSON.stringify(forge.data));assert.equal(war.data.cityWar.nativeLimit,4);
    assert.equal(war.data.actions.length,2,'真实场景配置下也应生成两项有效城战计划');assert(forge.data.actions.length);assert(forge.data.forge.factories.length);assert.equal(f.client.writes.length,0);
    const expectedAccounts = JSON.parse(before);
    expectedAccounts.accounts.find(account => account.id === 'a').automation.settingsConfigured = true;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,'accounts.json'))), expectedAccounts, '保存仅登记本账号已配置，不改变凭据、其他账号或挂机开关');
  });
  await check('真实场景2配置与地图可通过HTTP预览，且按真实汽油库存规划行军',async()=>{
    const f=warForgeFixture(),session=app.sessions.get('a');f.player.scenarioId=2;
    f.state.cities=[{id:277,state:1,guildIdx:7},{id:285,state:2,guildIdx:8}];
    f.state.war.declarations=[{attackGuildIdx:7,defenceGuildIdx:8,cityId:285}];
    f.state.war.assembleCityId=285;f.state.fleets.forEach(fleet=>{fleet.cityId=277;});
    session.client=f.client;session.player=f.player;session.paused=false;
    const war=await api('settings/preview','a',{category:'cityWar'});
    assert.equal(war.status,200,JSON.stringify(war.data));
    assert(!war.data.notes.some(note=>note.startsWith('城战状态未确认')),JSON.stringify(war.data));
    assert.equal(war.data.actions.length,2,JSON.stringify(war.data));
    assert(war.data.actions.reduce((sum, action)=>sum+action.costs.reduce((cost, item)=>cost+item.num,0),0)<=f.state.fuel);
    assert(war.data.cityWar.targets.every(target=>target.ref==='2:285'&&target.petrol>0));
    assert.equal(f.client.writes.length,0);
  });
} finally {app.server.closeAllConnections();await app.close();}
await check('装备自动领取和续产可分别关闭，只领取时无需配方', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  settings.forge.craft = false;
  settings.forge.recipeIds = [];
  assert.doesNotThrow(() => validateSettings(settings));
  f.state.factory.equipMaking = { makeId: 1001, finishTime: Math.floor(Date.now() / 1000) - 10, equipId: '测试武器', star: 2 };
  const claimed = await forgeRun(f, settings, usage);
  assert(claimed.results.some(row => row.step?.kind === 'forgeClaim' && row.status === 'confirmed'));
  await forgeRun(f, settings, usage);
  assert.deepEqual(f.client.writes.map(row => row.name), ['PickMadeEquipRequest']);
  assert.equal(f.state.equipment.length, 2);
  assert.equal(usage.snapshot().counters.forgeStarts ?? 0, 0);
  const g = warForgeFixture(), second = warForgeSettings();
  second.forge.collect = false;
  g.state.factory.equipMaking = { makeId: 1001, finishTime: Math.floor(Date.now() / 1000) - 10, equipId: '测试武器', star: 2 };
  await forgeRun(g, second);
  assert.equal(g.client.writes.length, 0, '关闭领取时保留已完成批次，不能跳过领取继续制作');
});
await check('原生自动锻造只切换游戏开关，禁用工具领取制作分解及预算', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  Object.assign(settings.forge, { nativeAuto: true, recipeIds: [], decompose: true, decomposeQualities: ['BLUE'],
    goldReserve: 999999, materialReserve: 999999, dailyLimit: 1, dailyGoldLimit: 1 });
  f.state.monthCards = [{ type: f.protocol.MonthCardType.MONTH_CARD_SENIOR, endTime: -1 }];
  f.state.factory.equipMaking = { makeId: 1001, finishTime: Math.floor(Date.now() / 1000) - 10, equipId: '测试武器', star: 2 };
  assert.doesNotThrow(() => validateSettings(settings), '原生模式无需配方');
  const result = await forgeRun(f, settings, usage);
  assert.deepEqual(f.client.writes, [{ name: 'SetBuildingAutoWorkRequest', body: { buildingId: '1装备厂', isOn: true } }]);
  assert.equal(result.results.at(-1)?.status, 'confirmed', JSON.stringify(result));
  assert.equal(f.state.factory.auto, true);
  assert(f.calls.some(row => row.name === 'MonthCardRequest'));
  assert(f.calls.filter(row => row.name === 'OnWaterRequest').length >= 2, '开关发送后必须回读工厂');
  assert.equal(usage.snapshot().counters.forgeStarts ?? 0, 0);
  assert.equal(usage.snapshot().counters.forgeGold ?? 0, 0);
  const record = Object.values(usage.keyRecords()).find(row => row.details?.kind === 'forgeNative');
  assert.equal(record?.confirmed, true, '保留本工具启用原生的归属记录');
  await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.length, 1, '已开启时不会重复发送或触发工具分解');
});
await check('原生自动锻造遵守月卡有效期和权益，缺少资格不回退工具制作', async () => {
  for (const variant of ['absent', 'expired', 'normal', 'zero', 'missingConfig', 'readFailed']) {
    const f = warForgeFixture(), settings = warForgeSettings();
    settings.forge.nativeAuto = true;
    f.state.monthCards = variant === 'absent' ? [] : [{ type: variant === 'normal' ? 1 : 2,
      endTime: variant === 'expired' ? Math.floor(Date.now() / 1000) - 1 : -1 }];
    if (variant === 'zero') f.config.tables.MonthCardCfg.data[1].effectList[0][1] = 0;
    if (variant === 'missingConfig') delete f.config.tables.MonthCardCfg;
    if (variant === 'readFailed') f.beforeRead = name => { if (name === 'MonthCardRequest') throw new Error('模拟月卡读取失败'); };
    const result = await forgeRun(f, settings);
    assert.equal(f.client.writes.length, 0, variant + ': ' + JSON.stringify(result));
    assert(result.notes.length, variant + ' 必须给出等待原因');
  }
  for (const endTime of [-1, Math.floor(Date.now() / 1000) + 3600]) {
    const f = warForgeFixture(), settings = warForgeSettings();
    settings.forge.nativeAuto = true;
    f.state.monthCards = [{ type: 2, endTime }];
    await forgeRun(f, settings);
    assert.equal(f.client.writes.length, 1, '永久或未到期月卡可开启');
  }
});
await check('月卡读取失败不影响工具自定义锻造', async () => {
  const f = warForgeFixture(), settings = warForgeSettings();
  f.beforeRead = name => { if (name === 'MonthCardRequest') throw new Error('模拟月卡读取失败'); };
  const result = await forgeRun(f, settings);
  assert.equal(result.results.at(-1)?.status, 'confirmed');
  assert.deepEqual(f.client.writes.map(row => row.name), ['MakeEquipRequest']);
});
await check('原生开启结果未知跨轮及重启保留防重，回读后确认归属', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), file = path.join(directory, 'native-pending.json');
  let usage = ledger({ file });
  settings.forge.nativeAuto = true;
  f.state.monthCards = [{ type: 2, endTime: -1 }];
  f.ignoreForgeNative = true;
  const first = await forgeRun(f, settings, usage);
  assert.equal(first.results.at(-1)?.status, 'unknown');
  assert.equal(f.client.writes.length, 1);
  assert(Object.values(usage.keyRecords()).some(row => row.details?.kind === 'forgeNative' && !row.confirmed));
  usage = ledger({ file });
  await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.length, 1, '新账本实例仍阻止重复开启');
  f.state.factory.auto = true;
  await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.length, 1);
  assert(Object.values(usage.keyRecords()).some(row => row.details?.kind === 'forgeNative' && row.confirmed));
});
await check('关闭工具开启的原生自动后先回读确认，后续轮次恢复自定义', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  settings.forge.nativeAuto = true;
  f.state.monthCards = [{ type: 2, endTime: -1 }];
  await forgeRun(f, settings, usage);
  settings.forge.nativeAuto = false;
  const result = await forgeRun(f, settings, usage);
  assert.deepEqual(f.client.writes.map(row => [row.name, row.body.isOn]), [
    ['SetBuildingAutoWorkRequest', true], ['SetBuildingAutoWorkRequest', false],
  ]);
  assert.equal(result.results.at(-1)?.status, 'confirmed');
  assert.equal(f.state.factory.auto, false);
  assert(!Object.values(usage.keyRecords()).some(row => row.details?.kind === 'forgeNative'));
  await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.at(-1).name, 'MakeEquipRequest');
});
await check('原生关闭未确认时继续等待，单轮最多关闭一次且不接管制作', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  settings.forge.nativeAuto = true;
  f.state.monthCards = [{ type: 2, endTime: -1 }];
  await forgeRun(f, settings, usage);
  settings.forge.nativeAuto = false;
  f.ignoreForgeNative = true;
  for (let round = 0; round < 2; round++) {
    const before = f.client.writes.length;
    const result = await forgeRun(f, settings, usage);
    assert.equal(f.client.writes.length, before + 1);
    assert.deepEqual(f.client.writes.at(-1), { name: 'SetBuildingAutoWorkRequest', body: { buildingId: '1装备厂', isOn: false } });
    assert.equal(result.results.at(-1)?.status, 'unknown');
    assert(Object.values(usage.keyRecords()).some(row => row.details?.kind === 'forgeNative'));
  }
  f.ignoreForgeNative = false;
  await forgeRun(f, settings, usage);
  assert.equal(f.state.factory.auto, false);
  assert(f.client.writes.every(row => row.name === 'SetBuildingAutoWorkRequest'));
});
await check('游戏内已有原生开关不冒领归属，不擅自关闭或重复领取', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  f.state.factory.auto = true;
  f.state.monthCards = [{ type: 2, endTime: -1 }];
  settings.forge.nativeAuto = true;
  await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.length, 0);
  assert(!Object.values(usage.keyRecords()).some(row => row.details?.kind === 'forgeNative'));
  settings.forge.nativeAuto = false;
  await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.length, 0);
  assert.equal(f.state.factory.auto, true);
});
await check('原生开启已发送后回读失败保留归属，显式关闭可解除未知状态', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  settings.forge.nativeAuto = true;
  f.state.monthCards = [{ type: 2, endTime: -1 }];
  f.beforeRead = name => {
    if (name === 'OnWaterRequest' && f.client.writes.length)
      throw Object.assign(new Error('模拟回读未发送'), { notSent: true });
  };
  const result = await forgeRun(f, settings, usage);
  assert.equal(result.results.at(-1)?.status, 'unknown');
  assert.equal(f.client.writes.length, 1);
  assert(Object.values(usage.keyRecords()).some(row => row.details?.kind === 'forgeNative' && !row.confirmed));
  f.beforeRead = null;
  settings.forge.nativeAuto = false;
  await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.length, 2);
  assert.equal(f.client.writes.at(-1).body.isOn, false);
  assert.equal(f.state.factory.auto, false);
  assert(!Object.values(usage.keyRecords()).some(row => row.details?.kind === 'forgeNative'));
});
await check('工具下单结果未知时不启用原生自动覆盖原批次证据', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  f.unknown = true;
  await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.length, 1);
  f.unknown = false;
  settings.forge.nativeAuto = true;
  f.state.monthCards = [{ type: 2, endTime: -1 }];
  const result = await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.length, 1);
  assert.match(result.notes.join(' '), /结果待确认/);
});
await check('取消工厂选择仍关闭本工具原生开关，其他角色记录不影响当前角色', async () => {
  const f = warForgeFixture(), settings = warForgeSettings(), usage = ledger();
  settings.forge.nativeAuto = true;
  f.state.monthCards = [{ type: 2, endTime: -1 }];
  await forgeRun(f, settings, usage);
  const [nativeKey] = Object.keys(usage.keyRecords()).filter(key => key.startsWith('forgeNative:'));
  settings.forge.buildingIds = [];
  await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.length, 2);
  assert.equal(f.client.writes.at(-1).body.isOn, false);
  assert.equal(usage.hasKey(nativeKey), false);
  settings.forge.buildingIds = ['1装备厂'];
  await forgeRun(f, settings, usage);
  const prior = usage.keyRecords();
  f.player.playerId = '9007199254900999';
  settings.forge.nativeAuto = false;
  await forgeRun(f, settings, usage);
  assert.equal(f.client.writes.length, 3, '同世界另一角色不能关闭原角色的原生开关');
  assert.deepEqual(usage.keyRecords(), prior);
});
await check('周活动等待时原生模式可开启关闭再开启，普通工具制造按自身开关恢复', async () => {
  const originalNow = Date.now;
  let clock = Date.UTC(2026, 10, 18, 4);
  Date.now = () => clock;
  try {
    for (const subjectId of [1, 2]) {
      const f = warForgeFixture(), usage = ledger(), rounds = [];
      let settings = warForgeSettings(), weeklyReads = 0;
      settings.cityWar.enabled = false;
      settings.forge.nativeAuto = true;
      Object.assign(settings.weeklyActivity, { enabled: true, forgeEnabled: true, forgeStop: 'score', forgeScore: 60 });
      f.state.monthCards = [{ type: 2, endTime: -1 }];
      f.player.worldId = f.protocol.PlayerInfo.decode(f.protocol.PlayerInfo.encode({ worldId: '2000001' }).finish()).worldId;
      f.config.tables.ModuleOpenCfg.data.push({ moduleId: '每日跨服比拼', playerLevel: 20 });
      const request = f.client.request;
      f.client.request = async (name, ...args) => {
        if (name !== 'CrossRankInfoRequest') return request(name, ...args);
        weeklyReads++;
        return f.protocol.CrossRankInfoResponse.decode(f.protocol.CrossRankInfoResponse.encode({
          subjectId, roomLevel: 1, grouping: false, settleTime: Math.floor(clock / 1000) + 3600,
          rankList: [{ playerId: f.player.playerId, score: 60, rank: 1, nickname: '测试角色', level: 40, avatar: {} }],
        }).finish());
      };
      await runLoop(f.client, f.protocol, {
        config: f.config, player: f.player, rounds: 4, everyMs: 15000, allowMutate: true,
        getSettings: () => settings, usageLedger: usage, isEnabled: () => false,
        sleep: async ms => { clock += ms; },
        onRound: () => {
          rounds.push(f.client.writes.map(row => [row.name, row.body.isOn]));
          if (rounds.length === 1 || rounds.length === 3)
            settings = { ...settings, forge: { ...settings.forge, nativeAuto: rounds.length === 3 } };
        },
      });
      const on = ['SetBuildingAutoWorkRequest', true], off = ['SetBuildingAutoWorkRequest', false], craft = ['MakeEquipRequest', undefined];
      assert.deepEqual(rounds, [[on], [on, off], [on, off, craft], [on, off, craft, on]], '周活动主题 ' + subjectId);
      assert.equal(f.state.factory.auto, true);
      assert(weeklyReads > 0, '真实主循环已进入周活动检查');
      assert.equal(usage.snapshot().counters.forgeStarts, 1, '普通制造独立执行且只扣一次预算');
    }
  } finally { Date.now = originalNow; }
});
await check('原生开关发送前暂停、改配置或关闭总开关即取消', async () => {
  for (const change of ['pause', 'settings', 'master']) {
    const f = warForgeFixture(), initial = warForgeSettings(), usage = ledger();
    initial.forge.nativeAuto = true;
    f.state.monthCards = [{ type: 2, endTime: -1 }];
    let current = initial, active = true, reads = 0;
    f.beforeRead = name => {
      if (name !== 'OnWaterRequest' || ++reads !== 2) return;
      if (change === 'pause') active = false;
      else if (change === 'master') current.forge.enabled = false;
      else current = { ...initial, forge: { ...initial.forge, nativeAuto: false } };
    };
    await forgeRun(f, initial, usage, { enabled: () => active, getSettings: () => current });
    assert.equal(f.client.writes.length, 0, change);
    assert(!Object.values(usage.keyRecords()).some(row => row.details?.kind === 'forgeNative'), change);
  }
});
const report=path.join(parent,'result-'+Date.now()+'.json');fs.writeFileSync(report,JSON.stringify({time:new Date().toISOString(),results},null,2));
console.log(results.filter(r=>r.passed).length+'/'+results.length+' 通过；'+report);
if(results.some(r=>!r.passed))process.exitCode=1;
