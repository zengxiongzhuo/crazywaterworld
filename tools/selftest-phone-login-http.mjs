import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cw-phone-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_EWAN_DEVICE = path.join(directory, 'custom-device.json');
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_CA_DIR = path.join(directory, 'certificates');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { createConsole } = await import('../src/server.mjs');
const { loadStore } = await import('../src/accounts.mjs');
const { GameClient } = await import('../src/client.mjs');
const { describeRole, listGroup } = await import('../src/worlds.mjs');
const { PHONE_LOGIN, encryptForm, decryptBody, loadDeviceProfile } = await import('../src/phone-login.mjs');
const nativeFetch = globalThis.fetch;
const profileOaid = 'oaid-' + '12'.repeat(15);
const profile = {
  di: encryptForm('cd'.repeat(8)).toUpperCase(), oi: encryptForm(profileOaid).toUpperCase(),
  deviceCode: 'CD'.repeat(8), model: '测试设备', business_did: 'legacy-did',
};
const phone = '13800138000';
const password = 'test-password-http';
const { publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const publicKeyBase64 = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const channelAppKey = 'http-channel-app-key';
const sdkInitKey = crypto.createHash('md5').update(channelAppKey).digest('hex').slice(8, 24);
let smsAttempts = 0;
let accountAttempts = 0;
let sdkInitFailure = false;
let smsFailure = false;
let smsGate = null;
let smsStarted = null;
let passwordFailure = false;
let secondAccountFailure = false;
let gameToken = 'fixture-token';
let externalCalls = 0;
const roleFailures = new Set();
const liveClients = new Set();
const connections = [];
const sdkDevices = [];
const sdkInitializations = [];
const businessDevices = [];
let stoppedClients = 0;
let interleavedReads = 0;
const roleLists = new Map([
  ['fixture-game-id', [
    { worldId: 3000000001, roleInfo: { id: 11, nickname: '海风船长', level: 28, power: 12345, worldId: 3000000010 } },
    { worldId: 3000000002, roleInfo: { id: 12, nickname: '星海船长', level: 42, power: 23456, worldId: 3000000002 } },
    { worldId: 3000000003 },
    { worldId: 3000000004, roleInfo: {} },
    { worldId: 3000000005, roleInfo: { id: 0, nickname: '空角色' } },
  ]],
  ['fixture-game-id-2', [{ worldId: 4000000008, roleInfo: { id: 21, nickname: '灯塔守望', level: 33, power: 34567, worldId: 4000000008 } }]],
]);
Object.defineProperty(GameClient.prototype, 'connected', { get() { return liveClients.has(this); } });
GameClient.prototype.connect = async function (login) {
  this.login = login;
  this.stopping = false;
  connections.push({ client: this, login });
  liveClients.add(this);
  const roles = roleLists.get(login.eworldParams.openId) || [];
  const role = (roles.find(row => row.worldId === login.worldId) ?? roles[0])?.roleInfo;
  return { result: 0, playerInfo: role && { ...role, playerId: role.id } };
};
GameClient.prototype.send = () => {};
GameClient.prototype.sendWatch = async () => ({});
GameClient.prototype.request = async function (name) {
  if (name === 'OnWaterRequest') return { building: [] };
  if (name === 'AllItemRequest') return { items: [] };
  if (name === 'EmailBoxRequest') return { email: [] };
  if (name !== 'GameWorldListRequest') return {};
  const id = this.login.eworldParams.openId;
  if (roleFailures.has(id)) throw new Error('模拟角色列表读取超时');
  return { recentWorlds: roleLists.get(id) || [], latestGroupId: 1 };
};
GameClient.prototype.interleaveRead = async function (work) { interleavedReads++; return work(); };
GameClient.prototype.stop = function () { this.stopping = true; liveClients.delete(this); stoppedClients++; };

globalThis.fetch = async (url, options) => {
  externalCalls++;
  const config = PHONE_LOGIN;
  const parsed = new URL(url);
  if (parsed.origin === config.businessBase) {
    assert.equal(options.headers.ai, config.business.appId);
    assert.equal(options.headers.pi, config.business.packetId);
    assert.equal(options.headers.ci, config.business.channelId);
    assert.equal(options.headers.cv, config.business.sdkVersion);
    assert.equal(parsed.searchParams.get('bai'), String(config.business.bai));
    assert.equal(parsed.searchParams.get('bci'), String(config.business.bci));
    if (parsed.pathname === '/api/init') {
      const body = JSON.parse(options.body);
      assert.equal(body.pn, config.business.packageName);
      assert.equal(body.appVersion, config.business.appVersion);
      businessDevices.push({ did: body.did, dc: body.dc });
    }
    const sdkId = options.body ? JSON.parse(options.body)?.channel?.uid : null;
    const bodies = {
      '/api/public/info': { publicKey: publicKeyBase64 },
      '/api/init': { initId: 'fixture-init', channel: { appKey: channelAppKey } },
      '/api/user/login': { openId: sdkId === 'fixture-sdk-id-2' ? 'fixture-game-id-2' : 'fixture-game-id', token: gameToken, sign: 'fixture-sign', ts: Date.now() },
    };
    assert.ok(bodies[parsed.pathname], 'unexpected game login request');
    return Response.json({ code: 0, data: bodies[parsed.pathname] });
  }
  if (parsed.origin === 'https://duoinitsdk.ewan.cn' && parsed.pathname === '/weplay') {
    assert.equal(parsed.searchParams.get('requestid'), config.appId);
    const fields = new URLSearchParams(decryptBody(options.body, sdkInitKey));
    assert.equal(fields.get('protocol'), '400008');
    assert.equal(fields.get('appid'), config.appId);
    assert.equal(fields.get('packetid'), config.packetId);
    assert.equal(options.headers.ai, config.appId);
    assert.equal(options.headers.pi, config.packetId);
    assert.equal(options.headers.cv, config.sdkVersion);
    assert.equal(decryptBody(options.headers.di, sdkInitKey), fields.get('devicecode'));
    const expectedOaid = loadDeviceProfile().source === 'imported' ? profileOaid : '';
    assert.equal(decryptBody(options.headers.oi, sdkInitKey), expectedOaid);
    sdkInitializations.push({ deviceCode: fields.get('devicecode') });
    const payload = sdkInitFailure
      ? { status: -100, error: 1001, errorMsg: '模拟 SDK 初始化失败' }
      : { status: 200, k: config.aesKey, loginurl: config.loginUrl, accounturl: config.accountUrl };
    return new Response(encryptForm(JSON.stringify(payload), sdkInitKey));
  }
  assert.ok([config.loginUrl, config.accountUrl].includes(String(url)), 'unexpected external request');
  const fields = new URLSearchParams(decryptBody(options.body, config.aesKey));
  assert.equal(options.headers.ai, config.appId);
  assert.equal(options.headers.pi, config.packetId);
  assert.equal(options.headers.cv, config.sdkVersion);
  assert.equal(fields.get('appid'), config.appId);
  assert.equal(fields.get('superappid'), config.superAppId);
  assert.equal(fields.get('packetid'), config.packetId);
  assert.equal(fields.get('channel'), config.channel);
  assert.equal(fields.get('packagename'), config.packageName);
  assert.equal(fields.get('appversion'), config.appVersion);
  assert.equal(fields.get('appversioncode'), config.appVersionCode);
  sdkDevices.push({ di: options.headers.di, oi: options.headers.oi, deviceCode: fields.get('devicecode') });
  let payload;
  if (fields.get('protocol') === '100015') {
    smsAttempts++;
    smsStarted?.();
    await smsGate;
    if (smsFailure) throw new Error('fixture SMS offline');
    payload = { status: 200, validatecode: '' };
  } else if (fields.get('protocol') === '420012') {
    accountAttempts++;
    payload = {
      status: 200,
      userAccount: [
        { userName: '测试账号一', multiAccountToken: 'first-token' },
        { userName: '测试账号二', multiAccountToken: 'second-token' },
      ],
    };
  } else if (passwordFailure) {
    accountAttempts++;
    payload = { status: -100, error: 1068, errorMsg: '用户名或密码错误' };
  } else {
    accountAttempts++;
    assert.ok(['100003', '420007'].includes(fields.get('protocol')));
    const second = fields.get('multiAccountToken') === 'second-token';
    payload = second && secondAccountFailure ? { status: -100, error: 1002, errorMsg: '模拟第二账号认证失败' }
      : { status: 200, openId: second ? 'fixture-sdk-id-2' : 'fixture-sdk-id', token: 'fixture-sdk-token', username: second ? '测试账号二' : '测试账号一' };
  }
  return new Response(encryptForm(JSON.stringify(payload)));
};

const app = createConsole({ port: 0,
  protocol: { OnWaterRequest: true, OnWaterResponse: true, AllItemRequest: true, AllItemResponse: true },
  captureController: { inspectCaptureRecovery: () => ({ pending: false }) } });
let closed = false;
try {
  const root = await app.listen();
  const selectedId = () => loadStore().selectedRoles['fixture-game-id'];
  const selectedAccount = () => loadStore().accounts.find(row => row.id === selectedId());
  async function request(route, body) {
    const response = await nativeFetch(root + '/api/accounts/phone-login' + route, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return { status: response.status, data };
  }
  async function accountApi(route, body, id = selectedId() || 'fixture-game-id') {
    const response = await nativeFetch(root + '/api/' + route + '?account=' + encodeURIComponent(id), {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify({ confirm: true, ...body }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  }
  async function waitForLoop(id, worldId) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const session = app.sessions.get(id);
      if (session?.loop.running && session.loop.completed >= 1 && session.client?.connected
        && session.client.login.worldId === worldId) return session;
      await sleep(10);
    }
    const session = app.sessions.get(id);
    assert.fail('等待所选角色自动挂机超时 ' + JSON.stringify({ running: session?.loop.running, completed: session?.loop.completed,
      stopping: session?.loop.controller?.signal.aborted, error: session?.loop.error, login: session?.client?.login.worldId,
      log: session?.log.slice(-8) }));
  }
  async function disconnect(id) {
    const job = app.sessions.get(id)?.loop.job;
    const result = await nativeFetch(root + '/api/disconnect?account=' + encodeURIComponent(id), {
      method: 'POST', body: JSON.stringify({ confirm: true }),
    });
    assert.equal(result.status, 200);
    await job;
  }

  const missing = await request('/status');
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.data, {
    deviceReady: false, devicePath: process.env.CW_EWAN_DEVICE, deviceModel: null, deviceSource: null, deviceError: null,
  });
  assert.equal(fs.existsSync(process.env.CW_EWAN_DEVICE), false, '只查询状态不创建档案');

  assert.equal(externalCalls, 0, '查询设备状态无需请求外部服务');

  // 无需导入档案即可经过发短信、验证和角色列表读取，两个 API 共用持久设备。
  const generatedPhone = '13700137000';
  sdkInitFailure = true;
  const failedSmsInit = await request('/send-code', { confirm: true, phone: generatedPhone });
  assert.equal(failedSmsInit.status, 400);
  assert.match(failedSmsInit.data.error, /模拟 SDK 初始化失败/);
  const failedLoginInit = await request('', { confirm: true, phone: generatedPhone, password });
  assert.equal(failedLoginInit.status, 400);
  assert.match(failedLoginInit.data.error, /模拟 SDK 初始化失败/);
  assert.equal(smsAttempts, 0);
  assert.equal(accountAttempts, 0);
  assert.equal(sdkDevices.length, 0);
  assert.equal(connections.length, 0);
  const deviceAfterFailedInit = loadDeviceProfile();
  sdkInitFailure = false;
  assert.equal((await request('/send-code', { confirm: true, phone: generatedPhone })).status, 200);
  const generated = loadDeviceProfile();
  assert.deepEqual(generated, deviceAfterFailedInit);
  assert.equal(generated.source, 'generated');
  assert.equal(decryptBody(generated.di), generated.deviceCode);
  assert.equal(decryptBody(generated.oi), '');
  const generatedPreview = await request('', { confirm: true, phone: generatedPhone, code: '123456' });
  assert.equal(generatedPreview.status, 200);
  assert.equal(generatedPreview.data.choices.length, 3);
  assert.equal(connections.at(-1).login.eworldClientInfo.appId, PHONE_LOGIN.superAppId);
  const generatedStatus = await request('/status');
  assert.equal(generatedStatus.data.deviceReady, true);
  assert.equal(generatedStatus.data.deviceSource, 'generated');
  assert.equal(generatedStatus.data.deviceError, null);
  assert.equal(JSON.stringify(generatedStatus.data).includes(generated.di), false);
  for (const device of sdkDevices) {
    assert.deepEqual(device, { di: generated.di, oi: generated.oi, deviceCode: generated.deviceCode });
    assert.equal(decryptBody(device.di), device.deviceCode);
    assert.equal(decryptBody(device.oi), '');
  }
  assert.equal(sdkInitializations.length, 4, '失败的两次请求与成功的两个客户端分别初始化一次');
  assert.equal(businessDevices.length, 4, '认证和游戏登录共用同一客户端的业务初始化');
  for (const initialized of sdkInitializations) {
    assert.equal(initialized.deviceCode, generated.deviceCode);
  }
  for (const initialized of businessDevices) {
    assert.deepEqual(initialized, { did: generated.businessDid, dc: generated.businessDeviceCode });
  }
  assert.equal((await request('/cancel', { id: generatedPreview.data.id })).status, 200);
  assert.equal(loadStore().accounts.length, 0);

  // 旧请求的 channel 字段仍使用统一配置，账号认证和角色凭证保持一致。
  assert.equal(PHONE_LOGIN.appId, '56000002');
  assert.equal(PHONE_LOGIN.superAppId, '14021102');
  assert.equal(PHONE_LOGIN.packetId, '259237');
  roleFailures.add('fixture-game-id');
  const legacyPassword = await request('', { confirm: true, phone, password, channel: 'xiaomi' });
  assert.equal(legacyPassword.status, 200);
  assert.equal(legacyPassword.data.failures.length, 1);
  roleFailures.clear();
  const beforeRoleRetry = externalCalls;
  const legacyRoles = await request('/roles', { confirm: true, id: legacyPassword.data.id });
  assert.equal(legacyRoles.status, 200);
  assert.equal(legacyRoles.data.choices.length, 2);
  assert.equal(externalCalls, beforeRoleRetry, '角色重试复用该次登录凭证');
  const legacyClientInfo = connections.at(-1).login.eworldClientInfo;
  assert.equal(legacyClientInfo.appId, PHONE_LOGIN.superAppId);
  assert.equal(legacyClientInfo.channelId, PHONE_LOGIN.channel);
  assert.equal(legacyClientInfo.sc, PHONE_LOGIN.packetId);
  assert.equal(legacyClientInfo.originVersion, PHONE_LOGIN.clientVersion);
  assert.equal((await request('/cancel', { id: legacyPassword.data.id })).status, 200);

  const legacyPhone = '13600136000';
  assert.equal((await request('/send-code', { confirm: true, phone: legacyPhone, channel: 'xiaomi' })).status, 200);
  const beforeDuplicateSms = externalCalls;
  assert.equal((await request('/send-code', { confirm: true, phone: legacyPhone })).status, 400);
  assert.equal(externalCalls, beforeDuplicateSms, '同一手机号继续遵守发码间隔');
  const legacySms = await request('', { confirm: true, phone: legacyPhone, code: '123456', channel: 'xiaomi' });
  assert.equal(legacySms.status, 200);
  assert.equal(legacySms.data.choices.length, 3);
  assert.equal(connections.at(-1).login.eworldClientInfo.appId, PHONE_LOGIN.superAppId);
  assert.equal(connections.at(-1).login.eworldClientInfo.sc, PHONE_LOGIN.packetId);
  assert.equal((await request('/cancel', { id: legacySms.data.id })).status, 200);
  smsAttempts = 0;
  sdkDevices.length = 0;
  sdkInitializations.length = 0;
  businessDevices.length = 0;

  fs.writeFileSync(process.env.CW_EWAN_DEVICE, JSON.stringify({ di: profile.di }));
  const incomplete = await request('/status');
  assert.equal(incomplete.data.deviceReady, false);
  assert.equal(incomplete.data.deviceSource, null);
  assert.match(incomplete.data.deviceError, /设备档案/);
  fs.writeFileSync(process.env.CW_EWAN_DEVICE, '{broken');
  const broken = await request('/status');
  assert.equal(broken.data.deviceReady, false);
  assert.match(broken.data.deviceError, /设备档案/);
  assert.equal((await request('', { confirm: true, phone, password })).status, 400);
  assert.equal(fs.readFileSync(process.env.CW_EWAN_DEVICE, 'utf8'), '{broken');
  assert.equal(sdkDevices.length, 0);
  assert.equal((await request('/device', { profile })).status, 400);
  const imported = await request('/device', { confirm: true, profile });
  assert.equal(imported.status, 200);
  assert.deepEqual(imported.data, {
    deviceReady: true, devicePath: process.env.CW_EWAN_DEVICE, deviceModel: '测试设备', deviceSource: 'imported', deviceError: null,
  });
  assert.equal(loadDeviceProfile().oi, profile.oi.toLowerCase());
  assert.equal(loadDeviceProfile().oi.length, 96);
  assert.equal(loadDeviceProfile().deviceCode, 'cd'.repeat(8));
  assert.equal(loadDeviceProfile().businessDid, 'legacy-did');
  assert.equal(JSON.stringify(imported.data).includes(profile.di), false);
  const savedProfile = fs.readFileSync(process.env.CW_EWAN_DEVICE, 'utf8');
  for (const invalid of [null, {}, { ...profile, di: 'short' }, { ...profile, oi: '0'.repeat(31) },
    { ...profile, oi: '' }, { ...profile, deviceCode: '' }, { ...profile, deviceCode: 'g'.repeat(16) }]) {
    const rejected = await request('/device', { confirm: true, profile: invalid });
    assert.equal(rejected.status, 400);
    assert.equal(fs.readFileSync(process.env.CW_EWAN_DEVICE, 'utf8'), savedProfile);
  }

  assert.equal((await request('/send-code', { phone })).status, 400);
  assert.equal((await request('/send-code', { confirm: true, phone: '123' })).status, 400);
  assert.equal(smsAttempts, 0);
  let releaseSms;
  smsGate = new Promise(resolve => { releaseSms = resolve; });
  const started = new Promise(resolve => { smsStarted = resolve; });
  const sending = request('/send-code', { confirm: true, phone });
  await started;
  const concurrent = await request('/send-code', { confirm: true, phone });
  assert.equal(concurrent.status, 400);
  assert.match(concurrent.data.error, /正在发送/);
  assert.equal(smsAttempts, 1);
  releaseSms();
  assert.equal((await sending).data.cooldown, 60);
  assert.equal((await request('/send-code', { confirm: true, phone })).status, 400);
  assert.equal(smsAttempts, 1);
  smsGate = null;
  smsFailure = true;
  const retryPhone = '13900139000';
  assert.equal((await request('/send-code', { confirm: true, phone: retryPhone })).status, 400);
  smsFailure = false;
  assert.equal((await request('/send-code', { confirm: true, phone: retryPhone })).status, 200);
  assert.equal(smsAttempts, 3);

  passwordFailure = true;
  const badLogin = await request('', { confirm: true, phone, password });
  assert.equal(badLogin.status, 400);
  assert.match(badLogin.data.error, /用户名或密码错误/);
  passwordFailure = false;
  const beforeLogin = Date.now();
  const preview = await request('', { confirm: true, phone, password });
  assert.equal(preview.status, 200);
  assert.deepEqual(loadDeviceProfile(), JSON.parse(savedProfile));
  assert.deepEqual(businessDevices[0], { did: 'legacy-did', dc: profile.deviceCode.toLowerCase() });
  assert.equal(preview.data.phone, '138****8000');
  assert.equal(preview.data.linkedAccountCount, 1);
  assert.equal(preview.data.choices.length, 2);
  assert.equal(preview.data.choices[0].userName, '测试账号一');
  assert.equal(preview.data.choices[0].nickname, '海风船长');
  assert.equal(preview.data.choices[0].worldName, '海港1服');
  assert.equal(preview.data.choices[0].roleWorldName, '海港10服');
  assert.equal(preview.data.choices[0].matched, false);
  assert.ok(preview.data.expiresAt >= beforeLogin + 600000);
  assert.ok(preview.data.expiresAt <= Date.now() + 600000);
  assert.equal(loadStore().accounts.length, 0);
  assert.equal(JSON.stringify(preview.data).includes('fixture-token'), false);
  assert.equal(JSON.stringify(preview.data).includes('multiAccountToken'), false);
  assert.equal(connections.at(-1).login.worldId, 0);
  assert.equal(liveClients.size, 0);
  assert.ok(stoppedClients > 0);
  assert.equal((await request('/save', { confirm: true, id: preview.data.id })).status, 400);
  assert.equal((await request('/save', { confirm: true, id: preview.data.id, choiceId: 'forged-choice', worldId: 42 })).status, 400);
  const beforeSaveConnections = connections.length;
  const saved = await request('/save', { confirm: true, id: preview.data.id, choiceId: preview.data.choices[1].id });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.account.id, 'fixture-game-id');
  assert.equal(saved.data.account.status.connected, false);
  assert.equal(saved.data.selectedRole.nickname, '星海船长');
  assert.equal(saved.data.selectedRole.worldName, '海港2服');
  assert.equal(loadStore().activeId, 'fixture-game-id');
  assert.equal(loadStore().accounts.length, 2, '同账号其他区服角色也分别保存');
  assert.equal(selectedAccount().login.worldId, 3000000002);
  assert.equal(selectedAccount().lastSeen.nickname, '星海船长');
  assert.equal(selectedAccount().automation.autoStart, false);
  assert.equal((await accountApi('loop')).running, false);
  assert.equal(connections.length, beforeSaveConnections, '新账号保存和读取状态不启动挂机连接');
  const configured = await accountApi('settings');
  configured.settings.schedule.mail = true;
  await accountApi('settings', { settings: configured.settings, revision: configured.revision, baseRevision: configured.baseRevision });
  await accountApi('accounts/pause', { paused: false, start: true });
  let initialSession = await waitForLoop('fixture-game-id', 3000000002);
  assert.equal(initialSession.loop.rounds, 0);
  assert.equal(selectedAccount().automation.autoStart, true);
  const refreshRunning = await request('', { confirm: true, phone, password });
  const oldRunningClient = initialSession.client;
  assert.equal((await request('/save', { confirm: true, id: refreshRunning.data.id, choiceId: refreshRunning.data.choices[0].id })).status, 200);
  assert.equal(selectedAccount().automation.autoStart, false, '新选区服沿用自己的启停选择');
  await accountApi('loop/stop', {}, 'fixture-game-id');
  const firstRoleConfigured = await accountApi('settings');
  firstRoleConfigured.settings.schedule.mail = true;
  await accountApi('settings', { settings: firstRoleConfigured.settings, revision: firstRoleConfigured.revision, baseRevision: firstRoleConfigured.baseRevision });
  await accountApi('accounts/pause', { paused: false, start: true });
  initialSession = await waitForLoop(selectedId(), 3000000001);
  assert.equal(oldRunningClient.connected, false);
  assert.equal(selectedAccount().automation.autoStart, true);

  // 顶号等待中保存同一角色的新凭证，取消旧等待后直接接续挂机。
  const loginSettings = await accountApi('login-settings');
  await accountApi('login-settings', { revision: loginSettings.revision, settings: {
    ...loginSettings.settings, reconnectEnabled: true, baseDelaySeconds: 900, jitterSeconds: 0,
    deep: { ...loginSettings.settings.deep, enabled: false },
  } });
  const kickedClient = initialSession.client;
  const previousLoopJob = initialSession.loop.job;
  kickedClient.closeReason = 'kicked';
  liveClients.delete(kickedClient);
  kickedClient.emit('fatal', { reason: 'SCChannelExpired' });
  kickedClient.emit('close', { reason: 'kicked' });
  assert.equal(initialSession.loginBlocked, true);
  assert.equal(initialSession.loginRecovery.status, 'waiting');
  const previousRecoveryJob = initialSession.loginRecoveryJob;
  const previousRecoveryController = initialSession.loginRecoveryController;
  gameToken = 'fixture-refreshed-token';
  const sameRoleRefresh = await request('', { confirm: true, phone, password });
  assert.equal(sameRoleRefresh.status, 200);
  const beforeSameRoleSave = connections.length;
  assert.equal((await request('/save', {
    confirm: true, id: sameRoleRefresh.data.id, choiceId: sameRoleRefresh.data.choices[0].id,
  })).status, 200);
  await waitForLoop(selectedId(), 3000000001);
  assert.equal(previousRecoveryController.signal.aborted, true);
  await previousRecoveryJob;
  assert.equal(initialSession.loginRecoveryJob, null);
  assert.equal(initialSession.loginBlocked, false);
  assert.equal(initialSession.client.login.eworldParams.token, gameToken);
  assert.equal(connections.length, beforeSameRoleSave + 1, '新凭证只建立一次挂机连接');
  assert.notEqual(initialSession.loop.job, previousLoopJob);
  assert.equal(liveClients.size, 1);
  assert.equal(selectedAccount().automation.autoStart, true);
  await disconnect(selectedId());
  assert.equal(selectedAccount().automation.autoStart, false);
  assert.equal((await request('/save', { confirm: true, id: preview.data.id, choiceId: preview.data.choices[0].id })).status, 400);

  // 所有短信关联账号及其已有角色都进入同一列表，选择第二个 APP 账号持久化到正确身份。
  const smsPreview = await request('', { confirm: true, phone, code: '123456' });
  assert.equal(smsPreview.status, 200);
  assert.equal(smsPreview.data.linkedAccountCount, 2);
  assert.equal(smsPreview.data.choices.length, 3);
  assert.equal(smsPreview.data.choices[0].matched, true);
  assert.equal(smsPreview.data.choices[2].userName, '测试账号二');
  assert.equal(smsPreview.data.choices[2].nickname, '灯塔守望');
  assert.equal(smsPreview.data.choices[2].worldName, '海灯8服');
  const savedSecond = await request('/save', { confirm: true, id: smsPreview.data.id, choiceId: smsPreview.data.choices[2].id });
  assert.equal(savedSecond.data.account.id, 'fixture-game-id-2');
  assert.equal(loadStore().accounts.find(row => row.id === 'fixture-game-id-2').login.worldId, 4000000008);
  assert.equal((await accountApi('loop', undefined, 'fixture-game-id-2')).running, false);
  assert.equal(loadStore().accounts.find(row => row.id === 'fixture-game-id-2').automation.autoStart, false);
  await disconnect('fixture-game-id-2');

  // 单账号读取失败保留其他账号结果，原凭证可重试，已有选择 ID 保持稳定。
  roleFailures.add('fixture-game-id-2');
  const partial = await request('', { confirm: true, phone, code: '123456' });
  assert.equal(partial.data.choices.length, 2);
  assert.deepEqual(partial.data.failures, [{ userName: '测试账号二', error: '模拟角色列表读取超时', retryable: true }]);
  assert.equal(liveClients.size, 0);
  roleFailures.clear();
  const retried = await request('/roles', { confirm: true, id: partial.data.id });
  assert.equal(retried.data.choices.length, 3);
  assert.deepEqual(retried.data.failures, []);
  assert.equal(retried.data.choices[0].id, partial.data.choices[0].id);
  assert.equal(retried.data.expiresAt, partial.data.expiresAt);
  assert.equal((await request('/cancel', { id: partial.data.id })).status, 200);
  assert.equal((await request('/save', { confirm: true, id: partial.data.id, choiceId: partial.data.choices[0].id })).status, 400);
  assert.equal((await request('/roles', { confirm: true, id: partial.data.id })).status, 400);

  // 认证失败与空角色账号分别反馈，成功账号仍可选择。
  secondAccountFailure = true;
  const authPartial = await request('', { confirm: true, phone, code: '123456' });
  assert.equal(authPartial.data.choices.length, 2);
  assert.equal(authPartial.data.failures[0].retryable, false);
  assert.equal(authPartial.data.failures[0].userName, '测试账号二');
  secondAccountFailure = false;
  const previousRoles = roleLists.get('fixture-game-id');
  roleLists.set('fixture-game-id', []);
  const empty = await request('', { confirm: true, phone, password });
  assert.equal(empty.data.choices.length, 0);
  assert.deepEqual(empty.data.emptyAccounts, [{ userName: '测试账号一' }]);
  assert.deepEqual(empty.data.failures, []);
  assert.equal((await request('/save', { confirm: true, id: empty.data.id })).status, 400);
  roleLists.set('fixture-game-id', previousRoles);

  // 已在线账号使用现有读通道，不额外登录或关闭现有连接。
  const session = app.sessions.get(selectedId());
  const activeClient = new GameClient({ protocol: {} });
  activeClient.login = selectedAccount().login;
  liveClients.add(activeClient);
  session.client = activeClient;
  session.player = { playerId: 11, nickname: '海风船长', worldId: 3000000010 };
  session.productionSyncRequired = false;
  session.queueTail = Promise.resolve();
  const beforeReuse = connections.length;
  const reused = await request('', { confirm: true, phone, password });
  assert.equal(connections.length, beforeReuse);
  assert.equal(interleavedReads, 1);
  assert.equal(activeClient.connected, true);
  session.queueTail = null;
  const sameRole = await request('/save', { confirm: true, id: reused.data.id, choiceId: reused.data.choices[0].id });
  assert.equal(sameRole.data.account.status.connected, true);
  assert.equal(activeClient.connected, true);
  assert.equal(selectedAccount().login.worldId, 3000000001);
  assert.equal(selectedAccount().lastSeen.worldId, 3000000010);
  assert.equal(session.loop.running, false);
  assert.equal(selectedAccount().automation.autoStart, false);

  // 不同角色保存先停旧任务与连接，并把停止状态持久化。
  const changed = await request('', { confirm: true, phone, password });
  session.loop.running = true;
  session.loop.controller = new AbortController();
  const changedRole = await request('/save', { confirm: true, id: changed.data.id, choiceId: changed.data.choices[1].id });
  assert.equal(changedRole.status, 200);
  assert.equal(changedRole.data.account.status.connected, false);
  assert.equal(activeClient.connected, false);
  assert.equal(session.loop.controller.signal.aborted, true);
  assert.equal(selectedAccount().automation.enabled, false);
  assert.equal(selectedAccount().login.worldId, 3000000002);
  assert.equal(selectedAccount().lastSeen.nickname, '星海船长');
  assert.equal(selectedAccount().label, '星海船长');

  // 不同出生服的角色合入同服时仍按角色 ID 区分，避免继续操作旧角色。
  roleLists.get('fixture-game-id')[1].roleInfo.worldId = 3000000010;
  const mergedClient = new GameClient({ protocol: {} });
  mergedClient.login = selectedAccount().login;
  liveClients.add(mergedClient);
  session.client = mergedClient;
  session.player = { playerId: 11, nickname: '海风船长', worldId: 3000000010 };
  const merged = await request('', { confirm: true, phone, password });
  const mergedSaved = await request('/save', { confirm: true, id: merged.data.id, choiceId: merged.data.choices[1].id });
  assert.equal(mergedSaved.status, 200);
  assert.equal(mergedSaved.data.account.status.connected, false);
  assert.equal(mergedClient.connected, false);
  assert.equal(mergedSaved.data.selectedRole.roleWorldId, 3000000010);
  assert.equal(selectedAccount().login.worldId, 3000000002);
  const longRoleId = { low: 7, high: 3000000, unsigned: false };
  const exactLongRoleId = ((3000000n << 32n) + 7n).toString();
  assert.equal(describeRole({ id: longRoleId }).id, exactLongRoleId);
  assert.equal(describeRole({ id: 123 }).id, 123);
  assert.equal((await listGroup({ request: async () => ({ worlds: [{ worldId: 3000000001, roleInfo: { id: longRoleId } }] }) }, 1))[0].role.id, exactLongRoleId);
  roleLists.get('fixture-game-id')[0].roleInfo.id = longRoleId;
  const longClient = new GameClient({ protocol: {} });
  longClient.login = selectedAccount().login;
  liveClients.add(longClient);
  session.client = longClient;
  session.player = { playerId: longRoleId, nickname: '海风船长', worldId: 3000000010 };
  const longPreview = await request('', { confirm: true, phone, password });
  assert.equal(longPreview.data.choices.length, 2);
  const longSaved = await request('/save', { confirm: true, id: longPreview.data.id, choiceId: longPreview.data.choices[0].id });
  assert.equal(longSaved.status, 200);
  assert.equal(longSaved.data.account.status.connected, false, '角色ID变化时另存角色，旧记录不会继承新角色连接');
  assert.ok(longSaved.data.account.id.endsWith(exactLongRoleId));
  longClient.stop();
  session.client = null;
  session.loop.running = false;

  // 等待连接交接期间重复点击被拒绝，取消预览后不得再写入。
  const queuedPreview = await request('', { confirm: true, phone, password });
  let releaseQueue;
  const queuedSession = app.sessions.get('fixture-game-id');
  queuedSession.connectionDrain = new Promise(resolve => { releaseQueue = resolve; });
  const queuedPayload = { confirm: true, id: queuedPreview.data.id, choiceId: queuedPreview.data.choices[1].id };
  const beforeQueuedSave = selectedAccount().login.worldId;
  const queuedSave = request('/save', queuedPayload);
  await sleep(30);
  assert.match((await request('/save', queuedPayload)).data.error, /正在处理/);
  await request('/cancel', { id: queuedPreview.data.id });
  releaseQueue();
  queuedSession.connectionDrain = null;
  assert.equal((await queuedSave).status, 400);
  assert.equal(selectedAccount().login.worldId, beforeQueuedSave);

  // 控制台关闭取消临时网关读取，防止遗留心跳和连接。
  let roleReadStarted;
  let rejectRoleRead;
  const roleReading = new Promise(resolve => { roleReadStarted = resolve; });
  GameClient.prototype.request = async function (name) {
    assert.equal(name, 'GameWorldListRequest');
    roleReadStarted();
    return new Promise((resolve, reject) => { rejectRoleRead = reject; });
  };
  const originalStop = GameClient.prototype.stop;
  GameClient.prototype.stop = function () {
    originalStop.call(this);
    rejectRoleRead?.(new Error('client stopped'));
  };
  const closingPreview = request('', { confirm: true, phone, password });
  await roleReading;
  await app.close();
  closed = true;
  assert.equal((await closingPreview).status, 400);
  assert.equal(fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8').includes(password), false);
  assert.equal(liveClients.size, 0);
  console.log('selftest-phone-login-http: ok');
} finally {
  globalThis.fetch = nativeFetch;
  if (!closed) await app.close();
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
