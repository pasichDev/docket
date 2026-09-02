# Security Policy

Docket handles todo data, device identities, and (in self-hosted mode) authentication
secrets. If you find a real vulnerability, please report it privately rather than as a
public issue — see below.

## Reporting a vulnerability

**Preferred: [GitHub Security Advisories](https://github.com/pasichDev/docket/security/advisories/new)**
("Report a vulnerability" on this repo). This reaches the maintainer privately and lets
us coordinate a fix and a disclosure timeline before any details are public.

Please include:

- What component is affected (local storage encryption, P2P sync/pairing, the Web UI's
  LAN Viewer Gate, or self-hosted server auth — see the
  [README's Security section](README.md#security) for how these four threat models are
  scoped separately)
- Steps to reproduce, or a minimal proof of concept
- What you'd expect to happen vs. what actually happens
- Your assessment of impact, if you have one

You should get an acknowledgment within a few days. This is a personal open-source
project, not a company with a formal SLA — response time depends on maintainer
availability, but security reports get priority over regular issues.

## Scope

In scope:

- The `@pasichdev/docket` npm package and this repository's source
- The local encryption scheme (`src/crypto.ts`), P2P pairing/sync (`src/sync.ts`,
  `src/device.ts`), the Web UI's LAN Viewer Gate and CSRF/DNS-rebinding defenses
  (`src/web/server.ts`), and self-hosted server authentication
  (`src/server/auth.ts`, `src/remote/device-auth.ts`)
- The release/publish pipeline (`.github/workflows/release.yml`) and its npm
  provenance attestation

Out of scope / already-documented, non-surprising behavior — please read the
[README's Security section](README.md#security) first, since these are **deliberate,
disclosed** design boundaries, not vulnerabilities:

- A self-hosted Docket Server is not end-to-end encrypted against its own operator —
  it holds the authoritative plaintext workspace while running. This is explicit.
- The local Web UI's LAN viewer traffic is plain HTTP, not TLS — mitigated by requiring
  explicit host-approval before any LAN browser gets access, not by encryption. Also
  explicit.
- A compromised device (local or self-hosted) can do whatever that device's own
  legitimate access already permitted, until revoked.

If you're not sure whether something is a genuine vulnerability or one of the
documented boundaries above, report it anyway — a clarifying "this is the documented
tradeoff described here: ..." reply is a fine outcome.

## Supported versions

Only the latest published version on npm receives security fixes — there's no LTS
branch. `docket check-update` / `docket update` (see the
[README's Updating section](README.md#updating)) is the supported way to stay current;
every release is published with [Sigstore provenance](README.md#updating), verifiable
with `npm audit signatures`.
