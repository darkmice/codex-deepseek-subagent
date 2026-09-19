import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const temp = await realpath(await mkdtemp(join(tmpdir(), "deepseek-native-e2e-")));
const codexHome = join(temp, "codex-home");
const settingsDir = join(temp, "settings");
const settingsFile = join(settingsDir, "settings.json");
process.env.NODE_ENV = "test";
process.env.DEEPSEEK_SUBAGENT_RUNTIME_MODE = "direct";
process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE = settingsFile;
process.env.DEEPSEEK_SUBAGENT_LAUNCH_AGENT_LABEL = `com.dark.deepseek-subagent-router.test-native-e2e-${process.pid}`;
process.env.DEEPSEEK_SUBAGENT_LAUNCH_AGENTS_DIR = join(temp, "launchagents");
const {
  LEGACY_NATIVE_CREDENTIAL_SOURCE,
  installNativeIntegration,
  nativeIntegrationStatus,
  removeNativeIntegration,
} = await import("../plugins/deepseek-subagent/scripts/native-config.mjs");
const imageFile = join(temp, "synthetic-probe.png");
const desktopCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
const codexBin = process.env.CODEX_BIN || (existsSync(desktopCodex) ? desktopCodex : "codex");
const codexAuthFile = process.env.CODEX_AUTH_FILE;
const forceDeepSeek413 = process.env.DEEPSEEK_SUBAGENT_TEST_FORCE_413 === "1";
const legacyParentProvider = process.env.DEEPSEEK_SUBAGENT_TEST_LEGACY_PARENT === "1";
assert(!(forceDeepSeek413 && legacyParentProvider), "Native E2E fallback modes are mutually exclusive.");
assert(codexAuthFile && existsSync(codexAuthFile), "Set CODEX_AUTH_FILE to a logged-in Codex auth.json for the native E2E.");
const authFixture = JSON.parse(await readFile(codexAuthFile, "utf8"));
const authSecrets = [authFixture?.OPENAI_API_KEY, ...Object.values(authFixture?.tokens || {})]
  .filter((value) => typeof value === "string" && value.length >= 8);
