// Launcher fixtures never install packages, connect to a game, or change system settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isSupportedNode, dependencyStatus, prepareConsole, startConsole } from './start-console.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const temporary = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporary, 'cw-start-console-'));
const nodeVersion = '22.12.0';
let passed = 0, fixtureIndex = 0;
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };

function fixture() {
  const root = path.join(directory, `项目 with spaces & symbols ${fixtureIndex++}`);
  const manifest = {
    name: 'launcher-fixture', version: '1.0.0',
    engines: { node: '^20.19.0 || >=22.12.0' },
    dependencies: { 'fixture-runtime': '^1.0.0' },
    devDependencies: { 'fixture-builder': '^1.0.0' },
    scripts: { 'build:ui': 'fixture-build' },
  };
  const packages = {
    '': manifest,
    'node_modules/fixture-runtime': {
      version: '1.0.0', resolved: 'https://fixture.invalid/runtime.tgz', integrity: 'sha512-runtime',
      dependencies: { 'fixture-leaf': '^1.0.0' },
    },
    'node_modules/fixture-leaf': {
      version: '1.0.0', resolved: 'https://fixture.invalid/leaf.tgz', integrity: 'sha512-leaf',
    },
    'node_modules/fixture-builder': {
      version: '1.0.0', resolved: 'https://fixture.invalid/builder.tgz', integrity: 'sha512-builder',
      dev: true, bin: { 'fixture-build': 'bin/build.js' },
    },
  };
  write(path.join(root, 'package.json'), manifest);
  write(path.join(root, 'package-lock.json'), { name: manifest.name, lockfileVersion: 3, packages });
  const install = ({ productionOnly = false } = {}) => {
    const lock = read(path.join(root, 'package-lock.json'));
    const installed = {};
    for (const [relative, entry] of Object.entries(lock.packages)) {
      if (!relative || (productionOnly && entry.dev)) continue;
      if (entry.os && !entry.os.includes(process.platform)) continue;
      installed[relative] = entry;
      write(path.join(root, relative, 'package.json'), { name: path.basename(relative), ...entry });
      for (const [name, file] of Object.entries(entry.bin ?? {})) {
        write(path.join(root, relative, file), '// fixture executable\n');
        write(path.join(root, 'node_modules/.bin', name + (process.platform === 'win32' ? '.cmd' : '')), 'fixture');
      }
    }
    write(path.join(root, 'node_modules/.package-lock.json'), { lockfileVersion: 3, packages: installed });
  };
  return { root, manifest, packages, install };
}

const prepareOptions = f => ({ root: f.root, nodeVersion, env: {}, print() {} });
const noLaunch = () => { throw new Error('不得启动真实服务'); };

