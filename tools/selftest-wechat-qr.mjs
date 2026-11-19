import assert from 'node:assert/strict';
import { createWechatQrSession } from '../src/wechat/qr-session.mjs';
import { createWechatHttp } from '../src/wechat/http.mjs';
import { fetchWechatLoginBuffer, validateLoginBuffer, WECHAT_BUFFER_URL } from '../src/wechat/login-buffer.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42Y42Y=', 'base64');
// Published upstream 1x1 PNG fixture, independent of our validation code.
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const buffer = 'CgZ0aWNrZXQSBmRldmljZQ==';
const credentials = { openid: 'fixture-open', accessToken: 'fixture-access', refreshToken: 'fixture-refresh' };
const success = () => new Response(JSON.stringify({ code: 0, ext_info: { list_s: { login_buffer: { value: [buffer] } } } }), { headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('通过：' + name); }

function fixture({ poll, callback, loginBuffer, html, qrImage } = {}) {
  const calls = [];
  const fetcher = async (value, options) => {
    const url = new URL(value); calls.push({ url, options });
    if (url.pathname === '/connect/qrconnect') return new Response(html ?? '<img src="/connect/qrcode/test-uuid">', { headers: { 'set-cookie': 'wxsession=wx-only; Domain=weixin.qq.com; Path=/; Secure' } });
    if (url.pathname === '/connect/qrcode/test-uuid') return new Response(qrImage ?? image, { headers: { 'content-type': 'image/png' } });
    if (url.hostname === 'long.open.weixin.qq.com') return poll ? poll(url, options) : new Response("window.wx_errcode=405;window.wx_code='fixture-authorization';");
    if (url.pathname === '/pc_yyb/pcyyb_oauth') {
      if (callback) return callback(url, options);
      const headers = new Headers();
      for (const [name, value] of [['openid', credentials.openid], ['accesstoken', credentials.accessToken], ['refreshtoken', credentials.refreshToken]]) headers.append('set-cookie', `${name}=${value}; Domain=.qq.com; Path=/; Secure; HttpOnly`);
      return new Response('authorized', { headers });
    }
    if (value === WECHAT_BUFFER_URL) return loginBuffer ? loginBuffer(url, options) : success();
    throw Error('unexpected fixture request');
  };
  return { calls, fetcher };
}

await test('票据请求字段顺序与签名固定向量一致，Cookie只发往应用宝接口', async () => {
  let count = 0;
  const result = await fetchWechatLoginBuffer(credentials, { now: () => 1700000000123, nonce: () => '42', fetcher: async (url, options) => {
    count++; assert.equal(url, WECHAT_BUFFER_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert.equal(options.body, '{"extInfo":{"listS":{"unionid":{"value":["fixture-open"]},"user_id":{"value":["fixture-open"]},"access_token":{"value":["fixture-access"]}},"listI":{"user_type":{"value":[0]}}}}');
    assert.equal(options.headers.get('Ual-Access-Signature'), '4cab91473d37f4a1d5e6a1b097a5fb07');
    assert.equal(options.headers.get('Ual-Access-Businessid'), 'pc_yyb_auth');
    assert.equal(options.headers.get('cookie'), 'openid=fixture-open; accesstoken=fixture-access; refreshtoken=fixture-refresh');
    return success();
  } });
  assert.equal(result, buffer); assert.equal(count, 1);
});

await test('票据响应要求显式整数成功码，不把拒绝或含敏感信息的错误当作成功', async () => {
  for (const raw of ['{}', '{"code":null}', '{"code":false}', '{"code":0.5}', '{"code":0.0}', '{"code":0e0}', '{"code":2147483648}', '{"code":0,"code":0}', '{"code":"fixture-access"}', '{"code":1,"msg":"fixture-access fixture-refresh"}']) {
    await assert.rejects(fetchWechatLoginBuffer(credentials, { fetcher: async () => new Response(raw) }), error => !/fixture-access|fixture-refresh/.test(error.message));
  }
  assert.equal(await fetchWechatLoginBuffer(credentials, { fetcher: async () => new Response(JSON.stringify({ code: '0', ext_info: { list_s: { login_buffer: { value: [buffer] } } } })) }), buffer);
  for (const value of ['', '%%%', 'AAAA\n', 'Zh==', 'A'.repeat(90000)]) assert.throws(() => validateLoginBuffer(value));
  await assert.rejects(fetchWechatLoginBuffer({ ...credentials, accessToken: 'bad\r\nheader' }, { fetcher: () => { throw Error('must not fetch'); } }), /完整凭据/);
});

await test('扫码状态和应用宝固定state与参考协议一致，凭据只保留在内部内存', async () => {
  const statuses = ['408', '404', "405;window.wx_code='fixture-authorization'"];
  const f = fixture({ poll: () => new Response('window.wx_errcode=' + statuses.shift() + ';') });
  const session = await createWechatQrSession({ fetcher: f.fetcher });
  assert.equal(session.qrImage, 'data:image/png;base64,' + image.toString('base64'));
  assert.equal((await session.poll()).phase, 'waiting');
  assert.equal((await session.poll()).phase, 'scanned');
  assert.deepEqual(await session.poll(), { phase: 'authorized' });
  assert.equal(session.qrImage, '');
  assert.equal(await session.getLoginBuffer(), buffer);
  assert.equal(await session.getLoginBuffer(), buffer);
  const initial = f.calls[0].url, callback = f.calls.find(call => call.url.pathname === '/pc_yyb/pcyyb_oauth');
  assert.equal(initial.searchParams.get('state'), 'web');
  assert.equal(callback.url.searchParams.get('state'), initial.searchParams.get('state'));
  assert.equal(callback.options.headers.get('cookie'), null, '微信Cookie不能发送给应用宝');
  assert.equal(f.calls.filter(call => call.url.href === WECHAT_BUFFER_URL).length, 1);
  assert.equal(f.calls.find(call => call.url.hostname === 'long.open.weixin.qq.com').options.headers.get('cookie'), 'wxsession=wx-only');
  assert(!JSON.stringify(session).includes('fixture-access')); session.close();
  await assert.rejects(session.poll(), { name: 'AbortError' });
});

await test('授权身份摘要仅供内部稳定设备派生，不可枚举且关闭后清除', async () => {
  const create = async openid => {
    const f = fixture({ callback: () => {
      const headers = new Headers();
      headers.append('set-cookie', 'openid=' + openid + '; Path=/; Secure');
      headers.append('set-cookie', 'accesstoken=fixture-access; Path=/; Secure');
      return new Response('authorized', { headers });
    } });
    return createWechatQrSession({ fetcher: f.fetcher });
  };
  const first = await create('openid-a'), again = await create('openid-a'), second = await create('openid-b');
  try {
    assert.equal(first.identityKey, null);
    for (const session of [first, again, second]) {
      const state = await session.poll();
      assert.equal(session.identityKey, null, '轮询确认后尚未完成授权回调');
      assert(!('identityKey' in state));
      await session.getLoginBuffer();
      assert.match(session.identityKey, /^[a-f0-9]{64}$/);
      assert(!Object.keys(session).includes('identityKey'));
      assert(!JSON.stringify(session).includes(session.identityKey));
      assert.equal(Reflect.set(session, 'identityKey', 'changed'), false);
    }
    assert.equal(first.identityKey, again.identityKey);
    assert.notEqual(first.identityKey, second.identityKey);
    assert.notEqual(first.id, again.id, '独立扫码会话仍使用不同UUID');
  } finally { first.close(); again.close(); second.close(); }
  assert.equal(first.identityKey, null);
  assert.equal(again.identityKey, null);
  assert.equal(second.identityKey, null);
});

await test('Cookie遵守来源分组、路径、过期，重定向不泄漏Cookie或签名', async () => {
  let time = 0;
  const transport = createWechatHttp({ now: () => time, fetcher: async (url, options) => {
    if (new URL(url).pathname === '/set') return new Response('', { headers: { 'set-cookie': 'secret=value; Domain=qq.com; Path=/pc_yyb; Max-Age=2' } });
    if (new URL(url).pathname === '/redirect') return new Response('', { status: 302, headers: { location: 'https://open.weixin.qq.com/next' } });
    if (new URL(url).pathname === '/same') return new Response('', { status: 302, headers: { location: '/ok', 'set-cookie': 'same=ok; Path=/' } });
    if (new URL(url).pathname === '/ok') assert.match(options.headers.get('cookie'), /same=ok/);
    return new Response('');
  } });
  await transport.request('https://yybadaccess.3g.qq.com/set');
  assert.deepEqual(transport.cookies('https://yybadaccess.3g.qq.com/pc_yyb/callback'), [{ name: 'secret', value: 'value' }]);
  assert.deepEqual(transport.cookies('https://yybadaccess.3g.qq.com/pc_yyb_other'), []);
  assert.deepEqual(transport.cookies('https://open.weixin.qq.com/pc_yyb'), []);
  time = 2001; assert.deepEqual(transport.cookies('https://yybadaccess.3g.qq.com/pc_yyb'), []);
  await assert.rejects(transport.request('https://yybadaccess.3g.qq.com/redirect', { redirects: 3 }), /跨域/);
  await assert.rejects(transport.request('https://yybadaccess.3g.qq.com/redirect', { method: 'POST', body: 'fixture-secret', redirects: 3 }), /跳转/);
  await transport.request('https://yybadaccess.3g.qq.com/same', { redirects: 1 });
  for (const url of ['http://open.weixin.qq.com/', 'https://open.weixin.qq.com.evil.invalid/', 'https://secret@open.weixin.qq.com/', 'https://open.weixin.qq.com:8443/']) await assert.rejects(transport.request(url), /地址/);
  transport.close(); assert.deepEqual(transport.cookies('https://yybadaccess.3g.qq.com/ok'), []);
});

await test('授权回调设置完整Cookie后跳转即可取票据，不访问外站且阶段观察失败不影响登录', async () => {
  const f = fixture({ callback: () => {
    const headers = new Headers({ location: 'https://sj.qq.com/ignored?code=must-not-forward' });
    for (const [name, value] of [['openid', credentials.openid], ['accesstoken', credentials.accessToken], ['refreshtoken', credentials.refreshToken]]) {
      headers.append('set-cookie', `${name}=${value}; Path=/; Secure; HttpOnly`);
    }
    return new Response('', { status: 302, headers });
  } });
  const session = await createWechatQrSession({ fetcher: f.fetcher }), stages = [];
  try {
    await session.poll();
    const result = await session.getLoginBuffer({ onStage: name => {
      stages.push(name);
      if (name === 'callback') throw Error('observer failure');
      return Promise.reject(Error('async observer failure'));
    } });
    await turn();
    assert.equal(result, buffer);
    assert.deepEqual(stages, ['callback', 'ticket']);
    assert.equal(f.calls.filter(call => call.url.pathname === '/pc_yyb/pcyyb_oauth').length, 1);
    assert.equal(f.calls.filter(call => call.url.href === WECHAT_BUFFER_URL).length, 1);
    assert(f.calls.every(call => call.url.hostname !== 'sj.qq.com'));
  } finally { session.close(); }
});

await test('带引号的Cookie去掉外层引号，签名字段保留原百分号编码', async () => {
  let ticketRequests = 0;
  const f = fixture({ callback: () => {
    const headers = new Headers();
    headers.append('set-cookie', 'openid="fixture%2Bid"; Path=/; Secure');
    headers.append('set-cookie', 'accesstoken="fixture%2Btoken"; Path=/; Secure');
    headers.append('set-cookie', 'refreshtoken="fixture%2Brefresh"; Path=/; Secure');
    return new Response('', { headers });
  }, loginBuffer: (_url, options) => {
    ticketRequests++;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.extInfo.listS.user_id.value, ['fixture%2Bid']);
    assert.deepEqual(body.extInfo.listS.access_token.value, ['fixture%2Btoken']);
    assert.equal(options.headers.get('cookie'), 'openid=fixture%2Bid; accesstoken=fixture%2Btoken; refreshtoken=fixture%2Brefresh');
    return success();
  } });
  const session = await createWechatQrSession({ fetcher: f.fetcher });
  try { await session.poll(); assert.equal(await session.getLoginBuffer(), buffer); assert.equal(ticketRequests, 1); }
  finally { session.close(); }
  const transport = createWechatHttp({ fetcher: async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a="unterminated; Path=/');
    headers.append('set-cookie', 'b=mis"quoted; Path=/');
    headers.append('set-cookie', 'c="bad\\slash"; Path=/');
    return new Response('', { headers });
  } });
  await transport.request('https://yybadaccess.3g.qq.com/');
  assert.deepEqual(transport.cookies('https://yybadaccess.3g.qq.com/'), []); transport.close();
});

