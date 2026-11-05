import test from "node:test";
import assert from "node:assert/strict";
import { createBudget, neuronsFor, msUntilUtcMidnight, utcDay, BudgetStoreError } from "../budget.mjs";
import { fakeStore } from "./fake-store.mjs";

const T = Date.parse("2026-11-05T23:59:00Z");

test("per-model prices follow the published Neuron rates", () => {
  assert.equal(neuronsFor("clef", 1e6), 21818);
  assert.equal(neuronsFor("clef-flash", 1e6), 3455);
  assert.throws(() => neuronsFor("other", 1), RangeError);
});

test("UTC day boundaries", () => {
  assert.equal(utcDay(T), "2026-11-05");
  assert.equal(msUntilUtcMidnight(T), 60_000);
});

test("reserve refuses past the cap and reports time to UTC midnight", async () => {
  const b = createBudget({ store: fakeStore(), cap: 100, now: () => T });
  const a = await b.reserve(60);
  assert.equal(a.ok, true);
  const denied = await b.reserve(50);
  assert.deepEqual(denied, { ok: false, retryAfterMs: 60_000 });
  assert.equal((await b.reserve(40)).ok, true);
  assert.equal(await b.usedToday(), 100);
});

test("settle replaces the estimate with actual usage; release returns it", async () => {
  const b = createBudget({ store: fakeStore(), cap: 100, now: () => T });
  const r1 = await b.reserve(80);
  await b.settle(r1.ticket, 5);
  assert.equal(await b.usedToday(), 5);
  const r2 = await b.reserve(90);
  await b.release(r2.ticket);
  assert.equal(await b.usedToday(), 5);
});

test("a new UTC day starts from zero and late settlement hits the original day", async () => {
  let now = T;
  const store = fakeStore();
  const b = createBudget({ store, cap: 100, now: () => now });
  const r = await b.reserve(100);
  now = T + 120_000;
  assert.equal((await b.reserve(100)).ok, true);
  await b.release(r.ticket);
  assert.equal(store.rows.get("day:2026-11-05").value.used, 0);
  assert.equal(store.rows.get("day:2026-11-06").value.used, 100);
});

test("retries optimistic conflicts, then fails closed", async () => {
  const ok = createBudget({ store: fakeStore({ conflicts: 3 }), cap: 10, now: () => T });
  assert.equal((await ok.reserve(1)).ok, true);
  const stuck = createBudget({ store: fakeStore({ conflicts: 100 }), cap: 10, now: () => T });
  await assert.rejects(stuck.reserve(1), BudgetStoreError);
});

test("concurrent reservations never overshoot the cap", async () => {
  const b = createBudget({ store: fakeStore(), cap: 10, now: () => T });
  const results = await Promise.all(Array.from({ length: 6 }, () => b.reserve(3)));
  assert.equal(results.filter(r => r.ok).length, 3);
  assert.ok(await b.usedToday() <= 10);
});

test("rejects missing store and invalid caps", () => {
  assert.throws(() => createBudget({ store: {}, cap: 1 }), BudgetStoreError);
  assert.throws(() => createBudget({ store: fakeStore(), cap: 0 }), RangeError);
});
