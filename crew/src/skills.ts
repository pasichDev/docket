import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { CrewProfile, CrewRole } from "./types.js";

/**
 * The Crew skill system.
 *
 * Behaviour for an agent turn comes from SKILL.md files, not from code. Until this module
 * existed that meant exactly three hardcoded files resolved by role, and `CrewProfile.skills`
 * — which config.ts has always parsed — was dead config nothing read. This makes skills a
 * real system: data, discovered from several roots, composed per profile.
 *
 * ## The format we implement
 *
 * We deliberately implement the *ecosystem* format rather than inventing one, because the
 * whole value of a skill is that it is portable:
 *
 *   - Anthropic's Agent Skills spec — a folder per skill containing `SKILL.md`, which opens
 *     with YAML frontmatter. The portable field set is `name`, `description`, `allowed-tools`,
 *     `license`, `compatibility`, `metadata`; anything else is a host-specific extension.
 *     (https://code.claude.com/docs/en/skills)
 *   - The cross-agent `~/.agents/skills/<name>/SKILL.md` convention, which Codex CLI and the
 *     rest of the AGENTS.md ecosystem read, and which this repo's own `src/setup.ts` already
 *     installs the `docket` skill into. Same file format, different root.
 *     (https://learn.chatgpt.com/docs/build-skills)
 *
 * Both agree on the two things that matter here: the *directory name* is the skill's
 * identity, and only `name`/`description` are truly required.
 *
 * ## Progressive disclosure, and why Crew only gets half of it
 *
 * Upstream hosts load a skill in levels: descriptions always, the body when the model picks
 * the skill, bundled files on demand. Crew has no picker — a crew agent is *assigned* its
 * role and starts working — so Crew loads the body eagerly for the skills a profile declares
 * and never loads bundled sibling files at all. That is a real cost difference: this block is
 * re-sent on every wake, so the budget below is a body budget, not a listing budget. Bundled
 * `scripts/` and `references/` alongside a SKILL.md are left on disk for the agent to open
 * with its own file tools, which is exactly what upstream's level 3 does.
 */

export const SKILL_FILE = "SKILL.md";

/**
 * A skill body is injected into *every* turn prompt for the agents that declare it, so it is
 * paid for on every wake — unlike an editor host, where a skill is loaded once when the model
 * reaches for it. Claude Code's own compaction budget keeps the first ~5,000 tokens of each
 * skill and ~25,000 tokens combined; Codex caps its skill listing at 2% of the context window
 * or 8,000 characters. We sit deliberately below both, because a crew skill set is a *role
 * definition* that should be short enough to stay in the model's head, and because a runaway
 * set costs real money silently. These are defaults, not laws — `composeSkills` takes an
 * override.
 */
export const DEFAULT_PER_SKILL_CHAR_BUDGET = 12_000;
export const DEFAULT_TOTAL_CHAR_BUDGET = 40_000;

/**
 * A cap on what we will even read off disk. Skill roots are user-writable directories that
 * may contain anything; without this, one pathological file turns discovery into an OOM.
 */
export const MAX_SKILL_FILE_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Roots and precedence
// ---------------------------------------------------------------------------

/**
 * Where a skill came from. The order of these is the precedence order, lowest first.
 *
 * `bundled` — the skills shipped inside the Crew package (`crew/skills/`).
 * `agents`  — `~/.agents/skills`, the cross-agent convention shared with Codex et al.
 * `crewHome`— `<crew home>/skills`, i.e. `~/.docket/crew/skills`. Crew-specific user skills.
 * `extra`   — explicitly declared by the operator (env var today, config key later).
 */
export type SkillRootKind = "bundled" | "agents" | "crewHome" | "extra";

export interface SkillRoot {
  kind: SkillRootKind;
  dir: string;
  /** Higher wins. Set from `kind` unless a caller overrides it. */
  precedence: number;
}

const ROOT_PRECEDENCE: Record<SkillRootKind, number> = {
  bundled: 10,
  agents: 20,
  crewHome: 30,
  extra: 40,
};

