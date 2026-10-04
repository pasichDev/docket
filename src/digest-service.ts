import {
  deleteDigest,
  DigestValidationError,
  getDigest,
  listDigests,
  listSeen,
  markSeen,
  publishDigest,
  type Digest,
  type DigestContext,
  type DigestSeen,
} from "./digests.js";
import { RemoteProtocolError, type RemoteTodoRepository } from "./remote/client.js";

/**
 * Digests behind one interface, so the MCP tools work the same in both deployment modes:
 * Local Mode keeps them in this machine's digests.json.enc (and peer sync carries them),
 * Self-hosted Mode forwards every call to the Docket Server, which holds the only copy.
 */
export interface SeenInput {
  key: string;
  status: string | null;
  title: string;
}

export interface DigestService {
  publish(input: unknown, ctx: DigestContext): Promise<Digest>;
  list(limit: number): Promise<{ digests: Digest[]; total: number }>;
  get(id: string): Promise<Digest | null>;
  delete(id: string, deviceId: string | null): Promise<Digest | null>;
  seen(): Promise<DigestSeen[]>;
  markSeen(input: SeenInput, seen: boolean, deviceId: string | null): Promise<DigestSeen>;
}

export const localDigestService: DigestService = {
  publish: publishDigest,
  list: listDigests,
  get: getDigest,
  delete: deleteDigest,
  seen: listSeen,
  markSeen,
};

/** The server's 400 carries the validation message; it reaches the agent the same as a local rejection. */
function errorOf(body: unknown): string {
  return typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "rejected";
}

/**
 * A server older than 3.1 has no digest routes and answers its generic 404 — which must not
 * read as "no such digest" (a get that quietly returns nothing) or as an unreachable server.
 * The digest routes' own 404 says "no such digest"; anything else means the routes are missing.
 */
function predatesDigests(status: number, body: unknown): boolean {
  return status === 404 && errorOf(body) !== "no such digest";
}

export const SERVER_PREDATES_DIGESTS = "this Docket Server predates digests — update it to docket 3.1 or later";

type RemoteCall = Pick<RemoteTodoRepository, "call" | "unexpectedResponse">;

export class RemoteDigestService implements DigestService {
  constructor(private readonly remote: RemoteCall) {}

  private async send(method: string, path: string, body?: unknown, agent?: string | null): Promise<{ status: number; body: unknown }> {
    const context = agent === undefined ? undefined : { agent, session: null, deviceId: "", deviceName: "" };
    const res = await this.remote.call(method, path, body, context);
    if (predatesDigests(res.status, res.body)) throw new RemoteProtocolError(SERVER_PREDATES_DIGESTS);
    return res;
  }

  async publish(input: unknown, ctx: DigestContext): Promise<Digest> {
    // The server stamps device and agent from the authenticated request; the agent name
    // rides the usual descriptive header.
    const { status, body } = await this.send("POST", "/api/v1/digests", input, ctx.agent);
    if (status === 400) throw new DigestValidationError(errorOf(body));
    if (status !== 201) throw this.remote.unexpectedResponse(status, body);
    return (body as { digest: Digest }).digest;
  }

  async list(limit: number): Promise<{ digests: Digest[]; total: number }> {
    const { status, body } = await this.send("GET", `/api/v1/digests?limit=${encodeURIComponent(String(limit))}`);
    if (status !== 200) throw this.remote.unexpectedResponse(status, body);
    return body as { digests: Digest[]; total: number };
  }

  async get(id: string): Promise<Digest | null> {
    const { status, body } = await this.send("GET", `/api/v1/digests/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (status === 409) throw new DigestValidationError(errorOf(body));
    if (status !== 200) throw this.remote.unexpectedResponse(status, body);
    return (body as { digest: Digest }).digest;
  }

  /** `deviceId` is ignored here: the server records the device the request was signed by. */
  async delete(id: string, _deviceId?: string | null): Promise<Digest | null> {
    const { status, body } = await this.send("DELETE", `/api/v1/digests/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (status === 409) throw new DigestValidationError(errorOf(body));
    if (status !== 200) throw this.remote.unexpectedResponse(status, body);
    return (body as { removed: Digest }).removed;
  }

  async seen(): Promise<DigestSeen[]> {
    const { status, body } = await this.send("GET", "/api/v1/digests/seen");
    if (status !== 200) throw this.remote.unexpectedResponse(status, body);
    return (body as { seen: DigestSeen[] }).seen;
  }

  async markSeen(input: SeenInput, seen: boolean, _deviceId?: string | null): Promise<DigestSeen> {
    const { status, body } = await this.send("POST", "/api/v1/digests/seen", { ...input, seen });
    if (status === 400) throw new DigestValidationError(errorOf(body));
    if (status !== 200) throw this.remote.unexpectedResponse(status, body);
    return (body as { seen: DigestSeen }).seen;
  }
}
