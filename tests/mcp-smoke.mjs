import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_NATIVE_CREDENTIAL_SOURCE } from "../plugins/deepseek-subagent/scripts/native-config.mjs";
import { removeRuntimeRouter, runtimePaths } from "../plugins/deepseek-subagent/scripts/runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(join(tmpdir(), "deepseek-subagent-test-"));
const codexHome = join(temp, "codex-home");
const fakeKey = "not-a-real-secret-for-tests";
let modelRequests = 0;
let responsesRequests = 0;
let lastResponsesPayload = null;
const api = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${fakeKey}`) {
    response.writeHead(401).end(); return;
  }
  if (request.url === "/v1/responses" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    assert(["deepseek-mock-a", "deepseek-mock-b"].includes(payload.model));
    lastResponsesPayload = payload;
    responsesRequests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: `response-${responsesRequests}`, status: "completed", output: [] }));
    return;
  }
  if (request.url !== "/v1/models" || request.method !== "GET") {
    response.writeHead(404).end(); return;
  }
  modelRequests++;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ data: [{ id: "deepseek-mock-a", owned_by: "mock" }, { id: "deepseek-mock-b" }, { id: "not-deepseek" }] }));
});
await new Promise((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
const port = api.address().port;
const child = spawn(process.execPath, [join(root, "plugins/deepseek-subagent/scripts/server.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    DEEPSEEK_SUBAGENT_CONFIG_DIR: temp,
    DEEPSEEK_SUBAGENT_API_BASE_URL: `http://127.0.0.1:${port}/v1/`,
    DEEPSEEK_SUBAGENT_RUNTIME_MODE: "direct",
    DEEPSEEK_SUBAGENT_TEST_FAIL_REMOVE_AFTER_RUNTIME_FILE_ONCE: "1",
    DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE: join(temp, "settings.json"),
    NODE_ENV: "test",
    CODEX_HOME: codexHome,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "", stdoutAll = "", buffer = "", nextId = 1;
