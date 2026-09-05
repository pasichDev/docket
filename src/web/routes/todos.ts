import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../http.js";
import { log } from "../../log.js";
import { isClaimActive, shortId } from "../../mutations.js";
import { todoService } from "../../todo-service.js";
import { isDate, isPriority, isTodoList, json, patchDate, patchPriority, patchText, readJsonBody, textOrNull, webContext } from "../http.js";

/**
 * The list itself: read, create, complete, edit, delete, and one item's full history.
 *
 * Every mutation goes through todoService, which is what makes the same routes work against a
 * remote server. Nothing here touches the store directly.
 */

interface TodoRequestBody {
  title?: unknown;
  description?: unknown;
  list?: unknown;
  category?: unknown;
  priority?: unknown;
  dueDate?: unknown;
  sourceUrl?: unknown;
  workspace?: unknown;
}

export async function handleTodoRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  // 6. Todos - List
  if (req.method === "GET" && url.pathname === "/api/todos") {
    const all = await todoService.list({});
    // shortId travels with each item so the web UI can show the same cross-device id an
    // MCP tool would — computed here, not client-side, so there's only one place deriving
    // it from uuid (see shortId() in mutations.ts).
    const todos = all.map((t) => ({ ...(isClaimActive(t) ? t : { ...t, workingAgent: null }), shortId: shortId(t.uuid) }));
    json(res, 200, { todos });
    return true;
  }

  // 6b. Todos - Full history for one item
  // GET /api/todos/:id/history — the card preview ships the last few entries inline with
  // the item; this is what the detail panel opens for the rest. Separate route (rather than
  // fattening /api/todos) precisely so the list stays cheap: history is the unbounded part.
  const historyMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/history$/);
  if (req.method === "GET" && historyMatch) {
    const entries = await todoService.history(decodeURIComponent(historyMatch[1]));
    if (!entries) {
      json(res, 404, { error: "no such todo" });
      return true;
    }
    json(res, 200, { history: entries });
    return true;
  }

  // 7. Todos - Create
  if (req.method === "POST" && url.pathname === "/api/todos") {
    const body = (await readJsonBody(req)) as TodoRequestBody;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      json(res, 400, { error: "title is required" });
      return true;
    }
    const todo = await todoService.create(
      {
        // The dashboard is one view over every project, so it says which one an item
        // belongs to rather than inheriting a project from the process it runs in. Without
        // this, typing a todo while a project is selected files it Unfiled and it vanishes
        // from the very list it was typed into.
        workspace: typeof body.workspace === "string" ? textOrNull(body.workspace) : undefined,
        title,
        description: textOrNull(body.description),
        list: isTodoList(body.list) ? body.list : "todo",
        category: textOrNull(body.category),
        priority: isPriority(body.priority) ? body.priority : null,
        dueDate: isDate(body.dueDate) ? body.dueDate : null,
        sourceUrl: textOrNull(body.sourceUrl),
      },
      webContext(ctx),
    );
    ctx.broadcastUpdate();
    json(res, 201, { todo });
    return true;
  }

  // 8. Todos - Complete
  const completeMatch = url.pathname.match(/^\/api\/todos\/(\d+)\/complete$/);
  if (req.method === "POST" && completeMatch) {
    const id = Number(completeMatch[1]);
    const todo = await todoService.complete(id, webContext(ctx));
    if (!todo) {
      json(res, 404, { error: `No todo with id #${id}` });
      return true;
    }
    ctx.broadcastUpdate();
    json(res, 200, { todo });
    return true;
  }

  // 9. Todos - Edit / Patch
  const todoIdMatch = url.pathname.match(/^\/api\/todos\/(\d+)$/);
  if (req.method === "PATCH" && todoIdMatch) {
    const id = Number(todoIdMatch[1]);
    const body = (await readJsonBody(req)) as TodoRequestBody;
    const nextTitle = typeof body.title === "string" ? body.title.trim() : "";
    const patch = {
      title: nextTitle || undefined,
      description: patchText(body.description),
      category: patchText(body.category),
      priority: patchPriority(body.priority),
      dueDate: patchDate(body.dueDate),
      sourceUrl: patchText(body.sourceUrl),
      list: isTodoList(body.list) ? body.list : undefined,
    };
    const todo = await todoService.edit(id, patch, webContext(ctx));
    if (!todo) {
      json(res, 404, { error: `No todo with id #${id}` });
      return true;
    }
    ctx.broadcastUpdate();
    json(res, 200, { todo });
    return true;
  }

  // 10. Todos - Delete
  if (req.method === "DELETE" && todoIdMatch) {
    const id = Number(todoIdMatch[1]);
    const removed = await todoService.delete(id, webContext(ctx));
    if (!removed) {
      json(res, 404, { error: `No todo with id #${id}` });
      return true;
    }
    log(`deleted #${removed.id} "${removed.title}" by web`);
    ctx.broadcastUpdate();
    json(res, 200, { removed });
    return true;
  }

  return false;
}
