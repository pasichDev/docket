import type { HistoryEntry } from "../history.js";
import {
  TodoClaimConflictError,
  TodoConflictError,
  TodoNotFoundError,
  type ClaimOptions,
  type ClaimResult,
  type CreateTodoInput,
  type EditTodoInput,
  type MutationContext,
  type RepositoryHealth,
  type TodoId,
  type TodoQuery,
  type TodoRepository,
} from "../repository.js";
import type { Todo } from "../types.js";
import { generateNonce, hashBody, signDeviceRequest } from "./device-auth.js";
import { CLIENT_PROTOCOL_VERSION, DEVICE_AUTH_HEADERS, MIN_COMPATIBLE_SERVER_PROTOCOL } from "./protocol.js";

/**
 * HTTP client implementation of TodoRepository (RFC "Local and Self-Hosted Backend Modes"
 * §7, Implementation Phase 2) — every method forwards to the real /api/v1 routes Phase 1
 * built, signing each request per §14 (src/remote/device-auth.ts). A genuine adapter, not
 * a reimplementation: it never applies a mutation rule itself, only translates
 * TodoRepository calls <-> signed HTTP <-> the server's own LocalTodoRepository, which is
 * the ONLY place mutation semantics actually run (RFC §8).
 */

/** Thrown for any connectivity/response failure — network error, timeout, non-2xx the caller isn't specifically handling, or a malformed response. NEVER thrown as (and never caught as) TodoNotFoundError: RFC §22's invariant is that a remote failure surfaces as a clear, distinct error, never silently treated as "no such item" or papered over. */
export class RemoteUnavailableError extends Error {
  constructor(
    public readonly serverUrl: string,
    lastError: string,
  ) {
    super(
      `docket: remote server unavailable\nserver: ${serverUrl}\nlast error: ${lastError}\n\n` +
        `The docket workspace is hosted remotely and the configured server cannot currently be reached. No local mutation was performed.`,
    );
    this.name = "RemoteUnavailableError";
  }
}

/** Protocol/compatibility failures (RFC §23) — distinct from RemoteUnavailableError because the server WAS reached; it just isn't a compatible/genuine docket server. Also fails closed rather than guessing. */
export class RemoteProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteProtocolError";
  }
}

type WireTodo = Omit<Todo, "id"> & { id: string };

export interface RemoteTodoRepositoryOptions {
  serverUrl: string;
  /** This device's own identity (device.ts) — sent as X-Docket-Device / signed with `secret`. */
  deviceId: string;
  deviceName: string;
  /** The ECDH+HKDF("docket/server-auth/v1")-derived secret from pairing (see remote/pairing.ts and device.ts's deriveServerAuthSecret). Never transmitted. */
  secret: string;
  fetchTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
/** A bare digit-shaped id (number OR a numeric-looking string) is ONLY ever one of this repository's own synthetic local ids (assigned in fromWire, below) — never forwarded to the server as-is. The server's own LocalTodoRepository would happily resolve a random small integer against ITS OWN local numeric id space (findTodoByAnyId in storage.ts), which could silently hit an unrelated item. Only a short id ("T-XXXX") or a full uuid — both globally unique per RFC §19 — is safe to send verbatim. */
const PURE_DIGITS_RE = /^\d+$/;

export class RemoteTodoRepository implements TodoRepository {
  private readonly serverOrigin: string;
  private readonly timeoutMs: number;
  private compatibility: Promise<void> | null = null;

  // RFC §19: the wire protocol never carries a local numeric id. TodoRepository's
  // interface still returns `Todo` (id: number) though, so this repository fabricates a
  // stable-for-this-process-lifetime numeric id the first time it sees each uuid — purely
  // a local display/lookup convenience, never sent to the server (see resolveRemoteId).
  private nextLocalId = 1;
  private readonly localIdByUuid = new Map<string, number>();
  private readonly uuidByLocalId = new Map<number, string>();

