# Contributing to Docket

Docket is a personal open-source project (MIT-licensed), not a company product —
contributions are welcome, but keep expectations proportionate to that: no SLA on
review turnaround, and some proposals will get a "not the direction I want for this"
rather than a merge, which isn't a reflection on the work itself.

## Before opening a PR

For anything beyond a small fix (typo, obviously-wrong error message, a one-line bug
fix with a clear repro), **open an issue first** and describe what you want to change
and why. That avoids spending real effort on something that turns out to conflict with
a design decision already made — see [Non-goals](#design-boundaries-worth-knowing-before-you-start)
below for the most common ones.

## Development setup

```sh
git clone https://github.com/pasichDev/docket.git
cd docket
npm install
npm run build
npm test
```

- `npm run build` — TypeScript compile (`tsc`), must be clean (zero errors) before a PR is reviewed.
- `npm test` — runs `npm run build` then the full `node:test` suite (`dist/*.test.js dist/web/*.test.js dist/server/*.test.js dist/remote/*.test.js`). Same command CI runs; a red `npm test` locally means CI will also be red.
- To run the MCP server itself against your working copy: `claude mcp add docket -- node "$(pwd)/dist/index.js"` (see [README → From source](README.md#from-source)).
- To exercise the Web UI or `docket serve` locally without touching your real `~/.docket`, set `DOCKET_DATA_DIR` to a scratch directory first — every test in this repo already does this (see the `mkdtemp(...)` + `DOCKET_DATA_DIR` pattern at the top of any `*.test.ts` file) and your manual testing should too.

## What a good PR looks like

- **Add tests for new behavior.** This codebase leans heavily on `node:test` (no
  mocking framework) with real encryption/crypto round-trips and real spawned child
  processes for integration-level checks (see `src/mcp-startup.test.ts`,
  `src/server/serve.e2e.test.ts`) rather than mocked ones — match that style rather
  than introducing a new testing approach for one PR.
- **Explain the *why*, not just the *what*, in commit messages and comments.** Code
  comments in this codebase are reserved for non-obvious reasoning (a hidden
  constraint, a subtle invariant, a workaround for a specific bug) — not restating
  what the code visibly does.
- **Don't reformat or refactor unrelated code** in the same PR as a feature/fix — it
  makes the actual change harder to review.
- **Security-relevant changes** (anything touching `src/crypto.ts`, `src/sync.ts`,
  `src/server/auth.ts`, `src/remote/device-auth.ts`, pairing, or authentication) get
  extra scrutiny — see [SECURITY.md](SECURITY.md) if you're reporting a vulnerability
  rather than proposing a change; that's a separate, private channel.

## Design boundaries worth knowing before you start

Some things are deliberately **not** how Docket works, not because nobody's thought of
them:

- **No hosted/cloud version, no accounts, no multi-tenant server.** Self-hosted mode
  (`docket serve`) is meant to run on infrastructure *you* control — see the
  [README's Security section](README.md#security) for why that boundary is explicit
  rather than incidental.
- **Self-hosted mode never silently falls back to local storage** on a connectivity
  failure, and P2P sync and self-hosted mode are not combined on the same device — see
  [README → What Self-hosted Mode does *not* do](README.md#what-self-hosted-mode-doesnt-do).
  A PR that reintroduces either of these (even as a "helpful" fallback) will likely be
  declined — they're the specific failure modes this design exists to avoid.
- **No offline write queue / CRDT merge against the self-hosted server.** That's a
  real, harder distributed-systems problem than it looks; see the design notes this
  project's RFC calls "Hybrid Mode" — an intentionally separate, not-yet-started
  effort, not an oversight.

If you're unsure whether a change fits, ask in the issue before writing code.

## Reporting bugs

Open a [GitHub issue](https://github.com/pasichDev/docket/issues). Useful details:
Docket version (`docket --version` isn't a thing yet — check your installed
`@pasichdev/docket` version), Node version, deployment mode (local vs self-hosted),
and — for anything touching encryption/sync/pairing — enough of a repro that it
doesn't require sharing your actual todo data.

Found a security vulnerability rather than a regular bug? See [SECURITY.md](SECURITY.md)
instead of a public issue.
