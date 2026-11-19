// Real downloads and file uploads against an isolated local console.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-account-backup-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { accountFromCredential, saveStore, loadStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('浏览器验收禁止连接游戏'); };
const account = accountFromCredential({ url: 'wss://fixture.invalid', source: 'mitm', login: {
  eworldParams: { openId: 'browser-fixture', token: 'fake-backup-token' },
} }, { label: '备份验收船长' });
account.automation = { autoStart: false, enabled: false };
const extraAccounts = ['second', 'third'].map((id, index) => ({ ...accountFromCredential({
  url: 'wss://fixture.invalid', source: 'mitm', login: { eworldParams: { openId: id, token: 'fake-' + id } },
}, { label: index === 0 ? '第二个勾选账号' : '不应导出的第三个账号' }), automation: { autoStart: false, enabled: false } }));
saveStore({ version: 1, activeId: account.id, accounts: [account, ...extraAccounts] });
const settings = defaultSettings(); settings.loop.everySeconds = 47;
saveAutomationSettings(account.id, settings, { revision: 0 });
const output = path.resolve('output/playwright'); fs.mkdirSync(output, { recursive: true });
const app = createConsole({ port: 0, protocol: {} });
let browser;
const pageErrors = [];
try {
  const root = await app.listen();
  const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(file => fs.existsSync(file));
  assert.ok(executablePath, '未找到浏览器，可用 CW_BROWSER_TEST_EXECUTABLE 指定');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(root);
  await page.locator('#account-picker-title').filter({ hasText: '备份验收船长' }).waitFor();
  await page.locator('#tabs [data-tab="account"]').click();
  assert.equal(await page.locator('.account-backup-menu').count(), 0);
  await page.locator('#export-accounts').click();
  assert.equal(await page.locator('#account-export-only').isDisabled(), true);
  assert.equal(await page.locator('#account-export-settings').isDisabled(), true);
  await page.locator('#account-export-all').check();
  assert.equal(await page.locator('#account-export-list input:checked').count(), 3);
  await page.locator('#account-export-all').uncheck();
  assert.equal(await page.locator('#account-export-list input:checked').count(), 0);
  await page.locator('#account-export-list input').nth(0).check();
  await page.locator('#account-export-list input').nth(1).check();
  assert.equal(await page.locator('#account-export-all').evaluate(input => input.indeterminate), true);
  await page.screenshot({ path: path.join(output, 'account-export-desktop.png'), animations: 'disabled' });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#account-export-settings').click()]);
  const backupPath = path.join(directory, download.suggestedFilename()); await download.saveAs(backupPath);
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(backup.includeSettings, true);
  assert.deepEqual(backup.accounts.map(row => row.id), [account.id, extraAccounts[0].id]);
  assert.equal(backup.accounts[0].settings.settings.loop.everySeconds, 47);
  console.log('通过：直接打开导出、全选与取消全选，多选下载仅包含勾选账号及配置');

  await page.locator('.account-card-menu > summary').first().click();
  await page.locator('[data-account-action="export"]').first().click();
  assert.equal(await page.locator('#account-export-list input:checked').count(), 1);
  const [single] = await Promise.all([page.waitForEvent('download'), page.locator('#account-export-only').click()]);
  const singleBackup = JSON.parse(fs.readFileSync(await single.path(), 'utf8'));
  assert.equal(singleBackup.accounts.length, 1);
  assert.equal(Object.hasOwn(singleBackup.accounts[0], 'settings'), false);
  console.log('通过：账号卡片导出仅账号');

  for (const row of [account, ...extraAccounts]) {
    const removal = await fetch(root + '/api/accounts/remove', { method: 'POST', body: JSON.stringify({ id: row.id, confirm: true }) });
    assert.equal(removal.status, 200);
  }
  const saved = loadAutomationSettings(account.id); saved.settings.loop.everySeconds = 99;
  saveAutomationSettings(account.id, saved.settings, { revision: saved.revision });
  await page.reload();
  await page.locator('#tabs [data-tab="account"]').click();
  await page.locator('#account-count').filter({ hasText: '0 个账号' }).waitFor();
  assert.equal(await page.locator('#export-accounts').isDisabled(), true);
  const connectionsBeforeImport = connections;
  await page.locator('#import-accounts-file').setInputFiles(backupPath);
  await page.locator('#account-dialog[open]').waitFor();
  assert.match(await page.locator('#account-message').textContent(), /新增 2 个账号/);
  await page.locator('#account-dialog button[value="cancel"]').click();
  await page.locator('#account-transfer-notice').filter({ hasText: '已取消' }).waitFor();
  assert.equal(loadStore().accounts.length, 0);
  await page.locator('#import-accounts-file').setInputFiles(backupPath);
  await page.locator('#account-dialog button[value="ok"]').click();
  await page.locator('#account-transfer-notice').filter({ hasText: '导入完成' }).waitFor();
  assert.equal(loadStore().accounts.length, 2);
  assert.equal(loadAutomationSettings(account.id).settings.loop.everySeconds, 47);
  assert.equal(loadStore().accounts[0].automation.autoStart, false);
  assert.equal(connections, connectionsBeforeImport, '导入不主动连接游戏');
  await page.screenshot({ path: path.join(output, 'account-import-desktop.png'), animations: 'disabled' });
  console.log('通过：空账号列表导入、取消、重选文件和配置恢复');
  await page.locator('#import-accounts-file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await page.locator('#account-transfer-notice').filter({ hasText: '文件不是有效 JSON' }).waitFor();
  assert.equal(loadStore().accounts.length, 2);
  console.log('通过：错误文件显示明确反馈');

  const mobileContext = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage(); mobile.on('pageerror', error => pageErrors.push(error.message));
  await mobile.goto(root);
  await mobile.locator('#account-picker-title').filter({ hasText: '备份验收船长' }).waitFor();
  await mobile.locator('#tabs [data-tab="account"]').tap();
  await mobile.screenshot({ path: path.join(output, 'account-import-mobile.png'), animations: 'disabled' });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.locator('#export-accounts').tap();
  await mobile.locator('#account-export-list label').first().tap();
  assert.equal(await mobile.locator('#account-export-list input:checked').count(), 1);
  await mobile.screenshot({ path: path.join(output, 'account-export-mobile.png'), animations: 'disabled' });
  assert.equal(await mobile.locator('#account-export-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true);
  for (const id of ['account-export-only', 'account-export-settings']) {
    assert.equal(await mobile.locator('#' + id).evaluate(button => button.scrollHeight <= button.clientHeight), true);
  }
  const [mobileDownload] = await Promise.all([mobile.waitForEvent('download'), mobile.locator('#account-export-only').tap()]);
  const mobileBackup = JSON.parse(fs.readFileSync(await mobileDownload.path(), 'utf8'));
  assert.deepEqual(mobileBackup.accounts.map(row => row.id), [account.id]);
  console.log('通过：360px手机操作入口、导出弹窗和选项无溢出');
  assert.deepEqual(pageErrors, []);
  await context.close(); await mobileContext.close();
  console.log('账号备份浏览器验收通过，截图目录 ' + output);
} finally {
  if (browser) await browser.close();
  app.server.closeAllConnections(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
