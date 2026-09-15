import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "plugins", "deepseek-subagent", ".codex-plugin", "plugin.json"), "utf8"));
const version = String(manifest.version).replace(/[^A-Za-z0-9._+-]/g, "-");
const output = join(root, "dist", `codex-deepseek-subagent-${version}.zip`);
const roots = [join(root, ".agents"), join(root, "plugins"), join(root, "README.md"), join(root, "LICENSE"), join(root, "scripts", "package.mjs")];

async function collect(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path);
  return (await Promise.all(entries.sort().map((entry) => collect(join(path, entry))))).flat();
}

const files = (await Promise.all(roots.map(collect))).flat().filter((path) => !path.includes(`${sep}dist${sep}`));
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const localParts = [];
const centralParts = [];
const secretPattern = /(?:sk-|Bearer\s+)[A-Za-z0-9_-]{20,}/;
const privatePathPattern = /(?:\/Users\/[^/\s"']+\/|\/home\/[^/\s"']+\/|[A-Za-z]:\\Users\\[^\\\s"']+\\)/;
let offset = 0;
for (const path of files) {
  const data = await readFile(path);
  const text = data.toString("utf8");
  const archiveName = relative(root, path).split(sep).join("/");
  if (secretPattern.test(text)) throw new Error(`Refusing to package ${archiveName}: content resembles an API key.`);
  if (privatePathPattern.test(text)) throw new Error(`Refusing to package ${archiveName}: content contains a user-specific absolute path.`);
  const name = Buffer.from(archiveName, "utf8");
  const info = await stat(path);
  const { time, date } = dosDateTime(info.mtime);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  localParts.push(local, name, data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);
  offset += local.length + name.length + data.length;
}
const central = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...localParts, central, end]);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, archive, { flag: "w", mode: 0o600 });
process.stdout.write(`${output}\n`);
