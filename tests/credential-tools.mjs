import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CredentialRuntimePool,
  credentialsFromSettingsDocument,
  mergeCredentialStatuses,
} from "../plugins/deepseek-subagent/scripts/credential-pool.mjs";

const unitCredentials = [
  { id: "key_aaaaaaaaaaaaaaaaaaaaaaaa", label: "A", enabled: true, baseUrl: "https://api-a.example/v1/", apiKey: "unit-test-key-a" },
  { id: "key_bbbbbbbbbbbbbbbbbbbbbbbb", label: "B", enabled: true, baseUrl: "https://api-b.example/v1/", apiKey: "unit-test-key-b" },
];
const unitPool = new CredentialRuntimePool({ exhaustedCooldownMs: 1_000 });
unitPool.sync(1);
unitPool.markFailure(unitCredentials[0].id, "exhausted", 100);
unitPool.markSuccess(unitCredentials[1].id);
assert.deepEqual(unitPool.candidates(unitCredentials, { now: 1_099 }).map((credential) => credential.id), [unitCredentials[1].id]);
assert.deepEqual(unitPool.candidates(unitCredentials, { now: 1_100 }).map((credential) => credential.id), unitCredentials.map((credential) => credential.id));
unitPool.markFailure(unitCredentials[0].id, "invalid", 2_000);
assert.deepEqual(unitPool.candidates(unitCredentials, { now: Number.MAX_SAFE_INTEGER }).map((credential) => credential.id), [unitCredentials[1].id]);
unitPool.sync(1);
assert.deepEqual(unitPool.candidates(unitCredentials).map((credential) => credential.id), [unitCredentials[1].id]);
unitPool.sync(2);
assert.deepEqual(unitPool.candidates(unitCredentials).map((credential) => credential.id), unitCredentials.map((credential) => credential.id));
assert.equal(mergeCredentialStatuses(
  new Map([[unitCredentials[0].id, { status: "invalid" }]]),
  new Map([[unitCredentials[0].id, { status: "ready" }]]),
).get(unitCredentials[0].id).status, "invalid");
const migratedV3 = credentialsFromSettingsDocument({
  schemaVersion: 3,
  revision: 9,
  model: "deepseek-flash",
  baseUrl: "https://legacy-proxy.example/v1/",
  credentials: unitCredentials.map(({ baseUrl: _baseUrl, ...credential }) => credential),
});
assert(migratedV3.every((credential) => credential.baseUrl === "https://legacy-proxy.example/v1/"));
assert.throws(() => credentialsFromSettingsDocument({
  schemaVersion: 4,
  revision: 10,
  model: "deepseek-flash",
  baseUrl: "https://global-is-forbidden.example/v1/",
  credentials: unitCredentials,
}), /invalid/);
const reusedKeyAcrossEndpoints = credentialsFromSettingsDocument({
  schemaVersion: 4,
  revision: 11,
  model: "deepseek-flash",
  credentials: [
    { ...unitCredentials[0], apiKey: "shared-test-key" },
    { ...unitCredentials[1], apiKey: "shared-test-key" },
  ],
});
assert.deepEqual(reusedKeyAcrossEndpoints.map((credential) => credential.baseUrl), [
  "https://api-a.example/v1/",
  "https://api-b.example/v1/",
]);
assert.throws(() => credentialsFromSettingsDocument({
  schemaVersion: 4,
  revision: 12,
  model: "deepseek-flash",
  credentials: [unitCredentials[0], { ...unitCredentials[1], baseUrl: unitCredentials[0].baseUrl, apiKey: unitCredentials[0].apiKey }],
}), /duplicate ID or connection/);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(join(tmpdir(), "deepseek-credential-tools-"));
const codexHome = join(temp, "codex-home");
const settingsFile = join(temp, "settings.json");
const secrets = Array.from({ length: 10 }, (_, index) => `test-only-api-key-${index}`);
const upstreamAttempts = [];
const propagatedFailures = [];
const routeToken = "a".repeat(48);
const instanceId = "b".repeat(48);
const shutdownToken = "c".repeat(48);
const upstream = createServer(async (request, response) => {
  if (request.url === `/${routeToken}/healthz`) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", instanceId, credentials: [{ id: "legacy_primary", status: "ready" }] }));
    return;
  }
  if (request.url === `/${routeToken}/control/credential-failure`) {
    assert.equal(request.headers.authorization, `Bearer ${shutdownToken}`);
    let body = ""; for await (const chunk of request) body += chunk;
    propagatedFailures.push(JSON.parse(body));
    response.writeHead(204).end();
    return;
  }
  upstreamAttempts.push(request.headers.authorization);
  if (request.headers.authorization === `Bearer ${secrets[0]}`) {
    response.writeHead(402, { "content-type": "application/json" }); response.end('{"error":{"message":"insufficient balance"}}'); return;
  }
  if (request.url?.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":[{"id":"deepseek-mock-a"}]}'); return;
  }
  if (request.url?.endsWith("/responses")) {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"completed","output":[]}'); return;
  }
  response.writeHead(404).end();
});
await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
const upstreamBaseUrl = `http://127.0.0.1:${upstream.address().port}/v1/`;
await mkdir(codexHome, { recursive: true });
await writeFile(join(codexHome, "config.toml"), "[features.multi_agent_v2]\nenabled = true\n");
await writeFile(settingsFile, `${JSON.stringify({ schemaVersion: 2, revision: 4, model: "", apiKey: secrets[0], baseUrl: upstreamBaseUrl })}\n`);
await writeFile(join(temp, "router-runtime.json"), `${JSON.stringify({ port: upstream.address().port, routeToken, instanceId, shutdownToken })}\n`);

