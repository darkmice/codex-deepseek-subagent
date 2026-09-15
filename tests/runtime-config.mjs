import assert from "node:assert/strict";
import { installRouterConfig, removeRouterConfig, routerConfigActive, tomlBooleanSetting } from "../plugins/deepseek-subagent/scripts/runtime.mjs";

const baseUrl = `http://127.0.0.1:54321/${"a".repeat(48)}/v1`;
const original = `model = "gpt-5.6-sol"\nmodel_provider = "custom"\n\n[model_providers.custom]\nname = "custom"\nrequires_openai_auth = true\nwire_api = "responses"\n\n[projects]\n`;
const installed = installRouterConfig(original, baseUrl);
assert.equal(installed.originalProviderId, "custom");
assert.equal(installed.parentBaseUrl, "https://chatgpt.com/backend-api/codex/");
assert(routerConfigActive(installed.contents, baseUrl));
assert.equal(removeRouterConfig(installed.contents), original);

const updated = installRouterConfig(installed.contents, "http://127.0.0.1:54322/new-capability/v1");
assert(routerConfigActive(updated.contents, "http://127.0.0.1:54322/new-capability/v1"));
assert.equal(removeRouterConfig(updated.contents), original);

const commentedProvider = original.replace('model_provider = "custom"', 'model_provider = "custom" # keep this comment');
const commentedInstalled = installRouterConfig(commentedProvider, baseUrl);
assert(routerConfigActive(commentedInstalled.contents, baseUrl));
assert.equal(removeRouterConfig(commentedInstalled.contents), commentedProvider);

const crlfProvider = original.replaceAll("\n", "\r\n");
const crlfInstalled = installRouterConfig(crlfProvider, baseUrl);
assert.equal(removeRouterConfig(crlfInstalled.contents), crlfProvider);

const legacy = `# >>> DeepSeek Subagent managed config >>>\nmulti_agent_v2.hide_spawn_agent_metadata = false\n# <<< DeepSeek Subagent managed config <<<\n[features.multi_agent_v2]\nenabled = true\nhide_spawn_agent_metadata = false\n\n${original}`;
const migrated = installRouterConfig(legacy, baseUrl);
const restoredLegacy = removeRouterConfig(migrated.contents);
assert(!restoredLegacy.includes("multi_agent_v2.hide_spawn_agent_metadata = false"));
assert(restoredLegacy.includes("[features.multi_agent_v2]"));
assert.equal(tomlBooleanSetting(restoredLegacy, ["features", "multi_agent_v2", "enabled"]), true);
assert(restoredLegacy.includes('model_provider = "custom"'));
assert(!restoredLegacy.includes("managed config"));

assert.equal(tomlBooleanSetting("features.multi_agent_v2.enabled = true\n", ["features", "multi_agent_v2", "enabled"]), true);
assert.equal(tomlBooleanSetting("[features]\nmulti_agent_v2.enabled = true\n", ["features", "multi_agent_v2", "enabled"]), true);
assert.equal(tomlBooleanSetting("[features.multi_agent_v2]\nenabled = false\n", ["features", "multi_agent_v2", "enabled"]), false);
assert.equal(tomlBooleanSetting("multi_agent_v2.hide_spawn_agent_metadata = false\n", ["features", "multi_agent_v2", "enabled"]), null);
assert.throws(
  () => tomlBooleanSetting("features.multi_agent_v2.enabled = true\n[features.multi_agent_v2]\nenabled = true\n", ["features", "multi_agent_v2", "enabled"]),
  /multiple features\.multi_agent_v2\.enabled assignments/,
);
assert.throws(
  () => tomlBooleanSetting("features = { multi_agent_v2 = { enabled = true } }\n", ["features", "multi_agent_v2", "enabled"]),
  /not an inline table/,
);
assert.throws(
  () => tomlBooleanSetting("[[features.multi_agent_v2]]\nenabled = true\n", ["features", "multi_agent_v2", "enabled"]),
  /cannot be declared through an array table/,
);
assert.throws(
  () => tomlBooleanSetting("[features.multi_agent_v2]\nenabled = TRUE\n", ["features", "multi_agent_v2", "enabled"]),
  /must be a boolean/,
);
for (const tamperedLegacy of [
  `# >>> DeepSeek Subagent managed config >>>\nuser_setting = true\n# <<< DeepSeek Subagent managed config <<<\n${original}`,
  `# >>> DeepSeek Subagent managed config >>>\nmulti_agent_v2.hide_spawn_agent_metadata = false\nuser_setting = true\n# <<< DeepSeek Subagent managed config <<<\n${original}`,
]) {
  assert.throws(() => installRouterConfig(tamperedLegacy, baseUrl), /block was edited/);
  assert.throws(() => removeRouterConfig(tamperedLegacy), /block was edited/);
}