await test('旧Cookie、缺失凭据或HTTP失败不能完成回调，其他请求仍禁止跨站跳转', async () => {
  const callback = 'https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_oauth?code=fixture-code&state=web';
  for (const scenario of ['none', 'partial', 'wrong-path', 'expired', 'http-error', 'ordinary']) {
    const calls = [];
    const transport = createWechatHttp({ fetcher: async url => {
      const current = new URL(url); calls.push(current.hostname);
      const headers = new Headers({ location: 'https://sj.qq.com/' });
      if (current.pathname === '/seed') {
        headers.append('set-cookie', 'openid=old-id; Path=/');
        headers.append('set-cookie', 'accesstoken=old-token; Path=/');
        return new Response('', { headers });
      }
      if (scenario !== 'none') {
        const suffix = scenario === 'wrong-path' ? 'Path=/other' : scenario === 'expired' ? 'Path=/; Max-Age=0' : 'Path=/';
        headers.append('set-cookie', 'openid=new-id; ' + suffix);
        if (scenario !== 'partial') headers.append('set-cookie', 'accesstoken=new-token; ' + suffix);
      }
      return new Response('', { status: scenario === 'http-error' ? 500 : 302, headers });
    } });
    await transport.request('https://yybadaccess.3g.qq.com/seed');
    await assert.rejects(transport.request(callback, { redirects: 3,
      ...(scenario === 'ordinary' ? {} : { completeOnCookies: ['openid', 'accesstoken'] }),
    }), /跳转|HTTP 500/);
    assert.deepEqual(calls, ['yybadaccess.3g.qq.com', 'yybadaccess.3g.qq.com']);
    transport.close();
  }
  let requests = 0;
  const invalid = createWechatHttp({ fetcher: async () => { requests++; throw Error('unexpected'); } });
  await assert.rejects(invalid.request('https://open.weixin.qq.com/', { completeOnCookies: ['openid', 'accesstoken'] }), /回调选项/);
  await assert.rejects(invalid.request(callback, { method: 'POST', completeOnCookies: ['openid', 'accesstoken'] }), /回调选项/);
  assert.equal(requests, 0); invalid.close();
});

