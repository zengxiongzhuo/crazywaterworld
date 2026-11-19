import { exactAutomationId } from './automation-policy.mjs';
import { cityPetrolCost } from './city-war.mjs';
import { toNumber } from './client.mjs';
import { pendingPetrol } from './dispatch-preview.mjs';
import { dispatchReservationReason, fleetRecordReason, fleetStateName } from './fleet-availability.mjs';
import { cityDispatchObserved, fleetAtHome, recordsInWorld, settleFleetSnapshot } from './fleet-settlement.mjs';
import { loadMapAsset } from './world.mjs';

const moveRequest = 'MoveFleetsToCityRequest';
const valid = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const fleetNumber = id => /^([1-9]\d*)远征船$/.exec(id)?.[1];

// 只读预览在副本中扣除已核实的旧占用，实际释放留给账号写队列。
function projectManualReturns(records, baseline, fleets) {
  let confirmedCost = 0;
  for (const [key, previous] of Object.entries(baseline)) {
    const record = records[key], details = record?.details;
    if (!details || record.expired || record.id !== previous.id || record.confirmed !== previous.confirmed) continue;
    const matches = fleets.filter(f => f.buildingId === details.buildingId);
    if (matches.length !== 1) continue;
    const fleet = matches[0], observed = cityDispatchObserved(fleet, details);
    if (!record.confirmed && observed) confirmedCost += details.cost ?? 0;
    if ((record.confirmed || observed) && fleetAtHome(fleet)) delete records[key];
  }
  return confirmedCost;
}

