import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installNativeIntegration,
  nativeIntegrationStatus,
  nativePaths,
  reconcileNativeCleanup,
  removeNativeIntegration,
  validateLegacyCredentialHelper,
  withNativeMutationLock,
} from "./native-config.mjs";

const SERVER_NAME = "deepseek-settings";
const SERVER_VERSION = "0.6.0+codex.20260916122412";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(SCRIPT_DIR);
const MODEL_TEMPLATE = join(PLUGIN_DIR, "assets", "model-template.json");
const SETTINGS_HTML = join(PLUGIN_DIR, "assets", "settings.html");
const SETTINGS_DIR = settingsDirectory();
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const SETTINGS_RESOURCE_URI = "ui://deepseek-subagent/settings/v5.html";
const LEGACY_SETTINGS_RESOURCE_URIS = ["ui://deepseek-subagent/settings/v4.html", "ui://deepseek-subagent/settings/v3.html", "ui://deepseek-subagent/settings/v2.html", "ui://deepseek-subagent/settings/v1.html"];
const SETTINGS_MIME_TYPE = "text/html;profile=mcp-app";
const OFFICIAL_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1/";
const TEST_DEEPSEEK_BASE_URL = process.env.NODE_ENV === "test" && process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE === SETTINGS_FILE
  ? process.env.DEEPSEEK_SUBAGENT_API_BASE_URL
  : "";
const DEFAULT_DEEPSEEK_BASE_URL = normalizeApiBaseUrl(TEST_DEEPSEEK_BASE_URL || OFFICIAL_DEEPSEEK_BASE_URL);
const DEFAULT_SETTINGS = Object.freeze({ schemaVersion: 2, revision: 0, model: "", apiKey: null, baseUrl: DEFAULT_DEEPSEEK_BASE_URL });
const MODEL_ID_PATTERN = /^deepseek-[A-Za-z0-9][A-Za-z0-9._:/-]{0,118}$/;
const RESPONSES_MODELS_NOT_LISTED_BY_API = Object.freeze(["deepseek-flash"]);
const MODELS_CACHE_MS = 5 * 60 * 1000;
const MAX_DELEGATION_MESSAGE_BYTES = 512 * 1024;
const TASK_BASE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
let modelsCache = null;
let settingsMutationQueue = Promise.resolve();
let cleanupReconcileTimer = null;
let cleanupReconcileDueAt = 0;
let cleanupReconcileRetryMs = 250;

function settingsDirectory() {
  const testDir = process.env.DEEPSEEK_SUBAGENT_CONFIG_DIR;
  if (process.env.NODE_ENV === "test" && testDir && process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE === join(testDir, "settings.json")) {
    return testDir;
  }
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "DeepSeek Subagent");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "DeepSeek Subagent");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "deepseek-subagent");
}

function normalizeApiBaseUrl(value) {
  if (typeof value !== "string" || value !== value.trim() || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 2048) {
    throw new Error("DeepSeek API base URL must be 1–2048 UTF-8 bytes with no leading or trailing whitespace.");
  }
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error("DeepSeek API base URL must be an absolute HTTPS URL."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("DeepSeek API base URL must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (parsed.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error("DeepSeek API base URL must use HTTPS unless it is loopback-only.");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function emptyObjectSchema() {
  return { type: "object", properties: {}, additionalProperties: false };
}

function modelIdSchema() {
  return { type: "string", minLength: 1, maxLength: 128, pattern: MODEL_ID_PATTERN.source };
}

function settingsOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "revision", "model", "baseUrl", "credentialConfigured", "credentialMask", "nativeReady", "message"],
    properties: {
      schemaVersion: { type: "integer", const: 2 }, revision: { type: "integer", minimum: 0 },
      model: { type: "string", maxLength: 128 }, baseUrl: { type: "string", minLength: 1, maxLength: 2048, format: "uri" }, credentialConfigured: { type: "boolean" },
      credentialMask: { type: "string", enum: ["", "••••••••"] },
      nativeReady: { type: "boolean" }, message: { type: "string" },
    },
  };
}