await test('二维码图片、状态响应和响应长度严格检查，不接受HTML或执行脚本', async () => {
  for (const qrImage of [Buffer.from('<html>blocked</html>'), png]) await assert.rejects(createWechatQrSession({ fetcher: fixture({ qrImage }).fetcher }), /图片无效/);
  await assert.rejects(createWechatQrSession({ fetcher: fixture({ html: '<img src="/connect/qrcode/../escape">' }).fetcher }), /获取微信登录二维码/);
  const session = await createWechatQrSession({ fetcher: fixture({ poll: () => new Response("window.wx_errcode=405;window.wx_code='bad</script>';throw Error('secret')") }).fetcher });
  await assert.rejects(session.poll(), /有效凭据/); session.close();
  const transport = createWechatHttp({ fetcher: async () => new Response(new Uint8Array(20)) });
  await assert.rejects(transport.request('https://open.weixin.qq.com/', { maxBytes: 10 }), /响应过大/);
  await assert.rejects(createWechatHttp({ fetcher: async () => new Response('SECRET', { status: 500 }) }).request('https://open.weixin.qq.com/'), error => !error.message.includes('SECRET'));
});

await test('二维码过期和用户取消不会继续授权请求', async () => {
  let time = 1000;
  const f = fixture();
  const session = await createWechatQrSession({ fetcher: f.fetcher, now: () => time, ttlMs: 100 });
  const count = f.calls.length; time += 101;
  await assert.rejects(session.poll(), /过期/); assert.equal(f.calls.length, count); session.close();
  const cancelled = await createWechatQrSession({ fetcher: fixture({ poll: () => new Response('window.wx_errcode=403;') }).fetcher });
  assert.equal((await cancelled.poll()).phase, 'expired'); assert.equal(cancelled.qrImage, '');
  await assert.rejects(cancelled.getLoginBuffer(), /重新获取/); cancelled.close();
});

