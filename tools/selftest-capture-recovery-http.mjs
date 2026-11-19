import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-recovery-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { createConsole } = await import('./fixtures/console-server.mjs');
const events = [];
let pending = true, recoveries = 0, fail = false, running = false, platform = null;
const starts = [], stops = [];
const inspect = () => ({ pending, recoverable: pending, message: pending ? '检测到上次采集残留' : '' });
const captureController = {
  captureState: () => ({ running, phase: running ? 'waiting' : 'idle', platform, recovery: inspect() }),
  inspectCaptureRecovery: inspect,
  startCapture: async options => {
    starts.push(options);
    platform = options.platform;
    running = true;
  },
  stopCapture: async reason => {
    stops.push(reason);
    running = false;
  },
  recoverCapture: async () => {
    if (fail) throw new Error('模拟恢复失败，保留记录');
    recoveries++;
    pending = false;
  },
};
const app = createConsole({ port: 0, protocol: {}, captureController, onLog: entry => events.push(entry) });
try {
  const root = await app.listen();
  assert(events.some(entry => entry.level === 'warn' && /上次采集残留/.test(entry.message)));
  const state = await (await fetch(root + '/api/capture')).json();
  assert.equal(state.recovery.pending, true);
  const page = await (await fetch(root)).text();
  assert.match(page, /id="cap-recover"/);
  const recover = body => fetch(root + '/api/capture/recover', { method: 'POST', body: JSON.stringify(body) });
  const unconfirmed = await recover({});
  assert.equal(unconfirmed.status, 400);
  assert.equal(recoveries, 0);
  fail = true;
  const rejected = await recover({ confirm: true });
  assert.equal(rejected.status, 400);
  assert.equal(pending, true);
  fail = false;
  const restored = await recover({ confirm: true });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).recovery.pending, false);
  assert.equal(recoveries, 1);
  assert(events.some(entry => /残留已核对并恢复/.test(entry.message)));

  // Removed browser QR endpoints must not fall through into PC capture.
  const removed = [
    ['POST', '/start'], ['GET', '/status?id=retired-scan'], ['POST', '/cancel'],
    ['POST', '/roles'], ['POST', '/save'], ['GET', '/verification/frame?id=retired-scan'],
    ['POST', '/verification/action'], ['POST', '/verification/input'],
  ];
  for (const [method, suffix] of removed) {
    const response = await fetch(root + '/api/accounts/douyin-login' + suffix, {
      method,
      ...(method === 'POST' ? { body: JSON.stringify({ confirm: true, id: 'retired-scan',
        frameId: 'retired-frame', type: 'down', seq: 0, x: 1, y: 1, points: [{ x: 1, y: 1, t: 0 }] }) } : {}),
    });
    assert.equal(response.status, 404, `${method} ${suffix} should be removed`);
    assert.equal((await response.json()).error, 'not found');
  }
  assert.equal(starts.length, 0, '废弃扫码接口不能启动抓包');
  assert.equal(stops.length, 0, '废弃扫码接口不能停止抓包');
  assert.equal(recoveries, 1, '废弃扫码接口不能触发恢复');
  assert.equal(fs.existsSync(path.join(directory, 'accounts.json')), false, '废弃扫码接口不能保存账号');

  const postCapture = (suffix, body) => fetch(root + '/api/capture/' + suffix, {
    method: 'POST', body: JSON.stringify(body),
  });
  assert.equal((await postCapture('start', { platform: 'douyin' })).status, 400);
  assert.equal((await postCapture('start', { confirm: true, platform: 'douyin-qr' })).status, 400);
  assert.equal(starts.length, 0, '未确认或未知渠道不调用抓包控制器');
  const captured = await postCapture('start', { confirm: true, platform: 'douyin' });
  assert.equal(captured.status, 200);
  const captureState = await captured.json();
  assert.equal(captureState.running, true);
  assert.equal(captureState.platform, 'douyin');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].platform, 'douyin');
  assert.equal(typeof starts[0].onLogin, 'function');
  assert.equal(typeof starts[0].onLog, 'function');
  assert(Number.isInteger(starts[0].port) && starts[0].port > 0 && starts[0].port <= 65535);
  assert.equal((await postCapture('start', { confirm: true, platform: 'douyin' })).status, 400);
  assert.equal(starts.length, 1, '运行中的采集不能重复启动');
  assert.equal((await postCapture('stop', {})).status, 400);
  assert.equal(stops.length, 0);
  const stopped = await postCapture('stop', { confirm: true });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).running, false);
  assert.equal(stops.length, 1);
  console.log('抓包恢复 HTTP 自检通过，覆盖恢复流程、废弃抖音扫码接口 404 与电脑抖音采集分发（无真实系统操作）');
} finally {
  await app.close();
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
