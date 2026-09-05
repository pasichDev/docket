import { pendingRequestActions, refreshDevicesPanel } from "./devices.js";
import { byId, el } from "./dom.js";
import { refresh } from "./list.js";
import { showToast } from "./modals.js";

/**
 * The controls inside the devices modal: its tabs, the peer rows, incoming pairing and
 * access requests, and redeeming a code from another device.
 *
 * Separate from devices.ts, which renders those panels — this is what happens when someone
 * clicks them.
 */

/** The poll that watches for the other device to approve. */
let outgoingPollTimer: number | null = null;

/**
 * An address with no port is the commonest way a pairing attempt fails, and the failure is
 * opaque: the browser turns "192.168.1.42" into http://192.168.1.42, which is port 80,
 * which nothing is listening on — so the server answers 502 "couldn't reach that device"
 * and the reason is nowhere on screen. Nobody runs docket on port 80; an address typed
 * without one means "the docket on that machine".
 */
const DEFAULT_PEER_PORT = "8787";

function peerUrlFrom(host: string): string {
  const raw = /^https?:\/\//.test(host) ? host : `http://${host}`;
  try {
    const parsed = new URL(raw);
    // URL.port is "" both when absent and when it is the protocol default, which is why
    // this only fills in for http: an https peer on 443 is a deliberate setup, not an omission.
    if (!parsed.port && parsed.protocol === "http:") parsed.port = DEFAULT_PEER_PORT;
    return parsed.origin;
  } catch {
    return raw; // let the server report what is wrong with it
  }
}

function sasLine(sas: string | null | undefined): string {
  return sas ? `Verify code: ${sas.slice(0, 3)} ${sas.slice(3)} — must match on both screens` : "";
}