/**
 * Precedence: **more specific overrides more general, and the vendor default loses.**
 *
 * A later (higher-precedence) root replaces a same-named skill from an earlier one wholesale
 * — there is no merging of two SKILL.md files, which would produce a document neither author
 * wrote. The shadowed file is remembered on `ResolvedSkill.shadows` so `doctor` can show it.
 *
 * This matches Codex, which scans repository → user → admin → system and lets the most
 * specific win, and it matches what Crew already did before this module existed: `runtime.ts`
 * passes `~/.docket/crew/skills` as the first candidate and falls back to the packaged
 * `crew/skills` only if nothing is there.
 *
 * It is the *opposite* of Claude Code's enterprise > personal > project ordering, and that is
 * intentional. There, the top of the chain is a managed policy an administrator imposes and a
 * user must not be able to shrug off. Crew has no enterprise tier and no policy to enforce:
 * its bundled skills are defaults, and a user who writes `~/.agents/skills/crew-worker` is
 * customising, not attacking. Making the shipped file unoverridable would mean forking the
 * package to change a sentence.
 */
export function skillRoot(kind: SkillRootKind, dir: string, precedence?: number): SkillRoot {
  return { kind, dir: resolve(dir), precedence: precedence ?? ROOT_PRECEDENCE[kind] };
}

export interface DefaultRootsOptions {
  /** Overrides the packaged `crew/skills` location (tests, and unusual install layouts). */
  bundledDir?: string;
  /** Overrides `~/.agents/skills`. */
  agentsDir?: string;
  /** `<crew home>/skills`. Pass `crewPaths(...).root` joined with "skills". */
  crewHomeDir?: string;
  /** Extra roots, highest precedence, in ascending order of importance. */
  extraDirs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to `os.homedir()`. */
  home?: string;
}

/**
 * `DOCKET_CREW_SKILLS_DIR` — path-separator-delimited extra roots.
 *
 * This exists because `CrewProfile`/`CrewConfig` in types.ts are frozen and have nowhere to
 * declare a root. An env var needs no type change and works today; the config key is reported
 * as a follow-up rather than smuggled in.
 */
export const SKILLS_DIR_ENV = "DOCKET_CREW_SKILLS_DIR";

export function defaultSkillRoots(options: DefaultRootsOptions = {}): SkillRoot[] {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const roots: SkillRoot[] = [];

  const bundled = options.bundledDir ?? packagedSkillsDir();
  if (bundled) roots.push(skillRoot("bundled", bundled));

  roots.push(skillRoot("agents", options.agentsDir ?? join(home, ".agents", "skills")));

  if (options.crewHomeDir) roots.push(skillRoot("crewHome", options.crewHomeDir));

  const declared = [
    ...(options.extraDirs ?? []),
    ...splitPathList(env[SKILLS_DIR_ENV]),
  ];
  // Ascending importance: the last one declared should win, so give it the highest number.
  declared.forEach((dir, index) => {
    if (dir.trim()) roots.push(skillRoot("extra", dir.trim(), ROOT_PRECEDENCE.extra + index));
  });

  return roots;
}

function splitPathList(value: string | undefined): string[] {
  if (!value) return [];
  // Accept both separators: `:` is what a POSIX user will type, `;` is Windows' PATH
  // separator, and a Windows drive letter (`C:\...`) makes a naive `:` split wrong.
  const separator = value.includes(";") ? ";" : ":";
  return value
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The packaged `skills/` directory, found relative to this module. `src/skills.ts` and
 * `dist/skills.js` both sit one level under the package root, but a bundler or a nested
 * `dist/` layout can add a level, so both are tried — the same fallback chain the
 * orchestrator used before this module existed.
 */
function packagedSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "skills");
}

/** Every candidate location for the packaged skills, in order. Exported for `doctor`. */
export function packagedSkillsCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(join(here, "..", "skills")), resolve(join(here, "..", "..", "skills"))];
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** The portable frontmatter field set, plus everything else kept verbatim. */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** `allowed-tools`, normalised to a list whether it was written as a list or a string. */
  allowedTools?: string[];
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  /** Every key we do not model, unmodified — host extensions like `effort` or `hidden`. */
  extra: Record<string, unknown>;
}

