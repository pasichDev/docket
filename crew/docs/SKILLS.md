# Crew skills

Agent behaviour in Crew comes from `SKILL.md` files, not from code. This document describes
the skill *system* — where skills come from, which one wins, how a profile composes several,
and what happens when something is wrong.

Implementation: `crew/src/skills.ts`. Tests: `crew/src/skills.test.ts`.

---

## The format

Crew implements the existing ecosystem format rather than a Crew-specific one. A skill is a
**directory** containing a **`SKILL.md`** that opens with YAML frontmatter:

```
crew-worker/
├── SKILL.md          # required: frontmatter + instructions
├── reference.md      # optional: detail the agent opens on demand
└── scripts/          # optional: executables the agent may run
```

The optional siblings are part of the format Crew accepts, not something it ships — the three
bundled skills are a bare `SKILL.md` each.

```yaml
---
name: crew-worker
description: How to execute exactly one Docket Crew assignment — claim the Docket task, do the work in your isolated worktree, report honestly, and stop.
---

# You are a crew worker
...
```

### Frontmatter fields

The portable set, parsed into structured metadata by `parseSkillDocument`:

| Field | Meaning |
|---|---|
| `name` | Display name. **Not the id** — see below. |
| `description` | What it does and when it applies. Front-load the trigger. |
| `allowed-tools` | Tools the skill needs. Accepted as a list or a space-separated string. |
| `license` | License covering the skill. |
| `compatibility` | Environment requirements. |
| `metadata` | Free-form map for custom tooling. |

Any other key (`effort`, `hidden`, `disable-model-invocation`, …) is a host-specific
extension. Crew keeps it verbatim on `frontmatter.extra` and ignores it — a skill written for
Claude Code or Codex loads here unchanged instead of erroring.

**The directory name is the skill's id**, lowercased, in both upstream conventions. A
frontmatter `name` that disagrees is reported as a `name-mismatch` warning rather than
honoured, because honouring it would make a skill unreferenceable by the name the user can
actually see on disk.

### Sources

- Anthropic Agent Skills — <https://code.claude.com/docs/en/skills>
- Codex / cross-agent skills — <https://learn.chatgpt.com/docs/build-skills>

---

## Where skills come from

Four roots, listed **lowest precedence first**:

| Kind | Location | Purpose |
|---|---|---|
| `bundled` | `crew/skills/` inside the package | The shipped role skills. Defaults. |
| `agents` | `~/.agents/skills/` | The cross-agent convention, shared with Codex and the rest of the AGENTS.md ecosystem. This repo's own `src/setup.ts` installs the `docket` skill here. Explicitly **not** `~/.codex/skills`, which does not exist. |
| `crewHome` | `~/.docket/crew/skills/` | Crew-specific user skills, inside the Crew state tree. |
| `extra` | `DOCKET_CREW_SKILLS_DIR` (`:` or `;` separated), or roots passed programmatically | Operator-declared. Later entries outrank earlier ones. |

Only `bundled` and `agents` are defaults of `defaultSkillRoots()` itself. `crewHome` is added by
the **caller**: the daemon passes `<crew home>/skills` (`runtime.ts` → `OrchestratorDeps.skillsDir`),
which is why it is standard in practice but absent for any other embedder of `Orchestrator`.

Roots that do not exist are not an error — most users have no `~/.agents/skills` — they are
reported on `catalog.missingRoots`.

### Precedence: most specific wins, and the vendor default loses

A higher-precedence root **replaces** a same-named skill wholesale. There is no merging of two
`SKILL.md` files; merging would produce a document neither author wrote. The file that lost is
recorded on `ResolvedSkill.shadows`, and `docket-crew doctor` prints it — that is how a user
finds out why the file they edited had no effect.

This matches Codex (repository → user → admin → system, most specific first). Note there is no
"first candidate / fall back" search: **every** root is scanned on every discovery pass, and
precedence decides which same-named file wins.

It is the **opposite** of Claude Code's `enterprise > personal > project` ordering, and that is
deliberate. There, the top of the chain is a managed policy an administrator imposes and a user
must not be able to shrug off. Crew has no enterprise tier and no policy to enforce: its bundled
skills are *defaults*, and a user who writes `~/.agents/skills/crew-worker/SKILL.md` is
customising, not attacking. Making the shipped file unoverridable would mean forking the
package to change a sentence.

