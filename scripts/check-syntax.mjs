import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function moduleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? moduleFiles(path) : extname(entry.name) === ".mjs" ? [path] : [];
  }));
  return files.flat();
}

const files = (await Promise.all(["plugins", "scripts", "tests"].map(moduleFiles))).flat().sort();
for (const file of files) await execFileAsync(process.execPath, ["--check", file]);
process.stdout.write(`Syntax check passed for ${files.length} modules\n`);