function modelsOutputSchema() {
  return {
    type: "object", additionalProperties: false, required: ["models", "selectedModel", "message"],
    properties: {
      models: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["id"],
          properties: { id: modelIdSchema(), ownedBy: { type: "string" } },
        },
      },
      selectedModel: { type: "string", maxLength: 128 }, message: { type: "string" },
    },
  };
}

function delegationOutputSchema() {
  return {
    type: "object", additionalProperties: false,
    required: ["taskName", "expiresInSeconds", "message"],
    properties: {
      taskName: { type: "string", minLength: 1, maxLength: 256 },
      expiresInSeconds: { type: "integer", minimum: 1, maximum: 3600 },
      message: { type: "string" },
    },
  };
}

const tools = [
  {
    name: "deepseek_settings", title: "DeepSeek Subagent",
    description: "Open or read native DeepSeek subagent settings only when the user explicitly requests setup or configuration. Never use this tool as a routine delegation readiness check; deepseek_delegation_prepare performs that check without rendering the settings UI. Never returns the API key.",
    inputSchema: emptyObjectSchema(), outputSchema: settingsOutputSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      ui: { resourceUri: SETTINGS_RESOURCE_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": SETTINGS_RESOURCE_URI,
      "openai/ui": { entrypoints: [{ type: "settings", searchTerms: ["DeepSeek", "subagent", "API key", "model", "子智能体", "模型"] }] },
      "openai/toolInvocation/invoking": "Loading DeepSeek settings",
      "openai/toolInvocation/invoked": "DeepSeek settings ready",
    },
  },
  {
    name: "deepseek_delegation_prepare", title: "Prepare native DeepSeek delegation",
    description: "Stage one explicit task message in short-lived loopback memory before native spawn_agent. Returns the randomized task name to pass to spawn_agent; it never calls a model.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["taskName", "message"],
      properties: {
        taskName: { type: "string", minLength: 1, maxLength: 256 },
        message: { type: "string", minLength: 1, maxLength: MAX_DELEGATION_MESSAGE_BYTES },
      },
    },
    outputSchema: delegationOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: {
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Preparing native DeepSeek delegation",
      "openai/toolInvocation/invoked": "Native DeepSeek delegation ready",
    },
  },
  {
    name: "deepseek_settings_save", title: "Save DeepSeek model settings",
    description: "Save a DeepSeek model and install its native role plus the local provider router used by the next task.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expectedRevision", "model"],
      properties: { expectedRevision: { type: "integer", minimum: 0 }, model: modelIdSchema() },
    },
    outputSchema: settingsOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "deepseek_models_list", title: "Refresh DeepSeek models",
    description: "Retrieve DeepSeek model IDs from GET /v1/models plus plugin-verified Responses models. Never returns the API key.",
    inputSchema: { type: "object", additionalProperties: false, properties: { force: { type: "boolean", default: true } } },
    outputSchema: modelsOutputSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "deepseek_credential_set", title: "Save DeepSeek connection",
    description: "Store a DeepSeek API base URL and optionally replace the local API key. Never returns the key.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expectedRevision", "baseUrl"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        apiKey: { type: "string", minLength: 8, maxLength: 4096, format: "password" },
        baseUrl: { type: "string", minLength: 1, maxLength: 2048, format: "uri" },
      },
    },
    outputSchema: settingsOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "deepseek_credential_delete", title: "Delete DeepSeek API key",
    description: "Delete the API key and native role, then restore the previous provider configuration for new tasks.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expectedRevision"],
      properties: { expectedRevision: { type: "integer", minimum: 0 } },
    },
    outputSchema: settingsOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "deepseek_connection_test", title: "Test DeepSeek connection",
    description: "Validate the stored credential and explicitly selected model with a minimal DeepSeek Responses request. Never returns the key.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["model"],
      properties: { model: modelIdSchema() },
    },
    outputSchema: settingsOutputSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function resultText(text, structuredContent, isError = false) {
  return { ...(isError ? { isError: true } : {}), ...(structuredContent === undefined ? {} : { structuredContent }), content: [{ type: "text", text }] };
}

