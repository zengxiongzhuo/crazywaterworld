// 虚构账号与状态；默认无需游戏缓存，--real-protocol 额外核对真实协议编解码。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';
import { defaultSettings, validateSettings, createUsageLedger, exportAutomationSettings, importAutomationSettings } from '../src/automation-settings.mjs';
import { readFleetSpeed,planFleetSpeed,runFleetSpeed,watchFleetSpeed } from '../src/fleet-speed.mjs';
import { fleetSpeedTarget, previewManualFleetSpeed, runManualFleetSpeed } from '../src/manual-fleet-speed.mjs';
import { repairDiamondCost } from '../src/fleet-speed-evidence.mjs';
import { watchFleetRepairPricing } from '../src/fleet-repair-pricing.mjs';
import { watchSiliconMining } from '../src/silicon-mining.mjs';
import { settleFleetSnapshot } from '../src/fleet-settlement.mjs';
import { sendRepairAndConfirm, fleetRepairConfirmed } from '../src/fleet-repair-confirmation.mjs';
import { runLoop } from '../src/loop.mjs';

const names=['MyFleetsRequest','MyFleetsResponse','AllResourceRequest','AllResourceResponse','SpeedUpFleetRequest','SpeedUpRepairRequest','RepairFleetRequest'];
const protocol=process.argv.includes('--real-protocol')?(await import('../src/proto.mjs')).loadProtocol():createDeclaredProtocol(names);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-fleet-speed-'));
let sequence=0,passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('通过：'+name);};
const pack=(name,value)=>protocol[name].decode(protocol[name].encode(value).finish());
function fixture(){
  const client=new EventEmitter();client.connected=true;client.serverClockOffsetMs=0;client.setMaxListeners(32);
  const now=()=>Math.floor((Date.now()+client.serverClockOffsetMs)/1000);
  const player={worldId:1001001,playerId:900001};
  const settings=defaultSettings();settings.resources.allowDiamonds=true;settings.resources.diamondDailyLimit=1000;
  settings.cityWar.enabled=true;settings.cityWar.autoRepair=false;settings.cityWar.fleetIds=['1远征船','2远征船'];
  Object.assign(settings.fleetSpeed.fleets[0],{repair:true,march:true,repairSmartSave:true,marchSmartSave:true,repairDailyDiamonds:300,marchDailyDiamonds:300});
  const config={tables:{WorldParamCfg:{data:[{paramName:'行军加速消耗',paramValue:30}]},SpeedUpRubyCfg:{data:[{minute:0,fleet:10},{minute:60,fleet:11},{minute:80,fleet:20}]}}};
  const state={diamonds:1000,repairMinutes:0,fleets:[1,2,3].map(id=>({buildingId:id+'远征船',owner:{playerId:900001},state:2,durability:100,maxDura:100,curGridIdx:0,targetGridIdx:42,targetCityId:7,treasureLootUid:0,moveStartTs:now()-10,moveEndTs:now()+300}))};
  const file=path.join(root,String(++sequence)+'.json'),ledger=createUsageLedger('虚构加速',{file,now:()=>now()*1000});
  const f={client,now,player,settings,config,state,ledger,file,writes:[],entries:[],mode:'ok',beforeRead:null,beforeSend:null,reads:0};
  client.request=async(name,body={})=>{
    pack(name,body);await f.beforeRead?.(name,++f.reads);
    if(f.readError&&f.writes.length)throw Object.assign(Error('read failed'),{request:name,notSent:true});
    if(name==='MyFleetsRequest')return pack('MyFleetsResponse',{fleets:state.fleets});
    if(name==='AllResourceRequest')return pack('AllResourceResponse',{list:[{res:4,amount:f.staleBalance??state.diamonds}]});
    throw Error('undeclared read '+name);
  };
  client.sendWatch=async(name,body)=>{
    pack(name,body);f.writes.push({name,body});await f.beforeSend?.(name,body);
    if(f.mode==='reject')throw Object.assign(Error('rejected'),{prompt:{prompt:1},request:name});
    if(f.mode==='notSent')throw Object.assign(Error('not sent'),{notSent:true,request:name});
    if(f.mode==='unknown')throw Error('timeout');
    const fleet=state.fleets.find(x=>x.buildingId===body.buildingId);
    if(name==='SpeedUpFleetRequest'){state.diamonds-=30;fleet.moveEndTs=now()+Math.floor((fleet.moveEndTs-now())/2);}
    else if(name==='SpeedUpRepairRequest'){
      // 服务端累计量独立于被测缓存；故意不推 SCSpeedUp，覆盖推送迟到的真实风险。
      const minutes=Math.ceil((fleet.repairing.endTs-now())/60);
      state.diamonds-=repairDiamondCost(config,minutes,state.repairMinutes);state.repairMinutes+=minutes;
      fleet.durability=fleet.repairing.endDura;fleet.repairing=null;fleet.state=1;
      if(f.pushRepairMinutes)client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:state.repairMinutes}]}});
    }
    else throw Error('undeclared write '+name);
    client.emit('message',{name:'SCMyFleetUpdate',body:{fleets:[structuredClone(fleet)]}});
  };
  f.run=(extra={})=>runFleetSpeed(client,protocol,config,player,{getSettings:()=>f.settings,ledger,enabled:()=>true,onStep:e=>f.entries.push(e),...extra});
  f.plan=async()=>planFleetSpeed(await readFleetSpeed(client,player),config,f.settings,ledger);
  f.manualQuote=async(fleet)=>previewManualFleetSpeed(client,protocol,config,player,fleetSpeedTarget(fleet,player),{ledger});
  f.manualRun=async(quote)=>runManualFleetSpeed(client,protocol,config,player,quote,{ledger,validate:()=>{}});
  f.repair=()=>Object.assign(state.fleets[0],{state:4,durability:80,repairing:{startTs:now()-10,endTs:now()+120,endDura:100}});
  return f;
}
try{
await test('手动派遣加速逐次核对同一航程，直至指定舰队抵达',async()=>{
  const f=fixture(), fleet=f.state.fleets[1];
  const other=structuredClone(f.state.fleets[0]);
  const quote=await f.manualQuote(fleet);
  assert(quote.maxCost>=60);
  f.beforeRead=name=>{
    if(name==='MyFleetsRequest' && fleet.moveEndTs<=f.now()){
      Object.assign(fleet,{state:1,curGridIdx:fleet.targetGridIdx,cityId:fleet.targetCityId});
    }
  };
  assert.equal((await f.manualRun(quote)).status,'completed');
  assert(f.writes.length>1);
  assert.deepEqual(f.writes,Array(f.writes.length).fill({name:'SpeedUpFleetRequest',body:{buildingId:fleet.buildingId}}));
  assert.equal(f.state.diamonds,1000-30*f.writes.length);
  assert.deepEqual(f.state.fleets[0],other);
  assert(1000-f.state.diamonds<=quote.maxCost);
});
await test('实际行军缩短少于预计时，手动加速在确认的费用上限停止',async()=>{
  const f=fixture(),fleet=f.state.fleets[0];
  fleet.moveEndTs=f.now()+32;
  const quote=await f.manualQuote(fleet);
  f.client.sendWatch=async(name,body)=>{
    assert.equal(name,'SpeedUpFleetRequest');
    assert.equal(body.buildingId,fleet.buildingId);
    f.writes.push(body);
    fleet.moveEndTs--;
    f.state.diamonds-=30;
  };
  assert.equal((await f.manualRun(quote)).status,'partial');
  assert.equal(30*f.writes.length,quote.maxCost);
  assert.equal(f.state.diamonds,1000-quote.maxCost);
});
await test('手动维修一次补到目标耐久，报价期间换任务不能沿用旧确认',async()=>{
  const f=fixture();f.repair();
  const fleet=f.state.fleets[0],quote=await f.manualQuote(fleet);
  fleet.repairing.startTs++;
  const stale=await f.manualRun(quote).catch(()=>null);
  assert.notEqual(stale?.status,'completed');
  assert.equal(f.writes.length,0);
  const fresh=await f.manualQuote(fleet);
  assert.equal((await f.manualRun(fresh)).status,'completed');
  assert.deepEqual(f.writes,[{name:'SpeedUpRepairRequest',body:{buildingId:fleet.buildingId,speedUp:{type:1,useNum:0}}}]);
  assert.equal(fleet.durability,100);
  assert.equal(fleetSpeedTarget(fleet,f.player),null);
});
await test('结果不明的手动行军加速保留扣费占用，重复点击不会再次消耗',async()=>{
  const f=fixture(),quote=await f.manualQuote(f.state.fleets[1]);f.mode='unknown';
  assert.equal((await f.manualRun(quote)).status,'unknown');
  assert.equal(f.ledger.pendingCounters().diamonds,30);
  const retry=await f.manualRun(quote).catch(()=>null);
  assert.notEqual(retry?.status,'completed');
  assert.equal(f.writes.length,1);
});
await test('同队更换了出发时间后，旧航程的加速不会继续发送到新航程',async()=>{
  const f=fixture(), fleet=f.state.fleets[1];
  const quote=await f.manualQuote(fleet);
  f.beforeRead=name=>{
    if(name==='MyFleetsRequest' && f.writes.length){
      Object.assign(fleet,{moveStartTs:f.now(),moveEndTs:f.now()+600});
    }
  };
  const result=await f.manualRun(quote).catch(()=>null);
  assert.notEqual(result?.status,'completed');
  assert.equal(f.writes.length,1);
});
await test('默认关闭、逐队逐项配置、严格校验和导入迁移',async()=>{
  const s=defaultSettings();assert(!Object.hasOwn(s.fleetSpeed,'enabled'));assert(!Object.hasOwn(s.fleetSpeed,'dailyDiamondLimit'));
  assert(s.fleetSpeed.fleets.every(p=>!p.repair&&!p.march&&p.marchSkipSeconds===60));
  assert(s.fleetSpeed.fleets.every(p=>!Object.hasOwn(p,'repairMaxDiamonds')&&!Object.hasOwn(p,'marchMaxDiamonds')));
  const exported={...exportAutomationSettings(s),version:1};delete exported.settings.fleetSpeed;assert.deepEqual(importAutomationSettings(exported).fleetSpeed,s.fleetSpeed);
  const bad=structuredClone(s);bad.fleetSpeed.fleets[0].marchDailyDiamonds=-1;assert.throws(()=>validateSettings(bad));
  bad.fleetSpeed.fleets[0].marchDailyDiamonds=1;bad.fleetSpeed.fleets[0].id='2远征船';assert.throws(()=>validateSettings(bad));
});
await test('旧单次维修和整段航程上限兼容丢弃，旧非法值不再校验或导出',async()=>{
  for(const oldLimit of [0,1,-1,'obsolete',null]){
    const legacy=defaultSettings();
    for(const row of legacy.fleetSpeed.fleets)Object.assign(row,{repairMaxDiamonds:oldLimit,marchMaxDiamonds:oldLimit,repairDailyDiamonds:200,marchDailyDiamonds:90});
    const expected=structuredClone(legacy);
    for(const row of expected.fleetSpeed.fleets){delete row.repairMaxDiamonds;delete row.marchMaxDiamonds;}
    const result=validateSettings(legacy);assert.deepEqual(result.fleetSpeed,expected.fleetSpeed);
    const document=exportAutomationSettings(legacy);assert.deepEqual(document.settings.fleetSpeed,expected.fleetSpeed);
    assert.deepEqual(importAutomationSettings({...document,settings:legacy}).fleetSpeed,expected.fleetSpeed);
  }
});
await test('旧共用省钻配置迁移到两项，新字段优先且导出不保留旧键',async()=>{
  for(const smartSave of [true,false]){
    const legacy=defaultSettings();
    for(const row of legacy.fleetSpeed.fleets){
      delete row.repairSmartSave;delete row.marchSmartSave;delete row.repairSmartWaitSeconds;delete row.marchSmartWaitSeconds;
      row.smartSave=smartSave;row.smartWaitSeconds=8;
    }
    legacy.fleetSpeed.fleets[0].repairSmartSave=!smartSave;
    const result=validateSettings(legacy),p=result.fleetSpeed.fleets[0];
    assert.equal(p.repairSmartSave,!smartSave);assert.equal(p.marchSmartSave,smartSave);
    assert.equal(p.repairSmartWaitSeconds,8);assert.equal(p.marchSmartWaitSeconds,8);assert(!Object.hasOwn(p,'smartSave'));
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(result)).fleetSpeed,result.fleetSpeed);
    legacy.fleetSpeed.fleets[1].smartWaitSeconds=61;assert.throws(()=>validateSettings(legacy));
  }
  const invalid=defaultSettings();invalid.fleetSpeed.fleets[0].repairSmartSave='false';assert.throws(()=>validateSettings(invalid));
});
await test('同队可维修立即加速、派遣省钻，反向设置和逐项等待秒数互不影响',async()=>{
  for(const repairSmartSave of [true,false]){
    const f=fixture(),p=f.settings.fleetSpeed.fleets[0];Object.assign(p,{repairSmartSave,marchSmartSave:!repairSmartSave,repairSkipSeconds:0});
    f.repair();const snapshot=await readFleetSpeed(f.client,f.player);snapshot.fleets[0].repairing.endTs=snapshot.now+121;
    assert.equal(planFleetSpeed(snapshot,f.config,f.settings,f.ledger).actions.length,repairSmartSave?0:1);
    Object.assign(snapshot.fleets[0],{state:2,moveEndTs:snapshot.now+62});
    assert.equal(planFleetSpeed(snapshot,f.config,f.settings,f.ledger).actions.length,repairSmartSave?1:0);
  }
  const f=fixture(),p=f.settings.fleetSpeed.fleets[0];Object.assign(p,{repairSmartWaitSeconds:1,marchSmartWaitSeconds:5,repairSkipSeconds:0});
  f.repair();const snapshot=await readFleetSpeed(f.client,f.player);snapshot.fleets[0].repairing.endTs=snapshot.now+121;
  assert.equal(planFleetSpeed(snapshot,f.config,f.settings,f.ledger).actions.length,1);
  Object.assign(snapshot.fleets[0],{state:2,moveEndTs:snapshot.now+64});assert.equal(planFleetSpeed(snapshot,f.config,f.settings,f.ledger).nextCheckSeconds,4);
});
await test('只读预览不改账本，仅允许所选队伍及加速种类',async()=>{
  const f=fixture(),before=f.ledger.snapshot(),plan=await f.plan();assert.equal(plan.actions.length,1);assert.equal(plan.actions[0].buildingId,'1远征船');assert.deepEqual(f.ledger.snapshot(),before);assert.equal(f.writes.length,0);
  f.settings.fleetSpeed.fleets[0].march=false;await f.run();assert.equal(f.writes.length,0);
});
await test('仅所选城战舰队开启加速时才读取和执行',async()=>{
  for(const mode of ['repair','march']){
    const f=fixture();if(mode==='repair')f.repair();
    const before=f.ledger.snapshot(),policy=f.settings.fleetSpeed.fleets[0];
    Object.assign(policy,{repair:false,march:false});
    f.settings.fleetSpeed.fleets[2][mode]=true;
    await f.run();assert.equal(f.reads,0);
    policy[mode]=true;
    f.settings.cityWar.enabled=false;
    assert.match(planFleetSpeed(null,f.config,f.settings,f.ledger).notes.join('；'),/联盟城战未开启/);
    await f.run();assert.equal(f.reads,0);assert.equal(f.writes.length,0);assert.deepEqual(f.ledger.snapshot(),before);
    f.settings.cityWar.enabled=true;await f.run();assert.equal(f.writes.length,1);
    assert.equal(f.writes[0].name,mode==='repair'?'SpeedUpRepairRequest':'SpeedUpFleetRequest');
  }
});
await test('逐次回读、到剩余阈值停止，最少三次缩短300秒至60秒内',async()=>{
  const f=fixture();for(let i=0;i<5;i++)await f.run();assert.equal(f.writes.length,3);assert(f.state.fleets[0].moveEndTs-f.now()<=60);
  assert.equal(f.ledger.snapshot().counters.diamonds,90);assert.equal(f.ledger.snapshot().counters.fleetSpeedMarch1,90);
});
await test('同航程多次加速持续累计每日预算，切换航程也不会重置',async()=>{
  const f=fixture();f.settings.fleetSpeed.fleets[0].marchDailyDiamonds=60;
  for(let i=0;i<4;i++)await f.run();assert.equal(f.writes.length,2);
  assert.equal(f.ledger.confirmedCounters().fleetSpeedMarch1,60);assert.equal(f.ledger.confirmedCounters().diamonds,60);
  assert((await f.plan()).notes.some(n=>n.includes('每日钻石上限')));
  f.state.fleets[0].moveStartTs+=1;f.state.fleets[0].moveEndTs=f.now()+300;
  await f.run();assert.equal(f.writes.length,2,'新的航程仍受同队当日预算限制');
});
await test('旧单次上限为零或小额不阻止维修及连续派遣加速',async()=>{
  for(const mode of ['repair','march'])for(const oldLimit of [0,1]){
    const f=fixture();if(mode==='repair')f.repair();
    f.settings.fleetSpeed.fleets[0][mode+'MaxDiamonds']=oldLimit;
    for(let i=0;i<4;i++)await f.run();
    assert.equal(f.writes.length,mode==='repair'?1:3,mode+': '+oldLimit);
    const counter=mode==='repair'?'fleetSpeedRepair1':'fleetSpeedMarch1',cost=mode==='repair'?40:90;
    assert.equal(f.ledger.confirmedCounters()[counter],cost);assert.equal(f.ledger.confirmedCounters().diamonds,cost);
    assert.equal(f.ledger.snapshot().uncertain,0);
  }
});
await test('剩余阈值包含相等；节省时间不足也不发请求',async()=>{
  for(const remaining of [0,30,60]){const f=fixture();f.state.fleets[0].moveEndTs=f.now()+remaining;await f.run();assert.equal(f.writes.length,0);}
  const f=fixture();f.settings.fleetSpeed.fleets[0].marchSkipSeconds=0;f.state.fleets[0].moveEndTs=f.now()+59;await f.run();assert.equal(f.writes.length,0);
});
await test('旧城战加速每日总上限为零或小额均不阻止维修和行军，历史聚合用量继续统计',async()=>{
  for(const mode of ['repair','march'])for(const oldLimit of [undefined,0,1]){
    const f=fixture();if(mode==='repair')f.repair();
    if(oldLimit!==undefined)f.settings.fleetSpeed.dailyDiamondLimit=oldLimit;
    f.ledger.confirm(f.ledger.reserve({fleetSpeedDiamonds:50000}));
    await f.run();assert.equal(f.writes.length,1,mode+': '+oldLimit);
    const cost=mode==='repair'?40:30;
    assert.equal(f.ledger.confirmedCounters().fleetSpeedDiamonds,50000+cost);
    assert.equal(f.ledger.confirmedCounters().diamonds,cost);
  }
});
await test('维修和行军各自每日及全局每日预算仍拦截；零禁止，库存与待确认费用继续核对',async()=>{
  for(const mode of ['repair','march']){
    const cost=mode==='repair'?40:30;
    for(const mutate of [f=>f.settings.resources.allowDiamonds=false,
      ...[0,cost-1].flatMap(limit=>[f=>f.settings.resources.diamondDailyLimit=limit,
        f=>f.settings.fleetSpeed.fleets[0][mode+'DailyDiamonds']=limit]),
      f=>f.settings.resources.diamondThreshold=1000-cost+1,f=>f.state.diamonds=cost-1,
      f=>{f.settings.resources.diamondDailyLimit=10000;f.ledger.reserve({diamonds:1000-cost+1});}]){
      const f=fixture();if(mode==='repair')f.repair();mutate(f);await f.run();assert.equal(f.writes.length,0,mode);
    }
  }
});
await test('不同队伍、维修和派遣的每日预算独立计数',async()=>{
  const f=fixture();Object.assign(f.settings.fleetSpeed.fleets[1],{march:true,marchDailyDiamonds:30});
  f.repair();await f.run();assert.equal(f.writes.length,2);assert.equal(f.ledger.snapshot().counters.fleetSpeedRepair1,40);assert.equal(f.ledger.snapshot().counters.fleetSpeedMarch2,30);assert(!f.ledger.snapshot().counters.fleetSpeedMarch1);
});
await test('维修按剩余分钟进位与累计阶梯费率，缺失累计分钟按最高档',async()=>{
  const f=fixture();assert.equal(repairDiamondCost(f.config,2,59),21);assert.equal(repairDiamondCost(f.config,2,60),22);assert.equal(repairDiamondCost(f.config,2),40);
  f.repair();f.settings.fleetSpeed.fleets[0].repairSmartSave=false;f.state.fleets[0].repairing.endTs=f.now()+61;const p=await f.plan();assert.equal(p.actions[0].cost,40);
  watchFleetSpeed(f.client);f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:60}]}});assert.equal((await f.plan()).actions[0].cost,22);
  f.client.serverClockOffsetMs+=86400000;assert.equal(watchFleetSpeed(f.client).minutes(),null);
});
await test('维修钻石请求只完成已有维修，原结束前满耐久才确认',async()=>{
  const f=fixture();f.repair();await f.run();assert.deepEqual(f.writes[0],{name:'SpeedUpRepairRequest',body:{buildingId:'1远征船',speedUp:{type:1,useNum:0}}});
  assert.equal(f.entries[0].status,'confirmed');await f.run();assert.equal(f.writes.length,1);
});
await test('两队连续维修跨过60分钟，推送迟到不能突破逐队或全局每日上限',async()=>{
  for(const budget of ['fleet','global']){
  const f=fixture();f.state.repairMinutes=59;watchFleetSpeed(f.client);
  if(budget==='global')f.settings.resources.diamondDailyLimit=20;
  f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:59}]}});
  for(let i=0;i<2;i++){
    Object.assign(f.settings.fleetSpeed.fleets[i],{repair:true,march:false,repairSmartSave:false,repairSkipSeconds:0,repairDailyDiamonds:budget==='fleet'?10:100});
    Object.assign(f.state.fleets[i],{state:4,durability:80,repairing:{startTs:f.now()-10,endTs:f.now()+59,endDura:100}});
  }
  await f.run();assert.equal(f.writes.length,1,'第二队实际需11钻，必须拦截');
  assert.equal(1000-f.state.diamonds,10);assert.equal(f.ledger.snapshot().counters.diamonds,10);
  }
});
await test('两队预览及真实扣费均按累计阶梯推进，同步推送不会重复累加',async()=>{
  for(const pushRepairMinutes of [false,true]){
    const f=fixture();f.pushRepairMinutes=pushRepairMinutes;f.state.repairMinutes=59;watchFleetSpeed(f.client);
    f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:59}]}});
    for(let i=0;i<2;i++){
      Object.assign(f.settings.fleetSpeed.fleets[i],{repair:true,march:false,repairSmartSave:false,repairSkipSeconds:0,repairDailyDiamonds:100});
      Object.assign(f.state.fleets[i],{state:4,durability:80,repairing:{startTs:f.now()-10,endTs:f.now()+59,endDura:100}});
    }
    const before=f.ledger.snapshot();assert.deepEqual((await f.plan()).actions.map(a=>a.cost),[10,11]);assert.deepEqual(f.ledger.snapshot(),before);
    await f.run();assert.equal(f.writes.length,2);assert.equal(1000-f.state.diamonds,21);assert.equal(f.ledger.snapshot().counters.diamonds,21);
    assert.equal(watchFleetSpeed(f.client).minutes(),61);
    f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:60}]}});
    assert.equal(watchFleetSpeed(f.client).minutes(),61,'迟到低值不回退');
    f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:61}]}});
    assert.equal(watchFleetSpeed(f.client).minutes(),61,'服务端追上后不重复计本地分钟');
  }
});
await test('城战与硅矿共用维修计费，明确拒绝回滚本地分钟但不回滚服务端值',async()=>{
  for(const mode of ['reject','notSent']){
    const f=fixture(),silicon=watchSiliconMining(f.client);watchFleetSpeed(f.client);f.repair();
    f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:59}]}});
    f.mode=mode;await f.run();assert.equal(silicon.repairMinutes(),59);assert.equal(watchFleetSpeed(f.client).minutes(),59);
    f.beforeSend=()=>f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:62}]}});
    await f.run();assert.equal(silicon.repairMinutes(),62,'拒绝不能撤销已知服务端累计量');
  }
  const f=fixture(),silicon=watchSiliconMining(f.client);watchFleetSpeed(f.client);f.repair();
  f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:59}]}});
  await f.run();assert.equal(silicon.repairMinutes(),61);assert.equal(watchFleetSpeed(f.client).minutes(),61);
});
await test('未知维修跨重连、跨日仍用最高档，其他区服未知记录不污染报价',async()=>{
  const f=fixture();f.repair();watchFleetSpeed(f.client);f.mode='unknown';
  f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:59}]}});await f.run();
  const prior=Object.values(f.ledger.keyRecords()).find(r=>r.details?.kind==='fleetSpeed');assert(!prior.confirmed);
  f.settings.fleetSpeed.fleets[1]={...f.settings.fleetSpeed.fleets[0],id:'2远征船'};
  Object.assign(f.state.fleets[1],{state:4,durability:80,repairing:{startTs:f.now()-10,endTs:f.now()+120,endDura:100}});
  for(const offset of [0,86400000]){
    f.client.emit('close');assert.equal(watchFleetSpeed(f.client).minutes(),null);f.client.serverClockOffsetMs+=offset;
    f.state.fleets[1].repairing.endTs=f.now()+120;
    f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:0}]}});
    assert.equal((await f.plan()).actions.find(a=>a.buildingId==='2远征船').cost,40);
  }
  const g=fixture();g.repair();watchFleetSpeed(g.client);
  g.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:0}]}});
  g.ledger.reserve({diamonds:20},{diamonds:100},{},{uniqueKey:'silicon-speed:999:1',details:{kind:'siliconSpeed',worldId:'999',repair:true,buildingId:'1远征船'}});
  assert.equal((await g.plan()).actions[0].cost,20);
});
await test('计费基线未知、断线、换日及其他账号不会复用旧累计分钟',async()=>{
  const f=fixture(),pricing=watchFleetRepairPricing(f.client),g=fixture();assert.equal(pricing.minutes(),null);
  pricing.reserve(2);f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:2}]}});
  assert.equal(pricing.minutes(),null,'无基线的发送不凭无关联推送推算准确值');
  f.client.emit('close');f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:59}]}});
  const old=pricing.reserve(1);assert.equal(pricing.minutes(),60);assert.equal(watchFleetRepairPricing(g.client).minutes(),null);
  f.client.serverClockOffsetMs+=86400000;assert.equal(pricing.minutes(),null);
  f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:3}]}});pricing.cancel(old);assert.equal(pricing.minutes(),3);
});
await test('智能省钻在2:01等到1:59，基础档少花10钻；关闭立即按目标执行',async()=>{
  const f=fixture();f.repair();const p=f.settings.fleetSpeed.fleets[0];p.repairSkipSeconds=0;
  watchFleetSpeed(f.client);f.client.emit('message',{name:'SCSpeedUp',body:{data:[{type:4,minutes:0}]}});
  const snapshot=await readFleetSpeed(f.client,f.player);snapshot.fleets[0].repairing.endTs=snapshot.now+121;
  const plan=planFleetSpeed(snapshot,f.config,f.settings,f.ledger);assert.equal(plan.actions.length,0);assert.equal(plan.nextCheckSeconds,2);
  p.repairSmartSave=false;assert.equal(planFleetSpeed(snapshot,f.config,f.settings,f.ledger).actions[0].cost,30);
  p.repairSmartSave=true;snapshot.now+=2;assert.equal(planFleetSpeed(snapshot,f.config,f.settings,f.ledger).actions[0].cost,20);
  snapshot.fleets[0].repairing.endTs=snapshot.now+130;assert.equal(planFleetSpeed(snapshot,f.config,f.settings,f.ledger).actions[0].cost,30);
  snapshot.fleets[0].repairing.endTs=snapshot.now+120;assert.equal(planFleetSpeed(snapshot,f.config,f.settings,f.ledger).actions[0].cost,20);
  p.repairDailyDiamonds=19;assert.equal(planFleetSpeed(snapshot,f.config,f.settings,f.ledger).actions.length,0);
});
await test('兼顾效率：跨过首次计费边界后不继续等下一分钟',async()=>{
  const originalNow=Date.now;let clock=originalNow();Date.now=()=>clock;
  try{
    const f=fixture();f.repair();Object.assign(f.settings.fleetSpeed.fleets[0],{repairSmartWaitSeconds:60,repairSkipSeconds:0});
    f.state.fleets[0].repairing.endTs=f.now()+122;
    const first=await f.run();assert.equal(first.nextCheckSeconds,3);assert.equal(f.writes.length,0);
    clock+=3000;await f.run();assert.equal(f.writes.length,1,'等到1:59后应立即维修加速，不能再等下一分钟');
  }finally{Date.now=originalNow;}
});
await test('省钻等待不占住其他队；耗时读取不能把等待截止向后顺延',async()=>{
  const originalNow=Date.now;let clock=originalNow();Date.now=()=>clock;
  try{
    const f=fixture();f.repair();f.state.fleets[0].repairing.endTs=f.now()+121;
    Object.assign(f.settings.fleetSpeed.fleets[1],{march:true,marchDailyDiamonds:100});
    f.beforeSend=()=>{clock+=3000;};const first=await f.run();
    assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.buildingId,'2远征船');assert.equal(first.nextCheckSeconds,1);
    const wait=f.ledger.keyRecords()['fleet-speed-wait:1001001:1:repair'].details;assert.equal(wait.until-wait.startedAt,2);
    assert.equal(f.ledger.snapshot().uncertain,0);
    f.beforeSend=null;await f.run();assert(f.writes.some(w=>w.name==='SpeedUpRepairRequest'));
  }finally{Date.now=originalNow;}
});
await test('等待截止跨重连和换日保留，旧等待不阻止新维修，预览不写账本',async()=>{
  const originalNow=Date.now;let clock=Date.parse('2026-11-17T15:59:59Z');Date.now=()=>clock;
  try{
    const f=fixture();f.repair();Object.assign(f.settings.fleetSpeed.fleets[0],{repairSmartWaitSeconds:60,repairSkipSeconds:0});
    f.state.fleets[0].repairing.endTs=f.now()+122;
    const before=f.ledger.keyRecords();await f.plan();assert.deepEqual(f.ledger.keyRecords(),before);
    await f.run();clock+=3000;
    const reopened=createUsageLedger('虚构加速',{file:f.file,now:()=>clock}),g=fixture();
    g.settings=structuredClone(f.settings);g.state.fleets=structuredClone(f.state.fleets);
    await runFleetSpeed(g.client,protocol,g.config,g.player,{getSettings:()=>g.settings,ledger:reopened});
    assert.equal(g.writes.length,1,'新连接不得从头再等');
    const snapshot=await readFleetSpeed(g.client,g.player);snapshot.fleets[0]={...snapshot.fleets[0],state:4,repairing:{startTs:snapshot.now,endTs:snapshot.now+122,endDura:100}};
    assert.equal(planFleetSpeed(snapshot,g.config,g.settings,reopened).nextCheckSeconds,3,'新任务有独立短等机会');
  }finally{Date.now=originalNow;}
});
await test('已确认行军加速安排1秒后复查，未知结果不进入快速接续',async()=>{
  const f=fixture();assert.equal((await f.run()).nextCheckSeconds,1);
  const g=fixture();g.mode='unknown';assert.equal((await g.run()).nextCheckSeconds,undefined);await g.run();assert.equal(g.writes.length,1);
});
await test('关闭智能省钻后忽略最少节省秒数；临近目标仅开启时等待',async()=>{
  for(const smartSave of [true,false]){
    const f=fixture();Object.assign(f.settings.fleetSpeed.fleets[0],{marchSmartSave:smartSave,marchMinSavedSeconds:300});
    f.state.fleets[0].moveEndTs=f.now()+62;await f.run();assert.equal(f.writes.length,smartSave?0:1);
  }
  const f=fixture();Object.assign(f.settings.fleetSpeed.fleets[0],{marchSmartSave:false,marchSkipSeconds:0});
  f.state.fleets[0].moveEndTs=f.now()+20;await f.run();assert.equal(f.writes.length,1);
});
await test('行军按服务端向上取整回报逐次核算，最后等1秒可省一次30钻',async()=>{
  for(const smartSave of [true,false]){
    const f=fixture(),policy=f.settings.fleetSpeed.fleets[0];Object.assign(policy,{marchSmartSave:smartSave,marchMinSavedSeconds:1});
    const snapshot=await readFleetSpeed(f.client,f.player),fleet=snapshot.fleets[0];fleet.moveEndTs=snapshot.now+242;
    let clicks=0,waited=0;
    for(let i=0;i<5;i++){
      const plan=planFleetSpeed(snapshot,f.config,f.settings,f.ledger),action=plan.actions[0];
      if(action){
        f.ledger.confirm(f.ledger.reserve(action.counters,action.limits,{},{uniqueKey:action.uniqueKey,details:action.details}));
        snapshot.diamonds-=action.cost;snapshot.observedDiamonds=snapshot.diamonds;
        // 服务端取整方式未实测；采用较保守的向上取整，执行必须信新回包。
        fleet.moveEndTs=snapshot.now+Math.ceil((fleet.moveEndTs-snapshot.now)/2);clicks++;
      }else if(plan.nextCheckSeconds){waited+=plan.nextCheckSeconds;snapshot.now+=plan.nextCheckSeconds;}
      else break;
    }
    assert.equal(clicks,smartSave?2:3);assert.equal(waited,smartSave?1:0);
    assert.equal(f.ledger.snapshot().counters.diamonds,smartSave?60:90);assert(fleet.moveEndTs-snapshot.now<=60);
  }
});
await test('城战名单、主开关和任务归属限制；实际缺少的舰队不展示',async()=>{
  for(const mutate of [f=>f.settings.cityWar.enabled=false,f=>f.settings.cityWar.fleetIds=[],f=>f.state.fleets[0].targetCityId=0,
    f=>f.state.fleets[0].treasureLootUid=123,f=>f.state.fleets[0].chipWar={rewardTs:f.now()+100}]){
    const f=fixture();mutate(f);await f.run();assert.equal(f.writes.length,0);
  }
  const f=fixture();f.state.fleets=f.state.fleets.slice(0,2);assert.equal((await f.plan()).rows.length,2);
  f.repair();f.ledger.confirm(f.ledger.reserve({}, {}, {}, {uniqueKey:'silicon-repair:1001001:1',details:{kind:'siliconRepair',buildingId:'1远征船',sentAt:f.now()}}));
  assert.equal((await f.plan()).actions.length,0);
});
await test('发送前仍复核智能省钻，等待期间关闭城战取消写入',async()=>{
  const f=fixture();f.repair();f.state.fleets[0].repairing.endTs=f.now()+126;
  f.beforeRead=(name,count)=>{if(count===5)f.client.serverClockOffsetMs+=5000;};
  await f.run();assert.equal(f.writes.length,0);assert.equal(f.ledger.snapshot().uncertain,0);
  f.settings.cityWar.enabled=false;await f.run();assert.equal(f.writes.length,0);
});
await test('明确拒绝或确定未发送取消预留；读回失败不取消已发送费用',async()=>{
  for(const mode of ['reject','notSent']){const f=fixture();f.mode=mode;await f.run();assert.equal(f.ledger.snapshot().uncertain,0);assert.equal(f.ledger.snapshot().counters.diamonds,0);}
  const f=fixture();f.readError=true;await f.run();assert.equal(f.ledger.snapshot().uncertain,1);assert.equal(f.ledger.snapshot().counters.diamonds,30);
});
await test('未知加速跨重启、跨日保留预算；同航程缩短才结算',async()=>{
  const f=fixture();f.mode='unknown';await f.run();await f.run();assert.equal(f.writes.length,1);
  const reopened=createUsageLedger('虚构加速',{file:f.file,now:()=>f.now()*1000});f.client.serverClockOffsetMs+=86400000;
  assert.equal(reopened.pendingCounters().diamonds,30);assert.equal(reopened.snapshot().uncertain,1);
  assert.equal(reopened.pendingCounters().fleetSpeedMarch1,30);
  const fleet=f.state.fleets[0];fleet.moveEndTs-=20;
  settleFleetSnapshot(reopened,{worldId:'1001001',fleets:f.state.fleets,now:f.now()});assert.equal(reopened.snapshot().uncertain,0);
});
await test('自然到期不算未知加速成功；归队只释放舰队且保留钻石预留',async()=>{
  const f=fixture();f.repair();f.mode='unknown';await f.run();f.client.serverClockOffsetMs+=121000;
  Object.assign(f.state.fleets[0],{state:1,durability:100,repairing:null,curGridIdx:0,treasureLootUid:0});
  settleFleetSnapshot(f.ledger,{worldId:'1001001',fleets:f.state.fleets,now:f.now()});assert.equal(f.ledger.snapshot().uncertain,1);assert.equal(f.ledger.pendingCounters().diamonds,40);
  assert(Object.values(f.ledger.keyRecords()).some(r=>r.expired&&!r.confirmed));
});
await test('新航程不会误确认旧请求，区服隔离，重复舰队阻止发送',async()=>{
  const f=fixture();f.mode='unknown';await f.run();f.state.fleets[0].moveStartTs+=1;f.state.fleets[0].moveEndTs-=30;
  settleFleetSnapshot(f.ledger,{worldId:'1001001',fleets:f.state.fleets,now:f.now()});assert.equal(f.ledger.snapshot().uncertain,1);
  settleFleetSnapshot(f.ledger,{worldId:'1001002',fleets:f.state.fleets,now:f.now()});assert.equal(f.ledger.snapshot().uncertain,1);
  const g=fixture();g.state.fleets.push(structuredClone(g.state.fleets[0]));await g.run();assert.equal(g.writes.length,0);
});
await test('关闭开关、暂停、切换账号以及末次读回换航程均取消发送',async()=>{
  for(const mutation of [f=>f.settings.cityWar.enabled=false,f=>f.settings.resources.allowDiamonds=false,
    f=>f.settings.fleetSpeed.fleets[0].march=false,f=>f.player.playerId=900002,f=>f.state.fleets[0].moveStartTs+=1]){
    const f=fixture();f.beforeRead=(name,count)=>{if(count===5)mutation(f);};await f.run();assert.equal(f.writes.length,0);assert.equal(f.ledger.snapshot().uncertain,0);
  }
  const f=fixture();await f.run({enabled:()=>false});assert.equal(f.reads,0);
});
await test('并发同队不会多发；确认后旧钻石余额不重复使用',async()=>{
  const f=fixture();await Promise.all([f.run(),f.run()]);assert.equal(f.writes.length,1);
  f.staleBalance=1000;await f.run();assert.equal(f.writes.length,1);f.staleBalance=null;await f.run();assert.equal(f.writes.length,2);
});
await test('返航零目标、缺少报价或错误归属时不加速',async()=>{
  for(const mutate of [f=>f.state.fleets[0].targetCityId=0,f=>f.config.tables.WorldParamCfg.data=[],f=>f.state.fleets[0].owner.playerId=800001]){
    const f=fixture();mutate(f);await f.run();assert.equal(f.writes.length,0);
  }
});
await test('城战逐队加速接入串行调度，每轮每队发送一次',async()=>{
  const f=fixture();for(const [key,value]of Object.entries(f.settings))if(!['fleetSpeed','resources'].includes(key)&&value&&typeof value==='object'){
    for(const field of Object.keys(value))if(typeof value[field]==='boolean')value[field]=false;
  }
  f.settings.cityWar.enabled=true;
  await runLoop(f.client,protocol,{config:f.config,player:f.player,getSettings:()=>f.settings,usageLedger:f.ledger,
    allowMutate:true,isEnabled:()=>false,rounds:1,onStep:e=>f.entries.push(e)});
  assert.equal(f.writes.length,1);assert(f.entries.some(e=>e.taskKey==='cityWar.enabled'&&e.status==='confirmed'));
});
await test('短维修过期瞬态、迟到满耐久、推送确认和只读重试',async()=>{
  const f=fixture(),step={buildingId:'1远征船',body:{buildingId:'1远征船'},beforeDurability:90,sentAt:f.now()};
  assert(fleetRepairConfirmed({state:4,durability:90,repairing:{startTs:f.now()-1,endTs:f.now(),endDura:100}},step,f.now()));
  let reads=0,sends=0;f.client.sendWatch=async()=>{sends++;};f.client.request=async()=>({fleets:[{buildingId:'1远征船',state:1,durability:++reads>=2?100:90,maxDura:100}]});
  const result=await sendRepairAndConfirm(f.client,step,{now:f.now,sleep:async()=>{}});assert.equal(result.durability,100);assert.equal(sends,1);assert.equal(reads,2);
  f.client.sendWatch=async()=>{f.client.emit('message',{name:'SCMyFleetUpdate',body:{fleets:[{buildingId:'1远征船',state:4,durability:90,repairing:{startTs:f.now(),endTs:f.now()+1,endDura:100}}]}});};
  f.client.request=async()=>{throw Error('read timeout');};assert(await sendRepairAndConfirm(f.client,step,{now:f.now,sleep:async()=>{}}));
});
console.log('舰队加速与短维修专项 '+passed+'/'+passed+' 通过'+(process.argv.includes('--real-protocol')?'（真实协议编解码）':''));
}finally{fs.rmSync(root,{recursive:true,force:true});}
