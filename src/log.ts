import { appendFileSync, chmodSync } from "node:fs";
import { dataPath } from "./data-dir.js";

const LOG_PATH = await dataPath("server.log");

/** Best-effort diagnostic log — synchronous so crash-path writes actually land before exit. */
export function log(line: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(LOG_PATH, 0o600);
  } catch {
    // Never let logging itself take down the server.
  }
}

/** Wire up start/stop/crash logging for a process (call once at entrypoint startup). */
export function installProcessLogging(processName: string): void {
  log(`${processName} started (pid ${process.pid})`);

  process.on("uncaughtException", (err) => {
    const message = `${processName} uncaughtException: ${err.stack ?? err.message}`;
    log(message);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    const message = `${processName} unhandledRejection: ${msg}`;
    log(message);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  process.on("exit", (code) => {
    log(`${processName} exiting (code ${code})`);
  });
}
