import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.DEEPSEEK_SUBAGENT_CLEANUP_DELAY_MS = "100";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { installRuntimeRouter, removeRuntimeRouter, runtimeExecutionMode, runtimePaths, runtimeRouterStatus } =
  await import("../plugins/deepseek-subagent/scripts/runtime.mjs");

const upstream = createServer(async (request, response) => {
  for await (const _chunk of request) {}
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true}');
});
await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
const upstreamPort = upstream.address().port;

async function waitForMissing(path, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { await access(path); }
    catch { return; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} was not removed.`);
}

async function waitForStopped(runtime, label) {
  const url = `http://127.0.0.1:${runtime.port}/${runtime.routeToken}/healthz`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(150) });
      const health = response.ok ? await response.json() : null;
      if (health?.instanceId !== runtime.instanceId) return;
    }
    catch { return; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} did not stop.`);
}

async function waitForRestarted(runtime, previousRouterPid, label) {
  const url = `http://127.0.0.1:${runtime.port}/${runtime.routeToken}/healthz`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(150) });
      const health = response.ok ? await response.json() : null;
      if (health?.instanceId === runtime.instanceId && health.routerPid !== previousRouterPid) return health;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} was not restarted by its detached host.`);
}

async function initializeSettingsServer(settingsDir, settingsFile, codexHome, platform) {
  const child = spawn(process.execPath, [join(root, "plugins/deepseek-subagent/scripts/server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CODEX_HOME: codexHome,
      DEEPSEEK_SUBAGENT_CONFIG_DIR: settingsDir,
      DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE: settingsFile,
      DEEPSEEK_SUBAGENT_TEST_PLATFORM: platform,
      DEEPSEEK_SUBAGENT_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const initialized = new Promise((resolveInitialized, rejectInitialized) => {
    let stdout = "";
    const timer = setTimeout(() => rejectInitialized(new Error(`Settings initialization timed out: ${stderr}`)), 8_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolveInitialized(JSON.parse(stdout.slice(0, newline)));
    });
    child.once("error", (error) => { clearTimeout(timer); rejectInitialized(error); });
    child.once("exit", (code, signal) => {
      if (!stdout.includes("\n")) {
        clearTimeout(timer);
        rejectInitialized(new Error(`Settings server exited before initialization (${code ?? signal}): ${stderr}`));
      }
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  try {
    const response = await initialized;
    assert.equal(response.result.serverInfo.name, "deepseek-settings");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolveClose, rejectClose) => {
        const timer = setTimeout(() => rejectClose(new Error("Settings server did not stop within 5 seconds.")), 5_000);
        const finish = () => { clearTimeout(timer); resolveClose(); };
        child.once("close", finish);
        child.once("error", (error) => { clearTimeout(timer); rejectClose(error); });
        if (child.exitCode !== null || child.signalCode !== null) finish();
        else child.kill("SIGTERM");
      });
    }
  }
}

async function exercise(platform) {
  const temp = await mkdtemp(join(tmpdir(), `deepseek-${platform}-detached-`));
  const settingsDir = join(temp, "settings");
  const settingsFile = join(settingsDir, "settings.json");
  const codexHome = join(temp, "codex-home");
  process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE = settingsFile;
  process.env.DEEPSEEK_SUBAGENT_TEST_PLATFORM = platform;
  const paths = runtimePaths(settingsDir, codexHome);
  const originalConfig = `model = "gpt-parent"
model_provider = "custom"

[features.multi_agent_v2]
enabled = true