---

## How a profile composes skills

```yaml
profiles:
  coder-codex:
    runtime: codex
    role: worker
    skills: [house-style, docket]
```

The injection order is:

1. **The role skill (`crew-<role>`) — always first, always present.** It is what makes the
   agent a manager rather than a worker. An agent silently losing it because someone added one
   unrelated skill to a profile would be a very expensive surprise, so `skills:` *adds to* the
   role skill rather than replacing it. To get different base behaviour, choose a different
   `role`.
2. **`profile.skills` in declared order.**

Duplicates collapse to their first position, case-insensitively. The result is a pure function
of the profile — it never depends on filesystem or map iteration order, so two runs of the same
config produce byte-identical prompts.

Bodies are joined with `\n\n---\n\n`, the same separator the orchestrator already uses between
prompt sections. A single skill therefore composes byte-identically to the old
strip-and-inject behaviour.

---

## The budget

| Limit | Default | Why |
|---|---|---|
| Per skill | 12,000 chars | |
| Whole set | 40,000 chars | |
| Max file read | 1 MiB | A skill root is a user-writable directory; without a cap one pathological file turns discovery into an OOM. |

This block is injected into **every turn's prompt** for every agent that declares it, so it is
paid for on every wake — unlike an editor host, where a skill is loaded once when the model
reaches for it. For scale: Claude Code's compaction budget keeps the first ~5,000 tokens of
each skill and ~25,000 combined; Codex caps its skill *listing* at 2% of the context window or
8,000 characters. Crew sits below both on purpose, because a crew skill set is a role
definition that should stay short enough to hold in the model's head.

For reference, the three shipped skills measure 6,686 (`crew-manager`) / 5,399 (`crew-worker`) /
2,986 (`crew-reviewer`) characters of body — but no agent gets all three. One agent carries its
own role skill plus whatever its profile adds, so the shipped baseline is 2,986–6,686 characters,
7–17% of the 40,000 total. `docket-crew doctor` prints the resolved set per profile.

### Enforcement is by exclusion, never by truncation

Cutting a body at character N produces a document that ends mid-sentence and reads, to the
model, like *complete* instructions. The failure mode is an agent confidently following half a
rule. So skills are taken **whole**, in order, until the next one will not fit; the rest are
dropped and named.

Both limits are overridable per call via `ComposeOptions`, but raising the total by reflex is
the wrong move — trim the profile's `skills:` list instead.

---

## When something is wrong

Every problem becomes a structured `SkillDiagnostic` (`severity`, `code`, `skill`, `path`,
`message`). Nothing in discovery throws: a skill root will contain lock files, junk, dangling
symlinks and half-written files, and discovery that died on any of them would take the daemon
down over a stray byte.

| Code | Severity | Meaning |
|---|---|---|
| `skill-not-found` | error | A profile named a skill that is not installed. |
| `budget-exceeded` | error | Did not fit the total budget; dropped. |
| `skill-too-large` | error | Over the per-skill budget or the file read limit. |
| `unreadable` | error | The file exists but could not be read. |
| `bad-frontmatter` | warning | The `---` block was not a YAML mapping. Metadata ignored, **body still used**. |
| `name-mismatch` | warning | Frontmatter `name` ≠ directory name. |
| `empty-body` | warning | Nothing below the frontmatter; injects nothing. |

### A missing skill is loud

A profile naming a skill that does not exist is a typo in the user's config, and a typo that
silently injects nothing produces an agent that behaves subtly wrong for reasons nobody can
see.

It does **not** throw — that would take every turn down over one bad line and leave the human
with no working agent to tell about it. Instead:

- an **error diagnostic** naming the skill and every root that was searched, for `doctor` and
  the Office; and
- a **visible notice appended to the injected block**, so the agent itself knows its rule set
  is incomplete and can say so in its report rather than guessing at the missing rules.

`composed.hasErrors` is the one boolean a caller needs to decide whether to surface anything.

---

## Two landmines this system defuses

**A prompt beginning with `-` is parsed as a flag by the `claude` CLI** (`error: unknown option
'---'`). This broke *every turn* in production until frontmatter was stripped at injection. The
defences, in order:

1. `sanitiseSkillText` strips a UTF-8 BOM and normalises CRLF **before** the `^---` anchor
   runs, so neither can make the anchor miss and leak YAML into the prompt.
