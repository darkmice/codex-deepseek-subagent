// Managed by the DeepSeek Subagent Codex plugin.
import { randomBytes } from "node:crypto";

export const MAX_CREDENTIALS = 8;
export const LEGACY_CREDENTIAL_ID = "legacy_primary";
export const EXHAUSTED_COOLDOWN_MS = 15 * 60 * 1000;
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1/";
const CREDENTIAL_ID_PATTERN = /^(?:legacy_primary|key_[a-f0-9]{24})$/;

export function normalizeApiBaseUrl(value) {
  if (typeof value !== "string" || value !== value.trim() || Buffer.byteLength(value, "utf8") < 1 ||
      Buffer.byteLength(value, "utf8") > 2048) {
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

export function validApiKey(apiKey) {
  return typeof apiKey === "string" && apiKey === apiKey.trim() &&
    Buffer.byteLength(apiKey, "utf8") >= 8 && Buffer.byteLength(apiKey, "utf8") <= 4096 &&
    !/[\r\n]/.test(apiKey);
}

export function validCredentialId(value) {
  return typeof value === "string" && CREDENTIAL_ID_PATTERN.test(value);
}

export function normalizeCredentialLabel(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 ||
      Buffer.byteLength(value, "utf8") > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Credential label must be 1–128 UTF-8 bytes with no control characters or surrounding whitespace.");
  }
  return value;
}

function normalizeCredential(candidate, fallbackBaseUrl = "") {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
      Object.keys(candidate).some((key) => !["id", "label", "enabled", "baseUrl", "apiKey"].includes(key)) ||
      !validCredentialId(candidate.id) || typeof candidate.enabled !== "boolean" || !validApiKey(candidate.apiKey)) {
    throw new Error("DeepSeek credential pool is invalid.");
  }
  return {
    id: candidate.id,
    label: normalizeCredentialLabel(candidate.label),
    enabled: candidate.enabled,
    baseUrl: normalizeApiBaseUrl(candidate.baseUrl ?? fallbackBaseUrl),
    apiKey: candidate.apiKey,
  };
}

export function credentialsFromSettings(settings, { defaultBaseUrl = "" } = {}) {
  let candidates;
  if (settings?.credentials !== undefined) {
    if (!Array.isArray(settings.credentials)) throw new Error("DeepSeek credential pool is invalid.");
    candidates = settings.credentials;
  } else if (settings?.apiKey == null) {
    candidates = [];
  } else {
    candidates = [{ id: LEGACY_CREDENTIAL_ID, label: "Primary", enabled: true, baseUrl: settings.baseUrl, apiKey: settings.apiKey }];
  }
  if (candidates.length > MAX_CREDENTIALS) throw new Error(`At most ${MAX_CREDENTIALS} DeepSeek connections can be configured.`);
  const fallbackBaseUrl = settings?.baseUrl ?? defaultBaseUrl;
  const credentials = candidates.map((candidate) => normalizeCredential(candidate, fallbackBaseUrl));
  const ids = new Set();
  const connections = new Set();
  for (const credential of credentials) {
    const connection = `${credential.baseUrl}\0${credential.apiKey}`;
    if (ids.has(credential.id) || connections.has(connection)) throw new Error("DeepSeek credential pool contains a duplicate ID or connection.");
    ids.add(credential.id);
    connections.add(connection);
  }
  return credentials;
}

export function credentialsFromSettingsDocument(settings, { defaultBaseUrl = "" } = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
      ![1, 2, 3, 4].includes(settings.schemaVersion) || !Number.isInteger(settings.revision) || settings.revision < 0 ||
      typeof settings.model !== "string" || (settings.baseUrl !== undefined && typeof settings.baseUrl !== "string")) {
    throw new Error("DeepSeek settings document is invalid.");
  }
  const pooled = settings.schemaVersion >= 3;
  const schemaV4 = settings.schemaVersion === 4;
  const allowed = pooled
    ? new Set(["schemaVersion", "revision", "model", "credentials", ...(schemaV4 ? [] : ["baseUrl"])])
    : new Set(["schemaVersion", "revision", "model", "apiKey", "baseUrl"]);
  if (Object.keys(settings).some((key) => !allowed.has(key)) ||
      (pooled ? !Array.isArray(settings.credentials) || settings.apiKey !== undefined : settings.credentials !== undefined) ||
      (schemaV4 && settings.baseUrl !== undefined)) {
    throw new Error("DeepSeek settings document is invalid.");
  }
  return credentialsFromSettings(settings, { defaultBaseUrl });
}

