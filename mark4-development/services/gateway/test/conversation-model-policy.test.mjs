import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationModelPolicy, directCredentialEnvNames } from "../../../scripts/conversation-model-policy.mjs";

test("requested Gemini aliases form a native credential pool before Big Pickle", () => {
  const env = { GEMINI_APY_KEY:"gem-a", GEMINI_API_KEY2:"gem-b" };
  const policy = buildConversationModelPolicy(env);
  assert.equal(env.GEMINI_API_KEY, "gem-a");
  assert.equal(env.GOOGLE_API_KEY, "gem-b");
  assert.equal(policy.primary.provider, "gemini");
  assert.equal(policy.directCredentialCount, 2);
  assert.deepEqual(policy.fallbacks.at(-1), policy.bigPickle);
});

test("Grok keys stay xAI routes and both precede NVIDIA and Big Pickle", () => {
  const env = { GROK_API_KEY:"grok-a", GROK_API_KEY2:"grok-b", NVIDIA_API_KEY:"nv-a" };
  const policy = buildConversationModelPolicy(env);
  assert.equal(env.XAI_API_KEY, "grok-a");
  assert.deepEqual(policy.directRoutes.map(item => item.id), ["grok-primary","grok-secondary","nvidia-primary"]);
  assert.equal(policy.directRoutes[1].keyEnv, "ULTRON_M4_GROK_SECONDARY_KEY");
  assert.deepEqual(policy.fallbacks.map(item => item.id), ["grok-secondary","nvidia-primary","big-pickle"]);
});

test("existing Groq env names remain a distinct compatibility provider", () => {
  const policy = buildConversationModelPolicy({ GROQ_API_KEY:"groq-a", GROQ_API_KEY2:"groq-b" });
  assert.equal(policy.primary.provider, "custom");
  assert.equal(policy.primary.keyEnv, "GROQ_API_KEY");
  assert.equal(policy.fallbacks[0].source, "Groq secondary compatibility route");
  assert.equal(policy.fallbacks.at(-1).id, "big-pickle");
});

test("Big Pickle becomes primary when no direct conversation credential exists", () => {
  const policy = buildConversationModelPolicy({});
  assert.equal(policy.primary.id, "big-pickle");
  assert.deepEqual(policy.fallbacks, []);
});

test("isolated-route masking covers every supported direct credential alias", () => {
  for (const key of ["GEMINI_APY_KEY","GEMINI_API_KEY2","GROK_API_KEY","GROK_API_KEY2","NVIDIA_API_KEY"]) {
    assert.ok(directCredentialEnvNames.includes(key), key);
  }
});
