// All registry and trust changes below use files in one temporary directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createCaptureController } from '../src/capture.mjs';
import { createCaptureJournal, createCaptureRecovery } from '../src/capture-recovery.mjs';
import { startConsole } from './start-console.mjs';
import { main as captureDouyin } from './capture-douyin-login.mjs';
import { wechatPackageCandidates, wechatConfigCandidates, wechatUsersDirectory } from '../src/platform/client-paths.mjs';

const ORIGINAL = { ProxyEnable: '0x1', ProxyServer: 'original:7890', ProxyOverride: '*.example' };
const THUMBPRINT = 'a'.repeat(40);

function fixture(directory) {
  const systemFile = path.join(directory, 'system.json');
  if (!fs.existsSync(systemFile)) fs.writeFileSync(systemFile, JSON.stringify({ proxy: ORIGINAL, trusted: [], certificate: false }));
  const read = () => JSON.parse(fs.readFileSync(systemFile, 'utf8'));
  const change = callback => { const state = read(); callback(state); fs.writeFileSync(systemFile, JSON.stringify(state)); };
  const journal = createCaptureJournal(path.join(directory, 'capture-session.json'));
  const ca = {
    CA_CN: 'Fixture', CA_CRT: path.join(directory, 'fixture.crt'),
    caFingerprint: () => read().certificate ? 'fixture-fingerprint' : null,
    caThumbprint: () => THUMBPRINT,
    isInstalled: (thumbprint = THUMBPRINT) => read().trusted.includes(thumbprint),
    initCa() { const created = !read().certificate; change(state => { state.certificate = true; }); return { created }; },
    prepareLeaf() {},
    installCa() { change(state => { state.trusted.push(THUMBPRINT); }); },
    uninstallCa(thumbprint = THUMBPRINT) { change(state => { state.trusted = state.trusted.filter(value => value !== thumbprint); }); },
    removeCaFiles() { change(state => { state.certificate = false; }); },
  };
  const proxySettings = {
    readCurrent: () => read().proxy,
    backup(values) { change(state => { state.backup = structuredClone(values); }); },
    readBackup() { const state = read(); return state.backup ? { values: state.backup, savedAt: 'fixture' } : null; },
    removeBackup() { change(state => { delete state.backup; }); },
    setProxy(host, port) { change(state => { state.proxy = { ProxyEnable: '0x1', ProxyServer: `${host}:${port}`, ProxyOverride: '<local>' }; }); },
    restore(values, names) {
      change(state => { for (const name of names) { if (name in values) state.proxy[name] = values[name]; else delete state.proxy[name]; } });
    },
  };
  const dependencies = { journal, ca, proxySettings, acquireLock: async () => async () => {},
    createProxy: () => ({ async listen() {}, async stop() {} }) };
  return { read, change, journal, dependencies, recovery: createCaptureRecovery(dependencies) };
}

async function killCaptureChild(mode, directory) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, directory], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture child timeout\n' + stderr)); }, 10_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { if (!output.includes('ready')) { clearTimeout(timer); reject(new Error('fixture exited ' + code + '\n' + stderr)); } });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready')) { clearTimeout(timer); resolve(); } });
  });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

