// In-process, direct TCP MMTLS client. No local daemon or account database.
// Wire behavior follows YYB-Go-Enhanced v0.3.10 internal/protocol/mmtls_client.go.
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256, generateECDH, mmtlsSecret, deriveHandshakeKeys, deriveMaster, deriveAppKeys,
  encryptRecordPayload, decryptRecordPayload, finishedVerifyData, derivePSK } from './mmtls-crypto.mjs';
import { buildRecord, parseRecords, buildClientHello, splitHandshake, parseServerHello, buildFinished,
  parseFinished, parseNewSessionTicket, buildShortlink, parseShortlink, ctHandshake, ctAppData,
  hsServerHello, hsFinished, hsCertVerify, hsNewSessionTicket, cipherECDHE, groupSecP256R1 } from './mmtls-wire.mjs';

const MAX_BUFFER = 256 * 1024;
const abortError = () => Object.assign(new Error('微信协议操作已取消'), { name: 'AbortError' });
const timeoutError = () => Object.assign(new Error('微信协议连接超时'), { name: 'TimeoutError' });

export class MmtlsClient {
  constructor(socket, { signal, timeoutMs = 8000, now = Date.now, random = randomBytes, keyFactory = generateECDH } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw Error('MMTLS 超时设置无效');
    this.socket = socket; this.signal = signal; this.timeoutMs = timeoutMs; this.now = now;
    this.random = random; this.keyFactory = keyFactory;
    this.buffer = Buffer.alloc(0); this.records = []; this.transcript = [];
    this.transcriptSize = 0; this.tickets = []; this.txSeq = 0n; this.rxSeq = 0n; this.appSeq = 0;
    this.failure = null; this.waiter = null; this.ready = false; this.closed = false; this.reading = false; this.writing = false;
    this.onData = chunk => {
      if (this.closed || this.failure) return;
      if (this.buffer.length + chunk.length > MAX_BUFFER) { this.fail(Error('MMTLS 接收缓冲区过大')); return; }
      this.buffer = Buffer.concat([this.buffer, chunk]); this.wake();
    };
    this.onError = () => this.fail(Error('微信协议连接中断'));
    this.onEnd = () => {
      if (!this.failure) this.remoteEnded = true;
      this.fail(Error('微信协议连接已结束'));
    };
    this.onAbort = () => this.fail(abortError());
    socket.on('data', this.onData); socket.on('error', this.onError); socket.on('end', this.onEnd); socket.on('close', this.onEnd);
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }
  wake() { const waiter = this.waiter; this.waiter = null; waiter?.(); }
  fail(error) {
    this.failure ??= error; this.wake();
    if (!this.socket.destroyed) this.socket.destroy();
  }
  check() {
    if (this.signal?.aborted) throw abortError();
    if (this.failure) throw this.failure;
    if (this.closed) throw Error('微信协议连接已关闭');
  }
  async waitConnected() {
    this.check();
    if (!this.socket.connecting) return;
    await new Promise((resolve, reject) => {
      let finished = false;
      const done = error => {
        if (finished) return; finished = true; clearTimeout(timer);
        this.socket.off('connect', connected); this.socket.off('error', ended); this.socket.off('close', ended);
        error ? reject(error) : resolve();
      };
      const connected = () => done(), ended = () => done(this.failure ?? Error('微信协议连接失败'));
      const timer = setTimeout(() => { this.fail(timeoutError()); done(this.failure); }, this.timeoutMs);
      this.socket.once('connect', connected); this.socket.once('error', ended); this.socket.once('close', ended);
      if (this.failure) done(this.failure);
    });
    this.check();
  }
  async nextRecord() {
    for (;;) {
      if (this.signal?.aborted || this.closed) this.check();
      if (this.records.length) return this.records.shift();
      const decoded = parseRecords(this.buffer);
      if (decoded.records.length) {
        this.records = decoded.records; this.buffer = Buffer.from(this.buffer.subarray(decoded.consumed));
        return this.records.shift();
      }
      this.check();
      await new Promise(resolve => {
        const timer = setTimeout(() => this.fail(timeoutError()), this.timeoutMs);
        this.waiter = () => { clearTimeout(timer); resolve(); };
      });
    }
  }
  async sendRaw(bytes) {
    this.check();
    if (this.writing) throw Error('MMTLS 不允许并发写入');
    this.writing = true;
    try {
      await new Promise((resolve, reject) => {
        let finished = false;
        const done = error => {
          if (finished) return; finished = true; clearTimeout(timer); this.socket.off('close', closed);
          error ? reject(error) : resolve();
        };
        const closed = () => done(this.failure ?? Error('微信协议写入中断'));
        const timer = setTimeout(() => { this.fail(timeoutError()); done(this.failure); }, this.timeoutMs);
        this.socket.once('close', closed);
        try { this.socket.write(bytes, error => done(error ? Error('微信协议写入失败') : this.failure)); }
        catch { done(Error('微信协议写入失败')); }
      });
      this.check();
    } finally { this.writing = false; }
  }
  advance(direction) {
    if (this[direction] >= 0xffffffffffffffffn) throw Error('MMTLS 序号已耗尽');
    this[direction]++;
  }
  async sendPlain(type, payload) { await this.sendRaw(buildRecord(type, payload)); this.advance('txSeq'); }
  async sendEncrypted(type, plaintext, key, iv) {
    const ciphertext = encryptRecordPayload(key, iv, this.txSeq, type, plaintext);
    await this.sendRaw(buildRecord(type, ciphertext)); this.advance('txSeq');
  }
  async receivePlain() { const record = await this.nextRecord(); this.advance('rxSeq'); return record; }
  async receiveEncrypted(key, iv) {
    const record = await this.nextRecord();
    const payload = decryptRecordPayload(key, iv, this.rxSeq, record.contentType, record.payload);
    this.advance('rxSeq'); return { contentType: record.contentType, payload };
  }
  feed(payload) {
    this.transcriptSize += payload.length;
    if (this.transcriptSize > MAX_BUFFER) throw Error('MMTLS 握手数据过大');
    this.transcript.push(Buffer.from(payload));
  }
  transcriptHash() { return sha256(Buffer.concat(this.transcript)); }
  async handshake() {
    if (this.ready || this.started) throw Error('MMTLS 握手不能重复');
    this.started = true;
    const timeout = setTimeout(() => this.fail(timeoutError()), this.timeoutMs);
    try {
      const g1 = this.keyFactory(), g2 = this.keyFactory(); this.privateKey = g1.privateKey;
      const hello = buildClientHello(this.random(32), Math.floor(this.now() / 1000), g1.publicKey, g2.publicKey);
      this.feed(hello); await this.sendPlain(ctHandshake, hello);
      const first = await this.receivePlain();
      if (first.contentType !== ctHandshake) throw Error('MMTLS 期望握手记录');
      const serverMessage = splitHandshake(first.payload);
      if (serverMessage.type !== hsServerHello) throw Error('MMTLS 缺少 ServerHello');
      const server = parseServerHello(serverMessage.body);
      if (server.serverGroup !== groupSecP256R1 || server.cipher !== cipherECDHE) throw Error('MMTLS 服务器算法不支持');
      this.feed(first.payload); this.secret = mmtlsSecret(g1.privateKey, server.serverPubKey);
      this.handshakeKeys = deriveHandshakeKeys(this.secret, this.transcriptHash());
      let complete = false;
      for (let count = 0; count < 16; count++) {
        const record = await this.receiveEncrypted(this.handshakeKeys.serverKey, this.handshakeKeys.serverIV);
        if (record.contentType !== ctHandshake) throw Error('MMTLS 握手记录类型不符');
        const message = splitHandshake(record.payload);
        if (message.type === hsFinished) {
          this.finalHash = this.transcriptHash();
          const got = parseFinished(message.body), expected = finishedVerifyData(this.secret, false, this.finalHash);
          if (!timingSafeEqual(got, expected)) throw Error('MMTLS ServerFinished 校验失败');
          this.master = deriveMaster(this.secret, this.finalHash);
          this.appKeys = deriveAppKeys(this.master, this.finalHash); this.feed(record.payload); complete = true; break;
        }
        if (message.type !== hsCertVerify && message.type !== hsNewSessionTicket) throw Error('MMTLS 握手消息不支持');
        this.feed(record.payload);
        if (message.type === hsCertVerify) this.certHash = this.transcriptHash();
        if (message.type === hsNewSessionTicket) this.tickets = parseNewSessionTicket(message.body);
      }
      if (!complete) throw Error('MMTLS 握手消息数量过多');
      await this.sendEncrypted(ctHandshake, buildFinished(finishedVerifyData(this.secret, true, this.finalHash)), this.handshakeKeys.clientKey, this.handshakeKeys.clientIV);
      this.ready = true;
    } catch (error) { this.fail(error); throw error; }
    finally { clearTimeout(timeout); }
  }
  extractPSKs() {
    // A FIN after the authenticated ManualAuth reply does not revoke tickets
    // issued during the completed handshake. Cancellation and authentication
    // failures still invalidate the operation, even if FIN arrived first.
    if (this.signal?.aborted || this.closed || this.integrityFailed || this.failure && !this.remoteEnded) this.check();
    if (!this.ready || !this.secret || !this.certHash) throw Error('MMTLS 票据状态不完整');
    return this.tickets.map(ticket => ({ pskType: ticket.pskType, lifetime: ticket.lifetime,
      preSharedKey: derivePSK(this.secret, this.certHash, ticket.pskType).toString('hex'), ticketEntry: ticket.ticketEntry.toString('hex'),
      expiredAt: Math.floor(this.now() / 1000) + ticket.lifetime }));
  }
  async sendApp(cmd, body) {
    this.check(); if (!this.ready) throw Error('MMTLS 握手尚未完成');
    if (this.writing) throw Error('MMTLS 不允许并发写入');
    if (this.appSeq > 0xffffffff) throw Error('MMTLS 应用序号已耗尽');
    const seq = this.appSeq++;
    await this.sendEncrypted(ctAppData, buildShortlink(cmd, seq, body), this.appKeys.clientKey, this.appKeys.clientIV); return seq;
  }
  async recvApp() {
    if (this.signal?.aborted || this.closed || (!this.records.length && !this.buffer.length)) this.check();
    if (!this.ready || this.reading) throw Error('MMTLS 读取状态无效');
    this.reading = true;
    try {
      const record = await this.receiveEncrypted(this.appKeys.serverKey, this.appKeys.serverIV);
      if (record.contentType !== ctAppData) throw Error('MMTLS 期望应用数据');
      return parseShortlink(record.payload);
    } catch (error) { this.integrityFailed = true; this.fail(error); throw error; }
    finally { this.reading = false; }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.signal?.removeEventListener('abort', this.onAbort);
    this.fail(Error('微信协议连接已关闭'));
    this.socket.off('data', this.onData); this.socket.off('end', this.onEnd);
    // Keep the error listener until the destroyed socket has finished emitting.
    for (const key of ['secret', 'master', 'finalHash', 'certHash']) { this[key]?.fill(0); this[key] = null; }
    for (const group of [this.handshakeKeys, this.appKeys]) for (const value of Object.values(group ?? {})) value.fill(0);
    this.privateKey = null; this.transcript = []; this.records = []; this.buffer = Buffer.alloc(0); this.tickets = [];
  }
}
export async function connectMmtls(target, options = {}) {
  const host = target.host ?? target.ip ?? target.IP, port = target.port ?? target.Port;
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('微信协议目标无效');
  if (options.signal?.aborted) throw abortError();
  const socketFactory = options.socketFactory ?? (address => net.createConnection(address));
  const socket = socketFactory({ host, port });
  let client;
  try {
    client = new MmtlsClient(socket, options); await client.waitConnected(); await client.handshake(); return client;
  } catch (error) { client?.close(); if (!socket.destroyed) socket.destroy(); throw error; }
}
export const pickAccessPSK = (entries, now = Date.now()) => entries.find(entry => entry.pskType === 1 && entry.expiredAt > now / 1000);
export const pickRefreshPSK = (entries, now = Date.now()) => entries.find(entry => entry.pskType === 2 && entry.expiredAt > now / 1000);
