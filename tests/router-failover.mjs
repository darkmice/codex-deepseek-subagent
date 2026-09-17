import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(join(tmpdir(), "deepseek-router-failover-"));
const settingsFile = join(temp, "settings.json");
const catalogFile = join(temp, "catalog.json");
const runtimeFile = join(temp, "runtime.json");
const routeToken = "d".repeat(48);
const instanceId = "e".repeat(48);
const shutdownToken = "f".repeat(48);
const keyA = "router-failover-key-a";
const keyDisabled = "router-disabled-key";
const keyB = "router-failover-key-b";
const seen = [];

const upstream = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  const authorization = request.headers.authorization;
  seen.push({ mode: payload.testMode, authorization, path: request.url });
  const isA = authorization === `Bearer ${keyA}`;
  const isB = authorization === `Bearer ${keyB}`;
  assert(isA || isB, `Unexpected credential: ${authorization}`);
  if (payload.testMode === "concurrent-failover" && isA) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
    response.writeHead(402, { "content-type": "application/json" });
    response.end('{"error":{"message":"a exhausted"}}');
    return;
  }
  if (payload.testMode === "reflect-secret") {
    response.writeHead(503, { "content-type": "application/json", "x-reflected-authorization": authorization });
    response.end(JSON.stringify({ error: { message: `debug ${authorization}` } }));
    return;
  }
  if (payload.testMode === "reflect-success-header") {
    response.writeHead(200, { "content-type": "application/json", "x-reflected-authorization": authorization });
    response.end('{"status":"completed","output":[]}');
    return;
  }
  if (payload.testMode === "reflect-success-body") {
    response.writeHead(200, { "content-type": "application/json" });
    const reflected = JSON.stringify({ status: "completed", output: [], debug: authorization });
    const splitAt = reflected.indexOf(keyA) + Math.floor(keyA.length / 2);
    response.write(reflected.slice(0, splitAt));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    response.end(reflected.slice(splitAt));
    return;
  }
  if (payload.testMode === "reflect-success-sse-terminal") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reasoning-reflected-terminal","summary":[],"encrypted_content":"cipher-reflected-terminal"}}\n\n');
    const terminal = `event: response.completed\ndata: {"type":"response.completed","response":{"id":"reflected-terminal","debug":"${keyA}"}}\n\n`;
    const splitAt = terminal.indexOf(keyA) + Math.floor(keyA.length / 2);
    response.write(terminal.slice(0, splitAt));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    response.end(terminal.slice(splitAt));
    return;
  }
  if (payload.testMode === "reflect-previous-key") {
    if (isA) {
      response.writeHead(402, { "content-type": "application/json" });
      response.end('{"error":{"message":"a exhausted"}}');
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      const reflected = JSON.stringify({ status: "completed", output: [], debug: `Bearer ${keyA}` });
      const splitAt = reflected.indexOf(keyA) + Math.floor(keyA.length / 2);
      response.write(reflected.slice(0, splitAt));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      response.end(reflected.slice(splitAt));
    }
    return;
  }
  if (payload.testMode === "fail402" && isA || payload.testMode === "all402" || payload.testMode === "pinned402" && isA) {
    response.writeHead(402, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: isA ? "a exhausted" : "b exhausted" } }));
    return;
  }
  if (payload.testMode === "fail401" && isA) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":{"message":"invalid"}}');
    return;
  }
  if (payload.testMode === "no-switch-429") {
    response.writeHead(429, { "content-type": "application/json" });
    response.end('{"error":{"message":"rate limit"}}');
    return;
  }
  if (payload.testMode === "no-switch-503") {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"error":{"message":"unavailable"}}');
    return;
  }
  if (payload.testMode === "network-drop") {
    request.socket.destroy();
    return;
  }
  if (payload.testMode === "sse-drop") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    response.socket.destroy();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"status":"completed","output":[]}');
});
await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
const upstreamPort = upstream.address().port;
const routerPort = await new Promise((resolvePort, rejectPort) => {
  const probe = createServer();
  probe.once("error", rejectPort);
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close((error) => error ? rejectPort(error) : resolvePort(port));
  });
});

