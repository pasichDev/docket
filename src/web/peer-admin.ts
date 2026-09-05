import { loadPeers, removePeer } from "../peers.js";
import { setDeviceRole } from "../device.js";
import { log } from "../log.js";
import type { ApiContext } from "./http.js";

/**
 * Unpairing has a side effect on this device's own role, which is why it is not just a call
 * to removePeer: a guest that has just left its last group is nobody's guest any more, and
 * leaving it in that state would keep it deferring to a host it no longer has.
 *
 * Shared by the peers route and by web/server.ts's own unpair path.
 */

export async function removePeerAndMaybeRevertRole(id: string, ctx: ApiContext): Promise<boolean> {
  const ok = await removePeer(id);
  if (ok && ctx.deviceRole === "guest" && (await loadPeers()).length === 0) {
    ctx.setDeviceRoleState("host");
    await setDeviceRole("host");
    log("pairing: this device left its last group and is a host again");
  }
  return ok;
}
