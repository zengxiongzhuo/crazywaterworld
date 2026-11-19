import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createTraceLog, emitDiagnostic, traceJson } from '../src/trace-log.mjs';
import { createProtocolDiagnostics } from '../src/protocol-diagnostics.mjs';
import { createOperationLog } from '../src/operation-log.mjs';
import { formatConsoleLog } from '../src/console-log.mjs';
import { classifyLog } from '../src/log-categories.mjs';
import { prepareAd } from '../src/ad-shop.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-trace-log-'));
const douyinTrace = JSON.parse(traceJson({ sessionid: 'fixture-web-session', hostSessionId: 'fixture-host-session',
  frameId: 'fixture-verification-frame', image: 'data:image/png;base64,fixture-challenge',
  anonymousCode: 'fixture-anonymous-code', cloudCode: 'fixture-cloud-code', code: 'fixture-login-code',
  qrImage: 'data:image/png;base64,fixture-image', error: { code: 21101 },
  message: 'sessionid=fixture-session-text anonymousCode=fixture-anonymous-text' }));
assert.equal(douyinTrace.error.code, 21101, '数值错误码保留以便诊断');
assert.doesNotMatch(JSON.stringify(douyinTrace), /fixture-|data:image/);
const file = path.join(dir, 'protocol.log');
function diagnosticFrame(name, size = 4) {
  const frame = Buffer.alloc(11 + name.length + size, 0);
  frame.writeInt32BE(frame.length - 4, 0);
  frame[4] = 2; frame.writeInt32BE(123, 5); frame[9] = name.length;
  frame.write(name, 10, 'ascii');
  frame.fill(0xab, 11 + name.length);
  return frame;
}
const snapshotDir = path.join(dir, 'protocol-errors');
const diagnostics = createProtocolDiagnostics(snapshotDir);
const unknownFrame = diagnosticFrame('SCUnknownFarmUpdate');
const diagnosticEvent = { phase: 'message', error: 'Unknown message type: SCUnknownFarmUpdate', frame: unknownFrame,
  pending: [{ name: 'FarmHarvestRequest', responseName: 'FarmHarvestResponse' }], watchers: [],
  sendSeqNo: 12, recvSeqNo: 122, recentFrames: [{ direction: 'out', name: 'FarmHarvestRequest', seq: 12, bytes: 40 }] };
const savedSnapshot = diagnostics.save(diagnosticEvent, { account: 'alipay:test', token: 'secret-context' });
const savedRecord = JSON.parse(fs.readFileSync(savedSnapshot.file, 'utf8'));
assert.deepEqual(Buffer.from(savedRecord.frameHex, 'hex'), unknownFrame, '错误原始帧必须逐字节保留以便离线重放');
assert.equal(savedRecord.header.name, 'SCUnknownFarmUpdate');
assert.equal(savedRecord.header.seq, 123);
assert.equal(savedRecord.pending[0].name, 'FarmHarvestRequest');
assert.equal(savedRecord.account, 'alipay:test');
assert.equal(savedRecord.token, '[已脱敏]');
assert.equal(savedRecord.truncated, false);
const loginSnapshot = diagnostics.save({ phase: 'login', error: 'Unknown message type: FutureLoginResponse', frameBytes: 50,
  header: { version: 2, name: 'FutureLoginResponse', seq: 77, flag: 0, payloadOffset: 30, token: 'secret-header' } });
