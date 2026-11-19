import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash, createECDH } from 'node:crypto';
import { once } from 'node:events';
import { varint, readVarint, pbLen, pbVar, pbParse, lz4AllLiteral, lz4Decompress } from '../src/wechat/bytes.mjs';
import { hkdfExtract, hkdfExpand, gcmEncrypt, gcmDecrypt, nonce, buildRecordAAD, generateECDH,
  mmtlsSecret, deriveHandshakeKeys, deriveMaster, deriveAppKeys, finishedVerifyData,
  encryptRecordPayload, decryptRecordPayload, aesGCMEncryptLayout, aesGCMDecryptLayout } from '../src/wechat/mmtls-crypto.mjs';
import { buildRecord, parseRecords, buildHandshake, splitHandshake, buildClientHello, parseServerHello,
  buildFinished, parseFinished, parseNewSessionTicket, buildShortlink, parseShortlink, u16, u32,
  ctHandshake, ctAppData, hsServerHello, hsCertVerify, hsNewSessionTicket, hsFinished } from '../src/wechat/mmtls-wire.mjs';
import { connectMmtls, pickAccessPSK, pickRefreshPSK } from '../src/wechat/mmtls-client.mjs';

const hex = value => Buffer.from(value, 'hex');
const sha = bytes => createHash('sha256').update(bytes).digest();
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };

await test('uint64、protobuf 固定线格式和非法截断，64位数保持精确', () => {
  assert.equal(varint(150n).toString('hex'), '9601');
  assert.equal(varint(0xffffffffffffffffn).toString('hex'), 'ffffffffffffffffff01');
  assert.deepEqual(readVarint(hex('009601'), 1), { value: 150n, offset: 3, next: 3 });
  assert.equal(pbVar(1, 150n).toString('hex'), '089601');
  assert.equal(pbLen(16, Buffer.from('abc')).toString('hex'), '820103616263');
  const fields = pbParse(hex('08ffffffffffffffffff011203616263'));
  assert.equal(fields.get(1), 0xffffffffffffffffn); assert.equal(fields.get(2).toString(), 'abc');
  for (const bytes of ['80', 'ffffffffffffffffff02', '12ff', '120261', '0d01', '00']) assert.throws(() => pbParse(hex(bytes)));
  assert.throws(() => varint(Number.MAX_SAFE_INTEGER + 1)); assert.throws(() => varint(-1n));
});

await test('LZ4 固定字面量与重叠回溯，截断、偏移和输出上限均拒绝', () => {
  assert.equal(lz4AllLiteral(Buffer.from('abc')).toString('hex'), '30616263');
  assert.equal(lz4AllLiteral(Buffer.alloc(15, 0x41)).toString('hex'), 'f000' + '41'.repeat(15));
  assert.equal(lz4Decompress(hex('326162630300')).toString(), 'abcabcabc');
  assert.equal(lz4Decompress(hex('30616263')).toString(), 'abc');
  for (const bytes of ['f0', '40616263', '000000', '106101', '1f610100']) assert.throws(() => lz4Decompress(hex(bytes)));
  assert.throws(() => lz4Decompress(hex('326162630300'), 8));
});