let revision = 1;
async function writeSettings() {
  await writeFile(settingsFile, `${JSON.stringify({
    schemaVersion: 4, revision, model: "deepseek-flash",
    credentials: [
      { id: "key_aaaaaaaaaaaaaaaaaaaaaaaa", label: "A", enabled: true, baseUrl: `http://127.0.0.1:${upstreamPort}/a/v1/`, apiKey: keyA },
      { id: "key_cccccccccccccccccccccccc", label: "Disabled", enabled: false, baseUrl: `http://127.0.0.1:${upstreamPort}/disabled/v1/`, apiKey: keyDisabled },
      { id: "key_bbbbbbbbbbbbbbbbbbbbbbbb", label: "B", enabled: true, baseUrl: `http://127.0.0.1:${upstreamPort}/b/v1/`, apiKey: keyB },
    ],
  })}\n`);
}
await writeSettings();
await writeFile(catalogFile, `${JSON.stringify({ models: [{ slug: "deepseek-flash", visibility: "hide", priority: 10_000, supported_in_api: true, input_modalities: ["text", "image"], supports_image_detail_original: true }] })}\n`);
await writeFile(runtimeFile, `${JSON.stringify({
  schemaVersion: 2, routeToken, instanceId, shutdownToken, executionMode: "direct-test", port: routerPort,
  settingsFile, catalogFile, selectedModel: "deepseek-flash",
  deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/v1/`, parentBaseUrl: `http://127.0.0.1:${upstreamPort}/parent/v1/`,
})}\n`);

const router = spawn(process.execPath, [join(root, "plugins/deepseek-subagent/scripts/router.mjs"), runtimeFile], {
  env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
router.stderr.setEncoding("utf8"); router.stderr.on("data", (chunk) => { stderr += chunk; });
const base = `http://127.0.0.1:${routerPort}/${routeToken}`;
async function prepare(name) {
  const response = await fetch(`${base}/delegations/prepare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskName: name, message: `Execute ${name}` }) });
  assert.equal(response.status, 201);
  return (await response.json()).taskName;
}
function payload(taskName, testMode) {
  return {
    model: "deepseek-flash", testMode,
    input: [{ type: "agent_message", role: "assistant", content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${taskName}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: `cipher-${taskName}` },
    ] }],
  };
}
async function invoke(taskName, mode) {
  return fetch(`${base}/v1/responses`, { method: "POST", headers: { authorization: "Bearer parent-must-not-forward", "content-type": "application/json" }, body: JSON.stringify(payload(taskName, mode)) });
}
async function invokeWithReasoning(taskName, id, encryptedContent) {
  const body = payload(taskName, "reasoning-continuation");
  body.input.push({ type: "reasoning", id, summary: [], encrypted_content: encryptedContent });
  return fetch(`${base}/v1/responses`, { method: "POST", headers: { authorization: "Bearer parent-must-not-forward", "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function readBytesPreservingAbort(response) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } catch {}
  return Buffer.concat(chunks);
}
async function resetPool() { revision++; await writeSettings(); }
function attempts(mode) { return seen.filter((entry) => entry.mode === mode).map((entry) => entry.authorization); }
function paths(mode) { return seen.filter((entry) => entry.mode === mode).map((entry) => entry.path); }

try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }

  let task = await prepare("balance_failover");
  let response = await invoke(task, "fail402");
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(attempts("fail402"), [`Bearer ${keyA}`, `Bearer ${keyB}`]);
  assert.deepEqual(paths("fail402"), ["/a/v1/responses", "/b/v1/responses"]);

  await resetPool(); task = await prepare("invalid_failover");
  response = await invoke(task, "fail401");
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(attempts("fail401"), [`Bearer ${keyA}`, `Bearer ${keyB}`]);

  await resetPool(); task = await prepare("all_exhausted");
  response = await invoke(task, "all402");
  assert.equal(response.status, 402);
  assert.match(await response.text(), /DeepSeek upstream returned HTTP 402/);
  assert.deepEqual(attempts("all402"), [`Bearer ${keyA}`, `Bearer ${keyB}`]);

  await resetPool(); task = await prepare("rate_limit");
  response = await invoke(task, "no-switch-429");
  assert.equal(response.status, 429); await response.text();
  assert.deepEqual(attempts("no-switch-429"), [`Bearer ${keyA}`]);

  await resetPool(); task = await prepare("server_error");
  response = await invoke(task, "no-switch-503");
  assert.equal(response.status, 503); await response.text();
  assert.deepEqual(attempts("no-switch-503"), [`Bearer ${keyA}`]);

  await resetPool(); task = await prepare("reflected_error");
  response = await invoke(task, "reflect-secret");
  assert.equal(response.status, 503);
  const reflectedHeaders = JSON.stringify([...response.headers]);
  const reflectedBody = await response.text();
  assert.equal(reflectedHeaders.includes(keyA) || reflectedHeaders.includes(keyB), false);
  assert.equal(reflectedBody.includes(keyA) || reflectedBody.includes(keyB), false);

  await resetPool(); task = await prepare("reflected_success_header");
  response = await invoke(task, "reflect-success-header");
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify([...response.headers]).includes(keyA), false);
  await response.text();

  await resetPool(); task = await prepare("reflected_success_body");
  response = await invoke(task, "reflect-success-body");
  const reflectedSuccessText = (await readBytesPreservingAbort(response)).toString("utf8");
  assert.equal(reflectedSuccessText.includes(keyA) || reflectedSuccessText.includes(keyB), false);

  await resetPool(); task = await prepare("reflected_sse_terminal");
  response = await invoke(task, "reflect-success-sse-terminal");
  const reflectedTerminalText = (await readBytesPreservingAbort(response)).toString("utf8");
  assert.equal(reflectedTerminalText.includes(keyA) || reflectedTerminalText.includes(keyB), false);
  assert.equal(reflectedTerminalText.includes("response.completed"), false, "A rejected terminal event was forwarded.");
  const rejectedReflectedContinuation = await invokeWithReasoning(task, "reasoning-reflected-terminal", "cipher-reflected-terminal");
  assert.equal(rejectedReflectedContinuation.status, 409, "A credential-reflecting SSE response committed reasoning provenance.");
  await rejectedReflectedContinuation.text();

  await resetPool(); task = await prepare("reflected_previous_key");
  response = await invoke(task, "reflect-previous-key");
  const reflectedPreviousText = (await readBytesPreservingAbort(response)).toString("utf8");
  assert.deepEqual(attempts("reflect-previous-key"), [`Bearer ${keyA}`, `Bearer ${keyB}`]);
  assert.equal(reflectedPreviousText.includes(keyA), false);

  await resetPool(); task = await prepare("network_error");
  response = await invoke(task, "network-drop");
  assert(response.status >= 500); await response.text();
  assert.deepEqual(attempts("network-drop"), [`Bearer ${keyA}`]);

  await resetPool(); task = await prepare("pinned_task");
  response = await invoke(task, "pin-success");
  assert.equal(response.status, 200); await response.text();
  response = await invoke(task, "pinned402");
  assert.equal(response.status, 402); await response.text();
  assert.deepEqual(attempts("pinned402"), [`Bearer ${keyA}`]);
  const seenBeforePinnedCooldown = seen.length;
  response = await invoke(task, "pinned-cooldown");
  assert.equal(response.status, 503); await response.text();
  assert.equal(seen.length, seenBeforePinnedCooldown, "A pinned exhausted key was retried before its cooldown expired.");

  await resetPool(); task = await prepare("concurrent_binding");
  const firstConcurrent = invoke(task, "concurrent-failover");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  const secondConcurrent = invoke(task, "concurrent-success");
  const [firstConcurrentResponse, secondConcurrentResponse] = await Promise.all([firstConcurrent, secondConcurrent]);
  assert.equal(firstConcurrentResponse.status, 200); await firstConcurrentResponse.text();
  assert.equal(secondConcurrentResponse.status, 200); await secondConcurrentResponse.text();
  assert.deepEqual(attempts("concurrent-failover"), [`Bearer ${keyA}`, `Bearer ${keyB}`]);
  assert.deepEqual(attempts("concurrent-success"), [`Bearer ${keyB}`], "Concurrent first turns did not share one credential binding decision.");

  await resetPool();
  const sharedFailure = await fetch(`${base}/control/credential-failure`, {
    method: "POST",
    headers: { authorization: `Bearer ${shutdownToken}`, "content-type": "application/json" },
    body: JSON.stringify({ revision, id: "key_aaaaaaaaaaaaaaaaaaaaaaaa", reason: "invalid" }),
  });
  assert.equal(sharedFailure.status, 204);
  task = await prepare("shared_failure_state");
  response = await invoke(task, "shared-state-success");
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(attempts("shared-state-success"), [`Bearer ${keyB}`]);

  await resetPool();
  task = await prepare("pin_before_replacement");
  response = await invoke(task, "pin-before-replacement");
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(attempts("pin-before-replacement"), [`Bearer ${keyA}`]);

  revision++;
  await writeFile(settingsFile, `${JSON.stringify({
    schemaVersion: 4, revision, model: "deepseek-flash",
    credentials: [
      { id: "key_dddddddddddddddddddddddd", label: "Replacement A", enabled: true, baseUrl: `http://127.0.0.1:${upstreamPort}/replacement/v1/`, apiKey: keyA },
      { id: "key_bbbbbbbbbbbbbbbbbbbbbbbb", label: "B", enabled: true, baseUrl: `http://127.0.0.1:${upstreamPort}/b/v1/`, apiKey: keyB },
    ],
  })}\n`);
  const seenBeforeReplacedPin = seen.length;
  response = await invoke(task, "replaced-pinned-secret");
  assert.equal(response.status, 503); await response.text();
  assert.equal(seen.length, seenBeforeReplacedPin, "A pinned task crossed to a replacement credential ID.");
  await resetPool();

  await resetPool(); task = await prepare("stream_once");
  try { response = await invoke(task, "sse-drop"); await response.text(); } catch {}
  assert.deepEqual(attempts("sse-drop"), [`Bearer ${keyA}`]);

  assert.equal(seen.some((entry) => entry.authorization === `Bearer ${keyDisabled}`), false);
  const health = await (await fetch(`${base}/healthz`)).json();
  assert(health.deepseekFailovers >= 3);
  assert.deepEqual(health.credentials.map((credential) => credential.id), ["key_aaaaaaaaaaaaaaaaaaaaaaaa", "key_cccccccccccccccccccccccc", "key_bbbbbbbbbbbbbbbbbbbbbbbb"]);
  assert.equal(JSON.stringify(health).includes(keyA) || JSON.stringify(health).includes(keyB), false);
  process.stdout.write("Router credential failover, pinning, non-retry, stream, and redaction tests passed\n");
} finally {
  router.kill("SIGTERM");
  upstream.close();
  await rm(temp, { recursive: true, force: true });
}
if (stderr) throw new Error(stderr);
