import { exactAutomationId } from './automation-policy.mjs';
import { rewardData } from './missing-rewards.mjs';
import { recordsInWorld, settleFleetSnapshot } from './fleet-settlement.mjs';
import { fleetSpeedConfirmed, sameFleetSpeedOperation, repairDiamondCost, fleetCargoId, fleetSpeedOperationId } from './fleet-speed-evidence.mjs';
import { watchFleetRepairPricing, conservativeRepairMinutes } from './fleet-repair-pricing.mjs';
import { fleetSpeedEnabled } from './fleet-speed-settings.mjs';

export { fleetSpeedEnabled };

const valid = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const nowOf = c => Math.floor((Date.now() + (c.serverClockOffsetMs || 0))/1000);
const dayOf = n => Math.floor((n+28800)/86400);
const active = new WeakSet(), watchers = new WeakMap();
const identity = p => [exactAutomationId(p?.worldId), exactAutomationId(p?.playerId)].join(':');
const fleetData = fleet => ({...rewardData(fleet),treasureLootUid:fleetCargoId(fleet)});

// 仅短等一个计费边界；不会为了省钻无限推迟。行军固定收费，只在临近目标时等自然到达。
export function fleetSpeedWait(policy, mode, remaining) {
  const maxWait=policy[mode+'SmartWaitSeconds'];
  if (!policy[mode+'SmartSave'] || !valid(maxWait,1)) return 0;
  const toTarget = remaining - policy[mode+'SkipSeconds'];
  if (toTarget > 0 && toTarget <= maxWait) return toTarget;
  if (mode === 'repair') {
    const remainder = remaining % 60;
    // 留一秒余量避开客户端倒计时/网络边界；2:01 等到 1:59。
    if (remaining > 60 && remainder > 0 && remainder + 1 <= maxWait) return remainder + 1;
  }
  return 0;
}

function planSpeedWait(plan, keys, snapshot, policy, mode, operation, remaining) {
  const key=`fleet-speed-wait:${snapshot.worldId}:${policy.id.replace('远征船','')}:${mode}`;
  const prior=keys[key]?.details, window=prior?.operation===operation?prior:null;
  const wait=fleetSpeedWait(policy,mode,remaining);
  if(!wait)return 0;
  // 同一任务只短等一次；推送、重连、跨日或再次检查都不能滑动截止时间。
  if(window&&(!valid(window.startedAt,1)||!valid(window.until,window.startedAt)||snapshot.now<window.startedAt||
    snapshot.now+wait>Math.min(window.until,window.startedAt+policy[mode+'SmartWaitSeconds'])))return 0;
  const details=window??{kind:'fleetSpeedWait',worldId:snapshot.worldId,fleetId:policy.id,mode,operation,startedAt:snapshot.now,until:snapshot.now+wait};
  plan.waits.push({key,details});
  plan.nextCheckAt=Math.min(plan.nextCheckAt??Infinity,snapshot.now+wait);
  plan.nextCheckSeconds=Math.min(plan.nextCheckSeconds??Infinity,wait);
  return wait;
}

function rememberSpeedWaits(plan, ledger) {
  for(const {key,details} of plan.waits){
    const prior=ledger.keyRecords()[key];
    if(prior?.details?.operation===details.operation){
      // 这只是本地等待标记，崩溃在 reserve/confirm 中间也没有游戏消费。
      if(!prior.confirmed)ledger.resolveKey(key,true);
    }else if(prior)ledger.resolveKey(key,true,details);
    else ledger.confirm(ledger.reserve({}, {}, {}, {uniqueKey:key,details}));
  }
}

function inCityWarScope(fleet, mode, settings, keys) {
  if (!settings.cityWar.fleetIds.includes(fleet.buildingId)) return false;
  if (mode === 'march') return valid(fleet.targetCityId,1) && fleetCargoId(fleet)==='0' && !(fleet.chipWar?.rewardTs > 0);
  // 其他玩法已确认发起的当前维修由各自设置负责，不能套用城战预算。
  return !Object.values(keys).some(r => !r.expired && r.confirmed &&
    ['siliconRepair','treasureRepair'].includes(r.details?.kind) && r.details.buildingId===fleet.buildingId &&
    r.details.sentAt >= (fleet.repairing?.startTs ?? Infinity)-2);
}

export function watchFleetSpeed(client) {
  if (watchers.has(client)) return watchers.get(client);
  const pricing = watchFleetRepairPricing(client);
  const listeners = new Set();
  const watcher = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    minutes() { return pricing.minutes(); } };
  client.on?.('message', ({name,body}) => {
    if (['SCMyFleetUpdate','SCUpdateResource','SCSpeedUp'].includes(name)) for (const fn of listeners) fn();
  });
  watchers.set(client,watcher); return watcher;
}

