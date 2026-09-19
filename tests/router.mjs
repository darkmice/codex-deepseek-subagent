import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, brotliDecompressSync, deflateSync, gzipSync, gunzipSync, inflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(join(tmpdir(), "deepseek-router-test-"));
const settingsFile = join(temp, "settings.json");
const catalogFile = join(temp, "native-models.json");
const runtimeFile = join(temp, "runtime.json");
const routeToken = "a".repeat(48);
const instanceId = "b".repeat(48);
const shutdownToken = "c".repeat(48);
const requests = [];
const heldResponses = [];
const removedProviderCapBytes = 128 * 1024 * 1024;
const providerRequestMaxBytes = removedProviderCapBytes + 8 * 1024 * 1024;
const providerBufferedMaxBytes = providerRequestMaxBytes * 4;
let declaredOversizeClosed = false;
let streamedOversizeClosed = false;

const upstream = createServer(async (request, response) => {
  const declaredRequestBytes = Number(request.headers["content-length"] || 0);
  if (request.url.endsWith("/v1/responses") && declaredRequestBytes > removedProviderCapBytes) {
    let bodyLength = 0;
    let bodyPrefix = Buffer.alloc(0);
    for await (const chunk of request) {
      bodyLength += chunk.length;
      if (bodyPrefix.length < 4096) bodyPrefix = Buffer.concat([bodyPrefix, chunk.subarray(0, 4096 - bodyPrefix.length)]);
    }
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      encoding: request.headers["content-encoding"],
      body: bodyPrefix,
      bodyLength,
    });
    if (request.url.startsWith("/deepseek/")) {
      response.writeHead(413, { "content-type": "application/json" });
      response.end('{"error":{"message":"synthetic upstream payload limit"}}');
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"completed","ok":true}');
    }
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  requests.push({
    path: request.url,
    authorization: request.headers.authorization,
    encoding: request.headers["content-encoding"],
    ifNoneMatch: request.headers["if-none-match"],
    ifModifiedSince: request.headers["if-modified-since"],
    body: rawBody,
  });
  if (request.method === "GET" && request.url.startsWith("/parent/v1/models?")) {
    if (request.url.includes("force_304=1")) { response.writeHead(304, { etag: '"parent-etag"' }).end(); return; }
    if (request.url.includes("oversized=declared")) {
      response.writeHead(200, { "content-type": "application/json", "content-length": String(9 * 1024 * 1024) });
      const timer = setInterval(() => response.write(Buffer.alloc(1024)), 2);
      response.on("close", () => { clearInterval(timer); declaredOversizeClosed = true; });
      return;
    }
    if (request.url.includes("oversized=streamed")) {
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024);
      const timer = setInterval(() => response.write(chunk), 2);
      response.on("close", () => { clearInterval(timer); streamedOversizeClosed = true; });
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json", etag: '"parent-etag"', "cache-control": "max-age=3600",
      "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT", "content-md5": "stale", digest: "sha-256=stale",
      age: "12", expires: "Mon, 01 Jan 2035 00:00:00 GMT",
    });
    response.end(JSON.stringify({ models: [{ slug: "gpt-parent", supported_in_api: true, input_modalities: ["text", "image"] }] }));
    return;
  }
  const decodedBody = request.headers["content-encoding"] === "gzip" ? gunzipSync(rawBody)
    : request.headers["content-encoding"] === "br" ? brotliDecompressSync(rawBody)
      : request.headers["content-encoding"] === "deflate" ? inflateSync(rawBody) : rawBody;
  const payload = JSON.parse(decodedBody.toString("utf8"));
  if (payload.testMode === "seed-json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"id":"json-response","status":"completed","output":[');
    response.write('{"type":"reasoning","id":"reasoning-json","summary":[],"encrypted_content":"cipher-json"},');
    response.end('{"type":"function_call","call_id":"call-json","name":"view_image","arguments":"{}"}]}');
    return;
  }
  if (["failed", "incomplete", "cancelled"].some((status) => payload.testMode === `seed-json-${status}`)) {
    const status = payload.testMode.slice("seed-json-".length);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status, output: [{ type: "reasoning", id: `reasoning-${status}`, encrypted_content: `cipher-${status}` }] }));
    return;
  }
  if (payload.testMode === "seed-json-long-top-string") {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"status":"completed","irrelevant":"');
    for (let index = 0; index < 32; index++) response.write("x".repeat(1024));
    response.end('","output":[{"type":"reasoning","id":"reasoning-long","encrypted_content":"cipher-long"}]}');
    return;
  }
  if (payload.testMode === "seed-json-missing-comma") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"completed","output":[{"type":"reasoning","id":"reasoning-missing-comma","encrypted_content":"cipher-missing-comma"}] "junk":true}');
    return;
  }
  if (payload.testMode === "seed-json-missing-colon") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"output":[{"type":"reasoning","id":"reasoning-missing-colon","encrypted_content":"cipher-missing-colon"}],"status" "completed"}');
    return;
  }
  if (payload.testMode === "seed-json-duplicate-output") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"completed","output":[{"type":"reasoning","id":"reasoning-duplicate-output","encrypted_content":"cipher-duplicate-output"}],"output":[]}');
    return;
  }
  if (payload.testMode === "seed-json-duplicate-status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"completed","output":[{"type":"reasoning","id":"reasoning-duplicate-status","encrypted_content":"cipher-duplicate-status"}],"status":"completed"}');
    return;
  }
  if (payload.testMode === "seed-json-nonstring-status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":true,"output":[{"type":"reasoning","id":"reasoning-nonstring-status","encrypted_content":"cipher-nonstring-status"}]}');
    return;
  }
  if (payload.testMode === "seed-json-escaped-status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"complet\\u0065d","output":[{"type":"reasoning","id":"reasoning-escaped-status","encrypted_content":"cipher-escaped-status"}]}');
    return;
  }
  if (payload.testMode === "seed-json-illegal-whitespace") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"status":"completed","output":[{"type":"reasoning","id":"reasoning-illegal-whitespace","encrypted_content":"cipher-illegal-whitespace"}]}\u00a0`);
    return;
  }
  if (payload.testMode === "seed-json-bom-prefix") {
    response.writeHead(200, { "content-type": "application/json" });
    for (const byte of [0xef, 0xbb, 0xbf]) {
      response.write(Buffer.from([byte]));
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
    }
    response.end('{"status":"completed","output":[{"type":"reasoning","id":"reasoning-bom-prefix","encrypted_content":"cipher-bom-prefix"}]}');
    return;
  }
  if (payload.testMode === "seed-json-too-deep") {
    response.writeHead(200, { "content-type": "application/json" });
    const deep = "[".repeat(257) + "null" + "]".repeat(257);
    response.end(`{"status":"completed","output":[{"type":"reasoning","id":"reasoning-too-deep","encrypted_content":"cipher-too-deep"}],"padding":${deep}}`);
    return;
  }
  if (payload.testMode === "seed-json-byte-chunks") {
    response.writeHead(200, { "content-type": "application/json" });
    const body = Buffer.from('{"status":"complet\\u0065d","note":"雪","count":1.2e+3,"flag":true,"output":[{"type":"reasoning","id":"reasoning-byte-chunks","encrypted_content":"cipher-byte-chunks"}]}');
    for (const byte of body) response.write(Buffer.from([byte]));
    response.end();
    return;
  }
  if (payload.testMode === "seed-sse") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reasoning-sse","summary":[],"encrypted_content":"cipher-sse"}}\n\n');
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"sse-response"}}\n\n');
    return;
  }
  if (payload.testMode === "seed-sse-race") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reasoning-race","summary":[],"encrypted_content":"cipher-race"}}\n\n');
    response.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"sse-race"}}\n\n');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    response.end();
    return;
  }
  if (["incomplete", "cancelled"].some((status) => payload.testMode === `seed-sse-${status}`)) {
    const status = payload.testMode.slice("seed-sse-".length);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reasoning-sse-${status}","encrypted_content":"cipher-sse-${status}"}}\n\n`);
    response.end(`event: response.${status}\ndata: {"type":"response.${status}","response":{"status":"${status}"}}\n\n`);
    return;
  }
  if (payload.testMode === "seed-sse-done-only") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reasoning-sse-done-only","encrypted_content":"cipher-sse-done-only"}}\n\n');
    response.end("data: [DONE]\n\n");
    return;
  }
  if (payload.testMode === "seed-non-2xx") {
    response.writeHead(429, { "content-type": "application/json" });
    response.end('{"output":[{"type":"reasoning","id":"reasoning-error","encrypted_content":"cipher-error"}]}');
    return;
  }
  if (payload.testMode === "seed-malformed") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"output":[{"type":"reasoning","id":"reasoning-malformed","encrypted_content":"cipher-malformed"}');
    return;
  }
  if (payload.testMode === "hold") { heldResponses.push(response); return; }
  if (payload.testMode === "delay-followup") {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"completed","ok":true}');
    return;
  }
  if (payload.testMode === "stream") {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(1024 * 1024);
    const timer = setInterval(() => response.write(chunk), 2);
    response.on("close", () => clearInterval(timer));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"status":"completed","ok":true}');
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