/** Every listener this module owns. Called once, from main.ts — never at import time. */
export function initPairingUi(): void {
  byId("import-file-btn").addEventListener("click", () => {
    byId("import-file-input").click();
  });
  byId<HTMLInputElement>("import-file-input").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const statusEl = byId("import-status");
    statusEl.textContent = "Importing…";
    try {
      const text = await file.text();
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, filename: file.name }),
      });
      const data = (await res.json()) as { error?: string; added?: number };
      if (!res.ok) throw new Error(data.error || "Import failed");
      statusEl.textContent = `Imported ${data.added} items!`;
      void refresh();
    } catch (err) {
      statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    input.value = "";
  });

  document.querySelectorAll<HTMLElement>(".modal-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll<HTMLElement>(".modal-tab").forEach((b) => (b.dataset.active = String(b === btn)));
      document
        .querySelectorAll<HTMLElement>(".modal-pane")
        .forEach((p) => (p.hidden = p.dataset.modalTab !== btn.dataset.modalTab));
    });
  });

  document.querySelectorAll<HTMLElement>(".pair-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll<HTMLElement>(".pair-tab").forEach((b) => (b.dataset.active = String(b === btn)));
      document.querySelectorAll<HTMLElement>(".devices-pair-pane").forEach((p) => (p.hidden = p.dataset.tab !== btn.dataset.tab));
    });
  });

  byId("devices-list").addEventListener("click", async (e) => {
    const btn = e.target;
    if (!(btn instanceof HTMLButtonElement)) return;
    const id = btn.dataset.id;
    if (btn.matches(".unpair")) {
      btn.disabled = true;
      await fetch(`/api/peers/${id}`, { method: "DELETE" });
      void refreshDevicesPanel();
      return;
    }
    if (btn.matches(".peer-revoke")) {
      const action = btn.dataset.action; // "revoke" or "restore"
      btn.disabled = true;
      await fetch(`/api/peers/${id}/${action}`, { method: "POST" });
      void refreshDevicesPanel();
      return;
    }
    if (btn.matches(".peer-update-address")) {
      const name = btn.dataset.name;
      const newUrl = prompt(`New address for ${name} (e.g. http://192.168.1.42:8787) — its identity will be re-verified before this device trusts it:`);
      if (!newUrl) return;
      btn.disabled = true;
      btn.textContent = "Verifying…";
      try {
        const res = await fetch(`/api/peers/${id}/address`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: newUrl }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) alert(data.error || "Couldn't update the address.");
      } catch {
        alert("Couldn't reach that address.");
      }
      void refreshDevicesPanel();
    }
  });

  async function handleIncomingAction(e: Event, kind: "pair" | "access"): Promise<void> {
    const btn = e.target;
    if (!(btn instanceof HTMLElement)) return;
    const id = btn.dataset.id;
    if (!id || pendingRequestActions.has(id)) return; // already mid-flight — ignore a second click
    const action = btn.matches(".approve") ? "approve" : btn.matches(".deny") ? "deny" : null;
    if (!action) return;
    pendingRequestActions.set(id, action);
    // Toggle the existing buttons directly rather than re-rendering the row from its own
    // .textContent — the name/meta text came from another device over the network, and
    // round-tripping it back through innerHTML without re-escaping would be a stored-XSS
    // hole. incomingRowHtml() (used by refreshDevicesPanel) is the only place that builds
    // this markup from scratch, always straight from freshly-escaped server JSON.
    const row = btn.closest<HTMLElement>(".incoming-row");
    const approve = row?.querySelector<HTMLButtonElement>(".approve");
    const deny = row?.querySelector<HTMLButtonElement>(".deny");
    if (approve && deny) {
      approve.disabled = true;
      deny.disabled = true;
      (action === "approve" ? approve : deny).textContent = action === "approve" ? "Approving…" : "Denying…";
    }
    try {
      await fetch(`/api/${kind}/${action}/${id}`, { method: "POST" });
    } finally {
      pendingRequestActions.delete(id);
    }
    void refreshDevicesPanel();
  }

  byId("devices-incoming").addEventListener("click", (e) => void handleIncomingAction(e, "pair"));
  byId("access-incoming").addEventListener("click", (e) => void handleIncomingAction(e, "access"));

  byId("access-viewers-list").addEventListener("click", async (e) => {
    const btn = e.target;
    if (!(btn instanceof HTMLButtonElement) || !btn.matches(".unpair")) return;
    btn.disabled = true;
    await fetch(`/api/access/viewers/${btn.dataset.id}`, { method: "DELETE" });
    void refreshDevicesPanel();
  });

  byId("pair-redeem-btn").addEventListener("click", async () => {
    const hostInput = byId<HTMLInputElement>("pair-host-input");
    const codeInput = byId<HTMLInputElement>("pair-code-input");
    const status = byId("pair-status-text");
    let host = hostInput.value.trim();
    let token = codeInput.value.trim().toUpperCase();
    let publicKeyX: string | null = null;
    // Someone pasting the full "host?pair=CODE&pk=..." line into the host field still works —
    // pk is what lets this device verify the host's identity out-of-band (see generateInvite).
    if (host.includes("?pair=")) {
      const [h, rest] = host.split("?pair=");
      host = h.trim();
      const params = new URLSearchParams(rest.includes("&") ? rest.slice(rest.indexOf("&")) : "");
      const c = rest.split("&")[0];
      if (!token) token = c.trim().toUpperCase();
      publicKeyX = params.get("pk");
    }
    if (!host || !token) {
      status.textContent = "Enter both the host address and the code.";
      return;
    }
    const peerUrl = peerUrlFrom(host);
    status.textContent = "Connecting…";
    try {
      const res = await fetch("/api/pair/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerUrl, token, publicKeyX: publicKeyX || undefined }),
      });
      const body = (await res.json()) as { error?: string; requestId?: string; sas?: string };
      if (!res.ok) {
        status.textContent = body.error || "Couldn't connect.";
        return;
      }
      status.textContent = `Waiting for approval on the other device… ${sasLine(body.sas)}`;
      if (outgoingPollTimer !== null) clearInterval(outgoingPollTimer);
      let attempts = 0;
      outgoingPollTimer = window.setInterval(async () => {
        attempts += 1;
        if (attempts > 90) {
          if (outgoingPollTimer !== null) clearInterval(outgoingPollTimer);
          status.textContent = "Timed out waiting for approval.";
          return;
        }
        const s = (await (await fetch(`/api/pair/outgoing/${body.requestId}`)).json()) as { status?: string; deviceName?: string; sas?: string };
        if (s.status === "confirmed") {
          if (outgoingPollTimer !== null) clearInterval(outgoingPollTimer);
          status.textContent = `Paired with ${s.deviceName}!`;
          hostInput.value = "";
          codeInput.value = "";
          void refreshDevicesPanel();
        } else if (s.status === "denied") {
          if (outgoingPollTimer !== null) clearInterval(outgoingPollTimer);
          status.textContent = "The other device declined the request.";
        } else {
          status.textContent = `Waiting for approval on the other device… ${sasLine(s.sas || body.sas)}`;
        }
      }, 2000);
    } catch {
      status.textContent = "Couldn't reach that device.";
    }
  });
}
