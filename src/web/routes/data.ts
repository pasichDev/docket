import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../http.js";
import { exportToJson, exportToMarkdown, importFromJson, importFromMarkdown } from "../../export.js";
import { readStore, withStore } from "../../storage.js";
import { SECURITY_HEADERS, json, readJsonBody } from "../http.js";

/**
 * Whole-store import and export.
 *
 * These reach readStore/withStore directly rather than going through TodoService, and that is
 * the boundary rather than a leak: the repository abstraction covers per-ITEM operations, which
 * is what lets a remote deployment exist. Bulk operations over the whole store have no remote
 * equivalent and never will.
 */

export async function handleDataRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  // 2. Export
  if (req.method === "GET" && url.pathname === "/api/export") {
    const format = url.searchParams.get("format")?.toLowerCase() === "markdown" ? "markdown" : "json";
    const store = await readStore();
    const filename = format === "markdown" ? `todos-${new Date().toISOString().slice(0, 10)}.md` : `todos-${new Date().toISOString().slice(0, 10)}.json`;
    const contentType = format === "markdown" ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8";
    const content = format === "markdown" ? exportToMarkdown(store) : exportToJson(store);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...SECURITY_HEADERS,
    });
    res.end(content);
    return true;
  }

  // 3. Import
  if (req.method === "POST" && url.pathname === "/api/import") {
    const body = (await readJsonBody(req)) as { content?: unknown; filename?: unknown };
    const rawContent = typeof body.content === "string" ? body.content : "";
    if (!rawContent.trim()) {
      json(res, 400, { error: "No content provided to import" });
      return true;
    }
    const filename = typeof body.filename === "string" ? body.filename : "";
    const isJson = filename.endsWith(".json") || rawContent.trim().startsWith("{") || rawContent.trim().startsWith("[");
    const result = await withStore((store) => {
      if (isJson) {
        return importFromJson(store, rawContent, ctx.deviceId, ctx.deviceName);
      }
      return importFromMarkdown(store, rawContent, ctx.deviceId, ctx.deviceName);
    });
    ctx.broadcastUpdate();
    json(res, 200, result);
    return true;
  }

  return false;
}
