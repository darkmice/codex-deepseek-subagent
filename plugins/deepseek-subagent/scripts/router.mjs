import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { getHeapStatistics } from "node:v8";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import { CredentialRuntimePool, credentialsFromSettingsDocument, failoverReason } from "./credential-pool.mjs";

const runtimeFile = process.argv[2];
if (!runtimeFile) throw new Error("DeepSeek router runtime file is required.");
const requiredRuntimeFields = [
  "routeToken", "instanceId", "shutdownToken", "executionMode", "port", "settingsFile", "catalogFile",
  "selectedModel", "deepseekBaseUrl", "parentBaseUrl",
];
function validParentModel(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value) && !value.startsWith("deepseek-");
}
function validateRuntime(runtime) {
  if (runtime?.schemaVersion !== 2 || requiredRuntimeFields.some((field) => !runtime[field])) {
    throw new Error("DeepSeek router runtime file is invalid.");
  }
  if (!Number.isInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535 ||
      !/^[a-f0-9]{48}$/.test(runtime.routeToken) || !/^[a-f0-9]{48}$/.test(runtime.instanceId) ||
      !/^[a-f0-9]{48}$/.test(runtime.shutdownToken) ||
      !["launchagent", "detached", "direct-test"].includes(runtime.executionMode)) {
    throw new Error("DeepSeek router endpoint configuration is invalid.");
  }
  if (!/^deepseek-[A-Za-z0-9][A-Za-z0-9._:/-]{0,118}$/.test(runtime.selectedModel)) throw new Error("DeepSeek router model is invalid.");
  if (runtime.parentModel !== undefined && !validParentModel(runtime.parentModel)) throw new Error("DeepSeek router parent model is invalid.");
  for (const field of ["deepseekBaseUrl", "parentBaseUrl"]) {
    const url = new URL(runtime[field]);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("DeepSeek router upstream URL is invalid.");
    if (url.username || url.password || url.search || url.hash) throw new Error("DeepSeek router upstream URL contains unsupported URL components.");
    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      throw new Error("Unencrypted DeepSeek router upstreams must be loopback URLs.");
    }
  }
  return runtime;
}
async function loadRuntime() { return validateRuntime(JSON.parse(await readFile(runtimeFile, "utf8"))); }
const initialRuntime = await loadRuntime();
let lastParentModel = validParentModel(initialRuntime.parentModel) ? initialRuntime.parentModel : "";
// Schema v1/v2 settings do not carry a per-connection endpoint. During their
// read-only migration, preserve the endpoint that created this router instead
// of silently falling back to the public DeepSeek service.
const defaultDeepSeekBaseUrl = initialRuntime.deepseekBaseUrl;
const testTiming = process.env.NODE_ENV === "test" && initialRuntime?.testTiming && typeof initialRuntime.testTiming === "object"
  ? initialRuntime.testTiming
  : {};

const routePrefix = `/${initialRuntime.routeToken}/v1`;
const maxModelsResponseBytes = 8 * 1024 * 1024;
const maxConcurrentRequests = 8;
const maxCredentialControlBytes = 4 * 1024;
const mebibyte = 1024 * 1024;
const heapLimitBytes = getHeapStatistics().heap_size_limit;
const derivedProviderRequestBytes = Math.max(160 * mebibyte, Math.min(1024 * mebibyte, Math.floor(heapLimitBytes / 8)));
const maxProviderRequestBytes = Number.isSafeInteger(testTiming.providerRequestMaxBytes) &&
    testTiming.providerRequestMaxBytes > 128 * mebibyte
  ? testTiming.providerRequestMaxBytes
  : derivedProviderRequestBytes;
const derivedProviderBufferedBytes = Math.max(maxProviderRequestBytes, Math.min(
  2 * 1024 * mebibyte,
  Math.floor(heapLimitBytes / 4),
));
const maxProviderBufferedBytes = Number.isSafeInteger(testTiming.providerBufferedMaxBytes) &&
    testTiming.providerBufferedMaxBytes >= maxProviderRequestBytes
  ? testTiming.providerBufferedMaxBytes
  : derivedProviderBufferedBytes;
const upstreamHeaderTimeoutMs = 60_000;
const upstreamIdleTimeoutMs = 120_000;
const upstreamOverallTimeoutMs = 30 * 60_000;
const maxDelegationMessageBytes = 512 * 1024;
const maxDelegationControlBytes = maxDelegationMessageBytes * 6 + 4096;
const maxDelegationRecords = 64;
const maxDelegationMessagesPerTask = 256;
const maxDelegationMessageBytesPerTask = 32 * 1024 * 1024;
const maxDelegationMessageBytesGlobal = 128 * 1024 * 1024;
const delegationTtlMs = 10 * 60_000;
const activeDelegationIdleTtlMs = Number.isInteger(testTiming.activeIdleTtlMs) && testTiming.activeIdleTtlMs >= 100
  ? testTiming.activeIdleTtlMs
  : 35 * 60_000;
const activeDelegationAbsoluteTtlMs = Number.isInteger(testTiming.activeAbsoluteTtlMs) && testTiming.activeAbsoluteTtlMs >= activeDelegationIdleTtlMs
  ? testTiming.activeAbsoluteTtlMs
  : 2 * 60 * 60_000;
const maxReasoningDigestsPerTask = 128;
const maxReasoningDigestsGlobal = 1024;
const maxResponseIdDigestsPerTask = 512;
const maxResponseIdDigestsGlobal = 4096;
const maxProvenanceItemBytes = 1024 * 1024;
const maxSseEventBytes = 2 * 1024 * 1024;
const maxJsonTopLevelStringBytes = 256;
const maxJsonNestingDepth = 256;
let activeRequests = 0;
let bufferedControlBytes = 0;
let bufferedProviderBytes = 0;
const provenanceKey = randomBytes(32);
const counters = {
  parentRequests: 0, parentUpstreamResponses: 0, deepseekRequests: 0, deepseekUpstreamResponses: 0,
  deepseekAttempts: 0, deepseekFailovers: 0,
  parentFallbackRequests: 0, payloadTooLargeFallbacks: 0, unavailableCredentialFallbacks: 0,
  delegationsPrepared: 0, followupsPrepared: 0, delegationsInjected: 0, delegationMisses: 0,
};
const delegationRecords = new Map();
const credentialPool = new CredentialRuntimePool();
const decompress = {
  br: promisify(brotliDecompress),
  deflate: promisify(inflate),
  gzip: promisify(gunzip),
  "x-gzip": promisify(gunzip),
};

function routerError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

async function readRequestBody(request, limit = null) {
  const chunks = [];
  let size = 0;
  let reservedBytes = 0;
  const bounded = Number.isSafeInteger(limit) && limit >= 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (bounded && size > limit) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
      if (bounded) {
        bufferedControlBytes += chunk.length;
        reservedBytes += chunk.length;
      }
      chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks), reservedBytes };
  } catch (error) {
    bufferedControlBytes -= reservedBytes;
    throw error;
  }
}

function reserveProviderBytes(bytes, reservation) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Provider byte reservation is invalid.");
  if (bufferedProviderBytes + bytes > maxProviderBufferedBytes) {
    throw routerError("PROVIDER_BUFFER_CAPACITY", "Provider request buffering capacity is exhausted.", 503);
  }
  bufferedProviderBytes += bytes;
  reservation.bytes += bytes;
}

function releaseProviderBytes(bytes, reservation) {
  const released = Math.min(bytes, reservation.bytes, bufferedProviderBytes);
  reservation.bytes -= released;
  bufferedProviderBytes -= released;
}

