import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { installRuntimeRouter, removeRuntimeRouter, runtimePaths } from "../plugins/deepseek-subagent/scripts/runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
const codexBin = process.env.CODEX_BIN || (existsSync(desktopCodex) ? desktopCodex : "codex");
const codexAuthFile = process.env.CODEX_AUTH_FILE;
assert.equal(process.env.RUN_DEEPSEEK_PARENT_LIVE, "1", "Set RUN_DEEPSEEK_PARENT_LIVE=1 to acknowledge this test sends a minimal prompt to the real ChatGPT upstream.");
assert(codexAuthFile && existsSync(codexAuthFile), "Set CODEX_AUTH_FILE to a logged-in Codex auth.json for the parent-router live test.");

const temp = await mkdtemp(join(tmpdir(), "deepseek-parent-router-live-"));
const codexHome = join(temp, "codex-home");
const settingsDir = join(temp, "settings");
const paths = runtimePaths(settingsDir, codexHome);
process.env.NODE_ENV = "test";
process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE = paths.settingsFile;
process.env.DEEPSEEK_SUBAGENT_RUNTIME_MODE = "direct";
let parentRequests = 0;
let modelRequests = 0;
const upstream = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  parentRequests++;
  if (request.method === "GET" && request.url.startsWith("/chatgpt/models?")) modelRequests++;
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(request.headers)) {
    if (["host", "content-length", "connection", "accept-encoding"].includes(name)) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) if (typeof value === "string") headers.append(name, value);
  }
  const target = new URL(request.url.replace(/^\/chatgpt\/?/, ""), "https://chatgpt.com/backend-api/codex/");
  const forwarded = await fetch(target, {
    method: request.method, headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks),
    redirect: "error",
  });
  const responseHeaders = {};
  for (const [name, value] of forwarded.headers) {
    if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name)) responseHeaders[name] = value;
  }
  response.writeHead(forwarded.status, responseHeaders);
  if (!forwarded.body) response.end();
  else Readable.fromWeb(forwarded.body).on("error", () => response.destroy()).pipe(response);
});
await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
const upstreamPort = upstream.address().port;

try {
  await mkdir(codexHome, { recursive: true });
  await mkdir(settingsDir, { recursive: true });
  await copyFile(codexAuthFile, join(codexHome, "auth.json"));
  if (process.platform !== "win32") await chmod(join(codexHome, "auth.json"), 0o600);
  await writeFile(paths.settingsFile, `${JSON.stringify({ schemaVersion: 2, revision: 1, model: "deepseek-flash", apiKey: "unused-live-test-key" })}\n`);
  const template = JSON.parse(await readFile(join(root, "plugins/deepseek-subagent/assets/model-template.json"), "utf8"));
  await writeFile(paths.catalogFile, `${JSON.stringify({ models: [{ ...template, slug: "deepseek-flash", display_name: "deepseek-flash", supported_in_api: true, input_modalities: ["text", "image"], supports_image_detail_original: true }] })}\n`);
  const originalConfig = `model = "gpt-5.6-sol"\nmodel_provider = "custom"\n\n[features.multi_agent_v2]\nenabled = true\nhide_spawn_agent_metadata = false\n\n[model_providers.custom]\nname = "custom"\nrequires_openai_auth = true\nwire_api = "responses"\n`;
  await writeFile(paths.codexConfig, originalConfig);
  await installRuntimeRouter({
    paths,
    routerSourceFile: join(root, "plugins/deepseek-subagent/scripts/router.mjs"),
    nodeExecutable: process.execPath,
    selectedModel: "deepseek-flash",
    deepseekBaseUrl: "http://127.0.0.1:9/v1/",
    parentBaseUrl: `http://127.0.0.1:${upstreamPort}/chatgpt/`,
  });

  const result = await new Promise((resolveRun) => {
    const child = spawn(codexBin, ["exec", "--json", "--skip-git-repo-check", "-c", 'approval_policy="never"', "-s", "read-only", "-C", root, "Reply with exactly PARENT_ROUTER_OK."], {
      env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    let forced = null;
    const terminate = setTimeout(() => {
      child.kill("SIGTERM");
      forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, 120_000);
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      clearTimeout(terminate);
      clearTimeout(forced);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
  const auth = JSON.parse(await readFile(codexAuthFile, "utf8"));
  const secretValues = [auth?.OPENAI_API_KEY, ...Object.values(auth?.tokens || {})].filter((value) => typeof value === "string" && value.length >= 8);
  assert(secretValues.every((secret) => !result.stdout.includes(secret) && !result.stderr.includes(secret)), "Codex output exposed a value from the live auth fixture.");
  assert.equal(result.code, 0, `live Codex exited with code=${result.code} signal=${result.signal}; stdout bytes=${Buffer.byteLength(result.stdout)} stderr bytes=${Buffer.byteLength(result.stderr)}`);
  assert(result.stdout.includes("PARENT_ROUTER_OK"), "Live parent response did not contain the expected sentinel.");
  assert(parentRequests > 0, "Parent request never passed through the loopback router.");
  assert(modelRequests > 0, "The live gate did not exercise the parent /models merge path.");
  assert(!result.stderr.includes("failed to refresh available models"), "The live parent model catalog refresh failed.");
  await removeRuntimeRouter(paths);
  assert.equal(await readFile(paths.codexConfig, "utf8"), originalConfig);
  process.stdout.write(`Parent router live test passed with ${codexBin}\n`);
} finally {
  await removeRuntimeRouter(paths).catch(() => {});
  upstream.close();
  await rm(temp, { recursive: true, force: true });
}
