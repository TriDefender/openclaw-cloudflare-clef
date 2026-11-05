/**
 * Optional redaction of decision evidence before it leaves the host.
 *
 * Applied to every string in `state`, question `instructions`, `criteria`
 * values and choice labels. Question IDs and choice keys returned to OpenClaw
 * are not changed. Within one request the same value always maps to the same
 * placeholder ("[ip-1]", "[email-2]", "[redacted-1]"), so the model can still
 * tell two different hosts apart without seeing them.
 */

export class RedactConfigError extends Error {}

const MAX_PATTERNS = 32;
const MAX_PATTERN_LENGTH = 512;

// Bounded quantifiers keep matching linear on long runs without "@".
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
// A trailing sentence period is allowed; a fifth dotted number is not.
const IPV4 = /(?<!\d|\d\.)(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g;
// Longer strings cannot pass the 24,000-byte admission guard in protocol.mjs,
// so they are left as-is (the request is rejected) instead of being scanned.
const MAX_SCAN_LENGTH = 32768;
const KEYS = new Set(["privateIps", "emails", "patterns"]);
// Unique local (fc00::/7), link-local (fe80::/10) and loopback (::1).
const IPV6_PRIVATE = /(?<![0-9A-Fa-f:])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f])(?::[0-9a-f]{0,4}){1,7}(?![0-9A-Fa-f:])|(?<![0-9A-Fa-f:])::1(?![0-9A-Fa-f:])/gi;

/** RFC 1918, loopback, link-local and CGNAT (RFC 6598) ranges. */
export function isPrivateIpv4(s) {
  const o = s.split(".").map(Number);
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n > 255)) return false;
  const [a, b] = o;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function compilePattern(p) {
  const source = typeof p === "string" ? p : p?.pattern;
  const flags = typeof p === "string" ? "" : (p?.flags ?? "");
  if (typeof source !== "string" || !source || source.length > MAX_PATTERN_LENGTH)
    throw new RedactConfigError("redact.patterns entries must be 1-" + MAX_PATTERN_LENGTH + " characters");
  if (typeof flags !== "string" || !/^[imsu]*$/.test(flags))
    throw new RedactConfigError("redact.patterns flags may only contain i, m, s, u");
  let re;
  try { re = new RegExp(source, flags.replace(/(.)(?=.*\1)/g, "") + "g"); }
  catch { throw new RedactConfigError("Invalid redact pattern"); }
  re.lastIndex = 0;
  if (new RegExp(re.source, re.flags.replace("g", "")).test(""))
    throw new RedactConfigError("redact.patterns entries must not match the empty string");
  return re;
}

/**
 * Validate config once at registration. Returns null when redaction is off,
 * otherwise a factory that creates a fresh per-request redactor.
 * Throws RedactConfigError on invalid config so the plugin can fail closed.
 */
export function compileRedaction(cfg) {
  if (cfg === undefined || cfg === null) return null;
  if (typeof cfg !== "object" || Array.isArray(cfg)) throw new RedactConfigError("redact must be an object");
  for (const k of Object.keys(cfg)) if (!KEYS.has(k)) throw new RedactConfigError("Unknown redact option: " + k);
  for (const k of ["privateIps", "emails"])
    if (cfg[k] !== undefined && typeof cfg[k] !== "boolean") throw new RedactConfigError("redact." + k + " must be a boolean");
  const patterns = cfg.patterns ?? [];
  if (!Array.isArray(patterns) || patterns.length > MAX_PATTERNS)
    throw new RedactConfigError("redact.patterns must be an array of at most " + MAX_PATTERNS);
  const custom = patterns.map(compilePattern);
  const emails = cfg.emails === true, privateIps = cfg.privateIps === true;
  if (!emails && !privateIps && !custom.length) return null;

  return function createRedactor() {
    const seen = new Map(), counters = { ip: 0, email: 0, redacted: 0 };
    const token = (kind, value) => {
      const k = kind + "\0" + value;
      if (!seen.has(k)) seen.set(k, "[" + kind + "-" + (++counters[kind]) + "]");
      return seen.get(k);
    };
    return function redact(s) {
      if (typeof s !== "string" || !s || s.length > MAX_SCAN_LENGTH) return s;
      let out = s;
      // Custom patterns first, so they cannot rewrite built-in placeholders.
      for (const re of custom) out = out.replace(re, m => token("redacted", m));
      if (emails) out = out.replace(EMAIL, m => token("email", m.toLowerCase()));
      if (privateIps) {
        out = out.replace(IPV4, m => isPrivateIpv4(m) ? token("ip", m) : m);
        out = out.replace(IPV6_PRIVATE, m => token("ip", m.toLowerCase()));
      }
      return out;
    };
  };
}
