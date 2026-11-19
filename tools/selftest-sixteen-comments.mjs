import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {loadProtocol} from '../src/proto.mjs';import {getConfig} from '../src/config.mjs';
import {guildTechView,readGuildTech,upgradeGuildTech} from '../src/guild-tech.mjs';
import {resourceFieldRows} from '../src/resource-fields.mjs';
import {createUsageLedger} from '../src/automation-settings.mjs';
import {automationWireId} from '../src/automation-policy.mjs';
import {loadMapAsset} from '../src/world.mjs';import {mapRegions} from '../src/world-map-geometry.mjs';
import {PAGE as page} from '../src/page.mjs';
const protocol=loadProtocol(),config=getConfig(),folder=fs.mkdtempSync(path.join(os.tmpdir(),'cw-sixteen-'));let count=0,serial=0;
const test=async(name,fn)=>{await fn();count++;console.log('通过：'+name);};
function fixture(){
 const player={playerId:123,guildId:1001,worldId:2002001001,scenarioId:1},state={levels:new Map([[2010101,5]]),points:999999,stage:5,writes:[],reject:false,unknown:false,afterRead:null};
 const client={request:async(name,body={},response=name.replace(/Request$/,'Response'))=>{
  protocol[name].decode(protocol[name].encode(body).finish());let value;
  if(name==='GuildInfoRequest')value={guild:{guildId:automationWireId(player.guildId)}};
  else if(name==='GuildTechInfoRequest')value={tech:[...state.levels].map(([techId,level])=>({techId,level}))};
  else if(name==='SeasonTaskStageRequest')value={stage:state.stage};
  else if(name==='AllItemRequest'){value={items:[{itemId:'公会科技点',num:state.points},{itemId:'联盟职级科技点',num:1234}]};await state.afterRead?.();}
  else if(name==='UpgradeGuildTechRequest'){state.writes.push(body);if(state.reject)throw Object.assign(Error('拒绝'),{prompt:{prompt:1},request:name});if(state.unknown)throw Error('网络结果未知');const level=(state.levels.get(body.techId)??0)+1;state.levels.set(body.techId,level);value={tech:{techId:body.techId,level}};}
  else throw Error('未允许请求 '+name);
  return protocol[response].decode(protocol[response].encode(value).finish());
 }};
 const file=path.join(folder,++serial+'.json'),ledger=createUsageLedger('fixture',{file});
 return{client,player,state,ledger,file};
}
const options=(f,more={})=>({techId:2010102,expectedLevel:0,maxCost:2000,enabled:()=>true,ledger:f.ledger,...more});
await test('实际赛季配置、缺省零级、科技点与职级科技点分别统计',async()=>{const f=fixture(),v=await readGuildTech(f.client,config,f.player);assert.equal(v.season,2);assert.equal(v.rows.find(r=>r.id===2010102).cost,2000);assert.equal(v.rows.find(r=>r.id===2010102).canUpgrade,true);assert.equal(v.balances[1].value,1234);assert(v.rows.every(r=>config.tables.GuildTechCfg.data.some(c=>c.techId===r.id&&c.season===2)));});
await test('前置等级、阶段上限和科技点不足都阻断升级',async()=>{for(const change of [f=>f.state.levels.clear(),f=>{f.state.stage=1;f.state.levels.set(2010102,10);},f=>f.state.points=1999]){const f=fixture();change(f);await assert.rejects(upgradeGuildTech(f.client,config,f.player,options(f,{expectedLevel:f.state.levels.get(2010102)??0})));assert.equal(f.state.writes.length,0);}});
await test('阶段零采用全部开放上限，最终满级禁止升级',async()=>{const f=fixture();f.state.stage=0;f.state.levels.set(2010102,50);const v=await readGuildTech(f.client,config,f.player);assert.equal(v.rows.find(r=>r.id===2010102).reason,'已满级');});
await test('只升级一级；旧等级的重复点击不能再消费',async()=>{const f=fixture();const r=await upgradeGuildTech(f.client,config,f.player,options(f));assert.equal(r.level,1);await assert.rejects(upgradeGuildTech(f.client,config,f.player,options(f)),/等级已变化/);assert.equal(f.state.writes.length,1);});
await test('目标等级的逐级报价与回执一致，中途余额不足保留已升级等级', async () => {
  const f = fixture();
  const view = await readGuildTech(f.client, config, f.player);
  const row = view.rows.find(r => r.id === 2010102);
  assert.equal(row.costGrowth, config.tables.GuildTechCfg.data.find(r => r.techId === row.id).techPointCostGrowth);
  const step = level => upgradeGuildTech(f.client, config, f.player, options(f, {
    expectedIdentity: view.identity, expectedLevel: level, maxCost: row.cost + level * row.costGrowth,
  }));
  const first = await step(0), second = await step(1);
  assert.deepEqual([first.level, second.level], [1, 2]);
  assert.equal(first.cost + second.cost, 2 * row.cost + row.costGrowth);
  f.state.points = 0;
  await assert.rejects(step(2), /科技点不足/);
  assert.equal(f.state.levels.get(row.id), 2);
  assert.equal(f.state.writes.length, 2);
});
await test('跨级请求重用原身份；换角色、联盟、赛季后，即使等级相同也不继续', async () => {
  for (const field of ['playerId', 'guildId', 'worldId']) {
    const f = fixture();
    const view = await readGuildTech(f.client, config, f.player);
    f.player[field]++;
    await assert.rejects(upgradeGuildTech(f.client, config, f.player, options(f, { expectedIdentity: view.identity })), /已变化/);
    assert.equal(f.state.writes.length, 0);
  }
});
function guildTechFormFixture(respond) {
  const start = page.indexOf('function openGuildTechUpgrade(');
  const end = page.indexOf('\nfunction choice(', start);
  assert(start >= 0 && end > start);
  const controls = Object.fromEntries([...page.matchAll(/id="(guild-tech-[\w-]+)"/g)].map(([,id]) => [id, {}]));
  const get = id => controls['guild-tech-' + id];
  Object.assign(get('upgrade-dialog'), { showModal() { this.open = true; } });
  const target = get('target');
  Object.defineProperty(target, 'valueAsNumber', { get: () => Number(target.value) });
  target.select = get('dismiss').focus = () => {};
  target.checkValidity = target.reportValidity = () => Number.isInteger(target.valueAsNumber)
    && target.valueAsNumber >= Number(target.min) && target.valueAsNumber <= Number(target.max);
  const requests = [], errors = [];
  const call = async (route, options) => {
    assert.equal(route, '/api/guild/tech/upgrade');
    assert.equal(options.method, 'POST');
    const payload = JSON.parse(options.body);
    requests.push(payload);
    return respond(payload);
  };
  const open = new Function('$', 'call', 'reportError', 'refreshProgression',
    "const current='qa', snapshot={paused:false}, disconnected=new Set(), fmt=String; return " + page.slice(start, end)
  )(id => controls[id], call, error => errors.push(error.message), () => {});
  open(
    { id: 123, name: '测试科技', itemId: 'points', itemName: '科技点', canUpgrade: true, level: 3, maxLevel: 8, cost: 40, costGrowth: 10 },
    'qa', { identity: '7:8:9', balances: [{ id: 'points', value: 150 }] });
  get('highest').onclick();
  assert.equal(target.valueAsNumber, 6);
  assert.equal(get('estimate').textContent, '150 科技点');
  return { get, requests, errors, submit: () => get('upgrade-form').onsubmit({ preventDefault() {} }) };
}
const upgradeReceipt = payload => ({ ok: true, level: payload.expectedLevel + 1, cost: payload.maxCost });
await test('科技弹窗按原身份和每级报价提交，连续点击只执行一次', async () => {
  const f = guildTechFormFixture(upgradeReceipt);
  await Promise.all([f.submit(), f.submit()]);
  await f.submit();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests, [40, 50, 60].map((maxCost, i) => ({
    techId: 123, expectedIdentity: '7:8:9', expectedLevel: 3 + i, maxCost, confirm: true,
  })));
  assert.match(f.get('feedback').textContent, /已升至 6 级.*150 科技点/);
});
await test('科技弹窗中途遭拒或主动停止，不再提交下一级', async () => {
  const rejected = guildTechFormFixture(payload => {
    if (payload.expectedLevel === 4) throw Error('科技点不足');
    return upgradeReceipt(payload);
  });
  await rejected.submit();
  assert.deepEqual(rejected.requests.map(p => p.expectedLevel), [3, 4]);
  assert.deepEqual(rejected.errors, ['科技点不足']);
  assert.match(rejected.get('feedback').textContent, /已确认至 4 级/);

  let acknowledge;
  const stopped = guildTechFormFixture(payload => {
    const receipt = upgradeReceipt(payload);
    if (payload.expectedLevel !== 3) return receipt;
    return new Promise(resolve => { acknowledge = () => resolve(receipt); });
  });
  const run = stopped.submit();
  stopped.get('dismiss').onclick();
  acknowledge();
  await run;
  assert.deepEqual(stopped.requests.map(p => p.expectedLevel), [3]);
  assert.deepEqual(stopped.errors, []);
  assert.match(stopped.get('feedback').textContent, /已停止.*4 级.*40 科技点/);
});
await test('费用上限变化、暂停与读取时切换联盟都不发送',async()=>{const a=fixture();await assert.rejects(upgradeGuildTech(a.client,config,a.player,options(a,{maxCost:1999})),/费用/);const b=fixture();await assert.rejects(upgradeGuildTech(b.client,config,b.player,options(b,{enabled:()=>false})),/暂停/);const c=fixture();c.state.afterRead=()=>c.player.guildId=1002;await assert.rejects(upgradeGuildTech(c.client,config,c.player,options(c)),/变化/);assert.equal(a.state.writes.length+b.state.writes.length+c.state.writes.length,0);});
await test('未知结果跨重启保留，其他科技也等待；真实等级增长后解除',async()=>{const f=fixture();f.state.unknown=true;await assert.rejects(upgradeGuildTech(f.client,config,f.player,options(f)),/未知/);f.ledger=createUsageLedger('fixture',{file:f.file});let view=await readGuildTech(f.client,config,f.player,{ledger:f.ledger});assert(view.rows.every(r=>!r.canUpgrade));await assert.rejects(upgradeGuildTech(f.client,config,f.player,options(f)));assert.equal(f.state.writes.length,1);f.state.levels.set(2010102,1);view=await readGuildTech(f.client,config,f.player,{ledger:f.ledger});assert.equal(view.pending,false);});
await test('明确拒绝释放记录，并发调用只发一个请求',async()=>{const f=fixture();f.state.reject=true;await assert.rejects(upgradeGuildTech(f.client,config,f.player,options(f)));assert.equal(Object.keys(f.ledger.keyRecords()).length,0);f.state.reject=false;const values=await Promise.allSettled([upgradeGuildTech(f.client,config,f.player,options(f)),upgradeGuildTech(f.client,config,f.player,options(f))]);assert.equal(values.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.state.writes.length,2);});
await test('协议缺失或异常等级不能伪造可升级状态',()=>{assert.throws(()=>guildTechView(config,{season:2,stage:5,tech:[{techId:2010101,level:-1}],items:[]}));assert.throws(()=>guildTechView(config,{season:2,stage:undefined,tech:[],items:[]}));});
await test('真实资源田样本按城市与联盟等级显示建筑、基础产出，缺数据标未知',()=>{const f=fixture(),info={fields:[{gridIdx:49952,cityId:39,type:3},{gridIdx:5764,cityId:1,type:1}]},r=resourceFieldRows(config,f.player,info,[{id:1001,level:8}]);assert.equal(r[0].level,6);assert.match(r[0].product,/小时/);assert.equal(r[1].level,8);assert.notEqual(r[0].name,'资源田');assert.equal(resourceFieldRows(config,f.player,info,null)[1].level,null);});
await test('真实地图共享边界完全重合，长边水平垂直且保留城市数量',async()=>{const map=await loadMapAsset(1),regions=mapRegions(map),segments=new Map();assert.equal(regions.length,Object.keys(map.cityInfo).length);let long=0;for(const r of regions){const points=[...r.path.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(m=>[+m[1],+m[2]]);for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];if(Math.hypot(b[0]-a[0],b[1]-a[1])>5){assert(a[0]===b[0]||a[1]===b[1]);long++;}const key=[a.join(','),b.join(',')].sort().join('|');segments.set(key,(segments.get(key)||0)+1);}}assert(long>300);assert([...segments.values()].filter(n=>n===2).length>100);});
await test('导航与默认折叠结构正确，内联脚本可解析',()=>{assert(!page.includes('id="loop-view"'));assert(!page.includes('id="page-heading"'));assert(page.includes('id="guild-aid-view"'));assert(page.includes('id="account-details"'));assert(page.includes('建筑一览'));assert(page.includes('id="tab-guild"'));assert.match(page,/<details id="world-stock-panel"><summary>展开分类库存<\/summary>/);for(const script of page.matchAll(/<script>([\s\S]*?)<\/script>/g))new Function(script[1]);});
console.log('十六条批注专项 '+count+'/'+count+' 通过');