  constructor(private readonly options: RemoteTodoRepositoryOptions) {
    this.serverOrigin = options.serverUrl.replace(/\/$/, "");
    this.timeoutMs = options.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private fromWire(wire: WireTodo): Todo {
    let localId = this.localIdByUuid.get(wire.uuid);
    if (localId === undefined) {
      localId = this.nextLocalId++;
      this.localIdByUuid.set(wire.uuid, localId);
      this.uuidByLocalId.set(localId, wire.uuid);
    }
    const { id: _wireId, ...rest } = wire;
    return { id: localId, ...rest };
  }

  private resolveRemoteId(id: TodoId): string {
    if (typeof id === "number" || PURE_DIGITS_RE.test(String(id))) {
      const uuid = this.uuidByLocalId.get(Number(id));
      if (!uuid) throw new TodoNotFoundError(id);
      return uuid;
    }
    return String(id);
  }

  private tryResolveRemoteId(id: TodoId): string | null {
    try {
      return this.resolveRemoteId(id);
    } catch {
      return null;
    }
  }

  private contextHeaders(context: MutationContext): Record<string, string> {
    const headers: Record<string, string> = {};
    if (context.agent) headers["X-Docket-Agent"] = context.agent;
    if (context.session) headers["X-Docket-Session"] = context.session;
    return headers;
  }

  /**
   * Signs and sends one request (RFC §14). `path` MUST be the full request-target
   * (`/api/v1/...`, including any query string) — exactly what gets signed AND exactly
   * what gets fetched, so there's no way for the two to silently drift apart.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    const rawBody = body === undefined ? "" : JSON.stringify(body);
    const timestamp = new Date().toISOString();
    const nonce = generateNonce();
    const bodyHash = hashBody(rawBody);
    const signature = signDeviceRequest(this.options.secret, method, path, timestamp, nonce, bodyHash);
    const headers: Record<string, string> = {
      [DEVICE_AUTH_HEADERS.device]: this.options.deviceId,
      [DEVICE_AUTH_HEADERS.timestamp]: timestamp,
      [DEVICE_AUTH_HEADERS.nonce]: nonce,
      [DEVICE_AUTH_HEADERS.signature]: signature,
      "X-Docket-Device-Id": this.options.deviceId,
      "X-Docket-Device-Name": this.options.deviceName,
      ...extraHeaders,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${this.serverOrigin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : rawBody,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network error, DNS failure, timeout, refused connection, TLS failure — every one of
      // these MUST surface as a clear error, never as an empty/"not found" result (RFC §22).
      throw new RemoteUnavailableError(this.options.serverUrl, (err as Error).message);
    }

    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new RemoteUnavailableError(this.options.serverUrl, `malformed (non-JSON) response, status ${res.status}`);
      }
    }
    return { status: res.status, body: parsed };
  }

  private unexpected(status: number, body: unknown): Error {
    const error = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : undefined;
    return new RemoteUnavailableError(this.options.serverUrl, error ?? `unexpected response (status ${status})`);
  }

  /**
   * RFC §23: checked once per repository instance (an MCP session's lifetime), not on
   * every call — but a FAILED check is never cached, so a transient blip during startup
   * doesn't permanently wedge every later call once the server becomes reachable again.
   */
  private ensureCompatible(): Promise<void> {
    this.compatibility ??= this.checkCompatibility().catch((err) => {
      this.compatibility = null;
      throw err;
    });
    return this.compatibility;
  }

  private async checkCompatibility(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.serverOrigin}/api/v1/info`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new RemoteUnavailableError(this.options.serverUrl, (err as Error).message);
    }
    if (!res.ok) throw new RemoteUnavailableError(this.options.serverUrl, `GET /api/v1/info responded ${res.status}`);
    const info = (await res.json().catch(() => ({}))) as { product?: string; protocolVersion?: number; minClientProtocol?: number };
    if (info.product !== "docket") {
      throw new RemoteProtocolError(`docket: ${this.options.serverUrl} doesn't look like a docket server (unexpected /api/v1/info response)`);
    }
    if (typeof info.protocolVersion !== "number" || info.protocolVersion < MIN_COMPATIBLE_SERVER_PROTOCOL) {
      throw new RemoteProtocolError(
        `docket: server protocol v${info.protocolVersion} is older than this client supports (min v${MIN_COMPATIBLE_SERVER_PROTOCOL}) — update the server.`,
      );
    }
    if (typeof info.minClientProtocol === "number" && info.minClientProtocol > CLIENT_PROTOCOL_VERSION) {
      throw new RemoteProtocolError(
        `docket: server requires client protocol v${info.minClientProtocol}+, this client is v${CLIENT_PROTOCOL_VERSION} — update docket on this device.`,
      );
    }
  }

