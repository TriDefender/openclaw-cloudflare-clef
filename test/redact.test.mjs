import test from "node:test";
import assert from "node:assert/strict";
import { compileRedaction, isPrivateIpv4, RedactConfigError } from "../redact.mjs";
import { encodeBatch } from "../protocol.mjs";

test("off unless something is enabled", () => {
  assert.equal(compileRedaction(undefined), null);
  assert.equal(compileRedaction({}), null);
  assert.equal(compileRedaction({ emails: false, patterns: [] }), null);
});

test("private IPv4 ranges", () => {
  for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.50", "127.0.0.1", "169.254.1.1", "100.64.0.1"])
    assert.equal(isPrivateIpv4(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "192.169.0.1", "100.128.0.1", "999.1.1.1"])
    assert.equal(isPrivateIpv4(ip), false, ip);
});

test("stable per-request placeholders; public IPs and versions untouched", () => {
  const r = compileRedaction({ privateIps: true, emails: true })();
  assert.equal(r("db 192.168.0.50 down, ping 192.168.0.50 from 10.0.0.2; dns 1.1.1.1"),
    "db [ip-1] down, ping [ip-1] from [ip-2]; dns 1.1.1.1");
  assert.equal(r("mail Ops@Example.com and ops@example.com"), "mail [email-1] and [email-1]");
  assert.equal(r("version 1.2.3.4.5 and fd12:3456:789a::1 and ::1"), "version 1.2.3.4.5 and [ip-3] and [ip-4]");
  // a new request starts numbering again
  assert.equal(compileRedaction({ privateIps: true })()("10.0.0.2"), "[ip-1]");
});

test("custom patterns with flags", () => {
  const r = compileRedaction({ patterns: ["acme-\\d+", { pattern: "secret project", flags: "i" }] })();
  assert.equal(r("ticket ACME-1 acme-42 about Secret Project"), "ticket ACME-1 [redacted-1] about [redacted-2]");
});

test("invalid config throws so the plugin can fail closed", () => {
  for (const bad of [[], "x", { patterns: ["("] }, { patterns: [""] }, { patterns: ["a*"] },
    { patterns: [{ pattern: "a", flags: "g" }] }, { patterns: Array(33).fill("a") }])
    assert.throws(() => compileRedaction(bad), RedactConfigError, JSON.stringify(bad));
});

test("encodeBatch redacts evidence and labels but keeps IDs, types and images", () => {
  const img = "data:image/png;base64,iVBORw0KGgo=";
  const batch = {
    state: { log: "host 192.168.0.50 failed", pic: img },
    questions: {
      "route/10.0.0.1": { type: "choice", instructions: "Owner of 192.168.0.50?",
        criteria: { "dba 10.0.0.9": "db at 192.168.0.50", "net": "router 10.0.0.1" } },
      urgent: { type: "boolean", criteria: { true: "user a@b.io blocked", false: "no impact" } }
    }
  };
  const req = encodeBatch(batch, "clef", { redact: compileRedaction({ privateIps: true, emails: true })() });
  const body = req.body;
  assert.ok(!/192\.168|10\.0\.0|a@b\.io/.test(body), body);
  assert.equal(req.payload.state.log, "host [ip-1] failed");
  assert.equal(req.payload.state.pic, "[image #1]");
  assert.deepEqual(req.payload.images, [img]);
  assert.equal(req.payload.questions.q0.criteria.c0.label, "dba [ip-3]");
  assert.equal(req.payload.questions.q1.type, "noul");
  assert.equal(req.mapping[0].id, "route/10.0.0.1");
  assert.deepEqual(req.mapping[0].keys, ["dba 10.0.0.9", "net"]);
});

test("review fixes: trailing period, state keys, strict config, pattern order", () => {
  const r = compileRedaction({ privateIps: true, emails: true })();
  assert.equal(r("from 192.168.1.5."), "from [ip-1].");
  assert.equal(r("ip.10.0.0.1, then"), "ip.[ip-2], then");
  assert.equal(r("v1.10.0.0.1.2"), "v1.10.0.0.1.2");
  for (const bad of [{ emails: "true" }, { privateIP: true }])
    assert.throws(() => compileRedaction(bad), RedactConfigError);
  const c = compileRedaction({ privateIps: true, patterns: ["\\d+"] })();
  assert.equal(c("box 7"), "box [redacted-1]");
  const req = encodeBatch({ state: { "10.0.0.5": "down", "bob@x.com": "locked" },
    questions: { u: { type: "boolean", criteria: { true: "a", false: "b" } } } }, "clef",
    { redact: compileRedaction({ privateIps: true, emails: true })() });
  assert.deepEqual(Object.keys(req.payload.state), ["[ip-1]", "[email-1]"]);
  assert.deepEqual(Object.keys(req.payload.questions.q0.criteria), ["true", "false"]);
});

test("review fix: e-mail scan stays linear on long input", () => {
  const r = compileRedaction({ emails: true })();
  const t = performance.now();
  r("a".repeat(30000)); r("a.".repeat(15000));
  assert.ok(performance.now() - t < 500, "too slow");
  // longer than the admission guard: left alone, the request is rejected anyway
  assert.throws(() => encodeBatch({ state: "x@y.io ".repeat(6000), questions: { u: { type: "boolean" } } }, "clef",
    { redact: r }), /context budget/);
});