const loginRecord = JSON.parse(fs.readFileSync(loginSnapshot.file, 'utf8'));
assert.equal(loginRecord.header.name, 'FutureLoginResponse');
assert.equal(loginRecord.header.seq, 77);
assert.equal(loginRecord.frameBytes, 50);
assert(!('frameHex' in loginRecord));
assert(!('token' in loginRecord.header));
for (const event of [
  { ...diagnosticEvent, phase: 'login' },
  { ...diagnosticEvent, frame: diagnosticFrame('LoginResponse') },
  { ...diagnosticEvent, frame: diagnosticFrame('AuthTokenResponse') },
  { ...diagnosticEvent, frame: Buffer.from('token=secret-malformed') },
]) {
  const saved = diagnostics.save(event);
  const record = JSON.parse(fs.readFileSync(saved.file, 'utf8'));
  assert(!('frameHex' in record));
  assert(record.rawOmitted);
  assert.equal(record.capturedBytes, 0);
}
const oversizedSnapshot = diagnostics.save({ ...diagnosticEvent, frame: diagnosticFrame('SCHugeUpdate', 300 * 1024) });
const oversizedRecord = JSON.parse(fs.readFileSync(oversizedSnapshot.file, 'utf8'));
assert.equal(oversizedRecord.capturedBytes, 256 * 1024);
assert.equal(oversizedRecord.frameHex.length, 512 * 1024);
assert.equal(oversizedRecord.truncated, true);
fs.writeFileSync(path.join(snapshotDir, 'keep.json'), '{}');
for (let index = 0; index < 102; index++) {
  const saved = diagnostics.save(diagnosticEvent);
  assert(fs.existsSync(saved.file), '保留最新写入，即使多个错误在同一毫秒到达');
}
assert.equal(fs.readdirSync(snapshotDir).filter(name => name.startsWith('decode-')).length, 100);
assert(fs.existsSync(path.join(snapshotDir, 'keep.json')), '只清理本模块生成的快照');
const blockedSnapshotPath = path.join(dir, 'snapshot-path-is-file');
fs.writeFileSync(blockedSnapshotPath, 'x');
assert(createProtocolDiagnostics(blockedSnapshotPath).save(diagnosticEvent).error, '写入失败以结果返回，不中断业务');
const log = createTraceLog(file, { maxBytes: 1024 });
log.write('a'.repeat(700) + '\n');
log.write('b'.repeat(700) + '\n');
log.write('c'.repeat(700) + '\n');
await log.close();
const files = [file, file + '.1'];
assert.deepEqual(log.files, files);
for (const target of files) {
  const stat = fs.statSync(target);
  assert(stat.size > 0 && stat.size <= 1024, target + ' must stay within the size limit');
}
assert.match(fs.readFileSync(file, 'utf8'), /^c+$/m);
assert.match(fs.readFileSync(file + '.1', 'utf8'), /^b+$/m);

const oversized = path.join(dir, 'oversized.log');
fs.writeFileSync(oversized, 'o'.repeat(4096));
const trimmed = createTraceLog(oversized, { maxBytes: 1024 });
trimmed.write('z\n');
await trimmed.close();
assert(fs.statSync(oversized).size <= 1024);
assert.equal(fs.statSync(oversized).size, 2);

const empty = createTraceLog(path.join(dir, 'empty.log'), { maxBytes: 1024 });
assert.equal(fs.existsSync(path.join(dir, 'empty.log')), false, 'lazy: no file before the first write');
await empty.close();

const largeFile = path.join(dir, 'large-record.log');
const large = createTraceLog(largeFile, { maxBytes: 1024 });
large.write('舰队状态'.repeat(1024));
await large.close();
assert(fs.statSync(largeFile).size <= 1024, '单条超大回包也不能突破大小上限');
assert.match(fs.readFileSync(largeFile, 'utf8'), /日志过长，已截断/);
assert.doesNotMatch(fs.readFileSync(largeFile, 'utf8'), /\ufffd/);

const resumedFile = path.join(dir, 'resumed.log');
fs.writeFileSync(resumedFile, '旧文件\n');
fs.writeFileSync(resumedFile + '.1', '最新文件\n');
fs.utimesSync(resumedFile, 1000, 1000);
fs.utimesSync(resumedFile + '.1', 2000, 2000);
const resumed = createTraceLog(resumedFile, { maxBytes: 1024 });
resumed.write('重启后\n');
await resumed.close();
assert.equal(fs.readFileSync(resumedFile, 'utf8'), '旧文件\n');
assert.equal(fs.readFileSync(resumedFile + '.1', 'utf8'), '最新文件\n重启后\n');

