import { exactAutomationId } from './automation-policy.mjs';
import { loadMapAsset } from './world.mjs';
import { resourceFieldRows, resourceFieldTotals } from './resource-fields.mjs';
import { resourceFieldTargets } from './resource-field-allocation.mjs';
import { observeResourceFieldHoldings, forgetReleasedResourceField } from './resource-field-history.mjs';
import { pendingPetrol } from './dispatch-preview.mjs';
import { fleetRecordReason, dispatchReservationReason, reserveDispatch } from './fleet-availability.mjs';
import { registerFleetReservations, isFleetReserved } from './fleet-reservations.mjs';
import { settleFleetSnapshot, cancelResourceFieldReplacement, releaseResourceFieldReplacementLock } from './fleet-settlement.mjs';
import { readCityWar, cityWarReservedFleets } from './city-war.mjs';
import { settleResourceFieldGiveUps } from './resource-field-giveup.mjs';
export { previewResourceFieldGiveUp, runResourceFieldGiveUp } from './resource-field-giveup.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const now = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const day = time => Math.floor((time + 28800) / 86400);
const identity = player => [player?.worldId, player?.playerId, player?.guildId].map(exactAutomationId).join(':');
const active = new WeakSet();
const idle = fleet => fleet?.state === 1 && fleet.curGridIdx === 0 && !fleet.targetGridIdx && !fleet.treasureLootUid && !fleet.chipWar?.rewardTs && !fleet.autoFight?.isOn;
const keyFor = (world, grid) => `resource-field:${world}:${grid}`;
const replacementKey = (world, grid) => `resource-field-replace:${world}:${grid}`;
function quantity(value) {
  if (integer(value)) return value;
  const exact = exactAutomationId(value);
  return exact && BigInt(exact) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : null;
}
const fieldRecords = (ledger, world) => Object.entries(ledger?.keyRecords() ?? {}).filter(([key, record]) => key.startsWith('resource-field:' + world + ':') && record.details?.kind === 'resourceFieldDispatch');
function installReservations(client, ledger, world) {
  const held = id => fieldRecords(ledger, world).some(([, r]) => r.details.active !== false && (!id || r.details.buildingId === id));
  registerFleetReservations(client, 'resourceFields', held, () => held());
}

// Dispatch evidence confirms the cost, not a victory. Unknown writes remain locked across restarts.
function reconcile(state, ledger, baseline) {
  if (!ledger || !state.fieldsSynced || !state.fleetsSynced) return;
  settleFleetSnapshot(ledger, { worldId: state.worldId, fleets: state.rawFleets,
    resourceFields: state.owned.map(field => ({ gridIdx: field.grid, cityId: field.cityId, type: field.type })),
    now: state.checkedAt, baseline, kinds: ['resourceFieldDispatch'] });
  for (const [key, record] of fieldRecords(ledger, state.worldId)) {
    if (baseline?.[key]?.id !== record.id) continue;
    if (record.confirmed && record.details.active === false && day(record.details.returnedAt) < day(state.checkedAt)) ledger.releaseCompletedKey(key);
  }
  // A process can stop between taking the old-field lock and writing its main record.
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    const d = record.details;
    if (key.startsWith('resource-field-replace:' + state.worldId + ':') && d?.replacementLock
      && integer(d.leaseUntil) && d.leaseUntil <= state.checkedAt && d.targetKey && !ledger.hasKey(d.targetKey)) ledger.cancel({ id: record.id });
  }
}

