import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './accounts.mjs';
import { initialGiftCodeCatalog } from './gift-code-catalog.mjs';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';

const codePattern = /^[\p{L}\p{N}_-]{1,128}$/u;
export const GIFT_CODE_SOURCE = 'https://m.ali213.net/news/gl2602/1747967.html';
export const giftDay = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const expiredDate = (date, now) => Boolean(date) && Date.parse(date + 'T23:59:59.999+08:00') < now;
export const hasGiftCodeHistory = row => row.status === 'skipped' ? String(row.detail ?? '').includes('已有兑换记录')
  : row.status === 'rejected' ? row.promptName !== 'GIFT_CODE_TOO_MANY_REQUESTS' && row.detail !== '请求过于频繁'
    : ['success', 'used', 'unknown', 'sending', 'queued'].includes(row.status);

function normalizeExpiry(value, now) {
  if (value === undefined || value === null || value === '') return null;
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value + 'T00:00:00Z') : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value || expiredDate(value, now)) {
    throw new Error('到期日期无效或已经过期');
  }
  return value;
}

export function parseGiftCodeArticle(html) {
  const text = String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<(?:br\b[^>]*|\/p|\/div|\/li|\/h[1-6])>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) => {
      const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, name) => ({ nbsp:' ', amp:'&', quot:'"', apos:"'", lt:'<', gt:'>' })[name.toLowerCase()]);
  if (!text.includes('疯狂水世界')) throw Error('来源页面不是疯狂水世界礼包码文章');
  const start = /一[、.．]\s*兑换码/.exec(text), end = /二[、.．]\s*使用方式/.exec(text);
  if (!start || !end || end.index <= start.index) throw Error('来源页面格式已变化，保留原有码库');
  const rows = new Map();
  for (const line of text.slice(start.index + start[0].length, end.index).split(/\r?\n/)) {
    const value = line.trim();
    if (!value || /兑换码[：:]?$/.test(value)) continue;
    const match = /^([\p{L}\p{N}_-]{1,128})(?:[（(]有效期至\s*(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[）)])?$/u.exec(value);
    if (!match) throw Error('来源页面含无法识别的礼包码条目，保留原有码库');
    const expiresAt = match[2] ? `${match[2]}-${match[3].padStart(2, '0')}-${match[4].padStart(2, '0')}` : null;
    const stamp = expiresAt ? Date.parse(expiresAt + 'T00:00:00Z') : 0;
    if (expiresAt && (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== expiresAt)) throw Error('来源页面有效期格式异常');
    rows.set(match[1], { code: match[1], expiresAt });
  }
  if (!rows.size) throw Error('来源页面没有解析到礼包码，保留原有码库');
  const updated = /更新时间[：:]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(text);
  const timestamp = updated ? Date.parse(updated[1] + 'T' + updated[2] + '+08:00') : NaN;
  return { rows: [...rows.values()], sourceUpdatedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null };
}

