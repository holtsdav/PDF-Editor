import { deflateSync } from 'node:zlib';

/** An RGBA PNG of half-transparent red, generated so tests need no binary fixtures. */
export function png(width = 2, height = 2): Uint8Array<ArrayBuffer> {
  const crc = (bytes: Buffer) => {
    let c = ~0;
    for (const byte of bytes) {
      c ^= byte;
      for (let k = 0; k < 8; k++) {
        c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = [0, ...Array.from({ length: width }, () => [220, 30, 30, 128]).flat()];
  const pixels = Buffer.from(Array.from({ length: height }, () => row).flat());
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