if (process.argv[2] === '--douyin-child') {
  const f = fixture(process.argv[3]);
  await captureDouyin(['--yes', '--host', 'fixture.example'], { ...f.dependencies,
    process: { platform: 'win32', env: process.env, stdin: process.stdin, stdout: process.stdout,
      on: process.on.bind(process), removeListener: process.removeListener.bind(process) },
    io: { log(message) { if (message.startsWith('采集已就绪')) process.stdout.write('ready\n'); }, error: console.error } });
} else if (process.argv[2] === '--child') {
  const f = fixture(process.argv[3]);
  const controller = createCaptureController(f.dependencies);
  const state = await controller.startCapture({ port: 17322 });
  assert.equal(state.phase, 'waiting', state.error);
  process.stdout.write('ready\n');
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-platform-recovery-'));
  try {
    const f = fixture(directory);
    for (const mode of ['--child', '--douyin-child']) {
      await killCaptureChild(mode, directory);
      assert.equal(f.recovery.inspect().pending, true);
      assert.equal(f.read().proxy.ProxyServer, '127.0.0.1:17322');
      assert(f.read().trusted.includes(THUMBPRINT));
      await f.recovery.recover();
      assert.deepEqual(f.read().proxy, ORIGINAL);
      assert.deepEqual(f.read().trusted, []);
      assert.equal(f.read().certificate, false);
      assert.equal(f.journal.read(), null);
      await f.recovery.recover();
    }

    // Persistence failure before trust changes leaves both system settings intact.
    const failingJournal = { ...f.journal, write(record) {
      if (record.ca.installAttempted) throw new Error('fixture disk full');
      f.journal.write(record);
    } };
    const failedStart = createCaptureController({ ...f.dependencies, journal: failingJournal });
    assert.equal((await failedStart.startCapture({ port: 17322 })).running, false);
    assert.deepEqual(f.read().trusted, []);
    assert.deepEqual(f.read().proxy, ORIGINAL);
    assert.equal(f.journal.read(), null);

    // Recovery preserves proxy settings changed after the crashed capture.
    const record = { version: 1, id: 'retry', port: 17322, phase: 'proxy', ready: true,
      ca: { installedBefore: true, installAttempted: false },
      proxy: { original: ORIGINAL, target: { ProxyEnable: '0x1', ProxyServer: '127.0.0.1:17322', ProxyOverride: '<local>' },
        ready: true, owned: true, pending: ['ProxyEnable', 'ProxyServer', 'ProxyOverride'] } };
    f.journal.write(record);
    const chosen = { ProxyEnable: '0x1', ProxyServer: 'user-choice:9000', ProxyOverride: 'user-choice' };
    f.change(state => { state.proxy = chosen; state.trusted = [THUMBPRINT]; });
    await f.recovery.recover();
    assert.deepEqual(f.read().proxy, chosen);
    assert.deepEqual(f.read().trusted, [THUMBPRINT]);

    // A failed rollback retains its progress, then a fresh recovery can retry.
    f.journal.write(record);
    f.change(state => { state.proxy = record.proxy.target; });
    const fail = createCaptureRecovery({ ...f.dependencies, proxySettings: { ...f.dependencies.proxySettings, restore() { throw new Error('fixture registry busy'); } } });
    await assert.rejects(fail.recover(), /registry busy/);
    assert.equal(f.journal.read().proxy.pending.length, 3);
    await f.recovery.recover();
    assert.deepEqual(f.read().proxy, ORIGINAL);

    // A lock held by a live capture prevents recovery in another controller.
    f.journal.write(record);
    const busy = createCaptureRecovery({ ...f.dependencies, acquireLock: async () => { throw new Error('fixture capture busy'); } });
    await assert.rejects(busy.recover(), /capture busy/);
    assert(f.journal.read());
    f.journal.clear();

    // Legacy backups restore only matching proxy values and preserve certificates.
    f.change(state => { state.backup = ORIGINAL; state.proxy = record.proxy.target; });
    assert.equal(f.recovery.inspect().legacy, true);
    await f.recovery.recover();
    assert.deepEqual(f.read().proxy, ORIGINAL);
    assert.deepEqual(f.read().trusted, [THUMBPRINT]);

    // The captured thumbprint remains usable if certificate files changed or disappeared.
    f.journal.write({ ...record, proxy: null, ca: { installedBefore: false, installAttempted: true,
      thumbprint: THUMBPRINT, fingerprint: 'old-fingerprint', created: true } });
    f.change(state => { state.certificate = true; state.trusted = [THUMBPRINT, 'b'.repeat(40)]; });
    await f.recovery.recover();
    assert.deepEqual(f.read().trusted, ['b'.repeat(40)]);
    assert.equal(f.read().certificate, true);

    f.journal.write({ version: 999 });
    assert.equal(f.recovery.inspect().recoverable, false);
    await assert.rejects(f.recovery.recover(), /格式异常/);
    assert.deepEqual(f.journal.read(), { version: 999 });
    f.journal.clear();

    const env = {}, printed = [];
    let launched = 0, held = 0, checked = 0;
    const launcher = { env, print: value => printed.push(value), prepare: async () => {}, hold: async () => { held++; }, launch: async () => { launched++; },
      certificateCommand: async args => { assert.deepEqual(args, ['status']); checked++; }, inspectCaptureRecovery: () => ({ pending: false }) };
    await startConsole(['url'], launcher);
    assert.equal(printed[0], 'http://127.0.0.1:17323/');
    assert.equal(held, 1);
    env.CW_PORT = '18000';
    await startConsole(['address'], launcher);
    assert.equal(printed[1], 'http://127.0.0.1:18000/');
    await startConsole(['status'], launcher);
    await startConsole(['check'], launcher);
    assert.equal(checked, 2);
    await startConsole([], launcher);
    assert.equal(launched, 1);
    assert.equal(env.CW_NO_BROWSER, '1');
    assert.equal(env.CW_QUIET_START, '1');

    const options = { env: { APPDATA: path.join(directory, 'custom-appdata') }, home: path.join(directory, 'home') };
    const users = wechatUsersDirectory(options);
    const appId = 'fixture-app';
    const packageFiles = [2, 9].map(version => path.join(users, 'user', 'applet', 'packages', appId, String(version), '_src_chunks_.wxapkg'));
    const config = path.join(users, 'user', 'applet', 'local', appId, 'usr', 'gamecaches', 'config_cn', 'latest.json');
    for (const file of [...packageFiles, config]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}'); }
    assert.deepEqual(wechatPackageCandidates(appId, options), [...packageFiles].reverse());
    assert.deepEqual(wechatConfigCandidates(appId, options), [config]);
    assert(wechatUsersDirectory({ env: {}, home: options.home }).startsWith(options.home));
    console.log('平台与采集恢复测试通过，覆盖强杀后重启、原值核对、既存证书、恢复失败重试、采集锁、旧备份、启动参数及缓存发现。');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
