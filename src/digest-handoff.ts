import type { DigestService } from "./digest-service.js";
import { DigestValidationError, digestShortId, findItem, itemHandle, parseItemHandle, type Digest, type DigestItem, type DigestSection } from "./digests.js";
import { shortId } from "./mutations.js";
import type { MutationContext } from "./repository.js";
import type { TodoService } from "./todo-service.js";
import type { Todo } from "./types.js";

/**
 * Handing a digest item to an agent by its number.
 *
 * The person says "take 7 from the digest" to any agent; the agent calls digest_take("7").
 * What it gets back is the whole brief — the item, its section, the agent's own detail and
 * link — and a docket task that is now claimed by it, so every other agent and the dashboard
 * can see who is on it. When the work is done the agent closes that task with
 * todo_complete(id, reason), and the dashboard shows the item as done.
 *
 * The task is the single record of the hand-off, deliberately. Digests are immutable
 * snapshots; "who is doing this, and is it finished" changes, and the task list already
 * syncs, claims and closes things.
 */

const TICKET_REF = /^[A-Z][A-Z0-9]+-\d+$/;
const DOCKET_REF = /^T-[0-9A-Z]{6}$/;

/** The task an item becomes — the same shape the dashboard's "+ task" makes. */
export function taskInputFor(digest: Digest, item: DigestItem, workspace: string | null) {
  const ticketLike = !!item.ref && TICKET_REF.test(item.ref);
  const title = !ticketLike && item.ref ? `${item.ref} ${item.title}` : item.title;
  const description = [
    item.detail ?? item.note,
    item.repo ? `Repo: ${item.repo}` : null,
    item.status ? `Status when captured: ${item.status}` : null,
    `From digest ${itemHandle(digest, item)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    title: title.slice(0, 300),
    description,
    category: ticketLike ? item.ref : (item.repo ?? null),
    sourceUrl: item.url,
    priority: item.attention ? ("high" as const) : null,
    list: "todo" as const,
    workspace,
  };
}

/** The todo this item already is (a T- ref) or already became (same link). Open beats done. */
export function existingTaskFor(item: DigestItem, todos: readonly Todo[]): Todo | null {
  const ref = item.ref?.trim().toUpperCase();
  if (ref && DOCKET_REF.test(ref)) {
    const own = todos.find((t) => shortId(t.uuid) === ref);
    if (own) return own;
  }
  if (!item.url) return null;
  const linked = todos.filter((t) => t.sourceUrl === item.url);
  return linked.find((t) => !t.done) ?? linked[0] ?? null;
}

export function briefFor(digest: Digest, item: DigestItem, section: DigestSection, todo: Todo): string {
  const id = shortId(todo.uuid);
  const lines = [
    `${itemHandle(digest, item)} → ${id}, claimed by you.`,
    "",
    `${item.kind.toUpperCase()}${item.ref ? ` ${item.ref}` : ""}: ${item.title}`,
    [item.status ? `status: ${item.status}` : null, item.repo ? `repo: ${item.repo}` : null, item.owner ? `owner: ${item.owner}` : null].filter(Boolean).join(" · "),
    item.url ? `link: ${item.url}` : null,
    `from: ${section.group ? `${section.group} / ` : ""}${section.title} in "${digest.title}" (${digest.createdAt.slice(0, 10)})`,
    item.note ? `\n${item.note}` : null,
    item.detail ? `\n${item.detail}` : null,
    "",
    "The digest is a snapshot: check the item's current state at its source before acting.",
    `When it is done: todo_complete("${id}", reason) — say how it was closed (e.g. the MR that fixed it).`,
    `If you stop without finishing: todo_release("${id}").`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export interface TakeResult {
  brief: string;
  todo: Todo;
  created: boolean;
  alreadyDone: boolean;
}

export async function takeDigestItem(handle: string, digests: DigestService, todos: TodoService, context: MutationContext): Promise<TakeResult> {
  const parsed = parseItemHandle(handle);
  if (!parsed) throw new DigestValidationError(`"${handle}" is not a digest item — use its number ("7") or the full handle ("D-7K2F9A/7")`);
  const digest = parsed.digest ? await digests.get(parsed.digest) : ((await digests.list(1)).digests[0] ?? null);
  if (!digest) throw new DigestValidationError(parsed.digest ? `no digest ${parsed.digest}` : "there is no digest yet");
  const found = findItem(digest, parsed.n);
  if (!found) {
    const count = digest.sections.reduce((n, s) => n + s.items.length, 0);
    const numbered = digest.sections.some((s) => s.items.some((i) => i.n > 0));
    throw new DigestValidationError(
      numbered
        ? `${digestShortId(digest.uuid)} has no item ${parsed.n} — it has ${count}`
        : `${digestShortId(digest.uuid)} was published before items were numbered; take one from a newer digest`,
    );
  }
  const { item, section } = found;

  const existing = existingTaskFor(item, await todos.list({ filter: "all", workspace: "*" }));
  if (existing?.done) {
    return { brief: `${itemHandle(digest, item)} is already done as ${shortId(existing.uuid)} ("${existing.title}"). Nothing to take.`, todo: existing, created: false, alreadyDone: true };
  }
  const todo = existing ?? (await todos.create(taskInputFor(digest, item, context.workspace ?? null), context));
  const claimed = await todos.claim(todo.uuid, context);
  const current = claimed?.todo ?? todo;
  return { brief: briefFor(digest, item, section, current), todo: current, created: !existing, alreadyDone: false };
}