async function readDispatch(client, protocol, config, player, settings, ledger, target, {
  request = client.request.bind(client), mapLoader = loadMapAsset, settle = false,
} = {}) {
  const { scenarioId, cityId } = target;
  const view = { cityId, owner: null, cost: null, role: null, fleets: [], fleetChoices: [], reason: '' };
  const blocked = reason => ({ ...view, reason });
  const worldId = exactAutomationId(player.worldId), guildId = exactAutomationId(player.guildId);
  const playerId = exactAutomationId(player.playerId);
  const sameIdentity = () => worldId === exactAutomationId(player.worldId)
    && guildId === exactAutomationId(player.guildId) && playerId === exactAutomationId(player.playerId)
    && scenarioId === (player.scenarioId || 1);
  if (!valid(scenarioId, 1) || !valid(cityId, 1) || !sameIdentity()) return blocked('地图场景已变化，请刷新地图');
  if (!worldId || !playerId || !guildId) return blocked('派遣需要已加入联盟的角色');
  if (!protocol?.[moveRequest]) return blocked('当前协议未提供城池派遣');
  const guildIdx = Number(BigInt(guildId) % 1000n);
  const cities = rows(config, scenarioId + '_CityCfg'), definition = cities.find(c => c.id === cityId);
  const capital = cities.find(c => c.guildIndex === guildIdx);
  if (!guildIdx || !definition || !capital) return blocked('城池或联盟主城配置未同步');
  view.cityName = definition.name || '城池 ' + cityId;
  const get = (name, body = {}) => request(name, body, name.replace(/Request$/, 'Response'), 8000);
  const [world, guild, merge] = await Promise.all([
    get('WorldInfoRequest', { screenCenter: { x: 0, y: 0 } }), get('GuildInfoRequest'), get('UniteWorldsPlanRequest'),
  ]);
  if (exactAutomationId(guild?.guild?.guildId) !== guildId) return blocked('联盟身份已变化，请刷新地图');
  const city = world?.cities?.find(c => c.id === cityId);
  if (!city || !valid(city.guildIdx)) return blocked('目标城池归属未同步');
  if (!Array.isArray(merge?.worldIds)) return blocked('合服状态未同步');
  const mergeActive = merge.matchMaking || (merge.worldIds.length > 0 && merge.executeTs > 0);
  let deadline = mergeActive ? (merge.executeTs || 0) - 3600 : Infinity;
  if (nowOf(client) >= deadline) return blocked('合服期间暂停派遣');
  view.owner = city.guildIdx;
  view.role = city.guildIdx === guildIdx ? 'defence' : 'attack';
  view.intent = 'attack';
  view.cost = 0;
  let fuel = null;
  if (view.role === 'defence') {
    // 原生己城调动与增援共用移动请求。受宣战时也可在开战前提前布防。
    const fighting = valid(protocol.CityState?.CTS_BATTLING, 1) && city.state === protocol.CityState.CTS_BATTLING;
    const war = fighting ? null : await get('WarDeclarationRequest').catch(() => null);
    const threatened = war?.declarations?.some(d => d.cityId === cityId && d.defenceGuildIdx === guildIdx
      && valid(d.attackGuildIdx, 1) && d.attackGuildIdx !== guildIdx);
    view.intent = fighting || threatened ? 'reinforce' : 'relocate';
  } else {
    if (definition.guildIndex > 0) return blocked('不能向其他联盟主城派遣');
    const war = await get('WarDeclarationRequest');
    if (!Array.isArray(war?.declarations)) return blocked('宣战状态未同步');
    if (!war.declarations.some(d => d.cityId === cityId && d.attackGuildIdx === guildIdx && d.defenceGuildIdx === city.guildIdx))
      return blocked('本盟尚未向该城宣战');
    if (!valid(war.startTime, 1) || !valid(war.endTime, war.startTime + 1)) return blocked('城战时间未同步');
    if (nowOf(client) < war.startTime || nowOf(client) >= war.endTime) return blocked('城战时段内才可进攻');
    deadline = Math.min(deadline, war.endTime);
    const [map, bag] = await Promise.all([mapLoader(scenarioId, config?.resources ?? null), get('AllItemRequest')]);
    view.cost = cityPetrolCost(map, capital.id, cityId, rows(config, scenarioId + '_AttackCityConsumeCfg'));
    if (!valid(view.cost, 1)) return blocked('进攻行军费用未同步');
    if (!Array.isArray(bag?.items)) return blocked('汽油库存未同步');
    fuel = toNumber(bag.items.find(item => item.itemId === '汽油')?.num ?? 0);
    if (!valid(fuel)) return blocked('汽油库存未同步');
  }

  // 以此次读回结算尚未结束的手动调动。限定读前票据，避免旧视图释放较新的占用。
  const baseline = Object.fromEntries(Object.entries(recordsInWorld(ledger.keyRecords(), worldId)).filter(([, row]) => row.details?.manualCityMove));
  const [water, own] = await Promise.all([get('OnWaterRequest'), get('MyFleetsRequest')]);
  if (!Array.isArray(water?.building) || !Array.isArray(own?.fleets)) return blocked('舰队或编队未同步');
  if (!sameIdentity() || nowOf(client) >= deadline) return blocked('身份或可派遣时段已变化，请刷新');
  if (settle) settleFleetSnapshot(ledger, { worldId, fleets: own.fleets, now: nowOf(client), kinds: ['cityDispatch'], baseline });
  const records = recordsInWorld(ledger.keyRecords(), worldId);
  const projectedCost = settle ? 0 : projectManualReturns(records, baseline, own.fleets);
  if (view.role === 'attack') {
    const held = pendingPetrol(ledger) - projectedCost;
    if (!valid(held)) return blocked('在途汽油消耗未同步');
    if (fuel - held < view.cost) return blocked('可用汽油不足');
  }
  function dispatchBlock(fleet, building, origin) {
    const id = fleet.buildingId;
    if (own.fleets.filter(row => row?.buildingId === id).length !== 1) return '状态未同步';
    if (fleet.state !== 1 || fleet.curGridIdx > 0) return fleetStateName(fleet);
    if (!fleetAtHome(fleet)) {
      if (exactAutomationId(fleet.treasureLootUid)) return '货轮任务中';
      if (fleet.chipWar?.rewardTs) return '矿场任务中';
      return '状态未同步';
    }
    if (origin === cityId) return '已在此城';
    if (!valid(fleet.durability) || !valid(fleet.maxDura, 1) || fleet.durability > fleet.maxDura) return '耐久未同步';
    // 原生选舰窗允许零耐久的空闲舰队从正在交战的城市调离。
    if (fleet.durability === 0 && !(valid(protocol.CityState?.CTS_BATTLING, 1) &&
        world.cities.some(c => c.id === fleet.cityId && c.state === protocol.CityState.CTS_BATTLING))) return '耐久不足';
    if (!(building?.level > 0)) return '编队未同步';
    if (!building.fleet?.formation?.heroPositions?.some(slot => slot.heroId)) return '未编队';
    if (fleetRecordReason(records, id, worldId)) return '任务占用';
    if (dispatchReservationReason(client, settings, 'overview', id)) return '已预留';
    return '';
  }
  const roster = own.fleets.filter(fleet => fleetNumber(fleet?.buildingId) &&
    (!fleet.owner || exactAutomationId(fleet.owner.playerId) === playerId))
    .sort((a, b) => parseInt(a.buildingId, 10) - parseInt(b.buildingId, 10));
  for (const fleet of roster) {
    const id = fleet.buildingId, origin = fleet.cityId || capital.id;
    if (view.fleetChoices.at(-1)?.buildingId === id) continue;
    const building = water.building.find(b => b.buildingId === id);
    if (building?.level === 0) continue;
    const reason = dispatchBlock(fleet, building, origin), name = '远征舰队 ' + fleetNumber(id) + ' 队';
    view.fleetChoices.push({ buildingId: id, name, available: !reason, status: reason || '空闲' });
    if (!reason) view.fleets.push({ buildingId: id, name, durability: fleet.durability, maxDura: fleet.maxDura, origin });
  }
  if (!view.fleets.length) return blocked('没有可派往该城的空闲舰队');
  view.validUntil = Number.isFinite(deadline) ? deadline : null;
  return view;
}

