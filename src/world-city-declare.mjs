import { exactAutomationId } from './automation-policy.mjs';
import { toNumber } from './client.mjs';
import { readCityOfficer } from './world-city-authority.mjs';
import { loadMapAsset } from './world.mjs';

// CityMenuPop / GuildUtil: up to three simultaneous declarations per alliance.
const MAX_DECLARATIONS = 3;
const observations = new WeakMap();
const positive = value => Number.isSafeInteger(value) && value > 0;
const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const keyOf = (player, guildId, target) =>
  ['cityDeclare', exactAutomationId(player.worldId), exactAutomationId(player.playerId), guildId, target.scenarioId, target.cityId].join(':');

async function inspectDeclaration(client, protocol, config, player, target, {
  ledger, mapLoader = loadMapAsset, request = client.request.bind(client),
} = {}, settle = false) {
  const { scenarioId, cityId } = target;
  const guildId = exactAutomationId(player?.guildId);
  const view = { visible: false, available: false, reason: '', owner: null, guildId, count: null, limit: MAX_DECLARATIONS,
    name: '城池 ' + cityId, warEnd: null };
  const blocked = reason => ({ ...view, reason });
  const officer = await readCityOfficer(client, protocol, player, target, { request });
  const { guildIdx: own, identity, get, world } = officer;
  Object.assign(view, { visible: officer.visible, owner: officer.owner });
  if (officer.reason) return blocked(officer.reason);
  try {
    if (!protocol?.DeclareWarRequest) return blocked('当前游戏协议未提供宣战操作');
    const definition = rows(config, scenarioId + '_CityCfg').find(city => city.id === cityId);
    if (!definition || !positive(definition.level) || !Number.isSafeInteger(definition.guildIndex)) return blocked('未读取到城池配置');
    view.name = definition.name || view.name;
    if (definition.guildIndex > 0) return blocked('无法对联盟主城宣战');
    const uniqueKey = keyOf(player, guildId, target);
    const record = ledger?.keyRecords()[uniqueKey];
    const war = await get('WarDeclarationRequest');
    if (!Array.isArray(war.declarations)) return blocked('宣战信息未同步');
    const ours = war.declarations.filter(row => row.attackGuildIdx === own);
    view.count = ours.length;
    view.warEnd = positive(war.endTime) ? war.endTime : null;
    const declared = ours.some(row => row.cityId === cityId);
    if (record) {
      // A preview may observe resolution even if the declaration ends before the next submit.
      let seen = observations.get(client);
      if (!seen) { seen = new Map(); observations.set(client, seen); }
      if (declared || view.owner === own) seen.set(uniqueKey, record.id);
      const newWar = positive(record.details?.warEnd) && war.startTime >= record.details.warEnd
        && Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000) >= record.details.warEnd;
      if (!record.confirmed && seen.get(uniqueKey) !== record.id && !newWar) return blocked('上次宣战结果待确认，请刷新城池状态');
      if (settle && !declared && view.owner !== own && ledger.keyRecords()[uniqueKey]?.id === record.id) {
        if (record.confirmed) ledger.releaseCompletedKey(uniqueKey);
        else ledger.cancel({ id: record.id }); // No counters or costs use this ticket.
        seen.delete(uniqueKey);
      }
    }
    if (view.owner === own) return blocked('该城池属于本盟');
    if (declared) return blocked('本盟已向该城池宣战');
    if (ours.length >= MAX_DECLARATIONS) return blocked('本盟已有 3 个宣战目标');
    const map = await mapLoader(scenarioId, config?.resources ?? null);
    const neighbors = map?.cityInfo?.[cityId]?.neighbors;
    if (!Array.isArray(neighbors)) return blocked('城池邻接关系未同步');
    let polluted = [];
    if (world.blackWaterId) {
      polluted = map.pollutionData?.find(row => row.id === world.blackWaterId)?.citys;
      if (!Array.isArray(polluted)) return blocked('当前黑潮范围未同步');
    } else if (map.pollutionData?.length && typeof world.blackWaterId !== 'string') return blocked('当前黑潮状态未同步');
    if (polluted.includes(cityId)) return blocked('无法向黑潮城池宣战');
    if (!neighbors.some(id => !polluted.includes(id) && world.cities.some(city => city.id === id && city.guildIdx === own))) {
      return blocked('宣战目标需与本盟的非黑潮城池相邻');
    }
    const { stage } = await get('SeasonTaskStageRequest');
    if (!Number.isSafeInteger(stage) || stage < 0) return blocked('赛季阶段未同步');
    if (stage > 0) {
      const season = Number(BigInt(exactAutomationId(player.worldId)) / 1000000n % 1000n);
      const cap = rows(config, scenarioId + '_SeasonTaskCfg').find(row => Number(row.season) === season && row.stage === stage)?.maxCityLevel;
      if (!positive(cap)) return blocked('当前赛季的城池等级上限未同步');
      if (definition.level > cap) return blocked('当前赛季阶段尚未解锁该城池');
    }
    const { forts } = await get('FortListRequest');
    if (!Array.isArray(forts)) return blocked('城池工事未同步');
    if (forts.some(fort => fort.cityId === cityId && fort.type === '干扰器')) return blocked('该城池有干扰器，无法宣战');
    if (!identity()) return blocked('角色或联盟已变化，请重新查看');
    return { ...view, available: true };
  } catch (error) {
    return blocked('无法核对宣战条件：' + error.message);
  }
}

