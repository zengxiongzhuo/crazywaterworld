// 真实 HTTP/SSE 验证跨账号日志、清空水位和重连；只用隔离账号，禁止连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { formatConsoleLog } from '../src/console-log.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-log-filters-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore } = await import('../src/accounts.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('日志验收禁止连接游戏'); };
saveStore({ version: 1, activeId: 'logs-a', accounts: ['logs-a', 'logs-b'].map(id => ({
  id, label: '日志测试', url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
})) });
const terminal = [];
const app = createConsole({ port: 0, protocol: {}, onLog: entry => terminal.push(formatConsoleLog(entry)) });
const streams = new Set();
let base;
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, '等待超时：' + label);
    await sleep(10);
  }
}
function subscribe(query = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const stream = { events: [], response: null, request: null };
    streams.add(stream);
    stream.request = http.get(base + '/api/events' + query, { headers }, response => {
      stream.response = response;
      assert.equal(response.statusCode, 200);
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const lines = buffer.slice(0, end).split('\n'); buffer = buffer.slice(end + 2);
          const data = lines.find(line => line.startsWith('data: '));
          if (data) stream.events.push({ type: lines.find(line => line.startsWith('event: '))?.slice(7) || 'log', data: JSON.parse(data.slice(6)) });
        }
      });
      resolve(stream);
    });
    stream.request.on('error', reject);
  });
}
const messages = stream => stream.events.filter(event => event.type === 'log').map(event => event.data.message);
const clear = async account => {
  const response = await fetch(base + '/api/logs/clear?account=' + account, { method: 'POST', body: JSON.stringify({ confirm: true }) });
  assert.equal(response.status, 200); return response.json();
};

try {
  base = await app.listen();
  await fetch(base + '/api/accounts');
  const a = app.sessions.get('logs-a'), b = app.sessions.get('logs-b');
  app.emit(a, 'info', '甲账号旧记录'); app.emit(b, 'warn', '乙账号旧记录');
  app.emit(null, 'info', '共享系统旧记录');
  const all = await subscribe('?scope=all'), scoped = await subscribe('?account=logs-a'), system = await subscribe();
  await waitFor(() => messages(all).includes('乙账号旧记录') && messages(scoped).includes('甲账号旧记录') && messages(system).includes('共享系统旧记录'), '历史回放');
  assert(!messages(scoped).includes('乙账号旧记录'));
  assert(!messages(system).includes('甲账号旧记录'));
  assert(all.events.some(event => event.data.account === 'logs-b' && event.data.level === 'warn'));
  assert(all.events.some(event => event.data.accountName === '日志测试（1）'));
  assert(all.events.some(event => event.data.accountName === '日志测试（2）'));
  assert(terminal.some(line => line.includes('[日志测试（2）] [系统与连接] [警告] 乙账号旧记录')));
  console.log('通过：全账号、单账号和系统订阅保持各自范围，历史回放包含账号标识');

  const live = app.emit(b, 'error', '乙账号实时日志 token=private-value');
  app.emit(null, 'info', '实时发送完毕');
  await waitFor(() => [all, scoped, system].every(stream => messages(stream).includes('实时发送完毕')), '实时日志');
  assert(messages(all).some(message => message.includes('乙账号实时日志')));
  assert(!messages(scoped).some(message => message.includes('乙账号实时日志')));
  assert(!messages(system).some(message => message.includes('乙账号实时日志')));
  assert.doesNotMatch(JSON.stringify(all.events), /private-value/);
  assert.equal(live.account, 'logs-b');
  assert.equal(live.accountName, '日志测试（2）');
  console.log('通过：其他账号实时日志到达全账号订阅，敏感字段仍脱敏');

  const renamed = await fetch(base + '/api/accounts/label', { method: 'POST', body: JSON.stringify({ confirm: true, id: 'logs-a', label: '新船长名称' }) });
  assert.equal(renamed.status, 200);
  assert.equal(app.emit(a, 'info', '备注修改后的日志').accountName, '新船长名称');
  assert.equal(app.emit(b, 'info', '同名消除后的日志').accountName, '日志测试');
  const readFileSync = fs.readFileSync;
  try {
    fs.readFileSync = () => { throw new Error('日志输出不应重新读取账号文件'); };
    assert.equal(app.emit(a, 'info', '复用公开名称缓存').accountName, '新船长名称');
  } finally { fs.readFileSync = readFileSync; }
  console.log('通过：账号备注立即更新到业务日志，日志热路径不读取账号凭据文件');

  const cleared = await clear('logs-a');
  assert.equal(cleared.account, 'logs-a');
  await waitFor(() => [all, scoped].every(stream => stream.events.some(event => event.type === 'logs-cleared')), '清空通知');
  assert(!system.events.some(event => event.type === 'logs-cleared'));
  assert.equal(a.log.length, 0);
  assert(b.log.some(entry => entry.message === '乙账号旧记录'));
  const after = app.emit(a, 'info', '甲账号清空后新记录');
  const replay = await subscribe('?scope=all');
  await waitFor(() => messages(replay).includes(after.message), '清空后回放');
  assert(!messages(replay).includes('甲账号旧记录'));
  assert(messages(replay).includes('乙账号旧记录'));
  assert(messages(replay).includes('共享系统旧记录'));
  assert.deepEqual(replay.events[0], { type: 'logs-cleared', data: cleared });
  console.log('通过：清空按账号广播，全账号回放保留其他账号与系统记录');

  await clear('logs-b');
  const next = app.emit(b, 'info', '乙账号清空后新记录');
  const reconnect = await subscribe('?scope=all', { 'Last-Event-ID': String(after.id) });
  await waitFor(() => messages(reconnect).includes(next.message), '重连回放');
  assert.deepEqual(reconnect.events.slice(0, 2).map(event => event.data.account), ['logs-a', 'logs-b']);
  assert.deepEqual(messages(reconnect), ['乙账号清空后新记录']);
  const ids = all.events.filter(event => event.type === 'log').map(event => event.data.id);
  assert.deepEqual(ids, [...ids].sort((left, right) => left - right));
  console.log('通过：重连先同步每个账号的清空水位，再按全局编号回放新增日志');

  for (let index = 0; index < 450; index++) app.emit(index % 2 ? a : b, 'info', '容量测试' + index);
  const bounded = await subscribe('?scope=all');
  await waitFor(() => messages(bounded).includes('容量测试449'), '容量回放');
  assert.equal(messages(bounded).length, 400);
  assert.equal(messages(bounded)[0], '容量测试50');
  assert.equal(connections, 0);
  console.log('通过：全账号历史合并保留最近400条，整个验证未连接游戏');
} finally {
  for (const stream of streams) { stream.request?.destroy(); stream.response?.destroy(); }
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
