import assert from 'node:assert/strict';
import { createECDH, createCipheriv, createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import { pbLen, pbVar, pbParse, lz4AllLiteral } from '../src/wechat/bytes.mjs';
import { generateECDH, aesGCMEncryptLayout, derivePSKOneWayKeys, labelHandshakeKeys, encryptRecordPayload } from '../src/wechat/mmtls-crypto.mjs';
import { buildRecord, buildShortlink, ctHandshake, ctAppData } from '../src/wechat/mmtls-wire.mjs';
import { parseLoginBuffer, buildManualAuthRequest, buildLoginBody, parseLoginResponse, extractSession, wpkgHead, decodeWpkgHead,
  deriveWechatDevice, buildJSLoginPlaintext, buildTransferPacket, parseLoginCodeResponse, ManualAuthRejectedError, LoginCodeRejectedError, CMD_MANUAL_AUTH, CMD_TRANSFER } from '../src/wechat/ilink.mjs';
import { parseDomainList, discoverWechatTargets, longlinkLoginTargets, requestWechatHTTP, LONG_HOST, SHORT_HOST } from '../src/wechat/newdns.mjs';
import { build0RTTRequest, parse0RTTResponse, send0RTT, ShortlinkRejectedError } from '../src/wechat/shortlink.mjs';
import { getWechatLoginCode } from '../src/wechat/code-client.mjs';

const join = (...parts) => Buffer.concat(parts), b = value => Buffer.from(value);
const sha = (...parts) => createHash('sha256').update(join(...parts)).digest();
const buffer = join(pbLen(1, b('synthetic-ticket')), pbLen(2, b('ticket-device'))).toString('base64');
const appId = 'wx2ea52a972ea18e5e';
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };

await test('ManualAuth 与上游原生序列化固定向量逐字节相同', () => {
  assert.equal(buildManualAuthRequest(buffer, b('0123456789abcdef')).toString('hex'), '0a120a103031323334353637383961626364656610ed0e1a120a1073796e7468657469632d7469636b6574200438004006');
  assert.throws(() => parseLoginBuffer('%%%'));
  assert.throws(() => parseLoginBuffer(pbLen(1, b('ticket')).toString('base64')));
  assert.throws(() => parseLoginBuffer(join(Buffer.from(buffer, 'base64'), pbLen(3, b('wx-unsupported'))).toString('base64')), /渠道/);
});

await test('WPKG 保留大于安全整数范围的 UIN，长度和截断严格校验', () => {
  const uin = 18446744073709551600n;
  const raw = wpkgHead({ 2:uin, 23:BigInt.asUintN(64, -14n) }, { 24:b('device') });
  const parsed = decodeWpkgHead(raw);
  assert.equal(parsed.ints.get(2), uin); assert.equal(BigInt.asIntN(64, parsed.ints.get(23)), -14n);
  assert.equal(parsed.fields.get(24).toString(), 'device'); assert.equal(parsed.length, raw.length);
  assert.throws(() => decodeWpkgHead(raw.subarray(0, -1)));
  const corrupt = Buffer.from(raw); corrupt[corrupt.length - 1]--; assert.throws(() => decodeWpkgHead(corrupt), /长度/);
});

const zero = Buffer.alloc(0), sendKey = Buffer.alloc(24, 3), recvKey = Buffer.alloc(24, 4);
const uin = 9007199254740997n;
const sessionMessage = () => join(pbLen(1, pbVar(1, 0)), pbLen(3, join(pbLen(2, join(pbLen(1, sendKey), pbLen(2, recvKey), pbLen(9, b('f9')))), pbLen(3, pbVar(1, uin)))));
// Independent Node crypto construction of a peer reply: response AAD is tied
// to the original request's HKDF output and compressed plaintext.
function peerResponse(temp, message) {
  const peer = createECDH('prime256v1'); peer.setPrivateKey(Buffer.alloc(32, 7));
  const publicKey = peer.getPublicKey(), shared = peer.computeSecret(temp.privateKey.getPublicKey());
  const secret = sha(shared), aad = sha(temp.okm.subarray(24, 56), temp.compressed, b('415'), publicKey, b('1'));
  const iv = Buffer.alloc(12, 9), cipher = createCipheriv('aes-192-gcm', secret.subarray(0, 24), iv);
  cipher.setAAD(aad); const ciphertext = join(cipher.update(lz4AllLiteral(message)), cipher.final(), iv, cipher.getAuthTag());
  return join(wpkgHead({}, {}), pbLen(1, join(pbVar(1, 415), pbLen(2, publicKey))), pbVar(2, 1), pbLen(3, ciphertext));
}
await test('加密授权响应绑定原请求，篡改和错配被拒绝，大整数会话可解出', () => {
  const request = buildLoginBody(buffer, Buffer.alloc(32, 1));
  const response = peerResponse(request.temp, sessionMessage());
  const session = extractSession(parseLoginResponse(response, request.temp));
  assert.equal(session.uin, uin); assert.deepEqual(session.sendKey, sendKey); assert.deepEqual(session.recvKey, recvKey);
  const corrupt = Buffer.from(response); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => parseLoginResponse(corrupt, request.temp));
  const other = buildLoginBody(buffer, Buffer.alloc(32, 2));
  assert.throws(() => parseLoginResponse(response, other.temp));
  const denied = join(pbLen(1, join(pbVar(1, BigInt.asUintN(64, -10n)), pbLen(2, b('private-diagnostic')))), pbLen(3, pbVar(4, 0)));
  assert.throws(() => extractSession(denied), error => error instanceof ManualAuthRejectedError && error.code === -10n && !error.message.includes('private'));
});

