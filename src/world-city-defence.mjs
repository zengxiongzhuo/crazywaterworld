import { exactAutomationId } from './automation-policy.mjs';
import { toNumber } from './client.mjs';
import { beginOrderMaterialSpend, cancelOrderMaterialSpend, pendingOrderMaterialSpends, settleOrderMaterialState } from './order-reservations.mjs';

const itemId = '联盟募兵令';
const recruitRequest = 'CityRecruitDefenceRequest';
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const recordKey = player => 'cityRecruit:' + exactAutomationId(player.worldId) + ':' + exactAutomationId(player.playerId);

function reader(protocol, request) {
  return (name, body = {}) => {
    const response = name.replace(/Request$/, 'Response');
    if (!protocol?.[name] || !protocol?.[response]) throw Error('当前协议缺少' + name);
    return request(name, body, response, 8000);
  };
}

function cityDefinition(config, player, { scenarioId, cityId }) {
  if (integer(scenarioId, 1) && scenarioId === (player?.scenarioId || 1) && integer(cityId, 1))
    return rows(config, scenarioId + '_CityCfg').find(row => row.id === cityId);
}

async function readRecruitStock(get) {
  const bag = await get('AllItemRequest'), stock = new Map();
  if (!Array.isArray(bag?.items)) throw Error('道具库存未同步');
  for (const row of bag.items) {
    if (row?.itemId !== itemId) continue;
    const amount = row.num == null ? null : toNumber(row.num);
    if (!integer(amount) || stock.has(itemId)) throw Error('联盟募兵令库存不完整');
    stock.set(itemId, amount);
  }
  return stock;
}

// 同时核对守军增长和本人道具扣减。多人可为同一联盟城市募兵。
function recruited(before, guildId, cities, stock) {
  const number = cities.find(city => city.cityId === before.cityId)?.defenceNum;
  return before.guildId === guildId && integer(number) && number >= before.defenceNum + before.gain
    && (stock.get(itemId) ?? 0) <= before.stock - before.cost;
}

function settleRecruit(ledger, player, ticket, stock) {
  const key = recordKey(player);
  if (ledger.keyRecords()[key]?.id !== ticket.id) return;
  ledger.confirm(ticket);
  ledger.releaseCompletedKey(key);
  const handle = pendingOrderMaterialSpends(player).find(handle => handle.operation.cityRecruitTicket === ticket.id);
  if (handle) settleOrderMaterialState(player, { account: handle.account, handles: [handle] }, stock);
}

