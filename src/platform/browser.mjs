import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

// Edge、Chrome 通常不在 PATH 里，按安装位置找；找不到就交给系统默认浏览器。
export function findAppBrowser(env = process.env) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const apps = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']];
  for (const app of apps) {
    for (const root of roots) {
      const file = path.join(root, ...app);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

// Alipay QR capture runs a headless browser on the server, where Windows
// installation paths and a desktop default browser are often unavailable.
export function findHeadlessBrowser(env = process.env, platform = process.platform) {
  const configured = env.CW_BROWSER_EXECUTABLE || env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured && fs.existsSync(configured)) return configured;

  const candidates = platform === 'win32'
    ? [
      ...['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].filter(key => env[key])
        .flatMap(key => [
          path.join(env[key], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(env[key], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]),
    ]
    : platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;

  const names = platform === 'win32'
    ? ['msedge.exe', 'chrome.exe']
    : platform === 'darwin'
      ? ['Google Chrome', 'Microsoft Edge', 'Chromium']
      : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge'];
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let chromiumInstall = null;

// Playwright Core intentionally ships without browser binaries. Download the
// matching Chromium on first use and keep it in the app's persistent data dir.
export async function ensureHeadlessBrowser(env = process.env, platform = process.platform) {
  const installed = findHeadlessBrowser(env, platform);
  if (installed) return installed;

  if (env !== process.env) throw new Error('未找到可用浏览器。');
  if (!env.PLAYWRIGHT_BROWSERS_PATH) {
    const dataDir = env.CW_DATA_DIR ? path.resolve(env.CW_DATA_DIR) : path.resolve(import.meta.dirname, '../../data');
    env.PLAYWRIGHT_BROWSERS_PATH = path.join(dataDir, 'playwright-browsers');
  }
  if (env.PLAYWRIGHT_BROWSERS_PATH !== '0') fs.mkdirSync(env.PLAYWRIGHT_BROWSERS_PATH, { recursive: true });

  const { chromium } = await import('playwright-core');
  const executablePath = chromium.executablePath();
  if (fs.existsSync(executablePath)) return executablePath;

  if (!chromiumInstall) {
    chromiumInstall = (async () => {
      const require = createRequire(import.meta.url);
      const cli = path.join(path.dirname(require.resolve('playwright-core')), 'cli.js');
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
          env: process.env, stdio: 'ignore', windowsHide: true,
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('下载 Chromium 超时'));
        }, 10 * 60_000);
        child.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', code => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error('Playwright 浏览器下载程序退出，代码 ' + code));
        });
      });
    })().finally(() => { chromiumInstall = null; });
  }
  try {
    await chromiumInstall;
  } catch {
    throw new Error('自动下载 Chromium 失败，请检查服务器到 Playwright 浏览器下载源的网络、磁盘空间和写入权限后重试。');
  }
  if (!fs.existsSync(executablePath)) {
    throw new Error('Chromium 下载完成但没有找到浏览器文件，请检查服务器下载权限后重试。');
  }
  return executablePath;
}

export function openBrowser(url) {
  const launch = (command, args, onFail) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', onFail);
    child.unref();
  };
  if (process.platform === 'darwin') {
    launch('open', [url], () => {});
    return 'open';
  }
  const systemDefault = () => launch('cmd', ['/c', 'start', '', url], () => {});
  const app = findAppBrowser();
  if (app) {
    launch(app, ['--app=' + url], systemDefault);
    return path.basename(app, '.exe');
  }
  systemDefault();
  return 'cmd';
}