const child = spawn(process.execPath, [join(root, "plugins/deepseek-subagent/scripts/server.mjs")], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "test", CODEX_HOME: codexHome, DEEPSEEK_SUBAGENT_CONFIG_DIR: temp, DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE: settingsFile, DEEPSEEK_SUBAGENT_RUNTIME_MODE: "direct" },
  stdio: ["pipe", "pipe", "pipe"],
});
let output = "", stderr = "", buffer = "", nextId = 1;
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk; buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n"); if (newline < 0) break;
    const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
    pending.get(message.id)?.(message); pending.delete(message.id);
  }
});
child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
function rpc(name, args = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  return new Promise((resolveRpc, rejectRpc) => {
    const timer = setTimeout(() => rejectRpc(new Error(`timeout: ${name}`)), 10_000);
    pending.set(id, (message) => { clearTimeout(timer); resolveRpc(message.result); });
  });
}

try {
  let result = await rpc("deepseek_settings");
  assert.equal(result.structuredContent.schemaVersion, 4);
  assert.equal(result.structuredContent.revision, 4);
  assert.deepEqual(result.structuredContent.credentials, [{ id: "legacy_primary", label: "Primary", enabled: true, baseUrl: upstreamBaseUrl, priority: 1, status: "ready" }]);

  const concurrent = await Promise.all([
    rpc("deepseek_credential_add", { expectedRevision: 4, label: "Backup 1", baseUrl: `${upstreamBaseUrl}backup-1/`, apiKey: secrets[1] }),
    rpc("deepseek_credential_add", { expectedRevision: 4, label: "Conflict", baseUrl: `${upstreamBaseUrl}backup-2/`, apiKey: secrets[2] }),
  ]);
  assert.equal(concurrent.filter((value) => value.isError).length, 1);
  result = concurrent.find((value) => !value.isError);
  let revision = result.structuredContent.revision;
  assert.equal(revision, 5);
  assert.equal(result.structuredContent.credentials.length, 2);
  const usedSecret = result.structuredContent.credentials.some((credential) => credential.label === "Backup 1") ? secrets[1] : secrets[2];
  const unusedSecret = usedSecret === secrets[1] ? secrets[2] : secrets[1];
  const modelsResult = await rpc("deepseek_models_list", { force: true });
  assert.equal(modelsResult.isError, undefined, JSON.stringify(modelsResult));
  assert.deepEqual(upstreamAttempts, [`Bearer ${secrets[0]}`, `Bearer ${usedSecret}`]);
  assert.deepEqual(propagatedFailures, [{ revision: 5, id: "legacy_primary", reason: "exhausted" }]);
  result = await rpc("deepseek_settings");
  assert.equal(result.structuredContent.credentials[0].status, "exhausted");
  assert.equal(result.structuredContent.credentials[1].status, "ready");

  for (let index = 2; index < 8; index++) {
    const apiKey = index === 2 ? unusedSecret : secrets[index];
    result = await rpc("deepseek_credential_add", { expectedRevision: revision, label: `Backup ${index}`, baseUrl: `${upstreamBaseUrl}backup-${index}/`, apiKey });
    assert.equal(result.isError, undefined);
    revision = result.structuredContent.revision;
  }
  assert.equal(result.structuredContent.credentials.length, 8);
  const ninth = await rpc("deepseek_credential_add", { expectedRevision: revision, label: "Too many", baseUrl: `${upstreamBaseUrl}too-many/`, apiKey: secrets[9] });
  assert.equal(ninth.isError, true);
  const duplicate = await rpc("deepseek_credential_add", { expectedRevision: revision, label: "Duplicate", baseUrl: upstreamBaseUrl, apiKey: secrets[0] });
  assert.equal(duplicate.isError, true);

  const connectionToReplace = result.structuredContent.credentials[1];
  result = await rpc("deepseek_credential_update", {
    expectedRevision: revision,
    id: connectionToReplace.id,
    label: connectionToReplace.label,
    baseUrl: `${upstreamBaseUrl}replacement/`,
    enabled: connectionToReplace.enabled,
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  revision = result.structuredContent.revision;
  assert.notEqual(result.structuredContent.credentials[1].id, connectionToReplace.id, "Changing an endpoint retained a connection ID that an active task may have pinned.");

  const first = result.structuredContent.credentials[0];
  result = await rpc("deepseek_credential_update", { expectedRevision: revision, id: first.id, label: "Primary renamed", baseUrl: first.baseUrl, enabled: false });
  revision = result.structuredContent.revision;
  assert.equal(result.structuredContent.enabledCredentialCount, 7);
  assert.equal(result.structuredContent.credentials[0].status, "disabled");
  result = await rpc("deepseek_credential_move", { expectedRevision: revision, id: first.id, direction: "down" });
  revision = result.structuredContent.revision;
  assert.equal(result.structuredContent.credentials[1].id, first.id);
  result = await rpc("deepseek_credential_remove", { expectedRevision: revision, id: first.id });
  revision = result.structuredContent.revision;
  assert.equal(result.structuredContent.credentials.length, 7);

  result = await rpc("deepseek_credential_delete", { expectedRevision: revision });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.credentialConfigured, false);
  assert.deepEqual(result.structuredContent.credentials, []);
  revision = result.structuredContent.revision;
  result = await rpc("deepseek_credential_add", { expectedRevision: revision, label: "Legacy compatibility", baseUrl: upstreamBaseUrl, apiKey: secrets[8] });
  revision = result.structuredContent.revision;
  const legacyCompatibilityId = result.structuredContent.credentials[0].id;
  result = await rpc("deepseek_credential_update", { expectedRevision: revision, id: legacyCompatibilityId, label: "Legacy compatibility", baseUrl: upstreamBaseUrl, enabled: false });
  revision = result.structuredContent.revision;
  result = await rpc("deepseek_credential_set", { expectedRevision: revision, baseUrl: upstreamBaseUrl });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.credentials[0].enabled, false, "Legacy save without a new secret re-enabled a disabled key.");
  assert.equal(result.structuredContent.credentials[0].id, legacyCompatibilityId);
  revision = result.structuredContent.revision;
  result = await rpc("deepseek_credential_set", { expectedRevision: revision, baseUrl: upstreamBaseUrl, apiKey: secrets[9] });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.credentials[0].enabled, true);
  assert.notEqual(result.structuredContent.credentials[0].id, legacyCompatibilityId, "Replacing a secret reused an ID that may be pinned by an active task.");
  revision = result.structuredContent.revision;
  result = await rpc("deepseek_credential_delete", { expectedRevision: revision });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const stored = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(stored.schemaVersion, 4);
  assert.equal(Object.hasOwn(stored, "apiKey"), false);
  assert.equal(Object.hasOwn(stored, "baseUrl"), false);
  assert.deepEqual(stored.credentials, []);
  await writeFile(settingsFile, `${JSON.stringify({ ...stored, unexpected: true })}\n`);
  const strictSchema = await rpc("deepseek_settings");
  assert.equal(strictSchema.isError, true, "Schema v4 accepted an unknown top-level field.");
  const { credentials: _credentials, ...missingCredentials } = stored;
  await writeFile(settingsFile, `${JSON.stringify(missingCredentials)}\n`);
  const missingPool = await rpc("deepseek_settings");
  assert.equal(missingPool.isError, true, "Schema v4 accepted a missing credentials array.");
  for (const secret of secrets) assert.equal(output.includes(secret) || stderr.includes(secret), false);
  process.stdout.write("Credential migration, cooldown order, status merge, legacy compatibility, strict schema, pool mutation, and redaction tests passed\n");
} finally {
  child.kill("SIGTERM");
  upstream.close();
  await rm(temp, { recursive: true, force: true });
}
if (stderr) throw new Error(stderr);
