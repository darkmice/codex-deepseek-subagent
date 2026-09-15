// Managed by the DeepSeek Subagent Codex plugin.
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROUTER_PROVIDER_ID = "deepseek-subagent-router";
const CONFIG_TOP_BEGIN = "# >>> DeepSeek Subagent provider routing >>>";
const CONFIG_TOP_END = "# <<< DeepSeek Subagent provider routing <<<";
const CONFIG_PROVIDER_BEGIN = "# >>> DeepSeek Subagent provider definition >>>";
const CONFIG_PROVIDER_END = "# <<< DeepSeek Subagent provider definition <<<";
const LEGACY_BEGIN = "# >>> DeepSeek Subagent managed config >>>";
const LEGACY_END = "# <<< DeepSeek Subagent managed config <<<";
const DEFAULT_LAUNCH_AGENT_LABEL = "com.dark.deepseek-subagent-router";
const requestedTestLabel = process.env.DEEPSEEK_SUBAGENT_LAUNCH_AGENT_LABEL || "";
const TEST_LAUNCH_AGENT_LABEL = process.env.NODE_ENV === "test" && /^com\.dark\.deepseek-subagent-router\.test-[A-Za-z0-9._-]+$/.test(requestedTestLabel)
  ? requestedTestLabel
  : DEFAULT_LAUNCH_AGENT_LABEL;
const LAUNCH_AGENT_OWNER = "codex-deepseek-subagent/v1";
const DEFAULT_PARENT_BASE_URL = "https://chatgpt.com/backend-api/codex/";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactTestSettings(paths) {
  return process.env.NODE_ENV === "test" && process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE === paths.settingsFile;
}

function testOverridesEnabled(paths) {
  return exactTestSettings(paths) && paths.launchAgentLabel !== DEFAULT_LAUNCH_AGENT_LABEL;
}

function launchAgentLabel(paths) {
  return paths.launchAgentLabel || DEFAULT_LAUNCH_AGENT_LABEL;
}

function directRuntimeMode(paths) {
  return exactTestSettings(paths) && process.env.DEEPSEEK_SUBAGENT_RUNTIME_MODE === "direct";
}

export function runtimeExecutionMode(paths) {
  if (directRuntimeMode(paths)) return "direct-test";
  return process.platform === "darwin" ? "launchagent" : "unsupported";
}

function blockPattern(begin, end) {
  return new RegExp(`^${escapeRegExp(begin)}\\r?\\n[\\s\\S]*?^${escapeRegExp(end)}(?:\\r?\\n|$)`, "m");
}

function stripLegacyManagedConfig(contents) {
  const counts = [markerCount(contents, LEGACY_BEGIN), markerCount(contents, LEGACY_END)];
  if (counts.every((count) => count === 0)) return contents;
  if (counts[0] !== 1 || counts[1] !== 1) {
    throw new Error("Legacy DeepSeek config markers are incomplete or duplicated; refusing to modify Codex config.");
  }
  const block = contents.match(blockPattern(LEGACY_BEGIN, LEGACY_END))?.[0];
  const exactLegacyPattern = new RegExp(
    `^${escapeRegExp(LEGACY_BEGIN)}\\r?\\n` +
    `${escapeRegExp("multi_agent_v2.hide_spawn_agent_metadata = false")}\\r?\\n` +
    `${escapeRegExp(LEGACY_END)}(?:\\r?\\n|$)$`,
  );
  if (!block || !exactLegacyPattern.test(block)) {
    throw new Error("Legacy DeepSeek config block was edited; refusing to remove unverified user configuration.");
  }
  return contents.replace(block, "");
}

function stripTomlComment(rawLine) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < rawLine.length; index++) {
    const character = rawLine[index];
    if (quote === '"' && escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "#") return rawLine.slice(0, index);
  }
  return rawLine;
}

function parseTomlBasicString(raw) {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return null;
  let decoded = "";
  for (let index = 1; index < raw.length - 1; index++) {
    const character = raw[index];
    if (character !== "\\") {
      if (character.charCodeAt(0) < 0x20 && character !== "\t") return null;
      decoded += character;
      continue;
    }
    const escape = raw[++index];
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (Object.hasOwn(simple, escape)) { decoded += simple[escape]; continue; }
    if (escape !== "u" && escape !== "U") return null;
    const length = escape === "u" ? 4 : 8;
    const hexadecimal = raw.slice(index + 1, index + 1 + length);
    if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hexadecimal)) return null;
    const codePoint = Number.parseInt(hexadecimal, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
    decoded += String.fromCodePoint(codePoint);
    index += length;
  }
  return decoded;
}

function assertSupportedTomlLexing(contents) {
  for (const rawLine of contents.split(/\r?\n/)) {
    let quote = "";
    let escaped = false;
    for (let index = 0; index < rawLine.length; index++) {
      const character = rawLine[index];
      if (!quote && character === "#") break;
      if (!quote && (rawLine.startsWith('"""', index) || rawLine.startsWith("'''", index))) {
        throw new Error("Codex config contains a multiline TOML string that cannot be preserved safely by DeepSeek routing.");
      }
      if (quote === '"' && escaped) { escaped = false; continue; }
      if (quote === '"' && character === "\\") { escaped = true; continue; }
      if (quote) {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
    }
  }
}

function parseTomlKeyPath(rawKey) {
  const segments = [];
  let index = 0;
  const skipWhitespace = () => {
    while (rawKey[index] === " " || rawKey[index] === "\t") index++;
  };
  skipWhitespace();
  while (index < rawKey.length) {
    let segment;
    if (rawKey[index] === '"') {
      const start = index++;
      let escaped = false;
      while (index < rawKey.length) {
        const character = rawKey[index++];
        if (escaped) { escaped = false; continue; }
        if (character === "\\") { escaped = true; continue; }
        if (character === '"') break;
      }
      if (rawKey[index - 1] !== '"') return null;
      segment = parseTomlBasicString(rawKey.slice(start, index));
      if (segment === null) return null;
    } else if (rawKey[index] === "'") {
      const end = rawKey.indexOf("'", index + 1);
      if (end < 0) return null;
      segment = rawKey.slice(index + 1, end);
      index = end + 1;
    } else {
      const match = rawKey.slice(index).match(/^[A-Za-z0-9_-]+/);
      if (!match) return null;
      segment = match[0];
      index += segment.length;
    }
    if (typeof segment !== "string" || !segment) return null;
    segments.push(segment);
    skipWhitespace();
    if (index === rawKey.length) return segments;
    if (rawKey[index] !== ".") return null;
    index++;
    skipWhitespace();
    if (index === rawKey.length) return null;
  }
  return null;
}

function tomlTablePath(cleanLine) {
  const line = cleanLine.trim();
  if (line.startsWith("[[") && line.endsWith("]]")) {
    const path = parseTomlKeyPath(line.slice(2, -2));
    return path ? { path, array: true } : null;
  }
  if (line.startsWith("[") && line.endsWith("]")) {
    const path = parseTomlKeyPath(line.slice(1, -1));
    return path ? { path, array: false } : null;
  }
  return null;
}

function tomlAssignment(cleanLine) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < cleanLine.length; index++) {
    const character = cleanLine[index];
    if (quote === '"' && escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character !== "=") continue;
    const path = parseTomlKeyPath(cleanLine.slice(0, index));
    return path ? { path, value: cleanLine.slice(index + 1).trim() } : null;
  }
  return null;
}

function sameTomlPath(actual, expected) {
  return actual.length === expected.length && actual.every((segment, index) => segment === expected[index]);
}

export function tomlBooleanSetting(contents, expectedPath) {
  assertSupportedTomlLexing(contents);
  let section = [];
  const matches = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const cleanLine = stripTomlComment(rawLine);
    const table = tomlTablePath(cleanLine);
    if (table) {
      if (table.array && sameTomlPath(table.path, expectedPath.slice(0, table.path.length))) {
        throw new Error(`Codex config ${expectedPath.join(".")} cannot be declared through an array table.`);
      }
      section = table.path;
      continue;
    }
    const assignment = tomlAssignment(cleanLine);
    if (!assignment) continue;
    const fullPath = [...section, ...assignment.path];
    if (fullPath.length < expectedPath.length && sameTomlPath(fullPath, expectedPath.slice(0, fullPath.length)) && assignment.value.startsWith("{")) {
      throw new Error(`Codex config ${expectedPath.join(".")} must use a dotted key or table, not an inline table.`);
    }
    if (!sameTomlPath(fullPath, expectedPath)) continue;
    if (!/^(true|false)$/.test(assignment.value)) {
      throw new Error(`Codex config ${expectedPath.join(".")} must be a boolean.`);
    }
    matches.push(assignment.value === "true");
  }
  if (matches.length > 1) {
    throw new Error(`Codex config contains multiple ${expectedPath.join(".")} assignments.`);
  }
  return matches[0] ?? null;
}

function markerCount(contents, marker) {
  return contents.split(marker).length - 1;
}

