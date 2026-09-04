# P2P sync internals (Local Mode)

> **Deprecated as of v3.0.** P2P sync still works in this release and nothing
> has been removed. It is slated for removal, for one honest reason: peers pull
> from each other on a **15-second interval**, so a claim made on one device is
> up to a pull cycle stale everywhere else. That makes claims *advisory* across
> P2P, and this mode therefore cannot deliver the atomic guarantee that
> Self-hosted Mode can. **[Self-hosted Mode](self-hosting.md) is the supported
> multi-machine path.** Migrate with `docket backend use <url>`.

Pair a second computer (say, a desktop) and both keep the same list — useful
if you work from more than one machine, entirely within **Local Mode**. This
is off by default and stays off until you deliberately turn it on: nothing
scans your network, nothing connects to anything, until you open the Devices
panel (the icon in the header) and start a pairing.

## This is a different topology from Self-hosted Mode

P2P sync replicates a full writable copy onto each paired device:

```text
device A ↔ device B
```

A Docket Server instead owns the one authoritative copy that every client
forwards to:

```text
A ─┐
B ─┼→ Docket Server
C ─┘
```

A device connected to a Docket Server does not also run P2P sync with other
peers — see the [README's Deployment modes](../README.md#deployment-modes)
and [`self-hosting.md`](self-hosting.md#what-self-hosted-mode-does-not-do).

## Pairing, step by step

1. On device A, open **Devices → Show my code**. It shows a QR code and a
   6-character code (e.g. `WY6BWK`), valid once, for 5 minutes.
2. On device B, open **Devices → I have a code**, type A's host address and
   the 6-character code (or paste the full line shown under A's QR into
   either field — both work).
3. Device A shows a pending request — *"Pairing request from \<B\>"* — with
   **Approve** / **Deny** buttons. Nothing is shared until a human clicks
   Approve on A. There is no automatic or silent pairing path.
4. Once approved, both devices independently poll each other every 15s and
   merge changes. Unpair either side at any time from the Devices panel to
   revoke it.

## Host and guest

Every device starts out a **host** — it can invite and approve others. The
moment a device joins someone else's group via "I have a code", it becomes a
**guest**: it stays fully in sync, but the Devices panel hides its own "Pair
new device" controls, and the server rejects invite/approve calls even if
something tried to call the API directly. Only the device that originated a
group can grow it — a guest can't quietly become a new entry point into the
network. Unpairing from every peer restores host status.

## How the trust works

Each device generates its own X25519 identity key pair on first run
(`device.json` in Docket's resolved data directory) and never transmits its
private half. Pairing exchanges only the two devices' *public* keys; each
side then independently derives the same shared secret via ECDH + HKDF — the
secret itself never crosses the network in either direction, so capturing
the pairing traffic doesn't give an eavesdropper anything usable. That
secret authenticates every sync request (HMAC-SHA256 over the request, with
a signed timestamp to block replay) and encrypts every sync response
(AES-256-GCM) — sync payloads are not plaintext on the wire. The one-time
pairing token is rate-limited per source IP to make brute-forcing it
impractical.

(Self-hosted mode reuses this same X25519 identity but derives a
domain-separated secret under its own HKDF label, so the two protocols never
share key material — see [`security.md`](security.md#4-self-hosted-clientserver-traffic).)

## How the merge works

Two machines can each go offline and both keep editing. When they reconnect,
changes merge **field by field** — if device A changed the priority and
device B changed the description while apart, both changes survive; neither
clobbers the other. Deletes propagate as tombstones (so a deleted item
doesn't get silently resurrected by the other side's older copy) but an edit
made *after* a delete wins and brings the item back. A claim (`todo_claim`)
syncs like any other field, but its 15-minute lease means a stale claim
fades on its own instead of surviving forever in the replicated history.

This field-by-field automatic merge is specific to P2P sync — a Docket
Server instead uses `If-Match`/`409` optimistic concurrency (a conflicting
write is rejected, not silently merged); see
[`self-hosting.md`](self-hosting.md).