// The bundled catalog remains available offline. Manual entries and explicit
// server-expiry tombstones share one transaction so a rejected batch saves none.
export function createGiftCodeLibrary({ directory = DATA_DIR, now = Date.now, catalog = initialGiftCodeCatalog, fetcher = fetch } = {}) {
  const file = path.join(directory, 'shared-gift-codes.json');
  const catalogFile = path.join(directory, 'public-gift-codes.json');
  const preferenceFile = path.join(directory, 'gift-code-preferences.json');
  let fetching = null;
  const read = () => {
    const data = readJson(file, { version: 1, codes: [], expired: [] });
    if (data?.version !== 1 || !Array.isArray(data.codes) || !Array.isArray(data.expired ?? [])) throw Error('共享礼包码数据库无效');
    if (data.codes.some(row => !row || typeof row.code !== 'string' || !codePattern.test(row.code)
      || row.expiresAt != null && (typeof row.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.expiresAt)))) {
      throw Error('共享礼包码数据库无效');
    }
    if ((data.expired ?? []).some(row => !row || typeof row.code !== 'string')) throw Error('共享礼包码下架记录无效');
    return { ...data, expired: data.expired ?? [] };
  };
  const readPublic = () => {
    const data = readJson(catalogFile, { version: 1, codes: [], expired: [] });
    if (data?.version !== 1 || !Array.isArray(data.codes) || !Array.isArray(data.expired)
      || [...data.codes, ...data.expired].some(row => !row || typeof row.code !== 'string')) throw Error('公共礼包码数据库无效');
    return data;
  };
  const preferences = () => {
    const data = readJson(preferenceFile, { version: 1, accounts: [] });
    if (data?.version !== 1 || !Array.isArray(data.accounts)
      || data.accounts.some(account => !account || typeof account.id !== 'string' || typeof account.enabled !== 'boolean')) throw Error('自动兑换设置无效');
    return data;
  };
  const changePreference = (id, work) => withFileLock(preferenceFile, () => {
    const data = preferences();
    let account = data.accounts.find(entry => entry.id === id);
    if (!account) { account = { id, enabled: false }; data.accounts.push(account); }
    work(account); atomicJson(preferenceFile, data); return { ...account };
  });
  const currentSource = () => {
    const data = readPublic();
    return { ...(data.lastSuccessAt ? { source: GIFT_CODE_SOURCE, updatedAt: data.sourceUpdatedAt, codes: data.codes } : catalog(now())),
      retired: data.expired, sourceKind: data.lastSuccessAt ? 'synced' : 'bundled',
      lastSyncedAt: data.lastSuccessAt ?? null, lastError: data.lastError ?? '' };
  };
  const merge = (state, source) => {
    const rows = new Map();
    for (const row of source.codes) if (!rows.has(row.code)) rows.set(row.code, { ...row, manual: false });
    for (const row of state.codes) {
      const original = rows.get(row.code);
      rows.set(row.code, original ? { ...original, ...row, manual: true,
        expiresAt: original.expiresAt && (!row.expiresAt || original.expiresAt < row.expiresAt) ? original.expiresAt : row.expiresAt }
        : { ...row, manual: true });
    }
    const expired = new Set([...state.expired, ...(source.retired ?? [])].map(row => row.code));
    return [...rows.values()].map(row => ({ ...row, expired: expired.has(row.code) || expiredDate(row.expiresAt, now()) }));
  };
  const library = {
    entries() { return merge(read(), currentSource()).filter(row => !row.expired); },
    available(rows) {
      const handled = new Set(rows.filter(hasGiftCodeHistory).map(row => row.code));
      return library.entries().filter(row => !handled.has(row.code)).map(row => row.code);
    },
    view() {
      const source = currentSource(), state = read(), merged = merge(state, source), usable = merged.filter(row => !row.expired);
      const byCode = new Map(merged.map(row => [row.code, row])), publicCodes = new Set(source.codes.map(row => row.code));
      // Retain the original catalog rows (including duplicates/expired entries)
      // for API compatibility; entries() is the deduplicated usable library.
      const codes = [...source.codes.map(row => ({ ...row, ...byCode.get(row.code) })), ...merged.filter(row => !publicCodes.has(row.code))];
      const additionalExpired = new Set([...state.expired, ...source.retired].filter(row => !byCode.has(row.code)).map(row => row.code));
      return { source: source.source, sourceKind: source.sourceKind, updatedAt: source.updatedAt,
        lastSyncedAt: source.lastSyncedAt, lastError: source.lastError, dailyTime: '每天北京时间 08:00',
        total: codes.length, unique: merged.length, expired: codes.filter(row => row.expired).length + additionalExpired.size, codes, tryCodes: usable.map(row => row.code),
        batches: Array.from({ length: Math.ceil(usable.length / 100) }, (_, index) => usable.slice(index * 100, (index + 1) * 100).map(row => row.code)),
        revision: createHash('sha256').update(JSON.stringify(usable.map(row => [row.code, row.expiresAt]))).digest('hex') };
    },
    isExpired(code) {
      const state = read(), source = currentSource();
      if ([...state.expired, ...source.retired].some(row => row.code === code)) return true;
      return merge(state, source).some(row => row.code === code && row.expired);
    },
    expire(code, reason = '游戏服务器明确返回礼包码已过期') {
      withFileLock(file, () => {
        const state = read();
        if (state.expired.some(row => row.code === code)) return;
        state.expired.push({ code, reason, at: new Date(now()).toISOString() });
        atomicJson(file, state);
      });
    },
    reconcile(rows) {
      const codes = [...new Set(rows.filter(row => row.status === 'rejected'
        && (row.promptName === 'GIFT_CODE_EXPIRED' || row.detail === '礼包码已过期')).map(row => row.code))];
      if (!codes.length) return;
      withFileLock(file, () => {
        const state = read(), expired = new Set(state.expired.map(row => row.code));
        const additions = codes.filter(code => !expired.has(code));
        if (!additions.length) return;
        state.expired.push(...additions.map(code => ({ code, reason: '游戏服务器明确返回礼包码已过期', at: new Date(now()).toISOString() })));
        atomicJson(file, state);
      });
    },
    addManualBatch(input, expiry) {
      if (!Array.isArray(input) || !input.length || input.length > 500) throw Error('单次请提供 1 至 500 条礼包码');
      if (input.some(code => typeof code !== 'string' || code.trim().length > 128 || !codePattern.test(code.trim()))) {
        throw Error('礼包码需为1至128个汉字、字母、数字、下划线或短横线');
      }
      const codes = [...new Set(input.map(code => code.trim()))];
      const expiresAt = normalizeExpiry(expiry, now());
      return withFileLock(file, () => {
        const state = read(), source = currentSource();
        const expired = new Set([...state.expired, ...source.retired, ...source.codes.filter(row => expiredDate(row.expiresAt, now()))].map(row => row.code));
        if (codes.some(code => expired.has(code))) throw Error('批次包含已过期或全局下架的礼包码，未保存任何条目');
        const entries = new Map(state.codes.map(row => [row.code, row]));
        for (const code of codes) entries.set(code, { code, expiresAt, firstSeenAt: entries.get(code)?.firstSeenAt ?? new Date(now()).toISOString() });
        atomicJson(file, { ...state, codes: [...entries.values()] });
        return { saved: codes.length, codes: codes.length };
      });
    },
    pruneExpired() {
      if (!readPublic().codes.some(row => expiredDate(row.expiresAt, now()))) return;
      withFileLock(catalogFile, () => {
        const data = readPublic(), expired = new Set(data.expired.map(row => row.code));
        data.codes = data.codes.filter(row => {
          if (!expiredDate(row.expiresAt, now())) return true;
          if (!expired.has(row.code)) { data.expired.push({ code: row.code, reason: '来源注明的有效期已结束', at: new Date(now()).toISOString() }); expired.add(row.code); }
          return false;
        });
        atomicJson(catalogFile, data);
      });
    },
    auto(id) { return { enabled: false, ...preferences().accounts.find(entry => entry.id === id) }; },
    setAuto(id, enabled) {
      if (typeof enabled !== 'boolean') throw Error('自动兑换开关必须为布尔值');
      return changePreference(id, account => {
        if (account.enabled !== enabled) { account.lastRunKey = ''; account.lastAttemptAt = 0; }
        account.enabled = enabled;
      });
    },
    accountRevision() { return createHash('sha256').update(JSON.stringify(library.entries().map(row => [row.code, row.expiresAt]))).digest('hex'); },
    attempt(id, key) { return changePreference(id, account => { account.lastRunKey = key; account.lastAttemptAt = now(); }); },
    retry(id, key) { return changePreference(id, account => { if (account.lastRunKey === key) account.lastRunKey = ''; }); },
    removeAccount(id) {
      if (!preferences().accounts.some(account => account.id === id)) return;
      withFileLock(preferenceFile, () => { const data = preferences(); data.accounts = data.accounts.filter(account => account.id !== id); atomicJson(preferenceFile, data); });
    },
    due() {
      const data = readPublic(), time = now();
      return (!data.lastSuccessAt || giftDay(Date.parse(data.lastSuccessAt)) !== giftDay(time)) && new Date(time + 8 * 3600000).getUTCHours() >= 8;
    },
    async refresh({ force = false } = {}) {
      if (fetching) return fetching;
      const data = readPublic(), time = now();
      if (data.lastSuccessAt && giftDay(Date.parse(data.lastSuccessAt)) === giftDay(time)) return library.view();
      if (data.lastAttemptAt && time - data.lastAttemptAt < (force ? 60000 : 3600000) || data.leaseUntil > time) return library.view();
      const claimed = withFileLock(catalogFile, () => {
        const latest = readPublic();
        if (latest.leaseUntil > now() || latest.lastSuccessAt && giftDay(Date.parse(latest.lastSuccessAt)) === giftDay(now())) return false;
        latest.lastAttemptAt = now(); latest.leaseUntil = now() + 90000; atomicJson(catalogFile, latest); return true;
      });
      if (!claimed) return library.view();
      fetching = (async () => {
        try {
          const response = await fetcher(GIFT_CODE_SOURCE, { redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { 'user-agent': 'CrazyWaterWorld-GiftCatalog/1.0', accept: 'text/html' } });
          if (!response.ok) throw Error('来源站点返回 HTTP ' + response.status);
          const chunks = []; let size = 0;
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > 2 * 1024 * 1024) throw Error('来源页面超过大小限制');
            chunks.push(Buffer.from(chunk));
          }
          const parsed = parseGiftCodeArticle(Buffer.concat(chunks).toString('utf8'));
          withFileLock(catalogFile, () => {
            const latest = readPublic(), retired = new Set([...latest.expired, ...read().expired].map(row => row.code));
            const codes = new Map(latest.codes.map(row => [row.code, row]));
            for (const row of parsed.rows) {
              if (retired.has(row.code)) continue;
              if (expiredDate(row.expiresAt, now())) {
                codes.delete(row.code); latest.expired.push({ code: row.code, reason: '来源注明的有效期已结束', at: new Date(now()).toISOString() }); retired.add(row.code); continue;
              }
              codes.set(row.code, { ...row, firstSeenAt: codes.get(row.code)?.firstSeenAt ?? new Date(now()).toISOString(), lastSeenAt: new Date(now()).toISOString() });
            }
            Object.assign(latest, { codes: [...codes.values()], sourceUpdatedAt: parsed.sourceUpdatedAt,
              lastSuccessAt: new Date(now()).toISOString(), lastError: '', leaseUntil: 0 });
            atomicJson(catalogFile, latest);
          });
        } catch (error) {
          withFileLock(catalogFile, () => { const latest = readPublic(); latest.lastError = error.message; latest.leaseUntil = 0; atomicJson(catalogFile, latest); });
          throw error;
        }
        return library.view();
      })().finally(() => { fetching = null; });
      return fetching;
    },
  };
  return library;
}

export const publicGiftCodes = createGiftCodeLibrary();
