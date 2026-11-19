import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConsoleAuth } from '../src/console-auth.mjs';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-console-auth-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { GameClient } = await import('../src/client.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw Error('测试禁止连接游戏'); };
const { saveStore, loadStore } = await import('../src/accounts.mjs');
saveStore({ activeId: 'auth-test', accounts: [{ id: 'auth-test', label: '鉴权测试账号', url: 'wss://fixture.invalid',
  login: { token: 'fixture-only' }, automation: { enabled: false, autoStart: false, paused: true } }] });
const { createConsole } = await import('../src/server.mjs');
let app, base, passed = 0;
const open = async () => { app = createConsole({ port: 0, protocol: {} }); base = await app.listen(); };
const close = async () => { if (app) { app.server.closeAllConnections(); await app.close(); app = null; } };
const request = (route, options = {}) => fetch(base + route, { redirect: 'manual', signal: AbortSignal.timeout(5000), ...options });
const login = (password, options = {}) => request('/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }), ...options,
});
const cookieFor = response => response.headers.get('set-cookie').split(';')[0];
async function test(name, run) { await run(); passed++; console.log('通过：' + name); }

try {
  await open();
  await test('默认开启鉴权，页面、API、素材、日志与导出均不能绕过', async () => {
    for (const route of ['/', '/ui/client.js', '/favicon.ico']) {
      const response = await request(route);
      assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/login');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const route of ['/api/accounts', '/api/events?scope=all', '/api/accounts/export', '/api/settings', '/api/art/icon?id=1']) {
      const response = await request(route);
      assert.equal(response.status, 401, route); assert.equal((await response.json()).code, 'CONSOLE_AUTH_REQUIRED');
    }
    const response = await request('/', { method: 'HEAD', headers: { 'if-none-match': 'anything' } });
    assert.equal(response.status, 303);
    for (const headers of [{ cookie: 'cw_console_session=123456' }, { authorization: 'Bearer 123456' }]) {
      assert.equal((await request('/api/accounts', { headers })).status, 401);
    }
    const before = fs.readFileSync(path.join(directory, 'accounts.json'));
    assert.equal((await request('/api/accounts/remove', { method: 'POST', body: '{"id":"a","confirm":true}' })).status, 401);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'accounts.json')), before);
  });
  await test('未登录请求在读取完整业务请求体前拒绝', async () => {
    await new Promise((resolve, reject) => {
      const req = http.request(base + '/api/accounts/import', { method: 'POST', headers: { 'content-length': '10000000' } }, res => {
        try { assert.equal(res.statusCode, 401); res.resume(); req.destroy(); resolve(); } catch (error) { reject(error); }
      });
      req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
      req.setTimeout(3000, () => { req.destroy(); reject(Error('未登录请求等待了请求体')); });
      req.flushHeaders();
    });
  });
  await test('中文密码页不预填密码，错误密码、非JSON与超大请求不会建立会话', async () => {
    const response = await request('/login'), html = await response.text();
    assert.equal(response.status, 200); assert.match(html, /登录控制台/); assert.match(html, /type="password"/);
    assert(!html.includes('123456')); assert(!html.includes('tab-account')); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await login('wrong')).status, 401);
    assert.equal((await login(123456)).status, 401);
    assert.equal((await login('123456 ', { headers: { 'content-type': 'application/json' } })).status, 401);
    assert.equal((await login('123456', { body: '{bad' })).status, 400);
    assert.equal((await login('123456', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await login('123456', { body: 'x'.repeat(2048) })).status, 413);
  });
  let cookie;
  await test('正确密码发放随机HttpOnly会话，刷新保留登录，认证先于页面版本校验', async () => {
    const response = await login('123456');
    assert.equal(response.status, 200); cookie = cookieFor(response);
    assert.match(cookie, /^cw_console_session=[a-f0-9]{64}$/);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=43200/);
    assert(!JSON.stringify(await response.json()).includes(cookie.split('=')[1]));
    for (let index = 0; index < 2; index++) {
      const page = await request('/', { headers: { cookie } });
      assert.equal(page.status, 200); assert.match(await page.text(), /tab-account/);
      assert.equal(page.headers.get('cache-control'), 'private, no-store');
    }
    assert.equal((await request('/login', { headers: { cookie } })).headers.get('location'), '/');
    assert.equal((await request('/api/accounts', { headers: { cookie } })).status, 200);
    assert.equal((await request('/api/accounts', { headers: { cookie: cookie + 'x' } })).status, 401);
    assert.equal((await request('/api/accounts', { headers: { cookie: cookie + '; ' + cookie } })).status, 401);
    assert.equal((await request('/api/accounts/pause', { method: 'POST', headers: { origin: base, 'x-cw-console-version': 'old' } })).status, 401);
  });
  await test('登录后业务写入与账号导出可用，写入仍校验页面版本', async () => {
    const page = await request('/', { headers: { cookie } });
    const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-cw-console-version': page.headers.get('x-cw-console-version') };
    const options = { method: 'POST', headers, body: JSON.stringify({ id: 'auth-test', label: '登录后更新', confirm: true }) };
    const response = await request('/api/accounts/label', options);
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
    assert.equal(loadStore().accounts[0].label, '登录后更新');
    assert.equal((await request('/api/accounts/label', { ...options, headers: { ...headers, 'x-cw-console-version': 'old-page' } })).status, 409);
    const exported = await request('/api/accounts/export', { method: 'POST', headers, body: '{"ids":["auth-test"]}' });
    assert.equal(exported.status, 200); assert.equal(exported.headers.get('cache-control'), 'no-store');
    assert.equal((await exported.json()).accounts[0].id, 'auth-test');
  });
  await test('跨站登录和写操作被拒绝，同源登录仍可用', async () => {
    assert.equal((await login('123456', { headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { cookie, origin: 'null' } })).status, 403);
    assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 403);
    const response = await login('123456', { headers: { cookie, origin: base, 'content-type': 'application/json' } });
    assert.equal(response.status, 200);
    const previous = cookie; cookie = cookieFor(response); assert.notEqual(cookie, previous);
    assert.equal((await request('/api/accounts', { headers: { cookie: previous } })).status, 401);
  });
  await test('退出撤销当前会话与其日志流，其他浏览器会话仍有效', async () => {
    const background = app.sessions.get('auth-test');
    // 用运行标记模拟后台任务，不连接游戏；网页登录退出必须保持该标记。
    background.loop.running = true;
    const other = cookieFor(await login('123456'));
    const controller = new AbortController();
    const response = await request('/api/events?scope=all', { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); await reader.read();
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { cookie, origin: base } });
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(background.loop.running, true); background.loop.running = false;
    let text = '', next;
    while (!(next = await reader.read()).done) text += new TextDecoder().decode(next.value);
    assert.match(text, /event: auth-required/); controller.abort();
    assert.equal((await request('/api/accounts', { headers: { cookie } })).status, 401);
    assert.equal((await request('/api/accounts', { headers: { cookie: other } })).status, 200);
    cookie = other;
  });
  await test('服务重启后旧会话失效', async () => {
    await close(); await open();
    assert.equal((await request('/api/accounts', { headers: { cookie } })).status, 401);
  });
  await test('连续错误尝试限速，重启后重新登录', async () => {
    for (let index = 0; index < 5; index++) assert.equal((await login('bad')).status, 401);
    const response = await login('123456'); assert.equal(response.status, 429); assert(Number(response.headers.get('retry-after')) > 0);
    await close(); await open(); assert.equal((await login('123456')).status, 200);
  });
  await test('会话到期撤销访问并关闭日志流', async () => {
    const auth = createConsoleAuth({ loginPage: 'login', sessionMs: 200 });
    const server = http.createServer((req, res) => {
      if (auth.intercept(req, res)) return;
      if (!auth.authorize(req, res)) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' }); auth.trackStream(req, res); res.write('data: ready\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = 'http://127.0.0.1:' + server.address().port;
    try {
      const response = await fetch(address + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"123456"}' });
      const headers = { cookie: cookieFor(response) };
      const stream = await fetch(address + '/api/events', { headers, signal: AbortSignal.timeout(3000) });
      const reader = stream.body.getReader(); await reader.read();
      await delay(250);
      const ended = await reader.read(); assert.match(new TextDecoder().decode(ended.value), /auth-required/);
      assert.equal((await reader.read()).done, true);
      assert.equal((await fetch(address + '/api/auth/session', { headers })).status, 401);
    } finally { auth.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  assert.equal(connections, 0);
  console.log(`控制台密码鉴权专项 ${passed}/${passed} 通过（零游戏连接）`);
} finally {
  await close();
  assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true });
}