export function readCityDeclare(client, protocol, config, player, target, options) {
  return inspectDeclaration(client, protocol, config, player, target, options);
}

export async function declareCity(client, protocol, config, player, target, options = {}) {
  const { ledger, validate } = options;
  if (!ledger) throw new Error('缺少账号宣战记录');
  // A write always reads the live state. A preview's shared reads may be cached.
  const view = await inspectDeclaration(client, protocol, config, player, target, { ledger, mapLoader: options.mapLoader }, true);
  if (!view.available) throw new Error(view.reason);
  if (target.owner !== view.owner || target.guildId !== view.guildId) throw new Error('城池归属或本盟身份已变化，请重新确认宣战目标');
  validate?.();
  const uniqueKey = keyOf(player, view.guildId, target);
  const ticket = ledger.reserve({}, {}, {}, { uniqueKey, details: { warEnd: view.warEnd } });
  try {
    await client.sendWatch('DeclareWarRequest', { cityId: target.cityId }, { window: 600, beforeSend: validate });
  } catch (error) {
    if (error.notSent || (error.prompt && error.request === 'DeclareWarRequest')) {
      ledger.cancel(ticket);
      throw error;
    }
    // Transport errors can occur after the server applied the declaration.
  }
  const unknown = { confirmed: false, message: '向' + view.name + '宣战的结果待确认，请刷新城池状态' };
  let reply;
  try { reply = await client.request('WarDeclarationRequest', {}, 'WarDeclarationResponse', 8000); }
  catch { return unknown; }
  const own = Number(BigInt(view.guildId) % 1000n);
  if (!reply?.declarations?.some(row => row.cityId === target.cityId && row.attackGuildIdx === own)) return unknown;
  ledger.confirm(ticket);
  return { confirmed: true, message: '已确认本盟向' + view.name + '宣战' };
}

const cancelRequest = 'CancelDeclareWarRequest';
const serverSeconds = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const cancellationKey = (officer, target, start) =>
  ['cityCancel', officer.worldId, officer.playerId, officer.guildId, target.scenarioId, target.cityId, start].join(':');

function pendingCancellations(ledger, player, target) {
  const worldId = exactAutomationId(player?.worldId), playerId = exactAutomationId(player?.playerId);
  const guildId = exactAutomationId(player?.guildId);
  if (!ledger || !worldId || !playerId || !guildId || !positive(target.cityId) || target.scenarioId !== (player.scenarioId || 1)) return [];
  const prefix = cancellationKey({ worldId, playerId, guildId }, target, '');
  return Object.entries(ledger.keyRecords()).filter(([key, record]) => key.startsWith(prefix) && !record.confirmed && record.details);
}

