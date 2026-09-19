import { execFileSync } from "node:child_process";
import { lstat, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "deepseek-subagent";
const marketplaceName = "deepseek-team";
const pluginId = `${pluginName}@${marketplaceName}`;
const skillNames = ["deepseek-subagent", "deepseek-team"];
const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");

let listing;
try {
  listing = JSON.parse(execFileSync("codex", ["plugin", "list", "--marketplace", marketplaceName, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }));
} catch (error) {
  throw new Error(`Unable to read the installed ${pluginId} plugin: ${error.message}`);
}

const installed = listing?.installed?.find((entry) => entry.pluginId === pluginId && entry.installed);
if (!installed?.version) throw new Error(`${pluginId} is not installed.`);
if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(installed.version)) {
  throw new Error(`Installed ${pluginId} version is unsafe for a cache path.`);
}
const sourcePlugin = join(root, "plugins", pluginName);
const installedSource = await realpath(installed?.source?.path || "").catch(() => "");
if (!installedSource || installedSource !== await realpath(sourcePlugin)) {
  throw new Error(`${pluginId} is installed from another source checkout.`);
}
const cachePlugin = join(codexHome, "plugins", "cache", marketplaceName, pluginName, installed.version);
const cacheRoot = await realpath(join(codexHome, "plugins", "cache")).catch(() => "");
const resolvedCachePlugin = await realpath(cachePlugin).catch(() => "");
if (!cacheRoot || !resolvedCachePlugin ||
    (resolvedCachePlugin !== cacheRoot && !resolvedCachePlugin.startsWith(`${cacheRoot}${sep}`))) {
  throw new Error(`Installed plugin cache is missing or outside the Codex cache: ${cachePlugin}`);
}
const manifestInfo = await lstat(join(resolvedCachePlugin, ".codex-plugin", "plugin.json")).catch(() => null);
if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) throw new Error(`Installed plugin manifest is unsafe: ${cachePlugin}`);

const skillEntries = await Promise.all(skillNames.map(async (skillName) => {
  const source = join(sourcePlugin, "skills", skillName);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error(`Skill source is not a regular directory: ${source}`);
  return { skillName, source: await realpath(source), destination: join(resolvedCachePlugin, "skills", skillName) };
}));

for (const { skillName, source, destination } of skillEntries) {
  await mkdir(dirname(destination), { recursive: true });
  let alreadyLinked = false;
  try {
    const destinationInfo = await lstat(destination);
    if (destinationInfo.isSymbolicLink()) {
      const linked = resolve(dirname(destination), await readlink(destination));
      alreadyLinked = await realpath(linked).then((value) => value === source).catch(() => false);
    }
    if (!alreadyLinked) await rm(destination, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!alreadyLinked) await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
  process.stdout.write(`${skillName}: ${destination} -> ${source}\n`);
}

process.stdout.write("Local DeepSeek skills are linked. Start a new Codex task to reload them.\n");