async function readProviderRequestBody(request, reservation) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxProviderRequestBytes) {
    request.resume();
    throw routerError("PROVIDER_REQUEST_TOO_LARGE", "Provider request body exceeds the memory-safe request budget.", 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxProviderRequestBytes) {
      throw routerError("PROVIDER_REQUEST_TOO_LARGE", "Provider request body exceeds the memory-safe request budget.", 413);
    }
    reserveProviderBytes(chunk.length, reservation);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function decodeJsonBody(body, contentEncoding, reservation) {
  const encoding = String(contentEncoding || "identity").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return body;
  if (encoding.includes(",") || !decompress[encoding]) {
    throw Object.assign(new Error("Unsupported provider request content encoding."), { statusCode: 415 });
  }
  const outputBudget = Math.min(maxProviderRequestBytes, maxProviderBufferedBytes - bufferedProviderBytes);
  const constrainedByGlobalBudget = outputBudget < maxProviderRequestBytes;
  if (outputBudget < 1) {
    throw routerError("PROVIDER_BUFFER_CAPACITY", "Provider request decompression capacity is exhausted.", 503);
  }
  reserveProviderBytes(outputBudget, reservation);
  try {
    const decoded = await decompress[encoding](body, { maxOutputLength: outputBudget });
    releaseProviderBytes(outputBudget - decoded.length, reservation);
    return decoded;
  } catch (error) {
    releaseProviderBytes(outputBudget, reservation);
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      if (constrainedByGlobalBudget) {
        throw routerError("PROVIDER_BUFFER_CAPACITY", "Provider request decompression capacity is temporarily exhausted.", 503);
      }
      throw routerError("PROVIDER_REQUEST_TOO_LARGE", "Provider request decompression exceeds the memory-safe request budget.", 413);
    }
    throw Object.assign(new Error("Provider request body could not be decompressed."), { statusCode: 400 });
  }
}

function parentHeaders(requestHeaders, modelsRequest = false, bodyRewritten = false) {
  const headers = new Headers();
  const modelConditionHeaders = new Set(["if-match", "if-modified-since", "if-none-match", "if-range", "if-unmodified-since", "range"]);
  for (const [name, rawValue] of Object.entries(requestHeaders)) {
    if (["host", "content-length", "connection", "accept-encoding"].includes(name)) continue;
    if (bodyRewritten && name === "content-encoding") continue;
    if (modelsRequest && modelConditionHeaders.has(name)) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) if (typeof value === "string") headers.append(name, value);
  }
  return headers;
}

function deepseekHeaders(apiKey, requestHeaders, bodyRewritten = false) {
  const headers = new Headers({
    authorization: `Bearer ${apiKey}`,
    accept: typeof requestHeaders.accept === "string" ? requestHeaders.accept : "application/json",
    "content-type": typeof requestHeaders["content-type"] === "string" ? requestHeaders["content-type"] : "application/json",
  });
  if (typeof requestHeaders["user-agent"] === "string") headers.set("user-agent", requestHeaders["user-agent"]);
  if (!bodyRewritten && typeof requestHeaders["content-encoding"] === "string") headers.set("content-encoding", requestHeaders["content-encoding"]);
  return headers;
}

function taskLeaf(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const match = trimmed.match(/(?:^|\/)([a-z0-9_]+)$/);
  return match?.[1] || "";
}

function pruneDelegations(now = Date.now()) {
  for (const [task, record] of delegationRecords) {
    if (record.pendingFollowup && now >= record.pendingFollowup.expiresAt) {
      if (record.pendingFollowup.inFlight > 0) record.pendingFollowup.expired = true;
      else record.pendingFollowup = null;
    }
    const expiresAt = record.active ? Math.min(record.idleExpiresAt, record.absoluteExpiresAt) : record.expiresAt;
    if (now >= expiresAt) delegationRecords.delete(task);
  }
  if (delegationRecords.size <= maxDelegationRecords) return;
  const ordered = [...delegationRecords.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt);
  for (const [task] of ordered.slice(0, delegationRecords.size - maxDelegationRecords)) delegationRecords.delete(task);
}

function validTaskBase(value) {
  return typeof value === "string" && value.length <= 32 &&
    /^[a-z][a-z0-9]{1,15}(?:_[a-z0-9]{1,15}){1,3}$/.test(value) &&
    !["deepseek_job", "subagent_job", "worker_task"].includes(value) &&
    !/^worker_[a-z0-9]+$/.test(value);
}

function validDelegationMessage(value) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxDelegationMessageBytes;
}

function delegationMessageBytes(record) {
  return record.messages.reduce((total, message) => total + Buffer.byteLength(message, "utf8"), 0) +
    (record.pendingFollowup ? Buffer.byteLength(record.pendingFollowup.message, "utf8") : 0);
}

function totalDelegationMessageBytes() {
  let total = 0;
  for (const record of delegationRecords.values()) total += delegationMessageBytes(record);
  return total;
}

function prepareDelegation(payload) {
  pruneDelegations();
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !["taskName", "message"].includes(key))) {
    throw Object.assign(new Error("Invalid delegation preparation request."), { statusCode: 400 });
  }
  if (!validDelegationMessage(payload?.message) || !validTaskBase(payload?.taskName)) {
    throw Object.assign(new Error("Invalid delegation preparation request."), { statusCode: 400 });
  }
  if (delegationRecords.size >= maxDelegationRecords) {
    throw Object.assign(new Error("Delegation preparation capacity is exhausted."), { statusCode: 503 });
  }
  const messageBytes = Buffer.byteLength(payload.message, "utf8");
  if (messageBytes > maxDelegationMessageBytesPerTask ||
      totalDelegationMessageBytes() + messageBytes > maxDelegationMessageBytesGlobal) {
    throw Object.assign(new Error("Delegation message memory capacity is exhausted."), { statusCode: 503 });
  }
  const now = Date.now();
  const expiresAt = now + delegationTtlMs;
  let taskName;
  do { taskName = `${payload.taskName}_${randomBytes(12).toString("hex")}`; }
  while (delegationRecords.has(taskName));
  const record = {
    messages: [payload.message], envelopeDigests: [], pendingFollowup: null,
    createdAt: now, expiresAt, active: false,
    idleExpiresAt: 0, absoluteExpiresAt: now + activeDelegationAbsoluteTtlMs,
    reasoningDigests: new Map(), reasoningCipherDigests: new Map(), responseIdDigests: new Set(),
    lastCommittedFollowupRequestDigest: "",
    credentialId: "", providerMode: "", fallbackModel: lastParentModel || initialRuntime.parentModel || "", fallbackReason: "",
    credentialBindingTail: Promise.resolve(),
  };
  delegationRecords.set(taskName, record);
  const expiryTimer = setTimeout(() => {
    if (delegationRecords.get(taskName) === record && !record.active && Date.now() >= expiresAt) delegationRecords.delete(taskName);
  }, delegationTtlMs + 1);
  expiryTimer.unref();
  counters.delegationsPrepared++;
  return { taskName, expiresInSeconds: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)) };
}

function prepareFollowup(payload) {
  pruneDelegations();
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !["taskName", "message"].includes(key)) ||
      !validDelegationMessage(payload.message)) {
    throw Object.assign(new Error("Invalid delegation follow-up request."), { statusCode: 400 });
  }
  const taskMatch = typeof payload.taskName === "string"
    ? payload.taskName.match(/^(?:\/root\/)?([a-z0-9_]+)$/)
    : null;
  const taskName = taskMatch?.[1] || "";
  const record = taskName ? delegationRecords.get(taskName) : null;
  if (!record || !record.active || record.envelopeDigests.length !== record.messages.length) {
    throw routerError("TASK_BINDING_REQUIRED", "DeepSeek follow-up requires one completed prepared task.", 409);
  }
  if (record.pendingFollowup) {
    throw routerError("FOLLOWUP_ALREADY_PENDING", "A DeepSeek follow-up is already pending for this task.", 409);
  }
  const followupBytes = Buffer.byteLength(payload.message, "utf8");
  if (record.messages.length >= maxDelegationMessagesPerTask ||
      delegationMessageBytes(record) + followupBytes > maxDelegationMessageBytesPerTask ||
      totalDelegationMessageBytes() + followupBytes > maxDelegationMessageBytesGlobal) {
    throw Object.assign(new Error("Delegation follow-up memory capacity is exhausted."), { statusCode: 503 });
  }
  const now = Date.now();
  const expiresAt = Math.min(now + delegationTtlMs, record.idleExpiresAt, record.absoluteExpiresAt);
  if (expiresAt <= now) {
    delegationRecords.delete(taskName);
    throw routerError("TASK_BINDING_REQUIRED", "DeepSeek follow-up task binding expired.", 409);
  }
  const pending = { message: payload.message, createdAt: now, expiresAt, inFlight: 0, expired: false, requestDigest: "" };
  record.pendingFollowup = pending;
  const expiryTimer = setTimeout(() => {
    if (delegationRecords.get(taskName) === record && record.pendingFollowup === pending && Date.now() >= expiresAt) {
      if (pending.inFlight > 0) pending.expired = true;
      else record.pendingFollowup = null;
    }
  }, Math.max(1, expiresAt - now + 1));
  expiryTimer.unref();
  counters.followupsPrepared++;
  return { taskName, expiresInSeconds: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)) };
}

