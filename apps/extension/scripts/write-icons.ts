import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { publicPath, readManifest } from "./manifest.ts";

// Placeholder icons until the final artwork lands: one flat colour, no text.
const COLOR = [0x2f, 0x6f, 0xdb] as const;

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(NodeZlib.crc32(body));
  return Buffer.concat([length, body, crc]);
};

const squarePng = (size: number, [red, green, blue]: readonly [number, number, number]): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => [red, green, blue]).flat()),
  ]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const manifest = readManifest();
for (const [size, path] of Object.entries({ ...manifest.icons, ...manifest.action.default_icon })) {
  const file = publicPath(path);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, squarePng(Number(size), COLOR));
}