function classifiedError(error) {
  const message = error instanceof Error ? error.message : "DeepSeek Subagent operation failed.";
  const rules = [
    [/DeepSeek settings file.*(?:invalid|contains invalid JSON)/i, "SETTINGS_INVALID"],
    [/API base URL/i, "INVALID_BASE_URL"],
    [/API key.*(?:invalid|must be)|Invalid DeepSeek API key/i, "INVALID_API_KEY"],
    [/not configured|Save an API key and model first/i, "NOT_CONFIGURED"],
    [/Select a model|selected model.*(?:not available|no longer available)|Invalid DeepSeek model/i, "MODEL_UNAVAILABLE"],
    [/Settings changed|changed while|busy in another Codex task/i, "SETTINGS_CONFLICT"],
    [/timed out/i, "UPSTREAM_TIMEOUT"],
    [/Unable to reach DeepSeek/i, "NETWORK_UNREACHABLE"],
    [/returned HTTP (\d+)/i, "UPSTREAM_HTTP_ERROR"],
    [/invalid JSON|invalid response|invalid model list|no valid model IDs/i, "UPSTREAM_INVALID_RESPONSE"],
    [/native integration is not ready/i, "NATIVE_NOT_READY"],
    [/local DeepSeek delegation router|router runtime/i, "ROUTER_UNAVAILABLE"],
    [/multi_agent_v2/i, "MULTI_AGENT_DISABLED"],
    [/(?:current|restored parent) provider.*not (?:a )?ChatGPT-authenticated|not a ChatGPT-authenticated provider/i, "PROVIDER_NOT_AUTHENTICATED"],
    [/current Codex provider.*(?:unsupported|does not use the Responses wire API)|profile provider overrides/i, "PROVIDER_UNSUPPORTED"],
    [/routing is unavailable on this platform|runtime locking is unavailable on this platform/i, "NATIVE_PLATFORM_UNSUPPORTED"],
    [/unmanaged|unverified|unrecognized|ownership changed|non-regular|multiply linked/i, "OWNERSHIP_CONFLICT"],
    [/Codex config|provider routing|LaunchAgent|native role|Model save failed/i, "NATIVE_INTEGRATION_FAILED"],
  ];
  const matched = rules.find(([pattern]) => pattern.test(message));
  const code = matched?.[1] || "OPERATION_FAILED";
  const status = /returned HTTP (\d+)/i.exec(message)?.[1];
  return { code, message, ...(status ? { params: { status: Number(status) } } : {}) };
}

function toolError(error) {
  const classified = classifiedError(error);
  return {
    ...resultText(`DeepSeek Subagent error: ${classified.message}`, undefined, true),
    _meta: { deepseekSubagentError: { code: classified.code, ...(classified.params ? { params: classified.params } : {}) } },
  };
}

function errorResponse(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function validApiKey(apiKey) {
  return typeof apiKey === "string" && apiKey === apiKey.trim() && Buffer.byteLength(apiKey, "utf8") >= 8 && Buffer.byteLength(apiKey, "utf8") <= 4096 && !/[\r\n]/.test(apiKey);
}

function validModelId(model) {
  return typeof model === "string" && MODEL_ID_PATTERN.test(model);
}

function validDelegationMessage(message) {
  return typeof message === "string" && message.trim().length > 0 && Buffer.byteLength(message, "utf8") <= MAX_DELEGATION_MESSAGE_BYTES;
}

function parseSettingsSnapshot(snapshot) {
  if (!snapshot.exists) return { ...DEFAULT_SETTINGS };
  let parsed;
  try { parsed = JSON.parse(snapshot.contents); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("The DeepSeek settings file contains invalid JSON.");
    throw error;
  }
  const valid = [1, 2].includes(parsed?.schemaVersion) && Number.isInteger(parsed.revision) && parsed.revision >= 0 &&
    (parsed.model === "" || validModelId(parsed.model)) && (parsed.apiKey == null || validApiKey(parsed.apiKey)) &&
    (parsed.baseUrl === undefined || typeof parsed.baseUrl === "string");
  if (!valid) throw new Error("The DeepSeek settings file is invalid. Delete it and save settings again.");
  let baseUrl;
  try { baseUrl = normalizeApiBaseUrl(parsed.baseUrl === undefined ? DEFAULT_DEEPSEEK_BASE_URL : parsed.baseUrl); }
  catch { throw new Error("The DeepSeek settings file contains an invalid API base URL. Delete it and save settings again."); }
  return { schemaVersion: 2, revision: parsed.revision, model: parsed.model || "", apiKey: parsed.apiKey || null, baseUrl };
}

async function readSettings() {
  return parseSettingsSnapshot(await settingsFileSnapshot());
}

async function applyPrivatePermissions(path, mode) {
  if (process.platform === "win32") return;
  try { await chmod(path, mode); }
  catch (error) { if (!["ENOSYS", "EPERM"].includes(error?.code)) throw error; }
}

async function settingsFileSnapshot() {
  try {
    const info = await lstat(SETTINGS_FILE);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error("Refusing to replace a non-regular or multiply linked DeepSeek settings file.");
    }
    return { exists: true, contents: await readFile(SETTINGS_FILE, "utf8"), mode: info.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, contents: "", mode: 0o600 };
    throw error;
  }
}

