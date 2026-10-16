import { deflateRawSync, inflateRawSync } from "node:zlib";
import { AppError } from "../../../common/errors";

// A minimal ZIP container (no dependency) for .xlsx files: read (stored and deflated entries)
// and write (deflated with node:zlib, CRC32 computed here). No ZIP64, encryption or spanning.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const invalid = (message: string) => new AppError("INVALID_FILE", message, 422);

/**
 * Reads the entries of a ZIP archive. `maxBytes` bounds the total uncompressed size (a crafted
 * "zip bomb" is refused instead of exhausting memory); only names matching `wanted` are inflated.
 */
export function readZip(buf: Buffer, opts: { maxBytes: number; wanted?: (name: string) => boolean }): Map<string, Buffer> {
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 65_557); p--) {
    if (buf.readUInt32LE(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw invalid("This file is not a valid .xlsx workbook (it isn't a ZIP archive). Save it as Excel Workbook (.xlsx) or CSV.");
  const count = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) throw invalid("The workbook's file directory is damaged.");
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const size = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const offset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (opts.wanted && !opts.wanted(name)) continue;
    if (flags & 1) throw invalid("Password-protected workbooks can't be imported. Remove the password and upload it again.");
    if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== 0x04034b50) throw invalid("The workbook is damaged.");
    total += size;
    if (total > opts.maxBytes) throw new AppError("FILE_TOO_LARGE", "The workbook is too large once unpacked. Split it into smaller files.", 413);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + compressedSize);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) {
      try {
        files.set(name, inflateRawSync(data, { maxOutputLength: Math.max(size, 1) + 1024 }));
      } catch {
        throw invalid("The workbook is damaged (a part couldn't be unpacked).");
      }
    } else throw invalid(`The workbook uses an unsupported compression (method ${method}). Save it again from Excel.`);
  }
  return files;
}

/** Builds a ZIP archive (deflated entries). */
export function writeZip(entries: { name: string; data: Buffer | string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00 in DOS format keeps the output byte-for-byte reproducible.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const compressed = deflateRawSync(raw, { level: 6 });
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
