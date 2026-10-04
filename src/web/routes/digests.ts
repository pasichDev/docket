import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../http.js";
import { attentionCount, deleteDigest, digestShortId, DigestValidationError, getDigest, itemCount, listDigests, type Digest } from "../../digests.js";
import { log } from "../../log.js";
import { json } from "../http.js";

/**
 * The dashboard's read side of digests, plus delete. There is deliberately no POST: a digest
 * is written by an agent through digest_publish, after it has actually read the sources.
 */

function withShortId(d: Digest) {
  return { ...d, shortId: digestShortId(d.uuid) };
}

/**
 * What the timeline needs, and nothing else. The list is polled every 15 seconds; sending
 * every digest in full there would ship megabytes to draw a column of titles. A digest is
 * immutable, so the client fetches each one in full once and keeps it.
 */
function summaryOf(d: Digest) {
  return {
    uuid: d.uuid,
    shortId: digestShortId(d.uuid),
    title: d.title,
    createdAt: d.createdAt,
    agent: d.agent,
    deviceName: d.deviceName,
    itemCount: itemCount(d),
    attentionCount: attentionCount(d),
  };
}

export async function handleDigestRoutes(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiContext): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/digests") {
    const requested = Number(url.searchParams.get("limit") ?? 30);
    const limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 200) : 30;
    const { digests, total } = await listDigests(limit);
    json(res, 200, { digests: digests.map(summaryOf), total });
    return true;
  }

  const one = url.pathname.match(/^\/api\/digests\/([^/]+)$/);
  if (!one) return false;
  let id: string;
  try {
    id = decodeURIComponent(one[1]);
  } catch {
    json(res, 400, { error: "malformed digest id" });
    return true;
  }
  try {
    if (req.method === "GET") {
      const digest = await getDigest(id);
      if (!digest) json(res, 404, { error: "no such digest" });
      else json(res, 200, { digest: withShortId(digest) });
      return true;
    }
    if (req.method === "DELETE") {
      const removed = await deleteDigest(id, ctx.deviceId);
      if (!removed) {
        json(res, 404, { error: "no such digest" });
        return true;
      }
      log(`deleted digest ${digestShortId(removed.uuid)} "${removed.title}" from the web UI`);
      ctx.broadcastUpdate();
      json(res, 200, { ok: true });
      return true;
    }
  } catch (err) {
    // An ambiguous short id: the request was fine, the id just names two digests.
    if (err instanceof DigestValidationError) {
      json(res, 409, { error: err.message });
      return true;
    }
    throw err;
  }
  return false;
}