async function personalDiamonds(get) {
  const resource = await get('AllResourceRequest');
  const rubies = resource?.list?.filter(row => row.res === 4);
  if (rubies?.length !== 1 || rubies[0].amount == null) throw Error('个人钻石余额未同步');
  const amount = toNumber(rubies[0].amount);
  if (!Number.isSafeInteger(amount) || amount < 0) throw Error('个人钻石余额未同步');
  return amount;
}

export async function readCityCancelDeclare(client, protocol, config, player, target, { request, ledger } = {}) {
  const officer = await readCityOfficer(client, protocol, player, target, { request });
  const view = { visible: false, available: false, reason: '', owner: officer.owner, guildId: officer.guildId,
    cost: null, count: null, limit: MAX_DECLARATIONS, name: '城池 ' + target.cityId,
    warStart: null, warEnd: null, previousId: null, balance: null,
    pending: pendingCancellations(ledger, player, target).length > 0 };
  const blocked = reason => ({ ...view, reason });
  if (officer.reason) return blocked(officer.reason);
  try {
    const { cityId, scenarioId } = target, definition = rows(config, scenarioId + '_CityCfg').find(row => row.id === cityId);
    if (!definition || !Number.isSafeInteger(definition.guildIndex)) return blocked('城池配置未同步');
    if (definition.guildIndex > 0 || officer.owner === officer.guildIdx) return blocked('只能撤销对其他非主城的宣战');
    view.name = definition.name || view.name;
    const war = await officer.get('WarDeclarationRequest');
    if (!Array.isArray(war?.declarations)) return blocked('宣战列表未同步');
    const ourWars = war.declarations.filter(row => row.attackGuildIdx === officer.guildIdx);
    const declared = ourWars.find(row => row.cityId === cityId);
    if (!declared) return blocked('本盟未向该城池宣战');
    view.visible = true;
    if (declared.defenceGuildIdx !== officer.owner) return blocked('城池归属与宣战目标不一致，请刷新');
    view.count = new Set(ourWars.map(row => row.cityId)).size;
    if (view.count <= 1) return blocked('本盟须保留至少一个宣战目标');
    if (!protocol?.[cancelRequest]) return blocked('当前协议未提供撤销宣战操作');
    if (!positive(war.startTime) || !positive(war.endTime) || war.endTime <= war.startTime) return blocked('宣战时段未同步');
    view.warStart = war.startTime;
    view.warEnd = war.endTime;
    const record = ledger?.keyRecords()[cancellationKey(officer, target, war.startTime)];
    if (record && !record.confirmed) return blocked('上次撤销宣战的扣款结果待确认');
    view.previousId = record?.id ?? null;
    const cost = rows(config, 'WorldParamCfg').find(row => row.paramName === '取消宣战消耗')?.paramValue;
    if (!Number.isSafeInteger(cost) || cost < 0) return blocked('撤销宣战的钻石费用未同步');
    view.cost = cost;
    view.balance = await personalDiamonds(officer.get);
    const held = ledger?.pendingCounters().diamonds ?? 0;
    if (!Number.isSafeInteger(held) || held < 0 || view.balance - held < cost) return blocked('可用个人钻石不足');
    if (!officer.identity()) return blocked('角色或联盟已变化，请重新查看');
    return { ...view, available: true };
  } catch (error) {
    return blocked('无法核对撤销宣战条件：' + error.message);
  }
}

