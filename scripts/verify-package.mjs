import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "plugins", "deepseek-subagent", ".codex-plugin", "plugin.json"), "utf8"));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(packageJson.version, manifest.version, "package.json and plugin manifest versions differ.");
const archivePath = join(root, "dist", `codex-deepseek-subagent-${manifest.version}.zip`);
const archive = await readFile(archivePath);
const roots = [join(root, ".agents"), join(root, "plugins"), join(root, "README.md"), join(root, "LICENSE"), join(root, "scripts", "package.mjs")];

async function collect(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  return (await Promise.all((await readdir(path)).sort().map((entry) => collect(join(path, entry))))).flat();
}

const expectedFiles = (await Promise.all(roots.map(collect))).flat();
const expected = new Map(await Promise.all(expectedFiles.map(async (path) => [relative(root, path).split(sep).join("/"), await readFile(path)])));
const actual = new Map();
let offset = 0;
while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
  assert.equal(archive.readUInt16LE(offset + 8), 0, "Release archive unexpectedly uses compression.");
  const size = archive.readUInt32LE(offset + 18);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const dataStart = nameStart + nameLength + extraLength;
  const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
  assert(!actual.has(name), `Duplicate archive entry: ${name}`);
  actual.set(name, archive.subarray(dataStart, dataStart + size));
  offset = dataStart + size;
}
assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), "Release archive file list differs from the source candidate.");
for (const [name, data] of expected) assert.deepEqual(actual.get(name), data, `Release archive entry differs from source: ${name}`);
process.stdout.write(`Release archive matches ${actual.size} source files exactly.\n`);
