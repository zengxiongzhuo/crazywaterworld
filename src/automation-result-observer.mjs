import { randomUUID } from 'node:crypto';
import { RESOURCE } from './config.mjs';
import { toNumber } from './client.mjs';
import { ACTIONS } from './actions.mjs';
import { classifyLog, LOG_CATEGORIES } from './log-categories.mjs';

const labels = {
  GainFactoryProduceRequest: '收获工厂成品', CollectBuildingProductRequest: '收获建筑产出', FinishWorkerOrderRequest: '提交居民订单',
  StartFactoryProduceRequest: '工厂排产', StartFishingRequest: '钓鱼', GainBigFishRequest: '收获大鱼', PickUpFloaterRequest: '拾取漂浮物',
  QuickGotReadEmailRequest: '领取邮件附件', DrawAfkRewardRequest: '领取挂机收益', DrawAfkLevelRewardRequest: '领取挂机等级奖励',
  DrawDailyTaskRewardRequest: '领取日常任务奖励', DrawTaskRewardRequest: '领取任务奖励', PlantCropRequest: '农田播种',
};
const catalog = new Map(Object.values(ACTIONS).filter(action => action.mutate).map(action => [action.request, action.desc]));
export function resultWrite(name) {
  return catalog.has(name) || !/Info|List|Status|Query|Detail|Record|Options|Config/.test(name) && /^(?:Draw|Got|Gain|Collect|PickUp|Finish|Start|Upgrade|Enhance|Recruit|Challenge|Sweep|Plant|Harvest|Sow|Submit|Buy|Sell|Use|Select|Open|QuickGot|PirateSweep|RadarGetReward|GuildAidHelp|TradeBuy|TradeSell|Week.*(?:Got|Draw|Submit|Buy))/.test(name);
}
export function resultLabel(name) { return labels[name] || catalog.get(name) || (LOG_CATEGORIES[classifyLog('', { request: name })] ?? '挂机') + '操作'; }
const keyOf = id => String(RESOURCE[id] ?? id);
function add(out, id, number) {
  const amount = toNumber(number), key = keyOf(id);
  if (!id || ['__proto__', 'constructor', 'prototype'].includes(key) || !Number.isSafeInteger(amount) || amount <= 0) return;
  out[key] = (out[key] ?? 0) + amount;
}
export function receivedAssets(reply) {
  const out = {};
  // These are delivered packages in write replies. No configuration rewards,
  // preview values, costs or full inventory snapshots are interpreted as gains.
  for (const field of ['reward', 'rewards', 'extReward', 'products']) {
    const value = reply?.[field];
    for (const pack of Array.isArray(value) ? value : [value]) {
      for (const asset of pack?.asset ?? pack?.product?.asset ?? []) add(out, asset.id, asset.num);
      if (pack?.itemId) add(out, pack.itemId, pack.num);
      if (pack?.res) add(out, pack.res, pack.amount);
    }
  }
  for (const hero of reply?.hero ?? []) if (hero.heroId && !out[hero.heroId]) add(out, (hero.frag ? 'hero-fragment:' : 'hero:') + hero.heroId, 1);
  for (const antique of reply?.antique ?? []) if (antique.antiqueId && !out[antique.antiqueId]) add(out, (antique.frag ? 'antique-fragment:' : 'antique:') + antique.antiqueId, 1);
  if (reply?.equipIds?.length) add(out, 'result:equipment', new Set(reply.equipIds).size);
  for (const badge of reply?.badge ?? []) if (badge.badgeId) add(out, 'badge:' + badge.badgeId, 1);
  return out;
}