export async function readFleetSpeed(client, player) {
  const who = identity(player), watcher = watchFleetSpeed(client);
  const fleets = await client.request('MyFleetsRequest',{},'MyFleetsResponse',8000);
  const resources = rewardData(await client.request('AllResourceRequest',{},'AllResourceResponse',8000));
  const ruby = resources.list?.filter(r=>r.res===4);
  if (!Array.isArray(fleets.fleets) || ruby?.length !== 1 || !valid(ruby[0].amount) || who !== identity(player)) throw Error('舰队或钻石状态未完整同步');
  return { worldId:exactAutomationId(player.worldId), playerId:exactAutomationId(player.playerId), now:nowOf(client),
    fleets:fleets.fleets.map(fleetData), diamonds:ruby[0].amount, observedDiamonds:ruby[0].amount, usedMinutes:watcher.minutes() };
}

export function planFleetSpeed(snapshot, config, settings, ledger) {
  const plan = { actions:[], notes:[], rows:[], waits:[] };
  if (!settings?.cityWar?.enabled) { plan.notes.push('联盟城战未开启，维修及派遣钻石加速暂停'); return plan; }
  if (!snapshot.worldId || !snapshot.playerId) { plan.notes.push('角色或区服未确认'); return plan; }
  const keys = recordsInWorld(ledger.keyRecords(),snapshot.worldId), usage = {...ledger.snapshot().counters};
  if(Object.values(keys).some(r=>r.confirmed && r.details?.kind==='fleetSpeed' && !r.details.balanceObserved &&
    valid(r.details.beforeDiamonds) && (snapshot.observedDiamonds??snapshot.diamonds)>=r.details.beforeDiamonds)){
    plan.notes.push('前次加速已确认，但钻石余额尚未同步，暂不继续花钻');return plan;
  }
  let available = snapshot.diamonds - (ledger.pendingCounters().diamonds ?? 0);
  let usedMinutes = conservativeRepairMinutes(snapshot.usedMinutes, keys);
  for (const policy of settings.fleetSpeed.fleets) {
    const matches = snapshot.fleets.filter(f=>f.buildingId === policy.id), fleet = matches[0];
    if (!matches.length) continue;
    const mode = fleet?.state === 4 ? 'repair' : fleet?.state === 2 ? 'march' : null;
    const row = { id:policy.id, mode, reason:'' }; plan.rows.push(row);
    const block = reason => { row.reason = reason; plan.notes.push(policy.id + '：' + reason); };
    if (matches.length !== 1) { block('舰队未解锁或状态不唯一'); continue; }
    if (!mode) { block('当前没有进行中的维修或派遣'); continue; }
    if (!inCityWarScope(fleet,mode,settings,keys)) { block('不属于所选城战舰队的维修或城战行军'); continue; }
    if (!policy[mode]) { block('该队此项加速已关闭'); continue; }
    if (fleet.owner && exactAutomationId(fleet.owner.playerId) !== snapshot.playerId) { block('舰队归属未确认'); continue; }
    const start = mode === 'repair' ? fleet.repairing?.startTs : fleet.moveStartTs;
    const beforeEnd = mode === 'repair' ? fleet.repairing?.endTs : fleet.moveEndTs;
    const target = mode === 'repair' ? fleet.repairing?.endDura : fleet.targetCityId;
    if (!valid(start,1) || !valid(beforeEnd,start) || !valid(target,1)) { block('任务起止或目标未确认（返航不加速）'); continue; }
    const remaining = beforeEnd - snapshot.now, skip = policy[mode+'SkipSeconds'];
    row.remaining = remaining;
    if (!valid(skip) || remaining <= skip) { block('剩余时间不超过 '+skip+' 秒，不加速'); continue; }
    const cargo = fleetCargoId(fleet);
    const operation = fleetSpeedOperationId(mode,start,target,cargo);
    const wait = planSpeedWait(plan,keys,snapshot,policy,mode,operation,remaining);
    if (wait) {
      row.waitSeconds=wait;
      block('智能省钻：本任务仅短等一次，等待 '+wait+' 秒'+(mode==='repair'?'跨过分钟计费边界或自然达到停止阈值':'自然达到停止阈值')); continue;
    }
    if (policy.marchSmartSave && mode === 'march' && (!valid(policy.marchMinSavedSeconds,1) || Math.floor(remaining/2) < policy.marchMinSavedSeconds)) {
      block('本次预计节省时间不足 '+policy.marchMinSavedSeconds+' 秒，不花钻'); continue;
    }
    if (Object.values(keys).some(r=>!r.expired && !r.confirmed && r.details?.buildingId===policy.id)) { block('该队有结果待确认的操作'); continue; }
    const cost = mode==='repair' ? repairDiamondCost(config,Math.ceil(remaining/60),usedMinutes)
      : config?.tables?.WorldParamCfg?.data.find(r=>r.paramName==='行军加速消耗')?.paramValue;
    row.cost = cost;
    if (!valid(cost,1)) { block('加速费用未确认'); continue; }
    if (!settings.resources?.allowDiamonds) { block('全局钻石消费已关闭'); continue; }
    const counter = 'fleetSpeed'+(mode==='repair'?'Repair':'March')+policy.id.replace('远征船','');
    const limits = { diamonds:settings.resources.diamondDailyLimit, [counter]:policy[mode+'DailyDiamonds'] };
    if (Object.entries(limits).some(([key,limit])=>!valid(limit,1)||!valid(usage[key]??0)||(usage[key]??0)+cost>limit)) { block('达到该项或全局每日钻石上限'); continue; }
    if (!valid(settings.resources.diamondThreshold) || !valid(available) || available-cost<settings.resources.diamondThreshold) { block('钻石不足或低于保留量'); continue; }
    const uniqueKey = `fleet-speed:${snapshot.worldId}:${policy.id.replace('远征船','')}:${operation}:${beforeEnd}`;
    if (keys[uniqueKey]) { block('同一结束时间已有加速记录，等待新状态'); continue; }
    const request = mode==='repair'?'SpeedUpRepairRequest':'SpeedUpFleetRequest';
    const details = {kind:'fleetSpeed',buildingId:policy.id,mode,start,beforeEnd,target,...(mode==='march'?{targetCityId:target}:{}),cargo,operation,cost,sentAt:snapshot.now,beforeDiamonds:snapshot.observedDiamonds??snapshot.diamonds,balanceObserved:false};
    plan.actions.push({kind:'fleetSpeed',request,body:{buildingId:policy.id,...(mode==='repair'?{speedUp:{type:1,useNum:0}}:{})},
      ...details,uniqueKey,counters:{diamonds:cost,fleetSpeedDiamonds:cost,[counter]:cost},limits,costs:[{id:'RUBY',num:cost}],
      label:policy.id.replace('远征船','号舰队')+(mode==='repair'?'维修加速':'派遣加速')+'，预算 '+cost+' 钻石',details});
    available-=cost;for(const key of Object.keys(limits))usage[key]=(usage[key]??0)+cost;
    if(mode==='repair' && usedMinutes!==null)usedMinutes+=Math.ceil(remaining/60);
    row.reason=mode==='repair'?'一次完成剩余维修；未知累计费率时按最高档预留':'本轮仅加速一次，回读后达到阈值即停止';
  }
  return plan;
}

