export const utf8 = value => new TextEncoder().encode(value);
export const concat = (...parts) => {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
export function b64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function unb64(value, { min = 0, max = 8192 } = {}) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1 || value.length > max * 2) {
    throw new Error("Invalid base64url data.");
  }
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), x => x.charCodeAt(0));
  if (bytes.length < min || bytes.length > max || b64(bytes) !== value) throw new Error("Invalid data length or encoding.");
  return bytes;
}
export const randomId = (size = 32) => b64(crypto.getRandomValues(new Uint8Array(size)));
export const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
export function uint32(value) {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value);
  return result;
}
function head(type, value) {
  if (value < 24) return Uint8Array.of((type << 5) | value);
  if (value < 256) return Uint8Array.of((type << 5) | 24, value);
  if (value < 65536) return Uint8Array.of((type << 5) | 25, value >> 8, value & 255);
  return concat(Uint8Array.of((type << 5) | 26), uint32(value));
}
export function cbor(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return head(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (typeof value === 'string') { const bytes = utf8(value); return concat(head(3, bytes.length), bytes); }
  if (typeof value === 'boolean') return Uint8Array.of(value ? 0xf5 : 0xf4);
  if (Array.isArray(value)) return concat(head(4, value.length), ...value.map(cbor));
  if (value instanceof Map) return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
  throw new Error("Unsupported CBOR value.");
}
export function derSignature(raw) {
  if (raw.length !== 64) throw new Error("Invalid P-256 signature.");
  function integer(part) {
    let start = 0;
    while (start < part.length - 1 && part[start] === 0) start++;
    let bytes = part.slice(start);
    if (bytes[0] & 128) bytes = concat(Uint8Array.of(0), bytes);
    return concat(Uint8Array.of(2, bytes.length), bytes);
  }
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}