await test('小游戏取码只读固定字段路径，拒绝优先于code且重复字段不能覆盖', () => {
  const valid = pbLen(2, join(pbLen(1, pbVar(1, 0)), pbLen(3, b('synthetic-code'))));
  assert.equal(parseLoginCodeResponse(valid), 'synthetic-code');
  for (const field of [1, 2]) for (const code of [-12028n, -14n, 42n]) {
    const raw = pbLen(2, join(pbLen(field, join(pbVar(1, BigInt.asUintN(64, code)), pbLen(2, b('private diagnostic')))), pbLen(3, b('private-code'))));
    assert.throws(() => parseLoginCodeResponse(raw), error => error instanceof LoginCodeRejectedError && error.code === code && !error.message.includes('private'));
  }
  for (const raw of [Buffer.from('12ff', 'hex'), pbVar(2, 1), pbLen(2, pbVar(3, 1)), pbLen(2, join(pbLen(3, b('one')), pbLen(3, b('two')))), join(valid, Buffer.from([0xff])), pbLen(2, pbLen(1, pbLen(1, b('wrong wire'))))]) assert.throws(() => parseLoginCodeResponse(raw));
  assert.throws(() => parseLoginCodeResponse(pbLen(9, valid)), /未返回/);
});

await test('HTTPDNS 只接受目标域名和公网地址，保留官方域名回退及取消', async () => {
  const fixture = { dns:{ retcode:0, domainlist:[{ name:LONG_HOST, iplist:[{ip:'127.0.0.1'}, {ip:'203.0.113.10'}], protocollist:[{name:'mmtlsovertcp',portlist:[8080,443,0]}] }, { name:SHORT_HOST, iplist:[{ip:'203.0.113.20'}], protocollist:[{name:'mmtlsoverhttp',portlist:[80]}] }] } };
  const parsed = parseDomainList(fixture); assert.deepEqual(parsed.get(LONG_HOST).ips, ['203.0.113.10']);
  const targets = await discoverWechatTargets({ fetcher:async()=>({ok:true,json:async()=>fixture}) });
  assert.deepEqual(targets.longlink, [{ip:'203.0.113.10',port:443},{ip:'203.0.113.10',port:8080},{ip:LONG_HOST,port:443}]);
  assert.deepEqual(targets.shortlink, [{ip:'203.0.113.20',port:80}]);
  assert.deepEqual(longlinkLoginTargets([], 1), [{ip:LONG_HOST,port:443}]);
  const fallback = await discoverWechatTargets({fetcher:async()=>{throw Error('offline');}}); assert.equal(fallback.longlink[0].ip, LONG_HOST);
  const abort = new AbortController(); abort.abort(); await assert.rejects(discoverWechatTargets({signal:abort.signal,fetcher:async()=>{throw Error('should not run');}}));
});