export async function readResourceFieldState(client, protocol, config, player, options = {}) {
  const { getSettings = () => ({}), ledger, enabled = () => true, mapLoader = loadMapAsset } = options;
  const settings = getSettings(), who = identity(player), baseline = ledger?.keyRecords() ?? {};
  const playerId = exactAutomationId(player?.playerId), worldId = exactAutomationId(player?.worldId);
  const scope = worldId && playerId ? worldId + ':' + playerId : null;
  const previous = scope && ledger?.resourceFieldHistory?.(scope);
  const check = () => { if (!enabled() || client.connected === false || who !== identity(player) || settings !== getSettings()) throw Error('账号或配置已变化，请重新读取资源田'); };
  check();
  const state = { checkedAt: now(client), worldId: exactAutomationId(player?.worldId), count: null, maxNum: null, remaining: null,
    owned: [], candidates: [], fleets: [], rawFleets: [], totals: resourceFieldTotals(null, []), notes: [], reason: '', cost: null, fuel: null,
    fieldsSynced: false, fleetsSynced: false, automatic: settings.resourceFields?.enabled === true, lostFields: {} };
  const get = async (name, label, body = {}) => {
    try {
      if (!protocol?.[name + 'Request'] || !protocol?.[name + 'Response']) throw Error('协议未提供');
      const value = await client.request(name + 'Request', body, name + 'Response', 8000); check(); return value;
    } catch { check(); state.notes.push(label + '未同步'); return null; }
  };
  const [map, fields, world, own, guilds, bag, water, radarResponse, merge] = await Promise.all([
    mapLoader(player?.scenarioId || 1, config?.resources ?? null).catch(() => { state.notes.push('场景地图未同步'); return null; }),
    get('MyResFields', '资源田'), get('WorldInfo', '城池归属', { screenCenter: { x: 0, y: 0 } }), get('MyFleets', '舰队'),
    get('AllGuildAbstraction', '联盟等级'), get('AllItem', '汽油库存'), get('OnWater', '舰队编队'), get('RadarInfo', '雷达事件'),
    get('UniteWorldsPlan', '合服状态'),
  ]);
  check();
  const info = fields?.info, guildId = exactAutomationId(player?.guildId), guildIdx = guildId ? Number(BigInt(guildId) % 1000n) : null;
  const openLevel = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '世界')?.playerLevel;
  state.reason = !state.worldId || !exactAutomationId(player?.playerId) ? '角色身份未同步'
    : !integer(openLevel, 1) || !integer(player?.level, 1) ? '世界开放等级未同步'
    : player.level < openLevel ? `世界玩法在 ${openLevel} 级开放` : !guildIdx ? '加入联盟后才能占领资源田' : '';
  state.fieldsSynced = Array.isArray(info?.fields) && integer(info?.maxNum) && new Set(info.fields.map(f => f.gridIdx)).size === info.fields.length
    && info.fields.every(f => integer(f.gridIdx) && integer(f.cityId, 1) && integer(f.type, 1));
  const cities = Array.isArray(world?.cities) ? new Map(world.cities.map(c => [c.id, c])) : null;
  const activeCity = cityId => guildIdx && integer(cities?.get(cityId)?.guildIdx) ? cities.get(cityId).guildIdx === guildIdx : null;
  if (state.fieldsSynced) {
    state.count = info.fields.length; state.maxNum = info.maxNum;
    state.owned = resourceFieldRows(config, player, info, guilds?.guilds).map(row => {
      const active = activeCity(row.cityId);
      return { ...row, active, productionStatus: active === true ? '产出中' : active === false ? '城池失守，暂停产出' : '城池归属未同步' };
    });
    state.totals = resourceFieldTotals(info, state.owned.map(f => ({ ...f, perHour: f.active === false ? 0 : f.active === null ? null : f.perHour })));
    if (previous && settings.resourceFields) {
      const releasing = new Set(), upgrades = new Set();
      for (const { details: d } of Object.values(baseline)) {
        if (d?.worldId !== worldId || d.playerId !== playerId) continue;
        if (d.kind === 'resourceFieldGiveUp' && d.phase === 'givingUp') releasing.add(d.gridIdx);
        if (d.kind === 'resourceFieldDispatch' && d.replacement) {
          if (['givingUp', 'released'].includes(d.phase)) releasing.add(d.replacement.grid);
          if (d.phase === 'dispatching' && d.replacement.resourceId === d.resourceId) upgrades.add(d.gridIdx);
        }
      }
      observeResourceFieldHoldings(state, { scope, previous, policy: settings.resourceFields, ledger,
        previewOnly: options.previewOnly, releasing, upgrades });
      if (state.lossHistoryReason) state.notes.push(state.lossHistoryReason);
      else if (!settings.resourceFields.refillAfterLoss) {
        const held = Object.keys(state.lostFields).length;
        if (held) state.notes.push(`「失地后自动补齐」已关闭，已为失去的 ${held} 块田按资源类型保留缺口。`);
      }
    }
  } else state.reason ||= '资源田名额未同步';
  state.fleetsSynced = Array.isArray(own?.fleets) && new Set(own.fleets.map(f => f.buildingId)).size === own.fleets.length;
  state.rawFleets = (state.fleetsSynced ? own.fleets : []).filter(f => /^[1-9]\d*远征船$/.test(f.buildingId)).map(f => ({ ...f,
    state: f.state, curGridIdx: f.curGridIdx ?? null, targetGridIdx: f.targetGridIdx ?? 0, durability: f.durability, maxDura: f.maxDura,
    power: quantity(f.power), treasureLootUid: exactAutomationId(f.treasureLootUid), ownerPlayerId: f.owner ? exactAutomationId(f.owner.playerId) : null }));
  if (!options.previewOnly) {
    if (state.fieldsSynced) settleResourceFieldGiveUps(ledger, { worldId: state.worldId, playerId: exactAutomationId(player.playerId),
      fields: info.fields, now: state.checkedAt, baseline });
    reconcile(state, ledger, baseline);
  }
  if (ledger && !options.previewOnly) installReservations(client, ledger, state.worldId);
  const allRecords = ledger?.keyRecords() ?? {}, operation = options.heldOperation;
  if (operation && allRecords[operation.key]?.id !== operation.id) throw Error('替换记录已变化，已停止出征');
  const heldRecord = operation ? allRecords[operation.key] : null;
  const visibleRecords = Object.fromEntries(Object.entries(allRecords).filter(([key]) => key !== operation?.key));
  const records = fieldRecords({ keyRecords: () => visibleRecords }, state.worldId).filter(([key, r]) => {
    const d = r.details;
    // Only a previously won, fully settled trip to an observed lost field can be retried today.
    if (!settings.resourceFields?.refillAfterLoss || d.playerId !== playerId || !Object.hasOwn(state.lostFields, d.gridIdx)
      || !r.confirmed || d.active !== false || !(d.occupied || d.everOccupied) || baseline[key]?.id !== r.id) return true;
    if (!options.previewOnly) ledger.releaseCompletedKey(key);
    return false;
  });
  const pending = records.filter(([, r]) => r.details.active !== false && !state.owned.some(f => f.grid === r.details.gridIdx));
  state.pendingFuel = ledger ? pendingPetrol(ledger) : 0;
  if (heldRecord && !heldRecord.confirmed) state.pendingFuel = Math.max(0, state.pendingFuel - heldRecord.details.cost);
  state.autoStopReason = ledger?.hasKey(`resource-field-stop:${state.worldId}:${day(state.checkedAt)}`) ? '今日资源田请求曾被服务器拒绝，自动占田暂缓至明日'
    : ledger?.hasKey(`resource-field-partial:${state.worldId}:${day(state.checkedAt)}`) ? '今日替换只完成放弃，自动占田暂缓；请重新选择目标'
    : records.some(([, r]) => r.confirmed && r.details.active === false && !r.details.occupied && !r.details.everOccupied && day(r.details.returnedAt) === day(state.checkedAt)) ? '今日有占田出征返航后尚未确认占领，自动占田暂缓至明日' : '';
  state.pending = pending.map(([, r]) => {
    // Older dispatch records only stored the grid. Recover its resource even if its city was lost.
    const tile = map?.fieldAt(r.details.gridIdx);
    const resourceId = r.details.resourceId ?? (tile && resourceFieldRows(config, player, { fields: [
      { gridIdx: r.details.gridIdx, cityId: tile.cityId, type: tile.resType }
    ] }, guilds?.guilds)[0].resourceId);
    return { grid: r.details.gridIdx, resourceId, fleetId: r.details.buildingId, confirmed: r.confirmed,
      replaceGridIdx: r.details.replacement?.grid ?? null, phase: r.details.phase ?? 'dispatching',
      reason: r.details.phase === 'givingUp' ? '旧田放弃结果待确认，尚未出征新田'
        : r.details.phase === 'released' ? '旧田已放弃，替换未继续，等待核对处理' : '新田出征待确认' };
  });
  for (const field of state.owned) {
    const lock = allRecords[replacementKey(state.worldId, field.grid)];
    field.dispatchActive = records.some(([, r]) => r.details.active !== false && r.details.gridIdx === field.grid);
    field.replacementReason = lock && lock.id !== heldRecord?.details.replacement?.lock?.id ? '此田已有放弃或替换操作，等待结果' : '';
    field.giveUpReason = field.replacementReason ? '此田已有放弃或替换操作，等待结果' : '';
  }
  state.remaining = state.fieldsSynced ? Math.max(0, info.maxNum - info.fields.length - pending.length) : null;
  state.cost = rows(config, 'WorldParamCfg').find(row => row.paramName === '资源地消耗汽油')?.paramValue ?? null;
  const fuels = Array.isArray(bag?.items) ? bag.items.filter(item => item.itemId === '汽油') : null;
  state.fuel = fuels?.length === 0 ? 0 : fuels?.length === 1 ? quantity(fuels[0].num) : null;
  if (!integer(state.cost) || !integer(state.fuel)) state.reason ||= '占田费用或汽油库存未同步';
  if (!map || !cities) state.reason ||= '地图或城池归属未同步';
  if (!state.fleetsSynced || !Array.isArray(water?.building)) state.reason ||= '舰队或编队未同步';
  if (!Array.isArray(merge?.worldIds)) state.reason ||= '合服状态未同步';
  else if (merge.matchMaking || (merge.worldIds.length && merge.executeTs > 0 && (state.checkedAt >= merge.executeTs - 3600 || day(state.checkedAt) === day(merge.executeTs)))) state.reason ||= '合服期间暂停资源田派遣';
  // A radar event on this tile takes precedence in the official client.
  const radar = radarResponse?.radarInfo;
  if (!Array.isArray(radar?.events)) state.reason ||= '雷达事件未同步';
  const eventGrids = new Set([...(radar?.events ?? []), radar?.fixedEvent].filter(Boolean).map(e => e.gridIdx));
  if (map && cities && state.fieldsSynced) {
    const occupied = new Set(info.fields.map(f => f.gridIdx)), targets = [];
    for (let grid = 0; grid < map.width * map.height; grid++) {
      const f = map.fieldAt(grid);
      if (!f || occupied.has(grid) || activeCity(f.cityId) !== true || eventGrids.has(grid)) continue;
      targets.push({ gridIdx: grid, cityId: f.cityId, type: f.resType });
    }
    state.candidates = resourceFieldRows(config, player, { fields: targets }, guilds?.guilds).filter(row => row.resourceId && integer(row.perHour, 1) && integer(row.level, 1));
    state.candidates.sort((a, b) => b.level - a.level || b.perHour - a.perHour || a.grid - b.grid);
    for (const row of state.candidates) {
      const prior = records.find(([, r]) => r.details.gridIdx === row.grid);
      row.reason = allRecords[replacementKey(state.worldId, row.grid)] ? '此田有放弃或替换结果待确认，暂不占回'
        : prior ? (prior[1].details.active !== false ? '已有占领任务，等待结果' : '此田本日已尝试，请明日再试') : '';
    }
  }
  let cityReserved = [];
  if (settings.cityWar?.enabled && settings.cityWar.reserveDuringWar) {
    const war = await readCityWar(client, protocol, config, player, settings.cityWar); check();
    cityReserved = war.reason ? settings.cityWar.fleetIds : cityWarReservedFleets(war, settings, now(client));
  }
  state.fleets = state.rawFleets.map(fleet => {
    const formation = water?.building?.find(b => b.buildingId === fleet.buildingId && b.level > 0)?.fleet?.formation;
    const reason = fleet.ownerPlayerId && fleet.ownerPlayerId !== exactAutomationId(player.playerId) ? '舰队不属于当前角色'
      : !idle(fleet) ? '舰队正在执行任务或原生委任' : !integer(fleet.durability, 1) || !integer(fleet.maxDura, 1) ? '耐久不足或未同步'
      : !formation?.heroPositions?.some(h => h.heroId) ? '缺少英雄编队'
      : cityReserved.includes(fleet.buildingId) ? '舰队预留给城战时段'
      : fleetRecordReason(visibleRecords, fleet.buildingId, state.worldId)
        || (operation && isFleetReserved(client, fleet.buildingId, ['resourceFields', 'dispatch-ledger']) ? '舰队有其他自动任务尚未结束' : '')
        || dispatchReservationReason(client, settings, 'resourceFields', fleet.buildingId, { ignoreOwners: ['cityWar'], ignoreLegacy: !!operation });
    return { id: fleet.buildingId, name: fleet.buildingId.replace('远征船', '号舰队'), power: fleet.power, durability: fleet.durability,
      maxDura: fleet.maxDura, available: !reason, reason };
  });
  if (pending.length) state.notes.push(`${pending.length} 项占田任务正在等待结果，已预留名额`);
  if (state.autoStopReason) state.notes.push(state.autoStopReason);
  const partial = allRecords[`resource-field-partial:${state.worldId}:${day(state.checkedAt)}`]?.details;
  if (partial) state.notes.push(`旧田 ${partial.oldGrid} 已放弃，替换 ${partial.newGrid} 未继续，请重新选择。`);
  state.notes.push('产量为当前有效田地的基础小时产量，不含加成；城市失守后暂停产出。');
  return state;
}

