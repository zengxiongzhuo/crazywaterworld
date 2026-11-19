// Default YYB/appstore QR flow, implemented in Node. Protocol reference:
// YYB-Go-Enhanced v0.3.10 (9d5e2bd), internal/qr/qr.go. Other providers omitted.
import { createHash, randomUUID } from 'node:crypto';
import { createWechatHttp, throwIfAborted, withAbort } from './http.mjs';
import { fetchWechatLoginBuffer } from './login-buffer.mjs';

const CALLBACK = 'https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_oauth';
const QR_APPID = 'wxd44977328b36e647';

function imageMime(bytes) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 4096 && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 4096
    && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) return 'image/png';
  if (bytes.length > 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
    && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(6) <= 4096 && bytes.readUInt16LE(8) > 0 && bytes.readUInt16LE(8) <= 4096 && bytes.at(-1) === 0x3b) return 'image/gif';
  if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    for (let i = 2; i + 4 < bytes.length;) {
      if (bytes[i++] !== 0xff) break;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (i + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        const h = bytes.readUInt16BE(i + 3), w = bytes.readUInt16BE(i + 5);
        if (w > 0 && h > 0 && w <= 4096 && h <= 4096) return 'image/jpeg';
      }
      i += length;
    }
  }
  throw Error('微信二维码图片无效，请检查网络后重试');
}

