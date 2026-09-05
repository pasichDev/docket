# Headless deployment

Running `docket serve` on an always-on machine with no display — a Raspberry Pi, an old
mini PC, a NAS, a VPS, a home server — so your todo list keeps working (and stays reachable
from your phone) even when every laptop is off. See [`self-hosting.md`](self-hosting.md)
for the product picture and setup walkthrough; this document is the operational how-to.

Everything here works entirely from a terminal — no GUI step is required.

## Option A: systemd (bare metal / a VM)

1. Install docket and create a dedicated system user:

   ```sh
   sudo useradd --system --home /var/lib/docket --create-home docket
   sudo npm install -g @pasichdev/docket
   which docket   # confirm the path — used in the unit file's ExecStart
   ```

2. Install the unit file (adjust `ExecStart`'s path first if `which docket` printed
   something other than `/usr/local/bin/docket`):

   ```sh
   sudo cp docs/docket.service /etc/systemd/system/docket.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now docket
   sudo journalctl -u docket -f
   ```

3. Pair your first device (run **on the server**, as the `docket` user):

   ```sh
   sudo -u docket DOCKET_DATA_DIR=/var/lib/docket docket devices pair
   ```

   It prints a short-lived pairing code. On the client machine, run
   `docket pair http://<server-host>:8788` (or `https://...` once you've put a reverse
   proxy in front — see below), enter the code, and approve the request the server side
   prints under `docket devices pending` / `docket devices approve <requestId>`.

4. Check it's healthy any time with:

   ```sh
   sudo -u docket DOCKET_DATA_DIR=/var/lib/docket docket status
   ```

**Binding beyond localhost.** By default `docket serve` only listens on `127.0.0.1` (RFC
§9 — binding to all interfaces must be a deliberate choice, never the default). To accept
LAN/remote connections, uncomment `Environment=DOCKET_SERVER_HOST=0.0.0.0` in the unit file
and `sudo systemctl restart docket`.

**HTTPS.** Put a reverse proxy (Caddy, nginx, Traefik, or a Cloudflare Tunnel) in front of
docket for anything reachable outside a trusted LAN — docket itself doesn't terminate TLS.
A minimal Caddy example:

```
todo.home.example {
  reverse_proxy 127.0.0.1:8788
}
```

Note what a proxy does to source addresses: every request it forwards reaches docket from
`127.0.0.1`. Device management is therefore **not** gated on the request looking local — it
requires a secret that `docket serve` writes to `admin-token` in the data directory, mode
0600, which `docket devices …` reads because it runs as the same user on the same machine.
A proxied request cannot obtain it. Do not forward `/api/v1/admin/` through the proxy, and
do not add the token to a proxy configuration.

For trusted-LAN-only development, plain HTTP is allowed but requires an explicit opt-in on
every client — see [`security.md`](security.md#4-self-hosted-clientserver-traffic).

## Option B: Docker / docker-compose

```sh
docker compose up -d
```

That is the whole quickstart — there is no directory to create first. The compose file uses
a **named volume** (`docket-data`) rather than a bind mount, and the reason matters if you
change it: the image runs as an unprivileged `docket` user and owns `/data` at build time. A
bind mount covers that with a host directory, which `mkdir -p data` creates owned by *you*
at 0755, so the container user cannot write to it and docket exits at startup saying it has
no writable data directory. A named volume inherits the image's ownership.

To keep the data somewhere you can browse it, bind-mount **and** hand it to the container's
user first:

```sh
mkdir -p data && sudo chown -R 100:101 data   # the image's docket:docket
# then in docker-compose.yml:  volumes: ["./data:/data"]
```

Already running something on 8788 (a `docket serve` outside Docker, say)? The published host
port is overridable:

```sh
DOCKET_HOST_PORT=18788 docker compose up -d
```

This builds the image locally from this checkout (`build: .` in
[`docker-compose.yml`](../docker-compose.yml)) — no image is published yet, so there's
nothing to pull. The compose file also includes a container healthcheck against
`/api/v1/health`. The `Dockerfile` (repo root) is a multi-stage build targeting
`linux/amd64` and `linux/arm64`.

If you'd rather publish an image once and pull it on multiple machines instead of building
locally on each one:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/pasichdev/docket:latest --push .
```

then change `docker-compose.yml`'s `build: .` to `image: ghcr.io/pasichdev/docket:latest`.

Pairing a device against a Docker-hosted server works the same way as systemd — run
`docket devices pair` **inside the container**:

```sh
docker compose exec docket docket devices pair
```

## `docket status`

Works in both local and remote mode, and is the fastest way to sanity-check a headless
install without a browser:

```text
$ docket status
Mode: remote
Server: https://todo.home.example
Status: connected
Latency: 18 ms
Server version: 2.3.0
Device: andrii-desktop
Device authorization: active
```

Exit code is non-zero whenever something needs attention (unreachable server, revoked
device) — safe to wire into a monitoring script or a cron job.

## Graceful shutdown

`docket serve` handles `SIGTERM`/`SIGINT` directly: it stops accepting new connections,
closes every open SSE stream, and only then exits (see `startServeServer`'s `close()` in
`src/server/server.ts`). systemd's default stop sequence (SIGTERM, then SIGKILL after
`TimeoutStopSec`) and Docker's default `docker stop` both work correctly with no extra
init/tini layer needed to forward the signal.

## Safe upgrades

1. **Read the release notes** for anything that touches the on-disk store format
   (`todos.json.enc`'s `formatVersion` — see `CURRENT_FORMAT_VERSION` in `src/storage.ts`).
   A newer server refuses to read a NEWER format than it understands (fails loud, not
   silently), so upgrading the server before any client that depends on a new feature is
   always safe; the reverse (an old server, new client) is guarded by the protocol
   compatibility check in `GET /api/v1/info` (RFC §23).
2. **Back up first.** On the server machine:
   ```sh
   sudo -u docket DOCKET_DATA_DIR=/var/lib/docket docket backup /var/backups/docket-$(date +%F).backup
   ```
3. **Upgrade and restart:**
   - systemd: `sudo npm install -g @pasichdev/docket@latest && sudo systemctl restart docket`
   - Docker (local build): `git pull && docker compose up -d --build`
     (the named volume survives a rebuild — `docker compose down` alone never touches it;
     only `down -v` removes it)
   - Docker (published image): `docker compose pull && docker compose up -d`
4. **Verify** with `docket status` (exit code 0, `Status: connected`/local health all
   green) before considering the upgrade done. If something looks wrong, `docket restore
   <backup file>` on the server puts the previous state back (see the README's
   [Data & encryption](../README.md#data--encryption) section for what a restore actually
   does — it renames the current files aside rather than deleting them, so a bad restore
   is itself recoverable).

Client-side (`docket pair`-ed) machines never need a coordinated upgrade — a mismatched
protocol version fails loudly and specifically at connection time (RFC §23), rather than
silently misbehaving.