// Only a matching cancellation in the original war AND a matching personal debit
// settle a paid ticket. Losing the city or a war ending can remove the same row.
async function cancellationObserved(client, player, target, record) {
  const { guildId, worldId, playerId, owner, cost, balance, warStart, warEnd, sentAt } = record.details;
  const sameIdentity = () => exactAutomationId(player.guildId) === guildId && exactAutomationId(player.worldId) === worldId
    && exactAutomationId(player.playerId) === playerId && (player.scenarioId || 1) === target.scenarioId;
  const get = (name, body = {}) => client.request(name, body, name.replace(/Request$/, 'Response'), 8000);
  if (!sameIdentity()) return false;
  const guild = await get('GuildInfoRequest');
  if (exactAutomationId(guild?.guild?.guildId) !== guildId) return false;
  const war = await get('WarDeclarationRequest'), guildIdx = Number(BigInt(guildId) % 1000n);
  if (war?.startTime !== warStart || war.endTime !== warEnd || !Array.isArray(war.declarations) ||
    war.declarations.some(row => row.cityId === target.cityId && row.attackGuildIdx === guildIdx)) return false;
  const world = await get('WorldInfoRequest', { screenCenter: { x: 0, y: 0 } });
  if (world?.cities?.find(city => city.id === target.cityId)?.guildIdx !== owner) return false;
  if (cost > 0 && await personalDiamonds(get) !== balance - cost) return false;
  return sameIdentity() && !(sentAt < warEnd && serverSeconds(client) >= warEnd);
}

export async function reconcileCityCancelDeclare(client, protocol, config, player, target, { ledger, validate } = {}) {
  const pending = pendingCancellations(ledger, player, target);
  if (!pending.length) return { confirmed: false, message: '当前城池没有待核对的撤销记录' };
  let confirmed = 0;
  for (const [key, record] of pending) {
    validate?.();
    try {
      if (!await cancellationObserved(client, player, target, record)) continue;
    } catch { continue; }
    validate?.();
    if (ledger.keyRecords()[key]?.id !== record.id) continue;
    ledger.confirm({ id: record.id });
    confirmed++;
  }
  if (confirmed === pending.length) return { confirmed: true, message: '已核实撤销宣战及个人钻石扣款' };
  return { confirmed: false, message: '撤销宣战或个人钻石扣款仍待确认' };
}

export async function cancelCityDeclare(client, protocol, config, player, target, { ledger, validate } = {}) {
  if (!ledger) throw Error('缺少账号撤销宣战记录');
  const view = await readCityCancelDeclare(client, protocol, config, player, target, { ledger });
  if (!view.available) throw Error(view.reason);
  for (const field of ['cost', 'owner', 'guildId', 'warStart', 'warEnd', 'previousId']) {
    if (view[field] !== target[field]) throw Error('个人钻石费用、城池归属或宣战记录已变化，请重新确认');
  }
  validate?.();
  const details = { worldId: exactAutomationId(player.worldId), playerId: exactAutomationId(player.playerId),
    guildId: view.guildId, owner: view.owner, cityId: target.cityId, scenarioId: target.scenarioId,
    cost: view.cost, balance: view.balance, warStart: view.warStart, warEnd: view.warEnd, sentAt: serverSeconds(client) };
  const key = cancellationKey(details, target, view.warStart);
  if (view.previousId) {
    const current = ledger.keyRecords()[key];
    if (current?.id !== view.previousId || !current.confirmed) throw Error('宣战记录已变化，请重新确认');
    ledger.releaseCompletedKey(key);
  }
  const ticket = ledger.reserve({ diamonds: view.cost }, {}, {}, { uniqueKey: key, details });
  const beforeSend = () => {
    validate?.();
    if (details.sentAt < view.warEnd && serverSeconds(client) >= view.warEnd) throw Error('宣战时段已结束，请重新确认');
  };
  try {
    await client.sendWatch(cancelRequest, { cityId: target.cityId }, { window: 600, beforeSend });
  } catch (error) {
    if (error.notSent || (error.prompt && error.request === cancelRequest)) {
      ledger.cancel(ticket);
      throw error;
    }
  }
  let confirmed;
  try { confirmed = await cancellationObserved(client, player, target, { details }); }
  catch { confirmed = false; }
  if (!confirmed) return { confirmed: false, message: '撤销对' + view.name + '的宣战或个人钻石扣款待确认' };
  ledger.confirm(ticket);
  return { confirmed: true, message: '已撤销对' + view.name + '的宣战，本次消耗个人钻石 ' + view.cost };
}
