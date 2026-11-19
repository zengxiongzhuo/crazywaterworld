// In-process transport for the WeChat/YYB QR handshake. No cookies are persisted.
const HOSTS = new Set(['open.weixin.qq.com', 'long.open.weixin.qq.com', 'yybadaccess.3g.qq.com']);
const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const cookieValue = /^[\x21-\x7e]*$/;
const group = host => host.endsWith('.weixin.qq.com') ? 'wechat' : 'yyb';

export function abortError() { return new DOMException('微信授权请求已取消', 'AbortError'); }
export function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }

export function withAbort(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason?.name === 'TimeoutError'
      ? new DOMException('微信授权请求超时', 'TimeoutError') : abortError());
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}

function officialUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('微信授权地址无效'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash) {
    throw Error('微信授权地址不在允许范围');
  }
  return url;
}

function responseCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  return String(headers.get('set-cookie') || '').split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/).filter(Boolean);
}

export function createWechatHttp({ fetcher = fetch, now = Date.now } = {}) {
  const jar = new Map();
  function remember(url, headers) {
    const accepted = [];
    for (const text of responseCookies(headers)) {
      if (text.length > 8192) continue;
      const [pair, ...attributes] = text.split(';'), split = pair.indexOf('=');
      if (split < 1) continue;
      const name = pair.slice(0, split).trim();
      let value = pair.slice(split + 1).trim();
      // net/http accepts a quoted cookie value and removes only its outer
      // quotes. Do not URL-decode tokens: their original bytes are signed.
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (!cookieName.test(name) || !cookieValue.test(value) || /[";,\\]/.test(value)) continue;
      const flags = new Map(attributes.map(part => {
        const i = part.indexOf('=');
        return i < 0 ? [part.trim().toLowerCase(), ''] : [part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()];
      }));
      const domain = (flags.get('domain') || url.hostname).replace(/^\./, '').toLowerCase();
      if (domain !== url.hostname && !url.hostname.endsWith('.' + domain)) continue;
      // Public-suffix cookies have no role in this fixed three-host handshake.
      if (!domain.includes('.') || !domain.endsWith('qq.com')) continue;
      let cookiePath = flags.get('path');
      if (!cookiePath?.startsWith('/')) cookiePath = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/';
      const key = group(url.hostname) + '\n' + domain + '\n' + cookiePath + '\n' + name;
      let expiry = Infinity;
      if (/^-?\d+$/.test(flags.get('max-age') || '')) expiry = now() + Number(flags.get('max-age')) * 1000;
      else if (flags.has('expires') && Number.isFinite(Date.parse(flags.get('expires')))) expiry = Date.parse(flags.get('expires'));
      if (expiry <= now()) { jar.delete(key); continue; }
      if (jar.size >= 64 && !jar.has(key)) continue;
      const cookie = { name, value, domain, path: cookiePath, expiry, group: group(url.hostname), hostOnly: !flags.has('domain') };
      jar.set(key, cookie); accepted.push(cookie);
    }
    return accepted;
  }
  function matchingCookies(value) {
    const url = officialUrl(value), result = [];
    for (const [key, cookie] of jar) {
      if (cookie.expiry <= now()) { jar.delete(key); continue; }
      const domainMatch = cookie.hostOnly ? url.hostname === cookie.domain
        : url.hostname === cookie.domain || url.hostname.endsWith('.' + cookie.domain);
      const pathMatch = url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/');
      if (domainMatch && pathMatch && cookie.group === group(url.hostname)) result.push(cookie);
    }
    return result.sort((a, b) => b.path.length - a.path.length);
  }
  const cookies = value => matchingCookies(value).map(({ name, value }) => ({ name, value }));
  async function request(value, { method = 'GET', headers = {}, body, signal, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024, redirects = 0, completeOnCookies } = {}) {
    let url = officialUrl(value);
    const callback = url.href, freshCookies = new Set();
    if (completeOnCookies !== undefined && (method !== 'GET' || url.hostname !== 'yybadaccess.3g.qq.com'
      || url.pathname !== '/pc_yyb/pcyyb_oauth' || !Array.isArray(completeOnCookies) || completeOnCookies.length !== 2
      || !completeOnCookies.includes('openid') || !completeOnCookies.includes('accesstoken'))) throw Error('微信授权回调选项无效');
    throwIfAborted(signal);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000) throw Error('微信授权请求超时设置无效');
    const deadline = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      for (let hop = 0; ; hop++) {
        throwIfAborted(combined);
        const requestHeaders = new Headers(headers);
        if (!requestHeaders.has('cookie')) {
          const value = cookies(url).map(cookie => cookie.name + '=' + cookie.value).join('; ');
          if (value) requestHeaders.set('cookie', value);
        }
        const pending = Promise.resolve().then(() => {
          throwIfAborted(combined);
          return fetcher(url.href, { method, headers: requestHeaders, body, signal: combined, redirect: 'manual' });
        });
        // A deliberately injected transport may ignore AbortSignal. Do not let
        // its late response restore a cancelled session or leak an unread body.
        pending.then(response => { if (combined.aborted) response.body?.cancel?.().catch(() => {}); }, () => {});
        const response = await withAbort(pending, combined);
        if (response.redirected || response.url && officialUrl(response.url).href !== url.href) throw Error('微信授权服务发生未允许的跳转');
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          void response.body?.cancel?.().catch(() => {});
          for (const cookie of remember(url, response.headers)) freshCookies.add(cookie);
          if (completeOnCookies) {
            const visible = matchingCookies(callback);
            const complete = completeOnCookies.every(name => {
              const cookie = visible.find(item => item.name === name);
              return cookie?.value && freshCookies.has(cookie);
            });
            // The OAuth callback can finish by setting the credentials and
            // redirecting to a product page. Do not visit that page or forward
            // its query/Cookies. Old jar values cannot make a failed callback
            // look successful: every required cookie must be set this request.
            if (complete) {
              throwIfAborted(combined);
              return { bytes: Buffer.alloc(0), headers: response.headers, status: response.status };
            }
          }
          if (method !== 'GET' || hop >= redirects) throw Error('微信授权服务发生未允许的跳转');
          const location = response.headers.get('location');
          if (!location) throw Error('微信授权跳转地址无效');
          let next;
          try { next = officialUrl(new URL(location, url).href); } catch { throw Error('微信授权跳转地址无效'); }
          if (next.origin !== url.origin) throw Error('微信授权服务不允许跨域跳转');
          url = next; continue;
        }
        if (!response.ok) { void response.body?.cancel?.().catch(() => {}); throw Error('微信授权请求失败（HTTP ' + response.status + '）'); }
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > maxBytes) { void response.body?.cancel?.().catch(() => {}); throw Error('微信授权响应过大'); }
        const chunks = []; let total = 0;
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { value, done } = await withAbort(reader.read(), combined);
              if (done) break;
              total += value.byteLength;
              if (total > maxBytes) throw Error('微信授权响应过大');
              chunks.push(Buffer.from(value));
            }
          } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        } else {
          const bytes = Buffer.from(await withAbort(response.arrayBuffer(), combined));
          if (bytes.length > maxBytes) throw Error('微信授权响应过大');
          chunks.push(bytes);
        }
        throwIfAborted(combined);
        remember(url, response.headers);
        return { bytes: Buffer.concat(chunks), headers: response.headers, status: response.status };
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (deadline.aborted) throw new DOMException('微信授权请求超时', 'TimeoutError');
      // Error strings from network implementations can contain credential URLs.
      if (/^微信授权/.test(error?.message || '')) throw error;
      throw Error('微信授权网络请求失败，请重试');
    }
  }
  return { request, cookies, close() { jar.clear(); } };
}