async function readRecruit(protocol, config, player, target, definition, get, ledger, settleMaterials = false) {
  const guildId = exactAutomationId(player?.guildId);
  const previous = player && ledger?.keyRecords()[recordKey(player)];
  const pending = !!previous && previous.details?.cityId === target.cityId && previous.details?.scenarioId === target.scenarioId;
  const view = { visible: pending, pending, allowed: false, reason: '', owner: null, guildId, itemId, cost: 1, gain: null, stock: null, defenceNum: null };
  const blocked = reason => ({ ...view, reason });
  if (!definition || definition.guildIndex !== 0 || !guildId || !exactAutomationId(player.worldId) || !exactAutomationId(player.playerId))
    return blocked('仅本盟拥有的非主城可以募兵');
  try {
    const world = await get('WorldInfoRequest', { screenCenter: { x: 0, y: 0 } });
    const own = Number(BigInt(guildId) % 1000n);
    view.owner = world.cities?.find(city => city.id === target.cityId)?.guildIdx ?? null;
    if (own <= 0 || view.owner !== own) return blocked('仅本盟拥有的非主城可以募兵');
    const guild = await get('GuildInfoRequest');
    if (exactAutomationId(guild.guild?.guildId) !== guildId) return blocked('联盟身份已变化');
    const vip = player.vip?.vipLevel;
    const needed = rows(config, 'VipLevelCfg').find(row => row.effects?.some(([id]) => id === '联盟高级募兵'))?.level;
    if (!integer(needed) || !integer(vip)) return blocked('高级募兵 VIP 条件未同步');
    view.requiredVip = needed;
    // GuildCityArmyPop._refreshReruitDefenceBtn 提前两级展示灰色的高级募兵按钮。
    view.visible = pending || vip >= needed - 2;
    if (vip < needed) return blocked('高级募兵需要 VIP' + needed);
    if (!protocol?.[recruitRequest]) return blocked('当前协议未提供高级募兵');
    view.gain = rows(config, 'GuildParamCfg').find(row => row.paramName === '募兵令增加守军数')?.paramValue;
    if (!integer(view.gain, 1)) return blocked('募兵令增加守军数量未同步');
    const { cities } = await get('GuildCityInfoRequest');
    if (!Array.isArray(cities)) return blocked('联盟城市守军未同步');
    view.defenceNum = cities.find(row => row.cityId === target.cityId)?.defenceNum;
    if (!integer(view.defenceNum)) return blocked('目标城池已失守或守军未同步');
    const stock = await readRecruitStock(get);
    view.stock = stock.get(itemId) ?? 0;
    if (previous) {
      if (!pending) return blocked('请先到' + (previous.details.cityName || '上次募兵城池') + '核对募兵结果');
      return blocked('请核对上次募兵结果');
    }
    for (const handle of pendingOrderMaterialSpends(player)) {
      if (!handle.scope.has(itemId)) continue;
      // 另一连接/进程可已经核实扣款并解除持久占用。旧预览只投影这一结果；
      // 真正提交时用刚取得的库存清理对应的本地材料句柄。
      const ticketId = handle.operation.cityRecruitTicket;
      if (!ledger || !ticketId || ledger.keyRecords()[recordKey(player)]?.id === ticketId) return blocked('联盟募兵令已有待确认扣款');
      if (settleMaterials) settleOrderMaterialState(player, { account: handle.account, handles: [handle] }, stock);
    }
    if (view.stock < view.cost) return blocked('联盟募兵令不足');
    return { ...view, allowed: true };
  } catch (error) { return blocked('高级募兵条件未同步：' + error.message); }
}

export async function readWorldCityDefenders(client, protocol, config, player, target, { request = client.request.bind(client) } = {}) {
  const definition = cityDefinition(config, player, target);
  const cityName = definition?.name || '城池 ' + target.cityId;
  const get = reader(protocol, request);
  try {
    if (!definition) throw Error('城市或场景已变化');
    const { fleets } = await get('CityDefenceRequest', { cityId: target.cityId });
    if (!Array.isArray(fleets)) throw Error('守军名单未同步');
    const defenders = fleets.map(f => {
      const power = f.power == null ? null : toNumber(f.power);
      return { name: f.isNpc ? cityName + '守军' : f.name || '未同步', npc: !!f.isNpc,
        count: f.isNpc ? integer(f.multiple, 1) ? f.multiple : null : 1, guildIdx: f.guildIdx ?? null,
        power: integer(power) ? power : exactAutomationId(f.power) };
    });
    return { synced: true, reason: '', defenders };
  } catch (error) { return { synced: false, reason: '守军名单未同步：' + error.message, defenders: [] }; }
}

export async function readWorldCityDefence(client, protocol, config, player, target, { request = client.request.bind(client), ledger, includeDefenders = true } = {}) {
  const definition = cityDefinition(config, player, target);
  const [army, recruit] = await Promise.all([
    includeDefenders ? readWorldCityDefenders(client, protocol, config, player, target, { request }) :
      { deferred: Boolean(definition && protocol?.CityDefenceRequest && protocol.CityDefenceResponse) },
    readRecruit(protocol, config, player, target, definition, reader(protocol, request), ledger),
  ]);
  return { cityId: target.cityId, cityName: definition?.name || '城池 ' + target.cityId, ...army, recruit };
}

