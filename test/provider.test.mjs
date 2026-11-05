import test from "node:test";
import assert from "node:assert/strict";
import { sdk } from "./sdk-stub.mjs";
import { fakeStore } from "./fake-store.mjs";
const plugin = (await import("../index.mjs")).default;

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const batch = { state: "db 192.168.0.50 down", questions: { urgent: { type: "boolean", criteria: { true: "outage", false: "fine" } } } };

function setup(config, store = fakeStore()) {
  let provider;
  plugin.register({
    pluginConfig: { accountId: ACCOUNT, ...config },
    runtime: { state: { openKeyedStoreV2: () => store } },
    registerDecisionProvider(p) { provider = p; }
  });
  return { provider, store };
}
const ctx = (model = "clef") => ({ model, signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 5000, isAdmissible: () => true });
const ok = (inputTokens) => async () => new Response(JSON.stringify({ success: true, result: {
  model: "clef", answers: { q0: { type: "noul", noul: 0.9 } }, usage: { input_tokens: inputTokens, output_tokens: 0 } } }), { status: 200 });

test("redacts before sending and settles budget to actual usage", async () => {
  const { provider, store } = setup({ dailyNeuronCap: 100, redact: { privateIps: true } });
  sdk.calls.length = 0; sdk.fetchImpl = ok(1000);
  const out = await provider.evaluate(batch, ctx());
  assert.equal(out.status, "ok");
  assert.equal(sdk.calls[0].state, "db [ip-1] down");
  const [row] = store.rows.values();
  assert.ok(Math.abs(row.value.used - 21.818) < 1e-9);
});

test("refuses without network I/O once the cap is reached", async () => {
  const { provider } = setup({ dailyNeuronCap: 1 });
  sdk.calls.length = 0; sdk.fetchImpl = ok(1000);
  const out = await provider.evaluate(batch, ctx());
  assert.equal(out.status, "unavailable");
  assert.equal(out.reason, "rate-limited");
  assert.ok(out.retryAfterMs > 0);
  assert.equal(sdk.calls.length, 0);
});

test("Cloudflare rejections release the reservation", async () => {
  const { provider, store } = setup({ dailyNeuronCap: 100 });
  sdk.fetchImpl = async () => new Response("", { status: 429, headers: { "retry-after": "5" } });
  const out = await provider.evaluate(batch, ctx());
  assert.deepEqual(out, { status: "unavailable", reason: "rate-limited", retryAfterMs: 5000 });
  const [row] = store.rows.values();
  assert.equal(row.value.used, 0);
});

test("unknown outcome keeps the conservative reservation", async () => {
  const { provider, store } = setup({ dailyNeuronCap: 100 });
  sdk.fetchImpl = async () => { throw new Error("socket reset"); };
  const out = await provider.evaluate(batch, ctx());
  assert.equal(out.reason, "transport");
  const [row] = store.rows.values();
  assert.ok(row.value.used > 0);
});

test("invalid safeguard config fails closed", async () => {
  sdk.calls.length = 0;
  for (const cfg of [{ redact: { patterns: ["("] } }, { dailyNeuronCap: 10, noStore: true }]) {
    let provider;
    plugin.register({ pluginConfig: { accountId: ACCOUNT, ...cfg },
      runtime: cfg.noStore ? {} : { state: { openKeyedStoreV2: () => fakeStore() } },
      registerDecisionProvider(p) { provider = p; } });
    assert.equal(provider.isReady(), false);
    assert.equal((await provider.evaluate(batch, ctx())).reason, "unsupported-input");
  }
  assert.equal(sdk.calls.length, 0);
});

test("no safeguards configured keeps the original behaviour", async () => {
  let provider;
  plugin.register({ pluginConfig: { accountId: ACCOUNT }, registerDecisionProvider(p) { provider = p; } });
  sdk.calls.length = 0; sdk.fetchImpl = ok(10);
  assert.equal((await provider.evaluate(batch, ctx())).status, "ok");
  assert.equal(sdk.calls[0].state, "db 192.168.0.50 down");
});

test("budget is released even if the transport release() throws", async () => {
  const { provider, store } = setup({ dailyNeuronCap: 100 });
  const orig = sdk.fetchImpl;
  sdk.fetchImpl = async () => new Response("", { status: 503 });
  sdk.failRelease = true;
  await assert.rejects(provider.evaluate(batch, ctx()));
  sdk.failRelease = false; sdk.fetchImpl = orig;
  const [row] = store.rows.values();
  assert.equal(row.value.used, 0);
});
