import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dataPath } from "../data-dir.js";
import { atomicCreateOrRead } from "../fs-atomic.js";

/**
 * The credential that actually authorises `docket devices …`.
 *
 * The admin routes used to be gated on the request's source address being loopback, with
 * the reasoning that "the operator running these on the server machine itself IS the trust
 * boundary". That reasoning is sound right up until something else on the machine forwards
 * requests to it — and the documented way to put HTTPS in front of `docket serve` is
 * exactly that:
 *
 *     todo.example.com { reverse_proxy 127.0.0.1:8788 }
 *
 * Every request arriving through that proxy has a loopback source address. Anyone on the
 * internet could therefore mint a pairing code, approve their own request, and end up with
 * a fully authorised device against the authoritative store. The check was not wrong about
 * loopback; it was wrong to treat a network property as an identity.
 *
 * So: a secret in a 0600 file next to the store, which the CLI reads because it runs as the
 * same user on the same machine, and which a proxied request cannot obtain by being
 * forwarded. The loopback check stays as well — defence in depth, not the boundary.
 */
const TOKEN_PATH = await dataPath("admin-token");

let cached: string | null = null;

/**
 * 32 bytes, hex — so exactly 64 characters, which is also what makes a truncated file
 * detectable. A partially written token is not a weaker token, it is a DIFFERENT token: the
 * server would authorise against the 64 characters it holds in memory while the CLI reads
 * the 30 that reached the disk, and every admin call would fail with a signature mismatch
 * nobody could explain from the outside.
 */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const parseToken = (contents: Buffer | string): string | null => {
  const text = (typeof contents === "string" ? contents : contents.toString("utf8")).trim();
  return TOKEN_PATTERN.test(text) ? text : null;
};

/**
 * Created on first use by `docket serve`; read by the CLI.
 *
 * Read-then-write was a genuine race, not a theoretical one: `docket serve` and a `docket
 * devices` invocation racing on a fresh data directory both read nothing, both mint 32
 * random bytes, and both write — after which the server is authorising against a token that
 * is no longer in the file. Exclusive create settles the winner atomically and hands every
 * loser the value that actually landed.
 */
export async function getAdminToken(): Promise<string> {
  if (cached) return cached;
  const settled = await atomicCreateOrRead(
    TOKEN_PATH,
    () => Buffer.from(randomBytes(32).toString("hex"), "utf8"),
    (contents) => parseToken(contents) !== null,
  );
  cached = parseToken(settled)!;
  return cached;
}

/** For the CLI: absent means no server has ever run against this data directory. */
export async function readAdminToken(): Promise<string | null> {
  try {
    return parseToken(await readFile(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

export const ADMIN_TOKEN_PATH = TOKEN_PATH;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Both conditions, and the token is the one that matters. `X-Forwarded-For` is deliberately
 * not consulted: it is set by whatever spoke to the proxy, so trusting it would hand the
 * decision straight back to the caller.
 */
export function isAuthorizedAdminRequest(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!presented) return false;
  return safeEqual(presented, token);
}
