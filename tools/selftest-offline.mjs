import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cw-offline-'));
const cases = [
  ['selftest-campaign-report-rewards.mjs'],
  ['selftest-world-boss-fleets.mjs'],
  ['selftest-world-boss-lineups.mjs'],
  ['selftest-react-client.mjs'],
  ['selftest-account-backup-http.mjs'],
  ['selftest-account-backup-ui.mjs'],
  ['selftest-role-switch-http.mjs'],
  ['selftest-role-rotation-http.mjs'],
  ['selftest-automation-results.mjs'],
  ['selftest-automation-results-http.mjs'],
  ['selftest-fleet-speed.mjs'],
  ['selftest-fleet-speed-http.mjs'],
  ['selftest-storage-transactions.mjs'],
  ['selftest-settings-version.mjs'],
  ['selftest-settings-recovery.mjs'],
  ['selftest-settings-recovery-http.mjs'],
  ['selftest-console-version.mjs'],
  ['selftest-console-version-http.mjs'],
  ['selftest-console-version-ui.mjs'],
  ['selftest-protocol-updates.mjs'],
  ['selftest-protocol-refresh-http.mjs'],
  ['selftest-resource-version.mjs'],
  ['selftest-settings-runtime.mjs'],
  ['selftest-settings-upgrade-http.mjs'],
  ['selftest-settings-persistence.mjs'],
  ['selftest-auto-start.mjs'],
  ['selftest-new-account-defaults.mjs'],
  ['selftest-loop-auto-start-ui.mjs'],
  ['selftest-settings-hierarchy.mjs'],
  ['selftest-dispatch-order-ui.mjs'],
  ['selftest-settings-autosave.mjs'],
  ['selftest-switch-ownership.mjs'],
  ['selftest-appointments.mjs'],
  ['selftest-appointment-loop.mjs'],
  ['selftest-appointment-http.mjs'],
  ['selftest-appointment-settings-http.mjs'],
  ['selftest-appointments-ui.mjs'],
  ['selftest-saved-lineups.mjs'],
  ['selftest-hero-growth.mjs'],
  ['selftest-hero-advanced-growth.mjs'],
  ['selftest-hero-gear-growth.mjs'],
  ['selftest-hero-growth-http.mjs'],
  ['selftest-hero-show-rewards.mjs'],
  ['selftest-lineup-runtime.mjs'],
  ['selftest-lineup-challenges.mjs'],
  ['selftest-lineup-presets-http.mjs'],
  ['selftest-lineup-lifecycle-http.mjs'],
  ['selftest-lineup-editor-ui.mjs'],
  ['selftest-order-reservations.mjs'],
  ['selftest-week-order-auto.mjs'],
  ['selftest-merchant-activity-ui.mjs'],
  ['selftest-hero-raid-settings-http.mjs'],
  ['selftest-merchant-settings-http.mjs'],
  ['selftest-guild-ship-settings-http.mjs'],
  ['selftest-activity-automation.mjs'],
  ['selftest-weekly-activity-settings.mjs'],
  ['selftest-weekly-activity.mjs'],
  ['selftest-weekly-activity-loop.mjs'],
  // Weekly runner and ranking HTTP codec tests require the game protocol;
  // they remain in test:weekly-activity, which is included by test:core.
  ['selftest-activity-config-http.mjs'],
  ['selftest-activity-catalog.mjs'],
  ['selftest-activity-availability.mjs'],
  ['selftest-progression-budgets.mjs'],
  ['selftest-base-status.mjs'],
  ['selftest-pending-operation.mjs'],
  ['selftest-guard-lifecycle.mjs'],
  ['selftest-loop-scheduler.mjs'],
  ['selftest-factory-loop.mjs', '--offline'],
  ['selftest-production-optimizer.mjs'],
  ['selftest-production-snapshot.mjs'],
  ['selftest-production-timing.mjs'],
  ['selftest-production-planning.mjs'],
  ['selftest-production-plan-http.mjs'],
  ['selftest-production-planning-ui.mjs'],
  ['selftest-world-production-ui.mjs'],
  ['selftest-resource-updater.mjs'],
  ['selftest-trace-log.mjs'],
  ['selftest-protocol-diagnostics.mjs'],
  ['selftest-log-filters.mjs'],
  ['selftest-console-log.mjs'],
  ['selftest-account-status-ui.mjs'],
  ['selftest-account-picker-ui.mjs'],
  ['selftest-account-cards-ui.mjs'],
  ['selftest-account-capture-ui.mjs'],
  ['selftest-account-add-ui.mjs'],
  ['selftest-console-output.mjs'],
  ['selftest-platform-recovery.mjs'],
  ['selftest-capture-recovery-http.mjs'],
  ['selftest-phone-login.mjs'],
  ['selftest-phone-login-http.mjs'],
  ['selftest-phone-login-ui.mjs'],
  ['selftest-alipay-browser.mjs'],
  ['selftest-alipay-login.mjs'],
  ['selftest-alipay-login-http.mjs'],
  ['selftest-alipay-login-ui.mjs'],
];

try {
  for (const [index, [file, ...args]] of cases.entries()) {
    const directory = path.join(temporary, String(index));
    fs.mkdirSync(directory);
    const config = path.join(directory, 'config.json');
    fs.writeFileSync(config, '[]');
    console.log(`离线测试 ${index + 1}/${cases.length} ${file}`);
    const result = spawnSync(process.execPath, [path.join(root, 'tools', file), ...args], {
      cwd: root, stdio: 'inherit', windowsHide: true, timeout: 120_000,
      env: { ...process.env, CW_DATA_DIR: directory, CW_CONFIG_PACK: config,
        CW_RESOURCE_DIR: path.join(directory, 'resources'), CW_CA_DIR: path.join(directory, 'certificates'),
        CW_PROTO_BUNDLE: path.join(directory, 'missing-game-protocol.js'), CW_RESOURCE_AUTO_UPDATE: '0' },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, file + ' 离线验证失败');
  }
  console.log(`核心离线测试 ${cases.length}/${cases.length} 组通过`);
} finally {
  assert.equal(path.dirname(temporary), fs.realpathSync(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
}