await test('临近二维码到期扫码成功后有独立授权期限，跨原期限可完成但不会无限续期', async () => {
  let time = 0;
  const f = fixture({ loginBuffer: () => { time = 300001; return success(); } });
  const session = await createWechatQrSession({ fetcher: f.fetcher, now: () => time });
  time = 299000;
  assert.deepEqual(await session.poll(), { phase: 'authorized' });
  assert.equal(session.expiresAt, 300000, '对外保留原二维码到期时间');
  assert.equal(await session.getLoginBuffer(), buffer, '授权交换跨过原二维码期限仍可完成');
  const calls = f.calls.length;
  time = 419000;
  await assert.rejects(session.getLoginBuffer(), /授权已超时/);
  assert.equal(f.calls.length, calls, '新的授权期限结束后不能重发');
  session.close();
});

await test('轮询与取票据各自单飞，调用者中断不接受晚到结果', async () => {
  const gate = deferred(); let polls = 0;
  const f = fixture({ poll: () => { polls++; return gate.promise; } });
  const session = await createWechatQrSession({ fetcher: f.fetcher });
  const first = session.poll(), second = session.poll(); await turn(); assert.equal(polls, 1);
  gate.resolve(new Response("window.wx_errcode=405;window.wx_code='fixture-code';"));
  await Promise.all([first, second]);
  await Promise.all([session.getLoginBuffer(), session.getLoginBuffer()]);
  assert.equal(f.calls.filter(call => call.url.pathname === '/pc_yyb/pcyyb_oauth').length, 1);
  assert.equal(f.calls.filter(call => call.url.href === WECHAT_BUFFER_URL).length, 1); session.close();
  const late = deferred(); const aborted = await createWechatQrSession({ fetcher: fixture({ poll: () => late.promise }).fetcher });
  const waiting = aborted.poll(); await turn(); aborted.close();
  await assert.rejects(waiting, { name: 'AbortError' });
  late.resolve(new Response("window.wx_errcode=405;window.wx_code='late-code';")); await turn();
  await assert.rejects(aborted.getLoginBuffer(), { name: 'AbortError' });
});