export interface ParsedSkillDocument {
  frontmatter: SkillFrontmatter;
  /** The document with its frontmatter removed and sanitised for use as a prompt. */
  body: string;
  /** True when a `---` block was present at the top, whether or not it parsed. */
  hadFrontmatter: boolean;
  /** Set when a `---` block was present but was not usable YAML mapping. */
  frontmatterError?: string;
}

/**
 * A `---` fence at the very start, its contents, and the closing fence. The body is whatever
 * follows.
 *
 * Matching is done on already-sanitised text (see `sanitiseSkillText`) so a BOM or CRLF
 * cannot make the anchor miss — a miss is not cosmetic here, see `stripSkillFrontmatter`.
 */
const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/;

/**
 * Normalise text before anything looks at it.
 *
 * - **BOM** — a UTF-8 BOM ahead of the `---` makes a `^---` anchor fail, which silently
 *   leaks YAML metadata into an agent's prompt.
 * - **CRLF** — a skill authored on Windows otherwise fails the same anchor.
 * - **NUL and C0 controls** — this string is eventually passed as an argv element to a CLI.
 *   Node throws `ERR_INVALID_ARG_VALUE` on a NUL in an argument, so a single stray byte in a
 *   skill file would take down every turn for every agent that loaded it.
 */
export function sanitiseSkillText(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/**
 * Frontmatter is metadata for a skill loader, not content for a turn prompt — and stripping
 * it is load-bearing beyond tidiness.
 *
 * A prompt that begins with `---` is parsed as a flag by the `claude` CLI's argv parser
 * (`error: unknown option '---'`), which broke every turn in production until the frontmatter
 * was stripped at injection. `adapters/claude.ts` keeps its own guard for this; this function
 * is the layer that stops the problem existing. The parse is deliberately tolerant: even
 * frontmatter that is *not* valid YAML gets stripped, because leaving a malformed block in
 * place would reintroduce exactly that bug.
 */
export function stripSkillFrontmatter(text: string): string {
  return parseSkillDocument(text).body;
}

export function parseSkillDocument(text: string): ParsedSkillDocument {
  const clean = sanitiseSkillText(text);
  const match = FRONTMATTER_RE.exec(clean);
  if (!match) {
    return { frontmatter: { extra: {} }, body: clean.trim(), hadFrontmatter: false };
  }

  // Trimmed at both ends: leading whitespace is what would put a stray `-` or a blank line at
  // the head of a prompt, and a trailing newline would double up against the separator that
  // `composeSkills` joins bodies with.
  const body = clean.slice(match[0].length).trim();
  const raw = match[1] ?? "";

  let parsed: unknown;
  try {
    // `yaml` is already a dependency of this package (config.yml, spec §31). Reaching for it
    // here adds nothing to install and is strictly more correct than a hand-rolled
    // `key: value` split: real skills in the wild use block scalars (`description: >`),
    // quoted strings containing colons, and nested `metadata:` maps, all of which a naive
    // splitter mangles into wrong metadata. crew/package.json is not edited by this change.
    parsed = raw.trim() ? parseYaml(raw) : {};
  } catch (error) {
    return {
      frontmatter: { extra: {} },
      body,
      hadFrontmatter: true,
      frontmatterError: (error as Error).message,
    };
  }

  if (parsed === null || parsed === undefined) {
    return { frontmatter: { extra: {} }, body, hadFrontmatter: true };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      frontmatter: { extra: {} },
      body,
      hadFrontmatter: true,
      frontmatterError: "frontmatter must be a YAML mapping",
    };
  }

  return { frontmatter: toFrontmatter(parsed as Record<string, unknown>), body, hadFrontmatter: true };
}

