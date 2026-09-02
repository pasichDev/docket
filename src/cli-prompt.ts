import { createInterface } from "node:readline/promises";

/**
 * Shared answer-reading primitive for every CLI flow that needs more than one line from
 * stdin within a single command run. Node's readline has a real hazard here — reproduced
 * directly against this project's Node version, not theorized: calling the promises-API
 * `.question()` a SECOND time on the same Interface, after piped/non-TTY stdin has already
 * delivered all its buffered lines, throws `ERR_USE_AFTER_CLOSE`; creating a fresh
 * Interface per question instead just hangs forever on the second one (piped stdin can't
 * be "rewound" once one Interface has read from it — the data is gone). The one pattern
 * that survives reliably, on both a real TTY and piped/non-interactive stdin, with any
 * amount of async work (e.g. a network probe) between prompts: create ONE Interface, take
 * its async-iterator ONCE, and read every subsequent line via that SAME iterator's
 * `.next()` — never `.question()` on the same Interface afterward, and never a second
 * Interface for the rest of that command. Every multi-prompt CLI flow in this project goes
 * through this module for that reason (see index.ts's `restore`/`backup` commands,
 * `docket setup`'s remote flow, and `docket backend use`/`localize`).
 */
export interface LineReader {
  /** Raw next line (no trimming), or "" if stdin ended before a line arrived. */
  next(prompt: string): Promise<string>;
  /** Trimmed answer, or `fallback` if the line was empty or stdin ended. */
  ask(prompt: string, fallback: string): Promise<string>;
  /** y/yes (case-insensitive) is true, anything else non-empty is false, empty/EOF is `fallback`. */
  askYesNo(prompt: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

export function createLineReader(): LineReader {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();

  const reader: LineReader = {
    async next(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      const { value, done } = await lines.next();
      return done ? "" : value;
    },
    async ask(prompt: string, fallback: string): Promise<string> {
      const answer = (await reader.next(`${prompt} [${fallback}] `)).trim();
      return answer || fallback;
    },
    async askYesNo(prompt: string, fallback: boolean): Promise<boolean> {
      const answer = (await reader.next(`${prompt} [${fallback ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
      if (!answer) return fallback;
      return answer === "y" || answer === "yes";
    },
    close(): void {
      rl.close();
    },
  };
  return reader;
}

/**
 * One-shot convenience for a fixed, known-up-front batch of prompts read strictly in
 * order with no async work in between (e.g. `docket restore`'s password + confirmation) —
 * equivalent to createLineReader() + next() per prompt + close(), without the caller
 * needing to manage the reader's lifetime for a single straight-line sequence.
 */
export async function askQuestions(prompts: string[]): Promise<string[]> {
  const reader = createLineReader();
  try {
    const answers: string[] = [];
    for (const prompt of prompts) answers.push(await reader.next(prompt));
    return answers;
  } finally {
    reader.close();
  }
}