const pending = new Map();
child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => {
  stdoutAll += chunk; buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n"); if (newline < 0) break;
    const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
    pending.get(message.id)?.(message); pending.delete(message.id);
  }
});
function rpc(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolveRpc, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
    pending.set(id, (message) => { clearTimeout(timer); resolveRpc(message); });
  });
}
try {
  await mkdir(codexHome, { recursive: true });
  const skillContract = await readFile(join(root, "plugins/deepseek-subagent/skills/deepseek-subagent/SKILL.md"), "utf8");
  assert.match(skillContract, /Call `deepseek_delegation_prepare` first/);
  assert.match(skillContract, /Do not call `deepseek_settings` before a\s+normal delegation/);
  assert.match(skillContract, /If preparation reports that\s+setup is missing or not ready/);
  assert.doesNotMatch(skillContract, /^1\. Read `deepseek_settings`/m);
  assert.match(skillContract, /FINAL_ANSWER[\s\S]*do not\s+call `wait_agent`/);
  assert.match(skillContract, /timeout means only that no new mailbox event arrived/);
  assert.match(skillContract, /Read the matching task\s+with `list_agents`/);
  const originalCodexConfig = "[features.multi_agent_v2]\nenabled = true\nhide_spawn_agent_metadata = false\n\n[other]\nsetting = true\n";
  await writeFile(join(codexHome, "config.toml"), originalCodexConfig, "utf8");
  assert.equal((await rpc("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "deepseek-settings");
  const listed = (await rpc("tools/list")).result.tools;
  assert(listed.some((tool) => tool.name === "deepseek_models_list"));
  assert(listed.some((tool) => tool.name === "deepseek_delegation_prepare"));
  const prepareTool = listed.find((tool) => tool.name === "deepseek_delegation_prepare");
  assert.equal(prepareTool._meta?.ui?.resourceUri, undefined);
  assert.equal(prepareTool._meta?.["openai/outputTemplate"], undefined);
  assert.match(listed.find((tool) => tool.name === "deepseek_settings").description, /Never use this tool as a routine delegation readiness check/);
  assert(!listed.some((tool) => ["analyze", "implement"].includes(tool.name)));
  assert(!JSON.stringify(listed).includes("deepseek-mock-a"));
  assert(!JSON.stringify(listed).includes("deepseek-chat"));
  const resources = (await rpc("resources/list")).result.resources;
  assert.equal(resources[0].uri, "ui://deepseek-subagent/settings/v4.html");
  for (const uri of ["ui://deepseek-subagent/settings/v1.html", "ui://deepseek-subagent/settings/v2.html", "ui://deepseek-subagent/settings/v3.html", "ui://deepseek-subagent/settings/v4.html"]) {
    const read = await rpc("resources/read", { uri });
    assert.equal(read.result.contents[0].uri, uri);
    assert(read.result.contents[0].text.includes("ui/initialize"));
  }
  let result = (await rpc("tools/call", { name: "deepseek_settings", arguments: {} })).result;
  assert.equal(result.structuredContent.credentialConfigured, false);
  await writeFile(join(temp, "settings.json"), "{invalid-json", "utf8");
  result = (await rpc("tools/call", { name: "deepseek_settings", arguments: {} })).result;
  assert.equal(result.isError, true);
  assert.equal(result._meta.deepseekSubagentError.code, "SETTINGS_INVALID");
  await rm(join(temp, "settings.json"));
  const concurrentWrites = await Promise.all([
    rpc("tools/call", { name: "deepseek_credential_set", arguments: { expectedRevision: 0, apiKey: fakeKey } }),
    rpc("tools/call", { name: "deepseek_credential_set", arguments: { expectedRevision: 0, apiKey: fakeKey } }),
  ]);
  assert.equal(concurrentWrites.filter((message) => message.result?.isError).length, 1);
  result = concurrentWrites.find((message) => !message.result?.isError).result;
  assert.equal(result.structuredContent.credentialMask, "••••••••");
  assert(!JSON.stringify(result).includes(fakeKey));
  result = (await rpc("tools/call", { name: "deepseek_models_list", arguments: { force: true } })).result;
  assert.deepEqual(result.structuredContent.models.map((model) => model.id), ["deepseek-mock-a", "deepseek-mock-b", "deepseek-flash"]);
  const configPath = join(codexHome, "config.toml");
  const linkedConfig = join(codexHome, "linked-config.toml");
  const legacyCredentialHelper = join(temp, "native-credential.mjs");
  await writeFile(legacyCredentialHelper, LEGACY_NATIVE_CREDENTIAL_SOURCE, { mode: 0o600 });
  await writeFile(linkedConfig, originalCodexConfig);
  await rm(configPath);
  await symlink(linkedConfig, configPath);
  result = (await rpc("tools/call", { name: "deepseek_settings_save", arguments: { expectedRevision: 1, model: "deepseek-mock-a" } })).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /non-regular or multiply linked Codex config/);
  assert.equal(await readFile(legacyCredentialHelper, "utf8"), LEGACY_NATIVE_CREDENTIAL_SOURCE, "Failed install migration did not restore the legacy credential helper.");
  assert.deepEqual(JSON.parse(await readFile(join(temp, "settings.json"), "utf8")), {
    schemaVersion: 2, revision: 1, model: "", apiKey: fakeKey,
  });
  await assertRejectsMissing(join(codexHome, "agents", "deepseek-subagent.toml"));
  await assertRejectsMissing(join(temp, "native-models.json"));
  await rm(configPath);
  await writeFile(configPath, originalCodexConfig);
  result = (await rpc("tools/call", { name: "deepseek_settings_save", arguments: { expectedRevision: 1, model: "deepseek-mock-a" } })).result;
  assert.equal(result.structuredContent.model, "deepseek-mock-a");
  await assertRejectsMissing(legacyCredentialHelper);
  assert.equal(result.structuredContent.nativeReady, true);
  const rolePath = join(codexHome, "agents", "deepseek-subagent.toml");
  const role = await readFile(rolePath, "utf8");
  assert(role.includes('name = "deepseek"'));
  assert(role.includes('model = "deepseek-mock-a"'));
  assert(!role.includes("model_provider"));
  assert(!role.includes("model_catalog_json"));
  const catalog = JSON.parse(await readFile(join(temp, "native-models.json"), "utf8"));
  assert.deepEqual(catalog.models.map((model) => model.slug), ["deepseek-mock-a", "deepseek-mock-b", "deepseek-flash"]);
  assert(catalog.models.every((model) => model.visibility === "hide" && Number.isInteger(model.priority) && model.priority >= 10_000));
  assert.deepEqual(catalog.models.find((model) => model.slug === "deepseek-flash").input_modalities, ["text", "image"]);
  const routedConfig = await readFile(join(codexHome, "config.toml"), "utf8");
  assert(routedConfig.includes('model_provider = "deepseek-subagent-router"'));
  assert(routedConfig.includes("DeepSeek Subagent provider definition"));
  const runtime = JSON.parse(await readFile(join(temp, "router-runtime.json"), "utf8"));
  assert.equal(runtime.schemaVersion, 2);
  assert.equal(runtime.catalogFile, join(temp, "native-models.json"));
  assert.equal(runtime.deepseekBaseUrl, `http://127.0.0.1:${port}/v1/`);
  const delegationCanary = "delegation-canary-mcp-smoke-only";
  result = (await rpc("tools/call", {
    name: "deepseek_delegation_prepare",
    arguments: { taskName: "mcp_probe", message: delegationCanary },
  })).result;
  assert.equal(result.isError, undefined);
  assert.match(result.structuredContent.taskName, /^mcp_probe_[a-f0-9]{24}$/);
  assert.equal(result.structuredContent.expiresInSeconds, 600);
  assert(!JSON.stringify(result).includes(delegationCanary));
  assert(!await readFile(join(temp, "settings.json"), "utf8").then((contents) => contents.includes(delegationCanary)));
  assert(!await readFile(join(temp, "router-runtime.json"), "utf8").then((contents) => contents.includes(delegationCanary)));
  const routedDelegation = await fetch(`http://127.0.0.1:${runtime.port}/${runtime.routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret-do-not-forward", "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-mock-a",
      input: [{ type: "agent_message", role: "assistant", content: [
        { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${result.structuredContent.taskName}\nSender: /root\nPayload:\n` },
        { type: "encrypted_content", encrypted_content: "mcp-smoke-ciphertext" },
      ] }],
    }),
  });
  assert.equal(routedDelegation.status, 200);
  assert(JSON.stringify(lastResponsesPayload).includes(delegationCanary));
  assert(!JSON.stringify(lastResponsesPayload).includes("mcp-smoke-ciphertext"));
  result = (await rpc("tools/call", { name: "deepseek_connection_test", arguments: { model: "deepseek-mock-b" } })).result;
  assert.equal(result.isError, undefined);
  assert.equal(lastResponsesPayload.model, "deepseek-mock-b");
  result = (await rpc("tools/call", { name: "deepseek_connection_test", arguments: { model: "deepseek-unknown" } })).result;
  assert.equal(result.isError, true);
  assert.equal(result._meta.deepseekSubagentError.code, "MODEL_UNAVAILABLE");
  await writeFile(configPath, routedConfig.replace("enabled = true", "enabled = false"));
  result = (await rpc("tools/call", { name: "deepseek_settings", arguments: {} })).result;
  assert.equal(result.structuredContent.nativeReady, false);
  await writeFile(configPath, routedConfig);
  await appendFile(rolePath, "# read-only-sentinel\n");
  result = (await rpc("tools/call", { name: "deepseek_settings", arguments: {} })).result;
  assert.equal(result.structuredContent.nativeReady, false);
  result = (await rpc("tools/call", { name: "deepseek_connection_test", arguments: { model: "deepseek-mock-b" } })).result;
  assert.equal(result.isError, undefined);
  assert((await readFile(rolePath, "utf8")).includes("# read-only-sentinel"));
  assert.deepEqual(JSON.parse(await readFile(join(temp, "native-models.json"), "utf8")).models.map((model) => model.slug), ["deepseek-mock-a", "deepseek-mock-b", "deepseek-flash"]);
  await writeFile(legacyCredentialHelper, `${LEGACY_NATIVE_CREDENTIAL_SOURCE}# unrecognized\n`, { mode: 0o600 });
  const settingsIdentityBeforeRejectedDelete = await stat(join(temp, "settings.json"));
  result = (await rpc("tools/call", { name: "deepseek_credential_delete", arguments: { expectedRevision: 2 } })).result;
  assert.equal(result.isError, true);
  assert.equal(result._meta.deepseekSubagentError.code, "OWNERSHIP_CONFLICT");
  const settingsIdentityAfterRejectedDelete = await stat(join(temp, "settings.json"));
  assert.equal(settingsIdentityAfterRejectedDelete.ino, settingsIdentityBeforeRejectedDelete.ino, "Rejected helper ownership changed the settings file identity.");
  assert.equal(settingsIdentityAfterRejectedDelete.mtimeMs, settingsIdentityBeforeRejectedDelete.mtimeMs, "Rejected helper ownership rewrote the settings file.");
  assert.equal(await readFile(legacyCredentialHelper, "utf8"), `${LEGACY_NATIVE_CREDENTIAL_SOURCE}# unrecognized\n`);
  assert.deepEqual(JSON.parse(await readFile(join(temp, "settings.json"), "utf8")), {
    schemaVersion: 2, revision: 2, model: "deepseek-mock-a", apiKey: fakeKey,
  }, "Failed credential deletion did not restore settings after rejecting an unrecognized legacy helper.");
  assert((await readFile(rolePath, "utf8")).includes("# read-only-sentinel"), "Failed credential deletion partially removed the native role.");
  assert.equal(await readFile(configPath, "utf8"), routedConfig, "Failed credential deletion partially restored provider routing.");
  await writeFile(legacyCredentialHelper, LEGACY_NATIVE_CREDENTIAL_SOURCE, { mode: 0o600 });
  const rollbackPaths = [
    join(temp, "settings.json"), rolePath, join(temp, "native-models.json"), legacyCredentialHelper,
    join(temp, "cleanup.mjs"), join(temp, "native-config.mjs"), join(temp, "runtime.mjs"),
    join(temp, "router-runtime.json"), join(temp, "router.mjs"), configPath,
  ];
  const beforeInjectedRemoval = new Map(await Promise.all(rollbackPaths.map(async (path) => [path, await readFile(path, "utf8")])));
  result = (await rpc("tools/call", { name: "deepseek_credential_delete", arguments: { expectedRevision: 2 } })).result;
  assert.equal(result.isError, true);
  assert.equal(result._meta.deepseekSubagentError.code, "ROUTER_UNAVAILABLE");
  for (const path of rollbackPaths) {
    assert.equal(await readFile(path, "utf8"), beforeInjectedRemoval.get(path), `Runtime removal failure did not restore ${path}.`);
  }
  assert.equal((await fetch(`http://127.0.0.1:${runtime.port}/${runtime.routeToken}/healthz`)).status, 200, "Runtime removal rollback did not preserve the direct router process.");
  result = (await rpc("tools/call", { name: "deepseek_credential_delete", arguments: { expectedRevision: 2 } })).result;
  assert.equal(result.structuredContent.credentialConfigured, false);
  await assertRejectsMissing(legacyCredentialHelper);
  assert(!stdoutAll.includes(fakeKey));
  assert(modelRequests >= 2);
  assert(responsesRequests >= 2);
  const settings = JSON.parse(await readFile(join(temp, "settings.json"), "utf8"));
  assert.equal(settings.apiKey, null);
  await assertRejectsMissing(rolePath);
  await assertRejectsMissing(join(temp, "native-models.json"));
  await assertRejectsMissing(join(temp, "router-runtime.json"));
  await assertRejectsMissing(join(temp, "router.mjs"));
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalCodexConfig);
  if (process.platform !== "win32") {
    assert.equal((await stat(temp)).mode & 0o777, 0o700);
    assert.equal((await stat(join(temp, "settings.json"))).mode & 0o777, 0o600);
  }
  process.stdout.write("MCP smoke test passed\n");
} finally {
  child.kill("SIGTERM");
  await removeRuntimeRouter(runtimePaths(temp, codexHome)).catch(() => {});
  api.close();
  await rm(temp, { recursive: true, force: true });
}
if (stderr) throw new Error(stderr);