assert(authSecrets.length > 0, "The Codex auth fixture did not contain a usable parent credential.");
const parentAuthorizations = new Set(authSecrets.map((secret) => `Bearer ${secret}`));
const requests = [];
let preparedTaskName = "";
let routerRuntime = null;
let nativeFollowupPrepared = false;
const nativeFollowupMessage = "Return a second result from the same native child.";

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function completed(id) {
  return { type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
}

function assistant(id, text) {
  return { type: "response.output_item.done", item: { type: "message", role: "assistant", id, content: [{ type: "output_text", text }] } };
}

function visibleTools(payload) {
  if (Array.isArray(payload.tools) && payload.tools.length > 0) return payload.tools;
  const additionalTools = Array.isArray(payload.input) ? payload.input[0] : null;
  assert.equal(additionalTools?.type, "additional_tools", "Responses Lite must put additional_tools at input[0].");
  return Array.isArray(additionalTools?.tools) ? additionalTools.tools : [];
}

function functionCallOutput(payload, callId) {
  return Array.isArray(payload.input)
    ? payload.input.find((item) => item?.type === "function_call_output" && item.call_id === callId)
    : null;
}

function serializedOutput(item) {
  return typeof item?.output === "string" ? item.output : JSON.stringify(item?.output ?? null);
}

async function stageNativeFollowup() {
  if (nativeFollowupPrepared) return;
  assert(routerRuntime, "Native follow-up was requested before the router runtime was available.");
  const prepared = await fetch(`http://127.0.0.1:${routerRuntime.port}/${routerRuntime.routeToken}/delegations/followup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: `/root/${preparedTaskName}`, message: nativeFollowupMessage }),
  });
  assert.equal(prepared.status, 201, `Native follow-up preparation failed: ${await prepared.text()}`);
  nativeFollowupPrepared = true;
}

const api = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body || "{}");
  requests.push({
    path: request.url,
    model: payload.model,
    authorization: request.url === "/deepseek/v1/responses"
      ? (request.headers.authorization === "Bearer e2e-fake-deepseek-key" ? "deepseek" : "unexpected")
      : (request.headers.authorization === "Bearer e2e-fake-deepseek-key"
          ? "deepseek-leak"
          : (parentAuthorizations.has(request.headers.authorization) ? "parent" : (request.headers.authorization ? "unexpected" : "missing"))),
    body: payload,
  });

  if (request.url === "/deepseek/v1/responses") {
    if (forceDeepSeek413) {
      response.writeHead(413, { "content-type": "application/json" });
      response.end('{"error":{"message":"synthetic DeepSeek payload limit"}}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (JSON.stringify(payload.input || []).includes(nativeFollowupMessage)) {
      response.end(sse([
        { type: "response.created", response: { id: "child-followup-response" } },
        assistant("child-followup-message", "native DeepSeek child follow-up completed"),
        completed("child-followup-response"),
      ]));
      return;
    }
    const imageOutput = functionCallOutput(payload, "child_view_image");
    if (!imageOutput) {
      const childTools = visibleTools(payload);
      assert(childTools.some((tool) => tool.name === "view_image" || tool.tools?.some((nested) => nested.name === "view_image")),
        `Native DeepSeek child did not receive view_image. tools=${JSON.stringify(childTools.map((tool) => ({ type: tool.type, name: tool.name, nested: tool.tools?.map((nested) => nested.name) })))} inputTypes=${JSON.stringify((payload.input || []).map((item) => item?.type))}`);
      response.end(sse([
        { type: "response.created", response: { id: "child-tool-response" } },
        {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "child-reasoning", summary: [], encrypted_content: "child-reasoning-ciphertext" },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call", id: "child-function-call", call_id: "child_view_image", name: "view_image",
            arguments: JSON.stringify({ path: imageFile, detail: "original" }),
          },
        },
        completed("child-tool-response"),
      ]));
      return;
    }
    assert(serializedOutput(imageOutput).length > 0, "Native DeepSeek child did not return a view_image result.");
    const reasoning = Array.isArray(payload.input)
      ? payload.input.find((item) => item?.type === "reasoning" && item.encrypted_content === "child-reasoning-ciphertext")
      : null;
    assert.equal(reasoning?.encrypted_content, "child-reasoning-ciphertext", "Native tool continuation lost DeepSeek reasoning provenance.");
    assert.equal(reasoning?.id, undefined, "Current Codex wire behavior unexpectedly retained the response-side reasoning id.");
    response.end(sse([
      { type: "response.created", response: { id: "child-final-response" } },
      assistant("child-message", "native DeepSeek child completed"),
      completed("child-final-response"),
    ]));
    return;
  }

  if (request.url === "/parent/v1/responses") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const serializedInput = JSON.stringify(payload.input || []);
    if (forceDeepSeek413 && serializedInput.includes("Message Type: NEW_TASK") &&
        serializedInput.includes(nativeFollowupMessage)) {
      response.end(sse([
        { type: "response.created", response: { id: "fallback-child-followup-response" } },
        assistant("fallback-child-followup-message", "native GPT fallback child follow-up completed"),
        completed("fallback-child-followup-response"),
      ]));
      return;
    }
    if (forceDeepSeek413 && serializedInput.includes("Message Type: NEW_TASK") &&
        serializedInput.includes("Return a short native child result.")) {
      response.end(sse([
        { type: "response.created", response: { id: "fallback-child-response" } },
        assistant("fallback-child-message", "native GPT fallback child completed"),
        completed("fallback-child-response"),
      ]));
      return;
    }
    const spawnOutput = functionCallOutput(payload, "native_deepseek");
    const waitOutput = functionCallOutput(payload, "native_wait");
    const followupOutput = functionCallOutput(payload, "native_followup");
    const followupWaitOutput = functionCallOutput(payload, "native_followup_wait");
    if (!spawnOutput) {
      const agentNamespace = visibleTools(payload).find((tool) => tool.type === "namespace" && tool.tools?.some((nested) => nested.name === "spawn_agent"));
      assert(agentNamespace, "Codex did not expose spawn_agent in its direct or Responses Lite tool inventory.");
      const spawnSpec = agentNamespace.tools.find((tool) => tool.name === "spawn_agent");
      const v2 = Object.hasOwn(spawnSpec?.parameters?.properties || {}, "fork_turns");
      assert.equal(v2, true, "Codex did not activate the required Multi-Agent v2 spawn_agent contract.");
      response.end(sse([
        { type: "response.created", response: { id: "parent-spawn" } },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call", call_id: "native_deepseek", namespace: agentNamespace.name, name: "spawn_agent",
            arguments: JSON.stringify({ task_name: preparedTaskName, agent_type: "deepseek", message: "Return a short native child result.", fork_turns: "none" }),
          },
        },
        completed("parent-spawn"),
      ]));
      return;
    }
    const spawnMetadata = JSON.parse(serializedOutput(spawnOutput));
    assert.equal(spawnMetadata.task_name, `/root/${preparedTaskName}`, "spawn_agent did not return the canonical native child task name.");
    assert.equal(typeof spawnMetadata.nickname, "string", "spawn_agent did not return visible native child metadata.");
    assert(spawnMetadata.nickname.length > 0, "spawn_agent returned an empty native child nickname.");
    assert(!serializedOutput(spawnOutput).includes("native DeepSeek child completed"), "spawn_agent unexpectedly blocked until the child completed.");
    const expectedFirstResult = forceDeepSeek413 ? "native GPT fallback child completed" : "native DeepSeek child completed";
    const expectedFollowupResult = forceDeepSeek413
      ? "native GPT fallback child follow-up completed"
      : "native DeepSeek child follow-up completed";
    const hasFirstResult = serializedInput.includes("Message Type: FINAL_ANSWER") && serializedInput.includes(expectedFirstResult);
    const hasFollowupResult = serializedInput.includes("Message Type: FINAL_ANSWER") && serializedInput.includes(expectedFollowupResult);
    if (!hasFirstResult) {
      if (waitOutput) {
        assert(/"timed_out"\s*:\s*false/.test(serializedOutput(waitOutput)), "wait_agent timed out before the first child completion reached the mailbox.");
        throw new Error(`The first child completion was absent after wait_agent: ${serializedInput.slice(-4000)}`);
      }
      const agentNamespace = visibleTools(payload).find((tool) => tool.type === "namespace" && tool.tools?.some((nested) => nested.name === "wait_agent"));
      assert(agentNamespace, "Codex did not expose wait_agent after native spawn_agent completed.");
      response.end(sse([
        { type: "response.created", response: { id: "parent-wait" } },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call", call_id: "native_wait", namespace: agentNamespace.name, name: "wait_agent",
            arguments: JSON.stringify({ timeout_ms: 45_000 }),
          },
        },
        completed("parent-wait"),
      ]));
      return;
    }
    if (!followupOutput) {
      await stageNativeFollowup();
      const agentNamespace = visibleTools(payload).find((tool) => tool.type === "namespace" && tool.tools?.some((nested) => nested.name === "followup_task"));
      assert(agentNamespace, "Codex did not expose followup_task after the native child completed.");
      response.end(sse([
        { type: "response.created", response: { id: "parent-followup" } },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call", call_id: "native_followup", namespace: agentNamespace.name, name: "followup_task",
            arguments: JSON.stringify({ target: `/root/${preparedTaskName}`, message: nativeFollowupMessage }),
          },
        },
        completed("parent-followup"),
      ]));
      return;
    }
    if (!hasFollowupResult) {
      if (followupWaitOutput) {
        assert(/"timed_out"\s*:\s*false/.test(serializedOutput(followupWaitOutput)), "wait_agent timed out before the follow-up child completion reached the mailbox.");
        throw new Error(`The follow-up child completion was absent after wait_agent: ${serializedInput.slice(-4000)}`);
      }
      const agentNamespace = visibleTools(payload).find((tool) => tool.type === "namespace" && tool.tools?.some((nested) => nested.name === "wait_agent"));
      assert(agentNamespace, "Codex did not expose wait_agent after native followup_task completed.");
      response.end(sse([
        { type: "response.created", response: { id: "parent-followup-wait" } },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call", call_id: "native_followup_wait", namespace: agentNamespace.name, name: "wait_agent",
            arguments: JSON.stringify({ timeout_ms: 45_000 }),
          },
        },
        completed("parent-followup-wait"),
      ]));
      return;
    }
    response.end(sse([
      { type: "response.created", response: { id: "parent-finish" } },
      assistant("parent-message", "parent received native child follow-up result"),
      completed("parent-finish"),
    ]));
    return;
  }

  response.writeHead(404).end();
});

await new Promise((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
const port = api.address().port;

try {
  process.env.CODEX_HOME = codexHome;
  await mkdir(settingsDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(imageFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await copyFile(codexAuthFile, join(codexHome, "auth.json"));
  if (process.platform !== "win32") await chmod(join(codexHome, "auth.json"), 0o600);
  await writeFile(settingsFile, `${JSON.stringify({ schemaVersion: 2, revision: 1, model: "deepseek-flash", apiKey: "e2e-fake-deepseek-key" })}\n`);
  const parentConfig = `model = "gpt-5.6-sol"
model_provider = "custom"

[features.multi_agent_v2]
enabled = true
hide_spawn_agent_metadata = false

[model_providers.custom]
name = "custom"
${legacyParentProvider ? "" : `base_url = "http://127.0.0.1:${port}/parent/v1/"`}
requires_openai_auth = true
wire_api = "responses"
`;
  await writeFile(join(codexHome, "config.toml"), parentConfig, "utf8");
  await installNativeIntegration({
    settingsDir, settingsFile, model: "deepseek-flash",
    models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
    modelTemplateFile: join(root, "plugins/deepseek-subagent/assets/model-template.json"),
    apiBaseUrl: `http://127.0.0.1:${port}/deepseek/v1/`,
    parentBaseUrl: `http://127.0.0.1:${port}/parent/v1/`,
  });

  const catalog = JSON.parse(await readFile(join(settingsDir, "native-models.json"), "utf8"));
  const flash = catalog.models.find((model) => model.slug === "deepseek-flash");
  const pro = catalog.models.find((model) => model.slug === "deepseek-v4-pro");
  assert.deepEqual(flash.input_modalities, ["text", "image"]);
  assert.equal(flash.supports_image_detail_original, true);
  assert.equal(flash.visibility, "hide");
  assert(flash.priority >= 10_000);
  assert.deepEqual(pro.input_modalities, ["text"]);
  assert.equal(pro.visibility, "hide");
  assert.equal((await nativeIntegrationStatus(
    settingsDir, "deepseek-flash", `http://127.0.0.1:${port}/deepseek/v1/`, `http://127.0.0.1:${port}/parent/v1/`,
  )).ready, true);
  assert.equal((await nativeIntegrationStatus(
    settingsDir, "deepseek-flash", `http://127.0.0.1:${port}/wrong-deepseek/v1/`, `http://127.0.0.1:${port}/parent/v1/`,
  )).ready, false);
  const routedConfig = await readFile(join(codexHome, "config.toml"), "utf8");
  assert(routedConfig.includes('model_provider = "deepseek-subagent-router"'));
  const runtime = JSON.parse(await readFile(join(settingsDir, "router-runtime.json"), "utf8"));
  routerRuntime = runtime;
  assert.equal(runtime.parentModel, "gpt-5.6-sol");
  const prepared = await fetch(`http://127.0.0.1:${runtime.port}/${runtime.routeToken}/delegations/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "native_probe", message: "Return a short native child result." }),
  });
  assert.equal(prepared.status, 201);
  preparedTaskName = (await prepared.json()).taskName;
  assert.match(preparedTaskName, /^native_probe_[a-f0-9]{24}$/);

  const appServer = spawn(codexBin, ["app-server", "--stdio", "--strict-config"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let appBuffer = "", appStderr = "", nextRequestId = 1;
  const appMessages = [];
  const pendingRpc = new Map();
  const waiters = new Set();
  appServer.stdout.setEncoding("utf8");
  appServer.stderr.setEncoding("utf8");
  appServer.stderr.on("data", (chunk) => { appStderr += chunk; });
  appServer.stdout.on("data", (chunk) => {
    appBuffer += chunk;
    while (true) {
      const newline = appBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = appBuffer.slice(0, newline).replace(/\r$/, "");
      appBuffer = appBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      appMessages.push(message);
      if (Object.hasOwn(message, "id") && pendingRpc.has(message.id)) {
        const complete = pendingRpc.get(message.id);
        pendingRpc.delete(message.id);
        complete(message);
      } else if (Object.hasOwn(message, "id") && message.method) {
        appServer.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported test client request: ${message.method}` } })}\n`);
      }
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.delete(waiter);
          waiter.resolve(message);
        }
      }
    }
  });
  function appRpc(method, params) {
    const id = nextRequestId++;
    appServer.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => { pendingRpc.delete(id); rejectRpc(new Error(`app-server RPC timed out: ${method}; stderr bytes=${Buffer.byteLength(appStderr)}`)); }, 15_000);
      pendingRpc.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) {
          const code = Number.isInteger(message.error.code) ? message.error.code : "unknown";
          rejectRpc(new Error(`${method}: app-server RPC failed with code ${code}`));
        }
        else resolveRpc(message.result);
      });
    });
  }
  function appNotify(method, params = {}) {
    appServer.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  function waitForMessage(predicate, timeoutMs = 45_000) {
    const existing = appMessages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveMessage, rejectMessage) => {
      const waiter = { predicate, resolve: (message) => { clearTimeout(timer); resolveMessage(message); } };
      const timer = setTimeout(() => { waiters.delete(waiter); rejectMessage(new Error(`app-server notification timed out; stderr bytes=${Buffer.byteLength(appStderr)}; messages=${appMessages.length}`)); }, timeoutMs);
      waiters.add(waiter);
    });
  }

  try {
    await appRpc("initialize", { clientInfo: { name: "deepseek-subagent-e2e", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    appNotify("initialized");
    const started = await appRpc("thread/start", {
      cwd: root, model: "gpt-5.6-sol", modelProvider: legacyParentProvider ? "custom" : "deepseek-subagent-router", approvalPolicy: "never", sandbox: "read-only",
    });
    const threadId = started.thread.id;
    await appRpc("turn/start", {
      threadId,
      effort: "ultra",
      input: [{ type: "text", text: "Use the deepseek custom agent to run the native DeepSeek probe, wait for it, then return the child result." }],
    });
    const completedTurn = await waitForMessage((message) => message.method === "turn/completed" && message.params?.threadId === threadId);
    assert.equal(completedTurn.params.turn.status, "completed", "Native app-server turn did not complete.");
  } finally {
    if (appServer.exitCode === null && appServer.signalCode === null) {
      const closed = new Promise((resolveClose) => appServer.once("close", resolveClose));
      appServer.kill("SIGTERM");
      await closed;
    }
  }

  const transcript = JSON.stringify(appMessages);
  assert(authSecrets.every((secret) => !appStderr.includes(secret) && !transcript.includes(secret)), "Native E2E output exposed a value from the real auth fixture.");
  const deepseekRequests = requests.filter((request) => request.path === "/deepseek/v1/responses");
  const parentRequests = requests.filter((request) => request.path === "/parent/v1/responses");
  const deepseekRequest = deepseekRequests.find((request) => request.model === "deepseek-flash");
  const parentRequest = parentRequests.find((request) => request.model === "gpt-5.6-sol");
  const finalAgentMessage = [...appMessages].reverse().find((message) => message.method === "item/completed" && message.params?.item?.type === "agentMessage");
  assert(deepseekRequest,
    `Native child provider route was unexpected. Requests: ${JSON.stringify(requests.map((entry) => ({ path: entry.path, model: entry.model, authorization: entry.authorization })))}; parent result: ${finalAgentMessage?.params?.item?.text || "none"}`);
  assert(parentRequest, `The parent request never reached its configured Responses provider: ${JSON.stringify(requests.map((entry) => ({ path: entry.path, model: entry.model, authorization: entry.authorization })))}`);
  assert.equal(deepseekRequests.length, forceDeepSeek413 ? 1 : 3,
    forceDeepSeek413
      ? "Native fallback did not stop after the synthetic DeepSeek 413."
      : "Native DeepSeek child did not complete exactly one tool continuation and one same-child follow-up.");
  assert(deepseekRequests.every((request) => request.authorization === "deepseek"));
  assert(deepseekRequests.every((request) => request.model === "deepseek-flash"));
  assert(parentRequests.length > 0);
  assert(parentRequests.every((request) => request.authorization === "parent"));
  assert(parentRequests.every((request) => request.model === "gpt-5.6-sol"));
  const childParentRequests = forceDeepSeek413
    ? parentRequests.filter((request) => {
        const input = JSON.stringify(request.body.input || []);
        return input.includes("Message Type: NEW_TASK") &&
          (input.includes("Return a short native child result.") || input.includes(nativeFollowupMessage));
      })
    : [];
  assert.equal(childParentRequests.length, forceDeepSeek413 ? 2 : 0, "The native GPT fallback child turns did not reach the parent provider.");
  const childParentRequestSet = new Set(childParentRequests);
  const parentEfforts = parentRequests
    .filter((request) => !childParentRequestSet.has(request))
    .map((request) => request.body.reasoning?.effort ?? null);
  assert(parentEfforts.every((effort) => effort === "max"), `Codex did not resolve the parent's Ultra selection to its model-owned max wire effort: ${JSON.stringify(parentEfforts)}`);
  assert(deepseekRequests.every((request) => request.body.reasoning?.effort === "high"));
  const capturedBodies = requests.map((request) => JSON.stringify(request.body)).join("\n");
  assert(authSecrets.every((secret) => !capturedBodies.includes(secret)), "A real parent credential leaked into a provider request body.");
  if (deepseekRequest) assert(JSON.stringify(deepseekRequest.body).includes("Return a short native child result."));
  if (!forceDeepSeek413) {
    assert(deepseekRequests.some((request) => functionCallOutput(request.body, "child_view_image")), "Native DeepSeek child never returned the tool result to its provider.");
    assert(deepseekRequests.some((request) => JSON.stringify(request.body.input || []).includes(nativeFollowupMessage)),
      "Native followup_task did not continue the same DeepSeek child through its provider route.");
  } else {
    assert(childParentRequests.some((request) => JSON.stringify(request.body.input || []).includes(nativeFollowupMessage)),
      "Native followup_task did not continue the GPT fallback child through the parent route.");
  }
  assert(deepseekRequests.every((request) => !JSON.stringify(request.body).includes("Use the deepseek custom agent to run the native DeepSeek probe")));
  assert(parentRequests.length >= 2, "The parent did not continue after native spawn_agent.");
  assert(parentRequests.some((request) => functionCallOutput(request.body, "native_deepseek")), "The parent did not continue after native spawn_agent returned.");
  assert(parentRequests.some((request) => functionCallOutput(request.body, "native_followup")), "The parent did not continue after native followup_task returned.");
  const waitRequest = parentRequests.find((request) => functionCallOutput(request.body, "native_wait"));
  const earlyCompletionRequest = parentRequests.find((request) => {
    const input = JSON.stringify(request.body.input || []);
    return functionCallOutput(request.body, "native_deepseek") &&
      input.includes("Message Type: FINAL_ANSWER") && input.includes("native DeepSeek child completed");
  });
  assert(waitRequest || earlyCompletionRequest, "The parent neither waited for nor consumed the already-terminal native child.");
  assert(!appStderr.includes("e2e-fake-deepseek-key"));
  const expectedChildResult = forceDeepSeek413 ? "native GPT fallback child completed" : "native DeepSeek child completed";
  const expectedFollowupResult = forceDeepSeek413
    ? "native GPT fallback child follow-up completed"
    : "native DeepSeek child follow-up completed";
  assert(transcript.includes(expectedChildResult), "Native child result was not visible in app-server events.");
  assert(transcript.includes(expectedFollowupResult), "Native same-child follow-up result was not visible in app-server events.");
  const appEventShapes = appMessages
    .filter((message) => typeof message.method === "string" && message.method.startsWith("item/"))
    .map((message) => ({ method: message.method, type: message.params?.item?.type, tool: message.params?.item?.tool, status: message.params?.item?.status }));
  const subAgentActivityMethods = appMessages
    .filter((message) => message.params?.item?.type === "subAgentActivity")
    .map((message) => message.method);
  assert(subAgentActivityMethods.includes("item/started") && subAgentActivityMethods.includes("item/completed"), `Native child activity was not visible in app-server events: ${JSON.stringify(appEventShapes)}`);
  const waitLifecycle = appMessages
    .filter((message) => message.params?.item?.type === "collabAgentToolCall" && message.params?.item?.tool === "wait")
    .map((message) => message.params.item.status);
  if (waitRequest) {
    assert(waitLifecycle.includes("inProgress") && waitLifecycle.includes("completed"), `Native wait_agent lifecycle was not visible in app-server events: ${JSON.stringify(appEventShapes)}`);
  } else {
    assert.equal(waitLifecycle.length, 0, `The parent redundantly waited after receiving a terminal child event: ${JSON.stringify(appEventShapes)}`);
  }
  assert(finalAgentMessage?.params?.item?.text?.includes("parent received native child follow-up result"), "The parent did not emit its final post-follow-up response.");
  const health = await (await fetch(`http://127.0.0.1:${runtime.port}/${runtime.routeToken}/healthz`)).json();
  assert.equal(health.delegationsPrepared, 1);
  assert.equal(health.followupsPrepared, 1);
  assert(health.delegationsInjected >= 1);
  assert.equal(health.parentFallbackRequests, forceDeepSeek413 ? 2 : 0);
  const cleanupFile = join(settingsDir, "cleanup.mjs");
  assert(existsSync(cleanupFile), "Native integration did not install an independent cleanup command.");
  const validSettings = await readFile(settingsFile, "utf8");
  await writeFile(settingsFile, "{invalid-json", "utf8");
  await assert.rejects(
    execFileAsync(process.execPath, [cleanupFile], { env: { ...process.env, CODEX_HOME: codexHome, DEEPSEEK_SUBAGENT_RUNTIME_MODE: "direct" } }),
  );
  assert(existsSync(cleanupFile), "Failed cleanup deleted its only retry command.");
  assert(existsSync(join(settingsDir, "native-config.mjs")), "Failed cleanup deleted native cleanup support.");
  assert(existsSync(join(settingsDir, "runtime.mjs")), "Failed cleanup deleted runtime cleanup support.");
  assert(existsSync(join(codexHome, "agents", "deepseek-subagent.toml")), "Failed cleanup partially removed the native agent role.");
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), routedConfig, "Failed cleanup partially removed provider routing.");
  await writeFile(settingsFile, validSettings, "utf8");
  const legacyCredentialHelper = join(settingsDir, "native-credential.mjs");
  await writeFile(legacyCredentialHelper, `${LEGACY_NATIVE_CREDENTIAL_SOURCE}# modified\n`, { mode: 0o600 });
  await assert.rejects(
    execFileAsync(process.execPath, [cleanupFile], { env: { ...process.env, CODEX_HOME: codexHome, DEEPSEEK_SUBAGENT_RUNTIME_MODE: "direct" } }),
    /unrecognized legacy DeepSeek credential helper/,
  );
  assert(existsSync(cleanupFile), "Legacy helper ownership failure deleted cleanup support.");
  assert(existsSync(join(codexHome, "agents", "deepseek-subagent.toml")), "Legacy helper ownership failure partially removed the native role.");
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), routedConfig, "Legacy helper ownership failure partially removed provider routing.");
  await writeFile(legacyCredentialHelper, LEGACY_NATIVE_CREDENTIAL_SOURCE, { mode: 0o600 });
  const staleMutationLock = join(settingsDir, ".mutation.lock");
  await mkdir(staleMutationLock, { mode: 0o700 });
  const staleOwner = join(staleMutationLock, "owner.json");
  await writeFile(staleOwner, `${JSON.stringify({ schemaVersion: 1, pid: 99999999, token: "d".repeat(48), createdAt: Date.now() - 180_000 })}\n`, { mode: 0o600 });
  const staleTime = new Date(Date.now() - 180_000);
  await utimes(staleOwner, staleTime, staleTime);
  await execFileAsync(process.execPath, [cleanupFile], { env: { ...process.env, CODEX_HOME: codexHome, DEEPSEEK_SUBAGENT_RUNTIME_MODE: "direct" } });
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), parentConfig);
  assert.equal(existsSync(settingsFile), false, "Standalone cleanup did not remove the stored credential.");
  assert.equal(existsSync(legacyCredentialHelper), false, "Standalone cleanup did not remove the verified legacy credential helper.");
  assert.equal(existsSync(cleanupFile), false, "Standalone cleanup did not remove its managed copy.");
  const scenario = legacyParentProvider ? "legacy-provider bridge " : forceDeepSeek413 ? "GPT fallback " : "";
  process.stdout.write(`Native app-server spawn_agent + same-child followup_task ${scenario}E2E passed with ${codexBin} (${waitRequest ? "waited for child" : "consumed early terminal event"})\n`);
} finally {
  await removeNativeIntegration(settingsDir).catch(() => {});
  api.close();
  await rm(temp, { recursive: true, force: true });
}