await test('授权回调失败不重复消费code，取票据临时失败只重试取票据', async () => {
  let callbacks = 0;
  const failed = await createWechatQrSession({ fetcher: fixture({ callback: () => { callbacks++; throw Error('fixture-access'); } }).fetcher });
  await failed.poll();
  await assert.rejects(failed.getLoginBuffer(), error => !error.message.includes('fixture-access'));
  await assert.rejects(failed.getLoginBuffer(), /重新获取/); assert.equal(callbacks, 1); failed.close();
  let attempts = 0;
  const f = fixture({ loginBuffer: () => ++attempts === 1 ? new Response('', { status: 503 }) : success() });
  const retry = await createWechatQrSession({ fetcher: f.fetcher }); await retry.poll();
  await assert.rejects(retry.getLoginBuffer(), /HTTP 503/); assert.equal(await retry.getLoginBuffer(), buffer);
  assert.equal(f.calls.filter(call => call.url.pathname === '/pc_yyb/pcyyb_oauth').length, 1); retry.close();
});

await test('超时可终止忽略AbortSignal的传输，轮询超时保持等待', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const transport = createWechatHttp({ fetcher: () => new Promise(() => {}) });
    await assert.rejects(transport.request('https://open.weixin.qq.com/', { timeoutMs: 10 }), { name: 'TimeoutError' });
    const session = await createWechatQrSession({ fetcher: fixture({ poll: () => new Promise(() => {}) }).fetcher, pollTimeoutMs: 10 });
    assert.equal((await session.poll()).phase, 'waiting'); session.close();
    const signal = AbortSignal.abort(); let called = false;
    await assert.rejects(createWechatQrSession({ signal, fetcher: () => { called = true; } }), { name: 'AbortError' }); assert.equal(called, false);
  } finally { clearTimeout(keepAlive); }
});

console.log(`微信二维码与授权票据专项 ${passed}/${passed} 通过（假网络，不连接微信或游戏）`);