await test('ShortLink 验证两层认证，保留明确拒绝且不重放未知结果', async () => {
  const psk = Buffer.alloc(32, 7), hello = b('synthetic-client'), serverHello = b('synthetic-server'), type8 = b('synthetic-type8');
  const keys = derivePSKOneWayKeys(psk, labelHandshakeKeys, sha(hello, serverHello));
  const responseMessage = pbLen(2, pbLen(3, b('shortlink-code')));
  const sessionCipher = aesGCMEncryptLayout(recvKey, zero, lz4AllLiteral(responseMessage), {iv:Buffer.alloc(12, 5)});
  const wire = plaintext => join(buildRecord(ctHandshake, serverHello), buildRecord(ctAppData, encryptRecordPayload(keys.key, keys.iv, 2n, ctAppData, plaintext)));
  const good = wire(buildShortlink(CMD_TRANSFER, 0, join(wpkgHead({}, {}), sessionCipher)));
  assert.equal(parseLoginCodeResponse(parse0RTTResponse(good, {psk,hello,type8}, recvKey)), 'shortlink-code');
  const rejected = wire(buildShortlink(CMD_TRANSFER, 0, wpkgHead({4:0,23:BigInt.asUintN(64,-14n),25:0})));
  assert.throws(() => parse0RTTResponse(rejected,{psk,hello,type8},recvKey), error=>error instanceof ShortlinkRejectedError && error.code===-14n);
  const corrupt=Buffer.from(good);corrupt[corrupt.length-1]^=1;assert.throws(()=>parse0RTTResponse(corrupt,{psk,hello,type8},recvKey));
  let calls=0;
  await assert.rejects(send0RTT([{ip:'192.0.2.1',port:80},{ip:'192.0.2.2',port:80}], {preSharedKey:psk.toString('hex'),ticketEntry:'00'},recvKey,b('envelope'),{
    fetcher:async()=>{calls++;return {ok:true,arrayBuffer:async()=>b('broken')};},
  })); assert.equal(calls,1,'已收到未知响应时不能向其他地址重放取码');
});

await test('完整取码编排关闭临时连接，成功返回code且关闭后清除密钥', async () => {
  const identity = deriveWechatDevice(Buffer.alloc(32, 1), 'synthetic-account');
  const ephemeral = generateECDH({privateKey:Buffer.alloc(32, 2)}), cek = Buffer.alloc(32, 3);
  const appRequest = buildManualAuthRequest(buffer, identity.appDeviceId);
  // Derive the response context independently from the fixed client test key.
  const hash1 = sha(b('1'), b('415'), ephemeral.publicKey);
  const prk = createHmac('sha256', b('security hdkf expand')).update(cek).digest();
  const t1 = createHmac('sha256',prk).update(hash1).update(Buffer.from([1])).digest();
  const t2 = createHmac('sha256',prk).update(t1).update(hash1).update(Buffer.from([2])).digest();
  const temp = { privateKey:ephemeral.privateKey,okm:join(t1,t2).subarray(0,56),compressed:lz4AllLiteral(appRequest) };
  let closed=0,sent=0,retained;
  const code = await getWechatLoginCode(buffer, {appId,device:identity,authOptions:{ephemeral,cek},targets:{longlink:[{ip:'fixture',port:443}],shortlink:[{ip:'fixture',port:80}]},
    connect:async()=>({sendApp:async(cmd)=>{assert.equal(cmd,CMD_MANUAL_AUTH);sent++;return 1;},recvApp:async()=>({cmd:CMD_MANUAL_AUTH,seq:1,body:peerResponse(temp,sessionMessage())}),extractPSKs:()=>[{pskType:1,preSharedKey:'08'.repeat(32),ticketEntry:'ff',expiredAt:Math.floor(Date.now()/1000)-1},{pskType:1,preSharedKey:'07'.repeat(32),ticketEntry:'00',expiredAt:Math.floor(Date.now()/1000)+60}],close(){closed++;}}),
    shortlinkSender:async(_targets,ticket,key,envelope)=>{retained={ticket,key};assert.equal(ticket.ticketEntry,'00','跳过列表中已过期的首个access票据');assert(envelope.length>80);assert.deepEqual(key,recvKey);return pbLen(2,pbLen(3,b('full-login-code')));},
  });
  assert.equal(code,'full-login-code');assert.equal(sent,1);assert.equal(closed,1);assert(retained.key.every(value=>value===0));assert.equal(retained.ticket.preSharedKey,'');
});

await test('等待连接时取消不继续授权，迟到连接立即关闭', async () => {
  const abort=new AbortController();let release,closed=0,sends=0;
  const waiting=getWechatLoginCode(buffer,{signal:abort.signal,targets:{longlink:[{ip:'fixture',port:443}],shortlink:[]},connect:()=>new Promise(resolve=>{release=resolve;})});
  await new Promise(resolve=>setImmediate(resolve));abort.abort();await assert.rejects(waiting);
  release({close(){closed++;},sendApp(){sends++;}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,1);assert.equal(sends,0);
});

await test('本地HTTP传输限制响应大小并响应取消，不发送任何真实微信请求', async () => {
  const server=http.createServer((_req,res)=>{res.writeHead(200);res.write(Buffer.alloc(32));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  try{
    await assert.rejects(requestWechatHTTP(url,{maxBytes:16}),/过大/);
    const abort=new AbortController(),pending=requestWechatHTTP(url,{signal:abort.signal});setTimeout(()=>abort.abort(),10);await assert.rejects(pending);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
console.log(`微信小游戏取码专项 ${passed}/${passed} 通过（固定向量、假连接、本地HTTP；零真实账号）`);