2. Frontmatter is stripped **even when it fails to parse** — leaving a malformed block in place
   would put `---` right back at the head of the prompt.
3. `composeSkills` prepends a newline if the final block still starts with `-` (a body may
   legitimately open with a Markdown horizontal rule or a list item).
4. `adapters/claude.ts` keeps its own guard. Defence in depth; none of these layers is
   load-bearing alone.

**A NUL byte in a skill file kills every turn.** The composed text is eventually passed as an
argv element to a CLI, and Node throws `ERR_INVALID_ARG_VALUE` on a NUL in an argument — so one
stray byte in one skill file would take down every agent that loaded it. `sanitiseSkillText`
removes NUL and the other C0 controls (keeping `\t` and `\n`). Files are read as buffers and
decoded with `toString("utf8")`, which substitutes U+FFFD for invalid sequences rather than
throwing, so arbitrary bytes degrade to mojibake instead of an exception.

---

## Public API

```ts
// Roots
skillRoot(kind, dir, precedence?)          → SkillRoot
defaultSkillRoots(options?)                → SkillRoot[]
packagedSkillsCandidates()                 → string[]

// Parsing
sanitiseSkillText(text)                    → string
parseSkillDocument(text)                   → ParsedSkillDocument
stripSkillFrontmatter(text)                → string     // hardened stripFrontmatter

// Discovery
discoverSkills(roots)                      → Promise<SkillCatalog>
listSkills(catalog)                        → SkillListing[]   // for doctor / the Office

// Composition
roleSkillName(role)                        → string
skillNamesForProfile(profile)              → string[]
composeSkills(catalog, names, options?)    → ComposedSkills

// Everything at once — the only call the orchestrator needs
resolveSkillsForProfile(profile, options?) → Promise<ResolvedProfileSkills>
```

### Dependencies

None added. `parseSkillDocument` uses `yaml`, which is **already** a dependency of
`crew/package.json` for `config.yml` (spec §31). Reaching for it costs nothing at install time
and is strictly more correct than a hand-rolled `key: value` split: real skills in the wild use
block scalars (`description: >`), quoted strings containing colons, and nested `metadata:`
maps, all of which a naive splitter mangles into wrong metadata. `crew/package.json` was not
edited.

---

## Conventions deliberately *not* adopted

- **Dynamic shell injection** (`` !`git diff` `` in a SKILL.md body). Claude Code executes
  these before sending the skill. Crew resolves skills inside a long-lived daemon that
  supervises agents, so a skill file dropped into `~/.agents/skills` would become arbitrary
  code execution in the daemon on every wake. Bodies are treated as inert text.
- **`${CLAUDE_SKILL_DIR}` / `$ARGUMENTS` substitution.** Crew has no argument surface for a
  skill — an agent is assigned a role, not invoked with parameters. Leaving the tokens
  untouched means a skill authored for Claude Code still reads correctly there.
- **Model-facing description listing / progressive disclosure level 1.** Upstream shows every
  skill's description to the model so it can *pick* one. A crew agent does not pick; its
  profile decides. Shipping a listing would be pure context cost for a choice the model does
  not get to make. Descriptions are surfaced to *humans* by `docket-crew doctor`.
- **Frontmatter-`name` as the id.** Both upstream hosts key on the directory; only plugin
  skills use the frontmatter name, and only to build a namespaced command. Crew has no command
  surface, so the directory is the id, full stop.
- **`allowed-tools` enforcement.** Crew parses and exposes it, but does not gate tools on it —
  tool availability is the runtime adapter's business (`runtime.ts` → `buildMcpServerSpecs`),
  and quietly reinterpreting a declaration as a permission grant would be a security claim the
  code cannot back up.

---

## Follow-ups requiring frozen files

`crew/src/types.ts` is frozen, so these are recorded rather than done:

1. **`CrewConfig.skillRoots?: string[]`** — a config key for extra roots. Today the only
   declarative path is the `DOCKET_CREW_SKILLS_DIR` env var, which is invisible in
   `config.yml`. Needs a `types.ts` field plus a `config.ts` parse.
2. **`CrewProfile.skillBudget?: { perSkill?: number; total?: number }`** — per-profile budget
   override. `ComposeOptions` already supports it; there is nowhere to declare it.