const cyclic = { uid: 9007199254740993n, access_token: 'secret-token', nested: { password: 'secret-password' } };
cyclic.self = cyclic;
const redacted = traceJson({ cyclic, login: { data: 'secret-login' }, error: new Error('token=secret-error'),
  url: 'https://name:secret-url@example.test/path?openId=secret-open&sign=secret-sign',
  text: 'Authorization: Bearer secret-bearer' });
assert.doesNotMatch(redacted, /secret-/);
assert.match(redacted, /9007199254740993/);
assert.match(redacted, /循环引用/);
assert.doesNotThrow(() => emitDiagnostic({ emit() { throw new Error('observer failed'); } }, 'fleet-settlement', {}));
assert.equal(classifyLog('任意正文', { category: 'production' }), 'production');
assert.doesNotMatch(formatConsoleLog({ message: 'token=secret-terminal', t: Date.now() }), /secret-terminal/);
assert.doesNotMatch(traceJson({ loginFrameHex: 'secret-frame' }), /secret-frame/);
const quotedError = new Error('响应 ' + JSON.stringify({ phone: 'secret-phone', token: 'secret-quoted', sign: 'secret-escaped"tail' }));
assert.doesNotMatch(traceJson({ message: quotedError.message, error: quotedError }), /secret-/);
assert.doesNotMatch(formatConsoleLog({ message: quotedError.message }), /secret-/);
const actor = new EventEmitter(), operationEvents = [];
actor.on('diagnostic', entry => operationEvents.push(entry));
const firstOperation = createOperationLog(actor, { request: 'WriteRequest', module: 'test', dedupeKey: 'world:operation' });
const nextOperation = createOperationLog(actor, { request: 'WriteRequest', module: 'test' });
assert.equal(actor.listenerCount('sent'), 1);
actor.emit('sent', { dir: 'out', name: 'OtherRequest', seq: 1 });
actor.emit('sent', { dir: 'out', name: 'WriteRequest', seq: 2 });
firstOperation.phase('confirmed', 'confirmed');
firstOperation.phase('unknown', 'pending');
firstOperation.phase('sent', 'pending');
firstOperation.phase('confirmed', 'confirmed');
firstOperation.close();
actor.emit('sent', { dir: 'out', name: 'WriteRequest', seq: 3 });
actor.emit('close');
assert.equal(actor.listenerCount('sent'), 0);
assert.equal(actor.listenerCount('close'), 0);
assert.equal(actor.listenerCount('state'), 0);
assert.deepEqual(operationEvents.filter(row => row.operationId === firstOperation.operationId).map(row => row.phase), ['reserved', 'sent', 'confirmed']);
assert.deepEqual(operationEvents.filter(row => row.operationId === nextOperation.operationId).map(row => row.phase), ['reserved', 'sent', 'unknown']);
assert.equal(operationEvents.find(row => row.seq === 2).dedupeKey, 'world:operation');
createOperationLog(actor, { request: 'WriteRequest' });
actor.emit('state', { state: 'STOPPED' });
assert.equal(actor.listenerCount('sent'), 0);
assert.equal(actor.listenerCount('state'), 0);
const cancelledOperation = createOperationLog(actor, { request: 'WriteRequest' });
cancelledOperation.phase('cancelled', 'not-sent');
cancelledOperation.phase('unknown', 'pending');
cancelledOperation.phase('cancelled', 'rejected');
cancelledOperation.close();
assert.deepEqual(operationEvents.filter(row => row.operationId === cancelledOperation.operationId).map(row => row.phase), ['reserved', 'cancelled']);
const adEvents = [];
for (const waitMs of [0, 1]) {
  await prepareAd({ emit: (name, event) => adEvents.push(event), request: async () => ({}) }, { waitMs }, { type: 2, id: 1 }, () => true);
}
assert.deepEqual(adEvents.map(row => row.adMode), ['privileged', 'waiting']);
const blocked = path.join(dir, 'blocked');
fs.writeFileSync(blocked, '普通文件');
const failed = createTraceLog(path.join(blocked, 'protocol.log'));
assert.doesNotThrow(() => failed.write('日志目录不可写'));
await failed.close();

