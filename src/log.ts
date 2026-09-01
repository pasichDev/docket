import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_PATH = join(homedir(), ".todo-mcp", "server.log");

/** Best-effort diagnostic log — synchronous so crash-path writes actually land before exit. */
export function log(line: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    // Never let logging itself take down the server.
  }
}

/** Wire up start/stop/crash logging for a process (call once at entrypoint startup). */
export function installProcessLogging(processName: string): void {
  log(`${processName} started (pid ${process.pid})`);

  process.on("uncaughtException", (err) => {
    log(`${processName} uncaughtException: ${err.stack ?? err.message}`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log(`${processName} unhandledRejection: ${msg}`);
    process.exit(1);
  });

  process.on("exit", (code) => {
    log(`${processName} exiting (code ${code})`);
  });
}