export function enabledCredentials(settings) {
  return credentialsFromSettings(settings).filter((credential) => credential.enabled);
}

export function createCredential(credentials, label, baseUrl, apiKey, enabled = true, { reservedIds = [] } = {}) {
  const normalized = credentialsFromSettings({ credentials });
  if (normalized.length >= MAX_CREDENTIALS) throw new Error(`At most ${MAX_CREDENTIALS} DeepSeek connections can be configured.`);
  if (!validApiKey(apiKey)) throw new Error("API key must be 8–4096 UTF-8 bytes with no leading/trailing whitespace or newline.");
  const normalizedBaseUrl = normalizeApiBaseUrl(baseUrl);
  if (normalized.some((credential) => credential.apiKey === apiKey && credential.baseUrl === normalizedBaseUrl)) {
    throw new Error("This DeepSeek connection is already configured.");
  }
  const existingIds = new Set([
    ...normalized.map((credential) => credential.id),
    ...reservedIds.filter((id) => validCredentialId(id)),
  ]);
  let id;
  do { id = `key_${randomBytes(12).toString("hex")}`; } while (existingIds.has(id));
  return { id, label: normalizeCredentialLabel(label), enabled: Boolean(enabled), baseUrl: normalizedBaseUrl, apiKey };
}

export function publicCredentials(settings, runtimeStatuses = new Map()) {
  return credentialsFromSettings(settings).map((credential, index) => {
    const runtime = runtimeStatuses.get(credential.id);
    return {
      id: credential.id,
      label: credential.label,
      enabled: credential.enabled,
      baseUrl: credential.baseUrl,
      priority: index + 1,
      status: credential.enabled ? runtime?.status || "ready" : "disabled",
    };
  });
}

export function failoverReason(status) {
  if (status === 401) return "invalid";
  if (status === 402) return "exhausted";
  return "";
}

const STATUS_PRIORITY = Object.freeze({ ready: 0, disabled: 1, exhausted: 2, invalid: 3 });

export function mergeCredentialStatuses(...sources) {
  const merged = new Map();
  for (const source of sources) {
    if (!(source instanceof Map)) continue;
    for (const [id, state] of source) {
      if (!validCredentialId(id) || !state || !Object.hasOwn(STATUS_PRIORITY, state.status)) continue;
      const current = merged.get(id);
      if (!current || STATUS_PRIORITY[state.status] > STATUS_PRIORITY[current.status]) merged.set(id, { ...state });
    }
  }
  return merged;
}

export class CredentialRuntimePool {
  constructor({ exhaustedCooldownMs = EXHAUSTED_COOLDOWN_MS } = {}) {
    this.exhaustedCooldownMs = exhaustedCooldownMs;
    this.revision = null;
    this.states = new Map();
  }

  sync(revision) {
    if (this.revision === revision) return;
    this.revision = revision;
    this.states.clear();
  }

  #blocked(credentialId, now) {
    const state = this.states.get(credentialId);
    if (!state) return false;
    if (state.blockedUntil === Infinity || state.blockedUntil > now) return true;
    this.states.delete(credentialId);
    return false;
  }

  candidates(credentials, { pinnedId = "", now = Date.now() } = {}) {
    const enabled = credentialsFromSettings({ credentials }).filter((credential) => credential.enabled);
    if (pinnedId) {
      const pinned = enabled.find((credential) => credential.id === pinnedId);
      return pinned && !this.#blocked(pinned.id, now) ? [pinned] : [];
    }
    const available = enabled.filter((credential) => !this.#blocked(credential.id, now));
    return available;
  }

  markFailure(credentialId, reason, now = Date.now()) {
    if (!validCredentialId(credentialId) || !["invalid", "exhausted"].includes(reason)) return;
    this.states.set(credentialId, {
      status: reason,
      failedAt: now,
      blockedUntil: reason === "invalid" ? Infinity : now + this.exhaustedCooldownMs,
    });
  }

  markSuccess(credentialId) {
    if (!validCredentialId(credentialId)) return;
    this.states.delete(credentialId);
  }

  statuses(credentials, now = Date.now()) {
    const result = new Map();
    for (const credential of credentialsFromSettings({ credentials })) {
      if (!credential.enabled) continue;
      const state = this.states.get(credential.id);
      if (!state) continue;
      if (state.blockedUntil !== Infinity && state.blockedUntil <= now) {
        this.states.delete(credential.id);
        continue;
      }
      result.set(credential.id, { status: state.status, failedAt: state.failedAt });
    }
    return result;
  }
}
