// Resolve openclaw/plugin-sdk/* to local stubs so index.mjs can be tested without a host.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("openclaw/plugin-sdk/"))
    return { url: new URL("./sdk-stub.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