assert.throws(
  () => installRouterConfig('model_provider = "other"\n\n[model_providers.other]\nrequires_openai_auth = false\n', baseUrl),
  /not a ChatGPT-authenticated provider/,
);
assert.throws(
  () => installRouterConfig('model_provider = "other"\n\n[model_providers.other]\nrequires_openai_auth = true\n', baseUrl),
  /does not use the Responses wire API/,
);
assert.throws(
  () => installRouterConfig(`${original}\n[model_providers.deepseek-subagent-router]\nname = "collision"\n`, baseUrl),
  /unmanaged deepseek-subagent-router/,
);
assert.throws(
  () => installRouterConfig(`${original}\n[model_providers.deepseek-subagent-router] # existing\nname = "collision"\n`, baseUrl),
  /unmanaged deepseek-subagent-router/,
);
assert.throws(
  () => installRouterConfig(`${original}\n[model_providers."deepseek-subagent-router"]\nname = "collision"\n`, baseUrl),
  /unmanaged deepseek-subagent-router/,
);
for (const collisionConfig of [
  `${original}\n["model_providers"."deepseek-subagent-router"]\nname = "collision"\n`,
  original.replace("\n\n[model_providers.custom]", '\nmodel_providers . "deepseek-subagent-router" . name = "collision"\n\n[model_providers.custom]'),
  `${original}\n[model_providers]\n"deepseek-subagent-router" = { name = "collision" }\n`,
]) {
  assert.throws(() => installRouterConfig(collisionConfig, baseUrl), /unmanaged deepseek-subagent-router/);
}

const customBase = `${original.replace('wire_api = "responses"', 'wire_api = "responses"\nbase_url = "https://gateway.example.test/codex"')}`;
const customBaseInstalled = installRouterConfig(customBase, baseUrl);
assert.equal(customBaseInstalled.parentBaseUrl, "https://gateway.example.test/codex/");
assert.equal(removeRouterConfig(customBaseInstalled.contents), customBase);

const chatGptOverride = original.replace('\n\n[model_providers.custom]', '\nchatgpt_base_url = "https://chatgpt-gateway.example.test/codex"\n\n[model_providers.custom]');
assert.equal(installRouterConfig(chatGptOverride, baseUrl).parentBaseUrl, "https://chatgpt-gateway.example.test/codex/");

assert.throws(
  () => installRouterConfig(customBase.replace('\n\n[projects]', '\nhttp_headers = { "x-company" = "secret" }\n\n[projects]'), baseUrl),
  /unsupported routing fields: http_headers/,
);
assert.throws(
  () => installRouterConfig(`${original}\n[profiles.company]\nmodel_provider = "company"\n`, baseUrl),
  /global DeepSeek routing cannot preserve/,
);
assert.throws(
  () => installRouterConfig(original.replace('\n\n[model_providers.custom]', '\nprofiles."foo.bar".model_provider = "company"\n\n[model_providers.custom]'), baseUrl),
  /global DeepSeek routing cannot preserve them safely/,
);
assert.throws(
  () => installRouterConfig(`${original}\n[profiles.company] # work\nmodel_provider = "company"\n`, baseUrl),
  /global DeepSeek routing cannot preserve/,
);
for (const profileConfig of [
  `${original}\n["profiles".company]\nmodel_provider = "company"\n`,
  `${original}\n['profiles'.company]\nmodel_provider = "company"\n`,
  `${original}\n[profiles.company]\n"model_provider" = "company"\n`,
  original.replace("\n\n[model_providers.custom]", '\nprofiles . company . model_provider = "company"\n\n[model_providers.custom]'),
  `${original}\n[profiles]\ncompany . model_provider = "company"\n`,
  original.replace("\n\n[model_providers.custom]", '\nprofiles = { company = { model_provider = "company" } }\n\n[model_providers.custom]'),
  `${original}\n[profiles]\ncompany = { model_provider = "company" }\n`,
]) {
  assert.throws(() => installRouterConfig(profileConfig, baseUrl), /global DeepSeek routing cannot preserve/);
}

const quotedTopLevel = original
  .replace('model_provider = "custom"', '"model_provider" = "custom"')
  .replace('[model_providers.custom]', '["model_providers"."custom"]')
  .replace('requires_openai_auth = true', '"requires_openai_auth" = true')
  .replace('wire_api = "responses"', '"wire_api" = "responses"');
const quotedTopLevelInstalled = installRouterConfig(quotedTopLevel, baseUrl);
assert.equal(quotedTopLevelInstalled.originalProviderId, "custom");
assert.equal(removeRouterConfig(quotedTopLevelInstalled.contents), quotedTopLevel);

const unicodeEscapedKeys = quotedTopLevel
  .replace('"model_provider"', '"model_provide\\U00000072"')
  .replace('"model_providers"', '"model_provider\\U00000073"')
  .replace('"requires_openai_auth"', '"requires_openai_\\U00000061uth"');
assert.equal(installRouterConfig(unicodeEscapedKeys, baseUrl).originalProviderId, "custom");
assert.equal(removeRouterConfig(installRouterConfig(unicodeEscapedKeys, baseUrl).contents), unicodeEscapedKeys);

