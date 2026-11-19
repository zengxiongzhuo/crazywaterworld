import crypto from 'node:crypto';
import path from 'node:path';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';

/** @typedef {Record<string, number>} Counters */
/** @typedef {{id: string, day: string}} LedgerTicket */
/** @typedef {{paidBefore: number, resetTime?: number, account: string | null}} PaidGoldBaseline */
/** @typedef {{expectedPaidTimes: number, account: string | null, resetTime?: number, rewardReceived: boolean}} PaidGoldReservation */
/** @typedef {{at: number, day?: string, counters: Counters, uniqueKey?: string, paidGold?: PaidGoldReservation}} Reservation */
/** @typedef {{id: string, confirmed: boolean, expired?: boolean, details?: Record<string, unknown>}} KeyRecord */
/** @typedef {{revision: number, owned: Record<string,string>, lost: Record<string,string>, settled?: Record<string,string>}} FieldHistory */
/** @typedef {{day: string, counters: Counters, pending: Record<string, Reservation>, confirmed: Counters, keys: Record<string, KeyRecord>, fieldHistory?: Record<string,FieldHistory>}} LedgerEntry */
/** @typedef {{version: number, accounts: Record<string, LedgerEntry>}} LedgerStore */
/**
 * @typedef {object} UsageLedger
 * @property {() => {day: string, counters: Counters, uncertain: number, pendingPaidGold?: true}} snapshot
 * @property {() => Counters} confirmedCounters
 * @property {(uniqueKey: string) => boolean} hasKey
 * @property {() => Record<string, KeyRecord>} keyRecords
 * @property {(scope: string) => FieldHistory} resourceFieldHistory
 * @property {(scope: string, history: FieldHistory) => boolean} saveResourceFieldHistory
 * @property {(uniqueKey: string) => number | null} reservationTime
 * @property {() => Counters} pendingCounters
 * @property {(uniqueKey: string, confirmed: boolean, details?: Record<string, unknown>) => void} resolveKey
 * @property {(counters: Counters, limits?: Counters, minimums?: Counters, options?: {uniqueKey?: string | null, details?: Record<string, unknown> | null, paidGold?: PaidGoldBaseline}) => LedgerTicket} reserve
 * @property {(ticket: LedgerTicket) => boolean} markPaidGoldReward
 * @property {(info: {paidTimes?: number, resetTime?: number} | null | undefined, account?: string | null) => boolean} reconcilePaidGold
 * @property {(uniqueKey: string, details: Record<string, unknown>) => void} updateKeyDetails
 * @property {(uniqueKey: string) => void} releaseCompletedKey
 * @property {(records: Record<string, KeyRecord>) => {released: number, archived: string[]}} archiveManualForge
 * @property {(ticket: LedgerTicket | null | undefined) => void} confirm
 * @property {(ticket: {id: string, day?: string} | null | undefined) => void} cancel
 */

export const dataDirectory = () => process.env.CW_DATA_DIR ? path.resolve(process.env.CW_DATA_DIR) : path.resolve(import.meta.dirname, '../data');
export const usageFile = () => path.join(dataDirectory(), 'automation-usage.json');
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
/** @template T @param {T} value @returns {T} */
const copy = value => structuredClone(value);
/** @param {string} accountId */
export function accountKey(accountId) {
  if (typeof accountId !== 'string' || !accountId || accountId.length > 200 || ['__proto__', 'prototype', 'constructor'].includes(accountId)) throw new Error('账号标识不合法');
  return accountId;
}

export function beijingDay(now = Date.now()) { return new Date(now + 8 * 3600_000).toISOString().slice(0, 10); }

/** @param {LedgerEntry} entry */
function hasPendingPaidGold(entry) {
  return Object.values(entry.pending).some(row => (row.day ?? entry.day) === entry.day && row.counters.goldPaidTimes > 0);
}

/** @param {LedgerEntry} entry @param {string} id @param {string} day */
function confirmReservation(entry, id, day) {
  const pending = entry.pending[id];
  if ((pending.day ?? day) === entry.day) for (const [name, amount] of Object.entries(pending.counters)) {
    entry.confirmed[name] = Number(entry.confirmed[name] ?? 0) + amount;
  }
  if (pending.uniqueKey && entry.keys[pending.uniqueKey]?.id === id) entry.keys[pending.uniqueKey].confirmed = true;
  delete entry.pending[id];
}

