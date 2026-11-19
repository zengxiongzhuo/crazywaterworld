// Optional HTTPDNS discovery for the fixed WeChat protocol hosts. No proxy,
// database or shared authorization state is required by this login-only client.
import http from 'node:http';
import { isIP } from 'node:net';
import { CLIENT_VERSION } from './ilink.mjs';

export const LONG_HOST = 'longcloud.weixin.com';
export const SHORT_HOST = 'shortcloud.weixin.com';
const DNS_HOST = 'aedns.weixin.qq.com';
const SHORT_FALLBACK = ['116.128.171.253', '140.207.120.146', '182.50.15.223', '182.50.15.171'];

export function requestWechatHTTP(url, { method = 'GET', headers = {}, body, signal, timeoutMs = 8000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let request, timer, settled = false, connected = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { request?.destroy(); reject(error); } else resolve(value);
    };
    const abort = () => finish(signal?.reason ?? new Error('微信请求已取消'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const target = new URL(url);
      if (target.protocol !== 'http:' || target.username || target.password) throw Error('微信传输地址无效');
      request = http.request(target, { method, headers, agent: false }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) { response.destroy(); finish(new Error('微信协议响应过大')); return; }
          chunks.push(chunk);
        });
        response.on('error', () => finish(new Error('微信协议响应中断')));
        response.on('end', () => {
          const data = Buffer.concat(chunks), status = response.statusCode;
          finish(null, { status, ok: status >= 200 && status < 300,
            arrayBuffer: async () => data, text: async () => data.toString('utf8'), json: async () => JSON.parse(data.toString('utf8')) });
        });
      });
      request.on('socket', socket => { socket.once('connect', () => { connected = true; }); });
      request.on('error', () => finish(Object.assign(new Error('微信协议网络请求失败'), { code: connected ? 'WECHAT_HTTP_FAILED' : 'WECHAT_DIAL_FAILED' })));
      request.on('upgrade', (_response, socket) => { socket.destroy(); finish(new Error('微信协议返回意外升级响应')); });
      timer = setTimeout(() => finish(Object.assign(new Error('微信协议网络请求超时'), { code: connected ? 'WECHAT_HTTP_FAILED' : 'WECHAT_DIAL_FAILED' })), timeoutMs);
      request.end(body);
    } catch (error) { finish(error); }
  });
}

function publicAddress(address) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6) return !/^(?:fc|fd|fe[89ab]|::|ff)/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127);
}
export function parseDomainList(value) {
  const dns = value?.dns;
  if (!dns || dns.retcode !== undefined && dns.retcode !== 0 || !Array.isArray(dns.domainlist)) throw Error('微信 HTTPDNS 响应无效');
  const result = new Map();
  for (const domain of dns.domainlist) {
    if (![LONG_HOST, SHORT_HOST].includes(domain?.name)) continue;
    const ips = (Array.isArray(domain.iplist) ? domain.iplist : []).map(item => item?.ip).filter(ip => typeof ip === 'string' && publicAddress(ip)).slice(0, 32);
    const protocols = new Map();
    for (const protocol of Array.isArray(domain.protocollist) ? domain.protocollist : []) {
      if (!['mmtlsovertcp', 'mmtlsoverhttp', 'http'].includes(protocol?.name)) continue;
      protocols.set(protocol.name, (Array.isArray(protocol.portlist) ? protocol.portlist : []).filter(port => Number.isInteger(port) && port > 0 && port <= 65535).slice(0, 16));
    }
    result.set(domain.name, { ips, protocols });
  }
  return result;
}
const serversFor = (parsed, host, protocol) => {
  const domain = parsed.get(host);
  return domain ? domain.ips.flatMap(ip => (domain.protocols.get(protocol) ?? []).map(port => ({ ip, port }))) : [];
};
export function longlinkLoginTargets(targets, max = 6) {
  const preferred = [443, 8080, 80, 5000], unique = new Map();
  for (const target of targets) unique.set(target.ip + ':' + target.port, target);
  const ordered = [...unique.values()].filter(target => target.ip !== LONG_HOST || target.port !== 443);
  ordered.sort((a, b) => (preferred.includes(a.port) ? preferred.indexOf(a.port) : 4) - (preferred.includes(b.port) ? preferred.indexOf(b.port) : 4));
  return [...(max > 0 ? ordered.slice(0, max - 1) : ordered), { ip: LONG_HOST, port: 443 }];
}

export async function discoverWechatTargets({ signal, fetcher = requestWechatHTTP, timeoutMs = 6000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const query = new URLSearchParams({ clientversion: String(CLIENT_VERSION), devicetype: 'Windows', uin: '0', format: 'json' });
  let parsed = new Map();
  for (const host of [DNS_HOST, '180.153.202.85']) {
    try {
      combined.throwIfAborted();
      const response = await fetcher(`http://${host}/cgi-bin/default/getdns?${query}`, { signal: combined, timeoutMs, maxBytes: 1024 * 1024, redirect: 'error', headers: { host: DNS_HOST, 'user-agent': 'MicroMessenger Client', connection: 'close' } });
      if (!response.ok) throw Error('微信 HTTPDNS 请求失败');
      parsed = parseDomainList(await response.json()); break;
    } catch { if (signal?.aborted) throw signal.reason; }
  }
  const longlink = longlinkLoginTargets(serversFor(parsed, LONG_HOST, 'mmtlsovertcp'));
  let shortlink = [];
  for (const protocol of ['mmtlsoverhttp', 'http']) {
    shortlink = serversFor(parsed, SHORT_HOST, protocol).filter(target => target.port === 80);
    if (shortlink.length) break;
  }
  if (!shortlink.length) shortlink = [...SHORT_FALLBACK, SHORT_HOST].map(ip => ({ ip, port: 80 }));
  return { longlink, shortlink: shortlink.slice(0, 6) };
}
