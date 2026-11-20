import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { exactAutomationId } from './automation-policy.mjs';
import { readFleetSpeed } from './fleet-speed.mjs';
import { fleetCargoId, fleetSpeedConfirmed, fleetSpeedOperationId, repairDiamondCost } from './fleet-speed-evidence.mjs';
import { conservativeRepairMinutes, watchFleetRepairPricing } from './fleet-repair-pricing.mjs';
import { recordsInWorld } from './fleet-settlement.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const endOf = (fleet, mode) => mode === 'repair' ? fleet.repairing?.endTs : fleet.moveEndTs;
const requestOf = mode => mode === 'repair' ? 'SpeedUpRepairRequest' : 'SpeedUpFleetRequest';

// 截止时间在每次行军加速后都会改变，用起点时间和目的地绑定用户点选的任务。
export function fleetSpeedTarget(fleet, player) {
  const buildingId = fleet?.buildingId, worldId = exactAutomationId(player?.worldId), playerId = exactAutomationId(player?.playerId);
  if (!/^[1-9]\d*远征船$/.test(buildingId) || !worldId || !playerId ||
      (fleet.owner && exactAutomationId(fleet.owner.playerId) !== playerId)) return null;
  const role = { buildingId, worldId, playerId };
  if (fleet.state === 4) {
    const { startTs, endTs, endDura } = fleet.repairing ?? {};
    return positive(startTs) && positive(endDura) && Number.isSafeInteger(endTs) && endTs >= startTs
      ? { ...role, mode:'repair', start:startTs, target:endDura } : null;
  }
  const targetCityId = fleet.targetCityId ?? 0, targetGridIdx = fleet.targetGridIdx ?? 0;
  if (fleet.state !== 2 || !positive(fleet.moveStartTs) || !Number.isSafeInteger(fleet.moveEndTs) ||
      fleet.moveEndTs < fleet.moveStartTs || !(positive(targetCityId) || positive(targetGridIdx))) return null;
  return { ...role, mode:'march', start:fleet.moveStartTs, target:targetCityId || targetGridIdx,
    targetCityId, targetGridIdx, cargo:fleetCargoId(fleet) };
}

function selectedFleet(rows, player, target) {
  const matches = rows.filter(f => f.buildingId === target.buildingId);
  if (matches.length !== 1 || (matches[0].owner && exactAutomationId(matches[0].owner.playerId) !== exactAutomationId(player.playerId)))
    throw Error('未能确认所选舰队的当前状态');
  return matches[0];
}

function atDestination(fleet, target) {
  if (target.mode === 'repair') return fleet.state === 1 && Number.isSafeInteger(fleet.durability) && fleet.durability >= target.target;
  if (![1,3,5].includes(fleet.state)) return false;
  if (target.targetGridIdx && fleet.curGridIdx > 0) return fleet.curGridIdx === target.targetGridIdx;
  return target.cargo === '0' && target.targetCityId > 0 && fleet.cityId === target.targetCityId;
}

function price(config, target, seconds, usedMinutes) {
  const cost = target.mode === 'repair'
    ? repairDiamondCost(config, Math.ceil(seconds / 60), usedMinutes)
    : config?.tables?.WorldParamCfg?.data?.find(row => row.paramName === '行军加速消耗')?.paramValue;
  if (!positive(cost)) throw Error('舰队加速费用未同步');
  return cost;
}

function funds(snapshot, ledger, fleet, reconcile=false) {
  const records = recordsInWorld(ledger.keyRecords(),snapshot.worldId);
  let available = snapshot.diamonds - (ledger.pendingCounters().diamonds ?? 0);
  for (const [key,row] of Object.entries(records)) {
    const d = row.details;
    if (!row.confirmed && !row.expired && d?.buildingId === fleet.buildingId && ['fleetSpeed','siliconSpeed','treasureSpeed'].includes(d.kind)) {
      if (d.kind !== 'fleetSpeed' || !fleetSpeedConfirmed(fleet,d,snapshot.now)) throw Error('该舰队上次加速结果待确认，请稍后刷新');
      if (reconcile) ledger.resolveKey(key,true);
      // 已证明这笔加速生效，且余额已更新，才释放未决费用的占用。
      if (snapshot.diamonds < d.beforeDiamonds) available += d.cost;
    }
    if (row.confirmed && d?.kind === 'fleetSpeed' && !d.balanceObserved) {
      if (snapshot.diamonds >= d.beforeDiamonds) available -= d.cost;
      else if (reconcile) ledger.updateKeyDetails(key,{...d,balanceObserved:true});
    }
  }
  return { available, usedMinutes:conservativeRepairMinutes(snapshot.usedMinutes,records) };
}

export async function previewManualFleetSpeed(client, protocol, config, player, target, { ledger }) {
  if (!target || !['march','repair'].includes(target.mode) || !protocol?.[requestOf(target.mode)]) throw Error('当前舰队或加速协议不可用');
  const snapshot = await readFleetSpeed(client,player), fleet = selectedFleet(snapshot.fleets,player,target);
  const current = fleetSpeedTarget(fleet,player);
  if (!isDeepStrictEqual(current,target)) throw Error('舰队任务已变化，请刷新后重选');
  const remaining = endOf(fleet,target.mode) - snapshot.now;
  if (remaining <= 0) throw Error('舰队任务已经到期，请刷新状态');
  const { available,usedMinutes } = funds(snapshot,ledger,fleet);
  const unitCost = price(config,target,remaining,usedMinutes);
  // 向上取整的剩余时间每次减半；最后一秒只等到达回读，不再花钻。
  const maxCost = target.mode === 'repair' ? unitCost : Math.ceil(Math.log2(remaining)) * unitCost;
  if (!Number.isSafeInteger(maxCost) || maxCost > available) throw Error('完成本次加速最多需要 '+maxCost+' 钻石，可用 '+available+' 钻石');
  return { ...current, maxCost };
}