await test('RFC 5869 SHA-256 HKDF 固定向量，不依赖往返自验证', () => {
  const prk = hkdfExtract(hex('000102030405060708090a0b0c'), Buffer.alloc(22, 0x0b));
  assert.equal(prk.toString('hex'), '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');
  assert.equal(hkdfExpand(prk, hex('f0f1f2f3f4f5f6f7f8f9'), 42).toString('hex'),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  assert.throws(() => hkdfExpand(prk, Buffer.alloc(0), 8161));
});

await test('NIST AES-GCM 固定向量、认证标签及序号/AAD 篡改检查', () => {
  const key = Buffer.alloc(16), iv = Buffer.alloc(12), plain = Buffer.alloc(16), aad = Buffer.alloc(0);
  const expected = hex('0388dace60b6a392f328c2b971b2fe78ab6e47d42cec13bdf53a67b21257bddf');
  assert.deepEqual(gcmEncrypt(key, iv, 0n, plain, aad), expected);
  assert.deepEqual(gcmDecrypt(key, iv, 0n, expected, aad), plain);
  const tampered = Buffer.from(expected); tampered[0] ^= 1;
  assert.throws(() => gcmDecrypt(key, iv, 0n, tampered, aad));
  assert.throws(() => gcmDecrypt(key, iv, 1n, expected, aad));
  assert.throws(() => gcmDecrypt(key, iv, 0n, expected, Buffer.from('x')));
  assert.equal(nonce(Buffer.alloc(12), 0x100000000n).toString('hex'), '000000000000000100000000');
  assert.equal(buildRecordAAD(2n, ctAppData, 32).toString('hex'), '000000000000000217f1030020');
  const layout = aesGCMEncryptLayout(key, aad, plain, { iv });
  assert.deepEqual(layout, Buffer.concat([expected.subarray(0, 16), iv, expected.subarray(16)]));
  assert.deepEqual(aesGCMDecryptLayout(key, aad, layout), plain);
  assert.throws(() => aesGCMDecryptLayout(key, aad, Buffer.alloc(27)));
});

await test('P-256 公钥固定向量与标准 ECDH，非法点拒绝', () => {
  const one = Buffer.alloc(32); one[31] = 1;
  const key = generateECDH({ privateKey: one });
  const generator = hex('046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5');
  assert.deepEqual(key.publicKey, generator);
  assert.deepEqual(mmtlsSecret(key.privateKey, generator), sha(generator.subarray(1, 33)));
  assert.throws(() => mmtlsSecret(key.privateKey, Buffer.alloc(65, 4)));
});

await test('ClientHello 与应用封包固定格式，记录分片及错误长度拒绝', () => {
  const first = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]), second = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]);
  const hello = buildClientHello(Buffer.alloc(32, 0xa5), 0x01020304, first, second);
  const expected = '000000d00103f101c02b' + 'a5'.repeat(32) + '01020304000000a2010000009d00100200000047000000010041'
    + first.toString('hex') + '00000047000000020041' + second.toString('hex') + '00000001';
  assert.equal(hello.toString('hex'), expected);
  const packet = buildShortlink(0xd7d, 3, Buffer.from('abc'));
  assert.equal(packet.toString('hex'), '000000131110076d00000d7d00000003616263');
  assert.deepEqual(parseShortlink(packet), { totalLen: 19, magic: 0x1110, ver: 0x076d, cmd: 0xd7d, seq: 3, body: Buffer.from('abc') });
  const record = buildRecord(ctHandshake, hello);
  assert.equal(record.subarray(0, 5).toString('hex'), '16f10300d4');
  assert.equal(parseRecords(record.subarray(0, -1)).consumed, 0);
  assert.equal(parseRecords(Buffer.concat([record, record.subarray(0, 4)])).consumed, record.length);
  assert.throws(() => parseRecords(hex('1603030000')));
  assert.throws(() => splitHandshake(hex('0000000201')));
  assert.throws(() => parseFinished(hex('0020')));
  assert.throws(() => parseNewSessionTicket(hex('010000000501')));
  assert.throws(() => parseShortlink(Buffer.concat([packet, Buffer.from([0])])));
  assert.throws(() => parseServerHello(Buffer.alloc(40)));
});

