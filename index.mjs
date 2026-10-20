
import { getPreparedPluginSecretInput, assertPluginCapabilitySecretAvailable } from "openclaw/plugin-sdk/secret-input-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import { encodeBatch, decodeResponse, UnsupportedInput, InvalidResponse } from "./protocol.mjs";

const ID = "cloudflare-clef";
export default {
  id: ID,
  name: "Cloudflare CLEF decisions",
  register(api) {
    const cfg = api.pluginConfig ?? {};
    const accountId = typeof cfg.accountId === "string" ? cfg.accountId : "";
    // Model toggle: when config.model is a supported id, it overrides the
    // model selected by the consumer's decisionModel for every evaluation.
    const modelOverride = cfg.model === "clef" || cfg.model === "clef-flash" ? cfg.model : "";
    const unavailable = (reason,extra={}) => ({status:"unavailable",reason,...extra});
    api.registerDecisionProvider({
      id:ID,
      contractVersion:1,
      isReady() {
        const diag = { at:new Date().toISOString(), acctOk:/^[a-fA-F0-9]{32}$/.test(accountId) };
        try {
          const p = getPreparedPluginSecretInput(ID,"apiToken");
          diag.prepared = { hasValue: typeof p.value === "string" && p.value.trim().length > 0, revision: p.revision };
        } catch (e) { diag.preparedErr = (e && e.message) || String(e); }
        try {
          assertPluginCapabilitySecretAvailable("plugins.entries.cloudflare-clef.config.apiToken");
          diag.ownerAvailable = true;
        } catch (e) { diag.ownerAvailable = false; diag.ownerErr = (e && e.message) || String(e); }
        const ready = diag.acctOk && diag.prepared?.hasValue === true && diag.ownerAvailable === true;
        if (!ready) { try { console.log("[clef-diag]", JSON.stringify(diag)); } catch {} }
        return diag.acctOk && diag.prepared?.hasValue === true;
      },
      async evaluate(batch,context) {
        context.signal.throwIfAborted();
        if (!/^[a-fA-F0-9]{32}$/.test(accountId)) return unavailable("credentials-unavailable");
        const model = modelOverride || context.model;
        let request;
        try { request = encodeBatch(batch,model); }
        catch (e) { if (e instanceof UnsupportedInput) return unavailable("unsupported-input"); throw e; }
        let response, release, authorityError;
        try {
          // Read a fresh prepared credential per invocation, never ambient env or cached config.
          const token = getPreparedPluginSecretInput(ID,"apiToken").value;
          if (!token) return unavailable("credentials-unavailable");
          const remaining = Math.floor(context.deadlineMonotonicMs - performance.now());
          if (remaining <= 0) { context.signal.throwIfAborted(); throw new Error("Decision deadline"); }
          const fetched = await fetchWithSsrFGuard({
            url:"https://api.cloudflare.com/client/v4/accounts/" + accountId + "/ai/run/@cf/cloudflare/" + model,
            requireHttps:true,maxRedirects:0,capture:false,
            timeoutMs:remaining,signal:context.signal,
            beforeRequest() {
              context.signal.throwIfAborted();
              try {
                if (context.isAdmissible && !context.isAdmissible())
                  throw new Error("Decision consumer authority closed");
              } catch (e) { authorityError = e; throw e; }
            },
            init:{method:"POST",headers:{"Authorization":"Bearer " + token,"Content-Type":"application/json"},body:request.body}
          });
          response = fetched.response; release = fetched.release;
          if (!response.ok) {
            await response.body?.cancel();
            if ([401,403].includes(response.status)) return unavailable("authentication");
            if (response.status === 429) {
              const h = response.headers.get("retry-after");
              const n = h !== null ? Number(h) : NaN;
              return unavailable("rate-limited",Number.isFinite(n)&&n>=0 ? {retryAfterMs:Math.min(n*1000,60000)} : {});
            }
            if ([400,413,422].includes(response.status)) return unavailable("unsupported-input");
            return unavailable("transport");
          }
          // Limit successful response bodies too; never log submitted evidence or raw error bodies.
          const text = await readResponseTextLimited(response,1024*1024);
          const raw = JSON.parse(text);
          return {status:"ok",result:decodeResponse(raw,request)};
        } catch (e) {
          if (authorityError) throw authorityError;
          context.signal.throwIfAborted();
          if (e instanceof InvalidResponse || e instanceof SyntaxError) return unavailable("invalid-response");
          return unavailable("transport");
        } finally {
          if (release) await release();
        }
      }
    });
  }
};