const validSettingsText = `${JSON.stringify({
  schemaVersion: 2,
  revision: 1,
  model: "deepseek-flash",
  apiKey: "deepseek-test-key",
})}\n`;
await writeFile(settingsFile, validSettingsText);
const validCatalog = { models: [{ slug: "deepseek-flash", visibility: "hide", priority: 10_000, supported_in_api: true, input_modalities: ["text", "image"], supports_image_detail_original: true }] };
await writeFile(catalogFile, `${JSON.stringify(validCatalog)}\n`);
await writeFile(runtimeFile, `${JSON.stringify({
  schemaVersion: 2,
  routeToken,
  instanceId,
  shutdownToken,
  executionMode: "direct-test",
  port: routerPort,
  settingsFile,
  catalogFile,
  selectedModel: "deepseek-flash",
  deepseekBaseUrl: `http://127.0.0.1:${upstreamPort}/deepseek/v1/`,
  parentBaseUrl: `http://127.0.0.1:${upstreamPort}/parent/v1/`,
  parentModel: "gpt-parent",
  testTiming: {
    activeIdleTtlMs: 1000,
    activeAbsoluteTtlMs: 5000,
    providerRequestMaxBytes,
    providerBufferedMaxBytes,
  },
})}\n`);

const router = spawn(process.execPath, [join(root, "plugins/deepseek-subagent/scripts/router.mjs"), runtimeFile], {
  env: { ...process.env, NODE_ENV: "test" },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
router.stderr.setEncoding("utf8");
router.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  const healthUrl = `http://127.0.0.1:${routerPort}/${routeToken}/healthz`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(healthUrl)).ok) { ready = true; break; }
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert(ready, stderr);

  const models = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/models?client_version=0.154.0`, {
    headers: {
      authorization: "Bearer parent-model-auth", "if-none-match": '"stale"',
      "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT",
    },
  });
  assert.equal(models.status, 200);
  assert.equal(models.headers.has("etag"), false);
  assert.equal(models.headers.get("cache-control"), "no-store");
  for (const name of ["age", "content-md5", "digest", "expires", "last-modified"]) assert.equal(models.headers.has(name), false);
  const modelPayload = await models.json();
  assert.deepEqual(modelPayload.models.map((model) => model.slug), ["gpt-parent", "deepseek-flash"]);
  assert.deepEqual(modelPayload.models[1].input_modalities, ["text", "image"]);
  assert.equal(modelPayload.models[1].visibility, "hide");
  assert.equal(requests.at(-1).path, "/parent/v1/models?client_version=0.154.0");
  assert.equal(requests.at(-1).authorization, "Bearer parent-model-auth");
  assert.equal(requests.at(-1).ifNoneMatch, undefined);
  assert.equal(requests.at(-1).ifModifiedSince, undefined);

  await writeFile(catalogFile, `${JSON.stringify({ models: [{ ...validCatalog.models[0], visibility: "list", priority: 0 }] })}\n`);
  const unsafeCatalog = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/models?unsafe=1`, {
    headers: { authorization: "Bearer parent-model-auth" },
  });
  assert.equal(unsafeCatalog.status, 502);
  await writeFile(catalogFile, `${JSON.stringify(validCatalog)}\n`);

  const notModified = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/models?force_304=1`, {
    headers: { authorization: "Bearer parent-model-auth" },
  });
  assert.equal(notModified.status, 502);

  const declaredOversize = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/models?oversized=declared`, {
    headers: { authorization: "Bearer parent-model-auth" },
  });
  assert.equal(declaredOversize.status, 502);
  for (let attempt = 0; attempt < 50 && !declaredOversizeClosed; attempt++) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  assert.equal(declaredOversizeClosed, true);

  const streamedOversize = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/models?oversized=streamed`, {
    headers: { authorization: "Bearer parent-model-auth" },
  });
  assert.equal(streamedOversize.status, 502);
  for (let attempt = 0; attempt < 50 && !streamedOversizeClosed; attempt++) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  assert.equal(streamedOversizeClosed, true);

  const parentPayload = Buffer.from(JSON.stringify({
    model: "gpt-parent",
    input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "collaboration", tools: [{ name: "spawn_agent" }] }] }],
  }));
  const parent = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses?trace=preserved`, {
    method: "POST",
    headers: { authorization: "Bearer parent-tool-auth", "content-type": "application/json" },
    body: parentPayload,
  });
  assert.equal(parent.status, 200);
  assert.equal(requests.at(-1).path, "/parent/v1/responses?trace=preserved");
  assert.equal(requests.at(-1).authorization, "Bearer parent-tool-auth");
  assert.deepEqual(requests.at(-1).body, parentPayload);

  const prepare = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "bridge_probe", message: "Inspect the delegated image only." }),
  });
  assert.equal(prepare.status, 201);
  assert.equal(prepare.headers.get("cache-control"), "no-store");
  const prepared = await prepare.json();
  assert.match(prepared.taskName, /^bridge_probe_[a-f0-9]{24}$/);
  assert.equal(prepared.expiresInSeconds, 600);

  const secondPrepare = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "bridge_probe", message: "Message isolated to the second task." }),
  });
  assert.equal(secondPrepare.status, 201);
  const secondPrepared = await secondPrepare.json();
  assert.match(secondPrepared.taskName, /^bridge_probe_[a-f0-9]{24}$/);
  assert.notEqual(secondPrepared.taskName, prepared.taskName);

  const invalidPrepare = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "../escape", message: "must fail" }),
  });
  assert.equal(invalidPrepare.status, 400);
  const unreadablePrepare = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "task1", message: "must fail" }),
  });
  assert.equal(unreadablePrepare.status, 400);
  const unsupportedPrepareShape = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "bridge_probe", message: "must fail", kind: "message" }),
  });
  assert.equal(unsupportedPrepareShape.status, 400);

  const encryptedChildPayload = {
    model: "deepseek-flash",
    input: [{
      type: "agent_message", role: "assistant", author: "/root", recipient: `/root/${prepared.taskName}`, metadata: { providerOnly: true }, content: [
        { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${prepared.taskName}\nSender: /root\nPayload:\n` },
        { type: "encrypted_content", encrypted_content: "opaque-ciphertext" },
      ],
    }],
  };
  const bridgedChild = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret-must-not-leak", "content-type": "application/json", "x-codex-parent-thread-id": "unrelated-parent-id" },
    body: JSON.stringify(encryptedChildPayload),
  });
  assert.equal(bridgedChild.status, 200);
  const bridged = JSON.parse(requests.at(-1).body.toString("utf8"));
  assert.equal(requests.at(-1).authorization, "Bearer deepseek-test-key");
  assert.equal(bridged.input[0].type, "message");
  assert.equal(bridged.input[0].role, "user");
  assert.equal("author" in bridged.input[0], false);
  assert.equal("recipient" in bridged.input[0], false);
  assert.equal("metadata" in bridged.input[0], false);
  assert.equal(JSON.stringify(bridged).includes("opaque-ciphertext"), false);
  assert.equal(JSON.stringify(bridged).includes("Inspect the delegated image only."), true);
  assert.equal(JSON.stringify(bridged).includes("Message isolated to the second task."), false);

  const retriedChild = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret-must-not-leak", "content-type": "application/json" },
    body: JSON.stringify(encryptedChildPayload),
  });
  assert.equal(retriedChild.status, 200);
  const retried = JSON.parse(requests.at(-1).body.toString("utf8"));
  assert.equal(JSON.stringify(retried).includes("Inspect the delegated image only."), true);

  const secondTaskPayload = {
    ...encryptedChildPayload,
    input: [{ ...encryptedChildPayload.input[0], recipient: `/root/${secondPrepared.taskName}`, content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${secondPrepared.taskName}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: "second-opaque-ciphertext" },
    ] }],
  };
  const secondTaskChild = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret-must-not-leak", "content-type": "application/json" },
    body: JSON.stringify(secondTaskPayload),
  });
  assert.equal(secondTaskChild.status, 200);
  const bridgedSecond = JSON.parse(requests.at(-1).body.toString("utf8"));
  assert.equal(JSON.stringify(bridgedSecond).includes("Message isolated to the second task."), true);
  assert.equal(JSON.stringify(bridgedSecond).includes("Inspect the delegated image only."), false);

  const unknownEncryptedChild = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({
      ...encryptedChildPayload,
      input: [{ ...encryptedChildPayload.input[0], content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/not_prepared_deadbeefdeadbeefdeadbeef\nSender: /root\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "must-not-reach-upstream" },
      ] }],
    }),
  });
  assert.equal(unknownEncryptedChild.status, 409);
  assert.equal(requests.some((entry) => entry.body.includes?.("must-not-reach-upstream")), false);

  const unsupportedEncryptedChild = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      input: [{ type: "message", role: "user", content: [{ type: "encrypted_content", encrypted_content: "unsupported-encrypted-shape" }] }],
    }),
  });
  assert.equal(unsupportedEncryptedChild.status, 409);
  assert.equal(requests.some((entry) => entry.body.includes?.("unsupported-encrypted-shape")), false);

  const nestedEncryptedChild = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      input: [{ type: "reasoning", summary: [], encrypted_content: "nested-provider-ciphertext" }],
    }),
  });
  assert.equal(nestedEncryptedChild.status, 409);
  assert.equal(requests.some((entry) => entry.body.includes?.("nested-provider-ciphertext")), false);

  const metadataEnvelopeCipher = "metadata-envelope-must-not-bind-task";
  const metadataEnvelopeBypass = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "arbitrary unbound input" }] }],
      client_metadata: { content: [
        { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${prepared.taskName}\nSender: /root\nPayload:\n` },
        { type: "encrypted_content", encrypted_content: metadataEnvelopeCipher },
      ] },
    }),
  });
  assert.equal(metadataEnvelopeBypass.status, 409);
  assert.equal(requests.some((entry) => entry.body.includes?.(metadataEnvelopeCipher)), false);

  const duplicateEnvelopeCipher = "duplicate-envelope-must-not-reach-upstream";
  const duplicateEnvelope = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      input: [encryptedChildPayload.input[0], {
        ...encryptedChildPayload.input[0],
        content: [
          encryptedChildPayload.input[0].content[0],
          { type: "encrypted_content", encrypted_content: duplicateEnvelopeCipher },
        ],
      }],
    }),
  });
  assert.equal(duplicateEnvelope.status, 409);
  assert.equal(requests.some((entry) => entry.body.includes?.(duplicateEnvelopeCipher)), false);

  const jsonSeed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, testMode: "seed-json" }),
  });
  assert.equal(jsonSeed.status, 200);
  await jsonSeed.text();
  const jsonContinuationPayload = {
    ...encryptedChildPayload,
    testMode: "continuation-json",
    input: [...encryptedChildPayload.input, {
      type: "reasoning", id: "reasoning-json", summary: [], encrypted_content: "cipher-json",
    }, { type: "function_call_output", call_id: "call-json", output: "tool result" }],
  };
  const jsonContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify(jsonContinuationPayload),
  });
  assert.equal(jsonContinuation.status, 200);
  const jsonContinuedUpstream = JSON.parse(requests.at(-1).body.toString("utf8"));
  assert.equal(jsonContinuedUpstream.input.some((item) => item.id === "reasoning-json" && item.encrypted_content === "cipher-json"), true);

  const compactedJsonContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      previous_response_id: "json-response",
      testMode: "compacted-continuation-json",
      input: [{ type: "reasoning", id: "reasoning-json", summary: [], encrypted_content: "cipher-json" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Compacted task continuation." }] }],
    }),
  });
  assert.equal(compactedJsonContinuation.status, 200, await compactedJsonContinuation.clone().text());
  const compactedJsonUpstream = JSON.parse(requests.at(-1).body.toString("utf8"));
  assert.equal(compactedJsonUpstream.previous_response_id, "json-response");
  assert.equal(JSON.stringify(compactedJsonUpstream).includes("Compacted task continuation."), true);

  const unknownCompactedContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", previous_response_id: "unknown-response", input: [] }),
  });
  assert.equal(unknownCompactedContinuation.status, 409);

  const alteredJsonContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...jsonContinuationPayload, input: jsonContinuationPayload.input.map((item) =>
      item?.id === "reasoning-json" ? { ...item, encrypted_content: "cipher-json-altered" } : item) }),
  });
  assert.equal(alteredJsonContinuation.status, 409);
  assert.equal(requests.some((entry) => entry.body.includes?.("cipher-json-altered")), false);

  const crossTaskContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...secondTaskPayload, input: [...secondTaskPayload.input, jsonContinuationPayload.input[1]] }),
  });
  assert.equal(crossTaskContinuation.status, 409);

  for (const status of ["failed", "incomplete", "cancelled"]) {
    try {
      const unsuccessfulSeed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
        body: JSON.stringify({ ...encryptedChildPayload, testMode: `seed-json-${status}` }),
      });
      await unsuccessfulSeed.text();
    } catch {}
    const rejectedContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
      body: JSON.stringify({ ...encryptedChildPayload, input: [...encryptedChildPayload.input, {
        type: "reasoning", id: `reasoning-${status}`, encrypted_content: `cipher-${status}`,
      }] }),
    });
    assert.equal(rejectedContinuation.status, 409, `JSON ${status} response seeded reasoning provenance.`);
  }

  const longStringSeed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, testMode: "seed-json-long-top-string" }),
  });
  assert.equal(longStringSeed.status, 200);
  await longStringSeed.text();
  const longStringContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, input: [...encryptedChildPayload.input, {
      type: "reasoning", id: "reasoning-long", encrypted_content: "cipher-long",
    }] }),
  });
  assert.equal(longStringContinuation.status, 200);

  for (const malformed of [
    "missing-comma", "missing-colon", "duplicate-output", "duplicate-status", "nonstring-status",
    "illegal-whitespace", "bom-prefix", "too-deep",
  ]) {
    const upstreamRequestsBeforeMalformedSeed = requests.length;
    try {
      const malformedSemanticSeed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
        body: JSON.stringify({ ...encryptedChildPayload, testMode: `seed-json-${malformed}` }),
      });
      await malformedSemanticSeed.text();
    } catch {}
    assert(requests.length > upstreamRequestsBeforeMalformedSeed, `Malformed JSON ${malformed} fixture never reached upstream.`);
    assert.equal(JSON.parse(requests.at(-1).body.toString("utf8")).testMode, `seed-json-${malformed}`);
    const rejectedMalformedContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
      body: JSON.stringify({ ...encryptedChildPayload, input: [...encryptedChildPayload.input, {
        type: "reasoning", id: `reasoning-${malformed}`, encrypted_content: `cipher-${malformed}`,
      }] }),
    });
    assert.equal(rejectedMalformedContinuation.status, 409, `Malformed JSON ${malformed} response seeded reasoning provenance.`);
  }

  const escapedStatusSeed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, testMode: "seed-json-escaped-status" }),
  });
  assert.equal(escapedStatusSeed.status, 200);
  await escapedStatusSeed.text();
  const escapedStatusContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, input: [...encryptedChildPayload.input, {
      type: "reasoning", id: "reasoning-escaped-status", encrypted_content: "cipher-escaped-status",
    }] }),
  });
  assert.equal(escapedStatusContinuation.status, 200);

  const byteChunkSeed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, testMode: "seed-json-byte-chunks" }),
  });
  assert.equal(byteChunkSeed.status, 200);
  await byteChunkSeed.text();
  const byteChunkContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, input: [...encryptedChildPayload.input, {
      type: "reasoning", id: "reasoning-byte-chunks", encrypted_content: "cipher-byte-chunks",
    }] }),
  });
  assert.equal(byteChunkContinuation.status, 200);

  const mixedTaskRequest = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", input: [...encryptedChildPayload.input, ...secondTaskPayload.input] }),
  });
  assert.equal(mixedTaskRequest.status, 409);

  const sseSeed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...secondTaskPayload, testMode: "seed-sse" }),
  });
  assert.equal(sseSeed.status, 200);
  await sseSeed.text();
  const sseContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...secondTaskPayload, input: [...secondTaskPayload.input, {
      type: "reasoning", id: "reasoning-sse", summary: [], encrypted_content: "cipher-sse",
    }] }),
  });
  assert.equal(sseContinuation.status, 200);

  const compactedSseContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      previous_response_id: "sse-response",
      input: [{ type: "reasoning", id: "reasoning-sse", summary: [], encrypted_content: "cipher-sse" }],
    }),
  });
  assert.equal(compactedSseContinuation.status, 200);

  const raceStartedAt = Date.now();
  const sseRace = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...secondTaskPayload, testMode: "seed-sse-race" }),
  });
  assert.equal(sseRace.status, 200);
  const raceReader = sseRace.body.getReader();
  const raceDecoder = new TextDecoder();
  let raceText = "";
  while (!raceText.includes("response.completed")) {
    const { value, done } = await raceReader.read();
    assert.equal(done, false, "SSE race response ended before its completion event was visible.");
    raceText += raceDecoder.decode(value, { stream: true });
  }
  assert(Date.now() - raceStartedAt >= 150, "SSE completion was forwarded before upstream EOF committed provenance.");
  const raceContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...secondTaskPayload, input: [...secondTaskPayload.input, {
      type: "reasoning", id: "reasoning-race", encrypted_content: "cipher-race",
    }] }),
  });
  assert.equal(raceContinuation.status, 200, "Continuation raced ahead of SSE provenance commit.");
  await raceReader.cancel().catch(() => {});

  for (const terminal of ["incomplete", "cancelled", "done-only"]) {
    try {
      const unsuccessfulSse = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
        body: JSON.stringify({ ...secondTaskPayload, testMode: `seed-sse-${terminal}` }),
      });
      await unsuccessfulSse.text();
    } catch {}
    const rejectedSseContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
      body: JSON.stringify({ ...secondTaskPayload, input: [...secondTaskPayload.input, {
        type: "reasoning", id: `reasoning-sse-${terminal}`, encrypted_content: `cipher-sse-${terminal}`,
      }] }),
    });
    assert.equal(rejectedSseContinuation.status, 409, `SSE ${terminal} response seeded reasoning provenance.`);
  }

  const non2xxSeed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, testMode: "seed-non-2xx" }),
  });
  assert.equal(non2xxSeed.status, 429);
  const non2xxContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, input: [...encryptedChildPayload.input, {
      type: "reasoning", id: "reasoning-error", encrypted_content: "cipher-error",
    }] }),
  });
  assert.equal(non2xxContinuation.status, 409);

  const malformedSeed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, testMode: "seed-malformed" }),
  });
  await malformedSeed.text().catch(() => {});
  const malformedContinuation = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...encryptedChildPayload, input: [...encryptedChildPayload.input, {
      type: "reasoning", id: "reasoning-malformed", encrypted_content: "cipher-malformed",
    }] }),
  });
  assert.equal(malformedContinuation.status, 409);

  const outOfInputEncryptedChild = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      input: "ordinary input",
      client_metadata: { encrypted_content: "out-of-input-provider-ciphertext" },
    }),
  });
  assert.equal(outOfInputEncryptedChild.status, 409);
  assert.equal(requests.some((entry) => entry.body.includes?.("out-of-input-provider-ciphertext")), false);

  const payload = Buffer.from(JSON.stringify({ ...encryptedChildPayload, testMode: "compressed" }));
  const encodings = [
    ["gzip", gzipSync(payload)],
    ["br", brotliCompressSync(payload)],
    ["deflate", deflateSync(payload)],
  ];
  for (const [encoding, compressed] of encodings) {
    const routed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer parent-secret-must-not-leak",
        "content-type": "application/json",
        "content-encoding": encoding,
      },
      body: compressed,
    });
    assert.equal(routed.status, 200);
    const observed = requests.at(-1);
    assert.equal(observed.authorization, "Bearer deepseek-test-key");
    assert.equal(observed.encoding, undefined);
    const rewrittenCompressed = JSON.parse(observed.body.toString("utf8"));
    assert.equal(JSON.stringify(rewrittenCompressed).includes("Inspect the delegated image only."), true);
    assert.equal(JSON.stringify(rewrittenCompressed).includes("opaque-ciphertext"), false);
  }

  const unsupported = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-encoding": "compress" },
    body: payload,
  });
  assert.equal(unsupported.status, 415);
  const routedBeforeRejectedRequests = requests.filter((entry) => entry.path.startsWith("/deepseek/")).length;
  const staleDeepSeek = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-stale-model", input: "must not reach either upstream" }),
  });
  assert.equal(staleDeepSeek.status, 409);
  assert.equal(requests.filter((entry) => entry.path.startsWith("/deepseek/")).length, routedBeforeRejectedRequests);
  const oversizedPrepare = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/prepare`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "oversized_probe", message: "Fallback this oversized task to the parent provider." }),
  });
  assert.equal(oversizedPrepare.status, 201);
  const oversizedTask = (await oversizedPrepare.json()).taskName;
  const oversizedPayload = {
    ...encryptedChildPayload,
    model: "gpt-parent",
    input: [{ ...encryptedChildPayload.input[0], recipient: `/root/${oversizedTask}`, content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${oversizedTask}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: "oversized-envelope" },
    ] }],
    padding: "x".repeat(removedProviderCapBytes + 1024),
  };
  const expansionBomb = gzipSync(Buffer.from(JSON.stringify(oversizedPayload)));
  const oversized = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json", "content-encoding": "gzip" },
    body: expansionBomb,
  });
  assert.equal(oversized.status, 200);
  const oversizedFallback = requests.at(-1);
  assert.equal(oversizedFallback.path, "/parent/v1/responses");
  assert.equal(oversizedFallback.authorization, "Bearer parent-secret");
  assert.equal(oversizedFallback.encoding, undefined);
  assert(oversizedFallback.bodyLength > removedProviderCapBytes);
  assert.match(oversizedFallback.body.toString("utf8"), /^\{"model":"gpt-parent"/);
  const oversizedDeepSeek = requests.at(-2);
  assert.equal(oversizedDeepSeek.path, "/deepseek/v1/responses");
  assert.equal(oversizedDeepSeek.authorization, "Bearer deepseek-test-key");
  assert(oversizedDeepSeek.bodyLength > removedProviderCapBytes);
  assert.match(oversizedDeepSeek.body.toString("utf8"), /^\{"model":"deepseek-flash"/);
  assert.equal(requests.filter((entry) => entry.path.startsWith("/deepseek/")).length, routedBeforeRejectedRequests + 1);

  const compressedExpansionBomb = gzipSync(Buffer.from(JSON.stringify({
    model: "gpt-parent",
    padding: "z".repeat(providerRequestMaxBytes + 1024),
  })));
  const rejectedExpansion = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json", "content-encoding": "gzip" },
    body: compressedExpansionBomb,
  });
  assert.equal(rejectedExpansion.status, 413, "A compressed request expanded beyond the dynamic provider request budget.");
  assert.equal((await rejectedExpansion.json()).error.code, "PROVIDER_REQUEST_TOO_LARGE");

  const concurrencyPrepare = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/prepare`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "concurrency_probe", message: "Exercise provider concurrency after a large request." }),
  });
  assert.equal(concurrencyPrepare.status, 201);
  const concurrencyTask = (await concurrencyPrepare.json()).taskName;
  const concurrencyPayload = {
    ...encryptedChildPayload,
    input: [{ ...encryptedChildPayload.input[0], recipient: `/root/${concurrencyTask}`, content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${concurrencyTask}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: "concurrency-envelope" },
    ] }],
  };
  const concurrencySeed = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...concurrencyPayload, testMode: "after-large-seed" }),
  });
  assert.equal(concurrencySeed.status, 200);
  const holdRequests = Array.from({ length: 8 }, () => fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...concurrencyPayload, testMode: "hold" }),
  }));
  for (let attempt = 0; attempt < 100 && heldResponses.length < 8; attempt++) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.equal(heldResponses.length, 8);
  const overConcurrency = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", input: "ninth" }),
  });
  assert.equal(overConcurrency.status, 503);
  for (const held of heldResponses) held.end('{"status":"completed","ok":true}');
  await Promise.all(holdRequests);

  await new Promise((resolveAbort, rejectAbort) => {
    const request = httpRequest({
      hostname: "127.0.0.1", port: routerPort, path: `/${routeToken}/v1/responses`, method: "POST",
      headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    });
    request.once("error", (error) => { if (error.code === "ECONNRESET") resolveAbort(); else rejectAbort(error); });
    request.once("response", (response) => { response.destroy(); resolveAbort(); });
    request.end(JSON.stringify({ ...concurrencyPayload, testMode: "stream" }));
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const afterAbort = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify({ ...concurrencyPayload, testMode: "after-abort" }),
  });
  assert.equal(afterAbort.status, 200);
  const ttlPrepare = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/prepare`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "ttl_probe", message: "Verify active session refresh." }),
  });
  assert.equal(ttlPrepare.status, 201);
  const ttlTask = (await ttlPrepare.json()).taskName;
  const ttlPayload = {
    model: "deepseek-flash",
    input: [{ type: "agent_message", role: "assistant", content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${ttlTask}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: "ttl-envelope" },
    ] }],
  };
  const sendTtlRequest = () => fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer parent-secret", "content-type": "application/json" }, body: JSON.stringify(ttlPayload),
  });
  assert.equal((await sendTtlRequest()).status, 200);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
  assert.equal((await sendTtlRequest()).status, 200, "Active task did not refresh its idle TTL.");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
  assert.equal((await sendTtlRequest()).status, 200, "Second active request did not refresh its idle TTL.");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1100));
  assert.equal((await sendTtlRequest()).status, 409, "Expired active task was accepted.");

  const reusePrepare = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/prepare`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "router_reuse_probe", message: "Remember marker ORCHID-7319." }),
  });
  assert.equal(reusePrepare.status, 201);
  const reuseTask = (await reusePrepare.json()).taskName;
  const reuseEnvelope = (ciphertext, taskName = reuseTask) => ({
    type: "agent_message", role: "assistant", content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${taskName}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: ciphertext },
    ],
  });
  const reuseInitialPayload = { model: "deepseek-flash", input: [reuseEnvelope("reuse-first-envelope")] };
  assert.equal((await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify(reuseInitialPayload),
  })).status, 200);
  const followupMessage = "Return the marker remembered in the previous turn.";
  const stageFollowup = () => fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/followup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: `/root/${reuseTask}`, message: followupMessage }),
  });
  const stagedFollowup = await stageFollowup();
  assert.equal(stagedFollowup.status, 201);
  assert.equal((await stagedFollowup.json()).taskName, reuseTask);
  assert.equal((await stageFollowup()).status, 409, "A second pending follow-up was accepted.");
  const followupPayload = {
    model: "deepseek-flash",
    input: [reuseEnvelope("reuse-first-envelope"), reuseEnvelope("reuse-second-envelope")],
  };
  const followupResponse = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify(followupPayload),
  });
  assert.equal(followupResponse.status, 200);
  const followupUpstream = JSON.parse(requests.at(-1).body.toString("utf8"));
  assert.equal(JSON.stringify(followupUpstream).includes("Remember marker ORCHID-7319."), true);
  assert.equal(JSON.stringify(followupUpstream).includes(followupMessage), true);
  assert.equal(JSON.stringify(followupUpstream).includes("reuse-first-envelope"), false);
  assert.equal(JSON.stringify(followupUpstream).includes("reuse-second-envelope"), false);
  const committedReplayUpstreamCount = requests.length;
  const committedReplay = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify(followupPayload),
  });
  assert.equal(committedReplay.status, 409, "A committed follow-up retry was executed again.");
  assert.equal((await committedReplay.json()).error.code, "FOLLOWUP_REQUEST_REPLAYED");
  assert.equal(requests.length, committedReplayUpstreamCount, "A committed follow-up replay reached an upstream provider.");
  const concurrentFollowupMessage = "Verify concurrent retry idempotence.";
  const concurrentStage = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/followup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: reuseTask, message: concurrentFollowupMessage }),
  });
  assert.equal(concurrentStage.status, 201);
  const concurrentFollowupPayload = {
    model: "deepseek-flash", testMode: "delay-followup",
    input: [
      reuseEnvelope("reuse-first-envelope"),
      reuseEnvelope("reuse-second-envelope"),
      reuseEnvelope("reuse-third-envelope"),
    ],
  };
  const concurrentFollowups = await Promise.all([1, 2].map(() =>
    fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
      method: "POST", headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
      body: JSON.stringify(concurrentFollowupPayload),
    })));
  assert.deepEqual(concurrentFollowups.map((response) => response.status).sort(), [200, 409],
    "Concurrent retries of one prepared follow-up did not deterministically suppress one execution.");
  const concurrentRejection = concurrentFollowups.find((response) => response.status === 409);
  assert.equal((await concurrentRejection.json()).error.code, "FOLLOWUP_REQUEST_IN_PROGRESS");
  assert.equal(requests.filter((entry) => entry.path.startsWith("/deepseek/") &&
    entry.body.includes?.(concurrentFollowupMessage)).length, 1,
  "A concurrent follow-up replay reached the upstream provider more than once.");
  const retryAfterSetupFailureMessage = "Retry after a pre-upstream setup failure.";
  const retryAfterSetupFailureStage = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/followup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: reuseTask, message: retryAfterSetupFailureMessage }),
  });
  assert.equal(retryAfterSetupFailureStage.status, 201);
  const retryAfterSetupFailurePayload = {
    model: "deepseek-flash",
    input: [
      reuseEnvelope("reuse-first-envelope"),
      reuseEnvelope("reuse-second-envelope"),
      reuseEnvelope("reuse-third-envelope"),
      reuseEnvelope("reuse-fourth-envelope"),
    ],
  };
  const upstreamCountBeforeSetupFailure = requests.length;
  let setupFailure;
  await writeFile(settingsFile, "{invalid-json", "utf8");
  try {
    setupFailure = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
      method: "POST", headers: { authorization: "short", "content-type": "application/json" },
      body: JSON.stringify(retryAfterSetupFailurePayload),
    });
  } finally {
    await writeFile(settingsFile, validSettingsText, "utf8");
  }
  assert.equal(setupFailure.status, 401);
  assert.equal(requests.length, upstreamCountBeforeSetupFailure, "A setup failure unexpectedly reached an upstream provider.");
  const retriedAfterSetupFailure = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify(retryAfterSetupFailurePayload),
  });
  assert.equal(retriedAfterSetupFailure.status, 200, "A failed pre-upstream follow-up left its single-flight lock stuck.");
  assert.equal(requests.filter((entry) => entry.path.startsWith("/deepseek/") &&
    entry.body.includes?.(retryAfterSetupFailureMessage)).length, 1,
  "Retry after a pre-upstream setup failure did not execute exactly once.");
  const alteredHistory = { ...followupPayload, input: [
    reuseEnvelope("altered-first-envelope"), reuseEnvelope("reuse-second-envelope"), reuseEnvelope("reuse-third-envelope"),
  ] };
  assert.equal((await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer parent-secret", "content-type": "application/json" },
    body: JSON.stringify(alteredHistory),
  })).status, 409, "Altered follow-up history was accepted.");
  const unboundFollowup = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/followup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "not_prepared_deadbeefdeadbeefdeadbeef", message: "must fail" }),
  });
  assert.equal(unboundFollowup.status, 409);

  const absolutePrepare = await fetch(`http://127.0.0.1:${routerPort}/${routeToken}/delegations/prepare`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskName: "absolute_ttl_probe", message: "Verify the active session absolute TTL." }),
  });
  assert.equal(absolutePrepare.status, 201);
  const absoluteTask = (await absolutePrepare.json()).taskName;
  const absolutePayload = {
    model: "deepseek-flash",
    input: [{ type: "agent_message", role: "assistant", content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/${absoluteTask}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: "absolute-ttl-envelope" },
    ] }],
  };
  const sendAbsoluteRequest = () => fetch(`http://127.0.0.1:${routerPort}/${routeToken}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer parent-secret", "content-type": "application/json" }, body: JSON.stringify(absolutePayload),
  });
  const absoluteStartedAt = Date.now();
  while (Date.now() - absoluteStartedAt < 4_500) {
    assert.equal((await sendAbsoluteRequest()).status, 200, "Active task expired before its absolute TTL.");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
  }
  const remainingAbsoluteWait = Math.max(0, 5_100 - (Date.now() - absoluteStartedAt));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, remainingAbsoluteWait));
  assert.equal((await sendAbsoluteRequest()).status, 409, "Active task exceeded its absolute TTL.");
  const health = await (await fetch(healthUrl)).json();
  const deepseekUpstreamCount = requests.filter((entry) => entry.path.startsWith("/deepseek/")).length;
  const parentUpstreamCount = requests.filter((entry) => entry.path.startsWith("/parent/")).length;
  assert.equal(health.deepseekRequests, deepseekUpstreamCount);
  assert.equal(health.deepseekUpstreamResponses, deepseekUpstreamCount);
  assert.equal(health.parentRequests, parentUpstreamCount);
  assert.equal(health.parentUpstreamResponses, parentUpstreamCount);
  assert.equal(health.delegationsPrepared, 7);
  assert.equal(health.followupsPrepared, 3);
  assert.equal(health.delegationsInjected, deepseekUpstreamCount + 1);
  assert.equal(health.parentFallbackRequests, 1);
  assert.equal(health.payloadTooLargeFallbacks, 1);
  assert.equal(health.providerRequestMaxBytes, providerRequestMaxBytes);
  assert.equal(health.providerBufferedMaxBytes, providerBufferedMaxBytes);
  assert.equal(health.providerBufferedBytes, 0);
  assert(health.delegationMisses >= 10);
  process.stdout.write("Router model catalog, prepared delegation bridge, payload preservation, compression, and authorization tests passed\n");
} finally {
  if (router.exitCode === null && router.signalCode === null) {
    const closed = new Promise((resolveClose) => router.once("close", resolveClose));
    router.kill("SIGTERM");
    await closed;
  }
  upstream.close();
  await rm(temp, { recursive: true, force: true });
}
