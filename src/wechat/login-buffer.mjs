// Minimal appstore login-buffer exchange. Wire fields follow YYB-Go-Enhanced
// v0.3.10 (9d5e2bd), internal/protocol/loginbuffer.go; no refresh/account service.
import { createHash, randomInt } from 'node:crypto';
import { createWechatHttp, throwIfAborted } from './http.mjs';

export const WECHAT_BUFFER_URL = 'https://yybadaccess.3g.qq.com/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth';
const ACCESS_KEY = 'wgrdg373hy26ww2'; // Public application protocol constant.
const secretValue = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value) && !/[;,]/.test(value);

function responseCode(text) {
  let depth = 0;
  const tokens = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') depth++;
    else if (text[i] === '}' || text[i] === ']') depth--;
    else if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      const name = JSON.parse(text.slice(start, i + 1));
      let j = i + 1; while (/\s/.test(text[j] || '') && j < text.length) j++;
      if (depth !== 1 || name !== 'code' || text[j] !== ':') continue;
      j++; while (/\s/.test(text[j] || '') && j < text.length) j++;
      const valueStart = j;
      if (text[j] === '"') { j++; while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j++; j++; } j++; }
      else while (j < text.length && !/[\s,}]/.test(text[j])) j++;
      const raw = text.slice(valueStart, j);
      tokens.push(raw.startsWith('"') ? JSON.parse(raw) : raw);
    }
  }
  if (tokens.length !== 1 || typeof tokens[0] !== 'string' || !/^-?(0|[1-9]\d*)$/.test(tokens[0])
    || Number(tokens[0]) < -2147483648 || Number(tokens[0]) > 2147483647) throw Error('微信登录票据响应缺少有效状态');
  return Number(tokens[0]);
}

export function validateLoginBuffer(value) {
  if (typeof value !== 'string' || !value.length || value.length > 87384
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error('微信登录票据格式无效');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > 65536 || bytes.toString('base64') !== value) throw Error('微信登录票据格式无效');
  return value;
}

export async function fetchWechatLoginBuffer(credentials, { http, fetcher = fetch, signal, now = Date.now, nonce = () => String(randomInt(10000)), timeoutMs = 20000 } = {}) {
  throwIfAborted(signal);
  if (!secretValue(credentials?.openid) || !secretValue(credentials?.accessToken)
    || credentials.refreshToken && !secretValue(credentials.refreshToken)) throw Error('微信授权未返回完整凭据，请重新扫码');
  const body = JSON.stringify({ extInfo: { listS: {
    unionid: { value: [credentials.openid] }, user_id: { value: [credentials.openid] }, access_token: { value: [credentials.accessToken] },
  }, listI: { user_type: { value: [0] } } } }).replace(/[<>&\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  const timestamp = String(now()), random = String(nonce());
  if (!/^\d+$/.test(timestamp) || !/^\d{1,4}$/.test(random)) throw Error('微信授权请求参数无效');
  const transport = http ?? createWechatHttp({ fetcher, now });
  try {
    const response = await transport.request(WECHAT_BUFFER_URL, { method: 'POST', body, signal, timeoutMs, maxBytes: 1024 * 1024, headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'Ual-Access-Businessid': 'pc_yyb_auth', 'Ual-Access-Timestamp': timestamp,
      'Ual-Access-Nonce': random, 'Ual-Access-Signature': createHash('md5').update(body + timestamp + ACCESS_KEY + random).digest('hex'),
      Cookie: 'openid=' + credentials.openid + '; accesstoken=' + credentials.accessToken + '; refreshtoken=' + (credentials.refreshToken || ''),
    } });
    let result;
    const text = response.bytes.toString('utf8');
    let code;
    try { result = JSON.parse(text); code = responseCode(text); } catch { throw Error('微信登录票据响应格式无效'); }
    if (code !== 0) throw Object.assign(Error('微信授权被拒绝，请重新扫码'), { code: 'WECHAT_BUFFER_REJECTED', statusCode: code });
    throwIfAborted(signal);
    return validateLoginBuffer(result.ext_info?.list_s?.login_buffer?.value?.[0]);
  } finally { if (!http) transport.close(); }
}