  async list(query: TodoQuery): Promise<Todo[]> {
    await this.ensureCompatible();
    const params = new URLSearchParams();
    if (query.filter) params.set("filter", query.filter);
    if (query.list) params.set("list", query.list);
    if (query.category) params.set("category", query.category);
    if (query.agent) params.set("agent", query.agent);
    if (query.session) params.set("session", query.session);
    if (query.inProgress) params.set("inProgress", "true");
    const qs = params.toString();
    const { status, body } = await this.request("GET", `/api/v1/todos${qs ? `?${qs}` : ""}`);
    if (status !== 200) throw this.unexpected(status, body);
    return (body as { todos: WireTodo[] }).todos.map((w) => this.fromWire(w));
  }

  async get(id: TodoId): Promise<Todo | null> {
    // Resolve BEFORE the compat check (and thus before any network call at all) — an
    // unmapped numeric id can never resolve to anything real regardless of whether the
    // server is even reachable, so there's no reason to touch the network first.
    const remoteId = this.tryResolveRemoteId(id);
    if (remoteId === null) return null;
    await this.ensureCompatible();
    const { status, body } = await this.request("GET", `/api/v1/todos/${encodeURIComponent(remoteId)}`);
    if (status === 404) return null;
    if (status !== 200) throw this.unexpected(status, body);
    return this.fromWire((body as { todo: WireTodo }).todo);
  }

  async create(input: CreateTodoInput, context: MutationContext): Promise<Todo> {
    await this.ensureCompatible();
    const { status, body } = await this.request("POST", "/api/v1/todos", input, this.contextHeaders(context));
    if (status !== 201) throw this.unexpected(status, body);
    return this.fromWire((body as { todo: WireTodo }).todo);
  }

  async edit(id: TodoId, input: EditTodoInput, context: MutationContext, expectedRevision?: number): Promise<Todo> {
    const remoteId = this.resolveRemoteId(id); // resolved before any network call — see get()'s comment
    await this.ensureCompatible();
    const headers = this.contextHeaders(context);
    if (expectedRevision !== undefined) headers["If-Match"] = String(expectedRevision);
    const { status, body } = await this.request("PATCH", `/api/v1/todos/${encodeURIComponent(remoteId)}`, input, headers);
    if (status === 404) throw new TodoNotFoundError(id);
    if (status === 409) throw new TodoConflictError(this.fromWire((body as { todo: WireTodo }).todo));
    if (status !== 200) throw this.unexpected(status, body);
    return this.fromWire((body as { todo: WireTodo }).todo);
  }