const collaborationEnvelopePattern = /^Message Type: NEW_TASK\nTask name: ([^\n]+)\nSender: [^\n]+\nPayload:\n$/;
function reasoningDigest(id, encryptedContent) {
  return createHmac("sha256", provenanceKey).update(id).update("\0").update(encryptedContent).digest("base64url");
}

function reasoningCipherDigest(encryptedContent) {
  return createHmac("sha256", provenanceKey).update("cipher\0").update(encryptedContent).digest("base64url");
}

function validResponseId(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function responseIdDigest(responseId) {
  return createHmac("sha256", provenanceKey).update("response\0").update(responseId).digest("base64url");
}

function envelopeDigest(encryptedContent) {
  return createHmac("sha256", provenanceKey).update("envelope\0").update(encryptedContent).digest("base64url");
}

function providerRequestDigest(body) {
  return createHmac("sha256", provenanceKey).update("provider-request\0").update(body).digest("base64url");
}

function touchDelegation(record, now = Date.now()) {
  record.active = true;
  record.idleExpiresAt = Math.min(now + activeDelegationIdleTtlMs, record.absoluteExpiresAt);
}

function totalReasoningDigests() {
  let total = 0;
  for (const record of delegationRecords.values()) total += record.reasoningDigests.size;
  return total;
}

function totalResponseIdDigests() {
  let total = 0;
  for (const record of delegationRecords.values()) total += record.responseIdDigests.size;
  return total;
}

function delegationEnvelopeCandidates(payload) {
  if (!Array.isArray(payload?.input)) return [];
  return payload.input.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.content)) return [];
    const envelopes = value.content.filter((item) => item?.type === "input_text" && collaborationEnvelopePattern.test(item.text || ""));
    const encrypted = value.content.filter((item) => item?.type === "encrypted_content" && Object.hasOwn(item, "encrypted_content"));
    if (envelopes.length !== 1 || encrypted.length !== 1) return [];
    const match = envelopes[0].text.match(collaborationEnvelopePattern);
    return [{ value, encrypted: encrypted[0], taskName: taskLeaf(match?.[1]) }];
  });
}

function preparedDelegationForPayload(payload) {
  pruneDelegations();
  const encryptedMessages = delegationEnvelopeCandidates(payload);
  if (encryptedMessages.length >= 1 && encryptedMessages[0].taskName) {
    const taskName = encryptedMessages[0].taskName;
    if (encryptedMessages.some((item) => item.taskName !== taskName)) return null;
    const prepared = delegationRecords.get(taskName);
    if (!prepared) return null;
    const plaintextMessages = prepared.pendingFollowup
      ? [...prepared.messages, prepared.pendingFollowup.message]
      : prepared.messages;
    if (encryptedMessages.length !== plaintextMessages.length) return null;
    return {
      taskName, prepared, encryptedMessages, plaintextMessages,
      pendingFollowup: prepared.pendingFollowup, binding: "envelope",
    };
  }
  if (encryptedMessages.length !== 0 || !validResponseId(payload?.previous_response_id)) return null;
  const digest = responseIdDigest(payload.previous_response_id);
  const matches = [...delegationRecords.entries()].filter(([, record]) => record.active && record.responseIdDigests.has(digest));
  if (matches.length !== 1) return null;
  const [taskName, prepared] = matches[0];
  return { taskName, prepared, encryptedMessages: [], plaintextMessages: [], pendingFollowup: null, binding: "previous_response_id" };
}

function inspectDelegationMessages(payload) {
  pruneDelegations();
  if (!Array.isArray(payload?.input)) {
    counters.delegationMisses++;
    throw routerError("TASK_ENVELOPE_REQUIRED", "DeepSeek request input must preserve its prepared task envelope.", 409);
  }
  const binding = preparedDelegationForPayload(payload);
  if (!binding) {
    counters.delegationMisses++;
    throw routerError("TASK_BINDING_REQUIRED", "DeepSeek request must bind exactly one prepared task.", 409);
  }
  const { taskName, prepared, encryptedMessages, plaintextMessages, pendingFollowup } = binding;
  if (encryptedMessages.some(({ encrypted }) =>
    typeof encrypted.encrypted_content !== "string" || encrypted.encrypted_content.length < 1)) {
    counters.delegationMisses++;
    throw routerError("TASK_ENVELOPE_INVALID", "DeepSeek task envelope ciphertext is invalid.", 409);
  }
  const observedEnvelopeDigests = encryptedMessages.map(({ encrypted }) => envelopeDigest(encrypted.encrypted_content));
  if (observedEnvelopeDigests.length > 0 &&
      prepared.envelopeDigests.some((digest, index) => observedEnvelopeDigests[index] !== digest)) {
    counters.delegationMisses++;
    throw routerError("TASK_ENVELOPE_HISTORY_MISMATCH", "DeepSeek follow-up envelope history does not match this task.", 409);
  }
  if (prepared.providerMode === "parent") {
    return { taskName, prepared, encryptedMessages, plaintextMessages, pendingFollowup, observedEnvelopeDigests };
  }
  const encryptedNodes = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value.type === "encrypted_content" || Object.hasOwn(value, "encrypted_content")) encryptedNodes.add(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  const recognizedEncryptedNodes = new Set(encryptedMessages.map((item) => item.encrypted));
  for (const item of payload.input) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !Object.hasOwn(item, "encrypted_content")) continue;
    if (item.type !== "reasoning") {
      counters.delegationMisses++;
      throw routerError("REASONING_TYPE_INVALID", "DeepSeek reasoning provenance type is invalid.", 409);
    }
    if (item.id !== undefined && (typeof item.id !== "string" || item.id.length < 1 || item.id.length > 256)) {
      counters.delegationMisses++;
      throw routerError("REASONING_ID_INVALID", "DeepSeek reasoning provenance id is invalid.", 409);
    }
    if (typeof item.encrypted_content !== "string" || item.encrypted_content.length < 1) {
      counters.delegationMisses++;
      throw routerError("REASONING_CIPHERTEXT_INVALID", "DeepSeek reasoning provenance ciphertext is invalid.", 409);
    }
    const cipherDigest = reasoningCipherDigest(item.encrypted_content);
    const expectedId = prepared.reasoningCipherDigests.get(cipherDigest);
    const valid = item.id === undefined
      ? typeof expectedId === "string"
      : expectedId === item.id && prepared.reasoningDigests.get(item.id) === reasoningDigest(item.id, item.encrypted_content);
    if (!valid) {
      counters.delegationMisses++;
      throw routerError("REASONING_PROVENANCE_UNKNOWN", "DeepSeek reasoning provenance is unknown for this task.", 409);
    }
    recognizedEncryptedNodes.add(item);
  }
  if (encryptedNodes.size !== recognizedEncryptedNodes.size || [...encryptedNodes].some((node) => !recognizedEncryptedNodes.has(node))) {
    counters.delegationMisses++;
    throw routerError("ENCRYPTED_PAYLOAD_UNSUPPORTED", "DeepSeek encrypted payload is unsupported or in an invalid position.", 409);
  }
  return { taskName, prepared, encryptedMessages, plaintextMessages, pendingFollowup, observedEnvelopeDigests };
}

function injectDelegationMessages(payload, requestDigest) {
  const inspected = inspectDelegationMessages(payload);
  if (inspected.pendingFollowup) {
    const pending = inspected.pendingFollowup;
    if (pending.requestDigest && pending.requestDigest !== requestDigest) {
      throw routerError("FOLLOWUP_REQUEST_MISMATCH", "The prepared DeepSeek follow-up is already bound to another provider request.", 409);
    }
    if (pending.inFlight > 0) {
      throw routerError("FOLLOWUP_REQUEST_IN_PROGRESS", "The same DeepSeek follow-up provider request is already running.", 409);
    }
    pending.requestDigest = requestDigest;
    pending.inFlight = 1;
  } else if (inspected.prepared.lastCommittedFollowupRequestDigest === requestDigest) {
    throw routerError("FOLLOWUP_REQUEST_REPLAYED", "The same DeepSeek follow-up provider request was already committed.", 409);
  }
  inspected.encryptedMessages.forEach(({ value, encrypted }, index) => {
    value.content = value.content.flatMap((content) => content === encrypted
      ? [{ type: "input_text", text: inspected.plaintextMessages[index] }]
      : [content]);
    value.type = "message";
    value.role = "user";
    for (const field of ["author", "recipient", "status", "phase", "metadata", "internal_chat_message_metadata_passthrough"]) delete value[field];
  });
  touchDelegation(inspected.prepared);
  counters.delegationsInjected++;
  inspected.requestDigest = requestDigest;
  return inspected;
}

