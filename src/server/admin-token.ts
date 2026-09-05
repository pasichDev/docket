import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dataPath } from "../data-dir.js";

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

/** Created on first use by `docket serve`; read by the CLI. 32 bytes, hex. */
export async function getAdminToken(): Promise<string> {
  if (cached) return cached;
  try {
    const existing = (await readFile(TOKEN_PATH, "utf8")).trim();
    if (existing.length >= 32) {
      cached = existing;
      return cached;
    }
  } catch {
    // Not minted yet.
  }
  cached = randomBytes(32).toString("hex");
  await writeFile(TOKEN_PATH, cached, { mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600); // umask can widen the mode on creation; this cannot
  return cached;
}

/** For the CLI: absent means no server has ever run against this data directory. */
export async function readAdminToken(): Promise<string | null> {
  try {
    const existing = (await readFile(TOKEN_PATH, "utf8")).trim();
    return existing.length >= 32 ? existing : null;
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
