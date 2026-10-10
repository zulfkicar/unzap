import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { readZapArchive, crc32, decodeImport } from "../src/zip-import.js";
function zip(entries) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name),
      data = Buffer.from(text),
      c = deflateRawSync(data),
      crc = crc32(data),
      l = Buffer.alloc(30),
      h = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(c.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(n.length, 26);
    h.writeUInt32LE(0x02014b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(8, 10);
    h.writeUInt32LE(crc, 16);
    h.writeUInt32LE(c.length, 20);
    h.writeUInt32LE(data.length, 24);
    h.writeUInt16LE(n.length, 28);
    h.writeUInt32LE(offset, 42);
    locals.push(l, n, c);
    central.push(h, n);
    offset += 30 + n.length + c.length;
  }
  const index = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, index, end]);
}
test("ZIP imports decode a deflated export without extracting files", () => {
  const source = readFileSync(
      new URL("../fixtures/operations.json", import.meta.url),
      "utf8",
    ),
    archive = zip([["backup/zapfile.json", source]]);
  assert.equal(readZapArchive(archive).zaps.length, 3);
  assert.deepEqual(
    decodeImport({ archive_base64: archive.toString("base64") }),
    JSON.parse(source),
  );
});
test("ZIP bombs, ambiguous files, unsafe names, damaged entries and truncation are rejected", () => {
  assert.throws(
    () =>
      readZapArchive(zip([["zapfile.json", "x".repeat(10000)]]), {
        limit: 100,
      }),
    /limit/,
  );
  assert.throws(
    () =>
      readZapArchive(
        zip([
          ["a.json", "{}"],
          ["b.json", "{}"],
        ]),
      ),
    /unambiguous/,
  );
  assert.throws(
    () => readZapArchive(zip([["../zapfile.json", "{}"]])),
    /Unsafe/,
  );
  const broken = zip([["zapfile.json", "{}"]]);
  broken[30 + "zapfile.json".length] ^= 16;
  assert.throws(() => readZapArchive(broken));
  assert.throws(() => readZapArchive(broken.subarray(0, 20)), /Invalid/);
  assert.throws(() => decodeImport({ archive_base64: "invalid!" }), /Invalid/);
});