try {
  await test('Node.js 支持范围保留 20.x 兼容边界并拒绝过旧或预发布版本', () => {
    for (const version of ['20.19.0', '20.20.1', '22.12.0', '22.17.0', '23.0.0', '24.0.0']) {
      assert.equal(isSupportedNode(version), true, version);
    }
    for (const version of ['18.20.0', '20.18.3', '21.7.0', '22.11.1', '22.12.0-rc.1', 'invalid', '']) {
      assert.equal(isSupportedNode(version), false, version);
    }
  });

  await test('首次安装和仅生产依赖都需要补齐开发依赖', () => {
    const f = fixture();
    assert.equal(dependencyStatus(f.root).ready, false);
    f.install({ productionOnly: true });
    assert.equal(dependencyStatus(f.root).ready, false);
    f.install();
    assert.equal(dependencyStatus(f.root).ready, true);
  });

  await test('传递依赖版本、来源或完整性变化也会使安装过期', () => {
    for (const [field, value] of [['version', '1.0.1'], ['resolved', 'https://fixture.invalid/new-leaf.tgz'], ['integrity', 'sha512-new-leaf']]) {
      const f = fixture(); f.install();
      const file = path.join(f.root, 'package-lock.json'), lock = read(file);
      lock.packages['node_modules/fixture-leaf'][field] = value; write(file, lock);
      assert.equal(dependencyStatus(f.root).ready, false, field);
    }
  });

  await test('依赖清单变化、实际包损坏和构建入口缺失不会被隐藏锁文件掩盖', () => {
    for (const mutate of [
      f => { const file = path.join(f.root, 'package.json'), value = read(file); value.devDependencies['fixture-builder'] = '^2.0.0'; write(file, value); },
      f => write(path.join(f.root, 'node_modules/fixture-runtime/package.json'), { version: '0.9.0' }),
      f => write(path.join(f.root, 'node_modules/fixture-leaf/package.json'), 'invalid JSON'),
      f => fs.rmSync(path.join(f.root, 'node_modules/fixture-builder/bin/build.js')),
      f => fs.rmSync(path.join(f.root, 'node_modules/.bin/fixture-build' + (process.platform === 'win32' ? '.cmd' : ''))),
    ]) {
      const f = fixture(); f.install(); mutate(f);
      assert.equal(dependencyStatus(f.root).ready, false);
    }
  });

  await test('其他平台的可选原生包缺失不会触发每次重装', () => {
    const f = fixture(), file = path.join(f.root, 'package-lock.json'), lock = read(file);
    lock.packages['node_modules/fixture-other-platform'] = {
      version: '1.0.0', optional: true, os: [process.platform === 'win32' ? 'darwin' : 'win32'], cpu: [process.arch],
      resolved: 'https://fixture.invalid/optional.tgz', integrity: 'sha512-optional',
    };
    write(file, lock); f.install();
    assert.equal(dependencyStatus(f.root).ready, true);
  });

  await test('首次运行依次检查 npm、安装、复验、构建，路径与环境作为独立参数传递', async () => {
    const f = fixture(), calls = [], env = { NODE_ENV: 'production', CW_PORT: '18001' };
    await prepareConsole({ ...prepareOptions(f), env, runNpm: async (args, options) => {
      calls.push(args);
      assert.equal(options.cwd, f.root);
      assert.equal(options.env.CW_PORT, '18001');
      if (args[0] === 'ci') { assert(args.includes('--include=dev')); f.install(); }
      if (args[0] === 'run') assert.equal(dependencyStatus(f.root).ready, true);
    } });
    assert.deepEqual(calls, [['--version'], ['ci', '--include=dev'], ['run', 'build:ui']]);
  });

  await test('健康依赖跳过安装但每次启动仍构建最新页面', async () => {
    const f = fixture(), calls = []; f.install();
    await prepareConsole({ ...prepareOptions(f), runNpm: async args => { calls.push(args); } });
    assert.deepEqual(calls, [['--version'], ['run', 'build:ui']]);
  });

  await test('过旧 Node.js 在 npm 调用前停止', async () => {
    const f = fixture(); let calls = 0;
    await assert.rejects(prepareConsole({ ...prepareOptions(f), nodeVersion: '20.18.0', runNpm: async () => { calls++; } }), /Node/i);
    assert.equal(calls, 0);
  });

  await test('npm 缺失、安装失败、安装未完成或构建失败均不会继续启动', async () => {
    for (const failure of ['npm', 'install', 'incomplete', 'build']) {
      const f = fixture(), calls = []; let launches = 0;
      if (failure === 'build') f.install();
      await assert.rejects(startConsole([], {
        ...prepareOptions(f), launch: async () => { launches++; },
        runNpm: async args => {
          calls.push(args[0]);
          if (failure === 'npm' || (failure === 'install' && args[0] === 'ci') || (failure === 'build' && args[0] === 'run')) {
            throw new Error('fixture ' + failure + ' failure');
          }
        },
      }));
      assert.equal(launches, 0, failure);
      assert.deepEqual(calls, failure === 'npm' ? ['--version'] : failure === 'build' ? ['--version', 'run'] : ['--version', 'ci']);
    }
  });

  await test('全新目录可导入启动工具，地址模式不需要 npm、依赖或应用模块', async () => {
    const f = fixture();
    for (const relative of ['tools/start-console.mjs', 'src/console-address.mjs']) {
      const target = path.join(f.root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(repository, relative), target);
    }
    const { startConsole: freshStart } = await import(pathToFileURL(path.join(f.root, 'tools/start-console.mjs')));
    const printed = []; let held = 0;
    const dependencies = { env: {}, print: value => printed.push(value), hold: async () => { held++; },
      prepare: noLaunch, runNpm: noLaunch, launch: noLaunch };
    await freshStart(['url'], dependencies);
    dependencies.env.CW_HOST = '::'; dependencies.env.CW_PORT = '18000';
    await freshStart(['address'], dependencies);
    assert.deepEqual(printed, ['http://127.0.0.1:17323/', 'http://[::1]:18000/']);
    assert.equal(held, 2);
    assert.equal(fs.existsSync(path.join(f.root, 'node_modules')), false);
  });

  await test('维护命令不依赖监听地址配置，不构建服务且保留检查和恢复回调', async () => {
    const calls = [], printed = [];
    const dependencies = { env: { CW_HOST: 'http://invalid', CW_PORT: 'invalid' }, print: value => printed.push(value),
      prepare: async options => { calls.push(['prepare', options.build]); }, launch: noLaunch,
      certificateCommand: async args => { calls.push(['certificate', ...args]); },
      inspectCaptureRecovery: () => ({ pending: true, message: 'fixture recovery pending' }),
      recoverCapture: async () => { calls.push(['recover']); return { pending: false }; },
    };
    await startConsole(['status'], dependencies);
    await startConsole(['check'], dependencies);
    await startConsole(['recover'], dependencies);
    assert.deepEqual(calls, [['prepare', false], ['certificate', 'status'], ['prepare', false], ['certificate', 'status'], ['prepare', false], ['recover']]);
    assert.equal(printed.filter(value => value === 'fixture recovery pending').length, 2);
    assert.match(printed.at(-1), /清理/);
  });

  await test('正常启动在准备完成后执行一次，并保留已有地址和浏览器策略', async () => {
    const calls = [], env = { CW_HOST: 'localhost', CW_PORT: '18000' };
    await startConsole([], { env, print() {}, prepare: async options => { calls.push(['prepare', options.build]); },
      launch: async () => { calls.push(['launch']); } });
    assert.deepEqual(calls, [['prepare', true], ['launch']]);
    assert.deepEqual(env, { CW_HOST: 'localhost', CW_PORT: '18000', CW_NO_BROWSER: '1', CW_QUIET_START: '1' });
  });

  if (process.platform === 'win32') {
    await test('Windows 包装器支持特殊目录、维护参数及失败退出码', () => {
      const root = path.join(directory, 'Windows 空格 & ! (launcher)'), wrapper = path.join(root, 'start-console.cmd');
      fs.mkdirSync(root, { recursive: true }); fs.copyFileSync(path.join(repository, 'start-console.cmd'), wrapper);
      write(path.join(root, 'tools/start-console.mjs'), [
        'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));',
        'process.exit(Number(process.env.CW_FIXTURE_EXIT || 0));',
      ].join('\n'));
      const environment = { ...process.env, CW_NO_PAUSE: '1', CW_TEST_WRAPPER: wrapper };
      const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'PATH';
      environment[pathKey] = path.dirname(process.execPath) + path.delimiter + environment[pathKey];
      const run = env => spawnSync(process.env.ComSpec || 'cmd.exe',
        ['/d', '/v:off', '/s', '/c', 'call "%CW_TEST_WRAPPER%" recover "argument with spaces"'], {
          cwd: directory, env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000,
        });
      for (const code of [0, 17]) {
        const result = run({ ...environment, CW_FIXTURE_EXIT: String(code) });
        assert.ifError(result.error);
        assert.equal(result.status, code, result.stdout + result.stderr);
        const record = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('{')));
        assert.equal(record.cwd, root);
        assert.deepEqual(record.args, ['recover', 'argument with spaces']);
        if (code) assert.match(result.stdout, /启动未完成/);
      }
      // Invoke by filename so the parent shell cannot consume the path's "!"
      // before the wrapper has a chance to disable delayed expansion itself.
      const delayed = spawnSync(process.env.ComSpec || 'cmd.exe',
        ['/d', '/v:on', '/s', '/c', 'call start-console.cmd recover "argument with spaces"'], {
          cwd: root, env: environment, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000,
        });
      assert.ifError(delayed.error);
      assert.equal(delayed.status, 0, delayed.stdout + delayed.stderr);
      assert.deepEqual(JSON.parse(delayed.stdout.split(/\r?\n/).find(line => line.startsWith('{'))), {
        cwd: root, args: ['recover', 'argument with spaces'],
      });
      const missing = run({ ...environment, [pathKey]: path.join(process.env.SystemRoot, 'System32') });
      assert.ifError(missing.error);
      assert.equal(missing.status, 1, missing.stdout + missing.stderr);
      assert.match(missing.stdout, /未找到 Node\.js/);
      assert(!missing.stdout.includes('"cwd"'));
    });
  }

  console.log(`一键启动专项 ${passed}/${passed} 通过（临时依赖、模拟 npm、零游戏连接）`);
} finally {
  assert.equal(path.dirname(directory), temporary);
  fs.rmSync(directory, { recursive: true, force: true });
}
