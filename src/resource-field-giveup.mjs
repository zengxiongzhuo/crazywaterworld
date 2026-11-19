import { randomUUID } from 'node:crypto';
import { exactAutomationId } from './automation-policy.mjs';
import { resourceFieldRows } from './resource-fields.mjs';
import { forgetReleasedResourceField } from './resource-field-history.mjs';

const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const identity = player => [player?.worldId, player?.playerId, player?.guildId].map(exactAutomationId).join(':');
const time = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const lockKey = (world, grid) => `resource-field-replace:${world}:${grid}`;
const operationKey = (world, grid, operationId) => `resource-field-giveup:${world}:${grid}:${operationId}`;
const fieldsValid = fields => Array.isArray(fields)
  && fields.every(field => integer(field.gridIdx) && integer(field.cityId, 1) && integer(field.type, 1))
  && new Set(fields.map(field => field.gridIdx)).size === fields.length;
const yieldOf = field => field?.active === false ? 0 : field?.active === true && integer(field.perHour) ? field.perHour : null;

function releaseLock(ledger, record) {
  const lock = record?.details?.lock;
  if (lock && ledger.keyRecords()[lock.key]?.id === lock.id) ledger.cancel({ id: lock.id });
}

// A zero-cost give-up is confirmed only by removal from this player's fresh list.
// Prepared records are safe to cancel after their lease; sent requests never time out into success.
export function settleResourceFieldGiveUps(ledger, { worldId, playerId, fields, now, baseline }) {
  if (!ledger?.keyRecords || !worldId || !fieldsValid(fields)) return [];
  const changes = [];
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    const d = record.details;
    if (!key.startsWith('resource-field-giveup:' + worldId + ':') || d?.kind !== 'resourceFieldGiveUp'
      || d.playerId !== playerId || !integer(d.gridIdx)) continue;
    if (record.confirmed) { releaseLock(ledger, record); continue; }
    if (baseline && (baseline[key]?.id !== record.id || baseline[key]?.details?.phase !== d.phase)) continue;
    if (d.phase === 'prepared' && integer(d.leaseUntil) && integer(now) && d.leaseUntil <= now) {
      ledger.cancel({ id: record.id }); releaseLock(ledger, record);
      changes.push({ key, reason: '放弃尚未发送，过期预留已释放' });
    } else if (d.phase === 'givingUp' && !fields.some(field => field.gridIdx === d.gridIdx)) {
      forgetReleasedResourceField(ledger, worldId, playerId, d.gridIdx);
      ledger.resolveKey(key, true, { ...d, phase: 'completed', active: false, releasedAt: now });
      releaseLock(ledger, record);
      changes.push({ key, reason: `资源田 ${d.gridIdx} 已确认放弃` });
    }
  }
  return changes;
}

async function readGiveUpState(client, protocol, config, player, grid, options = {}, ownLockId = null) {
  const { getSettings, enabled = () => true, ledger } = options;
  const settings = getSettings?.() ?? {}, who = identity(player), baseline = ledger?.keyRecords() ?? {};
  const worldId = exactAutomationId(player?.worldId), playerId = exactAutomationId(player?.playerId);
  const check = () => {
    if (!enabled() || client.connected === false || identity(player) !== who || getSettings && getSettings() !== settings) throw Error('账号或配置已变化，请重新读取资源田');
  };
  check();
  const result = { worldId, field: null, available: false, reason: '', automatic: settings.resourceFields?.enabled === true };
  if (!worldId || !playerId) return { ...result, reason: '角色身份未同步' };
  const get = async (stem, body = {}) => {
    if (!protocol?.[stem + 'Request'] || !protocol?.[stem + 'Response']) return null;
    try { const response = await client.request(stem + 'Request', body, stem + 'Response', 8000); check(); return response; }
    catch { check(); return null; }
  };
  const [mine, guilds, world] = await Promise.all([
    get('MyResFields'), get('AllGuildAbstraction'), get('WorldInfo', { screenCenter: { x: 0, y: 0 } }),
  ]);
  check();
  if (!fieldsValid(mine?.info?.fields)) return { ...result, reason: '本人资源田未同步，请刷新后重试' };
  settleResourceFieldGiveUps(ledger, { worldId, playerId, fields: mine.info.fields, now: time(client), baseline });
  const lock = ledger?.keyRecords()[lockKey(worldId, grid)];
  if (lock?.details?.replacementLock && integer(lock.details.leaseUntil) && lock.details.leaseUntil <= time(client)
    && lock.details.targetKey && !ledger.hasKey(lock.details.targetKey)) ledger.cancel({ id: lock.id });
  const own = mine.info.fields.find(field => field.gridIdx === grid);
  if (!own) return { ...result, reason: '此田已不在本人占领列表中' };
  const field = resourceFieldRows(config, player, { fields: [own] }, guilds?.guilds)[0];
  const guildId = exactAutomationId(player?.guildId), guildIdx = guildId ? Number(BigInt(guildId) % 1000n) : null;
  const city = world?.cities?.find(city => city.id === field.cityId);
  field.active = guildIdx && integer(city?.guildIdx) ? city.guildIdx === guildIdx : null;
  field.productionStatus = field.active === true ? '产出中' : field.active === false ? '城池失守，暂停产出' : '城池归属未同步';
  field.effectivePerHour = yieldOf(field);
  const currentLock = ledger?.keyRecords()[lockKey(worldId, grid)];
  const reason = currentLock && currentLock.id !== ownLockId ? '此田已有放弃或替换操作，等待结果' : '';
  return { ...result, field, available: !reason, reason };
}

