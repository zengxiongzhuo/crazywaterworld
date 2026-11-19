// Minimal wire primitives for the application-store login protocol.
// Reference: YYB-Go-Enhanced v0.3.10, internal/protocol/bytes.go (9d5e2bd).
export const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const MAX_U64 = (1n << 64n) - 1n;
export function uint64(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('不精确的协议整数');
  const number = BigInt(value);
  if (number < 0n || number > MAX_U64) throw Error('协议整数超出 uint64 范围');
  return number;
}
export function varint(value) {
  let number = uint64(value);
  const result = [];
  do { const low = Number(number & 127n); number >>= 7n; result.push(low | (number ? 128 : 0)); } while (number);
  return Buffer.from(result);
}
export function readVarint(data, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0 || offset > data.length) throw Error('协议偏移无效');
  let value = 0n;
  for (let count = 0; count < 10; count++) {
    if (offset >= data.length) throw Error('协议 varint 被截断');
    const byte = data[offset++];
    if (count === 9 && byte > 1) throw Error('协议 varint 溢出');
    value |= BigInt(byte & 127) << BigInt(count * 7);
    if (!(byte & 128)) return { value, offset, next: offset };
  }
  throw Error('协议 varint 溢出');
}
function tag(field, wire) {
  if (!Number.isInteger(field) || field < 1 || field > 0x1fffffff) throw Error('protobuf 字段号无效');
  return varint(BigInt(field) * 8n + BigInt(wire));
}
export function pbLen(field, data) {
  const bytes = Buffer.from(data);
  if (bytes.length > MAX_WIRE_BYTES) throw Error('protobuf 字段过大');
  return Buffer.concat([tag(field, 2), varint(bytes.length), bytes]);
}
export function pbVar(field, value) { return Buffer.concat([tag(field, 0), varint(value)]); }
export function pbParse(input) {
  const data = Buffer.from(input), fields = new Map();
  if (data.length > MAX_WIRE_BYTES) throw Error('protobuf 消息过大');
  let offset = 0, count = 0;
  while (offset < data.length) {
    if (++count > 65536) throw Error('protobuf 字段过多');
    const fieldTag = readVarint(data, offset); offset = fieldTag.offset;
    const field = Number(fieldTag.value >> 3n), wire = Number(fieldTag.value & 7n);
    if (!field || field > 0x1fffffff) throw Error('protobuf 字段号无效');
    if (wire === 0) {
      const scalar = readVarint(data, offset); offset = scalar.offset; fields.set(field, scalar.value);
    } else if (wire === 2) {
      const length = readVarint(data, offset); offset = length.offset;
      if (length.value > BigInt(data.length - offset)) throw Error('protobuf 字段被截断');
      const end = offset + Number(length.value); fields.set(field, Buffer.from(data.subarray(offset, end))); offset = end;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > data.length) throw Error('protobuf 定长字段被截断');
      fields.set(field, wire === 1 ? data.readBigUInt64LE(offset) : BigInt(data.readUInt32LE(offset))); offset += size;
    } else throw Error('不支持的 protobuf wire 类型');
  }
  return fields;
}
export function safeBytes(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === 'string' ? Buffer.from(value) : Buffer.alloc(0);
}
export function lz4AllLiteral(input) {
  const data = Buffer.from(input);
  if (data.length > MAX_WIRE_BYTES) throw Error('LZ4 输入过大');
  const head = [Math.min(data.length, 15) << 4];
  if (data.length >= 15) {
    let rest = data.length - 15;
    while (rest >= 255) { head.push(255); rest -= 255; }
    head.push(rest);
  }
  return Buffer.concat([Buffer.from(head), data]);
}
export function lz4Decompress(input, maxBytes = MAX_WIRE_BYTES) {
  const data = Buffer.from(input);
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_WIRE_BYTES || data.length > MAX_WIRE_BYTES) throw Error('LZ4 大小限制无效');
  let inputOffset = 0, used = 0;
  // Bound allocations and overlapping-copy expansion independently of input size.
  const output = Buffer.alloc(Math.min(maxBytes, MAX_WIRE_BYTES));
  const extend = base => {
    let result = base, byte;
    do { if (inputOffset === data.length) throw Error('LZ4 长度被截断'); byte = data[inputOffset++]; result += byte; if (result > maxBytes) throw Error('LZ4 输出过大'); } while (byte === 255);
    return result;
  };
  while (inputOffset < data.length) {
    const token = data[inputOffset++];
    const literals = (token >> 4) === 15 ? extend(15) : token >> 4;
    if (inputOffset + literals > data.length) throw Error('LZ4 字面量被截断');
    if (used + literals > maxBytes) throw Error('LZ4 输出过大');
    data.copy(output, used, inputOffset, inputOffset + literals); inputOffset += literals; used += literals;
    if (inputOffset === data.length) break;
    if (inputOffset + 2 > data.length) throw Error('LZ4 偏移被截断');
    const back = data.readUInt16LE(inputOffset); inputOffset += 2;
    if (!back || back > used) throw Error('LZ4 回溯偏移无效');
    const match = (token & 15) === 15 ? extend(19) : (token & 15) + 4;
    if (used + match > maxBytes) throw Error('LZ4 输出过大');
    for (let index = 0; index < match; index++) { output[used] = output[used - back]; used++; }
  }
  return Buffer.from(output.subarray(0, used));
}