function toFrontmatter(raw: Record<string, unknown>): SkillFrontmatter {
  const known = new Set(["name", "description", "allowed-tools", "license", "compatibility", "metadata"]);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!known.has(key)) extra[key] = value;

  const frontmatter: SkillFrontmatter = { extra };
  if (typeof raw.name === "string" && raw.name.trim()) frontmatter.name = raw.name.trim();
  if (typeof raw.description === "string" && raw.description.trim()) {
    // Descriptions are frequently authored as multi-line block scalars; they are shown on one
    // line by every consumer, so collapse the whitespace once here.
    frontmatter.description = raw.description.trim().replace(/\s+/g, " ");
  }
  const tools = raw["allowed-tools"];
  if (typeof tools === "string" && tools.trim()) frontmatter.allowedTools = tools.trim().split(/\s+/);
  else if (Array.isArray(tools)) {
    const list = tools.filter((t): t is string => typeof t === "string" && Boolean(t.trim())).map((t) => t.trim());
    if (list.length) frontmatter.allowedTools = list;
  }
  if (typeof raw.license === "string" && raw.license.trim()) frontmatter.license = raw.license.trim();
  if (typeof raw.compatibility === "string" && raw.compatibility.trim()) frontmatter.compatibility = raw.compatibility.trim();
  if (raw.metadata !== null && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)) {
    frontmatter.metadata = raw.metadata as Record<string, unknown>;
  }
  return frontmatter;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type SkillDiagnosticCode =
  | "skill-not-found"
  | "budget-exceeded"
  | "skill-too-large"
  | "unreadable"
  | "bad-frontmatter"
  | "name-mismatch"
  | "empty-body";

export interface SkillDiagnostic {
  severity: "error" | "warning";
  code: SkillDiagnosticCode;
  /** The skill this is about, when it is about one. */
  skill?: string;
  path?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface ResolvedSkill {
  /**
   * The skill's identity: its *directory* name, lowercased. Both upstream conventions treat
   * the directory as the id — a frontmatter `name` that disagrees is the author's mistake,
   * not a rename, so it is reported rather than honoured (see `declaredName`).
   */
  name: string;
  /** The frontmatter `name`, only when it differs from the directory name. */
  declaredName?: string;
  description?: string;
  /** Absolute path to the SKILL.md. */
  path: string;
  root: SkillRoot;
  /** Frontmatter-stripped, sanitised body — what actually goes into a prompt. */
  body: string;
  frontmatter: SkillFrontmatter;
  /** `body.length`. The unit the budget is denominated in. */
  chars: number;
  /** Paths of same-named skills at lower precedence that this one replaced. */
  shadows: string[];
}

export interface SkillCatalog {
  /** Keyed by lowercased skill name. */
  byName: Map<string, ResolvedSkill>;
  /** Every winning skill, sorted by name. Stable — safe to render directly. */
  all: ResolvedSkill[];
  roots: SkillRoot[];
  /** Roots that did not exist or could not be listed. Not an error; most users have none. */
  missingRoots: string[];
  diagnostics: SkillDiagnostic[];
}

/**
 * Scan every root and build the catalog. Roots are visited in ascending precedence so a
 * later root simply overwrites an earlier entry.
 *
 * Nothing here throws for bad input. A skill root is a user-writable directory that will
 * contain lock files, junk, dangling symlinks and half-written files; discovery that dies on
 * any of them would take the daemon down over a stray byte. Everything unusable becomes a
 * diagnostic and is skipped.
 */
export async function discoverSkills(roots: readonly SkillRoot[]): Promise<SkillCatalog> {
  const ordered = [...roots].sort((a, b) => a.precedence - b.precedence);
  const byName = new Map<string, ResolvedSkill>();
  const diagnostics: SkillDiagnostic[] = [];
  const missingRoots: string[] = [];

  for (const root of ordered) {
    let entries: Dirent[];
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      missingRoots.push(root.dir);
      continue;
    }

    for (const entry of entries) {
      const name = entry.name;
      // `.skill-lock.json` and friends live next to the skills in a real ~/.agents/skills.
      if (name.startsWith(".")) continue;
      // `withFileTypes` reports a symlink as a symlink, not as what it points at, and both
      // conventions explicitly support symlinked skill folders — so probe rather than filter.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const file = join(root.dir, name, SKILL_FILE);
      const loaded = await loadSkillFile(file, name, root);
      if (!loaded) continue;
      diagnostics.push(...loaded.diagnostics);
      if (!loaded.skill) continue;

      const key = loaded.skill.name;
      const previous = byName.get(key);
      if (previous) loaded.skill.shadows = [...previous.shadows, previous.path];
      byName.set(key, loaded.skill);
    }
  }

