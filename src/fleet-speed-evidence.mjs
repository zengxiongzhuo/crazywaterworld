import { createHash } from 'node:crypto';
import { exactAutomationId } from './automation-policy.mjs';
export const fleetSpeedKind = 'fleetSpeed';
export const fleetCargoId = fleet => exactAutomationId(fleet?.treasureLootUid) ?? '0';
export const fleetSpeedOperationId = (mode,start,target,cargo) =>
  createHash('sha256').update(JSON.stringify([mode,start,target,cargo])).digest('hex').slice(0,20);
export function sameFleetSpeedOperation(fleet, d) {
  return fleet?.buildingId === d.buildingId && (d.mode === 'repair'
    ? fleet.state === 4 && fleet.repairing?.startTs === d.start && fleet.repairing?.endDura === d.target
    : fleet.state === 2 && fleet.moveStartTs === d.start && (d.targetCityId ? fleet.targetCityId === d.targetCityId : fleet.targetGridIdx === d.target) &&
      fleetCargoId(fleet) === d.cargo);
}
export function fleetSpeedConfirmed(fleet, d, now) {
  if (sameFleetSpeedOperation(fleet, d)) {
    const end = d.mode === 'repair' ? fleet.repairing.endTs : fleet.moveEndTs;
    return Number.isSafeInteger(end) && end >= d.start && end < d.beforeEnd;
  }
  // 正常到期不能证明加速成功。维修只能在原截止前观察到目标耐久补满。
  return d.mode === 'repair' && now < d.beforeEnd && fleet?.buildingId === d.buildingId &&
    fleet.state === 1 && Number.isSafeInteger(d.target) && fleet.durability >= d.target;
}

export function repairDiamondCost(config, minutes, usedMinutes = null) {
  const prices = (config?.tables?.SpeedUpRubyCfg?.data ?? []).slice().sort((a,b) => a.minute-b.minute);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || !prices.length || prices[0].minute !== 0 ||
    prices.some((p,i) => !Number.isFinite(p.minute) || p.minute < 0 || !Number.isFinite(p.fleet) || p.fleet <= 0 || i > 0 && p.minute <= prices[i-1].minute)) return null;
  if (usedMinutes === null) return Math.ceil(minutes * Math.max(...prices.map(p=>p.fleet)));
  if (!Number.isFinite(usedMinutes) || usedMinutes < 0) return null;
  let cost = 0, used = usedMinutes, left = minutes;
  while (left > 0) {
    const index = prices.findLastIndex(p=>p.minute <= used);
    const count = Math.min(left, (prices[index+1]?.minute ?? Infinity)-used);
    cost += count * prices[index].fleet; used += count; left -= count;
  }
  return Math.ceil(cost);
}