  async complete(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo> {
    const remoteId = this.resolveRemoteId(id);
    await this.ensureCompatible();
    const headers = this.contextHeaders(context);
    if (expectedRevision !== undefined) headers["If-Match"] = String(expectedRevision);
    const { status, body } = await this.request("POST", `/api/v1/todos/${encodeURIComponent(remoteId)}/complete`, undefined, headers);
    if (status === 404) throw new TodoNotFoundError(id);
    if (status === 409) throw new TodoConflictError(this.fromWire((body as { todo: WireTodo }).todo));
    if (status !== 200) throw this.unexpected(status, body);
    return this.fromWire((body as { todo: WireTodo }).todo);
  }

  async delete(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo> {
    const remoteId = this.resolveRemoteId(id);
    await this.ensureCompatible();
    const headers = this.contextHeaders(context);
    if (expectedRevision !== undefined) headers["If-Match"] = String(expectedRevision);
    const { status, body } = await this.request("DELETE", `/api/v1/todos/${encodeURIComponent(remoteId)}`, undefined, headers);
    if (status === 404) throw new TodoNotFoundError(id);
    if (status === 409) throw new TodoConflictError(this.fromWire((body as { todo: WireTodo }).todo));
    if (status !== 200) throw this.unexpected(status, body);
    return this.fromWire((body as { removed: WireTodo }).removed);
  }

  /**
   * Local semantics (LocalTodoRepository, no options passed — every MCP tool call site)
   * ALWAYS succeed by taking over an active claim. The server route (routes.ts)
   * unconditionally enforces RFC §21's atomic requireFree, though — so to keep MCP-visible
   * behavior identical in both modes (RFC §36: "both modes should expose the same
   * user-visible semantics"), a caller that did NOT explicitly ask for strict semantics
   * gets `force: true` here, matching the local always-succeeds path exactly. A caller
   * that DOES pass `requireFree` gets real 409 semantics — force is exactly what it asked.
   */
  async claim(id: TodoId, context: MutationContext, options?: ClaimOptions): Promise<ClaimResult> {
    const remoteId = this.resolveRemoteId(id);
    await this.ensureCompatible();
    const headers = this.contextHeaders(context);
    if (options?.expectedRevision !== undefined) headers["If-Match"] = String(options.expectedRevision);
    const force = options?.requireFree ? Boolean(options.force) : true;
    const { status, body } = await this.request("POST", `/api/v1/todos/${encodeURIComponent(remoteId)}/claim`, { force }, headers);
    if (status === 404) throw new TodoNotFoundError(id);
    if (status === 409) {
      const b = body as { error: string; todo: WireTodo };
      const current = this.fromWire(b.todo);
      if (b.error === "already_claimed") throw new TodoClaimConflictError(current);
      throw new TodoConflictError(current);
    }
    if (status !== 200) throw this.unexpected(status, body);
    const b = body as { todo: WireTodo; previousAgent: string | null };
    return { todo: this.fromWire(b.todo), previousAgent: b.previousAgent };
  }

  async release(id: TodoId, context: MutationContext, expectedRevision?: number): Promise<Todo> {
    const remoteId = this.resolveRemoteId(id);
    await this.ensureCompatible();
    const headers = this.contextHeaders(context);
    if (expectedRevision !== undefined) headers["If-Match"] = String(expectedRevision);
    const { status, body } = await this.request("POST", `/api/v1/todos/${encodeURIComponent(remoteId)}/release`, undefined, headers);
    if (status === 404) throw new TodoNotFoundError(id);
    if (status === 409) throw new TodoConflictError(this.fromWire((body as { todo: WireTodo }).todo));
    if (status !== 200) throw this.unexpected(status, body);
    return this.fromWire((body as { todo: WireTodo }).todo);
  }

  async history(id: TodoId): Promise<HistoryEntry[]> {
    const remoteId = this.resolveRemoteId(id);
    await this.ensureCompatible();
    const { status, body } = await this.request("GET", `/api/v1/todos/${encodeURIComponent(remoteId)}/history`);
    if (status === 404) throw new TodoNotFoundError(id);
    if (status !== 200) throw this.unexpected(status, body);
    return (body as { history: HistoryEntry[] }).history;
  }

  async health(): Promise<RepositoryHealth> {
    await this.ensureCompatible();
    const healthRes = await this.request("GET", "/api/v1/health");
    if (healthRes.status !== 200) throw this.unexpected(healthRes.status, healthRes.body);
    const infoRes = await this.request("GET", "/api/v1/info");
    if (infoRes.status !== 200) throw this.unexpected(infoRes.status, infoRes.body);
    const info = infoRes.body as { storeFormatVersion: number };
    const listed = await this.list({ filter: "all", list: "all" });
    return { ok: (healthRes.body as { ok: boolean }).ok, formatVersion: info.storeFormatVersion, todoCount: listed.length };
  }
}
