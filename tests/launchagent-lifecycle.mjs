import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, appendFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.stdout.write("LaunchAgent lifecycle test skipped outside macOS\n");
  process.exit(0);
}

process.env.NODE_ENV = "test";
const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(join(tmpdir(), "deepseek-launchagent-test-"));
const label = `com.dark.deepseek-subagent-router.test-${process.pid}-${Date.now()}`;
process.env.DEEPSEEK_SUBAGENT_LAUNCH_AGENT_LABEL = label;
process.env.DEEPSEEK_SUBAGENT_LAUNCH_AGENTS_DIR = join(temp, "LaunchAgents");
process.env.DEEPSEEK_SUBAGENT_CLEANUP_DELAY_MS = "1000";
const { installRuntimeRouter, removeRuntimeRouter, runtimeCleanupStatus, runtimePaths, runtimeRouterStatus } = await import("../plugins/deepseek-subagent/scripts/runtime.mjs");
const { installNativeIntegration, nativeIntegrationStatus, reconcileNativeCleanup, removeNativeIntegration } = await import("../plugins/deepseek-subagent/scripts/native-config.mjs");

const codexHome = join(temp, "codex-home");
const settingsDir = join(temp, "settings");
process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE = join(settingsDir, "settings.json");
const paths = runtimePaths(settingsDir, codexHome);
const requests = [];
const upstream = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push({ authorization: request.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true}');
});
await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
const upstreamPort = upstream.address().port;
const target = `gui/${userInfo().uid}/${label}`;
const runtimeLockHeld = async () => {
  try {
    await execFileAsync("/usr/bin/lockf", ["-k", "-s", "-t", "0", paths.routerLockDir, "/usr/bin/true"], { timeout: 2_000 });
    return false;
  } catch (error) {
    if (error?.code === 75) return true;
    throw error;
  }
};

