import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporary, 'cw-gift-library-'));
process.env.CW_DATA_DIR = path.join(directory, 'accounts');
const { createGiftCodeLibrary, publicGiftCodes } = await import('../src/gift-code-library.mjs');
const { initialGiftCodeCatalog } = await import('../src/gift-code-catalog.mjs');
const { startGiftCodes, startGiftCodeBatch, giftCodeStatus } = await import('../src/gift-codes.mjs');
const { filterGiftRecords, paginateGiftRecords, giftRecordsCsv, canRetryGiftCode } = await import('../src/gift-code-records.mjs');
let now = Date.parse('2026-11-19T12:00:00Z');
const fixture = () => ({ source: 'fixture', updatedAt: '2026-11-19', codes: [
  { code: 'PUBLIC', expiresAt: null }, { code: 'PUBLIC', expiresAt: null },
  { code: 'EXPIRED', expiresAt: '2026-11-18' }, { code: 'TONIGHT', expiresAt: '2026-11-19' },
] });
const libraryDirectory = path.join(directory, 'library');
const library = createGiftCodeLibrary({ directory: libraryDirectory, now: () => now, catalog: fixture });
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const codes = () => library.entries().map(row => row.code);

try {
  await test('内置公共码离线可用，原始目录统计与去重可用列表分开', () => {
    assert.deepEqual(codes(), ['PUBLIC', 'TONIGHT']);
    assert.deepEqual([library.view().total, library.view().unique, library.view().expired], [4, 3, 1]);
    const current = initialGiftCodeCatalog();
    const bundled = publicGiftCodes.view();
    assert.deepEqual([bundled.total, bundled.unique, bundled.codes.length], [current.total, current.unique, current.codes.length]);
    assert.equal(bundled.source, current.source);
  });

  await test('无账号也能批量添加，重复码去重且重建库后全账号共享', () => {
    assert.deepEqual(library.addManualBatch(['Shared', 'Shared', '中文_礼包-1']), { saved: 2, codes: 2 });
    const restarted = createGiftCodeLibrary({ directory: libraryDirectory, now: () => now, catalog: fixture });
    assert(restarted.entries().some(row => row.code === 'Shared'));
    assert(library.available([{ code: 'Shared', status: 'success' }]).includes('中文_礼包-1'));
    assert(!library.available([{ code: 'Shared', status: 'success' }]).includes('Shared'));
    assert(library.available([]).includes('Shared'), '其他账号没有继承兑换历史');
  });

  await test('整批先验证，字符、日期、过期和超量失败均不部分保存', () => {
    const file = path.join(libraryDirectory, 'shared-gift-codes.json');
    const before = fs.readFileSync(file, 'utf8');
    for (const attempt of [
      () => library.addManualBatch(['ValidNew', 'bad!']),
      () => library.addManualBatch(['ValidNew', 123]),
      () => library.addManualBatch(['ValidNew'], '2026-02-30'),
      () => library.addManualBatch(['ValidNew'], '2026-11-18'),
      () => library.addManualBatch(['ValidNew', 'EXPIRED']),
      () => library.addManualBatch(Array.from({ length: 501 }, (_, i) => 'Code' + i)),
    ]) {
      assert.throws(attempt);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    assert(!codes().includes('ValidNew'));
  });

  await test('明确过期全局下架，混合批次不留部分条目', () => {
    library.addManualBatch(['Retired']);
    library.reconcile([{ code: 'Retired', status: 'rejected', promptName: 'GIFT_CODE_EXPIRED' }]);
    assert(library.isExpired('Retired'));
    assert(!codes().includes('Retired'));
    assert.throws(() => library.addManualBatch(['Fresh', 'Retired']), /未保存任何条目/);
    assert(!codes().includes('Fresh'));
    library.reconcile([{ code: 'Future', status: 'rejected', promptName: 'GIFT_CODE_EXPIRED_OR_NOT_YET' }]);
    assert.equal(library.isExpired('Future'), false);
  });

  await test('手动有效期按北京时间换日，不能延长公共码已有的较早到期日', () => {
    library.addManualBatch(['ManualDay'], '2026-11-19');
    library.addManualBatch(['TONIGHT'], '2026-11-21');
    assert.equal(library.entries().find(row => row.code === 'TONIGHT').expiresAt, '2026-11-19');
    now = Date.parse('2026-11-19T15:59:59.999Z');
    assert(codes().includes('ManualDay'));
    now++;
    assert(!codes().includes('ManualDay'));
    assert(library.isExpired('TONIGHT'));
  });

  await test('筛选、越界页码、全量 CSV 与公式字符转义', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ code: 'Code' + i, status: 'success', detail: '奖励', at: String(i) }));
    rows.push({ code: 'bad', status: 'rejected', detail: '礼包码无效' });
    rows.push({ code: 'future', status: 'rejected', promptName: 'GIFT_CODE_EXPIRED_OR_NOT_YET', detail: '不在兑换有效期' });
    assert.equal(filterGiftRecords(rows).length, 26);
    assert.equal(filterGiftRecords(rows, 'invalid').length, 1);
    assert.equal(filterGiftRecords(rows, 'retryable')[0].code, 'future');
    const last = paginateGiftRecords(rows, { status: 'success', page: '99', pageSize: '10' });
    assert.deepEqual([last.total, last.pages, last.page, last.rows.length], [25, 3, 3, 5]);
    assert.throws(() => paginateGiftRecords(rows, { page: '-1' }));
    assert.throws(() => paginateGiftRecords(rows, { pageSize: '1e1' }));
    assert.throws(() => filterGiftRecords(rows, 'wrong'));
    assert.equal(giftRecordsCsv(rows, 'success').split('\r\n').filter(Boolean).length, 26);
    const escaped = giftRecordsCsv([{ code: '=FORMULA', status: 'success', detail: 'a,"b"\nnext', at: '\tformula' }], 'all');
    assert(escaped.startsWith('\uFEFF'));
    assert(escaped.includes('"\'=FORMULA"'));
    assert(escaped.includes('"a,""b""\nnext"'));
    assert(escaped.includes('"\'\tformula"'));
  });

  const sent = [];
  const client = { promptNames: { 1: 'GIFT_CODE_EXPIRED_OR_NOT_YET' }, async request(name, body) {
    assert.equal(name, 'GotGiftCodeRequest');
    sent.push(body.giftCode);
    if (body.giftCode === 'Unknown') throw Error('fixture timeout');
    if (body.giftCode === 'FutureReward' && !client.ready) throw Object.assign(Error('fixture not yet'), { request: name, prompt: { prompt: 1 } });
    return { reward: { asset: [{ id: 'RUBY', num: 1 }] } };
  } };
  const dispatch = work => work(client, () => true);

  await test('共享码按账号隔离兑换，旧重复提交保留 skipped 兼容', async () => {
    publicGiftCodes.addManualBatch(['SharedReward']);
    await startGiftCodes('first', 'SharedReward', dispatch).done;
    await startGiftCodes('first', 'SharedReward', dispatch).done;
    assert.equal(giftCodeStatus('first').rows[0].status, 'skipped');
    assert(!publicGiftCodes.available(giftCodeStatus('first').rows).includes('SharedReward'));
    const batch = startGiftCodeBatch([{ id: 'second', codes: 'SharedReward', dispatch }], null);
    assert.equal(batch[0].accepted, true);
    await batch[0].done;
    assert.equal(sent.filter(code => code === 'SharedReward').length, 2);
  });

  await test('尚未生效的明确拒绝可人工重试，成功后不能再次重试', async () => {
    await startGiftCodes('future-account', 'FutureReward', dispatch).done;
    const history = giftCodeStatus('future-account').rows;
    assert.equal(history[0].promptName, 'GIFT_CODE_EXPIRED_OR_NOT_YET');
    assert(canRetryGiftCode(history, 'FutureReward'));
    client.ready = true;
    await startGiftCodes('future-account', 'FutureReward', dispatch, { stop: '' }, { retry: true }).done;
    assert.equal(giftCodeStatus('future-account').rows[0].status, 'success');
    assert.throws(() => startGiftCodes('future-account', 'FutureReward', dispatch, { stop: '' }, { retry: true }), /不允许重试/);
  });

  await test('未知结果持久防重，排队期间过期不会发送', async () => {
    await startGiftCodes('unknown-account', 'Unknown', dispatch).done;
    assert(!canRetryGiftCode(giftCodeStatus('unknown-account').rows, 'Unknown'));
    assert.throws(() => startGiftCodes('unknown-account', 'Unknown', dispatch, { stop: '' }, { retry: true }), /不允许重试/);
    publicGiftCodes.addManualBatch(['PendingExpiry']);
    let release;
    const job = startGiftCodes('pending-expiry', 'PendingExpiry', action => new Promise(resolve => { release = resolve; }).then(() => dispatch(action)));
    publicGiftCodes.expire('PendingExpiry');
    release();
    await job.done;
    assert(!sent.includes('PendingExpiry'));
    assert.equal(giftCodeStatus('pending-expiry').rows[0].status, 'skipped');
  });

  console.log(`礼包共享库与兑换记录专项 ${passed}/${passed} 通过（临时数据、假客户端、零游戏连接）`);
} finally {
  assert.equal(path.dirname(path.resolve(directory)), temporary);
  fs.rmSync(directory, { recursive: true, force: true });
}
