# Cloudflare CLEF decisions for OpenClaw

[简体中文](README.zh-CN.md)

An OpenClaw **decision-provider** plugin that runs typed decision evaluations on
Cloudflare Workers AI **CLEF** and **CLEF Flash**. It does not replace your chat
model; it answers OpenClaw's boolean / choice / score rubrics with calibrated
probabilities, usually in a few hundred milliseconds.

Models: `cloudflare-clef/clef-flash` (recommended default) and `cloudflare-clef/clef`.

## Install

```bash
openclaw plugins install clawhub:openclaw-cloudflare-clef
```

From source: put the plugin directory anywhere and add
`"load": {"paths": ["<plugin dir>"]}` to the `plugins` config below
(not needed when installed with `plugins install`).

## Cloudflare setup

1. **Account ID**: Cloudflare dashboard → Workers & Pages overview, right-hand
   side (32 hex characters).
2. **API token**: avatar → My Profile → API Tokens → Create Token, permission
   **Workers AI → Run**, scoped to your account.
3. **Store the token** (the plugin only accepts a SecretRef: no environment
   variables, no plaintext fallback; the value goes through stdin so it stays out
   of shell history):

```bash
openclaw secrets store set CLOUDFLARE_API_TOKEN --kind secret \
  --allow-host api.cloudflare.com --value-file -
```

## Configuration

Merge into your existing config:

```json
{
  "plugins": {
    "allow": ["cloudflare-clef"],
    "entries": {
      "cloudflare-clef": {
        "enabled": true,
        "config": {
          "accountId": "<Cloudflare Account ID>",
          "apiToken": {"source": "store", "provider": "default", "id": "CLOUDFLARE_API_TOKEN"},
          "dailyNeuronCap": 8000,
          "redact": {"privateIps": true, "emails": true}
        }
      }
    }
  },
  "agents": {"defaults": {"decisionModel": "cloudflare-clef/clef-flash"}}
}
```

Leave `decisionModel` unset until credentials are in place.

| Option | Description |
|---|---|
| `accountId` | Cloudflare account ID (required). |
| `apiToken` | SecretRef to a Workers AI token (required). |
| `model` | Optional toggle `clef` or `clef-flash`. Overrides the model chosen in `decisionModel` for every evaluation. |
| `dailyNeuronCap` | Optional local cap on Neurons spent per UTC day. See [Cost control](#cost-control). |
| `redact` | Optional redaction of evidence before it leaves the host. See [Redaction](#redaction). |

**Activation**: restart the Gateway after configuring so the plugin registers
with ready credentials. If the plugin registered before the secret was stored,
the capability owner stays degraded and neither `secrets reload` nor
`plugins reload` clears it; only a Gateway restart does.

## Switching models

```bash
openclaw config set plugins.entries.cloudflare-clef.config.model clef        # stronger
openclaw config set plugins.entries.cloudflare-clef.config.model clef-flash  # faster, ~6x cheaper
openclaw config unset plugins.entries.cloudflare-clef.config.model           # follow decisionModel
```

Apply with `openclaw plugins reload cloudflare-clef`. The `model` field of each
result always reports the model that actually answered (checked against the API echo).

## Cost control

- Workers Free: 10,000 Neurons per UTC day, hard-limited by Cloudflare.
- Workers Paid: the same free allocation, then **usage above it is billed**.
  The free allocation is shared with all other Workers AI usage on the account.
- Prices (2026-10-20), input tokens only: CLEF Flash 3,455 Neurons / M tokens;
  CLEF 21,818 Neurons / M tokens.

Set `dailyNeuronCap` to stop this plugin before it spends more than you want:

- Before each request the plugin reserves a conservative estimate (one token per
  UTF-8 byte of the request, at the selected model's rate). After a successful
  call the reservation is replaced with the cost of the reported
  `usage.input_tokens`.
- If a request would cross the cap, the plugin returns
  `unavailable / rate-limited` without any network call, and OpenClaw keeps its
  normal fallback behaviour until 00:00 UTC.
- Rejected requests (HTTP 4xx/5xx) and requests that were never sent release
  their reservation; a lost connection keeps it, because the call may have been billed.
- The counter lives in OpenClaw's SQLite plugin state, survives restarts and is
  shared by concurrent evaluations. It only counts calls made by this plugin,
  so leave headroom if the same account runs other Workers AI models.
- If the host cannot provide plugin state, or the cap is invalid, the provider
  reports not ready and refuses every evaluation (fails closed).

## Redaction

Decision evidence often contains internal hostnames, IP addresses or e-mail
addresses. `redact` replaces them before the request is built:

```json
"redact": {
  "privateIps": true,
  "emails": true,
  "patterns": ["acme-internal-[a-z0-9-]+", {"pattern": "project falcon", "flags": "i"}]
}
```

- `privateIps`: RFC 1918, loopback, link-local and CGNAT IPv4; unique-local,
  link-local and loopback IPv6. Public addresses are kept.
- `emails`: e-mail addresses.
- `patterns`: up to 32 JavaScript regular expressions (string, or
  `{pattern, flags}` with flags from `imsu`). Patterns that match the empty
  string or fail to compile make the provider refuse evaluations.

Matches become placeholders such as `[ip-1]`, `[email-1]`, `[redacted-1]`.
Within one request the same value always gets the same placeholder, so the
model can still tell two hosts apart. Redaction covers `state`, question
`instructions`, criteria text and choice labels. Question IDs and choice keys
returned to OpenClaw are unchanged. Embedded images are not inspected.

Redaction is pattern-based and best effort. Do not rely on it to make secrets
safe to send; keep credentials out of decision evidence entirely.

## Behaviour and limits

- boolean → CLEF `noul` → `probabilityTrue`; choice keeps the full probability
  distribution; score turns CLEF's indexed object into an array.
- Question and choice IDs are remapped on the wire, so OpenClaw IDs with
  non-ASCII characters or slashes work; results come back under the original IDs.
- Uses the host's SSRF-guarded fetch, the cancellation signal, the remaining
  deadline and a final synchronous `isAdmissible` check before sending.
- No retries, no background polling, no automatic fallback to paid models.
  HTTP 429 returns `unavailable / rate-limited`.
- Images: data URLs (PNG/JPEG/WebP) or `{content_type, base64}` objects embedded
  in state, instructions or criteria are moved into CLEF's `images` array and
  replaced with `[image #N]` placeholders.
- Conservative input budget: request UTF-8 bytes + 1,024 + 128 per alternative
  must not exceed 24,000. This is an approximation, not the vendor tokenizer.
- OpenClaw's built-in automatic tool prefilter has a 500 ms budget; a remote call
  may time out there and fall back as usual. Other agent harnesses do not run the
  prefilter; whether they expose `decision_evaluate` depends on the harness.

## Testing

```bash
npm test
```

Unit tests cover protocol translation, budget accounting and redaction, plus
provider tests against stubbed host SDK modules. They do not prove that your
credentials work. End to end: after configuring and restarting the Gateway, call
the `decision_evaluate` tool once. `status: "ok"` with `answers` means it works;
`unavailable / credentials-unavailable` usually means the plugin registered
before the secret existed (see Activation).

## References

- https://developers.cloudflare.com/workers-ai/models/clef-flash/
- https://developers.cloudflare.com/workers-ai/models/clef/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- OpenClaw docs: `docs/concepts/decision-models.md`, `docs/plugins/sdk-overview/capabilities.md`