export async function readResourceFieldsOverview(...args) {
  const { rawFleets, worldId, ...view } = await readResourceFieldState(...args);
  view.candidateCount = view.candidates.length;
  return view;
}

const effectiveYield = field => field?.active === false ? 0 : field?.active === true && integer(field.perHour) ? field.perHour : null;
function plan(state, gridIdx, fleetId, replaceGridIdx = null) {
  if (state.reason) throw Error(state.reason);
  const replacement = replaceGridIdx === null ? null : state.owned.find(field => field.grid === replaceGridIdx);
  if (replaceGridIdx !== null && (!replacement || replaceGridIdx === gridIdx)) throw Error('请选择仍由本人占领的另一块旧田');
  if (replacement?.replacementReason) throw Error(replacement.replacementReason);
  if (replacement && (!replacement.resourceId || effectiveYield(replacement) === null)) throw Error('旧田产出或归属未同步，暂不能确认替换');
  if (replacement ? !(state.maxNum - state.count - state.pending.length + 1 > 0) : !(state.remaining > 0)) throw Error('占田名额已满或已被在途任务预留');
  const target = state.candidates.find(row => row.grid === gridIdx), fleet = state.fleets.find(row => row.id === fleetId);
  if (!target) throw Error('目标已占领、城市不属于本盟或田地信息未同步');
  if (target.reason) throw Error(target.reason);
  if (!fleet?.available) throw Error(fleet?.reason || '舰队未同步');
  if (state.fuel - state.pendingFuel < state.cost) throw Error('可用汽油不足（含其他任务待确认消耗）');
  return { gridIdx, fleetId, cost: state.cost, target, replacement: replacement ? { ...replacement, effectivePerHour: effectiveYield(replacement) } : null,
    label: `${fleet.name}${replacement ? '替换旧田 ' + replacement.grid + ' → ' : '占领'}${target.cityName} · ${target.name}（${gridIdx}）` };
}

