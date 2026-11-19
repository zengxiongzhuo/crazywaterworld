import crypto from 'node:crypto';
import { notifyWechatStage } from './diagnostics.mjs';

// Public client channel parameters, not an account credential. Keep this wire
// profile separate from the host OS: it describes the game's WeChat channel.
export const WECHAT_GAME_APPID = 'wx2ea52a972ea18e5e';
export const WECHAT_GAME_PROFILE = Object.freeze({ appId: '14021170', signKey: 'df8B12db29582476', packetId: '50001988',
  channelId: '1400', bai: 14021170, bci: 31400, appVersion: '1.12.11', platform: 'mac', system: 'macOS 15.0', model: 'Mac' });
const sorted = object => Object.keys(object).sort().filter(key => typeof object[key] === 'number' || object[key]).map(key => key + '=' + object[key]).join('&');

async function textBody(response) {
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.byteLength;
    if (size > 2 * 1024 * 1024) throw Error('微信游戏登录响应过大');
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts).toString('utf8');
}

// Complete the game-specific exchange after the one-time wx.login code has
// been obtained. URLs are fixed; redirects must never forward the code/token.
export async function exchangeWechatGameCode(code, { fetcher = fetch, signal, profile = WECHAT_GAME_PROFILE, now = Date.now, onStage } = {}) {
  if (typeof code !== 'string' || !code || code.length > 512) throw Error('微信未返回有效小游戏登录 code，请重新扫码');
  signal?.throwIfAborted();
  const config = profile, did = crypto.randomUUID(), dc = crypto.randomUUID(), clientKey = crypto.randomBytes(16).toString('hex');
  let initId = '', tid = '';
  const request = async (route, body = {}, method = 'POST', extra = {}) => {
    notifyWechatStage(onStage, { '/public/info': 'game-public', '/init': 'game-init', '/user/login': 'game-login' }[route]);
    signal?.throwIfAborted();
    const nonce = '1' + crypto.randomBytes(4).toString('hex');
    const query = { sign: '', ts: now().toString(), nonce: tid || nonce, initId: initId || tid || nonce,
      reqId: nonce, apiVersion: 200, bai: config.bai, bci: config.bci, rpf: '31', did, dc, sst: 1, ...extra };
    const header = { ai: config.appId, pi: config.packetId, ci: config.channelId, cv: '101200', pf: '1' };
    const text = JSON.stringify(body);
    query.sign = crypto.createHash('md5').update(`wltyx$${config.signKey}${clientKey}@${text === '{}' ? '' : text}$${sorted(query)}##${sorted(header)}`).digest('hex');
    const response = await fetcher('https://api.gzxianc.com/api' + route + '?' + new URLSearchParams(Object.entries(query).filter(([, value]) => value)), {
      method, headers: { 'content-type': 'application/json;charset=utf-8', ...header }, body: method === 'GET' ? undefined : text,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), redirect: 'error',
    });
    signal?.throwIfAborted();
    let result;
    try { result = JSON.parse(await textBody(response)); } catch { throw Error('游戏登录服务返回格式无效'); }
    if (!response.ok || result.code !== 0 || !result.data) throw Object.assign(Error('游戏登录服务拒绝请求，请重新扫码或稍后重试'), { code: 'WECHAT_GAME_REJECTED', httpStatus: response.status, responseCode: result.code });
    if (result.meta?.tid) tid = String(result.meta.tid);
    return result.data;
  };
  const pub = await request('/public/info', {}, 'GET', { ai: config.appId, pi: config.packetId, ci: config.channelId, pf: '1' });
  if (typeof pub.publicKey !== 'string' || !/^[A-Za-z0-9+/=]{64,4096}$/.test(pub.publicKey)) throw Error('游戏登录公钥无效');
  const key = crypto.publicEncrypt({ key: '-----BEGIN PUBLIC KEY-----\n' + pub.publicKey.match(/.{1,64}/g).join('\n') + '\n-----END PUBLIC KEY-----',
    padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(clientKey)).toString('base64');
  const init = await request('/init', { did, dc, nm: 'wifi', sv: '15.0', svc: '', pm: config.model, lang: 'zh', tz: '+8', dn: '',
    sd: '320', sh: '1280', sw: '720', pn: WECHAT_GAME_APPID, appVersion: config.appVersion, privacyVersion: 100, key, activation: 1, appName: '疯狂水世界' });
  initId = init.initId ?? ''; const channel = init.channel;
  if (!channel?.appId || !channel.mchId) throw Error('游戏初始化缺少微信渠道信息');
  const params = { protocol: '300003', code, sessionkey: '', openid: '', unionid: '', sceneId: '1001', appid: channel.appId,
    superaid: config.appId, aid: config.appId, packetid: channel.mchId, linkid: channel.mchId, cid: config.channelId, channelid: config.channelId,
    devicecode: dc, platform: config.platform, system: config.system, gameversion: config.appVersion, shareid: 0, shareposition: 0,
    shareserverid: '', shareroleid: '', traceId: Buffer.from(encodeURIComponent('{}')).toString('base64') };
  signal?.throwIfAborted();
  notifyWechatStage(onStage, 'game-channel');
  const response = await fetcher('https://minigame.ewan.cn/minigame', { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8',
    ai: String(channel.appId), pi: String(channel.mchId), ci: config.channelId, traceId: crypto.randomUUID(), reqId: '3' + now().toString().slice(-7) },
    body: Buffer.from(encodeURIComponent(JSON.stringify(params))).toString('base64'),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), redirect: 'error' });
  const text = await textBody(response); let login;
  try { login = JSON.parse(text); } catch {
    try { login = JSON.parse(decodeURIComponent(Buffer.from(text, 'base64').toString())); } catch { throw Error('微信游戏授权响应格式无效'); }
  }
  signal?.throwIfAborted();
  if (!response.ok || login.status !== 200 || !login.mopenid || !login.openid) throw Object.assign(Error('微信游戏授权失败，请重新扫码'), { code: 'WECHAT_GAME_REJECTED', httpStatus: response.status, responseCode: login.status });
  login.channeluid = String(login.openid); login.openid = login.mopenid; login.useractiveflag = 1;
  login.userInfo = { channelUid: login.channeluid, bandPhoneFlag: !!login.bandphoneflag, shareId: '0', sharePosition: '0', shareServerId: '',
    shareRoleId: '', userType: login.usertype, usertype: login.usertype, visitBackStatus: 0 };
  const game = await request('/user/login', { appVersion: config.appVersion, channel: { uid: login.openid, extJson: JSON.stringify(login) },
    sysVersion: config.system, phoneModel: config.model });
  const timestamp = Number(game.ts) < 1e12 ? Number(game.ts) * 1000 : Number(game.ts);
  if (typeof game.openId !== 'string' || !game.openId || typeof (game.signToken || game.token) !== 'string'
    || !(game.signToken || game.token) || typeof game.sign !== 'string' || !game.sign || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw Error('游戏返回的登录凭据不完整');
  }
  return { url: 'wss://dhyaoj-gate.khlgamen.com:443/ws', source: 'wechat', capturedAt: new Date(now()).toISOString(), login: {
    language: 'zh_CN', eworldParams: { openId: game.openId, token: game.signToken || game.token, sign: game.sign, timestamp },
    eworldClientInfo: { appId: config.appId, channelId: config.channelId, clientVersion: config.appVersion }, worldId: 0, systemLanguage: 'zh_cn_#hans',
  } };
}