function releasePendingFollowup(delegation) {
  const pending = delegation?.pendingFollowup;
  if (!pending) return;
  pending.inFlight = Math.max(0, pending.inFlight - 1);
  if (pending.inFlight === 0 && pending.expired && delegation.prepared.pendingFollowup === pending) {
    delegation.prepared.pendingFollowup = null;
  }
}

async function acquireCredentialBinding(record) {
  const predecessor = record.credentialBindingTail;
  let release;
  record.credentialBindingTail = new Promise((resolveRelease) => { release = resolveRelease; });
  await predecessor;
  return release;
}

function activateParentFallback(payload, delegation, runtime, reason) {
  const model = delegation.prepared.fallbackModel || lastParentModel || runtime.parentModel || "";
  if (!validParentModel(model)) {
    throw routerError("PARENT_FALLBACK_MODEL_UNAVAILABLE", "The parent GPT model is unavailable for safe fallback.", 503);
  }
  const transitioning = delegation.prepared.providerMode !== "parent";
  if (transitioning) {
    payload.input = payload.input.filter((item) => !(item?.type === "reasoning" && Object.hasOwn(item, "encrypted_content")));
    delete payload.previous_response_id;
    delegation.prepared.reasoningDigests.clear();
    delegation.prepared.reasoningCipherDigests.clear();
    delegation.prepared.responseIdDigests.clear();
    delegation.prepared.credentialId = "";
    delegation.prepared.providerMode = "parent";
    delegation.prepared.fallbackModel = model;
    delegation.prepared.fallbackReason = reason;
    if (reason === "payload_too_large") counters.payloadTooLargeFallbacks++;
    else counters.unavailableCredentialFallbacks++;
  }
  payload.model = delegation.prepared.fallbackModel;
  touchDelegation(delegation.prepared);
  counters.parentFallbackRequests++;
  return Buffer.from(JSON.stringify(payload));
}

