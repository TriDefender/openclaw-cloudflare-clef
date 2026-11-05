export const sdk = globalThis.__clefSdk ??= {
  token: "test-token",
  fetchImpl: null,
  calls: []
};
export function getPreparedPluginSecretInput() { return { value: sdk.token, revision: 1 }; }
export function assertPluginCapabilitySecretAvailable() {}
export async function fetchWithSsrFGuard(opts) {
  opts.beforeRequest?.();
  sdk.calls.push(JSON.parse(opts.init.body));
  return { response: await sdk.fetchImpl(opts), release: async () => { if (sdk.failRelease) throw new Error("release failed"); } };
}
export async function readResponseTextLimited(response) { return response.text(); }