export async function previewWorldCityDispatch(client, protocol, config, player, settings, ledger, target, options) {
  try { return await readDispatch(client, protocol, config, player, settings, ledger, target, { ...options, settle: false }); }
  catch (error) {
    return { cityId: target.cityId, owner: null, cost: null, role: null, fleets: [], fleetChoices: [], reason: '派遣状态未同步：' + error.message };
  }
}

export async function runWorldCityDispatch(client, protocol, config, player, settings, ledger, target, {
  validate: validateContext, mapLoader = loadMapAsset,
} = {}) {
  const { buildingId, cityId } = target;
  if (!fleetNumber(buildingId)) throw Error('请选择一支空闲远征舰队');
  const view = await readDispatch(client, protocol, config, player, settings, ledger, target, { mapLoader, settle: true });
  if (view.reason) throw Error(view.reason);
  const fleet = view.fleets.find(f => f.buildingId === buildingId);
  if (!fleet) throw Error('所选舰队已无法派遣，请刷新');
  if (view.owner !== target.owner || view.role !== target.role || view.cost !== target.cost) throw Error('城池归属或行军费用已变化，请重新确认');
  if (view.intent !== target.intent) throw Error('城池攻防状态已变化，请重新选择舰队');
  const validate = () => {
    validateContext?.();
    if (!client.connected) throw Error('连接已变化，派遣已取消');
    if (view.validUntil !== null && nowOf(client) >= view.validUntil) throw Error('派遣时段已结束，请刷新城池');
  };
  validate();
  const worldId = exactAutomationId(player.worldId);
  const uniqueKey = 'cityWar:' + worldId + ':' + fleetNumber(buildingId);
  const details = { kind: 'cityDispatch', manualCityMove: true, buildingId, cityId,
    cost: view.cost, role: view.role, intent: view.intent, origin: fleet.origin, sentAt: nowOf(client) };
  const ticket = ledger.reserve({ cityWarPetrol: view.cost, manualCityDispatches: 1 }, {}, {}, { uniqueKey, details });
  try {
    await client.sendWatch(moveRequest, { buildingId: [buildingId], cityId }, { window: 600, beforeSend: validate });
  } catch (error) {
    if (error.notSent || (error.prompt && error.request === moveRequest)) {
      ledger.cancel(ticket);
      return { status: 'rejected', message: '派遣未执行：' + error.message };
    }
    return { status: 'unknown', message: '派遣结果待确认，已保留舰队和汽油记录' };
  }
  try {
    const baseline = ledger.keyRecords();
    const after = await client.request('MyFleetsRequest', {}, 'MyFleetsResponse', 8000);
    settleFleetSnapshot(ledger, { worldId, fleets: after.fleets, now: nowOf(client), kinds: ['cityDispatch'], baseline });
    const record = ledger.keyRecords()[uniqueKey];
    const own = after.fleets?.filter(row => row.buildingId === buildingId);
    if ((record?.id === ticket.id && record.confirmed) ||
        (!record && own?.length === 1 && cityDispatchObserved(own[0], details))) {
      return { status: 'confirmed', message: fleet.name + '已派往' + view.cityName + (view.intent === 'reinforce' ? '增援防守' : '') };
    }
  } catch { /* 回读失败不撤销已经发出的调动。 */ }
  return { status: 'unknown', message: '派遣结果待确认，已保留舰队和汽油记录' };
}
