// 业务回归只验证原有 API；密码登录专项直接导入生产 server.mjs。
// 动态导入保留 CW_DATA_DIR 的初始化顺序，禁止使用真实账号数据。
if (!process.env.CW_DATA_DIR) throw new Error('控制台业务测试必须先设置临时 CW_DATA_DIR');
const server = await import('../../src/server.mjs');

export function createConsole(options = {}) {
  return server.createConsole({ ...options, authentication: false });
}
export const findAppBrowser = server.findAppBrowser;
export const openBrowser = server.openBrowser;