// Once a replacement has released its old field, finish only the originally reserved dispatch.
function automaticPlan(state, policy, releasedTarget = null) {
  if (!policy?.enabled) return { reason: '资源田自动化未开启' };
  if (state.reason || state.autoStopReason || state.lossHistoryReason) return { reason: state.reason || state.autoStopReason || state.lossHistoryReason };
  if (state.fuel - state.pendingFuel < state.cost) return { reason: '可用汽油不足（含其他任务待确认消耗）' };
  const available = state.fleets.filter(f => f.available);
  if (available.length <= policy.reserveFleetCount) return { reason: '保留空闲舰队数量不足' };
  const fleets = available.filter(f => policy.fleetIds.includes(f.id) && integer(f.power, 1)
    && f.durability >= f.maxDura * policy.minDurabilityPercent / 100 && (!releasedTarget || f.id === releasedTarget.fleetId));
  if (!fleets.length) return { reason: '没有达到耐久与战力条件的参与舰队' };

  const targets = resourceFieldTargets(policy, state.maxNum);
  const counts = Object.fromEntries(Object.keys(targets).map(id => [id, 0]));
  const losses = { ...counts }, inactive = { ...counts };
  if (!policy.refillAfterLoss) for (const id of Object.values(state.lostFields)) losses[id]++;
  const leaving = new Set(state.pending.map(p => p.replaceGridIdx));
  for (const field of [...state.owned.filter(f => !leaving.has(f.grid)), ...state.pending]) {
    if (!Object.hasOwn(counts, field.resourceId)) return { reason: '已占或在途资源田的类型未同步' };
    counts[field.resourceId]++;
    if (field.active === false) inactive[field.resourceId]++;
  }
  const replaceable = state.owned.filter(f => !f.replacementReason && !f.dispatchActive && effectiveYield(f) !== null
    && (f.active ? integer(f.level, 1) : policy.refillAfterLoss))
    .sort((a, b) => Number(a.active) - Number(b.active) || a.level - b.level || a.grid - b.grid);
  const surplus = replaceable.find(f => (counts[f.resourceId] - (policy.refillAfterLoss && f.active ? inactive[f.resourceId] : 0)) > targets[f.resourceId]);
  let choice = null;
  // Candidates are sorted by descending level. Prefer filling a missing resource, then
  // upgrade an existing field of the same resource even if the configured quota is full.
  for (const target of state.candidates) {
    const id = target.resourceId;
    if (!targets[id] || (!policy.refillAfterLoss && Object.hasOwn(state.lostFields, target.grid))
      || target.reason || target.level < policy.minLevel || !integer(target.recommendedPower, 1)
      || (releasedTarget && target.grid !== releasedTarget.gridIdx)) continue;
    const fleet = fleets.find(f => f.power >= target.recommendedPower);
    if (!fleet) continue;
    const restoringOwnSlot = releasedTarget?.replacement?.resourceId === id;
    const productiveShortage = policy.refillAfterLoss && counts[id] - inactive[id] < targets[id];
    const restoringInactive = restoringOwnSlot && releasedTarget.replacement.active === false && productiveShortage;
    const missing = restoringInactive || counts[id] + (restoringOwnSlot ? 0 : losses[id]) < targets[id];
    if (missing && (state.remaining > 0 || (surplus && !releasedTarget))) {
      choice = { target, fleet, old: state.remaining > 0 ? null : surplus };
      break;
    }
    if (productiveShortage && !releasedTarget) {
      const old = replaceable.find(f => f.resourceId === id && f.active === false);
      if (old) { choice = { target, fleet, old }; break; }
    }
    if (choice || releasedTarget || counts[id] > targets[id]) continue;
    const old = replaceable.find(f => f.resourceId === id && f.active && f.level < target.level);
    if (old) choice = { target, fleet, old };
  }
  if (!choice) return { reason: '没有可补足目标数量或提升等级的资源田与舰队组合' };
  try { return { step: plan(state, choice.target.grid, choice.fleet.id, choice.old?.grid ?? null) }; }
  catch (error) { return { reason: error.message }; }
}