// 用量在发送前占用；未收到确定结果时保留额度，避免网络超时或重启造成重复消费。
/**
 * @param {string} accountId
 * @param {{file?: string, now?: () => number}} [options]
 * @returns {UsageLedger}
 */
export function createUsageLedger(accountId, { file = usageFile(), now = Date.now } = {}) {
  const key = accountKey(accountId);
  const read = () => {
    /** @type {LedgerStore} */
    const store = readJson(file, { version: 1, accounts: {} });
    if (store.version !== 1 || !plain(store.accounts)) throw new Error('额度账本格式异常，已停止消费动作');
    const day = beijingDay(now());
    let entry = Object.hasOwn(store.accounts, key) ? store.accounts[key] : null;
    if (entry && (!plain(entry.counters) || !plain(entry.pending) || !plain(entry.confirmed))) throw new Error('额度账本损坏，已停止消费动作');
    if (entry?.keys != null && !plain(entry.keys)) throw new Error('派遣记录损坏，已停止消费动作');
    if (!entry || entry.day !== day) {
      // 每日统计换日，未决派遣不换日；保留汽油占用与待确认状态，且不计入新一天的出征次数。
      /** @type {Record<string, Reservation>} */
      const pending = {};
      for (const [id, reservation] of Object.entries(entry?.pending ?? {})) {
        if (reservation.uniqueKey) pending[id] = { ...reservation, day: reservation.day ?? entry?.day ?? day };
      }
      entry = { day, counters: {}, pending, confirmed: {}, keys: entry?.keys ?? {}, fieldHistory: entry?.fieldHistory };
    }
    if (!plain(entry.counters) || !plain(entry.pending) || !plain(entry.confirmed) || (entry.keys != null && !plain(entry.keys))) throw new Error('额度账本损坏，已停止消费动作');
    entry.keys ??= {};
    Object.defineProperty(store.accounts, key, { value: entry, enumerable: true, writable: true, configurable: true });
    return { store, entry };
  };
  return {
    snapshot() {
      const { entry } = read();
      return { day: entry.day, counters: { ...entry.counters }, uncertain: Object.keys(entry.pending).length,
        ...(hasPendingPaidGold(entry) ? { pendingPaidGold: /** @type {const} */ (true) } : {}) };
    },
    confirmedCounters() { return { ...read().entry.confirmed }; },
    hasKey(uniqueKey) { return Object.hasOwn(read().entry.keys, uniqueKey); },
    keyRecords() { return copy(read().entry.keys); },
    resourceFieldHistory(scope) {
      return copy(read().entry.fieldHistory?.[scope] ?? { revision: 0, owned: {}, lost: {} });
    },
    saveResourceFieldHistory(scope, history) {
      if (!/^\d+:\d+$/.test(scope)) throw Error('资源田记录缺少区服或角色身份');
      return withFileLock(file, () => {
        const { store, entry } = read();
        if ((entry.fieldHistory?.[scope]?.revision ?? 0) !== history.revision) return false;
        entry.fieldHistory ??= {};
        entry.fieldHistory[scope] = { ...copy(history), revision: history.revision + 1 };
        atomicJson(file, store);
        return true;
      });
    },
    reservationTime(uniqueKey) {
      const { entry } = read();
      return entry.pending[entry.keys[uniqueKey]?.id]?.at ?? null;
    },
    pendingCounters() {
      /** @type {Counters} */
      const totals = {};
      for (const reservation of Object.values(read().entry.pending)) for (const [name, amount] of Object.entries(reservation.counters)) totals[name] = (totals[name] ?? 0) + amount;
      return totals;
    },
    resolveKey(uniqueKey, confirmed, details) {
      return withFileLock(file, () => {
        const { store, entry } = read();
        if (!Object.hasOwn(entry.keys, uniqueKey)) return;
        const record = entry.keys[uniqueKey];
        if (details !== undefined) {
          if (!plain(details)) throw new Error('任务记录内容不合法');
          record.details = copy(details);
        }
        if (confirmed) {
          const pending = entry.pending[record.id];
          if (pending) {
            if ((pending.day ?? entry.day) === entry.day) for (const [name, amount] of Object.entries(pending.counters)) entry.confirmed[name] = Number(entry.confirmed[name] ?? 0) + amount;
            delete entry.pending[record.id];
          }
          record.confirmed = true;
        } else record.expired = true;
        atomicJson(file, store);
      });
    },
    reserve(counters, limits = {}, minimums = {}, { uniqueKey = null, details = null, paidGold } = {}) {
      return withFileLock(file, () => {
        const { store, entry } = read();
        if (uniqueKey !== null) {
          if (typeof uniqueKey !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(uniqueKey) || ['__proto__', 'constructor', 'prototype'].includes(uniqueKey)) throw new Error('派遣记录标识不合法');
          if (Object.hasOwn(entry.keys, uniqueKey)) throw new Error('该目标已有派遣记录，已阻止重复发送');
        }
        if (details !== null && (!uniqueKey || !plain(details))) throw new Error('任务记录内容不合法');
        if (counters.goldPaidTimes > 0 && hasPendingPaidGold(entry)) throw new Error('上一笔付费点金待确认，等待下轮检查');
        /** @type {PaidGoldReservation | undefined} */
        let goldReservation;
        if (paidGold) {
          const { paidBefore, resetTime, account } = paidGold;
          const expectedPaidTimes = paidBefore + counters.goldPaidTimes;
          if (uniqueKey || !Number.isSafeInteger(paidBefore) || paidBefore < 0 || paidBefore !== minimums.goldPaidTimes ||
              !Number.isSafeInteger(counters.goldPaidTimes) || counters.goldPaidTimes <= 0 || !Number.isSafeInteger(expectedPaidTimes) ||
              (resetTime !== undefined && (!Number.isSafeInteger(resetTime) || resetTime < 0)) ||
              (account !== null && (typeof account !== 'string' || !account.length))) throw new Error('付费点金次数或账号基准不合法');
          if ((entry.counters.goldPaidTimes ?? 0) > paidBefore) throw new Error('付费点金次数已变化，等待按最新次数重新规划');
          goldReservation = { expectedPaidTimes, account, ...(resetTime !== undefined ? { resetTime } : {}), rewardReceived: false };
        }
        for (const [name, amount] of Object.entries(counters)) {
          if (!/^[A-Za-z][A-Za-z0-9_]{0,50}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name) || !Number.isSafeInteger(amount) || amount < 0) throw new Error('消费计数不合法');
          const used = Math.max(Number(entry.counters[name] ?? 0), Number(minimums[name] ?? 0));
          if (!Number.isSafeInteger(used) || used < 0) throw new Error('历史消费计数不合法，已停止消费动作');
          if (limits[name] != null && used + amount > limits[name]) throw new Error(`达到今日上限：${({ diamonds: '钻石', residentOrders: '居民订单', cargoLoads: '贸易港装货', museumGuides: '探险指南', goldPaidTimes: '付费点金次数', treasureDispatches: '巨轮出征次数' })[name] ?? name}`);
        }
        const id = crypto.randomUUID();
        for (const [name, amount] of Object.entries(counters)) entry.counters[name] = Math.max(Number(entry.counters[name] ?? 0), Number(minimums[name] ?? 0)) + amount;
        entry.pending[id] = { at: now(), day: entry.day, counters: copy(counters), ...(uniqueKey ? { uniqueKey } : {}),
          ...(goldReservation ? { paidGold: goldReservation } : {}) };
        if (uniqueKey) entry.keys[uniqueKey] = { id, confirmed: false, ...(details ? { details: copy(details) } : {}) };
        atomicJson(file, store);
        return { id, day: entry.day };
      });
    },
    markPaidGoldReward(ticket) {
      return withFileLock(file, () => {
        const { store, entry } = read();
        const pending = entry.pending[ticket.id]?.paidGold;
        if (!pending || ticket.day !== entry.day) return false;
        if (!pending.rewardReceived) {
          pending.rewardReceived = true;
          atomicJson(file, store);
        }
        return true;
      });
    },
    reconcilePaidGold(info, account = null) {
      const paidTimes = info?.paidTimes;
      if (paidTimes === undefined || !Number.isSafeInteger(paidTimes) || paidTimes < 1) return false;
      return withFileLock(file, () => {
        const { store, entry } = read();
        for (const [id, reservation] of Object.entries(entry.pending)) {
          const gold = reservation.paidGold;
          if (reservation.day !== entry.day || gold?.rewardReceived !== true || gold.account !== account ||
              (gold.resetTime !== undefined && gold.resetTime !== info?.resetTime) ||
              !Number.isSafeInteger(gold.expectedPaidTimes) || gold.expectedPaidTimes < 1 || paidTimes < gold.expectedPaidTimes) continue;
          confirmReservation(entry, id, entry.day);
          atomicJson(file, store);
          return true;
        }
        return false;
      });
    },
    updateKeyDetails(uniqueKey, details) {
      return withFileLock(file, () => {
        if (!plain(details)) throw new Error('任务记录内容不合法');
        const { store, entry } = read();
        if (!Object.hasOwn(entry.keys, uniqueKey)) throw new Error('任务记录已不存在');
        entry.keys[uniqueKey].details = copy(details);
        atomicJson(file, store);
      });
    },
    releaseCompletedKey(uniqueKey) {
      return withFileLock(file, () => {
        const { store, entry } = read();
        const record = Object.hasOwn(entry.keys, uniqueKey) ? entry.keys[uniqueKey] : null;
        if (!record) return;
        if (!record.confirmed || Object.hasOwn(entry.pending, record.id)) throw new Error('待确认任务不可释放');
        delete entry.keys[uniqueKey];
        atomicJson(file, store);
      });
    },
    archiveManualForge(records) {
      return withFileLock(file, () => {
        if (!plain(records)) throw new Error('锻造交接记录不合法');
        const { store, entry } = read();
        const archived = [];
        let released = 0;
        for (const [uniqueKey, expected] of Object.entries(records)) {
          if (!/^forge(?:Claim)?:\d+:[1-9]\d*(?::[1-9]\d*)?$/.test(uniqueKey) || !plain(expected)
            || JSON.stringify(entry.keys[uniqueKey]) !== JSON.stringify(expected)) {
            throw new Error('同步期间锻造记录已变化，请重新同步');
          }
          const record = entry.keys[uniqueKey];
          const reservation = entry.pending[record.id];
          if (record.confirmed ? Boolean(reservation) : !reservation || reservation.uniqueKey !== uniqueKey) {
            throw new Error('锻造记录与用量预留不一致，保留原记录');
          }
          if (!record.confirmed && Object.hasOwn(entry.keys, 'forgeHistory:' + record.id)) {
            throw new Error('锻造历史记录已存在，请重新同步');
          }
        }
        // A manual handoff establishes a fresh inventory baseline. Preserve
        // unknown expenditure without keeping its old factory lock active.
        for (const uniqueKey of Object.keys(records)) {
          const record = entry.keys[uniqueKey];
          if (record.confirmed) released++;
          else {
            const archiveKey = 'forgeHistory:' + record.id;
            entry.keys[archiveKey] = { ...record, details: { ...record.details,
              archivedFrom: uniqueKey, disposition: 'manual-handoff-sync', archivedAt: now() } };
            entry.pending[record.id].uniqueKey = archiveKey;
            archived.push(archiveKey);
          }
          delete entry.keys[uniqueKey];
        }
        if (released || archived.length) atomicJson(file, store);
        return { released, archived };
      });
    },
    confirm(ticket) {
      if (!ticket) return;
      return withFileLock(file, () => {
        const { store, entry } = read();
        if (entry.keys['forgeHistory:' + ticket.id]?.details?.disposition === 'manual-handoff-sync') return;
        if (!Object.hasOwn(entry.pending, ticket.id)) {
          const record = Object.values(entry.keys).find(value => value.id === ticket.id);
          if (record) { record.confirmed = true; atomicJson(file, store); }
          return;
        }
        confirmReservation(entry, ticket.id, ticket.day);
        atomicJson(file, store);
      });
    },
    cancel(ticket) {
      if (!ticket) return;
      return withFileLock(file, () => {
        const { store, entry } = read();
        if (entry.keys['forgeHistory:' + ticket.id]?.details?.disposition === 'manual-handoff-sync') return;
        if (!Object.hasOwn(entry.pending, ticket.id)) {
          const uniqueKey = Object.keys(entry.keys).find(value => entry.keys[value].id === ticket.id);
          // A delayed rejection cannot undo a confirmation committed elsewhere.
          // Confirmed keys are released explicitly through releaseCompletedKey.
          if (uniqueKey && !entry.keys[uniqueKey].confirmed) { delete entry.keys[uniqueKey]; atomicJson(file, store); }
          return;
        }
        if ((entry.pending[ticket.id].day ?? ticket.day) === entry.day) for (const [name, amount] of Object.entries(entry.pending[ticket.id].counters)) entry.counters[name] = Math.max(0, Number(entry.counters[name] ?? 0) - amount);
        const uniqueKey = entry.pending[ticket.id].uniqueKey;
        if (uniqueKey && entry.keys[uniqueKey]?.id === ticket.id) delete entry.keys[uniqueKey];
        delete entry.pending[ticket.id];
        atomicJson(file, store);
      });
    },
  };
}