  const all = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { byName, all, roots: ordered, missingRoots, diagnostics };
}

interface LoadResult {
  skill?: ResolvedSkill;
  diagnostics: SkillDiagnostic[];
}

/** Returns `null` when there is simply no SKILL.md here — a plain directory, not a problem. */
async function loadSkillFile(file: string, dirName: string, root: SkillRoot): Promise<LoadResult | null> {
  const name = dirName.toLowerCase();
  const diagnostics: SkillDiagnostic[] = [];

  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null;
  }

  if (size > MAX_SKILL_FILE_BYTES) {
    return {
      diagnostics: [
        {
          severity: "error",
          code: "skill-too-large",
          skill: name,
          path: file,
          message:
            `skill "${name}" is ${size} bytes, over the ${MAX_SKILL_FILE_BYTES}-byte read limit, ` +
            `and was not loaded. A SKILL.md is meant to be instructions; move bulk content into ` +
            `sibling files the agent can open on demand.`,
        },
      ],
    };
  }

  let text: string;
  try {
    // Read as a buffer and decode: `toString("utf8")` substitutes U+FFFD for invalid
    // sequences rather than throwing, so a file of arbitrary bytes degrades to mojibake
    // instead of taking discovery with it.
    const buffer = await readFile(file);
    text = buffer.toString("utf8");
  } catch (error) {
    return {
      diagnostics: [
        {
          severity: "error",
          code: "unreadable",
          skill: name,
          path: file,
          message: `skill "${name}" could not be read from ${file}: ${(error as Error).message}`,
        },
      ],
    };
  }

  const parsed = parseSkillDocument(text);
  if (parsed.frontmatterError) {
    diagnostics.push({
      severity: "warning",
      code: "bad-frontmatter",
      skill: name,
      path: file,
      message:
        `skill "${name}" has unparseable frontmatter (${parsed.frontmatterError}); its metadata ` +
        `was ignored. The body is still used — the block was stripped, not injected.`,
    });
  }
  if (parsed.frontmatter.name && parsed.frontmatter.name.toLowerCase() !== name) {
    diagnostics.push({
      severity: "warning",
      code: "name-mismatch",
      skill: name,
      path: file,
      message:
        `skill directory "${dirName}" declares name "${parsed.frontmatter.name}" in its ` +
        `frontmatter. The directory name is the id everywhere it is referenced; reference it ` +
        `as "${name}".`,
    });
  }
  if (!parsed.body.trim()) {
    diagnostics.push({
      severity: "warning",
      code: "empty-body",
      skill: name,
      path: file,
      message: `skill "${name}" (${file}) has no body below its frontmatter — it will inject nothing.`,
    });
  }

  const skill: ResolvedSkill = {
    name,
    path: resolve(file),
    root,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
    chars: parsed.body.length,
    shadows: [],
  };
  if (parsed.frontmatter.name && parsed.frontmatter.name.toLowerCase() !== name) {
    skill.declaredName = parsed.frontmatter.name;
  }
  if (parsed.frontmatter.description) skill.description = parsed.frontmatter.description;

  return { skill, diagnostics };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * The skills a profile should get, in injection order.
 *
 * The role skill (`crew-<role>`) is always first and always present: it is what makes the
 * agent a manager rather than a worker, and an agent silently losing it because someone added
 * one extra skill to a profile would be a very expensive surprise. `profile.skills` is then
 * appended in declared order. Duplicates collapse to their first position, so the order is a
 * pure function of the inputs and does not depend on filesystem or map iteration order.
 */
