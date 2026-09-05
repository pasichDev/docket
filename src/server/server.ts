import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { log } from "../log.js";
import { json } from "../web/http.js";
import { getAdminToken } from "./admin-token.js";
import { sseClients } from "./events.js";
import { handleServeApiRoute, type ServeApiContext } from "./routes.js";
import { AmbiguousTodoIdError } from "../storage.js";

/** Pure HTTP server construction — no listen(), no signal handlers — so tests can create one, bind it to an ephemeral port, and tear it down without going through the CLI. */
export function createServeHttpServer(ctx: ServeApiContext): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await handleServeApiRoute(req, res, url, ctx);
      if (handled) return;
      json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof AmbiguousTodoIdError) {
        // 409, not 500: the request was well-formed and the server is healthy — the id the
        // caller used simply does not identify one item, and the fix is theirs (use the uuid).
        json(res, 409, { error: err.message, candidates: err.candidates.map((t) => ({ uuid: t.uuid, title: t.title })) });
        return;
      }
      log(`serve request error: ${(err as Error).stack ?? (err as Error).message}`);
      json(res, 500, { error: (err as Error).message });
    }
  });
}

export interface StartServeOptions {
  host: string;
  port: number;
  serverVersion: string;
}

export interface RunningServeServer {
  port: number;
  close: () => Promise<void>;
}

export async function startServeServer(options: StartServeOptions): Promise<RunningServeServer> {
  const ctx: ServeApiContext = {
    serverVersion: options.serverVersion,
    startedAt: new Date().toISOString(),
    // Minted here on first run, so `docket devices …` has something to read.
    adminToken: await getAdminToken(),
  };
  const server = createServeHttpServer(ctx);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? options.port;
  log(`serve: listening on ${options.host}:${port}`);

  const close = () =>
    new Promise<void>((resolve) => {
      for (const client of sseClients) {
        try {
          client.end();
        } catch {}
        sseClients.delete(client);
      }
      server.close(() => resolve());
    });

  return { port, close };
}
