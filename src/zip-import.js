import { inflateRawSync } from "node:zlib";
const MAX = 50 * 1024 * 1024;
const table = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function readZapArchive(bytes, { limit = MAX } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX)
    throw Error("Invalid ZIP archive or compressed size exceeds 50 MB.");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (
    end < 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0
  )
    throw Error("Split or invalid ZIP archives are not supported.");
  const count = bytes.readUInt16LE(end + 10),
    centralSize = bytes.readUInt32LE(end + 12),
    start = bytes.readUInt32LE(end + 16);
  if (
    count === 65535 ||
    count > 100 ||
    start + centralSize > end ||
    bytes.readUInt16LE(end + 8) !== count
  )
    throw Error("ZIP directory is too large or unsupported.");
  const entries = [];
  let position = start;
  for (let i = 0; i < count; i++) {
    if (
      position + 46 > start + centralSize ||
      bytes.readUInt32LE(position) !== 0x02014b50
    )
      throw Error("Invalid ZIP directory.");
    const nameLength = bytes.readUInt16LE(position + 28),
      extra = bytes.readUInt16LE(position + 30),
      comment = bytes.readUInt16LE(position + 32);
    if (position + 46 + nameLength + extra + comment > start + centralSize)
      throw Error("Truncated ZIP entry.");
    const name = bytes
      .subarray(position + 46, position + 46 + nameLength)
      .toString("utf8");
    entries.push({
      name,
      flags: bytes.readUInt16LE(position + 8),
      method: bytes.readUInt16LE(position + 10),
      crc: bytes.readUInt32LE(position + 16),
      compressed: bytes.readUInt32LE(position + 20),
      size: bytes.readUInt32LE(position + 24),
      offset: bytes.readUInt32LE(position + 42),
    });
    position += 46 + nameLength + extra + comment;
  }
  const candidates = entries.filter((e) =>
    /(^|\/)zapfile\.json$/i.test(e.name),
  );
  const jsons = candidates.length
    ? candidates
    : entries.filter((e) => e.name.toLowerCase().endsWith(".json"));
  if (jsons.length !== 1)
    throw Error(
      "ZIP must contain one unambiguous Zap JSON file. Extract the desired file and import it directly.",
    );
  const e = jsons[0];
  if (
    e.name.split(/[\\/]/).some((part) => part === "..") ||
    /^[\\/]/.test(e.name) ||
    e.name.includes("\0")
  )
    throw Error("Unsafe archive entry name.");
  if (e.flags & 1 || ![0, 8].includes(e.method))
    throw Error("Encrypted or unsupported ZIP compression.");
  if (
    e.size > limit ||
    e.compressed > MAX ||
    e.offset + 30 > start ||
    bytes.readUInt32LE(e.offset) !== 0x04034b50
  )
    throw Error(
      "ZIP expands beyond the 50 MB limit or contains an invalid entry.",
    );
  if (bytes.readUInt16LE(e.offset + 8) !== e.method)
    throw Error("Inconsistent ZIP compression metadata.");
  const dataStart =
      e.offset +
      30 +
      bytes.readUInt16LE(e.offset + 26) +
      bytes.readUInt16LE(e.offset + 28),
    dataEnd = dataStart + e.compressed;
  if (dataEnd > start) throw Error("Truncated ZIP payload.");
  const compressed = bytes.subarray(dataStart, dataEnd),
    payload =
      e.method === 8
        ? inflateRawSync(compressed, { maxOutputLength: limit })
        : compressed;
  if (payload.length !== e.size || crc32(payload) !== e.crc)
    throw Error("ZIP checksum or expanded size does not match.");
  // Nothing is extracted onto the filesystem, and no other archive entry is executed.
  return JSON.parse(payload.toString("utf8").replace(/^\uFEFF/, ""));
}
export function decodeImport(input) {
  if (input && Object.hasOwn(input, "archive_base64")) {
    if (
      typeof input.archive_base64 !== "string" ||
      input.archive_base64.length > Math.ceil((MAX * 4) / 3) + 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(input.archive_base64)
    )
      throw Error("Invalid encoded ZIP upload.");
    return readZapArchive(Buffer.from(input.archive_base64, "base64"));
  }
  return input;
}