export function skillNamesForProfile(profile: Pick<CrewProfile, "role" | "skills">): string[] {
  return dedupeNames([roleSkillName(profile.role), ...(profile.skills ?? [])]);
}

export function roleSkillName(role: CrewRole): string {
  return `crew-${role}`;
}

function dedupeNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export interface ComposeOptions {
  perSkillCharBudget?: number;
  totalCharBudget?: number;
}

export interface ComposedSkills {
  /** The injectable block. Empty string when nothing resolved. */
  text: string;
  /** Skills that made it in, in injection order. */
  included: ResolvedSkill[];
  /** Requested names that did not make it, and why. */
  omitted: { name: string; reason: "not-found" | "over-budget" | "too-large" }[];
  /** `text.length` before the notice is added. */
  chars: number;
  diagnostics: SkillDiagnostic[];
  /** True when any diagnostic is an error — the caller should surface this, loudly. */
  hasErrors: boolean;
}

/** Sections are joined with the same rule the orchestrator uses between prompt sections. */
const SECTION_SEPARATOR = "\n\n---\n\n";

/**
 * Resolve names against the catalog and concatenate the bodies.
 *
 * Two rules that shaped this:
 *
 * **A missing skill is loud.** A profile naming a skill that does not exist is a typo in the
 * user's config, and a typo that silently injects nothing produces an agent that behaves
 * subtly wrong for reasons nobody can see. It does not throw — that would take every turn
 * down over one bad line and leave the human no working agent to tell — but it emits an error
 * diagnostic *and* writes a visible notice into the block, so both the human (via `doctor` /
 * the Office) and the agent itself know the instruction set is incomplete.
 *
 * **The budget is enforced by exclusion, never by truncation.** Cutting a skill body at
 * character N produces a document that ends mid-sentence and reads, to the model, like the
 * complete instructions — the failure mode is an agent confidently following half a rule.
 * Skills are therefore taken whole, in order, until the next one will not fit; the rest are
 * dropped and named.
 */
export function composeSkills(
  catalog: SkillCatalog,
  names: readonly string[],
  options: ComposeOptions = {},
): ComposedSkills {
  const perSkill = options.perSkillCharBudget ?? DEFAULT_PER_SKILL_CHAR_BUDGET;
  const total = options.totalCharBudget ?? DEFAULT_TOTAL_CHAR_BUDGET;

  const included: ResolvedSkill[] = [];
  const omitted: ComposedSkills["omitted"] = [];
  const diagnostics: SkillDiagnostic[] = [];
  let used = 0;

  for (const name of dedupeNames(names)) {
    const skill = catalog.byName.get(name);
    if (!skill) {
      omitted.push({ name, reason: "not-found" });
      diagnostics.push({
        severity: "error",
        code: "skill-not-found",
        skill: name,
        message:
          `skill "${name}" is not installed — nothing was injected for it. Looked in: ` +
          `${catalog.roots.map((r) => r.dir).join(", ") || "(no roots)"}. ` +
          `Check the spelling in the profile's \`skills:\` list, or add ` +
          `<root>/${name}/${SKILL_FILE}.`,
      });
      continue;
    }

    if (skill.chars > perSkill) {
      omitted.push({ name, reason: "too-large" });
      diagnostics.push({
        severity: "error",
        code: "skill-too-large",
        skill: name,
        path: skill.path,
        message:
          `skill "${name}" is ${skill.chars} characters, over the ${perSkill}-character ` +
          `per-skill budget, and was left out rather than cut in half. Shorten ${skill.path}, ` +
          `or move the detail into sibling files the agent can open when it needs them.`,
      });
      continue;
    }

    const cost = skill.chars + (included.length ? SECTION_SEPARATOR.length : 0);
    if (used + cost > total) {
      omitted.push({ name, reason: "over-budget" });
      diagnostics.push({
        severity: "error",
        code: "budget-exceeded",
        skill: name,
        path: skill.path,
        message:
          `skill "${name}" (${skill.chars} chars) did not fit the ${total}-character total ` +
          `budget for one turn — ${used} were already used by ${included.map((s) => s.name).join(", ")}. ` +
          `This block is re-sent on every wake, so trim the profile's \`skills:\` list rather ` +
          `than raising the budget by reflex.`,
      });
      continue;
    }

    used += cost;
    included.push(skill);
  }

  let text = included.map((s) => s.body).join(SECTION_SEPARATOR);
  const chars = text.length;

  if (omitted.length) {
    // The agent, not just the human, needs to know: an agent operating on a partial rule set
    // that believes it is complete is the whole hazard. This is a short notice, appended so
    // it cannot displace the leading `#` heading of the first skill.
    const detail = omitted.map((o) => `${o.name} (${o.reason})`).join(", ");
    const notice =
      `> **crew: ${omitted.length} skill(s) requested for this agent were not loaded: ${detail}.** ` +
      `Your instructions may be incomplete. Do not guess at the missing rules — say so in your ` +
      `report so the human can fix the profile.`;
    text = text ? `${text}${SECTION_SEPARATOR}${notice}` : notice;
  }

  return {
    // Defence in depth for the `claude` CLI argv bug: a body could legitimately begin with a
    // Markdown horizontal rule or a list item, which is indistinguishable from a flag. The
    // adapter guards this too; guaranteeing it at the source costs one branch.
    text: text.startsWith("-") ? `\n${text}` : text,
    included,
    omitted,
    chars,
    diagnostics,
    hasErrors: diagnostics.some((d) => d.severity === "error"),
  };
}