export async function runFleetSpeed(client, protocol, config, player, {getSettings,ledger,enabled=()=>true,onStep,onView}={}) {
  if (!enabled() || !fleetSpeedEnabled(getSettings()) || active.has(client)) return null;
  active.add(client); const who=identity(player);
  const allowed = () => enabled() && client.connected && identity(player)===who && fleetSpeedEnabled(getSettings());
  try {
    const snapshot=await readFleetSpeed(client,player);
    if (!allowed()) return null;
    settleFleetSnapshot(ledger,{worldId:snapshot.worldId,fleets:snapshot.fleets,now:snapshot.now,kinds:['fleetSpeed']});
    for(const [key,r] of Object.entries(recordsInWorld(ledger.keyRecords(),snapshot.worldId)))
      if(r.confirmed&&r.details?.kind==='fleetSpeed'&&!r.details.balanceObserved&&snapshot.diamonds<r.details.beforeDiamonds)
        ledger.updateKeyDetails(key,{...r.details,balanceObserved:true});
    const plan=planFleetSpeed(snapshot,config,getSettings(),ledger);
    rememberSpeedWaits(plan,ledger);
    let remaining=snapshot.diamonds;
    for(const proposed of plan.actions) {
      if(!allowed())break;
      const settings=getSettings(),fresh=await readFleetSpeed(client,player);
      fresh.diamonds=Math.min(fresh.diamonds,remaining);
      if(!allowed()||settings!==getSettings())break;
      const reviewed=planFleetSpeed(fresh,config,settings,ledger);
      rememberSpeedWaits(reviewed,ledger);
      if(reviewed.nextCheckAt)plan.nextCheckAt=Math.min(plan.nextCheckAt??Infinity,reviewed.nextCheckAt);
      const step=reviewed.actions.find(a=>a.uniqueKey===proposed.uniqueKey&&a.cost<=proposed.cost);
      if(!step||!protocol?.[step.request]||dayOf(fresh.now)!==dayOf(nowOf(client)))continue;
      const permission=()=>allowed()&&settings===getSettings()&&settings.resources.allowDiamonds&&
        settings.cityWar.fleetIds.includes(step.buildingId) && settings.fleetSpeed.fleets.find(p=>p.id===step.buildingId)?.[step.mode];
      // 报价读取之后，再确认同一航程/维修未变化，且未自然到达阈值。
      const last=await client.request('MyFleetsRequest',{},'MyFleetsResponse',8000);
      const own=last.fleets?.map(fleetData).filter(f=>f.buildingId===step.buildingId);
      if(!permission()||own?.length!==1||!sameFleetSpeedOperation(own[0],step)||
        (step.mode==='repair'?own[0].repairing.endTs:own[0].moveEndTs)!==step.beforeEnd||
        step.beforeEnd-nowOf(client)<=settings.fleetSpeed.fleets.find(p=>p.id===step.buildingId)[step.mode+'SkipSeconds']||
        !inCityWarScope(own[0],step.mode,settings,recordsInWorld(ledger.keyRecords(),fresh.worldId)))continue;
      const policy=settings.fleetSpeed.fleets.find(p=>p.id===step.buildingId),remainingSeconds=step.beforeEnd-nowOf(client);
      const wait=planSpeedWait(plan,recordsInWorld(ledger.keyRecords(),fresh.worldId),{...fresh,now:nowOf(client)},policy,step.mode,step.operation,remainingSeconds);
      if(wait){rememberSpeedWaits(plan,ledger);continue;}
      if (policy.marchSmartSave && step.mode==='march' && Math.floor(remainingSeconds/2)<policy.marchMinSavedSeconds) continue;
      if(step.mode==='repair'){
        const finalCost=repairDiamondCost(config,Math.ceil((step.beforeEnd-nowOf(client))/60),
          conservativeRepairMinutes(watchFleetSpeed(client).minutes(),recordsInWorld(ledger.keyRecords(),fresh.worldId)));
        if(!valid(finalCost,1)||finalCost>step.cost)continue;
      }
      const ticket=ledger.reserve(step.counters,step.limits,{}, {uniqueKey:step.uniqueKey,details:step.details});
      if(!permission()||dayOf(fresh.now)!==dayOf(nowOf(client))){ledger.cancel(ticket);break;}
      let entry, sent=false, attempted=false, observed=false, pricingTicket;
      const inspect=list=>{if(!Array.isArray(list))return;const f=list.map(fleetData).filter(f=>f.buildingId===step.buildingId);if(f.length===1&&fleetSpeedConfirmed(f[0],step,nowOf(client)))observed=true;};
      const listener=({name,body})=>{if(name==='SCMyFleetUpdate')inspect(body?.fleets);};
      client.on?.('message',listener);
      try {
        if(step.mode==='repair')pricingTicket=watchFleetRepairPricing(client).reserve(Math.ceil((step.beforeEnd-nowOf(client))/60));
        try { attempted=true;await client.sendWatch(step.request,step.body,{window:600});sent=true; }
        catch(error) { if((error.prompt||error.notSent)&&error.request===step.request){ledger.cancel(ticket);watchFleetRepairPricing(client).cancel(pricingTicket);entry={step,ok:false,status:'rejected',error:error.message};}else throw error; }
        if(sent){
          const after=await client.request('MyFleetsRequest',{},'MyFleetsResponse',8000);inspect(after.fleets);
          if(identity(player)!==who)observed=false;
          if(observed)ledger.confirm(ticket);
          const current=after.fleets?.map(fleetData).filter(f=>f.buildingId===step.buildingId);
          if(observed&&step.mode==='march'&&current?.length===1&&sameFleetSpeedOperation(current[0],step)&&
            current[0].moveEndTs-nowOf(client)>policy.marchSkipSeconds)
            plan.nextCheckAt=Math.min(plan.nextCheckAt??Infinity,nowOf(client)+1);
          entry={step,ok:observed,status:observed?'confirmed':'unknown',note:observed?'服务器已确认加速，下一轮按新的剩余时间核对':'加速结果未确认，保留钻石预算，不重复加速'};
        }
      }catch(error){
        if(!attempted){ledger.cancel(ticket);watchFleetRepairPricing(client).cancel(pricingTicket);}
        entry={step,ok:false,status:attempted?'unknown':'rejected',error:error.message};
      }
      finally{client.off?.('message',listener);}
      onStep?.(entry);
      if(entry.status!=='rejected')remaining-=step.cost;
      if(entry.status==='unknown')break;
    }
    if(plan.nextCheckAt)plan.nextCheckSeconds=Math.max(1,plan.nextCheckAt-nowOf(client));
    onView?.(plan);return plan;
  }finally{active.delete(client);}
}