function managedRoutingState(contents) {
  const counts = {
    topBegin: markerCount(contents, CONFIG_TOP_BEGIN),
    topEnd: markerCount(contents, CONFIG_TOP_END),
    providerBegin: markerCount(contents, CONFIG_PROVIDER_BEGIN),
    providerEnd: markerCount(contents, CONFIG_PROVIDER_END),
  };
  const values = Object.values(counts);
  if (values.every((count) => count === 0)) return { present: false, originalConfigExisted: true };
  if (!values.every((count) => count === 1)) {
    throw new Error("DeepSeek provider routing markers are incomplete or duplicated; refusing to modify Codex config.");
  }
  const top = contents.match(blockPattern(CONFIG_TOP_BEGIN, CONFIG_TOP_END))?.[0];
  const provider = contents.match(blockPattern(CONFIG_PROVIDER_BEGIN, CONFIG_PROVIDER_END))?.[0];
  if (!top || !provider) throw new Error("DeepSeek provider routing blocks are malformed; refusing to modify Codex config.");
  const existed = top.match(/^# original_config_existed = (true|false)$/m);
  return { present: true, top, provider, originalConfigExisted: existed ? existed[1] === "true" : true };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function decodeOriginalProvider(block) {
  const match = block.match(/^# original_model_provider_b64 = ([A-Za-z0-9+/=]*)$/m);
  if (!match) throw new Error("The managed provider routing block is invalid; restore Codex config manually before continuing.");
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  if (/[\r\n]/.test(decoded)) throw new Error("The managed provider routing block contains an invalid original provider value.");
  return decoded;
}

function routingIntegrity(originalConfigExisted, insertedTopSeparator, originalProviderB64, provider) {
  return createHash("sha256").update(JSON.stringify({
    originalConfigExisted,
    insertedTopSeparator,
    originalProviderB64,
    provider,
  })).digest("hex");
}

function validateOriginalProviderMetadata(original, insertedTopSeparator) {
  if (original) {
    const assignment = tomlAssignment(stripTomlComment(original));
    if (!assignment || !sameTomlPath(assignment.path, ["model_provider"])) {
      throw new Error("The managed provider routing metadata contains an invalid original provider assignment.");
    }
    parseTomlString(assignment.value, "original model_provider");
  }
  if (original && insertedTopSeparator) throw new Error("The managed provider routing metadata has an invalid top-level separator marker.");
}

function legacyProviderMetadata(provider) {
  const pattern = new RegExp(
    `^${escapeRegExp(CONFIG_PROVIDER_BEGIN)}\\r?\\n` +
    `# inserted_separator = (true|false)\\r?\\n` +
    `\\[model_providers\\.${escapeRegExp(ROUTER_PROVIDER_ID)}]\\r?\\n` +
    `name = "DeepSeek Subagent loopback router"\\r?\\n` +
    `base_url = (.+?)\\r?\\n` +
    `requires_openai_auth = true\\r?\\n` +
    `wire_api = "responses"\\r?\\n` +
    `supports_websockets = false\\r?\\n` +
    `request_max_retries = 2\\r?\\n` +
    `stream_max_retries = 2\\r?\\n` +
    `${escapeRegExp(CONFIG_PROVIDER_END)}(?:\\r?\\n|$)$`,
  );
  const match = provider.match(pattern);
  if (!match) return null;
  let url;
  try { url = new URL(parseTomlString(match[2], "legacy router base_url")); }
  catch { return null; }
  const port = Number.parseInt(url.port, 10);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1024 || port > 65535 ||
    !/^\/[a-f0-9]{48}\/v1\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) return null;
  return { insertedProviderSeparator: match[1] === "true" };
}

function legacyManagedRoutingMetadata(top, provider) {
  if (!legacyProviderMetadata(provider)) return null;
  const commonTail =
    `# original_model_provider_b64 = ([A-Za-z0-9+/=]*)\\r?\\n` +
    `model_provider = ${escapeRegExp(tomlString(ROUTER_PROVIDER_ID))}\\r?\\n` +
    `${escapeRegExp(CONFIG_TOP_END)}(?:\\r?\\n|$)$`;
  const withSeparator = top.match(new RegExp(
    `^${escapeRegExp(CONFIG_TOP_BEGIN)}\\r?\\n` +
    `# original_config_existed = (true|false)\\r?\\n` +
    `# inserted_top_separator = (true|false)\\r?\\n${commonTail}`,
  ));
  const withoutSeparator = withSeparator ? null : top.match(new RegExp(
    `^${escapeRegExp(CONFIG_TOP_BEGIN)}\\r?\\n` +
    `# original_config_existed = (true|false)\\r?\\n${commonTail}`,
  ));
  const match = withSeparator || withoutSeparator;
  if (!match) return null;
  const originalConfigExisted = match[1] === "true";
  const insertedTopSeparator = withSeparator ? match[2] === "true" : false;
  const originalProviderB64 = withSeparator ? match[3] : match[2];
  const original = Buffer.from(originalProviderB64, "base64").toString("utf8");
  if (/[\r\n]/.test(original)) return null;
  validateOriginalProviderMetadata(original, insertedTopSeparator);
  return { format: "legacy", originalConfigExisted, insertedTopSeparator, originalProviderB64, original };
}

function managedRoutingMetadata(top, provider) {
  const pattern = new RegExp(
    `^${escapeRegExp(CONFIG_TOP_BEGIN)}\\r?\\n` +
    `# original_config_existed = (true|false)\\r?\\n` +
    `# inserted_top_separator = (true|false)\\r?\\n` +
    `# original_model_provider_b64 = ([A-Za-z0-9+/=]*)\\r?\\n` +
    `# routing_integrity_sha256 = ([a-f0-9]{64})\\r?\\n` +
    `model_provider = ${escapeRegExp(tomlString(ROUTER_PROVIDER_ID))}\\r?\\n` +
    `${escapeRegExp(CONFIG_TOP_END)}(?:\\r?\\n|$)$`,
  );
  const match = top.match(pattern);
  if (!match) {
    const legacy = legacyManagedRoutingMetadata(top, provider);
    if (legacy) return legacy;
    throw new Error("The managed provider routing metadata is malformed; refusing to modify Codex config.");
  }
  const originalConfigExisted = match[1] === "true";
  const insertedTopSeparator = match[2] === "true";
  const originalProviderB64 = match[3];
  const expectedIntegrity = routingIntegrity(originalConfigExisted, insertedTopSeparator, originalProviderB64, provider);
  if (match[4] !== expectedIntegrity) throw new Error("The managed provider routing metadata failed its integrity check; refusing to modify Codex config.");
  const original = decodeOriginalProvider(top);
  validateOriginalProviderMetadata(original, insertedTopSeparator);
  return { format: "integrity", originalConfigExisted, insertedTopSeparator, originalProviderB64, original };
}

function stripManagedRouting(contents) {
  const state = managedRoutingState(contents);
  if (!state.present) {
    return stripLegacyManagedConfig(contents);
  }
  const top = state.top;
  const provider = state.provider;
  const metadata = managedRoutingMetadata(top, provider);
  const { original, insertedTopSeparator } = metadata;
  const insertedProviderSeparator = /^# inserted_separator = true$/m.test(provider);
  const topIndex = contents.indexOf(top);
  const providerIndex = contents.indexOf(provider);
  if (topIndex < 0 || providerIndex < topIndex + top.length) {
    throw new Error("DeepSeek provider routing blocks are out of order; refusing to modify Codex config.");
  }
  const removeTrailingLineEnding = (value, label) => {
    if (value.endsWith("\r\n")) return value.slice(0, -2);
    if (value.endsWith("\n")) return value.slice(0, -1);
    throw new Error(`The managed provider routing block is missing its recorded ${label} separator.`);
  };
  let prefix = contents.slice(0, topIndex);
  let middle = contents.slice(topIndex + top.length, providerIndex);
  const suffix = contents.slice(providerIndex + provider.length);
  let topTerminator = top.endsWith("\r\n") ? "\r\n" : top.endsWith("\n") ? "\n" : "";
  if (insertedTopSeparator && !suffix) prefix = removeTrailingLineEnding(prefix, "top-level");
  if (insertedProviderSeparator && !suffix) {
    if (middle.endsWith("\n")) middle = removeTrailingLineEnding(middle, "provider");
    else if (!middle && topTerminator) topTerminator = "";
    else throw new Error("The managed provider routing block is missing its recorded provider separator.");
  }
  let next = prefix + (original ? `${original}${topTerminator}` : "") + middle + suffix;
  return stripLegacyManagedConfig(next);
}

function topLevelAssignment(contents, key) {
  let section = [];
  const matches = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine);
    const table = tomlTablePath(line);
    if (table) { section = table.path; continue; }
    if (section.length) continue;
    const assignment = tomlAssignment(line);
    if (assignment && sameTomlPath(assignment.path, [key])) matches.push({ line: rawLine, value: assignment.value });
  }
  if (matches.length > 1) throw new Error(`Codex config contains multiple top-level ${key} assignments.`);
  return matches[0] || null;
}

function parseTomlString(value, label) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'") && !/[\r\n]/.test(value)) {
    const parsed = value.slice(1, -1);
    if (parsed) return parsed;
  }
  const parsed = parseTomlBasicString(value);
  if (parsed) return parsed;
  throw new Error(`${label} must be a quoted TOML string.`);
}

function providerUsesOpenAiAuth(contents, providerId) {
  if (providerId === "openai") return true;
  let section = [];
  let requiresOpenAiAuth = null;
  for (const line of contents.split(/\r?\n/)) {
    const cleanLine = stripTomlComment(line);
    const table = tomlTablePath(cleanLine);
    if (table) { section = table.path; continue; }
    if (!sameTomlPath(section, ["model_providers", providerId])) continue;
    const assignment = tomlAssignment(cleanLine);
    if (assignment && sameTomlPath(assignment.path, ["requires_openai_auth"]) && /^(true|false)$/i.test(assignment.value)) {
      requiresOpenAiAuth = assignment.value.toLowerCase() === "true";
    }
  }
  return requiresOpenAiAuth === true;
}

