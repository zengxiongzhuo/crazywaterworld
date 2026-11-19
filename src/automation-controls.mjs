import { automationTasks, retiredAutomationTasks } from './automation.mjs';

// 模块总开关与细项分别保存，暂停模块不改动细项选择。
const controls = [];
const add = (key, label, group, options = {}) => controls.push({ key, label, group, fields: [key], ...options });
add('loop.world', '基地执行总开关', '总控制');
add('loop.dailies', '日常行动与点金总开关', '总控制', { help: '控制英雄免费/券招募、点金、竞技场、海盗日常和折扣店。免费领奖等独立项目不由本项控制。' });
add('loop.tasks', '主线、支线与成就总开关', '总控制');
add('dailies.enabled', '每日任务与奖励总开关', '总控制', { help: '控制日常行动和每日任务、活跃宝箱、免费赠礼。钻石点金独立受点金和钻石开关限制。' });
add('heroes.enabled', '英雄自动养成', '总控制', { fields: ['heroes.enabled','loop.heroes'], help: '控制英雄随挂机自动养成；养成动作、目标和资源保留在游戏配置中设置。' });
add('resources.allowDiamonds', '自动钻石消耗总开关', '总控制', { help: '仅授权已开启项目在保存的保留量、次数和预算内消费。不会开启任何其他项目。' });
for (const [key,label] of [
 ['building.enabled','建筑总开关'],['building.collect','收取建筑产出'],['building.build','自动建造'],['building.upgrade','自动升级建筑'],['building.finish','自动完工'],['building.supply','缺料时为建筑备料'],['building.speedUp','建筑自动加速'],
 ['factory.enabled','工厂总开关'],['factory.gain','领取工厂产品'],['factory.produce','工厂自动生产'],['factory.cooperateNative','按需调整原生自动生产'],['factory.speedUp','工厂自动加速'],
 ['farm.enabled','农田总开关'],['resident.enabled','自动交居民订单'],['resident.reroll','刷新不符合条件的订单'],['resident.rewards','领取居民订单进度奖励'],['cargo.enabled','贸易港自动交货与收货'],['events.enabled','处理已支持的随机事件'],
 ['pet.enabled','海兽培育总开关'],['museum.runEnabled','博物馆探宝总开关'],['museum.upgrade','升级博物馆技能与展区'],['museum.revenue','自动领取人气币'],['museum.achievements','自动领取人气奖励'],['museum.display','自动上架藏品'],['museum.enabled','自动探宝'],['gold.enabled','每日钻石点金'],
]) {
 const base = key.split('.')[0], gates = key === 'gold.enabled' ? ['loop.dailies'] : key === 'museum.runEnabled' ? [] : ['loop.world'];
 if (['building','factory'].includes(base) && !key.endsWith('.enabled')) gates.push(base+'.enabled');
 if (base === 'museum' && key !== 'museum.runEnabled') gates.push('museum.runEnabled');
 add(key,label,'基地',{gates});
}
add('forge.enabled','装备自动锻造','装备');
add('gather.enabled','采集总开关','采集',{gates:['loop.world'],help:'在游戏配置 → 采集选择钓鱼、潜水、拾荒、漂浮物和工具养成。关闭总开关会暂停这些项目，保留已选细项。'});
for (const [key,label] of [['fishing','自动钓鱼'],['floaters','拾取海面原料漂浮物'],['antiqueFloaters','打捞海面藏品宝箱'],['diving','潜水打捞原料'],['salvage','拾荒船自动拾荒'],['upgradeFishing','钓具强化与升级'],['upgradeDiving','潜水船坞强化与升级'],['upgradeSalvage','拾荒船强化与升级']]) add('gather.'+key,label,'采集',{gates:['loop.world','gather.enabled']});
for (const [key,label] of [['claimTasks','领取每日任务奖励'],['claimDailyChest','领取每日活跃宝箱'],['claimWeeklyChest','领取每周活跃宝箱'],['claimGift','每日免费赠礼']]) add('dailies.'+key,label,'任务与领奖',{gates:['dailies.enabled']});
add('worldBoss.enabled','世界Boss每日首战派遣','世界与挑战',{configLabel:'每日首战自动派遣',help:'每天仅在服务器计数为0时，将勾选且符合条件的舰队一起派出；未勾选时自动选一队。汽油按队数消耗，结果不明确时不重复派遣。伤害奖励由下方领奖开关独立控制。'});
add('radar.runEnabled','联盟情报总开关','世界与挑战',{help:'统一暂停或恢复情报处理和舰队维修，保留配置中的细项选择。请在下方选择执行动作。'});
add('radar.enabled','联盟情报自动处理','世界与挑战',{gates:['radar.runEnabled'],help:'逐条领取已完成奖励，并用所选空闲舰队处理新情报。不会开启游戏原生月卡自动功能；派遣前检查实际汽油库存和待确认消费。'});
add('radar.repairIdle','自动维修空闲舰队','世界与挑战',{gates:['radar.runEnabled'],help:'普通维修耐久低于80%的空闲舰队，按实际汽油库存检查。'});
add('treasure.enabled','万吨巨轮自动参与','世界与挑战');
add('cityWar.enabled','联盟城战','世界与挑战');
add('progression.enabled','推关与试炼总开关','世界与挑战',{help:'按统一配置自动挑战主线（闯关）和所选试炼。每轮继续推进，达到失败停止次数后本次挂机不再挑战该关；暂停后重新开始挂机可重试。扫荡仍按独立开关执行。'});
add('progression.mainline','主线 / 闯关自动挑战','世界与挑战',{gates:['progression.enabled']});
add('progression.trials','试炼自动推关','世界与挑战',{gates:['progression.enabled']});
add('pirateHunt.enabled','海盗讨伐自动推进','世界与挑战',{configLabel:'自动讨伐首杀',help:'每轮核对本人首杀和舰队状态，自动挑战下一等级。消耗汽油，达到失败停止次数或实际汽油不足时停止派遣；先在配置中选择舰队。每日免费扫荡独立控制。'});
add('antique.enabled','藏品自动养成','藏品',{
 configLabel:'藏品养成总开关', configuredFields:['antique.activate','antique.star','antique.master','antique.suit'],
 help:'开启后，挂机按下方已选动作培养藏品。关闭会暂停藏品养成，仍可编辑各项设置。养成只使用已有资源。',
});
add('appointments.enabled','自动英雄委任','英雄',{help:'在杂项 → 英雄与装备中设置开关和委任优先级，挂机按保存顺序调用游戏一键委任。'});
add('resourceFields.enabled','自动占领资源田','世界与挑战',{help:'按比例或配额占领本盟城市内的资源田，每次检查最多派一队。名额已满时，可放弃超过目标块数的田地来补足其他资源，也会把同类低级田换成可占的高级田。'});
add('trials.paid','试炼钻石扫荡','世界与挑战');
add('trials.ads','试炼免广告扫荡','世界与挑战');
for (const [key,label,group,gates] of [
 ['alliance.enabled','联盟自动化','世界与挑战',[]],['guildShip.enabled','联盟商船','活动',[]],
 ['guildFort.enabled','联盟工事捐赠','世界与挑战',['alliance.enabled']],['silicon.enabled','硅矿自动化','世界与挑战',[]],
 ['heroRaid.enabled','超凡英雄活动','活动',[]],
]) add(key,label,group,{gates});
const nativeKeys = new Set(['trialPaidSweep','trialAdSweep','diveEnhance','autoDive','salvageEnhance','autoSalvage','autoFish','fishEnhance','floaters','antiqueFloaters','cargo','farm','collect','finishUpgrade','build','buildSupply','upgrade','finishOrder','startProduce','speedUp','denyOrder','paidGold','dailyRewards','chests','gift','tasks']);
for (const task of automationTasks) {
 if (task.key === 'stageAuto' || task.key === 'heroGrowth' || retiredAutomationTasks.has(task.key)) continue;
 if (nativeKeys.has(task.key)) continue;
 const group = ['freeRecruit','ticketRecruit','heroRecruitRewards','heroAdRecruit'].includes(task.key) ? '英雄' : ['freeAntiqueRecruit','antiqueRecruitRewards','antiqueAdRecruit'].includes(task.key) ? '藏品' : ['周期活动','限时活动'].includes(task.group) ? '活动' : ['联盟','挑战'].includes(task.group) ? '世界与挑战' : task.group === '日常' ? '日常行动' : task.group === '海面' ? '基地' : '任务与领奖';
 const gates = task.group==='日常' ? ['loop.dailies','dailies.enabled'] : task.key==='adSpeedUpBuilding'?['loop.world','building.enabled']:task.key==='adSpeedUpProduce'?['loop.world','factory.enabled']:task.key==='adSpeedUpMuseum'?['loop.world']:[];
 add('schedule.'+task.key,task.label,group,{gates,taskKey:task.key,...(task.key==='pirate'?{configLabel:'每日免费扫荡',help:'在挂机配置 → 世界 → 海盗讨伐选择扫荡种类。三种海盗共用每日免费次数，无需派舰队，不消耗汽油、耐久或钻石；日常任务完成后仍按剩余次数执行，与首杀开关独立。'}:{}),...(task.key==='guildTitleReward'?{help:'默认关闭，每天只领取服务器确认可领的职级礼包；结果未知时保留记录，不重复提交。'}:{}),...(task.key==='seasonChest'?{help:'默认关闭。每箱消耗服务器指定的 3 把赛季钥匙，钥匙不足时等待，不花钻石。钥匙在进入新赛季时清零。'}:{})});
}
// 模块主控与细项在同一配置分组编辑；主控仍保留独立的保存字段。
const idleModules = {
 'alliance.enabled':['世界','alliance','联盟募兵与互助'],
 'guildFort.enabled':['世界','guildFort','联盟工事'], 'silicon.enabled':['世界','silicon','硅矿'],
 'resourceFields.enabled':['世界','resourceFields','资源田'],
 'loop.world':['基地','building','基地运行'],
 'building.enabled':['基地','building','建筑'], 'factory.enabled':['基地','factory','工厂'],
 'farm.enabled':['基地','farm','农田'], 'resident.enabled':['基地','resident','居民需求'],
 'gather.enabled':['基地','gather','采集'],
 'cargo.enabled':['基地','cargo','贸易港口'], 'events.enabled':['基地','events','随机事件'],
 'pet.enabled':['基地','pet','海兽培育室'], 'museum.runEnabled':['基地','museum','博物馆探宝'],
 'forge.enabled':['装备','forge','装备锻造'], 'gold.enabled':['基地','gold','每日付费点金'],
 'worldBoss.enabled':['世界','worldBoss','世界Boss首战'], 'radar.runEnabled':['世界','radar','联盟情报'],
 'treasure.enabled':['世界','treasure','万吨巨轮'], 'cityWar.enabled':['世界','cityWar','联盟城战'],
 'schedule.pirate':['世界','pirate-hunt','海盗日常扫荡'],
 'progression.enabled':['世界','progression','推关与试炼'],
 'pirateHunt.enabled':['世界','pirate-hunt','海盗讨伐'],
 'heroes.enabled':['英雄','heroes','英雄养成'],
 'antique.enabled':['藏品','antique','藏品养成'],
 'dailies.enabled':['日常与活动','rewards','每日任务与奖励'],
 'loop.tasks':['日常与活动','rewards','主线、支线与成就'],
 'loop.dailies':['日常与活动','daily-actions','日常行动'],
};
for(const control of controls){const module=idleModules[control.key];if(module)Object.assign(control,{idleGroup:module[0],configTarget:module[1],idleLabel:module[2]});}
Object.assign(controls.find(c=>c.key==='museum.runEnabled'),{help:'统一暂停或恢复博物馆升级、领奖、藏品上架和探宝，保留细项选择。自动探宝同时领取探险奖励和派遣探险。',configuredFields:['museum.upgrade','museum.revenue','museum.achievements','museum.display','museum.enabled']});
Object.assign(controls.find(c=>c.key==='museum.enabled'),{help:'自动领取已完成探险的奖励，并按配置继续派遣探险。'});
Object.assign(controls.find(c=>c.key==='radar.runEnabled'),{configuredFields:['radar.enabled','radar.repairIdle']});
export const idleAutomationControls=controls.filter(c=>c.idleGroup);
export const idleControlFields=idleAutomationControls.flatMap(c=>c.fields);
export const automationControls = controls;
export const automationControlFields = controls.flatMap(c=>c.fields);
const get = (settings,path) => path.split('.').reduce((obj,key)=>obj?.[key],settings);
export function automationControlView(settings) {
 return controls.map(c=>({ ...c, enabled:c.fields.every(path=>get(settings,path)===true), configurationNote:c.configuredFields && get(settings,c.key) === true && !c.configuredFields.some(path=>get(settings,path)===true) ? '尚未选择执行动作，请在对应配置中设置。' : '', blockedBy:(c.gates??[]).filter(path=>get(settings,path)!==true).map(path=>controls.find(x=>x.key===path)?.label??path) }));
}
export function setAutomationControl(settings,key,enabled) {
 const control=controls.find(c=>c.key===key);
 if(!control || typeof enabled!=='boolean') throw new Error('无效的挂机控制项');
 const next=structuredClone(settings);
 for(const path of control.fields){const [group,field]=path.split('.');next[group][field]=enabled;}
 return next;
}
