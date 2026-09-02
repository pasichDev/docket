import assert from "node:assert/strict";
import { test } from "node:test";
import { hasSameOriginForMutation, hasTrustedHostHeader } from "./server.js";

function reqWithHost(host: string | undefined) {
  return { headers: { host } } as import("node:http").IncomingMessage;
}

function req(method: string, headers: Record<string, string | undefined>) {
  return { method, headers } as import("node:http").IncomingMessage;
}

test("hasTrustedHostHeader: allows localhost, IP literals (v4/v6), and .local mDNS names", () => {
  assert.equal(hasTrustedHostHeader(reqWithHost("localhost:8787")), true);
  assert.equal(hasTrustedHostHeader(reqWithHost("127.0.0.1:8787")), true);
  assert.equal(hasTrustedHostHeader(reqWithHost("192.168.1.42:8787")), true);
  assert.equal(hasTrustedHostHeader(reqWithHost("[::1]:8787")), true);
  assert.equal(hasTrustedHostHeader(reqWithHost("my-laptop.local:8787")), true);
});

test("hasTrustedHostHeader: rejects an attacker's own domain (DNS-rebinding guard)", () => {
  assert.equal(hasTrustedHostHeader(reqWithHost("evil.example.com:8787")), false);
  assert.equal(hasTrustedHostHeader(reqWithHost("rebind.attacker.net")), false);
});

test("hasTrustedHostHeader: a missing Host header is allowed (non-browser client, authenticated by the usual means)", () => {
  assert.equal(hasTrustedHostHeader(reqWithHost(undefined)), true);
});

test("hasTrustedHostHeader: a malformed Host header is rejected, not thrown", () => {
  assert.equal(hasTrustedHostHeader(reqWithHost("not a valid host!!")), false);
});

test("hasSameOriginForMutation: GET/HEAD are never checked, even with a mismatched Origin", () => {
  assert.equal(hasSameOriginForMutation(req("GET", { host: "192.168.1.5:8787", origin: "http://evil.example.com" })), true);
});

test("hasSameOriginForMutation: a mutating request with no Origin or Referer is allowed (peer-to-peer fetch, curl)", () => {
  assert.equal(hasSameOriginForMutation(req("POST", { host: "192.168.1.5:8787" })), true);
});

test("hasSameOriginForMutation: a mutating request whose Origin matches this server's own Host is allowed", () => {
  assert.equal(hasSameOriginForMutation(req("POST", { host: "192.168.1.5:8787", origin: "http://192.168.1.5:8787" })), true);
});

test("hasSameOriginForMutation: a mutating request from a different origin is rejected (CSRF)", () => {
  assert.equal(hasSameOriginForMutation(req("POST", { host: "192.168.1.5:8787", origin: "http://evil.example.com" })), false);
});

test("hasSameOriginForMutation: falls back to Referer when Origin is absent", () => {
  assert.equal(hasSameOriginForMutation(req("DELETE", { host: "192.168.1.5:8787", referer: "http://evil.example.com/page" })), false);
  assert.equal(hasSameOriginForMutation(req("DELETE", { host: "192.168.1.5:8787", referer: "http://192.168.1.5:8787/" })), true);
});
