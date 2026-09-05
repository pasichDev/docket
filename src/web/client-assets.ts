import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

/**
 * Serves the dashboard's own JavaScript, compiled from src/web/client/app by
 * tsconfig.client.json.
 *
 * The client used to be a 1,676-line string inlined into the page, which no compiler could
 * see into. It is now real modules that the browser loads as native ESM — no bundler, no
 * new dependency, and `tsc` checks it against the DOM lib.
 *
 * The cost of that is one HTTP route, and the only thing this route must never do is let a
 * path out of that directory.
 */
const CLIENT_DIR = fileURLToPath(new URL("./client/app/", import.meta.url));

/**
 * Deliberately an allowlist pattern rather than path normalisation. The emitted filenames
 * are all lowercase module names, so anything with a slash, a dot-segment, a backslash or a
 * URL escape is not a module this server has — and refusing it by shape means there is no
 * traversal to reason about, on any platform.
 */
const CLIENT_MODULE = /^[a-z][a-z0-9-]*\.js$/;

/** In-memory, because these files change only when the server binary does. */
const cache = new Map<string, string>();

export function isClientAssetPath(pathname: string): boolean {
  return pathname.startsWith("/client/");
}

export async function serveClientAsset(pathname: string, res: ServerResponse, securityHeaders: Record<string, string>): Promise<void> {
  const name = pathname.slice("/client/".length);
  if (!CLIENT_MODULE.test(name)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders });
    res.end("not found");
    return;
  }

  let source = cache.get(name);
  if (source === undefined) {
    try {
      source = await readFile(join(CLIENT_DIR, name), "utf8");
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders });
      res.end("not found");
      return;
    }
    cache.set(name, source);
  }

  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    // no-cache, not immutable: the filenames are stable across versions, so a cached copy
    // would survive an upgrade and pair a new page with an old module. Revalidation is one
    // conditional request against a loopback server.
    "Cache-Control": "no-cache",
    ...securityHeaders,
  });
  res.end(source);
}
