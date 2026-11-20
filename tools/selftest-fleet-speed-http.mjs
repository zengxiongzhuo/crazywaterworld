import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cw-fleet-speed-http-'));
process.env.CW_DATA_DIR=directory;process.env.CW_CONFIG_PACK=path.join(directory,'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE='0';
fs.writeFileSync(process.env.CW_CONFIG_PACK,JSON.stringify([[0,'WorldParamCfg',{data:[{paramName:'行军加速消耗',paramValue:30}]}],
  [1,'BuildingUnlockCfg',{data:[1,2,3].map(i=>({buildingType:'远征船',buildingId:i+'远征船'}))}],
  [2,'SpeedUpRubyCfg',{data:[{minute:0,fleet:10}]}]]));
const {saveStore}=await import('../src/accounts.mjs');
const {createConsole}=await import('./fixtures/console-server.mjs');
const {createUsageLedger,loadAutomationSettings}=await import('../src/automation-settings.mjs');
const {observeOwnedFleets,ownedFleetCatalog}=await import('../src/fleet-catalog.mjs');
saveStore({activeId:'speed-a',accounts:['speed-a','speed-b'].map(id=>({id,label:id,url:'ws://invalid.invalid',login:{},automation:{enabled:false,paused:false}}))});
const app=createConsole({port:0,protocol:{}}),base=await app.listen();
const api=async(route,body,account='speed-a')=>{const r=await fetch(base+'/api/'+route+(route.includes('?')?'&':'?')+'account='+account,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});return{status:r.status,data:await r.json()};};
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
let client;
try{
  let view=ok(await api('settings'));assert(!Object.hasOwn(view.settings.fleetSpeed,'enabled'));
  assert(view.settings.fleetSpeed.fleets.every(fleet=>!Object.hasOwn(fleet,'repairMaxDiamonds')&&!Object.hasOwn(fleet,'marchMaxDiamonds')));
  assert.deepEqual(view.catalog.expeditionFleets,[]);assert.equal(view.catalog.fleetAvailability.known,false);
  const settings=structuredClone(view.settings);settings.fleetSpeed.enabled=false;settings.fleetSpeed.dailyDiamondLimit=100;
  settings.cityWar.enabled=true;settings.cityWar.fleetIds=['1远征船','2远征船','3远征船'];
  settings.resources.allowDiamonds=true;Object.assign(settings.fleetSpeed.fleets[1],{march:true,marchDailyDiamonds:90});
  // 兼容旧页面或导入文件的废弃字段，包括旧版不合法值；不继续执行其限制。
  for(const [i,fleet] of settings.fleetSpeed.fleets.entries())Object.assign(fleet,{repairMaxDiamonds:[0,-1,'obsolete'][i],marchMaxDiamonds:[1,'obsolete',-1][i]});
  view=ok(await api('settings',{settings,revision:view.revision,baseRevision:view.baseRevision}));
  assert(!Object.hasOwn(view.settings.fleetSpeed,'enabled'),'旧页面提交的加速开关被清理');
  assert.equal(Object.hasOwn(view.settings.fleetSpeed,'dailyDiamondLimit'),false,'旧页面提交的合计上限被清理');
  assert.equal(Object.hasOwn(view.rules.numbers,'fleetSpeed.dailyDiamondLimit'),false);
  delete settings.fleetSpeed.enabled;delete settings.fleetSpeed.dailyDiamondLimit;
  for(const [i,fleet] of view.settings.fleetSpeed.fleets.entries())for(const key of ['repairMaxDiamonds','marchMaxDiamonds']){
    assert.equal(Object.hasOwn(fleet,key),false,'旧单次上限不能继续保存');
    assert.equal(Object.hasOwn(view.rules.numbers,'fleetSpeed.fleets.'+i+'.'+key),false,'旧单次上限不能出现在界面规则');
    delete settings.fleetSpeed.fleets[i][key];
  }
  assert.deepEqual(loadAutomationSettings('speed-a').settings.fleetSpeed,settings.fleetSpeed);
  assert.deepEqual(ok(await api('settings/export')).settings.fleetSpeed,settings.fleetSpeed);
  assert(ok(await api('settings',undefined,'speed-b')).settings.fleetSpeed.fleets.every(fleet=>!fleet.repair&&!fleet.march));
  assert.equal(app.sessions.get('speed-a').loop.running,false);
  const controls=ok(await api('loop')).controls;assert(!controls.some(c=>c.key==='fleetSpeed.enabled'));
  assert.equal(controls.find(c=>c.key==='cityWar.enabled').configTarget,'cityWar');
  const time=Math.floor(Date.now()/1000),writes=[];
  client=new EventEmitter();Object.assign(client,{connected:true,serverClockOffsetMs:0,freeRecruitTimes:{hero:0,antique:0},snapshot:()=>({connected:true,state:'READY'}),stop(){this.connected=false;},
    async request(name){if(name==='MyFleetsRequest')return{fleets:[{buildingId:'1远征船',state:1},{buildingId:'2远征船',state:2,moveStartTs:time-10,moveEndTs:time+300,targetGridIdx:42,targetCityId:7,treasureLootUid:0}]};if(name==='AllResourceRequest')return{list:[{res:4,amount:1000}]};throw Error('undeclared '+name);},
    async sendWatch(name){writes.push(name);throw Error('read-only preview sent write');}});
  const session=app.sessions.get('speed-a');session.client=client;session.player={playerId:900001,worldId:1001001};
  view=ok(await api('settings?fleets=1'));assert.deepEqual(view.catalog.expeditionFleets.map(f=>f.value),['1远征船','2远征船']);
  assert.equal(view.catalog.fleetAvailability.known,true);
  // 未解锁的旧选择不在界面出现，但不能使其他字段保存失败或丢失历史配置。
  settings.fleetSpeed.fleets[0].repairSmartSave=false;settings.fleetSpeed.fleets[0].repairSmartWaitSeconds=8;
  settings.fleetSpeed.fleets[0].marchSmartSave=true;settings.fleetSpeed.fleets[0].marchSmartWaitSeconds=3;
  view=ok(await api('settings',{settings,revision:view.revision,baseRevision:view.baseRevision}));
  assert.deepEqual(view.settings.cityWar.fleetIds,settings.cityWar.fleetIds);
  assert.equal(view.settings.fleetSpeed.fleets[0].repairSmartSave,false);assert.equal(view.settings.fleetSpeed.fleets[0].marchSmartSave,true);
  assert.equal(view.settings.fleetSpeed.fleets[0].repairSmartWaitSeconds,8);assert.equal(view.settings.fleetSpeed.fleets[0].marchSmartWaitSeconds,3);
  assert.deepEqual(view.catalog.expeditionFleets.map(f=>f.value),['1远征船','2远征船']);
  observeOwnedFleets(session,[{buildingId:'1远征船'}]);assert.deepEqual(session.ownedFleets.ids,['1远征船','2远征船']);
  observeOwnedFleets(session,[{buildingId:'3远征船'}]);assert.deepEqual(session.ownedFleets.ids,['1远征船','2远征船','3远征船']);
  observeOwnedFleets(session,[{buildingId:'1远征船'},{buildingId:'2远征船'}],{complete:true});
  assert.equal(ownedFleetCatalog({...session,player:{...session.player,worldId:1001002}},view.catalog).fleetAvailability.known,false);
  assert.deepEqual(ownedFleetCatalog({...session,player:null,client:null},view.catalog).expeditionFleets.map(f=>f.value),['1远征船','2远征船']);
  assert.equal(ok(await api('settings',undefined,'speed-b')).catalog.fleetAvailability.known,false);
  const ledger=createUsageLedger('speed-a'),before=ledger.snapshot();
  const preview=ok(await api('settings/preview',{settings,category:'fleetSpeed'}));assert.equal(preview.viewOnly,true);assert.equal(preview.actions.length,1);assert.match(preview.actions[0].label,/2号舰队/);assert.deepEqual(ledger.snapshot(),before);assert.equal(writes.length,0);
  for(const oldLimit of [0,1]){
    const legacy=structuredClone(settings);legacy.fleetSpeed.fleets[1].marchMaxDiamonds=oldLimit;
    const compatible=ok(await api('settings/preview',{settings:legacy,category:'fleetSpeed'}));
    assert.equal(compatible.actions.length,1,'旧派遣上限不再阻止预览');
  }
  for(const scope of ['fleet','global']){
    const limited=structuredClone(settings);
    if(scope==='fleet')limited.fleetSpeed.fleets[1].marchDailyDiamonds=0;
    else limited.resources.diamondDailyLimit=0;
    assert.equal(ok(await api('settings/preview',{settings:limited,category:'fleetSpeed'})).actions.length,0,'每日预算为0仍禁止加速');
  }
  assert.deepEqual(ledger.snapshot(),before);assert.equal(writes.length,0);
  settings.schedule.guildWelfare=false;
  const cityPreview=ok(await api('settings/preview',{settings,category:'cityWar'}));
  assert.equal(cityPreview.actions.filter(action=>action.kind==='fleetSpeed').length,1);
  const disabled=structuredClone(settings);disabled.resources.allowDiamonds=false;
  const blocked=ok(await api('settings/preview',{settings:disabled,category:'cityWar'}));
  assert(blocked.notes.some(note=>note.includes('全局钻石消费已关闭')),'城战预览应说明阻止逐队加速的全局钻石设置');
  assert.equal(blocked.actions.filter(action=>action.kind==='fleetSpeed').length,0);
  assert.deepEqual(ledger.snapshot(),before);assert.equal(writes.length,0);
  const invalid=structuredClone(settings);invalid.fleetSpeed.fleets[1].marchDailyDiamonds=-1;
  assert.equal((await api('settings',{settings:invalid,revision:view.revision})).status,400);
  console.log('通过：城战加速 HTTP 持久化、账号隔离、真实两舰队目录、部分推送与解锁、旧选择保存、只读预览和非法预算拒绝，零游戏写入');

  const repair = { buildingId:'1远征船', owner:{ playerId:session.player.playerId }, state:4, durability:100, maxDura:2200,
    repairing:{startTs:time-20,endTs:time+102,endDura:2200} };
  const idle = { buildingId:'2远征船', state:1, durability:2200, maxDura:2200 };
  let balance=1000;
  client.protocol = {MyFleetsRequest:{},MyFleetsResponse:{},AllResourceRequest:{},AllResourceResponse:{},SpeedUpRepairRequest:{}};
  client.request=async name=>{
    if(name==='MyFleetsRequest')return {fleets:structuredClone([repair,idle])};
    if(name==='AllResourceRequest')return {list:[{res:4,amount:balance}]};
    return {};
  };
  client.sendWatch=async (name,body)=>{
    assert.equal(name,'SpeedUpRepairRequest');
    assert.deepEqual(body,{buildingId:repair.buildingId,speedUp:{type:1,useNum:0}});
    writes.push(name);
    balance-=20;
    Object.assign(repair,{state:1,durability:2200,repairing:null});
  };
  const rows=ok(await api('world/overview')).fleets;
  const target=rows.find(f=>f.id===repair.buildingId).speedTarget;
  assert.equal(target.mode,'repair');
  assert.equal(rows.find(f=>f.id===idle.buildingId).speedTarget,null);
  const previewRoute='world/fleet-speed/preview',actionRoute='world/fleet-speed/action';
  const quote=ok(await api(previewRoute,target));
  assert.equal(quote.maxCost,20);
  const command={token:quote.token,confirmedCost:quote.maxCost,confirm:true};
  assert.equal((await api(actionRoute,{...command,confirm:false})).status,400);
  assert.equal((await api(actionRoute,{...command,confirmedCost:1})).status,400);
  assert.equal((await api(actionRoute,command,'speed-b')).status,400);
  assert.deepEqual(writes,[]);
  repair.repairing.startTs++;
  assert.equal((await api(previewRoute,target)).status,400,'地图上的旧维修不能给新维修报价');
  const old=await api(actionRoute,command);
  assert(old.status===400 || old.data.status!=='completed');
  assert.deepEqual(writes,[]);
  const currentTarget=ok(await api('world/overview')).fleets[0].speedTarget;
  const fresh=ok(await api(previewRoute,currentTarget));
  const confirmed={confirm:true,token:fresh.token,confirmedCost:fresh.maxCost};
  const results=await Promise.all([api(actionRoute,confirmed),api(actionRoute,confirmed)]);
  assert.deepEqual(ok(results[0]),ok(results[1]));
  assert.deepEqual(writes,['SpeedUpRepairRequest']);
  assert.equal(ok(await api('world/overview')).fleets[0].speedTarget,null);
  console.log('通过：总览舰队维修报价、任务变化、账号隔离、费用确认与重复提交');
}finally{app.server.closeAllConnections();await app.close();fs.rmSync(directory,{recursive:true,force:true});}