function checkPreview(step, proposed, preview) {
  if (step.cost > preview.cost || step.target.cityId !== proposed.target.cityId || step.target.type !== proposed.target.type
    || step.target.resourceId !== proposed.target.resourceId || step.target.perHour < proposed.target.perHour
    || step.target.recommendedPower !== proposed.target.recommendedPower) throw Error('费用、产量或守军战力已变化，请重新确认');
  if (step.replacement && (!proposed.replacement || step.replacement.grid !== proposed.replacement.grid
    || step.replacement.cityId !== proposed.replacement.cityId || step.replacement.type !== proposed.replacement.type
    || step.replacement.resourceId !== proposed.replacement.resourceId
    || effectiveYield(step.replacement) > effectiveYield(proposed.replacement))) throw Error('旧田产出或归属已变化，放弃损失增加，请重新确认');
}

export async function previewResourceField(client, protocol, config, player, intent, options) {
  if (!integer(intent?.gridIdx) || intent.gridIdx > 2147483647) throw Error('请选择有效的资源田');
  const replaceGridIdx = intent.replaceGridIdx ?? null;
  if (replaceGridIdx !== null && (!integer(replaceGridIdx) || replaceGridIdx > 2147483647 || replaceGridIdx === intent.gridIdx)) throw Error('请选择有效且不同于目标的旧田');
  const state = await readResourceFieldState(client, protocol, config, player, options);
  const target = state.candidates.find(row => row.grid === intent.gridIdx);
  const replacement = replaceGridIdx === null ? null : state.owned.find(field => field.grid === replaceGridIdx);
  return { gridIdx: intent.gridIdx, worldId: state.worldId, identityKey: identity(player), name: target?.name ?? '资源田', cityName: target?.cityName ?? '', product: target?.product ?? '',
    resourceId: target?.resourceId ?? null, perHour: target?.perHour ?? null, level: target?.level ?? null,
    replaceGridIdx, replacement: replacement ? { ...replacement, effectivePerHour: effectiveYield(replacement) } : null,
    recommendedPower: target?.recommendedPower ?? null, cost: state.cost, fuel: state.fuel, reason: state.reason, automatic: state.automatic,
    fleets: state.fleets.map(fleet => {
      try { const step = plan(state, intent.gridIdx, fleet.id, replaceGridIdx); return { ...fleet, step, available: true }; }
      catch (error) { return { ...fleet, available: false, reason: error.message }; }
    }) };
}