export async function createWechatQrSession({ fetcher = fetch, signal, now = Date.now, timeoutMs = 20000, pollTimeoutMs = 35000, ttlMs = 300000, authorizationTimeoutMs = 120000 } = {}) {
  throwIfAborted(signal);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 300000) throw Error('二维码有效期设置无效');
  if (!Number.isSafeInteger(authorizationTimeoutMs) || authorizationTimeoutMs < 1 || authorizationTimeoutMs > 120000) throw Error('微信授权有效期设置无效');
  const controller = new AbortController(), http = createWechatHttp({ fetcher, now });
  const joined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  // This is an internal polling flow, not a public callback receiver. Keep the
  // appstore wire value; ownership is bound by UUID, isolated cookies and signal.
  const state = 'web', id = randomUUID();
  const expiresAt = now() + ttlMs;
  let phase = 'waiting', uuid = '', qrImage = '', authorizeCode = '', credentials = null, loginBuffer = null;
  let pollJob = null, bufferJob = null, authorizationAttempted = false, authorizationFailed = false;
  let authorizedExpiresAt = 0, authorizationSignal;
  function close() { controller.abort(); http.close(); authorizeCode = ''; credentials = null; loginBuffer = null; qrImage = ''; }
  const externalAbort = () => close();
  signal?.addEventListener('abort', externalAbort, { once: true });
  const ensure = extra => {
    throwIfAborted(joined); throwIfAborted(extra);
    const authorized = phase === 'authorized';
    if (authorized ? now() >= authorizedExpiresAt || authorizationSignal?.aborted : now() >= expiresAt) {
      phase = 'expired'; qrImage = ''; authorizeCode = ''; credentials = null; loginBuffer = null; http.close();
      throw Error(authorized ? '微信授权已超时，请重新扫码' : '二维码已过期，请重新获取');
    }
  };
  const requestSignal = extra => AbortSignal.any([joined, ...(extra ? [extra] : []), ...(authorizationSignal ? [authorizationSignal] : [])]);
  const current = () => ({ phase });
  try {
    const oauth = new URL('https://open.weixin.qq.com/connect/qrconnect');
    oauth.search = new URLSearchParams({ appid: QR_APPID, redirect_uri: CALLBACK + '?login_type=WX', response_type: 'code',
      scope: 'snsapi_login,snsapi_runtime_pcsdk', state, fast_login: '1', self_redirect: 'true' }).toString();
    const page = await http.request(oauth, { signal: joined, timeoutMs, maxBytes: 1024 * 1024, redirects: 3, headers: { 'User-Agent': 'Mozilla/5.0' } });
    ensure();
    const match = /\/connect\/qrcode\/([A-Za-z0-9_-]{1,256})(?=["'<>\s]|$)/.exec(page.bytes.toString('utf8'));
    if (!match) throw Error('未能获取微信登录二维码，请重试');
    uuid = match[1];
    const image = await http.request('https://open.weixin.qq.com/connect/qrcode/' + uuid, { signal: joined, timeoutMs, maxBytes: 2 * 1024 * 1024, redirects: 2 });
    ensure(); qrImage = 'data:' + imageMime(image.bytes) + ';base64,' + image.bytes.toString('base64');
  } catch (error) { close(); signal?.removeEventListener('abort', externalAbort); throw error; }
  const session = {
    id,
    get qrImage() { return qrImage; },
    expiresAt,
    async poll({ signal: extra } = {}) {
      ensure(extra);
      if (phase === 'authorized' || phase === 'expired') return current();
      if (!pollJob) {
        pollJob = (async () => {
          const url = new URL('https://long.open.weixin.qq.com/connect/l/qrconnect');
          url.search = new URLSearchParams({ uuid, _: String(now()) }).toString();
          let response;
          try { response = await http.request(url, { signal: requestSignal(extra), timeoutMs: pollTimeoutMs, maxBytes: 65536, headers: { 'User-Agent': 'Mozilla/5.0' } }); }
          catch (error) { if (error.name === 'TimeoutError') { ensure(extra); return current(); } throw error; }
          ensure(extra);
          const text = response.bytes.toString('utf8'), status = /(?:^|[;\s])(?:window\.)?wx_errcode\s*=\s*(\d+)\s*;?/.exec(text);
          if (!status) throw Error('微信扫码状态响应无效，请重试');
          switch (Number(status[1])) {
            case 408: break;
            case 404: phase = 'scanned'; break;
            case 402: case 403: phase = 'expired'; qrImage = ''; http.close(); break;
            case 405: {
              const value = /(?:^|[;\s])(?:window\.)?wx_code\s*=\s*['"]([A-Za-z0-9_-]{1,512})['"]/.exec(text)?.[1];
              if (!value) throw Error('微信授权未返回有效凭据，请重新扫码');
              authorizeCode = value; phase = 'authorized'; qrImage = '';
              // QR validity limits scanning only. A late successful scan gets
              // a fresh, bounded budget for callback and login-buffer exchange.
              authorizedExpiresAt = now() + authorizationTimeoutMs;
              authorizationSignal = AbortSignal.timeout(authorizationTimeoutMs);
              break;
            }
            default: throw Error('微信扫码状态暂不可用，请重试');
          }
          return current();
        })().finally(() => { pollJob = null; });
      }
      return withAbort(pollJob, extra);
    },
    async getLoginBuffer({ signal: extra, onStage } = {}) {
      ensure(extra);
      if (phase !== 'authorized' || authorizationFailed) throw Error('请重新获取二维码并确认微信授权');
      if (loginBuffer) return loginBuffer;
      const stage = name => { try { Promise.resolve(onStage?.(name)).catch(() => {}); } catch {} };
      if (!bufferJob) bufferJob = (async () => {
        if (!credentials) {
          if (authorizationAttempted) throw Error('授权结果未确认，请重新扫码');
          authorizationAttempted = true;
          const callback = new URL(CALLBACK);
          callback.search = new URLSearchParams({ login_type: 'WX', code: authorizeCode, state }).toString();
          try {
            stage('callback');
            await http.request(callback, { signal: requestSignal(extra), timeoutMs, maxBytes: 1024 * 1024, redirects: 3,
              completeOnCookies: ['openid', 'accesstoken'], headers: { 'User-Agent': 'Mozilla/5.0' } });
            ensure(extra);
            const values = new Map();
            for (const cookie of [...http.cookies(callback), ...http.cookies('https://yybadaccess.3g.qq.com/')]) if (!values.has(cookie.name)) values.set(cookie.name, cookie.value);
            if (!values.get('openid') || !values.get('accesstoken')) throw Error('微信授权未返回完整凭据，请重新扫码');
            credentials = { openid: values.get('openid'), accessToken: values.get('accesstoken'), refreshToken: values.get('refreshtoken') || '' };
            authorizeCode = '';
          } catch (error) { authorizationFailed = true; authorizeCode = ''; http.close(); throw error; }
        }
        stage('ticket');
        const value = await fetchWechatLoginBuffer(credentials, { http, signal: requestSignal(extra), now, timeoutMs });
        ensure(extra); loginBuffer = value;
        return value;
      })().finally(() => { bufferJob = null; });
      return withAbort(bufferJob, extra);
    },
    close() { close(); signal?.removeEventListener('abort', externalAbort); },
  };
  // Internal stable-device input only: non-enumerable so controller responses
  // and JSON serialization cannot accidentally expose the authorization identity.
  Object.defineProperty(session, 'identityKey', {
    get: () => credentials ? createHash('sha256').update(credentials.openid).digest('hex') : null,
  });
  return session;
}
