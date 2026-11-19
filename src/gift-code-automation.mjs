import { giftDay } from './gift-code-library.mjs';
import { giftCodeStatus, startGiftCodes } from './gift-codes.mjs';

export function createGiftCodeAutomation({ library, accounts, targetFor, refresh = true, report = () => {}, now = Date.now }) {
  let closed = false, checking = false, timer;
  async function check() {
    if (closed || checking) return;
    checking = true;
    try {
      if (refresh && library.due()) {
        try { await library.refresh(); } catch (error) { report('公共礼包码同步失败：' + error.message); }
      }
      if (closed) return;
      library.pruneExpired();
      const shared = { stop: '' }, all = accounts(), invalid = new Set();
      for (const account of all) {
        try { library.reconcile(giftCodeStatus(account.id).rows); }
        catch (error) { invalid.add(account.id); report('账号礼包历史读取失败：' + error.message); }
      }
      for (const account of all) {
        if (closed || invalid.has(account.id)) continue;
        const preference = library.auto(account.id);
        if (!preference.enabled) continue;
        const state = giftCodeStatus(account.id);
        if (state.running) continue;
        const codes = library.available(state.rows, account.id);
        const key = giftDay(now()) + ':' + library.accountRevision(account.id);
        if (!codes.length || preference.lastRunKey === key || now() - (preference.lastAttemptAt ?? 0) < 300000) continue;
        const target = targetFor(account);
        if (target.blocked) continue;
        library.attempt(account.id, key);
        const job = startGiftCodes(account.id, codes.join('\n'), target.dispatch, shared, {
          automatic: true,
          shouldContinue: () => !closed && library.auto(account.id).enabled && accounts().some(latest => latest.id === account.id),
        });
        job.done.then(() => {
          const batch = job.rows.filter(row => row.batch === job.rows[0]?.batch);
          if (batch.some(row => row.status === 'skipped' || row.promptName === 'GIFT_CODE_TOO_MANY_REQUESTS' || row.detail === '请求过于频繁')) {
            // A removed account must not be recreated by a late job completion.
            if (accounts().some(latest => latest.id === account.id)) library.retry(account.id, key);
          }
        }).catch(error => report('自动兑换记录保存失败：' + error.message));
      }
    } catch (error) { report('自动兑换检查失败：' + error.message); }
    finally { checking = false; }
  }
  return {
    check,
    start() { if (closed || timer) return; timer = setInterval(() => { void check(); }, 60000); timer.unref(); void check(); },
    close() { closed = true; clearInterval(timer); },
  };
}