export async function runResourceFieldShortcut(client, protocol, config, player, preview, fleetId, options) {
  const { getSettings, ledger, enabled = () => true, report = () => {} } = options;
  const proposed = preview?.fleets?.find(f => f.id === fleetId && f.step)?.step;
  if (!proposed || preview.worldId !== exactAutomationId(player?.worldId) || preview.identityKey !== identity(player)) throw Error('确认信息已失效，请重新选择资源田');
  const replaceGridIdx = preview.replaceGridIdx ?? null;
  if (replaceGridIdx !== null && (preview.replacement?.grid !== replaceGridIdx || proposed.replacement?.grid !== replaceGridIdx)) throw Error('替换确认信息已失效');
  if (replaceGridIdx === null && proposed.replacement) throw Error('替换确认信息不一致');
  if (!enabled() || active.has(client)) throw Error('资源田操作正在执行或账号已变化');
  active.add(client);
  try {
    const settings = getSettings(), who = identity(player);
    const allowed = () => enabled() && client.connected !== false && identity(player) === who && getSettings() === settings;
    const recheck = (snapshot, released = false) => {
      const oldGrid = released ? null : replaceGridIdx;
      if (!options.automatic) return plan(snapshot, preview.gridIdx, fleetId, oldGrid);
      const { step, reason } = automaticPlan(snapshot, settings.resourceFields, released ? proposed : null);
      if (step?.gridIdx !== preview.gridIdx || step.fleetId !== fleetId || (step.replacement?.grid ?? null) !== oldGrid) {
        throw Error(reason || '资源田分配或可用目标已变化，等待下一轮检查');
      }
      return step;
    };
    const state = await readResourceFieldState(client, protocol, config, player, options);
    const step = recheck(state);
    checkPreview(step, proposed, preview);
    if (!allowed()) throw Error('账号或配置已变化，操作未发送');
    if (!protocol?.ChallengeResFieldRequest) throw Error('当前协议缺少资源田占领请求');
    if (step.replacement && !protocol?.GiveUpResFieldRequest) throw Error('当前协议缺少资源田放弃请求');
    const details = { kind: 'resourceFieldDispatch', worldId: state.worldId, playerId: exactAutomationId(player.playerId), buildingId: fleetId, gridIdx: step.gridIdx, resourceId: step.target.resourceId,
      sentAt: state.checkedAt, active: true, occupied: false, cost: step.cost,
      phase: step.replacement ? 'givingUp' : 'dispatching', replacementLeaseUntil: state.checkedAt + 120 };
    const key = keyFor(state.worldId, step.gridIdx); let oldLock = null, ticket;
    try {
      if (step.replacement) {
        const lockKey = replacementKey(state.worldId, replaceGridIdx);
        oldLock = ledger.reserve({}, {}, {}, { uniqueKey: lockKey, details: { replacementLock: true, worldId: state.worldId, targetKey: key, leaseUntil: state.checkedAt + 120 } });
        details.replacement = { ...step.replacement, lock: { key: lockKey, id: oldLock.id } };
      }
      ticket = ledger.reserve({ resourceFieldPetrol: step.cost }, {}, {}, { uniqueKey: key, details });
    } catch (error) { if (oldLock) ledger.cancel(oldLock); throw error; }
    const assertHeld = () => {
      const current = ledger.keyRecords()[key];
      if (!allowed() || current?.id !== ticket.id || current.details.replacementLeaseUntil <= now(client)) throw Error('账号、配置或替换占用已变化，操作未发送');
      if (oldLock && ledger.keyRecords()[details.replacement.lock.key]?.id !== oldLock.id) throw Error('旧田替换占用已变化，操作未发送');
      return current;
    };
    const cancelUnsent = () => { ledger.cancel(ticket); if (oldLock) ledger.cancel(oldLock); };
    if (!allowed()) { cancelUnsent(); throw Error('账号或配置已变化，操作未发送'); }
    reserveDispatch(client, 'resourceFields', [fleetId]);
    let result, released = false, challengeAttempted = false, giveUpAttempted = false;
    try {
      if (step.replacement) {
        const ownOptions = { ...options, previewOnly: true, heldOperation: { key, id: ticket.id } };
        const before = await readResourceFieldState(client, protocol, config, player, ownOptions);
        checkPreview(recheck(before), proposed, preview);
        assertHeld(); giveUpAttempted = true;
        await client.sendWatch('GiveUpResFieldRequest', { resFieldGridIdx: replaceGridIdx }, { window: 500 });
        // This read only establishes removal. Any subsequent checks can fail with an
        // explicit partial result without pretending the released field was restored.
        const reply = await client.request('MyResFieldsRequest', {}, 'MyResFieldsResponse', 8000);
        if (!allowed()) throw Error('放弃发送后账号或配置已变化，尚不能核对旧田归属');
        const info = reply?.info;
        if (!Array.isArray(info?.fields) || !integer(info.maxNum) || info.fields.some(field => !integer(field.gridIdx) || !integer(field.cityId, 1) || !integer(field.type, 1))
          || new Set(info.fields.map(field => field.gridIdx)).size !== info.fields.length || info.fields.some(field => field.gridIdx === replaceGridIdx)) {
          throw Error('放弃结果待确认，已保留旧田替换、名额、汽油和舰队记录，不会重复放弃或出征');
        }
        released = true;
        forgetReleasedResourceField(ledger, state.worldId, details.playerId, replaceGridIdx);
        const current = assertHeld(); ledger.updateKeyDetails(key, { ...current.details, phase: 'released', releasedAt: now(client) });
        const after = await readResourceFieldState(client, protocol, config, player, ownOptions);
        if (after.owned.some(field => field.grid === replaceGridIdx)) throw Error('旧田状态再次变化，替换未继续');
        checkPreview(recheck(after, true), proposed, preview);
        const ready = assertHeld(); ledger.updateKeyDetails(key, { ...ready.details, phase: 'dispatching' });
      }
      assertHeld(); challengeAttempted = true;
      await client.sendWatch('ChallengeResFieldRequest', { resFieldGridIdx: step.gridIdx, fleetBuildingIds: [fleetId] }, { window: 500 });
      if (!allowed()) throw Error('发送后连接已变化');
      await readResourceFieldState(client, protocol, config, player, options);
      const confirmed = ledger.keyRecords()[key]?.confirmed === true;
      result = { ok: confirmed, status: confirmed ? 'confirmed' : 'unknown', ...(step.replacement ? { released: true, partial: !confirmed } : {}),
        reason: confirmed ? (released ? '旧田已放弃，新田派遣已确认，最终占领以资源田列表为准' : '派遣已确认，最终占领以资源田列表为准')
          : (released ? '旧田已放弃，新田出征结果待确认，已保留汽油、名额和舰队记录，不会重复派遣' : '结果待确认，已保留汽油、名额和舰队记录，不会重复派遣') };
    } catch (error) {
      const request = challengeAttempted ? 'ChallengeResFieldRequest' : 'GiveUpResFieldRequest';
      const rejected = error.prompt && error.request === request, notSent = error.notSent && error.request === request;
      const certainUnsent = step.replacement ? (released && !challengeAttempted || !giveUpAttempted || rejected || notSent) : !challengeAttempted || rejected || notSent;
      if (certainUnsent) {
        if (released) cancelResourceFieldReplacement(ledger, key, ledger.keyRecords()[key], now(client), '旧田已放弃，但新田未出征：' + error.message);
        else cancelUnsent();
      }
      if (rejected && options.automatic) {
        const stopKey = `resource-field-stop:${state.worldId}:${day(state.checkedAt)}`;
        if (!ledger.hasKey(stopKey)) ledger.confirm(ledger.reserve({}, {}, {}, { uniqueKey: stopKey, details: { kind: 'resourceFieldStop', worldId: state.worldId, reason: error.message } }));
      }
      result = { ok: false, status: rejected ? 'rejected' : certainUnsent ? 'cancelled' : 'unknown',
        ...(step.replacement ? { released, partial: released } : {}),
        reason: released ? '旧田已放弃，但新田' + (certainUnsent ? '未出征：' : '出征结果待确认：') + error.message
          : step.replacement && giveUpAttempted && !certainUnsent ? '旧田放弃结果待确认，尚未出征新田；不会重复发送：' + error.message : error.message };
    } finally {
      const current = ledger.keyRecords()[key];
      if (current?.id === ticket.id && step.replacement && current.details.phase !== 'dispatching') {
        ledger.updateKeyDetails(key, { ...current.details, replacementLeaseUntil: 0 });
      }
      if (current?.confirmed && step.replacement) releaseResourceFieldReplacementLock(ledger, current.details);
    }
    report({ ...result, label: step.label }); return result;
  } finally { reserveDispatch(client, 'resourceFields', []); active.delete(client); }
}