function upstreamUrl(baseUrl, suffix, query) {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/$/, "")}${suffix}`;
  base.search = query;
  return base;
}

async function readResponseBodyLimited(body, resetIdleTimer, limit = maxModelsResponseBytes, errorMessage = "Parent model catalog is too large.") {
  if (!body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  resetIdleTimer();
  for await (const chunk of Readable.fromWeb(body)) {
    resetIdleTimer();
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error(errorMessage), { statusCode: 502 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function mergedModelsResponse(upstream, runtime, resetIdleTimer) {
  const declaredLength = Number.parseInt(upstream.headers.get("content-length") || "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxModelsResponseBytes) {
    throw Object.assign(new Error("Parent model catalog is too large."), { statusCode: 502 });
  }
  const body = await readResponseBodyLimited(upstream.body, resetIdleTimer);
  let payload;
  let catalog;
  try {
    payload = JSON.parse(body.toString("utf8"));
    catalog = JSON.parse(await readFile(runtime.catalogFile, "utf8"));
  } catch {
    throw Object.assign(new Error("Model catalog could not be decoded."), { statusCode: 502 });
  }
  if (!Array.isArray(payload?.models) || !Array.isArray(catalog?.models)) {
    throw Object.assign(new Error("Model catalog has an invalid shape."), { statusCode: 502 });
  }
  const selected = catalog.models.find((model) => model?.slug === runtime.selectedModel);
  if (!selected || selected.supported_in_api !== true || selected.visibility !== "hide" ||
      !Number.isInteger(selected.priority) || selected.priority < 10_000 || !Array.isArray(selected.input_modalities) ||
      !selected.input_modalities.includes("text") ||
      (runtime.selectedModel === "deepseek-flash" && !selected.input_modalities.includes("image"))) {
    throw Object.assign(new Error("Selected DeepSeek model metadata is invalid."), { statusCode: 502 });
  }
  return Buffer.from(JSON.stringify({ ...payload, models: [...payload.models.filter((model) => model?.slug !== runtime.selectedModel), selected] }));
}

function waitForDrainOrClose(response) {
  if (response.destroyed) return Promise.resolve(false);
  return new Promise((resolveWait) => {
    const finish = (drained) => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
      resolveWait(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
  });
}

function addReasoningCandidate(candidates, item) {
  if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "reasoning" ||
      !Object.hasOwn(item, "encrypted_content")) return;
  if (typeof item.id !== "string" || item.id.length < 1 || item.id.length > 256 ||
      typeof item.encrypted_content !== "string" || item.encrypted_content.length < 1 ||
      Buffer.byteLength(item.encrypted_content, "utf8") > maxProvenanceItemBytes) {
    throw Object.assign(new Error("DeepSeek returned invalid reasoning provenance."), { statusCode: 502 });
  }
  const digest = reasoningDigest(item.id, item.encrypted_content);
  const cipherDigest = reasoningCipherDigest(item.encrypted_content);
  const existing = candidates.get(item.id);
  if (existing && (existing.digest !== digest || existing.cipherDigest !== cipherDigest)) {
    throw Object.assign(new Error("DeepSeek returned conflicting reasoning provenance."), { statusCode: 502 });
  }
  candidates.set(item.id, { digest, cipherDigest });
  if (candidates.size > maxReasoningDigestsPerTask) {
    throw Object.assign(new Error("DeepSeek returned too many reasoning provenance items."), { statusCode: 502 });
  }
}

class JsonProvenanceObserver {
  constructor() {
    this.decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    this.stack = [];
    this.rootSeen = false;
    this.rootComplete = false;
    this.mode = "default";
    this.stringRole = "";
    this.stringRaw = "";
    this.stringBytes = 0;
    this.collectString = false;
    this.escapePending = false;
    this.unicodeRemaining = 0;
    this.numberState = "";
    this.literalExpected = "";
    this.literalIndex = 0;
    this.statusSeen = 0;
    this.status = null;
    this.responseIdSeen = 0;
    this.responseId = null;
    this.outputSeen = false;
    this.capture = "";
    this.captureBytes = 0;
    this.captureContext = null;
    this.candidates = new Map();
  }

  feed(chunk) { this.#scan(this.decoder.decode(chunk, { stream: true })); }

  #fail(message = "DeepSeek returned malformed JSON while recording reasoning provenance.") {
    throw Object.assign(new Error(message), { statusCode: 502 });
  }

  #top() { return this.stack.at(-1) || null; }

  #expectingValue(context = this.#top()) {
    if (!context) return !this.rootSeen && !this.rootComplete;
    return context.type === "object"
      ? context.state === "value"
      : context.state === "value" || context.state === "valueOrEnd";
  }

  #appendCapture(char) {
    if (!this.captureContext) return;
    this.capture += char;
    this.captureBytes += Buffer.byteLength(char, "utf8");
    if (this.captureBytes > maxProvenanceItemBytes) {
      this.#fail("DeepSeek response output item is too large.");
    }
  }

  #beginValue(kind, opening = "") {
    const parent = this.#top();
    let rootOutputArray = false;
    let captureOutputObject = false;
    let valueRole = "value";
    if (!parent) {
      if (this.rootSeen || this.rootComplete || kind !== "object") this.#fail();
      this.rootSeen = true;
    } else if (parent.type === "object") {
      if (parent.state !== "value") this.#fail();
      const key = parent.key;
      parent.key = null;
      parent.state = "commaOrEnd";
      if (parent.root && key === "status") {
        valueRole = "status";
        if (kind !== "string") this.status = null;
      }
      if (parent.root && key === "id") {
        valueRole = "responseId";
        if (kind !== "string") this.responseId = null;
      }
      if (parent.root && key === "output" && kind === "array") rootOutputArray = true;
    } else {
      if (!this.#expectingValue(parent)) this.#fail();
      captureOutputObject = parent.rootOutput === true && kind === "object";
      parent.state = "commaOrEnd";
    }

    if (kind === "object") {
      if (this.stack.length >= maxJsonNestingDepth) this.#fail("DeepSeek JSON response exceeded the nesting safety limit.");
      const context = { type: "object", state: "keyOrEnd", key: null, root: !parent, capturedOutputItem: captureOutputObject };
      this.stack.push(context);
      if (captureOutputObject) {
        this.capture = opening;
        this.captureBytes = Buffer.byteLength(opening, "utf8");
        this.captureContext = context;
      }
    } else if (kind === "array") {
      if (this.stack.length >= maxJsonNestingDepth) this.#fail("DeepSeek JSON response exceeded the nesting safety limit.");
      this.stack.push({ type: "array", state: "valueOrEnd", rootOutput: rootOutputArray });
    }
    return valueRole;
  }

  #startString(role, collect) {
    this.mode = "string";
    this.stringRole = role;
    this.stringRaw = collect ? '"' : "";
    this.stringBytes = collect ? 1 : 0;
    this.collectString = collect;
    this.escapePending = false;
    this.unicodeRemaining = 0;
  }

  #finishString() {
    if (this.escapePending || this.unicodeRemaining) this.#fail();
    let decoded = null;
    if (this.collectString) {
      try { decoded = JSON.parse(this.stringRaw); }
      catch { this.#fail(); }
    }
    if (this.stringRole === "key") {
      const context = this.#top();
      if (!context || context.type !== "object" || !["key", "keyOrEnd"].includes(context.state)) this.#fail();
      context.key = decoded;
      context.state = "colon";
      if (context.root && decoded === "status") {
        this.statusSeen++;
        if (this.statusSeen > 1) this.#fail("DeepSeek JSON response contains duplicate status fields.");
      }
      if (context.root && decoded === "id") {
        this.responseIdSeen++;
        if (this.responseIdSeen > 1) this.#fail("DeepSeek JSON response contains duplicate id fields.");
      }
      if (context.root && decoded === "output") {
        if (this.outputSeen) this.#fail("DeepSeek JSON response contains duplicate output fields.");
        this.outputSeen = true;
      }
    } else if (this.stringRole === "status") {
      this.status = decoded;
    } else if (this.stringRole === "responseId") {
      this.responseId = decoded;
    }
    this.mode = "default";
    this.stringRole = "";
    this.stringRaw = "";
    this.collectString = false;
  }

  #startNumber(char) {
    this.mode = "number";
    if (char === "-") this.numberState = "sign";
    else if (char === "0") this.numberState = "zero";
    else this.numberState = "integer";
  }

  #feedNumber(char) {
    if (this.numberState === "sign") {
      if (char === "0") this.numberState = "zero";
      else if (/[1-9]/.test(char)) this.numberState = "integer";
      else this.#fail();
      return true;
    }
    if (this.numberState === "zero") {
      if (char === ".") this.numberState = "dot";
      else if (/[eE]/.test(char)) this.numberState = "exponentMark";
      else return false;
      return true;
    }
    if (this.numberState === "integer") {
      if (/[0-9]/.test(char)) return true;
      if (char === ".") this.numberState = "dot";
      else if (/[eE]/.test(char)) this.numberState = "exponentMark";
      else return false;
      return true;
    }
    if (this.numberState === "dot") {
      if (!/[0-9]/.test(char)) this.#fail();
      this.numberState = "fraction";
      return true;
    }
    if (this.numberState === "fraction") {
      if (/[0-9]/.test(char)) return true;
      if (/[eE]/.test(char)) { this.numberState = "exponentMark"; return true; }
      return false;
    }
    if (this.numberState === "exponentMark") {
      if (/[+-]/.test(char)) this.numberState = "exponentSign";
      else if (/[0-9]/.test(char)) this.numberState = "exponent";
      else this.#fail();
      return true;
    }
    if (this.numberState === "exponentSign") {
      if (!/[0-9]/.test(char)) this.#fail();
      this.numberState = "exponent";
      return true;
    }
    if (this.numberState === "exponent") {
      if (/[0-9]/.test(char)) return true;
      return false;
    }
    this.#fail();
  }

  #finishNumber() {
    if (!["zero", "integer", "fraction", "exponent"].includes(this.numberState)) this.#fail();
    this.mode = "default";
    this.numberState = "";
  }

  #closeContainer(type) {
    const context = this.#top();
    if (!context || context.type !== type) this.#fail();
    const canClose = type === "object"
      ? context.state === "keyOrEnd" || context.state === "commaOrEnd"
      : context.state === "valueOrEnd" || context.state === "commaOrEnd";
    if (!canClose) this.#fail();
    this.stack.pop();
    if (context.capturedOutputItem) {
      try { addReasoningCandidate(this.candidates, JSON.parse(this.capture)); }
      catch (error) {
        if (error instanceof SyntaxError) this.#fail();
        throw error;
      }
      this.capture = "";
      this.captureBytes = 0;
      this.captureContext = null;
    }
    if (!this.stack.length) this.rootComplete = true;
  }

  #scan(text) {
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      this.#appendCapture(char);
      if (this.mode === "string") {
        if (this.collectString) {
          this.stringBytes += Buffer.byteLength(char, "utf8");
          if (this.stringBytes <= maxJsonTopLevelStringBytes) this.stringRaw += char;
          else {
            this.collectString = false;
            this.stringRaw = "";
            if (this.stringRole === "status") this.status = null;
          }
        }
        if (this.unicodeRemaining) {
          if (!/[0-9A-Fa-f]/.test(char)) this.#fail();
          this.unicodeRemaining--;
          continue;
        }
        if (this.escapePending) {
          this.escapePending = false;
          if (char === "u") this.unicodeRemaining = 4;
          else if (!/["\\/bfnrt]/.test(char)) this.#fail();
          continue;
        }
        if (char === "\\") { this.escapePending = true; continue; }
        if (char === '"') { this.#finishString(); continue; }
        if (char.charCodeAt(0) < 0x20) this.#fail();
        continue;
      }
      if (this.mode === "number") {
        if (this.#feedNumber(char)) continue;
        this.#finishNumber();
        index--;
        if (this.captureContext) {
          this.capture = this.capture.slice(0, -char.length);
          this.captureBytes -= Buffer.byteLength(char, "utf8");
        }
        continue;
      }
      if (this.mode === "literal") {
        if (char !== this.literalExpected[this.literalIndex]) this.#fail();
        this.literalIndex++;
        if (this.literalIndex === this.literalExpected.length) {
          this.mode = "default";
          this.literalExpected = "";
          this.literalIndex = 0;
        }
        continue;
      }
      if (char === " " || char === "\t" || char === "\n" || char === "\r") continue;
      if (this.rootComplete) this.#fail();
      const context = this.#top();
      if (char === '"') {
        if (context?.type === "object" && ["key", "keyOrEnd"].includes(context.state)) {
          this.#startString("key", context.root === true);
        } else {
          const role = this.#beginValue("string");
          this.#startString(role, role === "status" || role === "responseId");
        }
        continue;
      }
      if (char === "{") { this.#beginValue("object", "{"); continue; }
      if (char === "[") { this.#beginValue("array"); continue; }
      if (char === "}") { this.#closeContainer("object"); continue; }
      if (char === "]") { this.#closeContainer("array"); continue; }
      if (char === ":") {
        if (!context || context.type !== "object" || context.state !== "colon") this.#fail();
        context.state = "value";
        continue;
      }
      if (char === ",") {
        if (!context || context.state !== "commaOrEnd") this.#fail();
        context.state = context.type === "object" ? "key" : "value";
        continue;
      }
      if (char === "-" || /[0-9]/.test(char)) {
        this.#beginValue("number");
        this.#startNumber(char);
        continue;
      }
      const literal = char === "t" ? "true" : char === "f" ? "false" : char === "n" ? "null" : "";
      if (literal) {
        this.#beginValue("literal");
        this.mode = "literal";
        this.literalExpected = literal;
        this.literalIndex = 1;
        continue;
      }
      this.#fail();
    }
  }

  finish() {
    this.#scan(this.decoder.decode());
    if (this.mode === "number") this.#finishNumber();
    if (this.mode !== "default" || this.stack.length || !this.rootSeen || !this.rootComplete || this.captureContext) this.#fail();
    if (this.statusSeen !== 1 || this.status !== "completed") {
      throw Object.assign(new Error("DeepSeek JSON response did not complete successfully."), { statusCode: 502 });
    }
    if (this.responseIdSeen > 0 && !validResponseId(this.responseId)) {
      this.#fail("DeepSeek JSON response contains an invalid id field.");
    }
    return { candidates: this.candidates, responseId: this.responseId };
  }
}

class SseProvenanceObserver {
  constructor() {
    this.streaming = true;
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.candidates = new Map();
    this.completed = false;
    this.terminalBlock = null;
    this.responseId = null;
  }

  feed(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  #drain(final) {
    const forward = [];
    while (true) {
      const match = this.buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      const wireBlock = this.buffer.slice(0, match.index + match[0].length);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const disposition = this.#event(block);
      if (disposition === "forward") forward.push(wireBlock);
      else if (disposition === "terminal") this.terminalBlock = wireBlock;
    }
    if (Buffer.byteLength(this.buffer, "utf8") > maxSseEventBytes) {
      throw Object.assign(new Error("DeepSeek SSE event exceeded the provenance safety limit."), { statusCode: 502 });
    }
    if (final && this.buffer.trim()) {
      const disposition = this.#event(this.buffer);
      if (disposition === "forward") forward.push(this.buffer);
      else if (disposition === "terminal") this.terminalBlock = this.buffer;
      this.buffer = "";
    }
    return forward;
  }

  #event(block) {
    if (Buffer.byteLength(block, "utf8") > maxSseEventBytes) {
      throw Object.assign(new Error("DeepSeek SSE event exceeded the provenance safety limit."), { statusCode: 502 });
    }
    let eventName = "";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return this.completed ? "drop" : "forward";
    const raw = data.join("\n");
    if (raw === "[DONE]") return "drop";
    let payload;
    try { payload = JSON.parse(raw); }
    catch { throw Object.assign(new Error("DeepSeek returned malformed SSE JSON."), { statusCode: 502 }); }
    const payloadType = typeof payload?.type === "string" ? payload.type : "";
    if (eventName && payloadType && eventName !== payloadType) {
      throw Object.assign(new Error("DeepSeek returned an inconsistent SSE event type."), { statusCode: 502 });
    }
    const type = payloadType || eventName;
    if (["response.failed", "response.incomplete", "response.cancelled", "error"].includes(type)) {
      throw Object.assign(new Error("DeepSeek SSE response failed before provenance could be committed."), { statusCode: 502 });
    }
    if (this.completed) {
      throw Object.assign(new Error("DeepSeek returned data after its SSE completion event."), { statusCode: 502 });
    }
    const responseId = payload?.response?.id;
    if (responseId !== undefined) {
      if (!validResponseId(responseId)) {
        throw Object.assign(new Error("DeepSeek SSE response contains an invalid response id."), { statusCode: 502 });
      }
      if (this.responseId && this.responseId !== responseId) {
        throw Object.assign(new Error("DeepSeek SSE response id changed during one response."), { statusCode: 502 });
      }
      this.responseId = responseId;
    }
    if (type === "response.output_item.done") addReasoningCandidate(this.candidates, payload?.item);
    if (type === "response.completed") {
      this.completed = true;
      return "terminal";
    }
    return "forward";
  }

  finish() {
    this.buffer += this.decoder.decode();
    const forward = this.#drain(true);
    if (!this.completed || !this.terminalBlock) {
      throw Object.assign(new Error("DeepSeek SSE response ended without a completion event."), { statusCode: 502 });
    }
    return { candidates: this.candidates, responseId: this.responseId, terminalBlock: this.terminalBlock, forward };
  }
}

function provenanceObserver(contentType) {
  return String(contentType || "").toLowerCase().startsWith("text/event-stream")
    ? new SseProvenanceObserver()
    : new JsonProvenanceObserver();
}

function commitResponseProvenance(taskName, record, candidates, responseId, delegation) {
  pruneDelegations();
  if (delegationRecords.get(taskName) !== record || !record.active) {
    throw Object.assign(new Error("DeepSeek task expired before reasoning provenance could be committed."), { statusCode: 409 });
  }
  const globalTotal = totalReasoningDigests();
  const additions = [];
  for (const [id, candidate] of candidates) {
    const { digest, cipherDigest } = candidate;
    const existing = record.reasoningDigests.get(id);
    if (existing && existing !== digest) {
      throw Object.assign(new Error("DeepSeek reasoning provenance changed within one task."), { statusCode: 502 });
    }
    const existingCipherId = record.reasoningCipherDigests.get(cipherDigest);
    if (existingCipherId && existingCipherId !== id) {
      throw Object.assign(new Error("DeepSeek reused one reasoning ciphertext across multiple ids."), { statusCode: 502 });
    }
    if (!existing) additions.push([id, digest, cipherDigest]);
  }
  if (record.reasoningDigests.size + additions.length > maxReasoningDigestsPerTask ||
      globalTotal + additions.length > maxReasoningDigestsGlobal) {
    delegationRecords.delete(taskName);
    throw Object.assign(new Error("DeepSeek reasoning provenance capacity is exhausted."), { statusCode: 503 });
  }
  for (const [id, digest, cipherDigest] of additions) {
    record.reasoningDigests.set(id, digest);
    record.reasoningCipherDigests.set(cipherDigest, id);
  }
  if (responseId) {
    const digest = responseIdDigest(responseId);
    for (const [otherTaskName, otherRecord] of delegationRecords) {
      if (otherTaskName !== taskName && otherRecord.responseIdDigests.has(digest)) {
        throw Object.assign(new Error("DeepSeek reused one response id across multiple tasks."), { statusCode: 502 });
      }
    }
    if (!record.responseIdDigests.has(digest) &&
        (record.responseIdDigests.size >= maxResponseIdDigestsPerTask || totalResponseIdDigests() >= maxResponseIdDigestsGlobal)) {
      delegationRecords.delete(taskName);
      throw Object.assign(new Error("DeepSeek response provenance capacity is exhausted."), { statusCode: 503 });
    }
    record.responseIdDigests.add(digest);
  }
  if (delegation?.observedEnvelopeDigests?.length) {
    if (record.pendingFollowup !== delegation.pendingFollowup ||
        delegation.observedEnvelopeDigests.length !== record.messages.length + (delegation.pendingFollowup ? 1 : 0) ||
        record.envelopeDigests.some((digest, index) => delegation.observedEnvelopeDigests[index] !== digest)) {
      throw Object.assign(new Error("DeepSeek follow-up state changed before it could be committed."), { statusCode: 409 });
    }
    if (delegation.pendingFollowup) {
      record.messages.push(delegation.pendingFollowup.message);
      record.lastCommittedFollowupRequestDigest = delegation.requestDigest;
      record.pendingFollowup = null;
    }
    record.envelopeDigests = [...delegation.observedEnvelopeDigests];
  }
  touchDelegation(record);
}

async function proxy(request, response, body, reservation) {
  const runtime = await loadRuntime();
  if (runtime.routeToken !== initialRuntime.routeToken || runtime.port !== initialRuntime.port) {
    throw Object.assign(new Error("DeepSeek router endpoint changed."), { statusCode: 503 });
  }
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const suffix = requestUrl.pathname.slice(routePrefix.length);
  const modelsRequest = request.method === "GET" && suffix === "/models";
  let routeToDeepSeek = false;
  let payload = null;
  let requestDigest = "";
  if (!modelsRequest) {
    const jsonBody = await decodeJsonBody(body, request.headers["content-encoding"], reservation);
    requestDigest = providerRequestDigest(jsonBody);
    try { payload = JSON.parse(jsonBody.toString("utf8")); }
    catch { throw Object.assign(new Error("Provider request is not valid JSON."), { statusCode: 400 }); }
    const selectedModelRequested = typeof payload?.model === "string" && payload.model !== "" && payload.model === runtime.selectedModel;
    if (typeof payload?.model === "string" && payload.model.startsWith("deepseek-") && !selectedModelRequested) {
      throw Object.assign(new Error("DeepSeek request model does not match the active configured model."), { statusCode: 409 });
    }
    if (validParentModel(payload?.model)) lastParentModel = payload.model;
    routeToDeepSeek = selectedModelRequested || Boolean(preparedDelegationForPayload(payload));
  }
  let headers;
  let baseUrl;
  let upstreamBody = body;
  let bodyRewritten = false;
  let delegation = null;
  let deepseekCandidates = [];
  let deepseekCredentialValues = [];
  let releaseCredentialBinding = null;
  let usingDeepSeek = routeToDeepSeek;
  const configureParentFallback = (reason) => {
    if (typeof request.headers.authorization !== "string" || request.headers.authorization.length < 16) {
      throw Object.assign(new Error("Parent provider authorization is unavailable."), { statusCode: 401 });
    }
    upstreamBody = activateParentFallback(payload, delegation, runtime, reason);
    reserveProviderBytes(upstreamBody.length, reservation);
    bodyRewritten = true;
    headers = parentHeaders(request.headers, false, true);
    baseUrl = runtime.parentBaseUrl;
    usingDeepSeek = false;
    counters.parentRequests++;
    releaseCredentialBinding?.();
    releaseCredentialBinding = null;
  };
  try {
    if (routeToDeepSeek) {
      delegation = injectDelegationMessages(payload, requestDigest);
      if (delegation.prepared.providerMode === "parent") {
        configureParentFallback(delegation.prepared.fallbackReason || "unavailable_credentials");
      } else {
        payload.model = runtime.selectedModel;
        if (!delegation.prepared.credentialId) releaseCredentialBinding = await acquireCredentialBinding(delegation.prepared);
        if (delegationRecords.get(delegation.taskName) !== delegation.prepared || !delegation.prepared.active) {
          throw Object.assign(new Error("DeepSeek task expired before credential binding."), { statusCode: 409 });
        }
        if (delegation.prepared.providerMode === "parent") {
          configureParentFallback(delegation.prepared.fallbackReason || "unavailable_credentials");
        } else {
          let settings;
          let credentials;
          try {
            settings = JSON.parse(await readFile(runtime.settingsFile, "utf8"));
            if (settings?.model !== runtime.selectedModel) throw new Error("DeepSeek model configuration changed.");
            credentials = credentialsFromSettingsDocument(settings, { defaultBaseUrl: defaultDeepSeekBaseUrl });
          } catch {
            configureParentFallback("unavailable_credentials");
          }
          if (usingDeepSeek) {
            deepseekCredentialValues = credentials.map((credential) => credential.apiKey);
            credentialPool.sync(settings?.revision);
            deepseekCandidates = credentialPool.candidates(credentials, { pinnedId: delegation.prepared.credentialId || "" });
            if (!deepseekCandidates.length) configureParentFallback("unavailable_credentials");
          }
          if (usingDeepSeek) {
            bodyRewritten = true;
            upstreamBody = Buffer.from(JSON.stringify(payload));
            reserveProviderBytes(upstreamBody.length, reservation);
            baseUrl = deepseekCandidates[0].baseUrl;
            counters.deepseekRequests++;
          }
        }
      }
    } else {
      if (typeof request.headers.authorization !== "string" || request.headers.authorization.length < 16) {
        throw Object.assign(new Error("Parent provider authorization is unavailable."), { statusCode: 401 });
      }
      headers = parentHeaders(request.headers, modelsRequest);
      baseUrl = runtime.parentBaseUrl;
      counters.parentRequests++;
    }
  } catch (error) {
    releasePendingFollowup(delegation);
    releaseCredentialBinding?.();
    delegation = null;
    releaseCredentialBinding = null;
    throw error;
  }

  const controller = new AbortController();
  const headerTimer = setTimeout(() => controller.abort(), upstreamHeaderTimeoutMs);
  const overallTimer = setTimeout(() => controller.abort(), upstreamOverallTimeoutMs);
  request.on("aborted", () => controller.abort());
  response.on("close", () => { if (!response.writableEnded) controller.abort(); });
  let idleTimer = null;
  try {
    let upstream;
    let selectedCredential = null;
    const attempts = usingDeepSeek ? deepseekCandidates : [null];
    for (let index = 0; index < attempts.length; index++) {
      selectedCredential = attempts[index];
      if (usingDeepSeek) {
        headers = deepseekHeaders(selectedCredential.apiKey, request.headers, bodyRewritten);
        baseUrl = selectedCredential.baseUrl;
        counters.deepseekAttempts++;
      }
      upstream = await fetch(upstreamUrl(baseUrl, suffix, usingDeepSeek ? "" : requestUrl.search), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : upstreamBody,
        redirect: "error",
        signal: controller.signal,
      });
      if (usingDeepSeek) counters.deepseekUpstreamResponses++;
      else counters.parentUpstreamResponses++;
      if (usingDeepSeek && upstream.status === 413) {
        try { await upstream.body?.cancel(); } catch {}
        configureParentFallback("payload_too_large");
        upstream = await fetch(upstreamUrl(baseUrl, suffix, requestUrl.search), {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : upstreamBody,
          redirect: "error",
          signal: controller.signal,
        });
        counters.parentUpstreamResponses++;
        break;
      }
      const reason = usingDeepSeek ? failoverReason(upstream.status) : "";
      if (!reason) break;
      credentialPool.markFailure(selectedCredential.id, reason);
      const pinned = Boolean(delegation.prepared.credentialId);
      if (pinned || index === attempts.length - 1) {
        try { await upstream.body?.cancel(); } catch {}
        configureParentFallback("unavailable_credentials");
        upstream = await fetch(upstreamUrl(baseUrl, suffix, requestUrl.search), {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : upstreamBody,
          redirect: "error",
          signal: controller.signal,
        });
        counters.parentUpstreamResponses++;
        break;
      }
      try { await upstream.body?.cancel(); } catch {}
      counters.deepseekFailovers++;
    }
    if (usingDeepSeek && upstream.ok) {
      credentialPool.markSuccess(selectedCredential.id);
      if (!delegation.prepared.credentialId) delegation.prepared.credentialId = selectedCredential.id;
      else if (delegation.prepared.credentialId !== selectedCredential.id) {
        throw Object.assign(new Error("DeepSeek task credential binding changed unexpectedly."), { statusCode: 409 });
      }
      delegation.prepared.providerMode = "deepseek";
    }
    clearTimeout(headerTimer);
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), upstreamIdleTimeoutMs);
    };
    if (usingDeepSeek && !upstream.ok) {
      try { await upstream.body?.cancel(); } catch {}
      response.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { code: "DEEPSEEK_UPSTREAM_ERROR", message: `DeepSeek upstream returned HTTP ${upstream.status}.` } }));
      return;
    }
    const responseHeaders = {};
    if (usingDeepSeek) {
      if (upstream.headers.get("content-encoding")) {
        throw Object.assign(new Error("DeepSeek returned an unsupported encoded response."), { statusCode: 502 });
      }
      responseHeaders["cache-control"] = "no-store";
      responseHeaders["content-type"] = String(upstream.headers.get("content-type") || "").toLowerCase().startsWith("text/event-stream")
        ? "text/event-stream"
        : "application/json";
    } else {
      for (const [name, value] of upstream.headers) {
        if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name) && !(modelsRequest && name === "etag")) {
          responseHeaders[name] = value;
        }
      }
    }
    if (modelsRequest && upstream.ok) {
      try {
        const merged = await mergedModelsResponse(upstream, runtime, resetIdleTimer);
        for (const name of ["age", "content-md5", "digest", "expires", "last-modified"]) delete responseHeaders[name];
        responseHeaders["cache-control"] = "no-store";
        responseHeaders["content-type"] = "application/json";
        response.writeHead(upstream.status, responseHeaders);
        response.end(merged);
        return;
      } catch (error) {
        controller.abort();
        try { await upstream.body?.cancel(); } catch {}
        throw error;
      }
    }
    if (modelsRequest && upstream.status === 304) {
      controller.abort();
      try { await upstream.body?.cancel(); } catch {}
      throw Object.assign(new Error("Parent model catalog returned an unusable not-modified response."), { statusCode: 502 });
    }
    const observer = delegation && upstream.ok ? provenanceObserver(upstream.headers.get("content-type")) : null;
    const credentialNeedles = usingDeepSeek ? deepseekCredentialValues.map((value) => Buffer.from(value, "utf8")) : [];
    const credentialTails = credentialNeedles.map(() => Buffer.alloc(0));
    const assertCredentialNotReflected = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let index = 0; index < credentialNeedles.length; index++) {
        const needle = credentialNeedles[index];
        const tail = credentialTails[index];
        const combined = tail.length ? Buffer.concat([tail, bytes]) : bytes;
        if (combined.includes(needle)) {
          throw Object.assign(new Error("DeepSeek response reflected a configured authorization credential."), { statusCode: 502 });
        }
        const tailLength = Math.min(Math.max(needle.length - 1, 0), combined.length);
        credentialTails[index] = tailLength ? combined.subarray(combined.length - tailLength) : Buffer.alloc(0);
      }
    };
    response.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) { response.end(); return; }
    resetIdleTimer();
    for await (const chunk of Readable.fromWeb(upstream.body)) {
      resetIdleTimer();
      const forward = observer?.feed(chunk);
      const outgoing = observer?.streaming ? forward : [chunk];
      for (const forwardedChunk of outgoing) {
        assertCredentialNotReflected(forwardedChunk);
        if (!response.write(forwardedChunk) && !await waitForDrainOrClose(response)) {
          controller.abort();
          return;
        }
      }
    }
    if (observer) {
      const observed = observer.finish();
      const candidates = observed.candidates;
      if (observer.streaming) {
        for (const forwardedChunk of observed.forward) assertCredentialNotReflected(forwardedChunk);
        assertCredentialNotReflected(observed.terminalBlock);
      }
      commitResponseProvenance(delegation.taskName, delegation.prepared, candidates, observed.responseId, delegation);
      if (observer.streaming) {
        for (const forwardedChunk of observed.forward) {
          if (!response.write(forwardedChunk) && !await waitForDrainOrClose(response)) return;
        }
        if (!response.write(observed.terminalBlock) && !await waitForDrainOrClose(response)) return;
      }
    }
    response.end();
  } finally {
    releasePendingFollowup(delegation);
    releaseCredentialBinding?.();
    clearTimeout(headerTimer);
    clearTimeout(overallTimer);
    clearTimeout(idleTimer);
  }
}

async function credentialHealth() {
  try {
    const settings = JSON.parse(await readFile(initialRuntime.settingsFile, "utf8"));
    const credentials = credentialsFromSettingsDocument(settings, { defaultBaseUrl: defaultDeepSeekBaseUrl });
    credentialPool.sync(settings?.revision);
    const statuses = credentialPool.statuses(credentials);
    return credentials.map((credential) => ({
      id: credential.id,
      status: credential.enabled ? statuses.get(credential.id)?.status || "ready" : "disabled",
    }));
  } catch {
    return [];
  }
}

async function applyCredentialFailure(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !["revision", "id", "reason"].includes(key)) ||
      !Number.isInteger(payload.revision) || !["invalid", "exhausted"].includes(payload.reason)) {
    throw Object.assign(new Error("Invalid credential failure update."), { statusCode: 400 });
  }
  let settings;
  try { settings = JSON.parse(await readFile(initialRuntime.settingsFile, "utf8")); }
  catch { throw Object.assign(new Error("DeepSeek credential settings are unavailable."), { statusCode: 503 }); }
  let credentials;
  try { credentials = credentialsFromSettingsDocument(settings, { defaultBaseUrl: defaultDeepSeekBaseUrl }); }
  catch { throw Object.assign(new Error("DeepSeek credential pool is invalid."), { statusCode: 503 }); }
  if (settings?.revision !== payload.revision || !credentials.some((credential) => credential.enabled && credential.id === payload.id)) {
    throw Object.assign(new Error("Credential failure update does not match the active settings revision."), { statusCode: 409 });
  }
  credentialPool.sync(settings.revision);
  credentialPool.markFailure(payload.id, payload.reason);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === `/${initialRuntime.routeToken}/healthz`) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({
        status: "ok", instanceId: initialRuntime.instanceId, routerPid: process.pid, ...counters,
        providerRequestMaxBytes: maxProviderRequestBytes,
        providerBufferedMaxBytes: maxProviderBufferedBytes,
        providerBufferedBytes: bufferedProviderBytes,
        credentials: await credentialHealth(),
      }));
      return;
    }
    if (request.method === "POST" && request.url === `/${initialRuntime.routeToken}/control/credential-failure`) {
      if (request.headers.authorization !== `Bearer ${initialRuntime.shutdownToken}` || request.headers["content-encoding"] ||
          String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        request.resume();
        response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: "CREDENTIAL_CONTROL_FORBIDDEN", message: "Credential state update was not authorized." } }));
        return;
      }
      const read = await readRequestBody(request, maxCredentialControlBytes);
      try {
        let payload;
        try { payload = JSON.parse(read.body.toString("utf8")); }
        catch { throw Object.assign(new Error("Credential failure update body is not valid JSON."), { statusCode: 400 }); }
        await applyCredentialFailure(payload);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      } finally {
        bufferedControlBytes -= Math.min(read.reservedBytes, bufferedControlBytes);
      }
      return;
    }
    if (process.env.NODE_ENV === "test" && request.method === "POST" &&
        request.url === `/${initialRuntime.routeToken}/control/test-crash` &&
        request.headers.authorization === `Bearer ${initialRuntime.shutdownToken}`) {
      request.resume();
      response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      response.end(JSON.stringify({ status: "crashing", instanceId: initialRuntime.instanceId }));
      setTimeout(() => process.exit(86), 10).unref();
      return;
    }
    if (request.method === "POST" && request.url === `/${initialRuntime.routeToken}/control/shutdown`) {
      if (request.headers.authorization !== `Bearer ${initialRuntime.shutdownToken}` || request.headers["content-encoding"] ||
          ![undefined, "0"].includes(request.headers["content-length"])) {
        request.resume();
        response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: "SHUTDOWN_FORBIDDEN", message: "Managed router shutdown was not authorized." } }));
        return;
      }
      request.resume();
      response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      response.end(JSON.stringify({ status: "stopping", instanceId: initialRuntime.instanceId }));
      setTimeout(() => {
        server.closeAllConnections?.();
        server.close(() => process.exit(0));
        const forcedExit = setTimeout(() => process.exit(0), 1_000);
        forcedExit.unref();
      }, 10).unref();
      return;
    }
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if ([`/${initialRuntime.routeToken}/delegations/prepare`, `/${initialRuntime.routeToken}/delegations/followup`].includes(requestUrl.pathname)) {
      if (request.method !== "POST" || requestUrl.search || request.headers["content-encoding"] ||
          String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        request.resume();
        throw Object.assign(new Error("Invalid delegation preparation request."), { statusCode: 400 });
      }
      if (activeRequests >= maxConcurrentRequests) {
        request.resume();
        throw Object.assign(new Error("Router concurrency limit reached."), { statusCode: 503 });
      }
      activeRequests++;
      let reservedBytes = 0;
      try {
        const read = await readRequestBody(request, maxDelegationControlBytes);
        reservedBytes = read.reservedBytes;
        let payload;
        try { payload = JSON.parse(read.body.toString("utf8")); }
        catch { throw Object.assign(new Error("Delegation preparation body is not valid JSON."), { statusCode: 400 }); }
        const prepared = requestUrl.pathname.endsWith("/followup") ? prepareFollowup(payload) : prepareDelegation(payload);
        response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(prepared));
      } finally {
        bufferedControlBytes -= Math.min(reservedBytes, bufferedControlBytes);
        activeRequests--;
      }
      return;
    }
    if (!requestUrl.pathname.startsWith(`${routePrefix}/`)) {
      response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" }).end("Not found.");
      return;
    }
    if (activeRequests >= maxConcurrentRequests) {
      request.resume();
      throw Object.assign(new Error("Router concurrency limit reached."), { statusCode: 503 });
    }
    activeRequests++;
    const reservation = { bytes: 0 };
    try {
      const body = await readProviderRequestBody(request, reservation);
      await proxy(request, response, body, reservation);
    } finally {
      releaseProviderBytes(reservation.bytes, reservation);
      activeRequests--;
    }
  } catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
    response.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store" });
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{3,64}$/.test(error.code) ? error.code : "ROUTER_REQUEST_FAILED";
    response.end(JSON.stringify({ error: { code, message: `DeepSeek Subagent router could not complete the provider request. [${code}]` } }));
  }
});

server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
server.listen(initialRuntime.port, "127.0.0.1");

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