// Asset pushes contain absolute quantities. Each update is compared to the last
// confirmed value, so a gain followed by a spend retains both gross quantities.
// Matching reply/push credits prevents recording the same delivery twice.
export function observeAutomationResults(client, { context, record, operation = () => {}, onError = () => {}, now = Date.now }) {
  const connectionId = randomUUID();
  const stock = new Map(), credits = new Map(), seen = new Set();
  const types = new Map();
  let itemBaseline = false, resourceBaseline = false;
  let source = '服务器资产更新', latestRequest = '';
  function safe(work) { try { return work(); } catch (error) { onError(error); } }
  function matched(id, amount, channel, runId) {
    const key = runId + ':' + id, other = channel === 'push' ? 'reply' : 'push';
    const rows = (credits.get(key) ?? []).filter(row => now() - row.at < 5000);
    let rest = amount;
    for (const row of rows) if (row.channel === other && rest) { const used = Math.min(row.amount, rest); row.amount -= used; rest -= used; }
    const remaining = rows.filter(row => row.amount > 0);
    if (rest) remaining.push({ amount: rest, channel, at: now() });
    credits.set(key, remaining);
    return rest;
  }
  function post(current, id, label, gains, costs, channel) {
    if (!current) return;
    const netGains = {};
    for (const [key, amount] of Object.entries(gains)) { const quantity = matched(key, amount, channel, current.runId); if (quantity) netGains[key] = quantity; }
    if (Object.keys(netGains).length || Object.keys(costs).length) record(current.runId, current.roleId, { id, kind: 'assets', label, category: LOG_CATEGORIES[classifyLog(label, { request: latestRequest })], gains: netGains, costs });
  }
  function snapshot(rows, resource, changed, event) {
    if (!Array.isArray(rows)) return;
    if (!changed) {
      const present = new Set(rows.map(row => resource ? keyOf(row.res) : String(row.itemId ?? '')));
      for (const [id, type] of types) if (type === resource && !present.has(id)) { stock.delete(id); types.delete(id); }
      if (resource) resourceBaseline = true; else itemBaseline = true;
    }
    const gains = {}, costs = {};
    for (const row of rows ?? []) {
      const id = resource ? keyOf(row.res) : String(row.itemId ?? ''), amount = toNumber(resource ? row.amount : row.num);
      if (!id || !Number.isSafeInteger(amount) || amount < 0) continue;
      const before = stock.get(id) ?? ((resource ? resourceBaseline : itemBaseline) ? 0 : null); stock.set(id, amount); types.set(id, resource);
      if (changed && before != null) {
        if (amount > before) add(gains, id, amount - before);
        if (amount < before) add(costs, id, before - amount);
      }
    }
    if (changed) post(context(), 'push:' + connectionId + ':' + event, source, gains, costs, 'push');
  }
  const message = ({ name, body, seq } = {}) => safe(() => {
    if (seq != null) { const key = name + ':' + seq; if (seen.has(key)) return; seen.add(key); if (seen.size > 4000) seen.delete(seen.values().next().value); }
    if (name === 'AllItemResponse' || name === 'SCUpdateItem') snapshot(body?.items, false, name === 'SCUpdateItem', seq ?? randomUUID());
    if (name === 'AllResourceResponse' || name === 'SCUpdateResource') snapshot(body?.list, true, name === 'SCUpdateResource', seq ?? randomUUID());
  });
  client.on?.('message', message);
  client.on?.('frame', ({ dir, name } = {}) => { if (dir === 'out' && resultWrite(name || '')) { latestRequest = name; source = resultLabel(name); } });
  client.on?.('diagnostic', data => safe(() => { const current = context(); if (current && data.event === 'operation') operation(current.runId, current.roleId, { ...data, label: data.label || resultLabel(data.request) }); }));
  const request = client.request;
  client.request = async function(name, body, ...args) {
    if (this.heldByRead?.()) return this.readGate.then(() => this.request(name, body, ...args));
    const current = context(), id = randomUUID(), write = resultWrite(name);
    if (write) { latestRequest = name; source = resultLabel(name); }
    const reply = await request.call(this, name, body, ...args);
    safe(() => {
      if (name === 'AllItemRequest') snapshot(reply?.items, false, false);
      if (name === 'AllResourceRequest') snapshot(reply?.list, true, false);
      if (write && !(Number(reply?.result) > 0)) post(current, 'reply:' + id, resultLabel(name), receivedAssets(reply), {}, 'reply');
    });
    return reply;
  };
  return { seed: message };
}
