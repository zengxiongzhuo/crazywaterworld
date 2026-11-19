import { exactAutomationId } from './automation-policy.mjs';

// GuildMemberTitle.VICE_PRESIDENT / PRESIDENT.
const officer = title => title === 4 || title === 5;
const positive = value => Number.isSafeInteger(value) && value > 0;

export async function readCityOfficer(client, protocol, player, { scenarioId, cityId }, { request = client.request.bind(client) } = {}) {
  const guildId = exactAutomationId(player?.guildId), playerId = exactAutomationId(player?.playerId);
  const worldId = exactAutomationId(player?.worldId), guildIdx = guildId ? Number(BigInt(guildId) % 1000n) : 0;
  const identity = () => exactAutomationId(player?.guildId) === guildId && exactAutomationId(player?.playerId) === playerId
    && exactAutomationId(player?.worldId) === worldId && (player?.scenarioId || 1) === scenarioId;
  const get = (name, body = {}) => {
    const response = name.replace(/Request$/, 'Response');
    if (!protocol?.[name] || !protocol?.[response]) throw Error('当前协议缺少 ' + name);
    return request(name, body, response, 8000);
  };
  const view = { visible: false, reason: '', guildId, guildIdx, worldId, playerId, owner: null, world: null, identity, get };
  const blocked = reason => ({ ...view, reason });
  if (!worldId || !playerId || !guildIdx) return blocked('未能确认角色或联盟身份');
  if (!positive(scenarioId) || !positive(cityId) || !identity()) return blocked('城池或场景已变化，请刷新地图');
  try {
    const guild = await get('GuildInfoRequest');
    if (exactAutomationId(guild?.guild?.guildId) !== guildId || !identity()) return blocked('联盟身份已变化，请刷新地图');
    if (!officer(guild.myTitle)) return blocked('仅盟主、副盟主可以操作');
    const world = await get('WorldInfoRequest', { screenCenter: { x: 0, y: 0 } });
    if (!identity()) return blocked('角色或联盟已变化，请重新查看');
    // Unset optional protobuf enums inherit the first value from their prototype.
    if (Object.hasOwn(world, 'myGuildTitle') && !officer(world.myGuildTitle)) return blocked('仅盟主、副盟主可以操作');
    view.visible = true;
    const city = world.cities?.find(row => row.id === cityId);
    if (!Number.isSafeInteger(city?.guildIdx) || city.guildIdx < 0) return blocked('城池归属未同步');
    return { ...view, owner: city.guildIdx, world };
  } catch (error) { return blocked('无法核对联盟职位或城池归属：' + error.message); }
}
