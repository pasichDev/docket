import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { decryptFromBuffer, encryptToBuffer } from "./crypto.js";
import { withFileLock } from "./filelock.js";

/**
 * A browser that was explicitly approved (by the host clicking Approve on an
 * access request) to view and edit this device's list over the LAN, without
 * being a full sync-pairing partner. Only `tokenHash` — a sha256 of the bearer
 * cookie value — is ever stored; the raw token lives only in the approving
 * browser's one-time poll response and the viewer's own cookie jar.
 */
export interface Viewer {
  id: string;
  tokenHash: string;
  label: string;
  approvedAt: string;
  lastSeenAt: string | null;
}

const VIEWERS_PATH = join(homedir(), ".todo-mcp", "viewers.json.enc");
const LOCK_PATH = `${VIEWERS_PATH}.lock`;

export async function loadViewers(): Promise<Viewer[]> {
  try {
    const encrypted = await readFile(VIEWERS_PATH);
    const json = await decryptFromBuffer(encrypted);
    return JSON.parse(json) as Viewer[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function saveViewers(viewers: Viewer[]): Promise<void> {
  await mkdir(dirname(VIEWERS_PATH), { recursive: true });
  const tmpPath = `${VIEWERS_PATH}.${randomUUID()}.tmp`;
  const encrypted = await encryptToBuffer(JSON.stringify(viewers, null, 2));
  await writeFile(tmpPath, encrypted, { mode: 0o600 });
  await rename(tmpPath, VIEWERS_PATH);
}

async function withViewers<T>(fn: (viewers: Viewer[]) => T | Promise<T>): Promise<T> {
  return withFileLock(LOCK_PATH, async () => {
    const viewers = await loadViewers();
    const result = await fn(viewers);
    await saveViewers(viewers);
    return result;
  });
}

export async function addViewer(viewer: Viewer): Promise<void> {
  await withViewers((viewers) => {
    viewers.push(viewer);
  });
}

export async function removeViewer(id: string): Promise<boolean> {
  return withViewers((viewers) => {
    const index = viewers.findIndex((v) => v.id === id);
    if (index === -1) return false;
    viewers.splice(index, 1);
    return true;
  });
}

export async function touchViewer(id: string): Promise<void> {
  await withViewers((viewers) => {
    const v = viewers.find((v) => v.id === id);
    if (v) v.lastSeenAt = new Date().toISOString();
  });
}