const inputLimitTemp = await mkdtemp(join(tmpdir(), "deepseek-mcp-limit-"));
const inputLimitChild = spawn(process.execPath, [join(root, "plugins/deepseek-subagent/scripts/server.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "test",
    DEEPSEEK_SUBAGENT_CONFIG_DIR: inputLimitTemp,
    DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE: join(inputLimitTemp, "settings.json"),
    CODEX_HOME: join(inputLimitTemp, "codex-home"),
  },
  stdio: ["pipe", "ignore", "pipe"],
});
let inputLimitStderr = "";
inputLimitChild.stderr.setEncoding("utf8");
inputLimitChild.stderr.on("data", (chunk) => { inputLimitStderr += chunk; });
inputLimitChild.stdin.on("error", (error) => { if (error?.code !== "EPIPE") throw error; });
inputLimitChild.stdin.end("x".repeat(4 * 1024 * 1024 + 1));
const inputLimitExit = await new Promise((resolveExit, rejectExit) => {
  inputLimitChild.once("error", rejectExit);
  inputLimitChild.once("exit", (code, signal) => signal ? rejectExit(new Error(`MCP limit child exited on ${signal}`)) : resolveExit(code));
});
assert.notEqual(inputLimitExit, 0);
assert.match(inputLimitStderr, /input safety limit/);
await rm(inputLimitTemp, { recursive: true, force: true });

