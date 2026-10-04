import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const originalDataDirectory = process.env.DOCKET_DATA_DIR;
const dataDirectory = await mkdtemp(join(tmpdir(), "docket-handoff-test-"));
process.env.DOCKET_DATA_DIR = dataDirectory;
const { localDigestService } = await import("./digest-service.js");
const { takeDigestItem } = await import("./digest-handoff.js");
const { todoService } = await import("./todo-service.js");
const { shortId } = await import("./mutations.js");
const { parseItemHandle, DigestValidationError } = await import("./digests.js");

test.after(() => {
  if (originalDataDirectory === undefined) delete process.env.DOCKET_DATA_DIR;
  else process.env.DOCKET_DATA_DIR = originalDataDirectory;
  return rm(dataDirectory, { recursive: true, force: true });
});

const agent = { agent: "codex", session: "s1", deviceId: "dev", deviceName: "Dev", workspace: "acme/backend" };
const pub = { agent: "claude-code", deviceId: "dev", deviceName: "Dev", workspace: null };

test("parseItemHandle: the ways a person names an item", () => {
  assert.deepEqual(parseItemHandle("7"), { digest: null, n: 7 });
  assert.deepEqual(parseItemHandle("#7"), { digest: null, n: 7 });
  assert.deepEqual(parseItemHandle("D-7k2f9a/7"), { digest: "D-7K2F9A", n: 7 });
  assert.deepEqual(parseItemHandle("7K2F9A#12"), { digest: "D-7K2F9A", n: 12 });
  assert.equal(parseItemHandle("take seven"), null);
});

test("digest_take: an item becomes a claimed task with the full brief; taking it again finds the same task; closing it ends the hand-off", async () => {
  const digest = await localDigestService.publish(
    {
      title: "Fri",
      summary: "",
      sections: [
        {
          group: "Work",
          title: "Needs you",
          items: [
            { kind: "mr", title: "Retry webhooks", ref: "!214", repo: "acme/backend", url: "https://gitlab.com/acme/backend/-/merge_requests/214", status: "review requested", attention: true, owner: "you", detail: "The retry loop has no jitter, so **every** client retries at once." },
            { kind: "ticket", title: "Pick a webhook fallback", ref: "ACME-701", url: "https://acme.example/browse/ACME-701", status: "Blocked", owner: "agent" },
          ],
        },
      ],
    },
    pub,
  );
  assert.deepEqual(digest.sections[0].items.map((i) => i.n), [1, 2], "items are numbered on publish");

  const first = await takeDigestItem("1", localDigestService, todoService, agent);
  assert.equal(first.created, true);
  assert.equal(first.todo.workingAgent, "codex", "the taking agent holds the claim, so others can see who is on it");
  assert.equal(first.todo.category, "acme/backend");
  assert.equal(first.todo.priority, "high", "needs-you becomes high priority");
  assert.equal(first.todo.workspace, "acme/backend", "filed where the agent works");
  assert.match(first.brief, /every\*\* client retries at once/, "the brief carries the agent's detail");
  assert.match(first.brief, new RegExp(`todo_complete\\("${shortId(first.todo.uuid)}"`), "the brief says how to close it");

  const again = await takeDigestItem(`${digest.uuid}/1`, localDigestService, todoService, agent);
  assert.equal(again.created, false);
  assert.equal(again.todo.uuid, first.todo.uuid, "taking the same item twice must not make a second task");

  const ticket = await takeDigestItem("2", localDigestService, todoService, agent);
  assert.equal(ticket.todo.category, "ACME-701", "a ticket id becomes the category");

  await todoService.complete(first.todo.uuid, agent, undefined, "merged as !214");
  const after = await takeDigestItem("1", localDigestService, todoService, agent);
  assert.equal(after.alreadyDone, true, "a closed item is reported as done, never reopened");
});

test("digest_take: an item that IS a docket task claims that task instead of making another", async () => {
  const todo = await todoService.create({ title: "Rotate the staging key" }, agent);
  await localDigestService.publish(
    { title: "Sat", summary: "", sections: [{ title: "Needs you", items: [{ kind: "todo", title: "Rotate the staging key", ref: shortId(todo.uuid), status: "open" }] }] },
    pub,
  );
  const taken = await takeDigestItem("#1", localDigestService, todoService, agent);
  assert.equal(taken.todo.uuid, todo.uuid);
  assert.equal(taken.created, false);
});

test("digest_take: a number past the end says how many items there are", async () => {
  await assert.rejects(() => takeDigestItem("99", localDigestService, todoService, agent), (err: Error) => err instanceof DigestValidationError && /has no item 99 — it has 1/.test(err.message));
});