// This peer performs a real loopback TCP handshake, including fragmented and
// coalesced records, then validates the client's Finished and application record.
async function withPeer(mode, work) {
  const sockets = new Set(), errors = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let bytes = Buffer.alloc(0), stage = 0, hsKeys, appKeys, secret, finalHash;
    const send = data => { socket.write(data.subarray(0, 3)); setImmediate(() => { if (!socket.destroyed) socket.write(data.subarray(3)); }); };
    socket.on('data', chunk => {
      if (mode === 'silent') return;
      bytes = Buffer.concat([bytes, chunk]);
      try {
        const parsed = parseRecords(bytes); bytes = Buffer.from(bytes.subarray(parsed.consumed));
        for (const record of parsed.records) {
          if (stage === 0) {
            assert.equal(record.contentType, ctHandshake);
            assert.equal(record.payload[4], 1);
            // Read the first offered key from the documented, fixed layout.
            const clientKey = record.payload.subarray(68, 133);
            assert.equal(clientKey.length, 65); assert.equal(clientKey[0], 4);
            const key = createECDH('prime256v1'); key.generateKeys();
            secret = sha(key.computeSecret(clientKey));
            const share = Buffer.concat([Buffer.from([0, 16]), u32(1), u16(65), key.getPublicKey()]);
            const extension = Buffer.concat([Buffer.from([1]), u32(share.length), share]);
            const shBody = Buffer.concat([hex('03f1c02b'), Buffer.alloc(32, 7), u32(extension.length), extension]);
            const hello = buildHandshake(hsServerHello, shBody);
            hsKeys = deriveHandshakeKeys(secret, sha(Buffer.concat([record.payload, hello])));
            const certificate = buildHandshake(hsCertVerify, Buffer.from('synthetic-certificate-verify'));
            const entry = Buffer.concat([Buffer.from([1]), u32(300), Buffer.from('synthetic-ticket')]);
            const ticket = buildHandshake(hsNewSessionTicket, Buffer.concat([Buffer.from([1]), u32(entry.length), entry]));
            finalHash = sha(Buffer.concat([record.payload, hello, certificate, ticket]));
            const verify = finishedVerifyData(secret, false, finalHash);
            if (mode === 'bad-finished') verify[0] ^= 1;
            const finished = buildFinished(verify);
            appKeys = deriveAppKeys(deriveMaster(secret, finalHash), finalHash);
            const flight = Buffer.concat([
              buildRecord(ctHandshake, hello),
              buildRecord(ctHandshake, encryptRecordPayload(hsKeys.serverKey, hsKeys.serverIV, 1n, ctHandshake, certificate)),
              buildRecord(ctHandshake, encryptRecordPayload(hsKeys.serverKey, hsKeys.serverIV, 2n, ctHandshake, ticket)),
              buildRecord(ctHandshake, encryptRecordPayload(hsKeys.serverKey, hsKeys.serverIV, 3n, ctHandshake, finished)),
            ]);
            stage = 1;
            if (mode === 'truncated') socket.end(flight.subarray(0, 10)); else send(flight);
          } else if (stage === 1) {
            const decoded = splitHandshake(decryptRecordPayload(hsKeys.clientKey, hsKeys.clientIV, 1n, ctHandshake, record.payload));
            assert.equal(decoded.type, hsFinished);
            assert.deepEqual(parseFinished(decoded.body), finishedVerifyData(secret, true, finalHash));
            stage = 2;
          } else {
            const packet = parseShortlink(decryptRecordPayload(appKeys.clientKey, appKeys.clientIV, 2n, ctAppData, record.payload));
            assert.equal(packet.cmd, 0xd7d); assert.equal(packet.seq, 0); assert.equal(packet.body.toString(), 'synthetic-request');
            const response = buildShortlink(packet.cmd, packet.seq, Buffer.from('synthetic-response'));
            const encrypted = encryptRecordPayload(appKeys.serverKey, appKeys.serverIV, 4n, ctAppData, response);
            if (mode === 'bad-tag') encrypted[0] ^= 1;
            socket.end(buildRecord(ctAppData, encrypted));
          }
        }
      } catch (error) { errors.push(error); socket.destroy(); }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await work({ host: '127.0.0.1', port: server.address().port }); assert.deepEqual(errors, []); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}

await test('本地假 TCP 完整握手、票据和应用交换，服务端验证客户端 Finished', async () => {
  await withPeer('valid', async target => {
    const controller = new AbortController();
    const client = await connectMmtls(target, { timeoutMs: 2000, signal: controller.signal });
    try {
      const tickets = client.extractPSKs(); assert.equal(tickets.length, 1);
      assert.equal(tickets[0].pskType, 1); assert.equal(tickets[0].preSharedKey.length, 64);
      assert(pickAccessPSK(tickets)); assert.equal(pickRefreshPSK(tickets), undefined);
      const ended = new Promise(resolve => client.socket.once('close', resolve));
      assert.equal(await client.sendApp(0xd7d, Buffer.from('synthetic-request')), 0);
      const reply = await client.recvApp(); assert.equal(reply.body.toString(), 'synthetic-response');
      await ended;
      assert.equal(client.extractPSKs()[0].preSharedKey, tickets[0].preSharedKey, 'FIN 不能撤销已校验握手的取码票据');
      controller.abort();
      assert.throws(() => client.extractPSKs(), error => error.name === 'AbortError', '取消后不再导出票据');
    } finally { client.close(); }
  });
});

await test('握手 Finished 篡改、半包结束及应用认证失败均拒绝', async () => {
  await withPeer('bad-finished', target => assert.rejects(connectMmtls(target, { timeoutMs: 2000 }), /ServerFinished/));
  await withPeer('truncated', target => assert.rejects(connectMmtls(target, { timeoutMs: 2000 }), /结束/));
  await withPeer('bad-tag', async target => {
    const client = await connectMmtls(target, { timeoutMs: 2000 });
    try {
      await client.sendApp(0xd7d, Buffer.from('synthetic-request'));
      await assert.rejects(client.recvApp());
      assert.throws(() => client.extractPSKs(), '认证失败后即使收到 FIN 也不能导出票据');
    }
    finally { client.close(); }
  });
});

await test('无响应 TCP 超时与外部取消都会关闭连接，不等待真实网络', async () => {
  await withPeer('silent', target => assert.rejects(connectMmtls(target, { timeoutMs: 50 }), error => error.name === 'TimeoutError'));
  await withPeer('silent', async target => {
    const controller = new AbortController();
    const pending = connectMmtls(target, { timeoutMs: 2000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, error => error.name === 'AbortError');
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(connectMmtls({ host: '127.0.0.1', port: 1 }, { signal: controller.signal }), error => error.name === 'AbortError');
});
console.log(`微信 MMTLS 专项 ${passed}/${passed} 通过（固定向量、回环假服务，零微信/游戏连接）`);