[model_providers.custom]
name = "detached parent"
base_url = "http://127.0.0.1:${upstreamPort}/parent/v1/"
requires_openai_auth = true
wire_api = "responses"
`;
  const install = () => installRuntimeRouter({
    paths,
    routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
    nodeExecutable: process.execPath,
    selectedModel: "deepseek-flash",
    deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
  });

  try {
    assert.equal(runtimeExecutionMode(paths), "detached");
    assert.equal(paths.launchAgentFile, join(settingsDir, ".router-service-placeholder"));
    await mkdir(settingsDir, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(paths.runtimeModuleFile, await readFile(join(root, "plugins/deepseek-subagent/scripts/runtime.mjs"), "utf8"));
    await writeFile(join(settingsDir, "credential-pool.mjs"), await readFile(join(root, "plugins/deepseek-subagent/scripts/credential-pool.mjs"), "utf8"));
    await writeFile(settingsFile, `${JSON.stringify({ schemaVersion: 2, revision: 1, model: "deepseek-flash", apiKey: "test-only-key" })}\n`);
    await writeFile(paths.codexConfig, originalConfig);

    const installed = await install();
    process.stdout.write(`${platform}: installed detached router\n`);
    assert.equal(installed.runtime.executionMode, "detached");
    assert(Number.isInteger(installed.runtime.pid) && installed.runtime.pid > 0);
    assert.match(installed.runtime.instanceId, /^[a-f0-9]{48}$/);
    assert.match(installed.runtime.shutdownToken, /^[a-f0-9]{48}$/);
    assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), true);
    const health = await (await fetch(`http://127.0.0.1:${installed.runtime.port}/${installed.runtime.routeToken}/healthz`)).json();
    assert.equal(health.instanceId, installed.runtime.instanceId);
    const rejectedShutdown = await fetch(
      `http://127.0.0.1:${installed.runtime.port}/${installed.runtime.routeToken}/control/shutdown`,
      { method: "POST", headers: { authorization: "Bearer wrong-token", "content-length": "0" } },
    );
    assert.equal(rejectedShutdown.status, 403);
    const crash = await fetch(
      `http://127.0.0.1:${installed.runtime.port}/${installed.runtime.routeToken}/control/test-crash`,
      { method: "POST", headers: { authorization: `Bearer ${installed.runtime.shutdownToken}`, "content-length": "0" } },
    );
    assert.equal(crash.status, 202);
    const restartedHealth = await waitForRestarted(installed.runtime, health.routerPid, `${platform} router`);
    process.stdout.write(`${platform}: watchdog restarted router\n`);
    assert.equal(restartedHealth.instanceId, installed.runtime.instanceId);
    assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), true);

    const stopForInitialize = await fetch(
      `http://127.0.0.1:${installed.runtime.port}/${installed.runtime.routeToken}/control/shutdown`,
      { method: "POST", headers: { authorization: `Bearer ${installed.runtime.shutdownToken}`, "content-length": "0" } },
    );
    assert.equal(stopForInitialize.status, 202);
    await waitForStopped(installed.runtime, `${platform} pre-initialize router`);
    await initializeSettingsServer(settingsDir, settingsFile, codexHome, platform);
    process.stdout.write(`${platform}: settings initialization recovered router\n`);
    assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), true);

    const reinstalled = await install();
    process.stdout.write(`${platform}: replaced router\n`);
    assert.equal(reinstalled.baseUrl, installed.baseUrl);
    assert.notEqual(reinstalled.runtime.pid, installed.runtime.pid);
    assert.notEqual(reinstalled.runtime.instanceId, installed.runtime.instanceId);
    await waitForStopped(installed.runtime, `${platform} replaced router`);
    assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), true);

    await removeRuntimeRouter(paths);
    assert.equal(await readFile(paths.codexConfig, "utf8"), originalConfig);
    const duringGrace = await fetch(new URL("responses", `${reinstalled.baseUrl}/`), {
      method: "POST",
      headers: { authorization: "Bearer parent-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-parent", input: "during detached grace" }),
    });
    assert.equal(duringGrace.status, 200);
    await waitForMissing(paths.runtimeFile, `${platform} deferred runtime`);
    await waitForMissing(paths.routerFile, `${platform} deferred router`);
    await waitForStopped(reinstalled.runtime, `${platform} deferred router`);
    process.stdout.write(`${platform}: deferred cleanup completed\n`);

    await writeFile(paths.codexConfig, originalConfig);
    const beforeRollback = await install();
    process.env.DEEPSEEK_SUBAGENT_TEST_FAIL_REMOVE_AFTER_RUNTIME_FILE_ONCE = "1";
    await assert.rejects(
      removeRuntimeRouter(paths, { deferCleanup: false }),
      /Injected DeepSeek router runtime removal failure/,
    );
    const recovered = JSON.parse(await readFile(paths.runtimeFile, "utf8"));
    assert.notEqual(recovered.pid, beforeRollback.runtime.pid);
    assert.equal(await runtimeRouterStatus(paths, "deepseek-flash", `http://127.0.0.1:${upstreamPort}/deepseek/v1/`), true);
    process.stdout.write(`${platform}: failed removal rolled back\n`);

    await removeRuntimeRouter(paths, { deferCleanup: false });
    await waitForStopped(recovered, `${platform} immediate router`);
    await waitForMissing(paths.runtimeFile, `${platform} immediate runtime`);
    await waitForMissing(paths.routerFile, `${platform} immediate router file`);
    process.stdout.write(`${platform}: immediate cleanup completed\n`);
  } finally {
    await removeRuntimeRouter(paths, { deferCleanup: false }).catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
}

try {
  await exercise("linux");
  await exercise("win32");
  process.stdout.write("Linux and Windows detached router lifecycle tests passed\n");
} finally {
  upstream.closeAllConnections?.();
  await new Promise((resolveClose) => upstream.close(resolveClose));
  delete process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE;
  delete process.env.DEEPSEEK_SUBAGENT_TEST_PLATFORM;
  delete process.env.DEEPSEEK_SUBAGENT_CLEANUP_DELAY_MS;
}
