/**
 * In-memory StateAccess/EventSink fakes for the orchestration tests.
 *
 * These are the only mocks in the codebase and they exist for one reason: the orchestration
 * layer's behaviour (state machine, delivery semantics, wake guard) must be testable without
 * a daemon, a disk or a real CLI. Everything that touches a REAL runtime is tested against
 * the real binary instead (adapters/live.test.ts) — a mocked `claude` would only prove the
 * mock works.
 *
 * Shipped in src/ rather than a test file because several test files share it; it is
 * excluded from the published package by package.json's `files`.
 */

import type { EventSink, StateAccess } from "./assignments.js";
import { freshState } from "./state.js";
import type { CrewAgent, CrewEvent, CrewEventType, CrewState } from "./types.js";

export class FakeStore implements StateAccess {
  private current: CrewState;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(workspace = "test-ws") {
    this.current = freshState(workspace, 0);
  }

  async getState(): Promise<CrewState> {
    return structuredClone(this.current);
  }

  /** Serialized like the real StateStore, and committing nothing when the mutator throws. */
  withState<T>(mutator: (state: CrewState) => T | Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const draft = structuredClone(this.current);
      const result = await mutator(draft);
      this.current = draft;
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export class FakeBus implements EventSink {
  readonly events: CrewEvent[] = [];
  private readonly listeners = new Set<(event: CrewEvent) => void>();
  private seq = 0;

  async publish(type: CrewEventType, fields: Omit<CrewEvent, "id" | "type" | "at"> = {}): Promise<CrewEvent> {
    const event: CrewEvent = { id: `e${++this.seq}`, type, at: new Date().toISOString(), ...fields };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: (event: CrewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async readRecent(n: number): Promise<CrewEvent[]> {
    return this.events.slice(-n);
  }

  types(): CrewEventType[] {
    return this.events.map((e) => e.type);
  }

  count(type: CrewEventType): number {
    return this.events.filter((e) => e.type === type).length;
  }
}

export function agent(overrides: Partial<CrewAgent> & { id: string }): CrewAgent {
  return {
    name: overrides.id,
    origin: "managed",
    status: "idle",
    runtime: "claude",
    role: "worker",
    ...overrides,
  };
}

/** Put agents straight into a FakeStore, bypassing spawn limits. */
export async function seedAgents(store: FakeStore, ...agents: CrewAgent[]): Promise<void> {
  await store.withState((state) => {
    for (const a of agents) state.agents[a.id] = a;
  });
}
