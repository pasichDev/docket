import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { atomicWriteFile, type CrewPaths } from "./paths.js";
import { DEFAULT_TURN_IDLE_TIMEOUT_MS } from "./supervisor.js";
import type { CrewConfig, CrewProfile, CrewRole, RuntimeId } from "./types.js";

/**
 * config.yml — profiles + automation limits (spec §10/§24).
 *
 * First run writes the default file below so the user has something concrete to edit, then
 * every load validates rather than trusts: an unknown runtime id or a manager pointing at a
 * profile that doesn't exist is a config error surfaced at startup, not a crash mid-run.
 */

const RUNTIME_IDS: readonly RuntimeId[] = ["claude", "codex", "opencode"];
const ROLES: readonly CrewRole[] = ["manager", "worker", "reviewer"];

export class CrewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrewConfigError";
  }
}

/**
 * The shipped default team. Model ids are real, not invented:
 * `openrouter/~google/gemini-flash-latest` was verified against `opencode models` and is the
 * exact model the probe in docs/RUNTIME-CONTRACTS.md ran real work through.
 */
export function defaultConfig(): CrewConfig {
  return {
    manager: { profile: "manager-claude" },
    profiles: {
      "manager-claude": { name: "manager-claude", runtime: "claude", role: "manager" },
      "coder-codex": { name: "coder-codex", runtime: "codex", role: "worker" },
      "coder-openrouter": {
        name: "coder-openrouter",
        runtime: "opencode",
        role: "worker",
        provider: "openrouter",
        model: "openrouter/~google/gemini-flash-latest",
      },
      "reviewer-claude": { name: "reviewer-claude", runtime: "claude", role: "reviewer" },
    },
    automation: {
      managerAutoWake: true,
      maxAutonomousTurns: 10,
      maxAgents: 4,
      maxConcurrentRuns: 3,
      maxRetries: 1,
      // Ten minutes of COMPLETE SILENCE from a runtime, not a cap on how long a turn may take.
      // See DEFAULT_TURN_IDLE_TIMEOUT_MS in supervisor.ts for why it is this and not a wall clock.
      turnIdleTimeoutMs: DEFAULT_TURN_IDLE_TIMEOUT_MS,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProfile(name: string, raw: unknown): CrewProfile {
  if (!isRecord(raw)) throw new CrewConfigError(`profile "${name}" must be a mapping`);
  const runtime = raw.runtime;
  if (typeof runtime !== "string" || !RUNTIME_IDS.includes(runtime as RuntimeId)) {
    throw new CrewConfigError(`profile "${name}": runtime must be one of ${RUNTIME_IDS.join("/")}, got ${JSON.stringify(runtime)}`);
  }
  const role = raw.role;
  if (typeof role !== "string" || !ROLES.includes(role as CrewRole)) {
    throw new CrewConfigError(`profile "${name}": role must be one of ${ROLES.join("/")}, got ${JSON.stringify(role)}`);
  }
  const profile: CrewProfile = { name, runtime: runtime as RuntimeId, role: role as CrewRole };
  if (typeof raw.model === "string" && raw.model.trim()) profile.model = raw.model.trim();
  if (typeof raw.provider === "string" && raw.provider.trim()) profile.provider = raw.provider.trim();
  if (Array.isArray(raw.skills)) profile.skills = raw.skills.filter((s): s is string => typeof s === "string");
  return profile;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * Untyped YAML → CrewConfig. Missing sections fall back to the defaults (a user deleting
 * `automation:` gets the shipped limits, not a crash); structurally wrong values throw.
 */
export function normalizeConfig(raw: unknown): CrewConfig {
  const defaults = defaultConfig();
  if (raw === null || raw === undefined) return defaults;
  if (!isRecord(raw)) throw new CrewConfigError("config.yml root must be a mapping");

  const profiles: Record<string, CrewProfile> = {};
  if (raw.profiles !== undefined) {
    if (!isRecord(raw.profiles)) throw new CrewConfigError("profiles must be a mapping of name -> profile");
    for (const [name, value] of Object.entries(raw.profiles)) profiles[name] = parseProfile(name, value);
  }
  const effectiveProfiles = Object.keys(profiles).length > 0 ? profiles : defaults.profiles;

  let managerProfile = defaults.manager.profile;
  if (raw.manager !== undefined) {
    if (!isRecord(raw.manager) || typeof raw.manager.profile !== "string") {
      throw new CrewConfigError('manager must be a mapping with a "profile" key');
    }
    managerProfile = raw.manager.profile;
  }
  const manager = effectiveProfiles[managerProfile];
  if (!manager) throw new CrewConfigError(`manager.profile "${managerProfile}" is not a defined profile`);
  if (manager.role !== "manager") throw new CrewConfigError(`manager.profile "${managerProfile}" must have role "manager", has "${manager.role}"`);

  const auto = isRecord(raw.automation) ? raw.automation : {};
  return {
    manager: { profile: managerProfile },
    profiles: effectiveProfiles,
    automation: {
      managerAutoWake: typeof auto.managerAutoWake === "boolean" ? auto.managerAutoWake : defaults.automation.managerAutoWake,
      maxAutonomousTurns: numberOr(auto.maxAutonomousTurns, defaults.automation.maxAutonomousTurns),
      maxAgents: numberOr(auto.maxAgents, defaults.automation.maxAgents),
      maxConcurrentRuns: numberOr(auto.maxConcurrentRuns, defaults.automation.maxConcurrentRuns),
      maxRetries: numberOr(auto.maxRetries, defaults.automation.maxRetries),
      // 0 is a legitimate value here — it turns the watchdog off — so numberOr's `>= 0` is right.
      turnIdleTimeoutMs: numberOr(auto.turnIdleTimeoutMs, defaults.automation.turnIdleTimeoutMs ?? 0),
    },
  };
}

const CONFIG_HEADER = `# Docket Crew configuration.
# profiles: named agent templates (runtime: claude | codex | opencode).
# manager.profile must name a profile with role: manager.
# Model/provider strings are passed to the runtime as-is — see crew/docs/RUNTIME-CONTRACTS.md.
`;

export function renderConfig(config: CrewConfig): string {
  return CONFIG_HEADER + stringify(config);
}

/**
 * Load config.yml, writing the default file first when it doesn't exist. A file that exists
 * but doesn't parse or validate throws — silently substituting defaults over a typo'd config
 * would run the wrong models with the wrong limits and look like it was on purpose.
 */
export async function loadConfig(paths: CrewPaths): Promise<CrewConfig> {
  let text: string;
  try {
    text = await readFile(paths.configFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const config = defaultConfig();
    await atomicWriteFile(paths.configFile, renderConfig(config));
    return config;
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new CrewConfigError(`config.yml is not valid YAML: ${(err as Error).message}`);
  }
  return normalizeConfig(raw);
}
