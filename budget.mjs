/**
 * Optional daily Neuron budget for CLEF calls.
 *
 * Cloudflare bills Workers AI in Neurons, resets the free allocation at 00:00
 * UTC, and on Workers Paid charges for usage above it. This guard keeps a
 * per-UTC-day counter in the host's SQLite plugin state and refuses requests
 * that would cross `dailyNeuronCap`. It is a local, approximate guard: it only
 * sees calls made through this plugin, not other Workers AI usage on the same
 * account.
 *
 * Accounting: reserve a conservative estimate before sending (one token per
 * UTF-8 byte of the request body, same assumption as the admission guard in
 * protocol.mjs), then settle to the actual `usage.input_tokens` when CLEF
 * reports it. A reservation is released when the request was never sent or
 * Cloudflare rejected it; it is kept when the outcome is unknown.
 */

/** Published Workers AI prices (Neurons per million input tokens, 2026-10-20). */
export const NEURONS_PER_M_INPUT = Object.freeze({ "clef": 21818, "clef-flash": 3455 });

export class BudgetStoreError extends Error {}

export const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

export function msUntilUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime();
}

export function neuronsFor(model, inputTokens) {
  const rate = NEURONS_PER_M_INPUT[model];
  if (rate === undefined) throw new RangeError("Unknown CLEF model");
  return inputTokens * rate / 1e6;
}

const MAX_ATTEMPTS = 8;
const TTL_MS = 3 * 24 * 3600 * 1000;

/**
 * @param {object} o
 * @param {{observe:Function, compareAndApply:Function}} o.store keyed store V2
 * @param {number} o.cap Neurons per UTC day
 * @param {() => number} [o.now]
 */
export function createBudget({ store, cap, now = Date.now }) {
  if (!store || typeof store.observe !== "function" || typeof store.compareAndApply !== "function")
    throw new BudgetStoreError("Keyed store with observe/compareAndApply is required");
  if (!Number.isFinite(cap) || cap <= 0) throw new RangeError("dailyNeuronCap must be positive");

  // Atomic read-modify-write; `fn(used)` returns the new value or null to abort.
  async function mutate(day, fn) {
    const key = "day:" + day;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const obs = await store.observe(key);
      const used = typeof obs.value?.used === "number" && obs.value.used >= 0 ? obs.value.used : 0;
      const next = fn(used);
      if (next === null) return { applied: false, used };
      const res = await store.compareAndApply(key, obs.comparison,
        { operation: "update", action: "set", value: { used: Math.max(0, next) }, ttlMs: TTL_MS });
      if (res.status !== "conflict") return { applied: true, used: next };
    }
    throw new BudgetStoreError("Budget store kept conflicting");
  }

  return {
    cap,
    /** @returns {Promise<{ok:true,ticket:object}|{ok:false,retryAfterMs:number}>} */
    async reserve(neurons) {
      const t = now(), day = utcDay(t);
      const r = await mutate(day, used => used + neurons > cap ? null : used + neurons);
      if (!r.applied) return { ok: false, retryAfterMs: msUntilUtcMidnight(t) };
      return { ok: true, ticket: { day, reserved: neurons } };
    },
    /** Replace the reservation with the actual cost reported by CLEF. */
    async settle(ticket, actual) {
      await mutate(ticket.day, used => used - ticket.reserved + actual);
    },
    /** Return a reservation that was never charged. */
    async release(ticket) {
      await mutate(ticket.day, used => used - ticket.reserved);
    },
    async usedToday() {
      const obs = await store.observe("day:" + utcDay(now()));
      return typeof obs.value?.used === "number" ? obs.value.used : 0;
    }
  };
}
