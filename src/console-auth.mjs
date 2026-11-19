import { randomBytes, timingSafeEqual } from 'node:crypto';

// 控制台访问密码独立于游戏账号登录，只在服务端检查。
const PASSWORD = Buffer.from('123456');
const COOKIE = 'cw_console_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const ATTEMPT_MS = 60 * 1000;

export function createConsoleAuth({ loginPage, sessionMs = SESSION_MS, now = Date.now } = {}) {
  const sessions = new Map();
  const attempts = new Map();
  const requestSessions = new WeakMap();
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const cookie = (req, token, age) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${req.socket.encrypted ? '; Secure' : ''}`;
  function tokenFor(req) {
    const values = String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
    return values.length === 1 ? values[0].slice(COOKIE.length + 1) : '';
  }
  function revoke(token) {
    const session = sessions.get(token);
    if (!session) return;
    sessions.delete(token);
    clearTimeout(session.timer);
    for (const stream of session.streams) {
      if (!stream.destroyed && !stream.writableEnded) stream.end('event: auth-required\ndata: {}\n\n');
    }
    session.streams.clear();
  }
  function sessionFor(req) {
    const token = tokenFor(req), session = sessions.get(token);
    if (session && session.expiresAt <= now()) { revoke(token); return null; }
    return session || null;
  }
  function sameOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!req.headers.origin) return true;
    try {
      const origin = new URL(req.headers.origin);
      const host = new URL('http://' + req.headers.host);
      return ['http:', 'https:'].includes(origin.protocol) && origin.host === host.host;
    } catch { return false; }
  }
  function denied(req, res) {
    res.setHeader('cache-control', 'no-store');
    if (['GET', 'HEAD'].includes(req.method) && !new URL(req.url, 'http://localhost').pathname.startsWith('/api/')) {
      res.writeHead(303, { location: '/login' });
      res.end();
    } else json(res, 401, { error: '请先输入控制台密码登录', code: 'CONSOLE_AUTH_REQUIRED' });
  }
  function login(req, res) {
    const ip = req.socket.remoteAddress || 'unknown';
    for (const [key, entry] of attempts) if (entry.until <= now()) attempts.delete(key);
    const entry = attempts.get(ip);
    if (entry?.count >= 5) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil((entry.until - now()) / 1000))));
      json(res, 429, { error: '密码错误次数过多，请稍后再试' });
      req.resume();
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      json(res, 415, { error: '请通过登录页面输入密码' });
      req.resume();
      return;
    }
    let size = 0, chunks = [], rejected = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (rejected) return;
      if (size > 1024) {
        rejected = true; chunks = [];
        json(res, 413, { error: '登录请求过大' });
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected || res.destroyed) return;
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { json(res, 400, { error: '登录请求格式错误' }); return; }
      const password = typeof value?.password === 'string' ? Buffer.from(value.password) : Buffer.alloc(0);
      if (password.length !== PASSWORD.length || !timingSafeEqual(password, PASSWORD)) {
        if (!attempts.has(ip) && attempts.size >= 1000) attempts.delete(attempts.keys().next().value);
        const failure = attempts.get(ip) || { count: 0, until: now() + ATTEMPT_MS };
        failure.count++;
        if (failure.count === 5) failure.until = now() + ATTEMPT_MS;
        attempts.set(ip, failure);
        json(res, 401, { error: '密码错误，请重新输入', code: 'CONSOLE_PASSWORD_INVALID' });
        return;
      }
      attempts.delete(ip);
      revoke(tokenFor(req));
      for (const [token, session] of sessions) if (session.expiresAt <= now()) revoke(token);
      if (sessions.size >= 100) revoke(sessions.keys().next().value);
      const token = randomBytes(32).toString('hex');
      const session = { expiresAt: now() + sessionMs, streams: new Set(), timer: null };
      session.timer = setTimeout(() => revoke(token), sessionMs);
      session.timer.unref();
      sessions.set(token, session);
      res.setHeader('set-cookie', cookie(req, token, Math.ceil(sessionMs / 1000)));
      json(res, 200, { authenticated: true });
    });
  }
  // 在读取业务请求体、静态资源和版本校验前调用。返回 true 表示已处理。
  function intercept(req, res) {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { json(res, 400, { error: '请求地址无效' }); req.resume(); return true; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('cache-control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) {
      json(res, 403, { error: '不允许跨站操作控制台' }); req.resume(); return true;
    }
    if (pathname === '/login' && ['GET', 'HEAD'].includes(req.method)) {
      if (sessionFor(req)) { res.writeHead(303, { location: '/' }); res.end(); }
      else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : loginPage); }
      req.resume(); return true;
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') { login(req, res); return true; }
    const session = sessionFor(req);
    if (!session) { denied(req, res); req.resume(); return true; }
    requestSessions.set(req, session);
    if (pathname === '/api/auth/session' && req.method === 'GET') {
      json(res, 200, { authenticated: true, expiresAt: session.expiresAt }); req.resume(); return true;
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      revoke(tokenFor(req));
      res.setHeader('set-cookie', cookie(req, '', 0));
      json(res, 200, { authenticated: false }); req.resume(); return true;
    }
    return false;
  }
  return {
    intercept,
    authorize(req, res) {
      const session = sessionFor(req);
      if (session && session === requestSessions.get(req)) return true;
      denied(req, res); return false;
    },
    trackStream(req, res) {
      const session = requestSessions.get(req);
      session.streams.add(res);
      res.once('close', () => session.streams.delete(res));
    },
    close() { for (const token of sessions.keys()) revoke(token); attempts.clear(); },
  };
}
