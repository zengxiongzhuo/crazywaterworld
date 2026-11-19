import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const temporary = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(temporary, 'cw-wechat-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_CA_DIR = path.join(directory, 'certificates');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { findHeadlessBrowser } = await import('../src/platform/browser.mjs');
const { GameClient } = await import('../src/client.mjs');
let connections = 0, starts = 0, cancels = 0, state = { phase: 'cancelled', id: null }, qrImage = '';
GameClient.prototype.connect = async () => { connections++; throw Error('界面验收不得连接游戏'); };
const controller = {
  start() { starts++; state = { id: 'fixture-' + starts, phase: 'waiting', qrImage, expiresAt: Date.now() + 300000, error: null }; return Promise.resolve({ ...state }); },
  status(id) { if (id && id !== state.id) throw Error('会话已变化'); return { ...state }; },
  async cancel(id) { this.status(id); cancels++; state = { ...state, phase: 'cancelled', qrImage: null }; },
  takeCredential() { throw Error('界面验收不产生游戏凭据'); },
  async close() { state = { phase: 'cancelled', id: null }; },
};
const app = createConsole({ port: 0, protocol: {}, wechatLoginController: controller });
const output = path.resolve('output/playwright'); fs.mkdirSync(output, { recursive: true });
let browser;
try {
  const url = await app.listen(), executablePath = findHeadlessBrowser();
  if (!executablePath) throw Error('浏览器验收需要已有 Chrome/Edge，不自动下载');
  browser = await chromium.launch({ executablePath, headless: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width > 600 ? 960 : 844 }, isMobile: width < 600, hasTouch: width < 600 });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    qrImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 260;
      const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 260, 260); context.fillStyle = 'black';
      for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) if ((x * 5 + y * 7) % 3) context.fillRect(25 + x * 10, 25 + y * 10, 10, 10);
      context.fillStyle = 'white'; context.fillRect(60, 108, 140, 38); context.fillStyle = 'black'; context.font = '18px sans-serif'; context.fillText('LOCAL TEST', 72, 133);
      return canvas.toDataURL('image/png');
    });
    await page.locator('#tabs [data-tab="account"]').click();
    await page.locator('#account-add').click();
    assert(await page.locator('[data-login-channel="wechat"]').isVisible());
    assert(await page.locator('[data-login-channel="douyin"]').isVisible());
    const before = starts;
    await page.locator('[data-login-channel="wechat-qr"]').click();
    assert.equal(starts, before, '进入渠道不自动请求微信');
    assert(await page.locator('#account-add-capture').isHidden());
    await page.locator('#wechat-start').click();
    await page.waitForFunction(() => document.getElementById('wechat-qr').naturalWidth > 0);
    assert.equal(starts, before + 1);
    assert(await page.locator('#wechat-hint').innerText().then(text => text.includes('应用宝')));
    await page.screenshot({ path: path.join(output, `wechat-native-${width}.png`), fullPage: true });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => el.id || el.tagName).slice(0, 12) }));
    assert(layout.width <= layout.viewport, JSON.stringify(layout));
    const old = cancels;
    await page.locator('#account-add-back').click();
    await page.locator('[data-login-channel="wechat"]').waitFor({ state: 'visible' });
    assert.equal(cancels, old + 1);
    assert(await page.locator('[data-login-channel="wechat"]').isVisible());
    await page.locator('#account-add-close').click();
    assert.deepEqual(errors, []); await context.close();
    console.log(`通过：${width}px 微信扫码独立入口、显示二维码、取消返回及旧采集保留`);
  }
  assert.equal(connections, 0);
  console.log('微信扫码浏览器验收通过（模拟二维码，零微信/游戏连接）');
} finally {
  await browser?.close(); app.server.closeAllConnections(); await app.close();
  assert.equal(path.dirname(directory), temporary); fs.rmSync(directory, { recursive: true, force: true });
}
