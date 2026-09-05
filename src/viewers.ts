import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dataPath } from "./data-dir.js";
import { decryptFromBuffer, encryptToBuffer } from "./crypto.js";
import { withRegistry } from "./registry.js";

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

const VIEWERS_PATH = await dataPath("viewers.json.enc");
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

async function withViewers<T>(fn: (viewers: Viewer[]) => T | Promise<T>): Promise<T> {
  return withRegistry(
    {
      path: VIEWERS_PATH,
      lockPath: LOCK_PATH,
      name: "the viewer list",
      load: loadViewers,
      serialize: (viewers) => encryptToBuffer(JSON.stringify(viewers, null, 2)),
    },
    fn,
  );
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
