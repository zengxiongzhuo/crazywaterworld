// Real local HTTP with isolated records; never connect to a game or download resources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporary, 'cw-gift-library-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
process.env.CW_PROTO_BUNDLE = path.join(directory, 'missing-game-protocol.js');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { GameClient } = await import('../src/client.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('测试禁止连接游戏'); };
const { saveStore, loadStore } = await import('../src/accounts.mjs');
const { publicGiftCodes } = await import('../src/gift-code-library.mjs');
const { giftCodeStatus } = await import('../src/gift-codes.mjs');
const originalRefresh = publicGiftCodes.refresh;
let refreshes = 0;
publicGiftCodes.refresh = async () => { refreshes++; return publicGiftCodes.view(); };
const { createConsole } = await import('../src/server.mjs');
const account = id => ({ id, label: '测试账号 ' + id, url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: false } });
const historyFile = id => path.join(directory, 'gift-codes-' + encodeURIComponent(id) + '.json');
const writeHistory = (id, rows) => fs.writeFileSync(historyFile(id), JSON.stringify(rows));
const historyRow = (code, status, detail, extra = {}) => ({ batch: 'fixture-batch', code, status, detail,
  at: '2026-01-01T00:00:00.000Z', ...extra });
const initialQuery = ids => '/api/gift-codes/initial?' + new URLSearchParams({ accounts: JSON.stringify(ids) });
let app, base, passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const open = async () => {
  app = createConsole({ port: 0, protocol: {}, resourceUpdates: false, giftCodeUpdates: false });
  base = await app.listen();
};
const close = async () => {
  if (!app) return;
  app.server.closeAllConnections();
  await app.close();
  app = null;
};
const request = async (route, { body, headers = {} } = {}) => {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(10000), headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, value: await response.json() };
};
const get = async (route, status = 200) => {
  const response = await request(route);
  assert.equal(response.status, status, JSON.stringify(response.value));
  return response.value;
};
const post = async (route, body, status = 200, headers = {}) => {
  const response = await request(route, { body, headers: { 'content-type': 'application/json', ...headers } });
  assert.equal(response.status, status, JSON.stringify(response.value));
  return response.value;
};

