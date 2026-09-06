/**
 * Docket Crew foundation layer — public surface.
 *
 * The other layers (adapters, MCP, Office/orchestrator) import from here rather than
 * reaching into individual modules, so the foundation can move internals without breaking
 * them. types.js is the frozen contract everything shares.
 */

export * from "./types.js";
export {
  atomicWriteFile,
  assertInsideRoot,
  crewHome,
  crewPaths,
  ensureCrewTree,
  type CrewPaths,
} from "./paths.js";
export { CrewConfigError, defaultConfig, loadConfig, normalizeConfig, renderConfig } from "./config.js";
export {
  detectAllRuntimes,
  detectDocket,
  detectRuntime,
  findOnPath,
  listOpencodeProviders,
  normalizeGitRemote,
  probeCapabilities,
  resolveWorkspace,
  slugifyWorkspace,
  type DetectedRuntime,
  type DocketDetection,
  type WorkspaceResolution,
  type WorkspaceSource,
} from "./discovery.js";
export { freshState, recoverInterruptedRuns, StateStore, type InterruptionReport } from "./state.js";
export { EventBus, type EventListener } from "./events.js";
export {
  listDescendantPids,
  MaxConcurrentRunsError,
  Supervisor,
  type SupervisorOptions,
  type TurnOutcome,
} from "./supervisor.js";
export {
  createCrewServer,
  CREW_VERSION,
  CrewRouter,
  hasSameOriginForMutation,
  hasTrustedHostHeader,
  isLoopbackRequest,
  json,
  SECURITY_HEADERS,
  UI_SESSION_COOKIE,
  type CrewRouteHandler,
  type CrewServer,
  type CrewServerContext,
  type CrewServerOptions,
} from "./server.js";
export { main, registry, type CommandRegistry, type CrewCommand, type CrewCommandContext } from "./cli.js";