assert.throws(
  () => installRouterConfig(original.replace("\n\n[model_providers.custom]", '\nprofiles.company."model_provide\\U00000072" = "company"\n\n[model_providers.custom]'), baseUrl),
  /global DeepSeek routing cannot preserve/,
);
assert.throws(
  () => installRouterConfig(original.replace("\n\n[model_providers.custom]", '\n"model_provider\\U00000073" . "deepseek-subagent-router" . name = "collision"\n\n[model_providers.custom]'), baseUrl),
  /unmanaged deepseek-subagent-router/,
);

const literalQuotedValues = quotedTopLevel
  .replace('"model_provider" = "custom"', '"model_provider" = \'custom\'')
  .replace('"wire_api" = "responses"', '"wire_api" = \'responses\'');
assert.equal(installRouterConfig(literalQuotedValues, baseUrl).originalProviderId, "custom");

assert.throws(
  () => installRouterConfig(original.replace('[model_providers.custom]', '[[model_providers.custom]]'), baseUrl),
  /unsupported array table/,
);

assert.throws(
  () => installRouterConfig(`${original}\n[profiles.company]\nmodel = """\n[not_a_table]\n"""\nmodel_provider = "company"\n`, baseUrl),
  /multiline TOML string/,
);

const quotedChatGptOverride = quotedTopLevel.replace(
  '\n\n["model_providers"."custom"]',
  '\n"chatgpt_base_url" = "https://quoted-gateway.example.test/codex"\n\n["model_providers"."custom"]',
);
assert.equal(installRouterConfig(quotedChatGptOverride, baseUrl).parentBaseUrl, "https://quoted-gateway.example.test/codex/");

assert.throws(
  () => installRouterConfig(original.replace("\n\n[model_providers.custom]", '\n"model_provider" = "custom"\n\n[model_providers.custom]'), baseUrl),
  /multiple top-level model_provider assignments/,
);
assert.throws(
  () => installRouterConfig(`${original}\n# >>> DeepSeek Subagent provider routing >>>\n`, baseUrl),
  /markers are incomplete or duplicated/,
);
assert.throws(
  () => removeRouterConfig(`${installed.contents.replace("# <<< DeepSeek Subagent provider definition <<<\n", "")}`),
  /markers are incomplete or duplicated/,
);

const originallyMissing = installRouterConfig("", baseUrl, { originalConfigExisted: false });
assert.equal(removeRouterConfig(originallyMissing.contents), "");
assert(routerConfigActive(originallyMissing.contents, baseUrl));
assert.equal(removeRouterConfig(installRouterConfig(originallyMissing.contents, `${baseUrl}/updated`).contents), "");
assert.equal(routerConfigActive(`${originallyMissing.contents}\n# model_provider = "deepseek-subagent-router"\n`, baseUrl), true);

for (const noProviderConfig of [
  'model = "gpt-parent"',
  'model = "gpt-parent"\n',
  '# trailing comment',
  '# trailing comment\n',
  '\n',
]) {
  const noProviderInstalled = installRouterConfig(noProviderConfig, baseUrl);
  assert.equal(removeRouterConfig(noProviderInstalled.contents), noProviderConfig);
  assert(routerConfigActive(noProviderInstalled.contents, baseUrl));
}

for (const originalWithoutFinalNewline of [
  'model = "gpt-parent"',
  '[projects]\ntrusted = true',
  'model_provider = "openai"',
]) {
  const withUserSuffix = `${installRouterConfig(originalWithoutFinalNewline, baseUrl).contents}user_change_after_install = true\n`;
  assert.equal(removeRouterConfig(withUserSuffix), `${originalWithoutFinalNewline}\nuser_change_after_install = true\n`);
}

for (const mutate of [
  (value) => value.replace("# inserted_top_separator = true", "# inserted_top_separator = false"),
  (value) => value.replace("# inserted_separator = false", "# inserted_separator = true"),
  (value) => value.replace(/^# original_model_provider_b64 = .*$/m, `# original_model_provider_b64 = ${Buffer.from('model_provider = "other"').toString("base64")}`),
]) {
  assert.throws(() => removeRouterConfig(mutate(installRouterConfig('model = "gpt-parent"', baseUrl).contents)), /integrity check/);
}

const legacyWithSeparatorMetadata = installed.contents.replace(/^# routing_integrity_sha256 = .*\n/m, "");
assert.equal(routerConfigActive(legacyWithSeparatorMetadata, baseUrl), false);
assert.equal(removeRouterConfig(legacyWithSeparatorMetadata), original);
assert(routerConfigActive(installRouterConfig(legacyWithSeparatorMetadata, baseUrl).contents, baseUrl));

const legacyWithoutSeparatorMetadata = legacyWithSeparatorMetadata.replace(/^# inserted_top_separator = false\n/m, "");
assert.equal(routerConfigActive(legacyWithoutSeparatorMetadata, baseUrl), false);
assert.equal(removeRouterConfig(legacyWithoutSeparatorMetadata), original);
assert(routerConfigActive(installRouterConfig(legacyWithoutSeparatorMetadata, baseUrl).contents, baseUrl));

process.stdout.write("Runtime config tests passed\n");
