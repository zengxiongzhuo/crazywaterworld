import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWechatDevice } from '../src/wechat/device.mjs';
import { wechatFailure } from '../src/wechat/diagnostics.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWechatLogin } from '../src/wechat-login.mjs';
import { exchangeWechatGameCode, WECHAT_GAME_APPID } from '../src/wechat/game-auth.mjs';

const watchdog = setTimeout(() => { throw Error('微信登录专项未在规定时间结束'); }, 15000);
const qrImage = 'data:image/png;base64,aGVsbG8=';
const credential = { source: 'wechat', url: 'wss://fixture.invalid', login: { eworldParams: { openId: 'fixture-openid', token: 'fixture-token', sign: 'fixture-sign', timestamp: 1 } } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(5); } throw Error('等待测试状态超时'); };
let passed = 0;
async function test(name, work) { await work(); passed++; console.log('通过：' + name); }
function fixture(overrides = {}) {
  const env = { time: 1000000, created: 0, closed: 0, codes: 0, exchanges: 0, phase: 'waiting', ...overrides };
  const login = createWechatLogin({ now: () => env.time, pollDelayMs: 1,
    createQr: async ({ signal }) => { env.created++; env.signal = signal; return { id: 'qr-fixture', qrImage, expiresAt: env.time + 300000,
      poll: async () => ({ phase: env.phase }), getLoginBuffer: async () => 'fixture-buffer', close() { env.closed++; } }; },
    getCode: async (buffer, options) => { assert.equal(buffer, 'fixture-buffer'); assert.equal(options.appId, WECHAT_GAME_APPID); assert(!('fetcher' in options)); env.codes++; return 'fixture-code'; },
    exchange: async code => { assert.equal(code, 'fixture-code'); env.exchanges++; return structuredClone(credential); }, ...env.options });
  return { env, login };
}
try {
  await test('同账号设备标识跨登录稳定，文件仅保存本机随机种子', async () => {
    const temporary = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(temporary, 'cw-wechat-device-'));
    try {
      const id = crypto.createHash('sha256').update('fixture-wechat-openid').digest('hex');
      const first = createWechatDevice(id, { directory }), second = createWechatDevice(id, { directory });
      assert.deepEqual(first, second);
      assert.notDeepEqual(first, createWechatDevice('b'.repeat(64), { directory }));
      const file = path.join(directory, 'wechat-device.json'), text = fs.readFileSync(file, 'utf8');
      assert(!text.includes(id)); assert(!text.includes('fixture-wechat-openid'));
      fs.writeFileSync(file, '{"version":99}');
      assert.throws(() => createWechatDevice(id, { directory }), /种子/);
      assert.equal(fs.readFileSync(file, 'utf8'), '{"version":99}');
    } finally { assert.equal(path.dirname(directory), temporary); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  await test('页面读取不发起登录，重复开始复用同一扫码会话且可找回丢失响应', async () => {
    const { env, login } = fixture();
    assert.equal(login.status().phase, 'cancelled'); assert.equal(env.created, 0);
    const [a, b] = await Promise.all([login.start(), login.start()]);
    assert.equal(a.id, b.id); assert.equal(env.created, 1); assert.equal(login.status().id, a.id);
    assert.equal(a.qrImage, qrImage); assert.equal(env.codes, 0);
    await login.cancel(a.id); assert.equal(env.closed, 1); assert.equal(login.status().qrImage, null);
    assert.throws(() => login.takeCredential(a.id)); await login.close();
  });
  await test('扫码后才取一次code，角色保存拥有独立有效期且公开状态不含凭据', async () => {
    const { env, login } = fixture(); const start = await login.start();
    env.time += 240000; env.phase = 'scanned'; await until(() => login.status().phase === 'scanned');
    env.phase = 'authorized'; await until(() => login.status().phase === 'captured');
    const state = login.status(); assert.equal(state.expiresAt, env.time + 600000); assert.equal(state.qrImage, null);
    assert.equal(env.codes, 1); assert.equal(env.exchanges, 1); assert.equal(env.closed, 1);
    assert(!JSON.stringify(state).includes('fixture-token'));
    const copy = login.takeCredential(start.id); copy.login.eworldParams.token = 'mutated';
    assert.equal(login.takeCredential(start.id).login.eworldParams.token, 'fixture-token');
    env.time += 600001; assert.equal(login.status().phase, 'expired'); assert.throws(() => login.takeCredential(start.id));
    await login.close();
  });
  await test('取消取码中的会话后不交换游戏凭据，晚到结果不能复活', async () => {
    const gate = deferred(); let requested = false;
    const { env, login } = fixture({ phase: 'authorized', options: { getCode: (_buffer, { signal }) => { requested = true; return gate.promise; } } });
    const start = await login.start(); await until(() => requested);
    await login.cancel(start.id); gate.resolve('late-code'); await sleep(5);
    assert.equal(env.exchanges, 0); assert.equal(login.status().phase, 'cancelled'); assert(env.signal.aborted);
    await login.close();
  });
  await test('二维码响应晚于取消时销毁会话，新扫码不被旧结果覆盖', async () => {
    const gate = deferred(); let closed = 0;
    const login = createWechatLogin({ createQr: () => gate.promise });
    const pending = login.start(), id = login.status().id;
    await login.cancel(id); assert.equal((await pending).phase, 'cancelled');
    gate.resolve({ qrImage, expiresAt: Date.now() + 10000, close() { closed++; } });
    await sleep(5); assert.equal(closed, 1); assert.equal(login.status().phase, 'cancelled'); await login.close();
  });
  await test('忽略取消的二维码或授权传输仍受总时限约束，错误不暴露底层票据', async () => {
    const login = createWechatLogin({ createQr: () => new Promise(() => {}), startTimeoutMs: 10 });
    assert.equal((await login.start()).phase, 'expired'); await login.close();
    const { login: failed } = fixture({ phase: 'authorized', options: { exchange: async () => { throw Error('secret=fixture-should-not-leak'); } } });
    await failed.start(); await until(() => failed.status().phase === 'error');
    assert(!JSON.stringify(failed.status()).includes('fixture-should-not-leak')); await failed.close();
  });
  await test('关闭服务清空凭据并拒绝新登录，旧会话ID不能取消新扫码', async () => {
    const { login } = fixture(); const first = await login.start(); await login.cancel(first.id);
    const second = await login.start(); assert.notEqual(second.id, first.id);
    await assert.rejects(login.cancel(first.id)); assert.equal(login.status().id, second.id);
    await login.close(); assert.equal(login.status().phase, 'cancelled'); await assert.rejects(login.start());
  });
  await test('游戏授权按已验证的渠道顺序换取凭据，code不进入日志或重定向', async () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicBody = publicKey.export({ type: 'spki', format: 'pem' }).replace(/-----[^\n]+-----|\s/g, '');
    const calls = [];
    const fetcher = async (url, options) => {
      const parsed = new URL(url); calls.push({ parsed, options });
      assert.equal(options.redirect, 'error'); assert(options.signal);
      if (parsed.pathname === '/api/public/info') return Response.json({ code: 0, data: { publicKey: publicBody } });
      if (parsed.pathname === '/api/init') {
        const body = JSON.parse(options.body); assert.equal(body.pn, WECHAT_GAME_APPID); assert(body.key);
        return Response.json({ code: 0, data: { initId: 'fixture-init', channel: { appId: 'fixture-channel', mchId: 'fixture-merchant' } } });
      }
      if (parsed.pathname === '/minigame') {
        const body = JSON.parse(decodeURIComponent(Buffer.from(options.body, 'base64').toString()));
        assert.equal(body.code, 'fixture-wx-code'); assert.equal(body.appid, 'fixture-channel');
        return new Response(Buffer.from(encodeURIComponent(JSON.stringify({ status: 200, mopenid: 'fixture-mopen', openid: 'fixture-channel-open', usertype: 1 }))).toString('base64'));
      }
      assert.equal(parsed.pathname, '/api/user/login');
      assert.equal(JSON.parse(options.body).channel.uid, 'fixture-mopen');
      return Response.json({ code: 0, data: { openId: 'fixture-game-open', signToken: 'fixture-game-token', sign: 'fixture-game-sign', ts: 1700000000 } });
    };
    const result = await exchangeWechatGameCode('fixture-wx-code', { fetcher });
    assert.deepEqual(calls.map(call => call.parsed.pathname), ['/api/public/info', '/api/init', '/minigame', '/api/user/login']);
    assert.equal(result.source, 'wechat'); assert.equal(result.login.eworldParams.timestamp, 1700000000000);
    assert.equal(result.login.eworldParams.openId, 'fixture-game-open');
    assert(calls.every(call => !call.parsed.href.includes('fixture-wx-code')));
  });
  await test('游戏授权取消、异常公钥和服务器拒绝不会继续下一阶段', async () => {
    const abort = new AbortController(); abort.abort(); let requests = 0;
    await assert.rejects(exchangeWechatGameCode('fixture', { signal: abort.signal, fetcher: async () => { requests++; } }));
    assert.equal(requests, 0);
    await assert.rejects(exchangeWechatGameCode('fixture', { fetcher: async () => Response.json({ code: 0, data: { publicKey: 'invalid' } }) }), /公钥/);
    await assert.rejects(exchangeWechatGameCode('fixture', { fetcher: async () => Response.json({ code: 1, message: 'secret=fixture' }) }), /拒绝/);
  });
  await test('失败显示具体阶段与安全状态码，日志不回显票据或上游正文', async () => {
    const events = [];
    const error = Object.assign(Error('secret=fixture-secret cookie=fixture-cookie https://example.invalid/?code=fixture-code'), {
      code: 'WECHAT_BUFFER_REJECTED', statusCode: 40001, httpStatus: 200,
      body: { token: 'fixture-token' }, responseCode: 'fixture-private-value',
    });
    const login = createWechatLogin({
      createQr: async () => ({ id: 'fixture', qrImage, expiresAt: Date.now() + 10000,
        poll: async () => ({ phase: 'authorized' }), getLoginBuffer: async ({ onStage }) => { onStage('ticket'); throw error; }, close() {} }),
      onEvent: event => events.push(event),
    });
    try {
      await login.start(); await until(() => login.status().phase === 'error');
      assert.match(login.status().error, /微信登录票据获取失败/);
      assert.match(login.status().error, /WX_TICKET_REJECTED/);
      assert.deepEqual(login.status().diagnostic, { stage: 'ticket', code: 'REJECTED', httpStatus: 200, statusCode: 40001 });
      assert.equal(events.length, 1);
      assert.doesNotMatch(JSON.stringify([login.status(), events]), /fixture-secret|fixture-cookie|fixture-code|fixture-token|fixture-private/);
    } finally { await login.close(); }
    const unknown = wechatFailure(Error('opaque-user-secret'), 'opaque-user-secret');
    assert.equal(unknown.diagnostic.stage, 'code');
    assert.doesNotMatch(JSON.stringify(unknown), /opaque-user-secret/);
    const game = wechatFailure(Object.assign(Error('游戏授权失败'), { code: 'WECHAT_GAME_REJECTED', responseCode: 403, httpStatus: 200 }), 'game-channel');
    assert.equal(game.diagnostic.statusCode, 403);
    assert.match(game.message, /游戏渠道授权失败/);
  });
  console.log(`微信扫码控制器与游戏授权 ${passed}/${passed} 通过（假网络，零游戏连接）`);
} finally { clearTimeout(watchdog); }