export async function reconcileWorldCityRecruit(client, protocol, config, player, target, { ledger, validate } = {}) {
  const key = recordKey(player), ticket = ledger?.keyRecords()[key], before = ticket?.details;
  if (!before || before.scenarioId !== target.scenarioId || before.cityId !== target.cityId)
    throw Error('该城没有待核对的募兵记录');
  const get = reader(protocol, client.request.bind(client));
  validate?.();
  if (!cityDefinition(config, player, target) || exactAutomationId(player.guildId) !== before.guildId)
    throw Error('角色场景或联盟已变化');
  const guild = await get('GuildInfoRequest');
  const { cities } = await get('GuildCityInfoRequest');
  const stock = await readRecruitStock(get);
  validate?.();
  if (recordKey(player) !== key || exactAutomationId(player.guildId) !== before.guildId ||
      exactAutomationId(guild.guild?.guildId) !== before.guildId || (player.scenarioId || 1) !== before.scenarioId) throw Error('角色或联盟已变化');
  if (!Array.isArray(cities) || !ticket.confirmed && !recruited(before, before.guildId, cities, stock))
    return { status: 'unknown', message: '守军增长与本人募兵令扣减尚未核实' };
  settleRecruit(ledger, player, { id: ticket.id }, stock);
  return { status: 'confirmed', message: before.cityName + '上次募兵已确认' };
}

export async function runWorldCityRecruit(client, protocol, config, player, target, { ledger, validate } = {}) {
  if (!ledger) throw Error('缺少募兵用量记录');
  const get = reader(protocol, client.request.bind(client)), definition = cityDefinition(config, player, target);
  const view = await readRecruit(protocol, config, player, target, definition, get, ledger, true);
  if (!view.allowed) throw Error(view.reason);
  if (['owner', 'guildId', 'cost', 'itemId', 'gain', 'stock'].some(key => target[key] !== view[key])) throw Error('城池归属、库存或募兵费用已变化，请重新确认');
  const check = () => {
    validate?.();
    if (client.connected === false || !cityDefinition(config, player, target) || exactAutomationId(player.guildId) !== view.guildId)
      throw Error('连接、联盟或场景已变化');
    if (!integer(player.vip?.vipLevel, view.requiredVip)) throw Error('角色 VIP 已变化，请重新查看城池');
  };
  check();
  const key = recordKey(player), details = { cityId: target.cityId, cityName: definition.name, scenarioId: target.scenarioId,
    guildId: view.guildId, stock: view.stock, cost: view.cost,
    gain: view.gain, defenceNum: view.defenceNum };
  const ticket = ledger.reserve({ manualCityRecruitTokens: view.cost }, {}, {}, { uniqueKey: key, details });
  let debit;
  try {
    debit = beginOrderMaterialSpend(player, [{ id: itemId, have: view.stock, need: view.cost }], '城池高级募兵',
      { operation: { cityRecruitTicket: ticket.id, verify: () => ledger.keyRecords()[key]?.id !== ticket.id } });
  } catch (error) { ledger.cancel(ticket); throw error; }
  try {
    await client.sendWatch(recruitRequest, { cityId: target.cityId }, { window: 600, beforeSend: check });
  } catch (error) {
    if (error.notSent || error.prompt && error.request === recruitRequest) {
      cancelOrderMaterialSpend(debit);
      ledger.cancel(ticket);
      throw error;
    }
  }
  try {
    const { cities } = await get('GuildCityInfoRequest');
    const stock = await readRecruitStock(get);
    if (recordKey(player) === key && Array.isArray(cities) && recruited(details, exactAutomationId(player.guildId), cities, stock)) {
      settleRecruit(ledger, player, ticket, stock);
      return { status: 'confirmed', message: definition.name + '已增加 ' + view.gain + ' 名守军，消耗 1 枚联盟募兵令' };
    }
  } catch { /* 已发出的募兵保留道具占用，供下次读取核对。 */ }
  return { status: 'unknown', message: definition.name + '募兵结果待确认，请刷新守军与募兵令库存' };
}