// ---------------------------------------------------------------------------
// The one call the orchestrator needs
// ---------------------------------------------------------------------------

export interface ResolveOptions extends DefaultRootsOptions, ComposeOptions {
  /** Pre-built roots. When given, `DefaultRootsOptions` is ignored. */
  roots?: readonly SkillRoot[];
  /** Reuse a catalog instead of re-scanning. */
  catalog?: SkillCatalog;
}

export interface ResolvedProfileSkills extends ComposedSkills {
  catalog: SkillCatalog;
  requested: string[];
}

/**
 * Roots → catalog → compose, for one profile. This is the whole system in one call, and the
 * only one `orchestrator.ts` needs.
 */
export async function resolveSkillsForProfile(
  profile: Pick<CrewProfile, "role" | "skills">,
  options: ResolveOptions = {},
): Promise<ResolvedProfileSkills> {
  const catalog = options.catalog ?? (await discoverSkills(options.roots ?? defaultSkillRoots(options)));
  const requested = skillNamesForProfile(profile);
  const composed = composeSkills(catalog, requested, options);
  return {
    ...composed,
    // Discovery problems (an unreadable file, a bad frontmatter block) belong in the same
    // list the caller reports, not in a second one it has to remember to look at.
    diagnostics: [...catalog.diagnostics.filter((d) => !d.skill || requested.includes(d.skill)), ...composed.diagnostics],
    hasErrors:
      composed.hasErrors ||
      catalog.diagnostics.some((d) => d.severity === "error" && d.skill !== undefined && requested.includes(d.skill)),
    catalog,
    requested,
  };
}

// ---------------------------------------------------------------------------
// Discoverability
// ---------------------------------------------------------------------------

export interface SkillListing {
  name: string;
  description: string;
  source: string;
  root: SkillRootKind;
  chars: number;
  /** Same-named files this one overrode. Empty for almost every skill. */
  shadowed: string[];
}

/**
 * A flat, renderable view of what is actually installed — for `doctor` and the Office, so a
 * human can see what an agent got rather than inferring it from the fact that it misbehaved.
 * Plain data, no formatting: the caller decides whether it is a table or JSON.
 */
export function listSkills(catalog: SkillCatalog): SkillListing[] {
  return catalog.all.map((skill) => ({
    name: skill.name,
    description: skill.description ?? "(no description)",
    source: skill.path,
    root: skill.root.kind,
    chars: skill.chars,
    shadowed: skill.shadows,
  }));
}