function providerAssignments(contents, providerId) {
  let section = [];
  const assignments = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const cleanLine = stripTomlComment(rawLine);
    const table = tomlTablePath(cleanLine);
    if (table) {
      section = table.path;
      if (table.array && sameTomlPath(section.slice(0, 2), ["model_providers", providerId])) {
        throw new Error(`The current Codex provider (${providerId}) uses an unsupported array table.`);
      }
      if (section.length > 2 && sameTomlPath(section.slice(0, 2), ["model_providers", providerId])) {
        throw new Error(`The current Codex provider (${providerId}) contains unsupported nested provider tables.`);
      }
      continue;
    }
    if (!sameTomlPath(section, ["model_providers", providerId])) continue;
    const line = cleanLine.trim();
    if (!line) continue;
    const assignment = tomlAssignment(line);
    if (!assignment || assignment.path.length !== 1) throw new Error(`The current Codex provider (${providerId}) contains unsupported TOML syntax.`);
    const key = assignment.path[0];
    if (assignments.has(key)) throw new Error(`The current Codex provider (${providerId}) contains duplicate ${key} assignments.`);
    assignments.set(key, assignment.value);
  }
  return assignments;
}

function validateUpstreamBaseUrl(value, label) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${label} is not a valid absolute URL.`); }
  if (url.username || url.password || url.hash || url.search) throw new Error(`${label} must not contain credentials, a query, or a fragment.`);
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error(`${label} must use HTTPS unless it is loopback-only.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${label} must use HTTP or HTTPS.`);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function parentProviderBaseUrl(contents, providerId) {
  const configuredChatGptBase = topLevelAssignment(contents, "chatgpt_base_url");
  const defaultChatGptBase = configuredChatGptBase
    ? validateUpstreamBaseUrl(parseTomlString(configuredChatGptBase.value, "chatgpt_base_url"), "chatgpt_base_url")
    : DEFAULT_PARENT_BASE_URL;
  if (providerId === "openai") return defaultChatGptBase;
  const assignments = providerAssignments(contents, providerId);
  const allowed = new Set(["name", "base_url", "requires_openai_auth", "wire_api"]);
  const unsupported = [...assignments.keys()].filter((key) => !allowed.has(key));
  if (unsupported.length) {
    throw new Error(`The current Codex provider (${providerId}) uses unsupported routing fields: ${unsupported.join(", ")}.`);
  }
  const wireApi = assignments.get("wire_api");
  if (!wireApi || parseTomlString(wireApi, `${providerId}.wire_api`) !== "responses") {
    throw new Error(`The current Codex provider (${providerId}) does not use the Responses wire API.`);
  }
  const configured = assignments.get("base_url");
  return configured ? validateUpstreamBaseUrl(parseTomlString(configured, `${providerId}.base_url`), `${providerId}.base_url`) : defaultChatGptBase;
}

function assertNoProfileProviderOverrides(contents) {
  let section = [];
  const sensitive = new Set(["model_provider", "chatgpt_base_url", "openai_base_url"]);
  for (const rawLine of contents.split(/\r?\n/)) {
    const cleanLine = stripTomlComment(rawLine);
    const table = tomlTablePath(cleanLine);
    if (table) { section = table.path; continue; }
    const assignment = tomlAssignment(cleanLine);
    if (!assignment) continue;
    const fullPath = [...section, ...assignment.path];
    if (fullPath[0] !== "profiles") continue;
    if (fullPath.length === 1 || sensitive.has(fullPath.at(-1)) || assignment.value.startsWith("{")) {
      throw new Error("Codex profile provider overrides use an unsupported inline or dotted form; global DeepSeek routing cannot preserve them safely.");
    }
  }
}

function ensureNoRouterCollision(contents) {
  let section = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const cleanLine = stripTomlComment(rawLine);
    const table = tomlTablePath(cleanLine);
    if (table) {
      section = table.path;
      if (sameTomlPath(section.slice(0, 2), ["model_providers", ROUTER_PROVIDER_ID])) {
        throw new Error(`Codex config already contains an unmanaged ${ROUTER_PROVIDER_ID} provider or an unsupported inline provider table.`);
      }
      continue;
    }
    const assignment = tomlAssignment(cleanLine);
    if (!assignment) continue;
    const fullPath = [...section, ...assignment.path];
    if (sameTomlPath(fullPath, ["model_providers"]) || sameTomlPath(fullPath.slice(0, 2), ["model_providers", ROUTER_PROVIDER_ID])) {
      throw new Error(`Codex config already contains an unmanaged ${ROUTER_PROVIDER_ID} provider or an unsupported inline provider table.`);
    }
  }
}

function providerBlock(baseUrl, insertedSeparator) {
  return `${CONFIG_PROVIDER_BEGIN}\n` +
    `# inserted_separator = ${insertedSeparator}\n` +
    `[model_providers.${ROUTER_PROVIDER_ID}]\n` +
    `name = "DeepSeek Subagent loopback router"\n` +
    `base_url = ${tomlString(baseUrl)}\n` +
    `requires_openai_auth = true\n` +
    `wire_api = "responses"\n` +
    `supports_websockets = false\n` +
    `request_max_retries = 2\n` +
    `stream_max_retries = 2\n` +
    `${CONFIG_PROVIDER_END}\n`;
}