function checkLoss(current, previous) {
  if (!current || !previous || current.grid !== previous.grid || current.cityId !== previous.cityId || current.type !== previous.type) throw Error('田地归属或类型已变化，请重新确认');
  const before = yieldOf(previous), after = yieldOf(current);
  if (previous.resourceId && current.resourceId !== previous.resourceId || before === null && after !== null
    || before !== null && (after === null || after > before)) throw Error('旧田产量或放弃损失已变化，请重新确认');
}

export async function previewResourceFieldGiveUp(client, protocol, config, player, intent, options) {
  if (!integer(intent?.gridIdx) || intent.gridIdx > 2147483647) throw Error('请选择有效的资源田');
  const state = await readGiveUpState(client, protocol, config, player, intent.gridIdx, options);
  return { kind: 'giveUp', gridIdx: intent.gridIdx, ...state, cost: 0, operationId: randomUUID(), identityKey: identity(player) };
}

export async function runResourceFieldGiveUp(client, protocol, config, player, preview, options) {
  if (options.automatic) throw Error('自动占田只在替换时放弃旧田');
  const { getSettings, enabled = () => true, ledger, report = () => {} } = options;
  if (!ledger || preview?.kind !== 'giveUp' || !preview.available || !preview.field || !integer(preview.gridIdx)
    || preview.field.grid !== preview.gridIdx || preview.worldId !== exactAutomationId(player.worldId)
    || preview.identityKey !== identity(player)
    || !/^[a-f0-9-]{36}$/.test(preview.operationId ?? '')) throw Error('放弃确认已失效，请重新选择资源田');
  const settings = getSettings?.() ?? {}, who = identity(player);
  const allowed = () => enabled() && client.connected !== false && who === identity(player) && (!getSettings || getSettings() === settings);
  const key = operationKey(preview.worldId, preview.gridIdx, preview.operationId);
  const resultFor = confirmed => ({ ok: confirmed, status: confirmed ? 'confirmed' : 'unknown', kind: 'giveUp', gridIdx: preview.gridIdx,
    released: confirmed, reason: confirmed ? `资源田 ${preview.gridIdx} 已确认放弃` : '资源田放弃结果待确认，已保留记录，不会重复发送' });
  const fresh = await readGiveUpState(client, protocol, config, player, preview.gridIdx, options);
  const prior = ledger.keyRecords()[key];
  if (prior) return resultFor(prior.confirmed);
  if (!fresh.available) throw Error(fresh.reason);
  checkLoss(fresh.field, preview.field);
  if (!allowed()) throw Error('账号或配置已变化，放弃未发送');
  if (!protocol?.GiveUpResFieldRequest) throw Error('当前协议缺少资源田放弃请求');
  const oldKey = lockKey(preview.worldId, preview.gridIdx), leaseUntil = time(client) + 120;
  const lock = ledger.reserve({}, {}, {}, { uniqueKey: oldKey, details: { replacementLock: true,
    operation: 'giveUp', worldId: preview.worldId, targetKey: key, leaseUntil } });
  let ticket;
  try {
    ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details: { kind: 'resourceFieldGiveUp', worldId: preview.worldId,
      playerId: exactAutomationId(player.playerId), gridIdx: preview.gridIdx, field: fresh.field, active: true,
      phase: 'prepared', leaseUntil, lock: { key: oldKey, id: lock.id } } });
  } catch (error) { ledger.cancel(lock); throw error; }
  const assertHeld = () => {
    const record = ledger.keyRecords()[key];
    if (!allowed() || record?.id !== ticket.id || record.details.leaseUntil <= time(client)
      || ledger.keyRecords()[oldKey]?.id !== lock.id) throw Error('放弃占用或账号已变化，操作未发送');
    return record;
  };
  let attempted = false, result;
  try {
    const again = await readGiveUpState(client, protocol, config, player, preview.gridIdx, options, lock.id);
    if (!again.available) throw Error(again.reason);
    checkLoss(again.field, preview.field);
    const record = assertHeld(); ledger.updateKeyDetails(key, { ...record.details, phase: 'givingUp', sentAt: time(client) });
    assertHeld(); attempted = true;
    await client.sendWatch('GiveUpResFieldRequest', { resFieldGridIdx: preview.gridIdx }, { window: 500 });
    if (!allowed()) throw Error('放弃发送后账号或配置已变化');
    await readGiveUpState(client, protocol, config, player, preview.gridIdx, options, lock.id);
    result = resultFor(ledger.keyRecords()[key]?.confirmed === true);
  } catch (error) {
    const confirmed = ledger.keyRecords()[key]?.confirmed === true;
    const rejected = error.prompt && error.request === 'GiveUpResFieldRequest';
    const notSent = !attempted || error.notSent && error.request === 'GiveUpResFieldRequest';
    if (confirmed) result = resultFor(true);
    else {
      if (rejected || notSent) { ledger.cancel(ticket); ledger.cancel(lock); }
      result = { ok: false, status: rejected ? 'rejected' : notSent ? 'cancelled' : 'unknown', kind: 'giveUp', gridIdx: preview.gridIdx,
        released: false, reason: rejected || notSent ? error.message : '资源田放弃结果待确认，不会重复发送：' + error.message };
    }
  }
  report({ ...result, label: `放弃资源田 ${preview.gridIdx}` }); return result;
}
