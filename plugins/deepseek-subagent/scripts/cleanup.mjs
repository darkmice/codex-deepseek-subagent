// Managed by the DeepSeek Subagent Codex plugin.
import { lstat, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeNativeCleanupSupport, removeNativeIntegration, validateLegacyCredentialHelper, withNativeMutationLock } from "./native-config.mjs";
import { credentialsFromSettingsDocument, DEFAULT_DEEPSEEK_BASE_URL } from "./credential-pool.mjs";

const settingsDir = dirname(fileURLToPath(import.meta.url));
const settingsFile = join(settingsDir, "settings.json");
const lockFile = join(settingsDir, ".router.lock");
const managedScripts = [
  fileURLToPath(import.meta.url),
  join(settingsDir, "native-config.mjs"),
  join(settingsDir, "runtime.mjs"),
  join(settingsDir, "credential-pool.mjs"),
];

async function validateOwnedRegularFile(path, { settings = false, managedScript = false } = {}) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`Refusing to delete a non-regular or multiply linked DeepSeek file: ${path}`);
    }
    if (settings) {
      const value = JSON.parse(await readFile(path, "utf8"));
      try { credentialsFromSettingsDocument(value, { defaultBaseUrl: DEFAULT_DEEPSEEK_BASE_URL }); }
      catch { throw new Error(`Refusing to delete an unrecognized DeepSeek settings file: ${path}`); }
    }
    if (managedScript && !/^\/\/ Managed by the DeepSeek Subagent Codex plugin\.\r?\n/.test(await readFile(path, "utf8"))) {
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
  await removeNativeIntegration(settingsDir, { deferCleanup: false, keepCleanupSupport: true });
  if (settingsExists) await rm(settingsFile);
  if (routerLockExists) await rm(lockFile);
  await removeNativeCleanupSupport(settingsDir);
});
await rmdir(settingsDir).catch((error) => {
  if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
});
process.stdout.write("DeepSeek Subagent native routing, credential, and managed local files were removed. Start a new Codex task.\n");