export function installRouterConfig(contents, baseUrl, { originalConfigExisted = true } = {}) {
  const priorManagedState = managedRoutingState(contents);
  const effectiveOriginalConfigExisted = priorManagedState.present ? priorManagedState.originalConfigExisted : originalConfigExisted;
  const clean = stripManagedRouting(contents);
  assertSupportedTomlLexing(clean);
  assertNoProfileProviderOverrides(clean);
  ensureNoRouterCollision(clean);
  const assignment = topLevelAssignment(clean, "model_provider");
  const originalLine = assignment?.line || "";
  const originalProviderId = assignment ? parseTomlString(assignment.value, "model_provider") : "openai";
  if (!providerUsesOpenAiAuth(clean, originalProviderId)) {
    throw new Error(`The current Codex provider (${originalProviderId}) is not a ChatGPT-authenticated provider. Disable DeepSeek routing before changing providers.`);
  }
  const parentBaseUrl = parentProviderBaseUrl(clean, originalProviderId);
  let next = clean;
  const encoded = Buffer.from(originalLine, "utf8").toString("base64");
  const firstTable = assignment ? -1 : next.search(/^\s*\[/m);
  const insertedTopSeparator = !assignment && firstTable < 0 && next.length > 0 && !next.endsWith("\n");
  const integrityPlaceholder = "0".repeat(64);
  const topBlock = `${CONFIG_TOP_BEGIN}\n# original_config_existed = ${effectiveOriginalConfigExisted}\n# inserted_top_separator = ${insertedTopSeparator}\n# original_model_provider_b64 = ${encoded}\n# routing_integrity_sha256 = ${integrityPlaceholder}\nmodel_provider = ${tomlString(ROUTER_PROVIDER_ID)}\n${CONFIG_TOP_END}\n`;
  const insertedTopBlock = assignment ? topBlock.trimEnd() : topBlock;
  if (assignment) next = next.replace(assignment.line, insertedTopBlock);
  else {
    next = firstTable < 0 ? `${next}${insertedTopSeparator ? "\n" : ""}${insertedTopBlock}` : `${next.slice(0, firstTable)}${insertedTopBlock}${next.slice(firstTable)}`;
  }
  const insertedSeparator = !next.endsWith("\n");
  const provider = providerBlock(baseUrl, insertedSeparator);
  const integrity = routingIntegrity(effectiveOriginalConfigExisted, insertedTopSeparator, encoded, provider);
  next = next.replace(insertedTopBlock, insertedTopBlock.replace(integrityPlaceholder, integrity));
  next = `${next}${insertedSeparator ? "\n" : ""}${provider}`;
  return { contents: next, originalProviderId, parentBaseUrl };
}

export function removeRouterConfig(contents) {
  return stripManagedRouting(contents);
}

export function routerConfigActive(contents, baseUrl) {
  try {
    const state = managedRoutingState(contents);
    if (!state.present) return false;
    if (managedRoutingMetadata(state.top, state.provider).format !== "integrity") return false;
    const insertedSeparator = /^# inserted_separator = (true|false)$/m.exec(state.provider)?.[1];
    if (!insertedSeparator || state.provider !== providerBlock(baseUrl, insertedSeparator === "true")) return false;
    const clean = stripManagedRouting(contents);
    return !topLevelAssignment(clean, "model_provider") || !new RegExp(`^\\s*model_provider\\s*=\\s*${escapeRegExp(tomlString(ROUTER_PROVIDER_ID))}`).test(topLevelAssignment(clean, "model_provider")?.line || "");
  } catch { return false; }
}

async function privatePermissions(path, mode) {
  if (process.platform === "win32") return;
  try { await chmod(path, mode); }
  catch (error) { if (!["ENOSYS", "EPERM"].includes(error?.code)) throw error; }
}

async function acquireRuntimeMutationLock(paths) {
  await mkdir(dirname(paths.routerLockDir), { recursive: true, mode: 0o700 });
  const flags = constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(paths.routerLockDir, flags, 0o600);
    const info = await handle.stat();
    const pathInfo = await lstat(paths.routerLockDir);
    if (!info.isFile() || info.nlink !== 1 || pathInfo.isSymbolicLink() || !pathInfo.isFile() ||
        pathInfo.dev !== info.dev || pathInfo.ino !== info.ino) {
      throw new Error(`Refusing to use an unsafe DeepSeek runtime lock file: ${paths.routerLockDir}`);
    }
    await handle.chmod(0o600);
    const command = process.platform === "darwin" ? "/usr/bin/lockf" : process.platform === "linux" ? "/usr/bin/flock" : "";
    const args = process.platform === "darwin" ? ["-s", "-t", "60", "3"] : ["-w", "60", "3"];
    if (!command) throw new Error("Native DeepSeek runtime locking is supported only on macOS and Linux.");
    const locker = spawn(command, args, { stdio: ["ignore", "ignore", "ignore", handle.fd] });
    const code = await new Promise((resolve, reject) => {
      locker.once("error", reject);
      locker.once("exit", (exitCode, signal) => signal ? reject(new Error(`DeepSeek runtime lock helper exited on ${signal}.`)) : resolve(exitCode));
    });
    if (code !== 0) throw new Error("DeepSeek runtime is busy in another process. Retry the operation.");
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function withRuntimeMutationLock(paths, operation) {
  const handle = await acquireRuntimeMutationLock(paths);
  try { return await operation(); }
  finally { await handle.close(); }
}

async function atomicWrite(path, contents, mode = 0o600, expectedSnapshot = null) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`Refusing to replace non-regular or multiply linked file: ${path}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode });
    if (expectedSnapshot) {
      const latest = await configSnapshot(path);
      if (latest.exists !== expectedSnapshot.exists || latest.contents !== expectedSnapshot.contents) {
        throw new Error("A managed file changed while DeepSeek routing was being committed; no changes were written. Retry the operation.");
      }
    }
    await rename(temporary, path);
    await privatePermissions(path, mode);
  } finally { await rm(temporary, { force: true }); }
}

async function configSnapshot(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`Refusing to modify non-regular or multiply linked Codex config: ${path}`);
    }
    return { path, exists: true, contents: await readFile(path, "utf8"), mode: info.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { path, exists: false, contents: "", mode: 0o600 };
    throw error;
  }
}

async function commitConfig(snapshot, contents, { removeWhenEmpty = false } = {}) {
  const current = await configSnapshot(snapshot.path);
  if (current.exists !== snapshot.exists || current.contents !== snapshot.contents) {
    throw new Error("Codex config changed while DeepSeek routing was being prepared; no config changes were written. Retry the save.");
  }
  if (removeWhenEmpty && !contents) {
    if (current.exists) await rm(snapshot.path);
    return;
  }
  await atomicWrite(snapshot.path, contents, current.exists ? current.mode : snapshot.mode, snapshot);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function launchAgentPlist(nodeExecutable, routerFile, runtimeFile, { legacy = false, label = DEFAULT_LAUNCH_AGENT_LABEL } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n` +
    `<key>Label</key><string>${label}</string>\n` +
    (legacy ? "" : `<key>DeepSeekSubagentOwner</key><string>${LAUNCH_AGENT_OWNER}</string>\n`) +
    `<key>ProgramArguments</key><array><string>${xml(nodeExecutable)}</string><string>${xml(routerFile)}</string><string>${xml(runtimeFile)}</string></array>\n` +
    `<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n` +
    `<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>\n` +
    `</dict></plist>\n`;
}

function unxml(value) {
  return value.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function ownedLaunchAgentExecutable(contents, paths) {
  const argumentsMatch = contents.match(/<key>ProgramArguments<\/key><array><string>([^<]+)<\/string><string>[^<]+<\/string><string>[^<]+<\/string><\/array>/);
  if (!argumentsMatch) return null;
  const executable = unxml(argumentsMatch[1]);
  if (contents === launchAgentPlist(executable, paths.routerFile, paths.runtimeFile, { label: launchAgentLabel(paths) }) ||
      contents === launchAgentPlist(executable, paths.routerFile, paths.runtimeFile, { legacy: true, label: launchAgentLabel(paths) })) return executable;
  return null;
}

function runtimeLaunchAgentExecutable(runtime, paths) {
  if (runtime?.schemaVersion !== 2 || runtime.settingsFile !== paths.settingsFile || runtime.catalogFile !== paths.catalogFile ||
      typeof runtime.nodeExecutable !== "string" || !runtime.nodeExecutable) return null;
  return runtime.nodeExecutable;
}

function launchAgentNotFound(error) {
  const diagnostic = String(error?.stderr || error?.message || "");
  return /Could not find service|service not found|No such process/i.test(diagnostic);
}

async function launchAgentService(paths, expectedExecutable = "") {
  const target = `gui/${userInfo().uid}/${launchAgentLabel(paths)}`;
  try {
    const { stdout } = await execFileAsync("launchctl", ["print", target], { timeout: 5_000 });
    const candidates = (Array.isArray(expectedExecutable) ? expectedExecutable : [expectedExecutable])
      .filter((value, index, values) => typeof value === "string" && value && values.indexOf(value) === index);
    const block = stdout.match(/(?:^|\n)\s*arguments = \{\s*\n([\s\S]*?)\n\s*\}/)?.[1] || "";
    const argumentsList = block.split("\n").map((value) => value.trim()).filter(Boolean);
    const executable = candidates.find((candidate) => argumentsList.length === 3 &&
      argumentsList[0] === candidate && argumentsList[1] === paths.routerFile && argumentsList[2] === paths.runtimeFile) || null;
    return { exists: true, owned: Boolean(executable), executable, target };
  } catch (error) {
    if (launchAgentNotFound(error)) return { exists: false, owned: false, executable: null, target };
    throw new Error("Unable to verify the existing DeepSeek LaunchAgent service.", { cause: error });
  }
}

async function stopOwnedLaunchAgent(paths, expectedExecutable) {
  const service = await launchAgentService(paths, expectedExecutable);
  if (!service.exists) return false;
  if (!service.owned) throw new Error(`Refusing to stop an unverified LaunchAgent service: ${launchAgentLabel(paths)}`);
  try { await execFileAsync("launchctl", ["bootout", service.target], { timeout: 10_000 }); }
  catch (error) { if (!launchAgentNotFound(error)) throw error; }
  for (let attempt = 0; attempt < 50; attempt++) {
    const after = await launchAgentService(paths, expectedExecutable);
    if (!after.exists) return true;
    if (!after.owned) throw new Error(`LaunchAgent ownership changed while stopping: ${launchAgentLabel(paths)}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for the managed LaunchAgent to stop: ${launchAgentLabel(paths)}`);
}

async function bootstrapOwnedLaunchAgent(paths, domain, expectedExecutable) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    const plist = await configSnapshot(paths.launchAgentFile);
    if (!plist.exists || ownedLaunchAgentExecutable(plist.contents, paths) !== expectedExecutable) {
      throw new Error(`Refusing to bootstrap an unverified LaunchAgent: ${paths.launchAgentFile}`);
    }
    try {
      await execFileAsync("launchctl", ["bootstrap", domain, paths.launchAgentFile], { timeout: 10_000 });
      return;
    } catch (error) {
      lastError = error;
      const service = await launchAgentService(paths, expectedExecutable);
      if (service.exists) {
        if (!service.owned) throw new Error(`LaunchAgent ownership changed while starting: ${launchAgentLabel(paths)}`);
        return;
      }
      if (!/Bootstrap failed:\s*5:\s*Input\/output error/i.test(String(error?.stderr || error?.message || ""))) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error(`Timed out starting the managed LaunchAgent: ${launchAgentLabel(paths)}`, { cause: lastError });
}

async function assertLaunchAgentOwnership(paths, launchAgentSnapshot, runtime = null) {
  if (process.platform !== "darwin" || directRuntimeMode(paths)) return { executable: process.execPath, service: null };
  const plistExecutable = launchAgentSnapshot.exists ? ownedLaunchAgentExecutable(launchAgentSnapshot.contents, paths) : null;
  if (launchAgentSnapshot.exists && !plistExecutable) {
    throw new Error(`Refusing to overwrite or remove an unmanaged LaunchAgent: ${paths.launchAgentFile}`);
  }
  const executable = plistExecutable || runtimeLaunchAgentExecutable(runtime, paths) || "";
  const service = await launchAgentService(paths, executable);
  if (service.exists && !service.owned) {
    throw new Error(`Refusing to stop an unverified LaunchAgent service: ${launchAgentLabel(paths)}`);
  }
  return { executable: executable || process.execPath, service };
}

async function startRuntime(paths, nodeExecutable, launchAgentSnapshot, previousRuntime, recovery) {
  if (directRuntimeMode(paths)) {
    const child = spawn(nodeExecutable, [paths.routerFile, paths.runtimeFile], { stdio: "ignore", detached: false });
    child.unref();
    return child.pid;
  }
  if (process.platform !== "darwin") {
    throw new Error("Native provider routing currently requires macOS LaunchAgents.");
  }
  const ownership = await assertLaunchAgentOwnership(paths, launchAgentSnapshot, previousRuntime);
  recovery.priorServiceExists = ownership.service?.exists === true;
  recovery.priorExecutable = ownership.executable;
  await mkdir(dirname(paths.launchAgentFile), { recursive: true, mode: 0o700 });
  await atomicWrite(paths.launchAgentFile, launchAgentPlist(nodeExecutable, paths.routerFile, paths.runtimeFile, { label: launchAgentLabel(paths) }), 0o600, launchAgentSnapshot);
  const domain = `gui/${userInfo().uid}`;
  if (ownership.service?.exists) {
    await stopOwnedLaunchAgent(paths, ownership.executable);
  }
  if (testOverridesEnabled(paths) &&
      process.env.DEEPSEEK_SUBAGENT_TEST_FAIL_BOOTSTRAP_ONCE === launchAgentLabel(paths)) {
    delete process.env.DEEPSEEK_SUBAGENT_TEST_FAIL_BOOTSTRAP_ONCE;
    throw new Error("Injected LaunchAgent bootstrap failure for lifecycle testing.");
  }
  await bootstrapOwnedLaunchAgent(paths, domain, nodeExecutable);
  return null;
}

async function scheduleLaunchAgentCleanup(
  paths, runtime, runtimeSnapshot, launchAgentSnapshot, launchAgentExecutable, cleanupExecutable = process.execPath, cleanupSupportSnapshots = [],
) {
  if (!runtimeSnapshot.exists) throw new Error("Cannot schedule deferred DeepSeek cleanup without managed runtime state.");
  const cleanupToken = randomBytes(24).toString("hex");
  const allowTestOverrides = testOverridesEnabled(paths);
  const delayMs = Number.parseInt(allowTestOverrides ? process.env.DEEPSEEK_SUBAGENT_CLEANUP_DELAY_MS || "600000" : "600000", 10);
  const maxAttemptsValue = Number.parseInt(allowTestOverrides ? process.env.DEEPSEEK_SUBAGENT_CLEANUP_MAX_ATTEMPTS || "5" : "5", 10);
  const maxAttempts = Number.isFinite(maxAttemptsValue) ? Math.min(Math.max(maxAttemptsValue, 1), 10) : 5;
  const retryDelayValue = Number.parseInt(allowTestOverrides ? process.env.DEEPSEEK_SUBAGENT_CLEANUP_RETRY_DELAY_MS || "1000" : "1000", 10);
  const retryDelayMs = Number.isFinite(retryDelayValue) ? Math.min(Math.max(retryDelayValue, 50), 60_000) : 1000;
  const lockTimeoutValue = Number.parseInt(allowTestOverrides ? process.env.DEEPSEEK_SUBAGENT_CLEANUP_LOCK_TIMEOUT_MS || "60000" : "60000", 10);
  const lockTimeoutMs = Number.isFinite(lockTimeoutValue) ? Math.min(Math.max(lockTimeoutValue, 0), 60_000) : 60_000;
  const normalizedDelayMs = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 600_000;
  const scheduledAt = Date.now();
  const cleanupRuntime = {
    ...runtime,
    cleanupToken,
    cleanupStatus: "scheduled",
    cleanupAttempts: 0,
    cleanupMaxAttempts: maxAttempts,
    cleanupScheduledAt: scheduledAt,
    cleanupDeadlineAt: scheduledAt + normalizedDelayMs + maxAttempts * (lockTimeoutMs + 15_000) + maxAttempts * retryDelayMs,
  };
  const cleanupContents = `${JSON.stringify(cleanupRuntime, null, 2)}\n`;
  await atomicWrite(paths.runtimeFile, cleanupContents, runtimeSnapshot.mode, runtimeSnapshot);
  const cleanupSnapshot = await fileSnapshot(paths.runtimeFile);
  const target = `gui/${userInfo().uid}/${launchAgentLabel(paths)}`;
  const cleanupSupportManifest = cleanupSupportSnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => ({
    path: snapshot.path,
    sha256: createHash("sha256").update(snapshot.contents).digest("hex"),
    mode: snapshot.mode,
    dev: snapshot.dev,
    ino: snapshot.ino,
  }));
const cleanupSource = `
const {execFile,spawn}=require("node:child_process");
const {createHash,randomBytes}=require("node:crypto");
const {constants}=require("node:fs");
const {chmod,readFile,open,lstat,mkdir,rename,rm,utimes,writeFile}=require("node:fs/promises");
const [runtimeFile,routerFile,lockDir,mutationLock,launchAgentFile,settingsFile,target,nodeExecutable,token,delayText,retryDelayText,maxAttemptsText,lockTimeoutText,supportManifestText]=process.argv.slice(1);
const delay=Number.parseInt(delayText,10);
const retryDelay=Number.parseInt(retryDelayText,10);
const maxAttempts=Number.parseInt(maxAttemptsText,10);
const lockTimeout=Number.parseInt(lockTimeoutText,10);
const supportManifest=JSON.parse(supportManifestText);
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
const coded=(code)=>Object.assign(new Error(code),{cleanupCode:code});
const notFound=(error)=>error&&error.code==="ENOENT";
const serviceNotFound=(value)=>/Could not find service|service not found|No such process/i.test(String(value||""));
const acquireRuntime=async()=>{
  let handle;
  try{
    const flags=constants.O_CREAT|constants.O_RDWR|(constants.O_NOFOLLOW||0);
    handle=await open(lockDir,flags,0o600);
    const info=await handle.stat();
    const pathInfo=await lstat(lockDir);
    if(!info.isFile()||info.nlink!==1||pathInfo.isSymbolicLink()||!pathInfo.isFile()||pathInfo.dev!==info.dev||pathInfo.ino!==info.ino)throw new Error("unsafe lock");
    await handle.chmod(0o600);
    const locker=spawn("/usr/bin/lockf",["-s","-t",String(Math.max(0,Math.ceil(lockTimeout/1000))),"3"],{stdio:["ignore","ignore","ignore",handle.fd]});
    const code=await new Promise((resolve,reject)=>{locker.once("error",reject);locker.once("exit",(exitCode,signal)=>signal?reject(new Error("lock helper signal")):resolve(exitCode));});
    if(code!==0)throw coded("lock_unavailable");
    return handle;
  }catch(error){await handle?.close().catch(()=>{});throw error.cleanupCode?error:coded("lock_unavailable");}
};
const acquireMutation=async()=>{
  const deadline=Date.now()+Math.max(0,lockTimeout);
  while(true){
    try{
      await mkdir(mutationLock,{mode:0o700});
      const dir=await lstat(mutationLock);
      if(dir.isSymbolicLink()||!dir.isDirectory())throw coded("mutation_lock_unsafe");
      const token=randomBytes(24).toString("hex");
      const ownerPath=mutationLock+"/owner.json";
      await writeFile(ownerPath,JSON.stringify({schemaVersion:1,pid:process.pid,token,createdAt:Date.now()})+"\\n",{encoding:"utf8",flag:"wx",mode:0o600});
      const owner=await lstat(ownerPath);
      if(owner.isSymbolicLink()||!owner.isFile()||owner.nlink!==1)throw coded("mutation_lock_unsafe");
      let heartbeat=Promise.resolve();
      const timer=setInterval(()=>{heartbeat=heartbeat.then(()=>utimes(ownerPath,new Date(),new Date())).catch(()=>{});},30000);
      timer.unref();
      return {dir,owner,ownerPath,token,timer,stop:async()=>{clearInterval(timer);await heartbeat;}};
    }catch(error){
      if(error&&error.cleanupCode)throw error;
      if(!error||error.code!=="EEXIST")throw coded("mutation_lock_unavailable");
      let info;
      try{info=await lstat(mutationLock);}catch(statError){if(notFound(statError))continue;throw coded("mutation_lock_unavailable");}
      if(info.isSymbolicLink()||!info.isDirectory())throw coded("mutation_lock_unsafe");
      if(Date.now()>=deadline)throw coded("mutation_lock_unavailable");
      await sleep(40);
    }
  }
};
const releaseMutation=async(expected)=>{
  await expected.stop();
  const current=await lstat(mutationLock);
  const ownerInfo=await lstat(expected.ownerPath);
  const ownerValue=JSON.parse(await readFile(expected.ownerPath,"utf8"));
  if(!current.isDirectory()||current.dev!==expected.dir.dev||current.ino!==expected.dir.ino||ownerInfo.dev!==expected.owner.dev||ownerInfo.ino!==expected.owner.ino||ownerValue.pid!==process.pid||ownerValue.token!==expected.token)throw coded("mutation_lock_identity_changed");
  const quarantine=mutationLock+".release-"+process.pid+"-"+Date.now();
  await rename(mutationLock,quarantine);
  const moved=await lstat(quarantine);
  const movedOwnerPath=quarantine+"/owner.json";
  const movedOwner=await lstat(movedOwnerPath);
  const movedValue=JSON.parse(await readFile(movedOwnerPath,"utf8"));
  if(!moved.isDirectory()||moved.dev!==expected.dir.dev||moved.ino!==expected.dir.ino||movedOwner.dev!==expected.owner.dev||movedOwner.ino!==expected.owner.ino||movedValue.pid!==process.pid||movedValue.token!==expected.token){
    await rename(quarantine,mutationLock).catch(()=>{});
    throw coded("mutation_lock_identity_changed");
  }
  await rm(quarantine,{recursive:true});
};
const loadRuntime=async()=>{
  let value;
  try{value=JSON.parse(await readFile(runtimeFile,"utf8"));}catch{throw coded("runtime_invalid");}
  return value.cleanupToken===token?value:null;
};
const writeStatus=async(status,attempt,code)=>{
  const value=await loadRuntime();
  if(!value)return false;
  value.cleanupStatus=status;
  value.cleanupAttempts=attempt;
  value.cleanupFailureCode=code||null;
  const temporary=runtimeFile+"."+process.pid+"."+Date.now()+".cleanup.tmp";
  try{
    await writeFile(temporary,JSON.stringify(value,null,2)+"\\n",{encoding:"utf8",flag:"wx",mode:0o600});
    await rename(temporary,runtimeFile);
    await chmod(runtimeFile,0o600).catch(()=>{});
  }finally{await rm(temporary,{force:true}).catch(()=>{});}
  return true;
};
const run=(args)=>new Promise((resolve)=>execFile("launchctl",args,{timeout:10000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
const assertMissing=async(path,code)=>{try{await lstat(path);throw coded(code);}catch(error){if(!notFound(error))throw error;}};
const restoreSupport=async(snapshots)=>{
  for(const snapshot of snapshots){
    try{
      const current=await lstat(snapshot.path);
      if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1)throw coded("support_restore_conflict");
      throw coded("support_restore_conflict");
    }catch(error){
      if(!notFound(error))throw error;
      let restored=false;
      if(snapshot.quarantine){
        try{
          const moved=await lstat(snapshot.quarantine);
          if(moved.isSymbolicLink()||!moved.isFile()||moved.nlink!==1||moved.dev!==snapshot.dev||moved.ino!==snapshot.ino)throw coded("support_restore_conflict");
          await rename(snapshot.quarantine,snapshot.path);
          restored=true;
        }catch(moveError){if(!notFound(moveError))throw moveError;}
      }
      if(!restored){
        await writeFile(snapshot.path,snapshot.contents,{flag:"wx",mode:snapshot.mode});
        await chmod(snapshot.path,snapshot.mode).catch(()=>{});
      }
    }
  }
};
const supportSnapshot=async(expected)=>{
  let handle;
  try{
    handle=await open(expected.path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const info=await handle.stat();
    const pathInfo=await lstat(expected.path);
    if(!info.isFile()||info.nlink!==1||pathInfo.isSymbolicLink()||!pathInfo.isFile()||pathInfo.nlink!==1||
      pathInfo.dev!==info.dev||pathInfo.ino!==info.ino||info.dev!==expected.dev||info.ino!==expected.ino||
      (info.mode&0o777)!==expected.mode)throw coded("support_ownership_changed");
    const contents=await handle.readFile();
    if(createHash("sha256").update(contents).digest("hex")!==expected.sha256)throw coded("support_ownership_changed");
    return {path:expected.path,contents,mode:expected.mode,dev:info.dev,ino:info.ino,quarantine:null};
  }catch(error){if(notFound(error))throw coded("support_ownership_changed");throw error.cleanupCode?error:coded("support_stat_failed");}
  finally{await handle?.close().catch(()=>{});}
};
const removeSupport=async()=>{
  const snapshots=(await Promise.all(supportManifest.map(supportSnapshot))).filter(Boolean);
  try{
    for(const snapshot of snapshots){
      snapshot.quarantine=snapshot.path+".cleanup-"+token+"-"+process.pid;
      await rename(snapshot.path,snapshot.quarantine);
      const moved=await lstat(snapshot.quarantine);
      if(moved.isSymbolicLink()||!moved.isFile()||moved.nlink!==1||moved.dev!==snapshot.dev||moved.ino!==snapshot.ino)throw coded("support_ownership_changed");
    }
    for(const snapshot of snapshots)await assertMissing(snapshot.path,"support_path_reappeared");
    for(const snapshot of snapshots)await rm(snapshot.quarantine);
  }catch(error){
    await restoreSupport(snapshots).catch(()=>{});
    throw coded("support_remove_failed");
  }
  return snapshots;
};
const cleanupOnce=async(attempt)=>{
  const runtime=await loadRuntime();
  if(!runtime)return "superseded";
  await writeStatus("running",attempt,null);
  const testOverridesEnabled=process.env.NODE_ENV==="test"&&target.includes(".test-")&&process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE===settingsFile;
  const hold=Number.parseInt(testOverridesEnabled?process.env.DEEPSEEK_SUBAGENT_CLEANUP_HOLD_LOCK_MS||"0":"0",10);
  if(Number.isFinite(hold)&&hold>0)await sleep(Math.min(hold,5000));
  if(!(await loadRuntime()))return "superseded";
  const inject=testOverridesEnabled&&process.env.DEEPSEEK_SUBAGENT_TEST_DEFERRED_FAIL_ONCE===target;
  if(testOverridesEnabled&&process.env.DEEPSEEK_SUBAGENT_TEST_DEFERRED_ALWAYS_FAIL===target)throw coded("injected_persistent_failure");
  if(inject&&!globalThis.__deepseekCleanupInjected){globalThis.__deepseekCleanupInjected=true;throw coded("injected_failure");}
  const status=await run(["print",target]);
  if(status.error){
    if(!serviceNotFound(status.stderr||status.error.message))throw coded("launchctl_status_failed");
  }else{
    if(![nodeExecutable,routerFile,runtimeFile].every((value)=>String(status.stdout||"").includes(value)))throw coded("service_ownership_changed");
    const bootout=await run(["bootout",target]);
    if(bootout.error&&!serviceNotFound(bootout.stderr||bootout.error.message))throw coded("launchctl_bootout_failed");
    const after=await run(["print",target]);
    if(!after.error||!serviceNotFound(after.stderr||after.error.message))throw coded("service_still_running");
  }
  await assertMissing(launchAgentFile,"launchagent_plist_reappeared");
  await rm(routerFile,{force:true});
  await assertMissing(routerFile,"router_remove_failed");
  if(!(await loadRuntime()))return "superseded";
  const supportSnapshots=await removeSupport();
  try{
    if(!(await loadRuntime())){await restoreSupport(supportSnapshots);return "superseded";}
    await rm(runtimeFile);
    await assertMissing(runtimeFile,"runtime_remove_failed");
  }catch(error){
    await restoreSupport(supportSnapshots).catch(()=>{});
    throw error;
  }
  return "complete";
};
setTimeout(async()=>{
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    let mutation=null;
    let locked=null;
    let outcome="";
    try{
      mutation=await acquireMutation();
      locked=await acquireRuntime();
      outcome=await cleanupOnce(attempt);
      if(outcome==="complete"||outcome==="superseded")return;
    }catch(error){
      const code=error&&error.cleanupCode||"cleanup_failed";
      if(locked)await writeStatus(attempt===maxAttempts?"failed":"retrying",attempt,code).catch(()=>{});
    }finally{
      if(locked)await locked.close().catch(()=>{});
      if(mutation)await releaseMutation(mutation).catch(()=>{});
    }
    if(attempt<maxAttempts)await sleep(Math.min(retryDelay*attempt,5000));
  }
},Number.isFinite(delay)&&delay>=0?delay:600000);
`;
  try {
    const cleanup = spawn(cleanupExecutable, [
      "-e", cleanupSource, paths.runtimeFile, paths.routerFile, paths.routerLockDir, join(dirname(paths.settingsFile), ".mutation.lock"),
      paths.launchAgentFile, paths.settingsFile, target, launchAgentExecutable, cleanupToken, String(delayMs), String(retryDelayMs),
      String(maxAttempts), String(lockTimeoutMs), JSON.stringify(cleanupSupportManifest),
    ], {
      stdio: "ignore", detached: true,
    });
    await new Promise((resolve, reject) => {
      const onSpawn = () => { cleanup.off("error", onError); resolve(); };
      const onError = (error) => { cleanup.off("spawn", onSpawn); reject(error); };
      cleanup.once("spawn", onSpawn);
      cleanup.once("error", onError);
    });
    cleanup.unref();
    if (launchAgentSnapshot.exists) {
      const currentPlist = await configSnapshot(paths.launchAgentFile);
      if (!currentPlist.exists || currentPlist.contents !== launchAgentSnapshot.contents ||
          !ownedLaunchAgentExecutable(currentPlist.contents, paths)) {
        throw new Error("The managed DeepSeek LaunchAgent changed before cleanup could be scheduled.");
      }
      await rm(paths.launchAgentFile);
    }
  } catch (error) {
    try {
      const currentRuntime = await fileSnapshot(paths.runtimeFile);
      if (!currentRuntime.exists || currentRuntime.contents !== cleanupSnapshot.contents) {
        throw new Error("DeepSeek runtime state changed while deferred cleanup was being scheduled; refusing to overwrite it.");
      }
      await atomicWrite(runtimeSnapshot.path, runtimeSnapshot.contents, runtimeSnapshot.mode, currentRuntime);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Deferred router cleanup could not start and runtime rollback was incomplete.");
    }
    throw new Error("Unable to schedule deferred DeepSeek router cleanup; provider routing was left unchanged.", { cause: error });
  }
}

async function waitUntilReady(runtime) {
  const url = `http://127.0.0.1:${runtime.port}/${runtime.routeToken}/healthz`;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("DeepSeek loopback router did not become ready.");
}

async function readOptional(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return ""; throw error; }
}

async function fileSnapshot(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    const pathInfo = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1 ||
        pathInfo.dev !== info.dev || pathInfo.ino !== info.ino) {
      throw new Error(`Refusing to modify non-regular or multiply linked runtime file: ${path}`);
    }
    return { path, exists: true, contents: await handle.readFile("utf8"), mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (error?.code === "ENOENT") return { path, exists: false, contents: "", mode: 0o600, dev: null, ino: null };
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sameFileSnapshot(actual, expected) {
  return actual.exists === expected.exists && (!actual.exists || actual.contents === expected.contents &&
    actual.mode === expected.mode && actual.dev === expected.dev && actual.ino === expected.ino);
}

async function quarantineRuntimeSnapshot(snapshot, purpose) {
  if (!snapshot.exists) return null;
  const current = await fileSnapshot(snapshot.path);
  if (!sameFileSnapshot(current, snapshot)) throw new Error(`Managed file changed before ${purpose}; refusing to remove it: ${snapshot.path}`);
  const quarantine = `${snapshot.path}.${purpose}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await rename(snapshot.path, quarantine);
  const moved = await fileSnapshot(quarantine);
  if (moved.dev !== snapshot.dev || moved.ino !== snapshot.ino || moved.contents !== snapshot.contents) {
    await rename(quarantine, snapshot.path).catch(() => {});
    throw new Error(`Managed file identity changed during ${purpose}; refusing to remove it: ${snapshot.path}`);
  }
  return { ...snapshot, quarantine };
}

async function restoreRuntimeQuarantines(entries) {
  for (const entry of entries.slice().reverse()) {
    if (!entry) continue;
    const current = await fileSnapshot(entry.path);
    if (current.exists) throw new Error(`Managed path was recreated during rollback; refusing to overwrite it: ${entry.path}`);
    const moved = await fileSnapshot(entry.quarantine);
    if (!moved.exists) {
      await atomicWrite(entry.path, entry.contents, entry.mode, current);
      continue;
    }
    if (moved.dev !== entry.dev || moved.ino !== entry.ino) {
      throw new Error(`Quarantined managed file changed during rollback: ${entry.path}`);
    }
    await rename(entry.quarantine, entry.path);
  }
}

async function restoreFiles(snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot.exists) await atomicWrite(snapshot.path, snapshot.contents, snapshot.mode);
    else await rm(snapshot.path, { force: true });
  }
}

async function restoreRemovedConfig(snapshot, removedContents, removeWhenEmpty) {
  const current = await configSnapshot(snapshot.path);
  const expectedExists = !(removeWhenEmpty && !removedContents);
  if (current.exists !== expectedExists || (current.exists && current.contents !== removedContents)) {
    throw new Error("Codex config changed after DeepSeek routing was removed; refusing to overwrite it during rollback.");
  }
  if (snapshot.exists) await atomicWrite(snapshot.path, snapshot.contents, snapshot.mode, current);
  else if (current.exists) await rm(snapshot.path);
}

async function restoreLaunchAgent(paths, launchAgentSnapshot, recovery = {}) {
  if (process.platform !== "darwin" || directRuntimeMode(paths)) return;
  const originalExecutable = launchAgentSnapshot.exists ? ownedLaunchAgentExecutable(launchAgentSnapshot.contents, paths) : null;
  if (launchAgentSnapshot.exists && !originalExecutable) return;
  const currentSnapshot = await fileSnapshot(paths.launchAgentFile);
  const currentExecutable = currentSnapshot.exists ? ownedLaunchAgentExecutable(currentSnapshot.contents, paths) : null;
  if (currentSnapshot.exists && !currentExecutable) {
    throw new Error(`Refusing to replace an unmanaged LaunchAgent during rollback: ${paths.launchAgentFile}`);
  }
  const domain = `gui/${userInfo().uid}`;
  const trustedExecutables = [currentExecutable, originalExecutable, recovery.priorExecutable];
  const service = await launchAgentService(paths, trustedExecutables);
  if (service.exists && !service.owned) {
    if (!launchAgentSnapshot.exists && !currentSnapshot.exists) return;
    throw new Error(`Refusing to stop an unverified LaunchAgent service: ${launchAgentLabel(paths)}`);
  }
  if (service.exists) await stopOwnedLaunchAgent(paths, service.executable);
  if (!launchAgentSnapshot.exists && recovery.priorServiceExists) {
    const recoveryPlist = launchAgentPlist(recovery.priorExecutable, paths.routerFile, paths.runtimeFile, { label: launchAgentLabel(paths) });
    await atomicWrite(paths.launchAgentFile, recoveryPlist, 0o600, currentSnapshot);
    await bootstrapOwnedLaunchAgent(paths, domain, recovery.priorExecutable);
    const installedRecoveryPlist = await configSnapshot(paths.launchAgentFile);
    if (!installedRecoveryPlist.exists || installedRecoveryPlist.contents !== recoveryPlist) {
      throw new Error("The recovered DeepSeek LaunchAgent plist changed before grace mode was restored.");
    }
    const recoveredRuntimeSnapshot = await fileSnapshot(paths.runtimeFile);
    let recoveredRuntime;
    try { recoveredRuntime = JSON.parse(recoveredRuntimeSnapshot.contents); }
    catch (error) { throw new Error("The recovered DeepSeek runtime state is invalid.", { cause: error }); }
    await waitUntilReady(recoveredRuntime);
    await scheduleLaunchAgentCleanup(
      paths,
      recoveredRuntime,
      recoveredRuntimeSnapshot,
      installedRecoveryPlist,
      recovery.priorExecutable,
    );
    return;
  }
  if (launchAgentSnapshot.exists) {
    if (!currentSnapshot.exists || currentSnapshot.contents !== launchAgentSnapshot.contents) {
      await atomicWrite(paths.launchAgentFile, launchAgentSnapshot.contents, launchAgentSnapshot.mode, currentSnapshot);
    }
    if (recovery.priorServiceExists) {
      await bootstrapOwnedLaunchAgent(paths, domain, originalExecutable);
      const restoredRuntimeSnapshot = await fileSnapshot(paths.runtimeFile);
      let restoredRuntime;
      try { restoredRuntime = JSON.parse(restoredRuntimeSnapshot.contents); }
      catch (error) { throw new Error("The restored DeepSeek runtime state is invalid.", { cause: error }); }
      await waitUntilReady(restoredRuntime);
    }
  } else if (currentSnapshot.exists) {
    await rm(paths.launchAgentFile);
  }
}

async function installRuntimeRouterUnlocked({ paths, routerSourceFile, nodeExecutable, selectedModel, deepseekBaseUrl, parentBaseUrl }) {
  const currentConfig = await configSnapshot(paths.codexConfig);
  const runtimeSnapshots = await Promise.all([
    fileSnapshot(paths.routerFile), fileSnapshot(paths.runtimeFile), fileSnapshot(paths.launchAgentFile),
  ]);
  const currentRuntimeText = await readOptional(paths.runtimeFile);
  const launchAgentRecovery = { priorServiceExists: false, priorExecutable: "" };
  let existingRuntime = null;
  try { existingRuntime = currentRuntimeText ? JSON.parse(currentRuntimeText) : null; } catch {}
  const reusableEndpoint = Number.isInteger(existingRuntime?.port) && existingRuntime.port >= 1024 && existingRuntime.port <= 65535 &&
    typeof existingRuntime?.routeToken === "string" && /^[a-f0-9]{48}$/.test(existingRuntime.routeToken);
  const runtime = {
    schemaVersion: 2,
    routeToken: reusableEndpoint ? existingRuntime.routeToken : randomBytes(24).toString("hex"),
    port: reusableEndpoint ? existingRuntime.port : await availablePort(),
    settingsFile: paths.settingsFile,
    catalogFile: paths.catalogFile,
    selectedModel,
    deepseekBaseUrl,
    nodeExecutable,
  };
  const baseUrl = `http://127.0.0.1:${runtime.port}/${runtime.routeToken}/v1`;
  const routedConfig = installRouterConfig(currentConfig.contents, baseUrl, { originalConfigExisted: currentConfig.exists });
  runtime.parentBaseUrl = parentBaseUrl
    ? validateUpstreamBaseUrl(parentBaseUrl, "DeepSeek parent test override")
    : routedConfig.parentBaseUrl;
  try {
    await atomicWrite(paths.routerFile, await readFile(routerSourceFile, "utf8"));
    await atomicWrite(paths.runtimeFile, `${JSON.stringify(runtime, null, 2)}\n`);
    const pid = await startRuntime(paths, nodeExecutable, runtimeSnapshots[2], existingRuntime, launchAgentRecovery);
    if (pid) {
      runtime.pid = pid;
      await atomicWrite(paths.runtimeFile, `${JSON.stringify(runtime, null, 2)}\n`);
    }
    await waitUntilReady(runtime);
    await commitConfig(currentConfig, routedConfig.contents);
  } catch (error) {
    if (directRuntimeMode(paths) && Number.isInteger(runtime.pid)) {
      try { process.kill(runtime.pid, "SIGTERM"); } catch {}
    }
    await restoreFiles(runtimeSnapshots.slice(0, 2)).then(
      () => restoreLaunchAgent(paths, runtimeSnapshots[2], launchAgentRecovery),
      (rollbackError) => { throw new AggregateError([error, rollbackError], "Provider router failed and runtime rollback was incomplete."); },
    ).catch((rollbackError) => {
      if (rollbackError instanceof AggregateError) throw rollbackError;
      throw new AggregateError([error, rollbackError], "Provider router failed and LaunchAgent rollback was incomplete.");
    });
    throw error;
  }
  return { runtime, baseUrl, originalProviderId: routedConfig.originalProviderId };
}

export async function installRuntimeRouter(options) {
  return withRuntimeMutationLock(options.paths, () => installRuntimeRouterUnlocked(options));
}

function configuredParentBaseUrl(contents) {
  const state = managedRoutingState(contents);
  if (!state.present) throw new Error("DeepSeek provider routing is not installed.");
  const clean = stripManagedRouting(contents);
  assertNoProfileProviderOverrides(clean);
  const assignment = topLevelAssignment(clean, "model_provider");
  const providerId = assignment ? parseTomlString(assignment.value, "model_provider") : "openai";
  if (!providerUsesOpenAiAuth(clean, providerId)) throw new Error("The restored parent provider is not ChatGPT-authenticated.");
  return parentProviderBaseUrl(clean, providerId);
}

async function runtimeProcessReady(paths, runtime) {
  if (directRuntimeMode(paths)) {
    if (!Number.isInteger(runtime.pid)) return false;
    try { process.kill(runtime.pid, 0); return true; }
    catch { return false; }
  }
  if (process.platform !== "darwin") return false;
  try {
    const plist = await readFile(paths.launchAgentFile, "utf8");
    if (ownedLaunchAgentExecutable(plist, paths) !== process.execPath || runtime.nodeExecutable !== process.execPath) return false;
    const { stdout } = await execFileAsync("launchctl", ["print", `gui/${userInfo().uid}/${launchAgentLabel(paths)}`], { timeout: 5_000 });
    return [process.execPath, paths.routerFile, paths.runtimeFile].every((value) => stdout.includes(value));
  } catch { return false; }
}

export async function runtimeRouterStatus(paths, expectedModel = "", expectedDeepseekBaseUrl = "", expectedParentBaseUrl = "") {
  try {
    const runtime = JSON.parse(await readFile(paths.runtimeFile, "utf8"));
    if (!expectedModel || runtime.schemaVersion !== 2 || runtime.selectedModel !== expectedModel || runtime.settingsFile !== paths.settingsFile ||
      runtime.catalogFile !== paths.catalogFile ||
      !Number.isInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535 || !/^[a-f0-9]{48}$/.test(runtime.routeToken || "")) return false;
    const config = await readFile(paths.codexConfig, "utf8");
    const baseUrl = `http://127.0.0.1:${runtime.port}/${runtime.routeToken}/v1`;
    if (!routerConfigActive(config, baseUrl)) return false;
    const deepseekBaseUrl = validateUpstreamBaseUrl(expectedDeepseekBaseUrl, "Expected DeepSeek API base URL");
    const parentBaseUrl = expectedParentBaseUrl
      ? validateUpstreamBaseUrl(expectedParentBaseUrl, "Expected parent API base URL")
      : configuredParentBaseUrl(config);
    if (runtime.deepseekBaseUrl !== deepseekBaseUrl || runtime.parentBaseUrl !== parentBaseUrl) return false;
    if (!await runtimeProcessReady(paths, runtime)) return false;
    const response = await fetch(`http://127.0.0.1:${runtime.port}/${runtime.routeToken}/healthz`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch { return false; }
}

export async function runtimeCleanupStatus(paths, now = Date.now()) {
  try {
    const runtime = JSON.parse(await readFile(paths.runtimeFile, "utf8"));
    const status = ["scheduled", "running", "retrying", "failed"].includes(runtime?.cleanupStatus)
      ? runtime.cleanupStatus
      : "none";
    const deadlineAt = Number.isFinite(runtime?.cleanupDeadlineAt) ? runtime.cleanupDeadlineAt : null;
    const deadlineExceeded = deadlineAt !== null && now >= deadlineAt && ["scheduled", "running", "retrying"].includes(status);
    return {
      present: true,
      status: deadlineExceeded ? "failed" : status,
      failureCode: deadlineExceeded ? "deadline_exceeded" : runtime?.cleanupFailureCode || null,
      deadlineAt,
      deadlineExceeded,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, status: "none", failureCode: null, deadlineAt: null, deadlineExceeded: false };
    return { present: true, status: "invalid", failureCode: "runtime_invalid", deadlineAt: null, deadlineExceeded: false };
  }
}

async function removeRuntimeRouterUnlocked(paths, { cleanupExecutable = process.execPath, deferMacCleanup = true, cleanupSupportSnapshots = [] } = {}) {
  const currentConfig = await configSnapshot(paths.codexConfig);
  const state = currentConfig.exists ? managedRoutingState(currentConfig.contents) : { present: false, originalConfigExisted: false };
  const restored = currentConfig.exists ? removeRouterConfig(currentConfig.contents) : "";
  const runtimeSnapshots = await Promise.all([
    fileSnapshot(paths.routerFile), fileSnapshot(paths.runtimeFile), fileSnapshot(paths.launchAgentFile),
  ]);
  const expectedCleanupSupportPaths = [
    join(dirname(paths.settingsFile), "cleanup.mjs"),
    join(dirname(paths.settingsFile), "native-config.mjs"),
    join(dirname(paths.settingsFile), "runtime.mjs"),
  ];
  if (!Array.isArray(cleanupSupportSnapshots) || cleanupSupportSnapshots.length > 0 &&
      (cleanupSupportSnapshots.length !== expectedCleanupSupportPaths.length || cleanupSupportSnapshots.some((snapshot, index) =>
        snapshot?.path !== expectedCleanupSupportPaths[index] || typeof snapshot?.exists !== "boolean" ||
        typeof snapshot?.contents !== "string" || !Number.isInteger(snapshot?.mode) ||
        (snapshot.exists && (!Number.isInteger(snapshot.dev) || !Number.isInteger(snapshot.ino)))))) {
    throw new Error("Invalid DeepSeek cleanup support snapshot contract.");
  }
  if (cleanupSupportSnapshots.length > 0) {
    const currentCleanupSupport = await Promise.all(expectedCleanupSupportPaths.map(fileSnapshot));
    if (currentCleanupSupport.some((snapshot, index) => !sameFileSnapshot(snapshot, cleanupSupportSnapshots[index]))) {
      throw new Error("DeepSeek cleanup support changed before runtime removal; refusing to delete it.");
    }
  }
  const runtimeText = runtimeSnapshots[1].contents;
  let runtime = null;
  try { runtime = runtimeText ? JSON.parse(runtimeText) : null; } catch {}
  const ownership = process.platform === "darwin" && !directRuntimeMode(paths)
    ? await assertLaunchAgentOwnership(paths, runtimeSnapshots[2], runtime)
    : { executable: process.execPath, service: null };
  const deferredMacCleanup = deferMacCleanup && process.platform === "darwin" && !directRuntimeMode(paths) &&
    ownership.service?.exists && runtime && Number.isInteger(runtime.port) && typeof runtime.routeToken === "string";
  const removeWhenEmpty = !state.originalConfigExisted;
  const recovery = {
    priorServiceExists: ownership.service?.exists === true,
    priorExecutable: ownership.executable,
  };
  if (deferredMacCleanup) {
    await scheduleLaunchAgentCleanup(
      paths, runtime, runtimeSnapshots[1], runtimeSnapshots[2], ownership.executable, cleanupExecutable, cleanupSupportSnapshots,
    );
    try {
      if (currentConfig.exists && state.present) await commitConfig(currentConfig, restored, { removeWhenEmpty });
    } catch (error) {
      await restoreFiles(runtimeSnapshots.slice(0, 2)).then(
        () => restoreLaunchAgent(paths, runtimeSnapshots[2], recovery),
      ).catch((rollbackError) => {
        throw new AggregateError([error, rollbackError], "Provider removal failed and runtime rollback was incomplete.");
      });
      throw error;
    }
    return;
  }

  let configCommitted = false;
  let removalStarted = false;
  const quarantinedSupport = [];
  try {
    if (currentConfig.exists && state.present) {
      await commitConfig(currentConfig, restored, { removeWhenEmpty });
      configCommitted = true;
    }
    removalStarted = true;
    if (process.platform === "darwin" && !directRuntimeMode(paths)) {
      if (ownership.service?.exists) await stopOwnedLaunchAgent(paths, ownership.executable);
      if (runtimeSnapshots[2].exists) await rm(paths.launchAgentFile);
    }
    for (const snapshot of cleanupSupportSnapshots) quarantinedSupport.push(await quarantineRuntimeSnapshot(snapshot, "remove"));
    await rm(paths.runtimeFile, { force: true });
    if (exactTestSettings(paths) &&
        process.env.DEEPSEEK_SUBAGENT_TEST_FAIL_REMOVE_AFTER_RUNTIME_FILE_ONCE === "1") {
      delete process.env.DEEPSEEK_SUBAGENT_TEST_FAIL_REMOVE_AFTER_RUNTIME_FILE_ONCE;
      throw new Error("Injected DeepSeek router runtime removal failure for testing.");
    }
    await rm(paths.routerFile, { force: true });
    if (directRuntimeMode(paths) && Number.isInteger(runtime?.pid)) {
      try { process.kill(runtime.pid, "SIGTERM"); } catch {}
    }
    for (const entry of quarantinedSupport) if (entry) await rm(entry.quarantine);
  } catch (error) {
    if (!configCommitted && !removalStarted) throw error;
    try {
      await restoreRuntimeQuarantines(quarantinedSupport);
      await restoreFiles(runtimeSnapshots.slice(0, 2));
      await restoreLaunchAgent(paths, runtimeSnapshots[2], recovery);
      if (configCommitted) await restoreRemovedConfig(currentConfig, restored, removeWhenEmpty);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Provider removal failed and runtime rollback was incomplete.");
    }
    throw error;
  }
}

export async function removeRuntimeRouter(paths, options = {}) {
  return withRuntimeMutationLock(paths, () => removeRuntimeRouterUnlocked(paths, options));
}

export function runtimePaths(settingsDir, codexHome) {
  const settingsFile = join(settingsDir, "settings.json");
  const allowTestPath = process.env.NODE_ENV === "test" && process.env.DEEPSEEK_SUBAGENT_TEST_SETTINGS_FILE === settingsFile &&
    TEST_LAUNCH_AGENT_LABEL !== DEFAULT_LAUNCH_AGENT_LABEL;
  const effectiveLaunchAgentLabel = allowTestPath ? TEST_LAUNCH_AGENT_LABEL : DEFAULT_LAUNCH_AGENT_LABEL;
  const launchAgentsDir = allowTestPath && process.env.DEEPSEEK_SUBAGENT_LAUNCH_AGENTS_DIR
    ? process.env.DEEPSEEK_SUBAGENT_LAUNCH_AGENTS_DIR
    : join(homedir(), "Library", "LaunchAgents");
  return {
    catalogFile: join(settingsDir, "native-models.json"),
    runtimeFile: join(settingsDir, "router-runtime.json"),
    routerFile: join(settingsDir, "router.mjs"),
    routerLockDir: join(settingsDir, ".router.lock"),
    launchAgentFile: join(launchAgentsDir, `${effectiveLaunchAgentLabel}.plist`),
    launchAgentLabel: effectiveLaunchAgentLabel,
    codexConfig: join(codexHome, "config.toml"),
    settingsFile,
  };
}