// 从真实控制台接线验证日志完整性，所有游戏通信均由假客户端处理。
const dataDir = path.join(dir, 'console');
fs.mkdirSync(dataDir);
process.env.CW_DATA_DIR = dataDir;
process.env.CW_CONFIG_PACK = path.join(dataDir, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { GameClient } = await import('../src/client.mjs');
const transport = new GameClient({ protocol: {}, url: 'ws://invalid.invalid' });
transport.codec = { encode: () => Buffer.alloc(0) };
transport.socket = { readyState: 1, send() { throw new Error('测试发送失败'); } };
const handedOff = [];
transport.on('sent', entry => handedOff.push(entry));
assert.throws(() => transport.send('WriteRequest', {}), /测试发送失败/);
assert.equal(handedOff.length, 0, 'socket.send抛错时不能标记已发送');
transport.socket.send = () => {};
transport.send('WriteRequest', {});
assert.equal(handedOff.length, 1);
transport.on('sent', () => { throw new Error('诊断观察者失败'); });
assert.doesNotThrow(() => transport.send('WriteRequest', {}));
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
Object.defineProperty(GameClient.prototype, 'connected', { get() { return this.state === 'READY'; } });
GameClient.prototype.connect = async function () {
  this.state = 'READY';
  return { playerInfo: { playerId: 9001, worldId: 1001, nickname: '日志测试', level: 1 } };
};
GameClient.prototype.send = () => {};
GameClient.prototype.request = async () => ({ fleets: [], items: [], records: [] });
GameClient.prototype.stop = function () { this.state = 'STOPPED'; this.emit('close', {}); };
saveStore({ activeId: 'trace-test', accounts: [{ id: 'trace-test', url: 'ws://invalid.invalid', login: {}, automation: { enabled: false } }] });
const webEntries = [];
const app = createConsole({ port: 0, protocol: {}, onLog: entry => webEntries.push(entry) });
try {
  const root = await app.listen();
  const response = await fetch(root + '/api/connect?account=trace-test', { method: 'POST', body: '{}' });
  assert.equal(response.status, 200, await response.text());
  const session = app.sessions.get('trace-test');
  const fleets = Array.from({ length: 20 }, (_, index) => ({ buildingId: (index + 1) + '远征船', state: 0, curGridIdx: 123456 + index }));
  const webBefore = webEntries.length;
  session.client.emit('message', { name: 'MyFleetsResponse', seq: 7, body: { fleets } });
  // 基地完整状态是“已发送却未生效 / 材料扣款待确认”反馈的核对依据。
  for (const name of ['OnWaterResponse', 'AllItemResponse', 'AllResourceResponse', 'AllPetResponse']) {
    session.client.emit('message', { name, seq: 9, body: { records: Array.from({ length: 30 }, (_, index) =>
      ({ id: `${name}-${index}`, num: index })), token: 'secret-base-packet' } });
  }
  session.client.emit('frame', { dir: 'out', name: 'TreasureLootSendFleetsRequest', seq: 8, bytes: Buffer.alloc(32), body: { uid: 5001, fleetBuildingIds: ['20远征船'] } });
  emitDiagnostic(session.client, 'treasure-plan', { notes: ['首杀占用待核对'], fleets, accessToken: 'secret-plan' });
  assert.equal(webEntries.length, webBefore, '完整协议与诊断事件只写文件');
  const business = app.emit(session, 'warn', '舰队暂不派遣', { diagnostic: 'token=secret-detail', request: 'TreasureLootSendFleetsRequest' });
  assert.equal(webEntries.at(-1), business, '网页和终端共用脱敏后的业务日志对象');
  assert.equal(business.detail, 'token=[已脱敏]');
  assert.doesNotMatch(JSON.stringify(session.log), /secret-/);
  const tracked = createOperationLog(session.client, { request: 'WriteRequest', module: 'test', dedupeKey: 'test:key' });
  session.client.emit('frame', { dir: 'out', name: 'WriteRequest', seq: 10, bytes: Buffer.alloc(0), body: {} });
  session.client.emit('sent', { dir: 'out', name: 'WriteRequest', seq: 10 });
  tracked.phase('unknown', 'pending', { reason: 'token=secret-operation' });
  tracked.close();
  const chain = webEntries.filter(entry => entry.operationId === tracked.operationId);
  assert.deepEqual(chain.map(entry => entry.phase), ['reserved', 'sent', 'unknown']);
  assert(chain.every(entry => entry.dedupeKey === 'test:key'));
  assert.doesNotMatch(JSON.stringify(chain), /secret-/);
  app.emit(session, 'error', quotedError.message, { diagnostic: quotedError.stack });
  session.client.emit('diagnostic', { ...diagnosticEvent, event: 'protocol-decode-error' });
  const protocolError = webEntries.at(-1);
  assert.match(protocolError.message, /SCUnknownFarmUpdate.*诊断快照已保存/);
  assert.match(protocolError.detail, /FarmHarvestRequest/);
  assert.equal(protocolError.extra.messageName, 'SCUnknownFarmUpdate');
  assert.deepEqual(Buffer.from(JSON.parse(fs.readFileSync(protocolError.extra.protocolSnapshot, 'utf8')).frameHex, 'hex'), unknownFrame);
  assert.doesNotMatch(JSON.stringify(protocolError), /"frameHex":|abababab/, '终端与网页不输出原始二进制');
  const stream = await fetch(root + '/api/events?account=trace-test', { signal: AbortSignal.timeout(5000) });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let streamed = '';
  try {
    while (!streamed.includes('id: ' + protocolError.id + '\n') || !streamed.endsWith('\n\n')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, '诊断日志到达前不能结束事件流');
      streamed += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(streamed, /已脱敏/);
    assert.doesNotMatch(streamed, /secret-/);
  } finally { await reader.cancel(); }
  const trace = fs.readFileSync(path.join(dataDir, 'protocol.log'), 'utf8');
  assert.match(trace, /\[MyFleetsResponse\] seq=7 .*20远征船/);
  assert.match(trace, /-> \[TreasureLootSendFleetsRequest\] seq=8 32B .*5001.*20远征船/);
  assert.match(trace, /diagnostic .*treasure-plan/);
  assert.match(trace, /business .*舰队暂不派遣/);
  assert.match(trace, /runtime .*startedAt.*node/);
  for (const name of ['OnWaterResponse', 'AllItemResponse', 'AllResourceResponse', 'AllPetResponse']) {
    const line = trace.split('\n').find(line => line.includes(`[${name}] seq=9`));
    assert(line?.includes(`${name}-29`), name + ' 必须保留回包末尾的记录');
    assert(!line.includes('正文已截断'), name + ' 不能按 400 字截断');
  }
  assert.doesNotMatch(trace, /secret-/);
  const writeSync = fs.writeSync;
  try {
    fs.writeSync = () => { throw new Error('模拟磁盘写入失败'); };
    assert.doesNotThrow(() => session.client.emit('diagnostic', { ...diagnosticEvent, event: 'protocol-decode-error' }));
    assert.match(webEntries.at(-1).message, /诊断快照保存失败/);
    assert.match(webEntries.at(-1).detail, /本次错误快照未保存/);
    assert.doesNotMatch(webEntries.at(-1).detail, /frameHex/);
    assert.doesNotThrow(() => app.emit(session, 'info', '磁盘失败后网页仍输出'));
    assert.equal(webEntries.at(-1).message, '磁盘失败后网页仍输出');
  } finally { fs.writeSync = writeSync; }
} finally {
  await app.close();
}
console.log('protocol log selftest ok: bounded files, restart rotation, credential redaction, complete fleet packets, diagnostic isolation and disk failures');
