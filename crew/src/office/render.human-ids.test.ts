import assert from "node:assert/strict";
import test from "node:test";

import { HUMAN_SPEAKER_IDS } from "./client/render.js";
import { RESERVED_AGENT_NAMES, agentNameKey } from "../naming.js";

/**
 * Drift guard for a deliberate duplication.
 *
 * `render.ts` is served to the browser as a raw ES module out of dist/office/client/, and the
 * asset route serves nothing outside that directory — so it cannot import naming.ts at runtime,
 * only duplicate the list. That is fine as long as the copy cannot silently diverge, which is
 * what these tests are for. Same pattern as markdown.ts's vendored escapeHtml.
 *
 * Why it matters rather than being tidiness: naming.ts reserves these so no agent can be NAMED
 * "human"; render.ts uses them to decide whose messages are drawn as the human's own. If the
 * lists drift, a sender the daemon considers ordinary gets rendered as "You" (or the reverse),
 * which is exactly the confusion the reservation exists to prevent.
 */
test("the browser's human-speaker list is naming.ts's reserved names, minus crew", () => {
  const expected = RESERVED_AGENT_NAMES.filter((n) => n !== "crew");
  assert.deepEqual([...HUMAN_SPEAKER_IDS].sort(), [...expected].sort());
});

test("crew is reserved but is NOT rendered as a human speaker", () => {
  // "crew" is reserved so an agent cannot impersonate the daemon in a mailbox `from`, not
  // because the daemon is a person. Rendering it as "You" would attribute Crew's own system
  // messages to the human.
  assert.ok(RESERVED_AGENT_NAMES.includes("crew"));
  assert.ok(!HUMAN_SPEAKER_IDS.includes("crew"));
});

test("render's speaker key folds the same spoofs naming.ts folds", () => {
  // Both sides must agree that these are "human"; naming.ts blocks the name at the source,
  // this is the display half of the same defence.
  for (const spoof of ["human", "Human", "  HUMAN  ", "ｈｕｍａｎ", "hu​man", "human‍"]) {
    assert.equal(agentNameKey(spoof), "human", `naming.ts should fold ${JSON.stringify(spoof)}`);
  }
});
