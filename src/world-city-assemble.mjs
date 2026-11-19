import { exactAutomationId } from './automation-policy.mjs';
import { readCityOfficer } from './world-city-authority.mjs';

const command = 'SetAssembleCityRequest';
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const observedTickets = new WeakMap();

function battleRole(declarations, cityId, owner, guildIdx) {
  for (const d of declarations) {
    if (d.cityId !== cityId || d.defenceGuildIdx !== owner || d.attackGuildIdx === d.defenceGuildIdx) continue;
    if (d.attackGuildIdx === guildIdx) return 'attack';
    if (d.defenceGuildIdx === guildIdx && d.attackGuildIdx > 0) return 'defence';
  }
  return null;
}

async function inspectAssemble(client, protocol, config, player, target, { request, ledger } = {}) {
  const { scenarioId, cityId } = target;
  const { worldId, playerId, guildId, guildIdx, owner, world, identity, get, reason } =
    await readCityOfficer(client, protocol, player, target, { request });
  const key = ['cityAssemble', worldId, playerId, guildId, scenarioId].join(':');
  const view = { visible: false, available: false, reason: '', name: '城池 ' + cityId, guildId, owner,
    currentCityId: null, currentName: '', role: null };
  const finish = (reason = '', previous = null, warEnd = null) =>
    ({ view: { ...view, reason, available: !reason }, key, previous, warEnd });
  if (reason) return finish(reason);
  try {
    const cities = config?.tables?.[scenarioId + '_CityCfg']?.data;
    const city = cities?.find(row => row.id === cityId);
    if (!city || !nonnegative(city.guildIndex)) return finish('城池配置未同步');
    if (city.guildIndex > 0) return finish('联盟主城不能设为集结目标');
    view.name = city.name || view.name;
    const war = await get('WarDeclarationRequest');
    if (!Array.isArray(war?.declarations) || !nonnegative(war.assembleCityId)) return finish('宣战或集结信息未同步');
    if (!identity()) return finish('场景或联盟身份已变化，请刷新地图');
    view.currentCityId = war.assembleCityId;
    view.currentName = view.currentCityId ? cities.find(row => row.id === view.currentCityId)?.name || '城池 ' + view.currentCityId : '';
    view.role = battleRole(war.declarations, cityId, view.owner, guildIdx);
    // CityMenuPop offers this command for both allied defence and allied attack declarations.
    view.visible = !!view.role;
    const previous = ledger?.keyRecords()[key];
    if (previous && !previous.confirmed) {
      // The sole assembly point has moved since the unconfirmed command. A later
      // officer can even move it back before the next click, so remember this observation.
      const oldEnd = previous.details?.warEnd;
      const newWar = oldEnd > 0 && war.startTime >= oldEnd && (Date.now() + (client.serverClockOffsetMs || 0)) / 1000 >= oldEnd;
      const oldTarget = world.cities?.find(row => row.id === previous.details?.to);
      const battleEnded = nonnegative(oldTarget?.guildIdx) && !battleRole(war.declarations, oldTarget.id, oldTarget.guildIdx, guildIdx);
      if (view.currentCityId !== previous.details?.from || battleEnded || newWar) observedTickets.set(client, previous.id);
      if (observedTickets.get(client) !== previous.id) return finish('上次集结设置结果待确认，请刷新城池状态');
    }
    if (!view.role) return finish('集结需要本盟已宣战或正在受攻的城池');
    if (view.currentCityId === cityId) return finish('该城已是本盟集结目标');
    if (!protocol[command]) return finish('当前游戏协议未提供集结操作');
    return finish('', previous, war.endTime ?? null);
  } catch (error) { return finish('集结条件未同步：' + error.message); }
}

export async function readCityAssemble(client, protocol, config, player, target, options) {
  return (await inspectAssemble(client, protocol, config, player, target, options)).view;
}

export async function assembleCity(client, protocol, config, player, target, { validate, ledger } = {}) {
  if (!ledger) throw Error('缺少账号集结记录');
  const { view, key, previous, warEnd } = await inspectAssemble(client, protocol, config, player, target, { ledger });
  if (!view.available) throw Error(view.reason);
  if (target.guildId !== view.guildId || target.owner !== view.owner || target.role !== view.role ||
      target.currentCityId !== view.currentCityId) throw Error('归属、攻守状态或集结目标已变化，请重新确认');
  validate?.();
  if (previous) {
    if (ledger.keyRecords()[key]?.id !== previous.id) throw Error('集结记录已变化，请重新确认');
    if (previous.confirmed) ledger.releaseCompletedKey(key);
    else ledger.cancel({ id: previous.id });
  }
  const ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details: { from: view.currentCityId, to: target.cityId, warEnd } });
  try {
    await client.sendWatch(command, { cityId: target.cityId }, { window: 600, beforeSend: validate });
  } catch (error) {
    if (error.notSent || (error.prompt && error.request === command)) { ledger.cancel(ticket); throw error; }
    // A transport failure after sending can still leave the new target in effect.
  }
  const unknown = { confirmed: false, message: view.name + '的集结设置结果待确认，请刷新城池状态' };
  let reply;
  try { reply = await client.request('WarDeclarationRequest', {}, 'WarDeclarationResponse', 8000); }
  catch { return unknown; }
  if (reply?.assembleCityId !== target.cityId || exactAutomationId(player.guildId) !== view.guildId) return unknown;
  ledger.confirm(ticket);
  return { confirmed: true, message: '本盟集结目标已设为' + view.name };
}