async function atomicWriteSettings(contents, mode = 0o600, expectedSnapshot = null) {
  await mkdir(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  await applyPrivatePermissions(SETTINGS_DIR, 0o700);
  const current = await settingsFileSnapshot();
  const temporary = join(SETTINGS_DIR, `.settings-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode });
    if (expectedSnapshot) {
      const latest = await settingsFileSnapshot();
      if (latest.exists !== expectedSnapshot.exists || latest.contents !== expectedSnapshot.contents) {
        throw new Error("DeepSeek settings changed while a write was being committed; no settings changes were written.");
      }
    }
    await rename(temporary, SETTINGS_FILE);
    await applyPrivatePermissions(SETTINGS_FILE, mode);
  } finally { await rm(temporary, { force: true }); }
}

async function restoreSettingsSnapshot(snapshot, expectedContents) {
  const current = await settingsFileSnapshot();
  if (!current.exists || current.contents !== expectedContents) {
    throw new Error("DeepSeek settings changed during rollback; refusing to overwrite the newer settings.");
  }
  if (snapshot.exists) await atomicWriteSettings(snapshot.contents, 0o600, current);
  else await rm(SETTINGS_FILE);
}

async function withCrossProcessMutationLock(operation) {
  return withNativeMutationLock(SETTINGS_DIR, operation);
}

function queueSettingsMutation(operation) {
  const queued = settingsMutationQueue.then(
    () => withCrossProcessMutationLock(operation),
    () => withCrossProcessMutationLock(operation),
  );
  settingsMutationQueue = queued.catch(() => {});
  return queued;
}

function clearCleanupReconcileTimer() {
  if (cleanupReconcileTimer) clearTimeout(cleanupReconcileTimer);
  cleanupReconcileTimer = null;
  cleanupReconcileDueAt = 0;
}

function scheduleCleanupReconcile(dueAt) {
  const normalizedDueAt = Math.max(Date.now() + 1, Math.min(dueAt, Date.now() + 0x7fffffff));
  if (cleanupReconcileTimer && cleanupReconcileDueAt <= normalizedDueAt) return;
  clearCleanupReconcileTimer();
  cleanupReconcileDueAt = normalizedDueAt;
  cleanupReconcileTimer = setTimeout(() => {
    cleanupReconcileTimer = null;
    cleanupReconcileDueAt = 0;
    void reconcileAndScheduleCleanup();
  }, normalizedDueAt - Date.now());
  cleanupReconcileTimer.unref();
}

async function reconcileAndScheduleCleanup() {
  try {
    const result = await reconcileNativeCleanup(SETTINGS_DIR);
    cleanupReconcileRetryMs = 250;
    const deadlineAt = result?.cleanup?.deadlineAt;
    if (!result.reconciled && Number.isFinite(deadlineAt) && deadlineAt > Date.now()) {
      scheduleCleanupReconcile(deadlineAt);
    } else {
      clearCleanupReconcileTimer();
    }
    return result;
  } catch {
    scheduleCleanupReconcile(Date.now() + cleanupReconcileRetryMs);
    cleanupReconcileRetryMs = Math.min(cleanupReconcileRetryMs * 2, 5_000);
    return { reconciled: false, reason: "retry-scheduled" };
  }
}

async function writeSettings(expectedRevision, patch) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("expectedRevision must be a non-negative integer.");
  const snapshot = await settingsFileSnapshot();
  const current = parseSettingsSnapshot(snapshot);
  if (current.revision !== expectedRevision) throw new Error("Settings changed in another window. Reload and try again.");
  const next = { ...current, ...patch, schemaVersion: 2, revision: current.revision + 1 };
  if (next.model !== "" && !validModelId(next.model)) throw new Error("Invalid DeepSeek model ID.");
  if (next.apiKey !== null && !validApiKey(next.apiKey)) throw new Error("Invalid DeepSeek API key.");
  next.baseUrl = normalizeApiBaseUrl(next.baseUrl);
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  await atomicWriteSettings(contents, 0o600, snapshot);
  return { settings: next, contents };
}

async function getConnectionSettings() {
  const settings = await readSettings();
  if (!validApiKey(settings.apiKey)) throw new Error("DeepSeek API key is not configured. Open Settings → Integrations → DeepSeek Subagent.");
  return settings;
}

async function ensureNative(settings, models = []) {
  if (!validApiKey(settings.apiKey) || !settings.model) return nativeIntegrationStatus(SETTINGS_DIR, settings.model, settings.baseUrl);
  await installNativeIntegration({
    settingsDir: SETTINGS_DIR, settingsFile: SETTINGS_FILE, model: settings.model,
    models: models.length ? models : [{ id: settings.model }], modelTemplateFile: MODEL_TEMPLATE,
    apiBaseUrl: settings.baseUrl,
  });
  return nativeIntegrationStatus(SETTINGS_DIR, settings.model, settings.baseUrl);
}

async function recoverConfiguredNative() {
  const observed = await readSettings();
  if (!validApiKey(observed.apiKey) || !observed.model) return { ready: false, skipped: true };
  const existing = await nativeIntegrationStatus(SETTINGS_DIR, observed.model, observed.baseUrl);
  if (existing.ready) return existing;
  return queueSettingsMutation(async () => {
    const current = await readSettings();
    if (current.revision !== observed.revision || current.model !== observed.model || current.apiKey !== observed.apiKey || current.baseUrl !== observed.baseUrl) {
      return { ready: false, skipped: true };
    }
    const latest = await nativeIntegrationStatus(SETTINGS_DIR, current.model, current.baseUrl);
    if (latest.ready) return latest;
    await ensureNative(current);
    return nativeIntegrationStatus(SETTINGS_DIR, current.model, current.baseUrl);
  });
}

async function settingsSnapshot(message, source = null) {
  const settings = source || await readSettings();
  const configured = validApiKey(settings.apiKey);
  const native = await nativeIntegrationStatus(SETTINGS_DIR, settings.model, settings.baseUrl);
  return {
    schemaVersion: 2, revision: settings.revision, model: settings.model, baseUrl: settings.baseUrl,
    credentialConfigured: configured, credentialMask: configured ? "••••••••" : "",
    nativeReady: native.ready, message,
  };
}

async function fetchModels({ force = false } = {}) {
  const connection = await getConnectionSettings();
  let apiKey = connection.apiKey;
  const baseUrl = connection.baseUrl;
  const fingerprint = createHash("sha256").update(apiKey).update("\0").update(baseUrl).digest("hex");
  if (!force && modelsCache?.fingerprint === fingerprint && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_MS) {
    apiKey = "";
    return modelsCache.models.map((model) => ({ ...model }));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await fetch(new URL("models", baseUrl), {
      method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("DeepSeek model request timed out after 30 seconds.");
    throw new Error("Unable to reach DeepSeek GET /v1/models.");
  } finally { clearTimeout(timer); apiKey = ""; }
  if (!response.ok) throw new Error(`DeepSeek GET /v1/models returned HTTP ${response.status}.`);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("DeepSeek GET /v1/models returned invalid JSON."); }
  const seen = new Set();
  if (!Array.isArray(payload?.data)) throw new Error("DeepSeek GET /v1/models returned an invalid model list.");
  const models = payload.data.flatMap((item) => {
    if (!validModelId(item?.id) || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ id: item.id, ...(typeof item.owned_by === "string" ? { ownedBy: item.owned_by } : {}) }];
  });
  for (const id of RESPONSES_MODELS_NOT_LISTED_BY_API) {
    if (!seen.has(id)) {
      seen.add(id);
      models.push({ id, ownedBy: "deepseek" });
    }
  }
  if (!models.length) throw new Error("DeepSeek GET /v1/models returned no valid model IDs.");
  modelsCache = { fingerprint, fetchedAt: Date.now(), models };
  return models.map((model) => ({ ...model }));
}

async function probeResponses(model) {
  const connection = await getConnectionSettings();
  let apiKey = connection.apiKey;
  const baseUrl = connection.baseUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await fetch(new URL("responses", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ model, input: "Reply with OK.", max_output_tokens: 8, stream: false }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("DeepSeek Responses request timed out after 30 seconds.");
    throw new Error("Unable to reach DeepSeek POST /v1/responses.");
  } finally { clearTimeout(timer); apiKey = ""; }
  if (!response.ok) throw new Error(`DeepSeek POST /v1/responses returned HTTP ${response.status} for ${model}.`);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("DeepSeek POST /v1/responses returned invalid JSON."); }
  if (!payload || typeof payload !== "object") throw new Error("DeepSeek POST /v1/responses returned an invalid response.");
}

async function saveModel(expectedRevision, model) {
  if (!validModelId(model)) throw new Error("Select a model from the refreshed DeepSeek model list.");
  const models = await fetchModels();
  if (!models.some((candidate) => candidate.id === model)) throw new Error("The selected model is no longer available. Refresh models.");
  await probeResponses(model);
  return queueSettingsMutation(async () => {
    const snapshot = await settingsFileSnapshot();
    const written = await writeSettings(expectedRevision, { model });
    try {
      await ensureNative(written.settings, models);
      return { settings: written.settings, models };
    } catch (error) {
      await restoreSettingsSnapshot(snapshot, written.contents).catch((rollbackError) => {
        throw new AggregateError([error, rollbackError], "Model save failed and settings rollback was incomplete.");
      });
      throw error;
    }
  });
}

async function prepareNativeDelegation(args) {
  if (!validDelegationMessage(args?.message)) {
    throw new Error("Delegation message must be non-empty and no larger than 512 KiB.");
  }
  if (!TASK_BASE_PATTERN.test(args?.taskName || "")) {
    throw new Error("Spawn taskName must start with a lowercase letter and contain at most 32 lowercase letters, digits, or underscores.");
  }
  const settings = await readSettings();
  if (!validApiKey(settings.apiKey) || !settings.model) {
    throw new Error("DeepSeek native delegation is not configured. Save an API key and model first.");
  }
  let native = await nativeIntegrationStatus(SETTINGS_DIR, settings.model, settings.baseUrl);
  if (!native.ready) {
    native = await queueSettingsMutation(async () => {
      const current = await readSettings();
      if (current.revision !== settings.revision || current.model !== settings.model || current.apiKey !== settings.apiKey || current.baseUrl !== settings.baseUrl) {
        throw new Error("DeepSeek settings changed while the native router was being recovered. Retry the delegation.");
      }
      await ensureNative(current);
      return nativeIntegrationStatus(SETTINGS_DIR, current.model, current.baseUrl);
    });
  }
  if (!native.ready) throw new Error("DeepSeek native integration could not be recovered. Save the selected model again, then start a new Codex task.");
  const runtimeFile = nativePaths(SETTINGS_DIR).runtimeFile;
  const info = await lstat(runtimeFile);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error("DeepSeek router runtime state is unsafe.");
  }
  let runtime;
  try { runtime = JSON.parse(await readFile(runtimeFile, "utf8")); }
  catch { throw new Error("DeepSeek router runtime state is invalid."); }
  if (runtime?.schemaVersion !== 2 || runtime.selectedModel !== settings.model || runtime.deepseekBaseUrl !== settings.baseUrl ||
      !Number.isInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535 ||
      !/^[a-f0-9]{48}$/.test(runtime.routeToken || "") || !/^[a-f0-9]{48}$/.test(runtime.instanceId || "") ||
      !/^[a-f0-9]{48}$/.test(runtime.shutdownToken || "")) {
    throw new Error("DeepSeek router runtime state does not match the saved model.");
  }
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${runtime.port}/${runtime.routeToken}/delegations/prepare`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ taskName: args.taskName, message: args.message }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    throw new Error("Unable to reach the local DeepSeek delegation router.");
  }
  if (!response.ok) throw new Error(`Local DeepSeek delegation preparation failed with HTTP ${response.status}.`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 4096) throw new Error("Local DeepSeek delegation router returned an oversized response.");
  let prepared;
  try { prepared = JSON.parse(text); }
  catch { throw new Error("Local DeepSeek delegation router returned invalid JSON."); }
  const validReturnedTask = new RegExp(`^${args.taskName}_[a-f0-9]{24}$`).test(prepared?.taskName || "");
  if (!validReturnedTask || !Number.isInteger(prepared?.expiresInSeconds) ||
      prepared.expiresInSeconds < 1 || prepared.expiresInSeconds > 600) {
    throw new Error("Local DeepSeek delegation router returned invalid preparation metadata.");
  }
  return {
    taskName: prepared.taskName,
    expiresInSeconds: prepared.expiresInSeconds,
    message: "Call native spawn_agent now with this exact taskName, agent_type deepseek, and fork_turns none.",
  };
}

