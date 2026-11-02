/**
 * UUID v7 (RFC 9562): 48 bits of Unix milliseconds, version 7, variant 10, random bits.
 * Time-ordered and creatable offline on any PC (spec 6.2).
 */
export function uuidv7(now: number = Date.now(), random?: () => number): string {
  const bytes = new Uint8Array(16);
  if (random) for (let i = 0; i < 16; i++) bytes[i] = Math.floor(random() * 256);
  else crypto.getRandomValues(bytes);
  let ms = Math.floor(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
