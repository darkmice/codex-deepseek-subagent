// Managed by the DeepSeek Subagent Codex plugin.
import { lstat, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeNativeCleanupSupport, removeNativeIntegration, validateLegacyCredentialHelper, withNativeMutationLock } from "./native-config.mjs";

const settingsDir = dirname(fileURLToPath(import.meta.url));
const settingsFile = join(settingsDir, "settings.json");
const lockFile = join(settingsDir, ".router.lock");
const managedScripts = [
  fileURLToPath(import.meta.url),
  join(settingsDir, "native-config.mjs"),
  join(settingsDir, "runtime.mjs"),
];

async function validateOwnedRegularFile(path, { settings = false, managedScript = false } = {}) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`Refusing to delete a non-regular or multiply linked DeepSeek file: ${path}`);
    }
    if (settings) {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (![1, 2].includes(value?.schemaVersion) || !Number.isInteger(value?.revision) || value.revision < 0 ||
          typeof value?.model !== "string" || !(value.apiKey === null || typeof value.apiKey === "string")) {
        throw new Error(`Refusing to delete an unrecognized DeepSeek settings file: ${path}`);
      }
    }
    if (managedScript && !(await readFile(path, "utf8")).startsWith("// Managed by the DeepSeek Subagent Codex plugin.\n")) {
      throw new Error(`Refusing to delete an unmanaged DeepSeek cleanup support file: ${path}`);
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

await withNativeMutationLock(settingsDir, async () => {
  const settingsExists = await validateOwnedRegularFile(settingsFile, { settings: true });
  const routerLockExists = await validateOwnedRegularFile(lockFile);
  const scriptStates = await Promise.all(managedScripts.map((path) => validateOwnedRegularFile(path, { managedScript: true })));
  if (scriptStates.some((exists) => !exists)) throw new Error("DeepSeek cleanup support files are incomplete; refusing partial cleanup.");
  await validateLegacyCredentialHelper(settingsDir);
  await removeNativeIntegration(settingsDir, { deferMacCleanup: false, keepCleanupSupport: true });
  if (settingsExists) await rm(settingsFile);
  if (routerLockExists) await rm(lockFile);
  await removeNativeCleanupSupport(settingsDir);
});
await rmdir(settingsDir).catch((error) => {
  if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
});
process.stdout.write("DeepSeek Subagent native routing, credential, and managed local files were removed. Start a new Codex task.\n");