async function readSelected(client,player,target) {
  const { fleets } = await client.request('MyFleetsRequest',{},'MyFleetsResponse',8000);
  if (!Array.isArray(fleets)) throw Error('舰队状态未同步');
  return selectedFleet(fleets,player,target);
}

export async function runManualFleetSpeed(client,protocol,config,player,preview,{ledger,validate}) {
  const { maxCost,...target } = preview, { buildingId,mode } = target;
  const request = requestOf(mode), repair = mode === 'repair', pricing = watchFleetRepairPricing(client);
  if (!protocol?.[request] || !Number.isSafeInteger(maxCost) || maxCost < 0) throw Error('加速报价无效');
  const operation = fleetSpeedOperationId(mode,target.start,target.target,target.cargo??'0');
  let steps = 0, committed = 0;
  const result = (status, message) => ({ status, steps, message:buildingId+' · '+message });
  const complete = () => result('completed',repair?'维修已完成':'已抵达目的地');
  const stillCurrent = fleet => isDeepStrictEqual(fleetSpeedTarget(fleet,player),target);
  async function waitForArrival() {
    // 游戏到时可能先推倒计时、再推舰队状态；这段时间仅查询，不重复支付。
    for (let i=0;i<9;i++) {
      validate();
      const fleet = await readSelected(client,player,target);
      if (atDestination(fleet,target)) return complete();
      if (!stillCurrent(fleet)) break;
      if (i<8) await delay(500);
    }
    return result('unknown',repair?'维修完成状态待同步':'抵达状态待同步');
  }
  try {
    validate();
    let snapshot = await readFleetSpeed(client,player);
    for (;;) {
      validate();
      // 余额读取后再核对一次舰队，避免把等待期间的新任务加速。
      const fleet = await readSelected(client,player,target);
      validate();
      if (!stillCurrent(fleet)) {
        if (atDestination(fleet,target)) return complete();
        throw Error('舰队任务已变化，请刷新后重选');
      }
      const beforeEnd = endOf(fleet,mode), now = nowOf(client), remaining = beforeEnd - now;
      if (remaining <= (repair ? 0 : 1)) return await waitForArrival();
      const {available,usedMinutes} = funds({...snapshot,now,usedMinutes:pricing.minutes()},ledger,fleet,true);
      const cost = price(config,target,remaining,usedMinutes);
      if (committed + cost > maxCost || cost > available) throw Error('费用或可用钻石已变化，请重新确认');
      const uniqueKey = ['fleet-speed',target.worldId,buildingId.replace('远征船',''),operation,beforeEnd].join(':');
      const details = { ...target,kind:'fleetSpeed',operation,beforeEnd,cost,sentAt:now,beforeDiamonds:snapshot.diamonds,balanceObserved:false };
      const counters = { diamonds:cost, fleetSpeedDiamonds:cost };
      const ticket = ledger.reserve(counters,{}, {},{uniqueKey,details});
      let minutes, attempted=false, paidProgress=false, arrived=false;
      const inspect = candidate => {
        if (!candidate || candidate.buildingId !== buildingId ||
            (candidate.owner && exactAutomationId(candidate.owner.playerId) !== target.playerId)) return;
        if (atDestination(candidate,target)) {
          arrived = true;
          if (nowOf(client) < beforeEnd) paidProgress = true;
        } else if (stillCurrent(candidate) && endOf(candidate,mode) < beforeEnd) paidProgress = true;
      };
      const onMessage = ({name,body}) => {if(name==='SCMyFleetUpdate')for(const f of body?.fleets??[])inspect(f);};
      client.on?.('message',onMessage);
      try {
        if (repair) minutes = pricing.reserve(Math.ceil(remaining/60));
        validate();
        attempted=true;
        try {
          await client.sendWatch(request,repair ? {buildingId,speedUp:{type:1,useNum:0}} : {buildingId},{window:600});
        } catch (error) {
          if (error.request===request && (error.notSent || error.prompt)) attempted=false;
          throw error;
        }
        for (let i=0;i<4 && !arrived && !paidProgress;i++) {
          if (i) await delay(250);
          validate();
          inspect(await readSelected(client,player,target));
        }
        if (paidProgress) {
          ledger.confirm(ticket);
          committed+=cost;
          steps++;
          // 已确认任务进度后，余额回读只用于释放旧余额的本地占用。
          try { snapshot = await readFleetSpeed(client,player); }
          catch (error) { if (arrived) return complete(); throw error; }
          if (snapshot.diamonds < details.beforeDiamonds) ledger.updateKeyDetails(uniqueKey,{...details,balanceObserved:true});
          inspect(selectedFleet(snapshot.fleets,player,target));
        }
        if (arrived) return complete();
        if (!paidProgress) return result('unknown','加速结果待确认，请稍后刷新');
        if (repair) return await waitForArrival();
      } catch (error) {
        if (attempted) return result('unknown','加速结果待确认：'+error.message);
        ledger.cancel(ticket);
        pricing.cancel(minutes);
        throw error;
      } finally { client.off?.('message',onMessage); }
    }
  } catch (error) {
    if (!steps) throw error;
    return result('partial','已确认 '+steps+' 次加速，'+error.message);
  }
}
