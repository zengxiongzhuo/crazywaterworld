export const giftRecordLabels = { queued:'待兑换', sending:'兑换中', success:'兑换成功', used:'已兑换', rejected:'服务器拒绝', unknown:'待确认', skipped:'未发送' };

const invalidDetails = new Set(['礼包码已过期', '礼包码无效', '已达到兑换上限', '已由其他账号兑换']);
const retryPrompts = new Set(['GIFT_CODE_TOO_MANY_REQUESTS', 'GIFT_CODE_EXPIRED_OR_NOT_YET']);
export const canRetryGiftRecord = row => row.status === 'rejected' && (
  retryPrompts.has(row.promptName) || row.detail === '请求过于频繁' || row.detail === '不在兑换有效期'
  || (!row.promptName && /^服务器拒绝，提示码 \d+$/.test(row.detail ?? '')));
export const canRetryGiftCode = (rows, code) => {
  const history = rows.filter(row => row.code === code);
  return history.some(canRetryGiftRecord) && history.every(row => canRetryGiftRecord(row) || row.status === 'skipped');
};

const filters = new Set(['all', 'exclude-invalid', 'invalid', 'retryable', ...Object.keys(giftRecordLabels)]);
export function filterGiftRecords(rows, status = 'exclude-invalid') {
  if (!filters.has(status)) throw new Error('不支持的兑换记录状态');
  const invalid = row => row.status === 'rejected' && invalidDetails.has(row.detail);
  const retryable = status === 'retryable' ? new Set(rows.filter(canRetryGiftRecord).map(row => row.code)
    .filter(code => canRetryGiftCode(rows, code))) : null;
  return rows.filter(row => status === 'all' || (status === 'retryable' ? canRetryGiftRecord(row) && retryable.has(row.code)
    : status === 'invalid' ? invalid(row) : status === 'exclude-invalid' ? !invalid(row) : row.status === status));
}

export function paginateGiftRecords(rows, { page = '1', pageSize = '10', status = 'exclude-invalid' } = {}) {
  if (!/^[1-9][0-9]*$/.test(String(page)) || !Number.isSafeInteger(Number(page))) throw new Error('页码无效');
  if (!['10', '20', '50', '100'].includes(String(pageSize))) throw new Error('每页条数仅支持 10、20、50、100');
  const filtered = filterGiftRecords(rows, status);
  const total = filtered.length, pages = Math.max(1, Math.ceil(total / Number(pageSize)));
  const current = Math.min(Number(page), pages);
  return { rows: filtered.slice((current - 1) * Number(pageSize), current * Number(pageSize)), total, pages,
    page: current, pageSize: Number(pageSize), status };
}

export function giftRecordsCsv(rows, status) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [['礼包码', '状态', '结果', '时间'], ...filterGiftRecords(rows, status)
    .map(row => [row.code, giftRecordLabels[row.status] || row.status, row.detail, row.at])]
    .map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
