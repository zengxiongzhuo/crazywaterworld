// Public diagnostics contain only fixed labels and bounded numeric status
// codes. Never return an upstream body, URL, cookie, code, ticket or raw error.
export const WECHAT_STAGES = Object.freeze({
  qr: '二维码获取', poll: '扫码状态查询', callback: '微信授权回调', ticket: '微信登录票据获取',
  device: '协议设备准备', discovery: '微信连接地址查询', handshake: '微信连接握手',
  'manual-auth': '微信协议认证', code: '小游戏登录码获取',
  'game-public': '游戏登录参数读取', 'game-init': '游戏登录初始化',
  'game-channel': '游戏渠道授权', 'game-login': '游戏凭据获取',
});

const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'WECHAT_DIAL_FAILED', 'WECHAT_HTTP_FAILED']);
const numeric = value => typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : undefined;
export function wechatFailure(error, stage) {
  stage = Object.hasOwn(WECHAT_STAGES, stage) ? stage : 'code';
  const text = typeof error?.message === 'string' ? error.message : '';
  let code = 'UNKNOWN', detail = '未能完成本阶段';
  if (error?.name === 'TimeoutError' || /超时/.test(text)) { code = 'TIMEOUT'; detail = '请求超时'; }
  else if (error?.name === 'AbortError') { code = 'CANCELLED'; detail = '请求已结束'; }
  else if (/跳转/.test(text)) { code = 'REDIRECT'; detail = '授权页面跳转未完成'; }
  else if (/完整凭据/.test(text)) { code = 'MISSING_CREDENTIAL'; detail = '未收到完整授权凭据'; }
  else if (/种子|设备标识|授权身份/.test(text)) { code = 'DEVICE'; detail = '设备标识无效'; }
  else if (/被拒绝|拒绝请求/.test(text) || ['WECHAT_BUFFER_REJECTED', 'WECHAT_GAME_REJECTED'].includes(error?.code)) { code = 'REJECTED'; detail = '服务端拒绝请求'; }
  else if (/不匹配|错配|认证|校验失败/.test(text)) { code = 'AUTHENTICATION'; detail = '响应验证未通过'; }
  else if (/格式|字段|无效|缺少|未返回|不支持|截断|protobuf|WPKG/i.test(text)) { code = 'RESPONSE'; detail = '响应格式不符合预期'; }
  else if (networkCodes.has(error?.code) || networkCodes.has(error?.cause?.code) || /网络请求|连接失败|连接中断/.test(text)) { code = 'NETWORK'; detail = '网络连接失败'; }
  const fromMessage = /^微信授权请求失败（HTTP (\d{3})）$/.exec(text);
  const httpStatus = numeric(error?.httpStatus) ?? (fromMessage ? Number(fromMessage[1]) : undefined);
  const statusCode = numeric(error?.statusCode) ?? numeric(error?.responseCode) ?? numeric(error?.code);
  const diagnostic = { stage, code, ...(httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}), ...(statusCode !== undefined ? { statusCode } : {}) };
  const numbers = [diagnostic.httpStatus && 'HTTP ' + diagnostic.httpStatus, diagnostic.statusCode !== undefined && '状态码 ' + diagnostic.statusCode].filter(Boolean);
  return { diagnostic, message: `${WECHAT_STAGES[stage]}失败：${detail}${numbers.length ? '（' + numbers.join('，') + '）' : ''}。诊断码 WX_${stage.replaceAll('-', '_').toUpperCase()}_${code}，请重新扫码或稍后重试。` };
}

export function notifyWechatStage(observer, stage) {
  if (!Object.hasOwn(WECHAT_STAGES, stage)) return;
  try { Promise.resolve(observer?.(stage)).catch(() => {}); } catch { /* Observers cannot alter login. */ }
}
