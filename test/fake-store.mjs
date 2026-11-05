/** In-memory stand-in for api.runtime.state.openKeyedStoreV2 (observe/compareAndApply). */
export function fakeStore({ conflicts = 0 } = {}) {
  const rows = new Map();
  let version = 0, pendingConflicts = conflicts;
  return {
    rows,
    async observe(key) {
      const row = rows.get(key);
      return { value: row?.value, comparison: key + "@" + (row?.v ?? "none") };
    },
    async compareAndApply(key, comparison, intent) {
      const row = rows.get(key);
      const current = key + "@" + (row?.v ?? "none");
      if (pendingConflicts > 0 || comparison !== current) {
        if (pendingConflicts > 0) pendingConflicts--;
        return { status: "conflict", current: { value: row?.value, comparison: current } };
      }
      if (intent.action === "set") rows.set(key, { value: structuredClone(intent.value), v: ++version });
      return { status: "applied" };
    }
  };
}
