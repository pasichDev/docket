import { randomInt } from "node:crypto";

/**
 * The human-readable code format shared by BOTH pairing flows — device-to-device peering
 * (sync/peering.ts) and device-to-server enrolment (remote/enrolment.ts).
 *
 * It lives on its own because those two are different protocols with different trust
 * models, and the only thing they genuinely share is this alphabet. Before this module,
 * the server-enrolment path imported the entire peer-to-peer sync layer to get at it.
 *
 * No 0/O and no 1/I/L: these codes are read aloud across a room or off a low-resolution
 * screen. 6 characters from this 32-symbol set is ~1.07e9 combinations, which — together
 * with a 5-minute single-use TTL and the per-IP rate limit each flow applies — is what
 * makes brute-forcing impractical. Changing the length or the alphabet changes that
 * argument, so do not treat either as a free knob.
 */
export const CODE_CHARSET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 6;

export function generateShortCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARSET[randomInt(CODE_CHARSET.length)];
  return code;
}
