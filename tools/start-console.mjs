import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NODE_REQUIREMENT = '^20.19.0 || >=22.12.0';

export function isSupportedNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
}

function checkNode(version) {
  if (!isSupportedNode(version)) {
    throw new Error(`当前 Node.js ${version} 不受支持，需要 ${NODE_REQUIREMENT}。请安装 Node.js 22.12 或更高稳定版本，并重新打开启动窗口。`);
  }
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sameDeclarations = (left = {}, right = {}) => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
};
const supports = (values, current) => !values || (!values.includes('!' + current)
  && (!values.some(value => !value.startsWith('!')) || values.includes(current) || values.includes('any')));

// npm's hidden lock omits the root and optional packages for other platforms.
// Check the files too: the hidden lock can survive an interrupted/manual removal.
export function dependencyStatus(root = ROOT, { platform = process.platform, arch = process.arch,
  libc = platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl') : undefined } = {}) {
  try {
    const manifest = readJson(path.join(root, 'package.json'));
    const wanted = readJson(path.join(root, 'package-lock.json')).packages;
    if (!wanted?.['']) return { ready: false, reason: '项目锁文件缺失或格式不支持' };
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (!sameDeclarations(manifest[field], wanted[''][field])) {
        return { ready: false, reason: 'package.json 与 package-lock.json 的依赖声明不一致' };
      }
    }
    const installed = readJson(path.join(root, 'node_modules', '.package-lock.json')).packages;
    if (!installed) return { ready: false, reason: '依赖安装记录缺失' };
    for (const key of Object.keys(installed)) {
      if (key && !wanted[key]) return { ready: false, reason: '已安装依赖与当前锁文件不一致' };
    }
    const direct = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })
      .map(name => 'node_modules/' + name));
    for (const [key, expected] of Object.entries(wanted)) {
      if (!key) continue;
      if (!key.startsWith('node_modules/') || key.split('/').includes('..')) {
        return { ready: false, reason: '锁文件包含不支持的依赖路径' };
      }
      const actual = installed[key];
      const nativeForPlatform = (expected.os || expected.cpu)
        && supports(expected.os, platform) && supports(expected.cpu, arch) && supports(expected.libc, libc);
      if (expected.optional && !actual && !direct.has(key) && !nativeForPlatform) continue;
      if (!actual || ['version', 'resolved', 'integrity'].some(field => actual[field] !== expected[field])) {
        return { ready: false, reason: `依赖缺失或锁文件已更新：${key}` };
      }
      const directory = path.join(root, key);
      const pkg = readJson(path.join(directory, 'package.json'));
      if (pkg.version !== expected.version) return { ready: false, reason: `依赖版本不匹配：${key}` };
      if (pkg.main) {
        const main = path.join(directory, pkg.main);
        const entries = [main, main + '.js', main + '.json', main + '.node', path.join(main, 'index.js')];
        if (!entries.some(file => { try { return fs.statSync(file).isFile(); } catch { return false; } })) {
          return { ready: false, reason: `依赖入口文件缺失：${key}/${pkg.main}` };
        }
      }
      // esbuild's platform archive does not declare its native executable as bin/main.
      if (nativeForPlatform && key.startsWith('node_modules/@esbuild/')) {
        const binary = path.join(directory, platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild');
        if (!fs.existsSync(binary)) return { ready: false, reason: `原生构建文件缺失：${key}` };
      }
      // Build CLIs need both the package executable and npm's top-level shim.
      const declaredBin = expected.bin || pkg.bin;
      const bin = typeof declaredBin === 'string' ? { [key.split('/').at(-1)]: declaredBin } : declaredBin || {};
      for (const [name, relative] of Object.entries(bin)) {
        if (!fs.existsSync(path.join(directory, relative))) return { ready: false, reason: `依赖命令文件缺失：${key}/${relative}` };
        if (direct.has(key) && !fs.existsSync(path.join(root, 'node_modules', '.bin', name + (platform === 'win32' ? '.cmd' : '')))) {
          return { ready: false, reason: `依赖命令入口缺失：${name}` };
        }
      }
    }
    return { ready: true, reason: '依赖与锁文件一致' };
  } catch (error) {
    return { ready: false, reason: `依赖未安装或文件不完整（${error.code || error.name}）` };
  }
}