const reconcileTemp = await mkdtemp(join(tmpdir(), "deepseek-mcp-reconcile-"));
const reconcileCodexHome = join(reconcileTemp, "codex-home");
const reconcileSettings = join(reconcileTemp, "settings.json");
const reconcileDeadlineAt = Date.now() + 750;
await mkdir(reconcileCodexHome, { recursive: true });
await writeFile(join(reconcileCodexHome, "config.toml"), '[features.multi_agent_v2]\nenabled = true\n');
await writeFile(reconcileSettings, `${JSON.stringify({ schemaVersion: 2, revision: 3, model: "", apiKey: null })}\n`);
await writeFile(join(reconcileTemp, "router-runtime.json"), `${JSON.stringify({
  schemaVersion: 2,
  cleanupToken: "a".repeat(48),
  cleanupStatus: "scheduled",
  cleanupAttempts: 0,
  cleanupMaxAttempts: 1,
  cleanupScheduledAt: Date.now() - 10_000,
  cleanupDeadlineAt: reconcileDeadlineAt,
  routeToken: "b".repeat(48),
  port: 54321,
  settingsFile: reconcileSettings,
  catalogFile: join(reconcileTemp, "native-models.json"),
  selectedModel: "deepseek-flash",
  deepseekBaseUrl: "https://api.deepseek.com/v1/",
  parentBaseUrl: "https://chatgpt.com/backend-api/codex/",
  nodeExecutable: process.execPath,
})}\n`);
await writeFile(join(reconcileTemp, "router.mjs"), "// Managed by the DeepSeek Subagent Codex plugin.\n");
const reconcileSupport = ["cleanup.mjs", "native-config.mjs", "runtime.mjs"].map((name) => join(reconcileTemp, name));
for (const path of reconcileSupport) await writeFile(path, "// Managed by the DeepSeek Subagent Codex plugin.\n");
const reconcileChild = spawn(process.execPath, [join(root, "plugins/deepseek-subagent/scripts/server.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "test",
    DEEPSEEK_SUBAGENT_CONFIG_DIR: reconcileTemp,
    DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE: reconcileSettings,
    DEEPSEEK_SUBAGENT_RUNTIME_MODE: "direct",
    DEEPSEEK_SUBAGENT_TEST_MUTATION_ACQUIRE_TIMEOUT_MS: "50",
    CODEX_HOME: reconcileCodexHome,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let reconcileStderr = "";
reconcileChild.stderr.setEncoding("utf8");
reconcileChild.stderr.on("data", (chunk) => { reconcileStderr += chunk; });
const reconcileInitialized = new Promise((resolveResponse, rejectResponse) => {
  let output = "";
  const timer = setTimeout(() => rejectResponse(new Error(`Restart reconciliation timed out: ${reconcileStderr}`)), 5_000);
  reconcileChild.stdout.setEncoding("utf8");
  reconcileChild.stdout.on("data", (chunk) => {
    output += chunk;
    const newline = output.indexOf("\n");
    if (newline < 0) return;
    clearTimeout(timer);
    resolveResponse(JSON.parse(output.slice(0, newline)));
  });
});
reconcileChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
assert.equal((await reconcileInitialized).result.serverInfo.name, "deepseek-settings");
const reconcileManagedPaths = [join(reconcileTemp, "router-runtime.json"), join(reconcileTemp, "router.mjs"), ...reconcileSupport];
for (const path of reconcileManagedPaths) await access(path);

const reconcileMutationLock = join(reconcileTemp, ".mutation.lock");
await mkdir(reconcileMutationLock, { mode: 0o700 });
await writeFile(join(reconcileMutationLock, "owner.json"), `${JSON.stringify({
  schemaVersion: 1,
  pid: process.pid,
  token: "c".repeat(48),
  createdAt: Date.now(),
})}\n`, { mode: 0o600 });
await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, reconcileDeadlineAt - Date.now()) + 100));
for (const path of reconcileManagedPaths) await access(path);
await rm(reconcileMutationLock, { recursive: true });

const reconcileCleanupDeadline = Date.now() + 5_000;
while (true) {
  const remaining = await Promise.all(reconcileManagedPaths.map((path) => access(path).then(() => true, () => false)));
  if (remaining.every((exists) => !exists)) break;
  if (Date.now() >= reconcileCleanupDeadline) {
    throw new Error(`Restart reconciliation did not automatically retry after the cleanup deadline: ${reconcileStderr}`);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
}
reconcileChild.kill("SIGTERM");
await rm(reconcileTemp, { recursive: true, force: true });

async function assertRejectsMissing(path) {
  await assert.rejects(access(path));
}
