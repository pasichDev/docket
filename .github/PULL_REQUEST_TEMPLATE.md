## What does this change?

<!-- One or two sentences. What, and why — not just what the diff shows. -->

## Related issue

<!-- Link the issue this PR addresses, if any. For anything beyond a small fix, an issue
     should already exist — see CONTRIBUTING.md. -->

Closes #

## Checklist

- [ ] `npm run build` passes with zero errors
- [ ] `npm test` passes (this is the same command CI runs)
- [ ] Added/updated tests for the actual behavior change, not just a happy path
- [ ] No unrelated reformatting/refactoring mixed into this diff
- [ ] Touches encryption/pairing/auth (`src/crypto.ts`, `src/sync.ts`, `src/server/auth.ts`,
      `src/remote/device-auth.ts`, or similar)? Called that out explicitly below.
- [ ] README/docs updated if this changes documented behavior (CLI commands, env vars,
      security guarantees)

## Notes for the reviewer

<!-- Anything non-obvious: a tradeoff you made, an alternative you considered and rejected,
     a known gap you're leaving for a follow-up. -->