async function callTool(name, args) {
  await reconcileAndScheduleCleanup();
  switch (name) {
  case "deepseek_settings": return resultText("DeepSeek settings loaded.", await settingsSnapshot("Settings loaded."));
  case "deepseek_delegation_prepare": {
    const prepared = await prepareNativeDelegation(args);
    return resultText("Native DeepSeek delegation prepared in loopback memory.", prepared);
  }
  case "deepseek_credential_set": {
    const baseUrl = normalizeApiBaseUrl(args?.baseUrl);
    if (args?.apiKey !== undefined && !validApiKey(args.apiKey)) throw new Error("API key must be 8–4096 UTF-8 bytes with no leading/trailing whitespace or newline.");
    return queueSettingsMutation(async () => {
      modelsCache = null;
      const snapshot = await settingsFileSnapshot();
      const current = parseSettingsSnapshot(snapshot);
      const apiKey = args?.apiKey === undefined ? current.apiKey : args.apiKey;
      if (!validApiKey(apiKey)) throw new Error("API key must be provided when DeepSeek has not been configured yet.");
      const baseUrlChanged = current.baseUrl !== baseUrl;
      if (baseUrlChanged && current.model) await validateLegacyCredentialHelper(SETTINGS_DIR);
      const written = await writeSettings(args?.expectedRevision, { apiKey, baseUrl, ...(baseUrlChanged ? { model: "" } : {}) });
      try {
        if (baseUrlChanged && current.model) await removeNativeIntegration(SETTINGS_DIR);
        const message = baseUrlChanged && current.model
          ? "Connection saved. Refresh and save a model again to activate the new API base URL."
          : "Connection saved.";
        return resultText("DeepSeek connection saved.", await settingsSnapshot(message, written.settings));
      } catch (error) {
        await restoreSettingsSnapshot(snapshot, written.contents).catch((rollbackError) => {
          throw new AggregateError([error, rollbackError], "Connection save failed and settings rollback was incomplete.");
        });
        throw error;
      }
    });
  }
  case "deepseek_credential_delete": {
    return queueSettingsMutation(async () => {
      await validateLegacyCredentialHelper(SETTINGS_DIR);
      modelsCache = null;
      const snapshot = await settingsFileSnapshot();
      const written = await writeSettings(args?.expectedRevision, { apiKey: null, model: "" });
      try {
        await removeNativeIntegration(SETTINGS_DIR);
        return resultText("DeepSeek API key, native role, and provider routing were removed.", await settingsSnapshot("API key deleted and routing disabled for new tasks.", written.settings));
      } catch (error) {
        await restoreSettingsSnapshot(snapshot, written.contents).catch((rollbackError) => {
          throw new AggregateError([error, rollbackError], "Credential deletion failed and settings rollback was incomplete.");
        });
        throw error;
      }
    });
  }
  case "deepseek_models_list": {
    const models = await fetchModels({ force: args?.force !== false });
    const settings = await readSettings();
    return resultText("DeepSeek models loaded.", { models, selectedModel: settings.model, message: `${models.length} model(s) loaded from DeepSeek.` });
  }
  case "deepseek_settings_save": {
    const { settings, models } = await saveModel(args?.expectedRevision, args?.model);
    return resultText("Default native subagent model saved.", await settingsSnapshot("Model saved. Start a new Codex task to load the native DeepSeek role.", settings));
  }
  case "deepseek_connection_test": {
    if (!validModelId(args?.model)) throw new Error("Select a model from the refreshed DeepSeek model list.");
    const models = await fetchModels({ force: true });
    if (!models.some((candidate) => candidate.id === args.model)) throw new Error("The selected model is no longer available. Refresh models.");
    const settings = await readSettings();
    await probeResponses(args.model);
    return resultText("DeepSeek connection test succeeded.", await settingsSnapshot(`Connection to ${args.model} succeeded; ${models.length} model(s) available.`, settings));
  }
  default: throw new Error(`Unknown tool: ${String(name)}`);
  }
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  if (message.id === undefined || message.id === null) return;
  try {
    if (message.method === "initialize") {
      await reconcileAndScheduleCleanup();
      await recoverConfiguredNative();
      send({
        jsonrpc: "2.0", id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: "DeepSeek Subagent Settings", version: SERVER_VERSION },
          instructions: "This MCP server manages settings and a local delegation control plane. Prepare each DeepSeek spawn with deepseek_delegation_prepare, then use native spawn_agent with agent_type `deepseek`; the MCP server never calls a model.",
        },
      });
      return;
    }
    if (message.method === "ping") { send({ jsonrpc: "2.0", id: message.id, result: {} }); return; }
    if (message.method === "tools/list") { send({ jsonrpc: "2.0", id: message.id, result: { tools } }); return; }
    if (message.method === "resources/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { resources: [{
        uri: SETTINGS_RESOURCE_URI, name: "deepseek-subagent-settings", title: "DeepSeek Subagent Settings",
        description: "Configure the local credential and native child-task model.", mimeType: SETTINGS_MIME_TYPE,
      }] } });
      return;
    }
    if (message.method === "resources/read") {
      const requestedUri = message.params?.uri;
      if (![SETTINGS_RESOURCE_URI, ...LEGACY_SETTINGS_RESOURCE_URIS].includes(requestedUri)) { errorResponse(message.id, -32602, `Unknown resource: ${String(requestedUri)}`); return; }
      send({ jsonrpc: "2.0", id: message.id, result: { contents: [{
        uri: requestedUri, mimeType: SETTINGS_MIME_TYPE, text: await readFile(SETTINGS_HTML, "utf8"),
        _meta: {
          ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
          "openai/widgetDescription": "Configure native DeepSeek child tasks inside Codex settings.",
        },
      }] } });
      return;
    }
    if (message.method === "resources/templates/list") { send({ jsonrpc: "2.0", id: message.id, result: { resourceTemplates: [] } }); return; }
    if (message.method === "prompts/list") { send({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } }); return; }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      if (!tools.some((tool) => tool.name === name)) { errorResponse(message.id, -32602, `Unknown tool: ${String(name)}`); return; }
      send({ jsonrpc: "2.0", id: message.id, result: await callTool(name, message.params?.arguments || {}) });
      return;
    }
    errorResponse(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: toolError(error) });
    else errorResponse(message.id, -32603, detail);
  }
}

const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_MCP_MESSAGE_BYTES) {
      process.stderr.write("MCP message exceeded the input safety limit.\n");
      process.exit(1);
    }
    try { void handle(JSON.parse(line)); }
    catch (error) { process.stderr.write(`Invalid MCP message: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
  if (Buffer.byteLength(buffer, "utf8") > MAX_MCP_MESSAGE_BYTES) {
    process.stderr.write("MCP message exceeded the input safety limit.\n");
    process.exit(1);
  }
});