try {
  saveStore({ version: 1, activeId: null, accounts: [] });
  await open();

  await test('没有账号也能读取码库、批量添加和载入，查询不会连接游戏', async () => {
    const before = await get(initialQuery([]));
    assert(Array.isArray(before.displayRows));
    assert(Array.isArray(before.tryCodes));
    const saved = await post('/api/gift-codes/manual', { confirm: true, codes: ['HTTP_SHARED_A', 'HTTP_SHARED_B', 'HTTP_SHARED_A'] });
    assert.equal(saved.saved, 2);
    assert.equal(saved.codes, 2);
    const loaded = await post('/api/gift-codes/load', { confirm: true, accounts: [] });
    for (const code of ['HTTP_SHARED_A', 'HTTP_SHARED_B']) {
      assert(loaded.displayRows.some(row => row.code === code), code);
      assert(loaded.tryCodes.includes(code), code);
    }
    assert.equal(connections, 0);
  });

  await test('批量校验失败完全不落盘，空批次、超过上限和过期日期被拒绝', async () => {
    const sharedFile = path.join(directory, 'shared-gift-codes.json');
    const before = fs.readFileSync(sharedFile);
    for (const payload of [
      { codes: ['HTTP_MUST_NOT_SAVE', 'bad!'] },
      { codes: [] },
      { codes: Array.from({ length: 501 }, (_, index) => 'HTTP_MANY_' + index) },
      { codes: ['HTTP_EXPIRED'], expiresAt: '2000-01-01' },
      { codes: ['HTTP_INVALID_DATE'], expiresAt: '2030-02-30' },
    ]) {
      await post('/api/gift-codes/manual', { confirm: true, ...payload }, 400);
      assert.deepEqual(fs.readFileSync(sharedFile), before, '整批失败不能修改共享库');
    }
    await post('/api/gift-codes/manual', { codes: ['HTTP_NO_CONFIRM'] }, 400);
    assert.deepEqual(fs.readFileSync(sharedFile), before);
  });

  await test('共享码对不同账号可见，成功和待确认的兑换历史按账号独立过滤', async () => {
    saveStore({ version: 1, activeId: 'a', accounts: [account('a'), account('b'), account('records')] });
    writeHistory('a', [historyRow('HTTP_SHARED_A', 'success', '金币 ×10'), historyRow('HTTP_SHARED_B', 'unknown', '待确认')]);
    const a = await get(initialQuery(['a']));
    const b = await get(initialQuery(['b']));
    for (const code of ['HTTP_SHARED_A', 'HTTP_SHARED_B']) {
      assert(a.displayRows.some(row => row.code === code), '已处理码仍可供显示已处理视图使用');
      assert.equal(a.displayRows.find(row => row.code === code).eligible, false);
      assert.equal(a.tryCodes.includes(code), false);
      assert.equal(b.displayRows.find(row => row.code === code).eligible, true);
      assert(b.tryCodes.includes(code));
    }
    const both = await get(initialQuery(['a', 'b']));
    assert(both.tryCodes.includes('HTTP_SHARED_A'), '多选时对尚未兑换的账号仍可用');
    const summary = await get('/api/gift-codes/accounts');
    assert.equal(summary.accounts.length, 3);
    assert(summary.accounts.every(row => row.autoRedeem === false), '账号自动兑换默认关闭');
    assert.equal(summary.accounts.find(row => row.id === 'b').available - summary.accounts.find(row => row.id === 'a').available, 2);
    await get(initialQuery(['missing']), 400);
    await get('/api/gift-codes/initial?accounts=not-json', 400);
    assert.equal(connections, 0);
  });

  const recordRows = [
    ...Array.from({ length: 22 }, (_, index) => historyRow(index === 0 ? '=1+1' : 'HTTP_HISTORY_' + index, 'success', index === 0 ? '金币,"双倍"' : '金币 ×10')),
    historyRow('HTTP_INVALID', 'rejected', '礼包码无效', { promptName: 'GIFT_CODE_INVALID' }),
    historyRow('HTTP_LIMIT', 'rejected', '请求过于频繁', { promptName: 'GIFT_CODE_TOO_MANY_REQUESTS' }),
    historyRow('HTTP_UNKNOWN', 'unknown', '未取得奖励回包'),
    historyRow('HTTP_USED', 'used', '该账号已兑换'),
    historyRow('HTTP_NOT_YET', 'rejected', '不在兑换有效期', { promptName: 'GIFT_CODE_EXPIRED_OR_NOT_YET' }),
  ];
  writeHistory('records', recordRows);
  await test('记录按账号和状态分页，越界页码收敛，非法查询参数被拒绝', async () => {
    const page = await get('/api/gift-codes?account=records&status=all&page=2&pageSize=10');
    assert.deepEqual([page.total, page.pages, page.page, page.pageSize], [27, 3, 2, 10]);
    assert.deepEqual(page.rows.map(row => row.code), recordRows.slice(10, 20).map(row => row.code));
    const last = await get('/api/gift-codes?account=records&status=all&page=999&pageSize=10');
    assert.equal(last.page, 3);
    assert.equal(last.rows.length, 7);
    const successes = await get('/api/gift-codes?account=records&status=success&pageSize=50');
    assert.equal(successes.total, 22);
    assert(successes.rows.every(row => row.status === 'success'));
    const retryable = await get('/api/gift-codes?account=records&status=retryable');
    assert(retryable.rows.some(row => row.code === 'HTTP_LIMIT'));
    assert(!retryable.rows.some(row => ['HTTP_UNKNOWN', 'HTTP_USED', 'HTTP_INVALID'].includes(row.code)));
    const a = await get('/api/gift-codes?account=a&status=all');
    assert.equal(a.total, 2, '记录不能串到其他账号');
    for (const query of ['page=0', 'page=-1', 'page=bad', 'pageSize=11', 'status=bad']) {
      await get('/api/gift-codes?account=records&' + query, 400);
    }
    await get('/api/gift-codes?account=missing', 400);
    assert.equal(connections, 0);
  });

  await test('CSV 导出当前状态下全部记录，忽略分页且转义公式与引号', async () => {
    const response = await fetch(base + '/api/gift-codes/export?account=records&status=success&page=2&pageSize=10', { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    const csv = Buffer.from(await response.arrayBuffer()).toString('utf8');
    assert(csv.startsWith('\uFEFF'), 'CSV 包含 Excel 可识别的 UTF-8 BOM');
    assert.equal(csv.trimEnd().split('\r\n').length, 23, '导出22条成功记录和表头，不受当前第2页影响');
    assert(csv.includes('"\'=1+1"'), '危险公式必须按文本导出');
    assert(csv.includes('"金币,""双倍"""'), '双引号按 CSV 规则转义');
    assert(!csv.includes('HTTP_INVALID'));
    await get('/api/gift-codes/export?account=records&status=bad', 400);
  });

  await test('危险写入沿用页面版本保护，跨源和过期页面不能改变共享库', async () => {
    const sharedFile = path.join(directory, 'shared-gift-codes.json');
    const before = fs.readFileSync(sharedFile);
    for (const [route, body] of [
      ['/api/gift-codes/manual', { confirm: true, codes: ['HTTP_UNAUTHORIZED'] }],
      ['/api/gift-codes/load', { confirm: true, accounts: ['a'] }],
      ['/api/gift-codes/retry?account=a', { confirm: true, code: 'HTTP_SHARED_B' }],
      ['/api/gift-codes/redeem', { confirm: true, library: true, accounts: ['a'] }],
      ['/api/gift-codes/auto?account=b', { confirm: true, enabled: true }],
    ]) {
      const foreign = await post(route, body, 409, { origin: 'https://untrusted.invalid', 'content-type': 'text/plain' });
      assert.equal(foreign.code, 'CLIENT_VERSION_MISMATCH');
      const stale = await post(route, body, 409, { origin: base, 'x-cw-console-version': 'old-version' });
      assert.equal(stale.code, 'CLIENT_VERSION_MISMATCH');
    }
    assert.deepEqual(fs.readFileSync(sharedFile), before);
    assert.equal(connections, 0);
  });

  await test('空选择、无效账号和已暂停目标不能开始兑换，未知结果禁止重试', async () => {
    await post('/api/gift-codes/redeem', { confirm: true, library: true, accounts: [] }, 400);
    await post('/api/gift-codes/redeem', { confirm: true, library: true, accounts: ['missing'] }, 400);
    await post('/api/gift-codes/retry?account=a', { confirm: true, code: 'HTTP_SHARED_B' }, 400);
    await post('/api/gift-codes/retry?account=a', { confirm: true, code: 'HTTP_SHARED_A' }, 400);
    await post('/api/accounts/pause?account=b', { paused: true });
    await post('/api/gift-codes/redeem', { confirm: true, library: true, accounts: ['b'] }, 400);
    assert.equal(connections, 0);
  });

  await test('自动兑换要求明确确认和布尔开关，暂停账号可保存偏好但不连接游戏', async () => {
    await post('/api/gift-codes/auto?account=b', { enabled: true }, 400);
    await post('/api/gift-codes/auto?account=b', { confirm: true, enabled: 'true' }, 400);
    await post('/api/gift-codes/auto?account=missing', { confirm: true, enabled: true }, 400);
    const before = refreshes;
    assert.equal((await post('/api/gift-codes/auto?account=b', { confirm: true, enabled: true })).enabled, true);
    assert.equal(refreshes, before + 1, '显式启用时请求码库同步，此处由本地替身完成');
    assert.equal((await get('/api/gift-codes/accounts')).accounts.find(row => row.id === 'b').autoRedeem, true);
    let preferences = JSON.parse(fs.readFileSync(path.join(directory, 'gift-code-preferences.json'), 'utf8'));
    assert.equal(preferences.accounts.find(row => row.id === 'b').enabled, true);
    assert.equal((await post('/api/gift-codes/auto?account=b', { confirm: true, enabled: false })).enabled, false);
    preferences = JSON.parse(fs.readFileSync(path.join(directory, 'gift-code-preferences.json'), 'utf8'));
    assert.equal(preferences.accounts.find(row => row.id === 'b').enabled, false);
    assert.equal(refreshes, before + 1, '关闭自动兑换不抓取远端');
    assert.equal(connections, 0, '暂停托管的账号开启自动兑换不能登录游戏');
  });

  await test('账号队列等待中关闭自动兑换，释放队列后也不再发起游戏登录', async () => {
    const id = 'queued-auto';
    const store = loadStore(); store.accounts.push(account(id)); saveStore(store);
    await get('/api/gift-codes/accounts');
    const session = app.sessions.get(id);
    let release;
    session.queueTail = new Promise(resolve => { release = resolve; });
    try {
      await post('/api/gift-codes/auto?account=' + id, { confirm: true, enabled: true });
      assert.equal(giftCodeStatus(id).running, true, '自动任务等待原账号队列');
      assert.equal(connections, 0);
      await post('/api/gift-codes/auto?account=' + id, { confirm: true, enabled: false });
      release();
      for (let index = 0; index < 200 && giftCodeStatus(id).running; index++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(giftCodeStatus(id).running, false, '已关闭的队列任务应结束');
      assert(giftCodeStatus(id).rows.every(row => row.status === 'skipped'));
      assert.equal(connections, 0, '关闭后不能在发送前检查之前先登录并顶号');
    } finally { release(); }
    await post('/api/accounts/remove', { confirm: true, id });
  });

  await test('删除账号移除自动兑换偏好，共享码库和其他账号偏好保留', async () => {
    const store = loadStore();
    const removable = account('auto-delete');
    removable.automation.paused = true;
    store.accounts.push(removable);
    saveStore(store);
    const sharedBefore = fs.readFileSync(path.join(directory, 'shared-gift-codes.json'));
    await post('/api/gift-codes/auto?account=auto-delete', { confirm: true, enabled: true });
    let preferences = JSON.parse(fs.readFileSync(path.join(directory, 'gift-code-preferences.json'), 'utf8'));
    assert.equal(preferences.accounts.find(row => row.id === 'auto-delete').enabled, true);
    await post('/api/accounts/remove', { confirm: true, id: 'auto-delete' });
    preferences = JSON.parse(fs.readFileSync(path.join(directory, 'gift-code-preferences.json'), 'utf8'));
    assert(!preferences.accounts.some(row => row.id === 'auto-delete'));
    assert.equal(preferences.accounts.find(row => row.id === 'b').enabled, false);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'shared-gift-codes.json')), sharedBefore);
    assert.equal(connections, 0);
  });

  await test('自动兑换偏好清理失败也不阻止已删除账号的会话清理', async () => {
    const store = loadStore();
    const removable = account('remove-with-bad-preference');
    removable.automation.paused = true;
    store.accounts.push(removable);
    saveStore(store);
    await get('/api/gift-codes/accounts');
    assert(app.sessions.has(removable.id));
    const removeAccount = publicGiftCodes.removeAccount;
    publicGiftCodes.removeAccount = () => { throw Error('fixture 偏好文件损坏'); };
    try {
      await post('/api/accounts/remove', { confirm: true, id: removable.id });
      assert(!loadStore().accounts.some(row => row.id === removable.id));
      assert.equal(app.sessions.has(removable.id), false);
      assert.equal(connections, 0);
    } finally { publicGiftCodes.removeAccount = removeAccount; }
  });

  await close();
  await open();
  await test('重建控制台后共享库和独立兑换记录仍存在，不触发自动登录', async () => {
    const library = await get(initialQuery(['b']));
    assert(library.displayRows.some(row => row.code === 'HTTP_SHARED_A'));
    assert.equal((await get('/api/gift-codes?account=records&status=all')).total, 27);
    assert.equal((await get('/api/gift-codes/accounts')).accounts.find(row => row.id === 'b').autoRedeem, false);
    assert.equal(connections, 0);
  });
  console.log(`礼包码库 HTTP 专项 ${passed}/${passed} 通过（临时数据、零游戏连接）`);
} finally {
  await close();
  if (originalRefresh === undefined) delete publicGiftCodes.refresh;
  else publicGiftCodes.refresh = originalRefresh;
  assert.equal(path.dirname(path.resolve(directory)), temporary);
  fs.rmSync(directory, { recursive: true, force: true });
}
