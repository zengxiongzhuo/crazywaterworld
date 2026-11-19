// Login-scoped application-store protocol client: no server, account database,
// proxy configuration or background credential renewal is started here.
import { randomBytes } from 'node:crypto';
import { notifyWechatStage } from './diagnostics.mjs';
import { connectMmtls, pickAccessPSK } from './mmtls-client.mjs';
import { discoverWechatTargets, requestWechatHTTP } from './newdns.mjs';
import { send0RTT } from './shortlink.mjs';
import { parseLoginBuffer, buildLoginBody, parseLoginResponse, extractSession, deriveWechatDevice,
  buildJSLoginPlaintext, buildTransferPacket, parseLoginCodeResponse, ManualAuthRejectedError, CMD_MANUAL_AUTH } from './ilink.mjs';

function abortable(work, signal, disposeLate) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { settled = true; reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(value => {
      signal.removeEventListener('abort', abort);
      if (settled || signal.aborted) { disposeLate?.(value); if (!settled) reject(signal.reason); return; }
      settled = true; resolve(value);
    }, error => { signal.removeEventListener('abort', abort); if (!settled) { settled = true; reject(error); } });
  });
}
function wipeSession(session) {
  if (!session) return;
  for (const field of ['sendKey', 'recvKey', 'f9', 'ticket', 'deviceId', 'hostAppId']) session[field]?.fill?.(0);
}

export async function getWechatLoginCode(loginBuffer, {
  appId = 'wx2ea52a972ea18e5e', signal, timeoutMs = 45000, fetcher = requestWechatHTTP,
  connect = connectMmtls, discover = discoverWechatTargets, shortlinkSender = send0RTT,
  targets, device, now = Date.now, authOptions, onStage,
} = {}) {
  if (!/^wx[0-9a-f]{16}$/.test(appId)) throw Error('微信小游戏 AppID 无效');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error('微信取码超时参数无效');
  const meta = parseLoginBuffer(loginBuffer);
  const deadline = Date.now() + timeoutMs, expiry = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, expiry]) : expiry;
  active.throwIfAborted();
  const identity = device ?? deriveWechatDevice(randomBytes(32), meta.deviceId.toString('hex'));
  if (!Buffer.isBuffer(identity.appDeviceId) || !Buffer.isBuffer(identity.sessDevice)) throw Error('微信设备标识无效');
  let session, access;
  try {
    notifyWechatStage(onStage, 'discovery');
    const endpoints = targets ?? await abortable(() => discover({ signal: active, timeoutMs: Math.min(6000, timeoutMs / 3 | 0) || 1, fetcher }), active);
    if (!Array.isArray(endpoints.longlink) || !Array.isArray(endpoints.shortlink)) throw Error('微信传输地址列表无效');
    const candidates = endpoints.longlink.slice(0, 6);
    let last;
    for (let index = 0; index < candidates.length; index++) {
      active.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining < 1) throw Error('微信取码超时');
      const perAttempt = Math.max(1, Math.floor(remaining / (candidates.length - index)));
      const attempt = AbortSignal.any([active, AbortSignal.timeout(perAttempt)]);
      let client, temp;
      try {
        notifyWechatStage(onStage, 'handshake');
        client = await abortable(() => connect(candidates[index], { signal: attempt, timeoutMs: perAttempt }), attempt, late => late.close());
        notifyWechatStage(onStage, 'manual-auth');
        const request = buildLoginBody(loginBuffer, identity.appDeviceId, authOptions); temp = request.temp;
        const sequence = await abortable(() => client.sendApp(CMD_MANUAL_AUTH, request.body), attempt);
        const response = await abortable(() => client.recvApp(), attempt);
        if (response.cmd !== CMD_MANUAL_AUTH || response.seq !== sequence) throw Error('微信授权响应与请求不匹配');
        session = extractSession(parseLoginResponse(response.body, temp));
        session.deviceId = Buffer.from(meta.deviceId); session.hostAppId = Buffer.from(meta.hostAppId);
        const tickets = client.extractPSKs();
        access = pickAccessPSK(tickets, now());
        if (!access) throw Error('微信授权未返回取码票据');
        break;
      } catch (error) {
        wipeSession(session); session = null; access = null; last = error;
        active.throwIfAborted();
        if (error instanceof ManualAuthRejectedError) throw error;
      } finally {
        client?.close(); temp?.okm?.fill(0); temp?.compressed?.fill(0);
      }
    }
    if (!session || !access) throw last ?? Error('没有可用的微信授权连接');
    active.throwIfAborted();
    notifyWechatStage(onStage, 'code');
    const envelope = buildTransferPacket(session, buildJSLoginPlaintext(session, appId, identity.sessDevice));
    const raw = await abortable(() => shortlinkSender(endpoints.shortlink, access, session.recvKey, envelope, {
      signal: active, timeoutMs: Math.min(10000, Math.max(1, deadline - Date.now())), fetcher, now,
    }), active);
    active.throwIfAborted();
    return parseLoginCodeResponse(raw);
  } finally {
    wipeSession(session); meta.ticket.fill(0); meta.deviceId.fill(0); meta.hostAppId.fill(0); meta.raw.fill(0);
    if (access) { access.preSharedKey = ''; access.ticketEntry = ''; }
    if (!device) { identity.appDeviceId.fill(0); identity.sessDevice.fill(0); }
  }
}
