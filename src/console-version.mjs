import { createHash, randomUUID } from 'node:crypto';

const VERSION_HEADER = 'x-cw-console-version';
const VERSION_MESSAGE = '控制台已更新或重启，当前页面版本已过期。请先保留未保存的修改，再刷新页面。';
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
// Only routes whose entire operation stops/cancels work are exempt. Mixed routes
// such as accounts/pause and loop/auto-start can also start work and must be checked.
const stopRoutes = new Set([
  '/api/loop/stop', '/api/disconnect', '/api/stages/stop', '/api/pirates/advance/stop',
  '/api/guild/mutual/stop', '/api/trials/stop', '/api/capture/stop',
  '/api/accounts/alipay-login/cancel', '/api/accounts/wechat-login/cancel', '/api/accounts/phone-login/cancel',
]);

function checkVersion(version) {
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(version)) {
    throw new TypeError('控制台版本标识无效');
  }
  return version;
}

/** Create once per console instance, never once per response or request. */
export function createConsoleVersion(page) {
  if (typeof page !== 'string') throw new TypeError('控制台页面必须为字符串');
  const hash = createHash('sha256').update(page).digest('hex').slice(0, 16);
  return 'cw-' + randomUUID() + '-' + hash;
}

/** Bind the browser to the backend instance that served this HTML. */
export function renderVersionedPage(page, version) {
  if (typeof page !== 'string') throw new TypeError('控制台页面必须为字符串');
  checkVersion(version);
  const head = /<head(?:\s[^>]*)?>/i;
  if (!head.test(page)) throw new Error('控制台页面缺少 head，无法注入版本标识');
  const escaped = version.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  // Rendering an already-versioned document must not leave an earlier meta first.
  const cleaned = page.replace(/<meta\b[^>]*\bname\s*=\s*(?:"cw-console-version"|'cw-console-version'|cw-console-version(?=\s|\/?>))[^>]*>/gi, '');
  return cleaned.replace(head, opening => opening + '\n<meta name="cw-console-version" content="' + escaped + '">');
}

/**
 * IncomingMessage-compatible, read-only request inspection. Local scripts without
 * browser headers remain compatible; an explicit version opts any caller into the
 * same check. Read requests and dedicated stop/cancel routes always remain usable.
 */
export function consoleVersionError(req, currentVersion) {
  checkVersion(currentVersion);
  const method = String(req.method ?? 'GET').toUpperCase();
  if (readMethods.has(method)) return null;
  let pathname;
  try { pathname = new URL(req.url ?? '/', 'http://console.local').pathname; }
  catch { pathname = null; }
  if (method === 'POST' && stopRoutes.has(pathname)) return null;
  const headers = Object.entries(req.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]);
  const supplied = headers.filter(([name]) => name === VERSION_HEADER);
  // Node fetch/undici also sends Sec-Fetch-Mode: cors. That header alone does
  // not identify a browser; real browser fetches additionally send site/dest.
  const browser = headers.some(([name]) => ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user'].includes(name));
  if (!supplied.length && !browser) return null;
  if (supplied.length === 1 && supplied[0][1] === currentVersion) return null;
  return { status: 409, code: 'CLIENT_VERSION_MISMATCH', error: VERSION_MESSAGE,
    fields: { revision: VERSION_MESSAGE }, version: currentVersion };
}