export function runNpm(args, { cwd = ROOT, env = process.env, quiet = false } = {}) {
  // Only fixed commands enter cmd.exe; no user arguments or paths are shell text.
  const commands = new Map([
    ['--version', 'npm.cmd --version'],
    ['ci --include=dev', 'npm.cmd ci --include=dev'],
    ['run build:ui', 'npm.cmd run build:ui'],
  ]);
  const command = commands.get(args.join(' '));
  if (!command) throw new Error('不支持的启动准备命令');
  const windows = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(windows ? (env.ComSpec || 'cmd.exe') : 'npm',
      windows ? ['/d', '/s', '/c', command] : args,
      { cwd, env, windowsHide: true, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let detail = '';
    child.stderr?.on('data', chunk => { detail = (detail + chunk).slice(-2000); });
    child.stdout?.resume();
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(' ')} 失败（${signal || code}）${detail.trim() ? '：' + detail.trim() : ''}`));
    });
  });
}

export async function prepareConsole({ root = ROOT, env = process.env, print = console.log,
  nodeVersion = process.versions.node, runNpm: npm = runNpm, build = true } = {}) {
  checkNode(nodeVersion);
  print(`[环境] Node.js ${nodeVersion}，正在检查 npm…`);
  try { await npm(['--version'], { cwd: root, env, quiet: true }); }
  catch (error) { throw new Error(`无法运行 npm，请安装包含 npm 的 Node.js 并重新打开终端。${error.message}`); }
  const status = dependencyStatus(root);
  if (!status.ready) {
    print(`[依赖] ${status.reason}，正在安装（npm ci --include=dev）…`);
    await npm(['ci', '--include=dev'], { cwd: root, env });
    const installed = dependencyStatus(root);
    if (!installed.ready) throw new Error(`依赖安装后检查未通过：${installed.reason}。请确认依赖和锁文件完整，且未禁用当前平台的可选依赖。`);
  } else {
    print('[依赖] 已安装且与锁文件一致，跳过安装。');
  }
  if (build) {
    print('[构建] 正在构建控制台界面…');
    await npm(['run', 'build:ui'], { cwd: root, env });
  }
}

export async function startConsole(args = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const print = dependencies.print ?? console.log;
  const root = dependencies.root ?? ROOT;
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  checkNode(nodeVersion);
  const command = String(args[0] ?? '').toLowerCase();
  if (!['', 'start', 'console', 'url', 'address', 'status', 'check', 'recover'].includes(command)) {
    throw new Error('未知启动命令。可直接启动，或使用 url、status、recover。');
  }
  env.CW_PORT ||= '17323';
  const maintenance = ['status', 'check', 'recover'].includes(command);
  // Address helpers only use Node built-ins and work before dependency setup.
  // Recovery must remain available even when the listening settings are invalid.
  let address;
  if (!maintenance) {
    const { consoleHost, consoleUrl } = await import('../src/console-address.mjs');
    address = consoleUrl(consoleHost(env), env.CW_PORT) + '/';
  }
  if (command === 'url' || command === 'address') {
    print(address);
    const hold = dependencies.hold ?? (() => new Promise(() => { setInterval(() => {}, 60_000); }));
    await hold();
    return;
  }
  await (dependencies.prepare ?? prepareConsole)({ root, env, print, nodeVersion,
    runNpm: dependencies.runNpm ?? runNpm, build: !maintenance });
  if (command === 'status' || command === 'check') {
    const certificateCommand = dependencies.certificateCommand ?? (await import('../src/platform/certificates.mjs')).certificateCommand;
    const inspectCaptureRecovery = dependencies.inspectCaptureRecovery ?? (await import('../src/capture.mjs')).inspectCaptureRecovery;
    await certificateCommand(['status']);
    const recovery = inspectCaptureRecovery();
    if (recovery.pending) print(recovery.error || recovery.message);
    return;
  }
  if (command === 'recover') {
    const recoverCapture = dependencies.recoverCapture ?? (await import('../src/capture.mjs')).recoverCapture;
    const result = await recoverCapture();
    print(result.pending ? result.error || result.message : '采集改动已清理。');
    return;
  }
  env.CW_NO_BROWSER = '1';
  env.CW_QUIET_START = '1';
  print(`[启动] ${address}（请保持此窗口打开）`);
  const launch = dependencies.launch ?? (async () => {
    process.chdir(root);
    process.argv = [process.argv[0], path.join(root, 'src', 'app.mjs'), 'console'];
    await import(pathToFileURL(path.join(root, 'src', 'app.mjs')).href);
  });
  await launch();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startConsole().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