export async function previewResourceFieldPlan(client, protocol, config, player, options) {
  const state = await readResourceFieldState(client, protocol, config, player, { ...options, previewOnly: true });
  const actions = [], notes = [...state.notes];
  const policy = options.getSettings().resourceFields;
  if (state.fieldsSynced && policy) {
    const targets = resourceFieldTargets(policy, state.maxNum);
    notes.push(`占领上限 ${state.maxNum} 块，本轮目标为汽油 ${targets['汽油']} 块、种子 ${targets['种子']} 块、科技点 ${targets['公会科技点']} 块。`);
  }
  const { step, reason } = automaticPlan(state, policy);
  if (step) actions.push({ kind: 'resourceFieldDispatch', label: step.label, costs: [{ id: '汽油', num: step.cost }] });
  else notes.push(reason);
  return { actions, notes, counts: { owned: state.count, remaining: state.remaining, candidates: state.candidates.length } };
}

export async function runResourceFields(client, protocol, config, player, options) {
  if (!options.getSettings()?.resourceFields?.enabled || options.enabled?.() === false || active.has(client)) return [];
  const state = await readResourceFieldState(client, protocol, config, player, options), settings = options.getSettings();
  const { step, reason } = automaticPlan(state, settings.resourceFields);
  if (step) {
    const preview = { gridIdx: step.gridIdx, worldId: state.worldId, identityKey: identity(player), cost: state.cost, fleets: [{ id: step.fleetId, step }],
      replaceGridIdx: step.replacement?.grid ?? null, replacement: step.replacement };
    return [await runResourceFieldShortcut(client, protocol, config, player, preview, step.fleetId, { ...options, automatic: true })];
  }
  options.report?.({ skipped: true, label: '资源田自动占领', reason }); return [];
}