try {
  await mkdir(codexHome, { recursive: true });
  await mkdir(settingsDir, { recursive: true });
  await writeFile(join(settingsDir, "credential-pool.mjs"), await readFile(join(root, "plugins/deepseek-subagent/scripts/credential-pool.mjs"), "utf8"));
  const originalConfig = `model = "gpt-parent"
model_provider = "custom"

[features.multi_agent_v2]
enabled = true
hide_spawn_agent_metadata = false

[model_providers.custom]
name = "lifecycle parent"
base_url = "http://127.0.0.1:${upstreamPort}/parent/v1/"
requires_openai_auth = true
wire_api = "responses"
`;
  await writeFile(paths.codexConfig, originalConfig);
  await writeFile(paths.settingsFile, `${JSON.stringify({ schemaVersion: 2, revision: 1, model: "deepseek-flash", apiKey: null })}\n`);
  await mkdir(dirname(paths.launchAgentFile), { recursive: true });
  await writeFile(paths.launchAgentFile, "unmanaged LaunchAgent fixture\n");
  await assert.rejects(
    installRuntimeRouter({
      paths,
      routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
      nodeExecutable: process.execPath,
      selectedModel: "deepseek-flash",
      deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
    }),
    /unmanaged LaunchAgent/,
  );
  assert.equal(await readFile(paths.launchAgentFile, "utf8"), "unmanaged LaunchAgent fixture\n");
  assert.equal(await readFile(paths.codexConfig, "utf8"), originalConfig);
  await rm(paths.launchAgentFile);
  await execFileAsync("launchctl", ["submit", "-l", label, "--", "/bin/sleep", "60"], { timeout: 10_000 });
  await assert.rejects(
    installRuntimeRouter({
      paths,
      routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
      nodeExecutable: process.execPath,
      selectedModel: "deepseek-flash",
      deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
    }),
    /unverified LaunchAgent service/,
  );
  assert.equal(await readFile(paths.codexConfig, "utf8"), originalConfig);
  await execFileAsync("launchctl", ["bootout", target], { timeout: 10_000 });
  const installed = await installRuntimeRouter({
    paths,
    routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
    nodeExecutable: process.execPath,
    selectedModel: "deepseek-flash",
    deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
  });
  const ownedPlist = await readFile(paths.launchAgentFile, "utf8");
  assert(ownedPlist.includes("DeepSeekSubagentOwner"));
  assert.equal(JSON.parse(await readFile(paths.runtimeFile, "utf8")).nodeExecutable, process.execPath);
  assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), true);
  await writeFile(paths.launchAgentFile, ownedPlist.replace(/^<key>DeepSeekSubagentOwner<\/key><string>[^<]+<\/string>\n/m, ""));
  await installRuntimeRouter({
    paths,
    routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
    nodeExecutable: process.execPath,
    selectedModel: "deepseek-flash",
    deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
  });
  assert((await readFile(paths.launchAgentFile, "utf8")).includes("DeepSeekSubagentOwner"));
  await appendFile(paths.launchAgentFile, "<!-- drift -->\n");
  assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), false);
  await assert.rejects(
    installRuntimeRouter({
      paths,
      routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
      nodeExecutable: process.execPath,
      selectedModel: "deepseek-flash",
      deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
    }),
    /unmanaged LaunchAgent/,
  );
  assert((await readFile(paths.launchAgentFile, "utf8")).endsWith("<!-- drift -->\n"));
  await writeFile(paths.launchAgentFile, ownedPlist);
  await installRuntimeRouter({
      paths,
      routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
      nodeExecutable: process.execPath,
      selectedModel: "deepseek-flash",
      deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
    });
  assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), true);
  const response = await fetch(new URL("responses", `${installed.baseUrl}/`), {
    method: "POST",
    headers: { authorization: "Bearer parent-test-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-parent", input: "before remove" }),
  });
  assert.equal(response.status, 200);

  await removeRuntimeRouter(paths);
  assert.equal(await readFile(paths.codexConfig, "utf8"), originalConfig);
  const duringGrace = await fetch(new URL("responses", `${installed.baseUrl}/`), {
    method: "POST",
    headers: { authorization: "Bearer parent-test-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-parent", input: "during grace" }),
  });
  assert.equal(duringGrace.status, 200);
  assert.equal(requests.length, 2);

  process.env.DEEPSEEK_SUBAGENT_TEST_FAIL_BOOTSTRAP_ONCE = label;
  await assert.rejects(
    installRuntimeRouter({
      paths,
      routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
      nodeExecutable: process.execPath,
      selectedModel: "deepseek-flash",
      deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
    }),
    /Injected LaunchAgent bootstrap failure/,
  );
  await assert.rejects(access(paths.launchAgentFile));
  assert.equal((await fetch(`http://127.0.0.1:${installed.runtime.port}/${installed.runtime.routeToken}/healthz`)).status, 200);
  assert.equal(await readFile(paths.codexConfig, "utf8"), originalConfig);

  const reinstalled = await installRuntimeRouter({
    paths,
    routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
    nodeExecutable: process.execPath,
    selectedModel: "deepseek-flash",
    deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
  });
  assert.equal(reinstalled.baseUrl, installed.baseUrl);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_400));
  assert.equal((await fetch(`http://127.0.0.1:${reinstalled.runtime.port}/${reinstalled.runtime.routeToken}/healthz`)).status, 200);
  await access(paths.runtimeFile);

  process.env.DEEPSEEK_SUBAGENT_CLEANUP_DELAY_MS = "0";
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_HOLD_LOCK_MS = "300";
  await removeRuntimeRouter(paths);
  let cleanupLockObserved = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await runtimeLockHeld()) { cleanupLockObserved = true; break; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert(cleanupLockObserved, "Deferred cleanup did not acquire the shared runtime mutation lock.");
  const reinstalledDuringCleanup = await installRuntimeRouter({
    paths,
    routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
    nodeExecutable: process.execPath,
    selectedModel: "deepseek-flash",
    deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
  });
  delete process.env.DEEPSEEK_SUBAGENT_CLEANUP_HOLD_LOCK_MS;
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_DELAY_MS = "200";
  assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), true);
  assert.equal((await fetch(`http://127.0.0.1:${reinstalledDuringCleanup.runtime.port}/${reinstalledDuringCleanup.runtime.routeToken}/healthz`)).status, 200);

  await assert.rejects(
    removeRuntimeRouter(paths, { cleanupExecutable: join(temp, "missing-cleanup-node") }),
    /Unable to schedule deferred DeepSeek router cleanup/,
  );
  assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), true);
  await access(paths.launchAgentFile);

  const beforeInjectedRemoval = new Map(await Promise.all([
    paths.codexConfig, paths.routerFile, paths.runtimeFile, paths.launchAgentFile,
  ].map(async (path) => [path, await readFile(path, "utf8")])));
  process.env.DEEPSEEK_SUBAGENT_TEST_FAIL_REMOVE_AFTER_RUNTIME_FILE_ONCE = "1";
  await assert.rejects(
    removeRuntimeRouter(paths, { deferMacCleanup: false }),
    /Injected DeepSeek router runtime removal failure/,
  );
  for (const [path, contents] of beforeInjectedRemoval) {
    assert.equal(await readFile(path, "utf8"), contents, `LaunchAgent removal rollback did not restore ${path}.`);
  }
  assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), true);
  assert.equal((await fetch(`http://127.0.0.1:${reinstalledDuringCleanup.runtime.port}/${reinstalledDuringCleanup.runtime.routeToken}/healthz`)).status, 200);

  const cleanupSupportPaths = ["cleanup.mjs", "native-config.mjs", "runtime.mjs", "credential-pool.mjs"].map((name) => join(settingsDir, name));
  await Promise.all(cleanupSupportPaths.map((path) => writeFile(path, "// Managed by the DeepSeek Subagent Codex plugin.\n")));
  const cleanupSupportSnapshots = await Promise.all(cleanupSupportPaths.map(async (path) => {
    const contents = await readFile(path, "utf8");
    const info = await lstat(path);
    return { path, exists: true, contents, mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
  }));
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_DELAY_MS = "0";
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_RETRY_DELAY_MS = "500";
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_MAX_ATTEMPTS = "3";
  process.env.DEEPSEEK_SUBAGENT_TEST_DEFERRED_FAIL_ONCE = target;
  await removeRuntimeRouter(paths, { cleanupSupportSnapshots });
  assert.equal(await readFile(paths.codexConfig, "utf8"), originalConfig);
  await assert.rejects(access(paths.launchAgentFile));

  let retryObserved = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const cleanupState = JSON.parse(await readFile(paths.runtimeFile, "utf8"));
      if (cleanupState.cleanupStatus === "retrying" && cleanupState.cleanupAttempts === 1 && cleanupState.cleanupFailureCode === "injected_failure") {
        retryObserved = true;
        break;
      }
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert(retryObserved, "Deferred cleanup did not expose its retry state after an injected worker failure.");
  for (const path of cleanupSupportPaths) await access(path);

  let cleaned = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const remaining = await Promise.all([paths.runtimeFile, paths.routerFile, ...cleanupSupportPaths].map(async (path) => {
      try { await access(path); return true; } catch { return false; }
    }));
    if (remaining.every((exists) => !exists)) { cleaned = true; break; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert(cleaned, "Deferred LaunchAgent cleanup did not converge runtime, router, and cleanup support files.");

  await writeFile(join(settingsDir, "credential-pool.mjs"), await readFile(join(root, "plugins/deepseek-subagent/scripts/credential-pool.mjs"), "utf8"));
  await installRuntimeRouter({
    paths,
    routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
    nodeExecutable: process.execPath,
    selectedModel: "deepseek-flash",
    deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
  });
  await Promise.all(cleanupSupportPaths.map((path) => writeFile(path, "// Managed by the DeepSeek Subagent Codex plugin.\n")));
  const retryableSupportSnapshots = await Promise.all(cleanupSupportPaths.map(async (path) => {
    const contents = await readFile(path, "utf8");
    const info = await lstat(path);
    return { path, exists: true, contents, mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
  }));
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_MAX_ATTEMPTS = "2";
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_RETRY_DELAY_MS = "100";
  process.env.DEEPSEEK_SUBAGENT_TEST_DEFERRED_ALWAYS_FAIL = target;
  await removeRuntimeRouter(paths, { cleanupSupportSnapshots: retryableSupportSnapshots });
  let exhaustedFailureObserved = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const cleanupState = JSON.parse(await readFile(paths.runtimeFile, "utf8"));
    if (cleanupState.cleanupStatus === "failed" && cleanupState.cleanupAttempts === 2 &&
        cleanupState.cleanupFailureCode === "injected_persistent_failure") {
      exhaustedFailureObserved = true;
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert(exhaustedFailureObserved, "Exhausted deferred cleanup did not expose a terminal failed state.");
  for (const path of [paths.runtimeFile, paths.routerFile, ...cleanupSupportPaths]) await access(path);
  delete process.env.DEEPSEEK_SUBAGENT_TEST_DEFERRED_ALWAYS_FAIL;
  await removeRuntimeRouter(paths, { deferMacCleanup: false, cleanupSupportSnapshots: retryableSupportSnapshots });
  for (const path of [paths.runtimeFile, paths.routerFile, ...cleanupSupportPaths]) await assert.rejects(access(path));
  assert.equal(await readFile(paths.codexConfig, "utf8"), originalConfig);
  await assert.rejects(fetch(`http://127.0.0.1:${installed.runtime.port}/${installed.runtime.routeToken}/healthz`));

  const nativeOptions = {
    settingsDir,
    settingsFile: paths.settingsFile,
    model: "deepseek-flash",
    models: [{ id: "deepseek-flash" }],
    modelTemplateFile: join(root, "plugins/deepseek-subagent/assets/model-template.json"),
    apiBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
  };
  process.env.CODEX_HOME = codexHome;
  await installNativeIntegration(nativeOptions);
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_DELAY_MS = "250";
  await removeNativeIntegration(settingsDir);
  await installNativeIntegration(nativeOptions);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  for (const path of cleanupSupportPaths) await access(path);
  assert.equal((await nativeIntegrationStatus(settingsDir, "deepseek-flash", nativeOptions.apiBaseUrl)).ready, true,
    "A stale deferred worker damaged the newer native integration generation.");

  process.env.DEEPSEEK_SUBAGENT_CLEANUP_DELAY_MS = "250";
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_LOCK_TIMEOUT_MS = "0";
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_MAX_ATTEMPTS = "2";
  process.env.DEEPSEEK_SUBAGENT_CLEANUP_RETRY_DELAY_MS = "50";
  await removeNativeIntegration(settingsDir);
  const scheduledCleanup = JSON.parse(await readFile(paths.runtimeFile, "utf8"));
  await writeFile(paths.settingsFile, `${JSON.stringify({ schemaVersion: 2, revision: 2, model: "", apiKey: null })}\n`);
  const beforeDeadline = await reconcileNativeCleanup(settingsDir, scheduledCleanup.cleanupDeadlineAt - 1);
  assert.equal(beforeDeadline.reconciled, false, "Reconciliation ended an unexpired grace period.");
  await access(paths.runtimeFile);
  const mutationLock = join(settingsDir, ".mutation.lock");
  await mkdir(mutationLock, { mode: 0o700 });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
  const rawAfterLockExhaustion = JSON.parse(await readFile(paths.runtimeFile, "utf8"));
  assert.equal(rawAfterLockExhaustion.cleanupStatus, "scheduled", "A worker without the runtime lock unsafely rewrote cleanup state.");
  const derivedFailure = await runtimeCleanupStatus(paths, scheduledCleanup.cleanupDeadlineAt + 1);
  assert.equal(derivedFailure.status, "failed");
  assert.equal(derivedFailure.failureCode, "deadline_exceeded");
  await rm(mutationLock, { recursive: true });
  const afterDeadline = await reconcileNativeCleanup(settingsDir, scheduledCleanup.cleanupDeadlineAt + 1);
  assert.equal(afterDeadline.reconciled, true, "Expired deferred cleanup was not reconciled after restart.");
  for (const path of [paths.runtimeFile, paths.routerFile, ...cleanupSupportPaths]) await assert.rejects(access(path));

  await writeFile(paths.launchAgentFile, "unmanaged removal fixture\n");
  await assert.rejects(removeRuntimeRouter(paths), /unmanaged LaunchAgent/);
  assert.equal(await readFile(paths.launchAgentFile, "utf8"), "unmanaged removal fixture\n");
  assert.equal(await readFile(paths.codexConfig, "utf8"), originalConfig);
  await rm(paths.launchAgentFile);
  process.stdout.write("LaunchAgent lifecycle and parent grace-period tests passed\n");
} finally {
  await execFileAsync("launchctl", ["bootout", target], { timeout: 10_000 }).catch(() => {});
  upstream.close();
  await rm(temp, { recursive: true, force: true });
}
