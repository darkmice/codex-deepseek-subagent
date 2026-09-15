import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, appendFile, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

process.env.DEEPSEEK_SUBAGENT_RUNTIME_MODE = "direct";
process.env.NODE_ENV = "test";
const { installRuntimeRouter, removeRuntimeRouter, runtimePaths, runtimeRouterStatus } = await import("../plugins/deepseek-subagent/scripts/runtime.mjs");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), "deepseek-runtime-cas-"));
const settingsDir = join(temp, "settings");
const codexHome = join(temp, "codex-home");
const paths = runtimePaths(settingsDir, codexHome);
process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE = paths.settingsFile;
const originalConfig = 'model = "gpt-parent"\n\n[features.multi_agent_v2]\nenabled = true\nhide_spawn_agent_metadata = false\n';

try {
  await mkdir(settingsDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(paths.settingsFile, `${JSON.stringify({ schemaVersion: 2, revision: 1, model: "deepseek-flash", apiKey: "test-key-only" })}\n`);
  await writeFile(paths.codexConfig, originalConfig);
  const routerSource = await readFile(join(root, "plugins/deepseek-subagent/scripts/router.mjs"), "utf8");
  const slowRouter = join(temp, "slow-router.mjs");
  await writeFile(slowRouter, `await new Promise((resolve) => setTimeout(resolve, 250));\n${routerSource}`);

  const installing = installRuntimeRouter({
    paths,
    routerSourceFile: slowRouter,
    nodeExecutable: process.execPath,
    selectedModel: "deepseek-flash",
    deepseekBaseUrl: "http://127.0.0.1:9/deepseek/v1/",
    parentBaseUrl: "http://127.0.0.1:9/parent/v1/",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await access(paths.runtimeFile); break; }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 5)); }
  }
  await appendFile(paths.codexConfig, "user_change_during_install = true\n");
  await assert.rejects(installing, /Codex config changed while DeepSeek routing was being/);
  assert.equal(await readFile(paths.codexConfig, "utf8"), `${originalConfig}user_change_during_install = true\n`);
  await assert.rejects(access(paths.runtimeFile));
  await assert.rejects(access(paths.routerFile));
  await installRuntimeRouter({
    paths,
    routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
    nodeExecutable: process.execPath,
    selectedModel: "deepseek-flash",
    deepseekBaseUrl: "http://127.0.0.1:9/deepseek/v1/",
    parentBaseUrl: "http://127.0.0.1:9/parent/v1/",
  });
  await access(paths.routerLockDir);
  await removeRuntimeRouter(paths);
  assert.equal(await readFile(paths.codexConfig, "utf8"), `${originalConfig}user_change_during_install = true\n`);

  await rm(paths.codexConfig);
  const absentConfigInstall = await installRuntimeRouter({
    paths,
    routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
    nodeExecutable: process.execPath,
    selectedModel: "deepseek-flash",
    deepseekBaseUrl: "http://127.0.0.1:9/deepseek/v1/",
    parentBaseUrl: "http://127.0.0.1:9/parent/v1/",
  });
  const routedConfigCreatedFromAbsent = await readFile(paths.codexConfig, "utf8");
  const runtimeBeforeFailedRemoval = await readFile(paths.runtimeFile, "utf8");
  const routerBeforeFailedRemoval = await readFile(paths.routerFile, "utf8");
  const cleanupSupportPaths = ["cleanup.mjs", "native-config.mjs", "runtime.mjs"].map((name) => join(settingsDir, name));
  await Promise.all(cleanupSupportPaths.map((path) => writeFile(path, "// Managed by the DeepSeek Subagent Codex plugin.\n")));
  const cleanupSupportSnapshots = await Promise.all(cleanupSupportPaths.map(async (path) => {
    const contents = await readFile(path, "utf8");
    const info = await lstat(path);
    return { path, exists: true, contents, mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
  }));
  await appendFile(cleanupSupportPaths[0], "// replaced after native ownership snapshot\n");
  await assert.rejects(
    removeRuntimeRouter(paths, { cleanupSupportSnapshots }),
    /cleanup support changed before runtime removal/,
  );
  assert.equal(await readFile(paths.codexConfig, "utf8"), routedConfigCreatedFromAbsent);
  assert.equal(await readFile(paths.runtimeFile, "utf8"), runtimeBeforeFailedRemoval);
  await Promise.all(cleanupSupportPaths.map((path) => rm(path)));
  process.env.DEEPSEEK_SUBAGENT_TEST_FAIL_REMOVE_AFTER_RUNTIME_FILE_ONCE = "1";
  await assert.rejects(removeRuntimeRouter(paths), /Injected DeepSeek router runtime removal failure/);
  assert.equal(await readFile(paths.codexConfig, "utf8"), routedConfigCreatedFromAbsent, "Failed removal did not restore the managed config created from an absent original.");
  assert.equal(await readFile(paths.runtimeFile, "utf8"), runtimeBeforeFailedRemoval);
  assert.equal(await readFile(paths.routerFile, "utf8"), routerBeforeFailedRemoval);
  assert.equal(await runtimeRouterStatus(
    paths, "deepseek-flash", "http://127.0.0.1:9/deepseek/v1/", "http://127.0.0.1:9/parent/v1/",
  ), true);
  assert.equal(absentConfigInstall.originalProviderId, "openai");
  await removeRuntimeRouter(paths);
  await assert.rejects(access(paths.codexConfig), /ENOENT/, "Successful removal recreated an empty config that was originally absent.");

  const productionProbe = `import { runtimeExecutionMode, runtimePaths } from ${JSON.stringify(new URL("../plugins/deepseek-subagent/scripts/runtime.mjs", import.meta.url).href)};\n` +
    `const paths=runtimePaths(${JSON.stringify(settingsDir)}, ${JSON.stringify(codexHome)});process.stdout.write(JSON.stringify({paths,mode:runtimeExecutionMode(paths)}));\n`;
  const { stdout: productionPathsText } = await execFileAsync(process.execPath, ["--input-type=module", "-e", productionProbe], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      DEEPSEEK_SUBAGENT_LAUNCH_AGENT_LABEL: "com.dark.deepseek-subagent-router.test-ignored",
      DEEPSEEK_SUBAGENT_LAUNCH_AGENTS_DIR: join(temp, "evil-launchagents"),
      DEEPSEEK_SUBAGENT_RUNTIME_MODE: "direct",
      DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE: paths.settingsFile,
    },
  });
  const productionProbeResult = JSON.parse(productionPathsText);
  const productionPaths = productionProbeResult.paths;
  assert(!productionPaths.launchAgentFile.includes("evil-launchagents"), "Production runtime honored the test LaunchAgent path override.");
  if (process.platform === "darwin") {
    assert(productionPaths.launchAgentFile.endsWith("com.dark.deepseek-subagent-router.plist"), "Production runtime honored the test LaunchAgent label override.");
  } else {
    assert.equal(productionPaths.launchAgentFile, join(settingsDir, ".router-service-placeholder"));
  }
  assert.equal(productionProbeResult.mode, process.platform === "darwin" ? "launchagent" : "detached", "Production runtime honored direct test mode.");

  process.env.CODEX_HOME = codexHome;
  await writeFile(paths.codexConfig, originalConfig);
  const { installNativeIntegration, removeNativeIntegration, withNativeMutationLock } = await import("../plugins/deepseek-subagent/scripts/native-config.mjs");
  const nativeOptions = {
    settingsDir,
    settingsFile: paths.settingsFile,
    model: "deepseek-flash",
    models: [{ id: "deepseek-flash" }],
    modelTemplateFile: join(root, "plugins/deepseek-subagent/assets/model-template.json"),
    apiBaseUrl: "http://127.0.0.1:9/deepseek/v1/",
    parentBaseUrl: "http://127.0.0.1:9/parent/v1/",
  };
  process.env.DEEPSEEK_SUBAGENT_TEST_HOLD_AFTER_SUPPORT_WRITE_MS = "200";
  process.env.DEEPSEEK_SUBAGENT_TEST_FAIL_AFTER_SUPPORT_WRITE = "1";
  const failedNativeInstall = installNativeIntegration(nativeOptions);
  const changedSupport = join(settingsDir, "cleanup.mjs");
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await access(changedSupport); break; } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 5)); }
  }
  await writeFile(changedSupport, "// externally replaced during native install\n");
  await assert.rejects(failedNativeInstall, /rollback was incomplete|could not be rolled back safely/);
  assert.equal(await readFile(changedSupport, "utf8"), "// externally replaced during native install\n", "Install rollback overwrote a concurrent support-file replacement.");
  delete process.env.DEEPSEEK_SUBAGENT_TEST_HOLD_AFTER_SUPPORT_WRITE_MS;
  delete process.env.DEEPSEEK_SUBAGENT_TEST_FAIL_AFTER_SUPPORT_WRITE;
  await rm(changedSupport);
  await removeNativeIntegration(settingsDir, { deferMacCleanup: false }).catch(() => {});

  const ownerlessLock = join(settingsDir, ".mutation.lock");
  process.env.DEEPSEEK_SUBAGENT_TEST_MUTATION_STALE_MS = "80";
  process.env.DEEPSEEK_SUBAGENT_TEST_MUTATION_ACQUIRE_TIMEOUT_MS = "400";
  await mkdir(ownerlessLock, { mode: 0o700 });
  const staleOwnerlessTime = new Date(Date.now() - 5_000);
  await utimes(ownerlessLock, staleOwnerlessTime, staleOwnerlessTime);
  await withNativeMutationLock(settingsDir, async () => {
    const owner = JSON.parse(await readFile(join(ownerlessLock, "owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid, "A stale ownerless lock was not replaced by the current owner.");
  });
  await assert.rejects(access(ownerlessLock), /ENOENT/, "The reclaimed ownerless mutation lock remained after release.");

  await mkdir(ownerlessLock, { mode: 0o700 });
  const malformedOwner = join(ownerlessLock, "owner.json");
  await writeFile(malformedOwner, '{"schemaVersion":1,"pid":');
  const staleMalformedTime = new Date(Date.now() - 5_000);
  await utimes(malformedOwner, staleMalformedTime, staleMalformedTime);
  await utimes(ownerlessLock, staleMalformedTime, staleMalformedTime);
  await withNativeMutationLock(settingsDir, async () => {
    const owner = JSON.parse(await readFile(malformedOwner, "utf8"));
    assert.equal(owner.pid, process.pid, "A stale partial mutation-lock owner was not safely replaced.");
  });
  await assert.rejects(access(ownerlessLock), /ENOENT/, "The reclaimed malformed mutation lock remained after release.");

  await mkdir(ownerlessLock, { mode: 0o700 });
  const freshOwnerlessCreatedAt = Date.now();
  let acquiredFreshOwnerlessAt = 0;
  await withNativeMutationLock(settingsDir, async () => { acquiredFreshOwnerlessAt = Date.now(); });
  assert(
    acquiredFreshOwnerlessAt - freshOwnerlessCreatedAt >= 70,
    "A fresh ownerless mutation lock was reclaimed before its stale window elapsed.",
  );

  const nativeConfigUrl = new URL("../plugins/deepseek-subagent/scripts/native-config.mjs", import.meta.url).href;
  const lockHolderSource = `
    const { withNativeMutationLock } = await import(${JSON.stringify(nativeConfigUrl)});
    await withNativeMutationLock(${JSON.stringify(settingsDir)}, async () => {
      process.stdout.write("locked\\n");
      process.stdin.resume();
      await new Promise((resolveRelease) => process.stdin.once("data", resolveRelease));
    });
  `;
  const spawnLockHolder = () => spawn(process.execPath, ["--input-type=module", "-e", lockHolderSource], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE: paths.settingsFile,
      DEEPSEEK_SUBAGENT_TEST_MUTATION_STALE_MS: "80",
      DEEPSEEK_SUBAGENT_TEST_MUTATION_ACQUIRE_TIMEOUT_MS: "400",
      DEEPSEEK_SUBAGENT_TEST_DISABLE_MUTATION_HEARTBEAT: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waitForLockHolder = (holder) => new Promise((resolveReady, rejectReady) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => rejectReady(new Error(`Mutation lock holder did not start: ${errors}`)), 3_000);
    holder.stderr.setEncoding("utf8");
    holder.stderr.on("data", (chunk) => { errors += chunk; });
    holder.stdout.setEncoding("utf8");
    holder.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("locked\n")) return;
      clearTimeout(timer);
      resolveReady();
    });
    holder.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
    holder.once("exit", (code, signal) => {
      if (!output.includes("locked\n")) {
        clearTimeout(timer);
        rejectReady(new Error(`Mutation lock holder exited before acquiring the lock (${code ?? signal}): ${errors}`));
      }
    });
  });
  const waitForSuccessfulExit = (holder, label) => new Promise((resolveExit, rejectExit) => {
    holder.once("error", rejectExit);
    holder.once("exit", (code, signal) => signal || code !== 0
      ? rejectExit(new Error(`${label} mutation lock holder failed (${code ?? signal}).`))
      : resolveExit());
  });

  process.env.DEEPSEEK_SUBAGENT_TEST_MUTATION_ACQUIRE_TIMEOUT_MS = "80";
  process.env.DEEPSEEK_SUBAGENT_TEST_DISABLE_MUTATION_HEARTBEAT = "1";
  const liveHolder = spawnLockHolder();
  await waitForLockHolder(liveHolder);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  await assert.rejects(
    withNativeMutationLock(settingsDir, async () => {}),
    /busy in another Codex task/,
    "A live mutation-lock owner was reclaimed only because its heartbeat was stale.",
  );
  const liveHolderExit = waitForSuccessfulExit(liveHolder, "Live");
  liveHolder.stdin.end("release\n");
  await liveHolderExit;
  await withNativeMutationLock(settingsDir, async () => {});

  process.env.DEEPSEEK_SUBAGENT_TEST_MUTATION_ACQUIRE_TIMEOUT_MS = "400";
  const deadHolder = spawnLockHolder();
  await waitForLockHolder(deadHolder);
  const deadHolderExit = new Promise((resolveExit) => deadHolder.once("exit", resolveExit));
  deadHolder.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
  await deadHolderExit;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  await withNativeMutationLock(settingsDir, async () => {
    const owner = JSON.parse(await readFile(join(ownerlessLock, "owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid, "A dead stale mutation-lock owner was not safely replaced.");
  });
  delete process.env.DEEPSEEK_SUBAGENT_TEST_MUTATION_STALE_MS;
  delete process.env.DEEPSEEK_SUBAGENT_TEST_MUTATION_ACQUIRE_TIMEOUT_MS;
  delete process.env.DEEPSEEK_SUBAGENT_TEST_DISABLE_MUTATION_HEARTBEAT;
  process.stdout.write("Runtime config CAS and rollback test passed\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
