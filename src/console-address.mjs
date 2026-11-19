import { isIP } from 'node:net';

export function normalizeConsoleHost(value) {
  let host = String(value ?? '').trim() || '127.0.0.1';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host.includes('%') && isIP(host)) return host;
  if (host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return host;
  throw new Error('CW_HOST 请填写 IP 地址或主机名，不要包含 http://、端口或路径');
}

export function consoleHost(env = process.env) {
  return normalizeConsoleHost(env.CW_HOST);
}

// Wildcard addresses describe where to listen, not where a browser should go.
// Other devices use this computer's LAN address; this URL is for local access.
export function consoleUrl(host, port) {
  const normalized = normalizeConsoleHost(host);
  const value = Number(port);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('控制台端口无效');
  if (normalized === '0.0.0.0') return `http://127.0.0.1:${value}`;
  if (isIP(normalized) === 6) {
    const ipv6 = new URL(`http://[${normalized}]/`).hostname;
    return `http://${ipv6 === '[::]' ? '[::1]' : ipv6}:${value}`;
  }
  return `http://${normalized}:${value}`;
}
