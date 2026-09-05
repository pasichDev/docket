import {
  getDeviceInfo,
  listAccessRequests,
  listNotifications,
  listPairingRequests,
  listPeers,
  listPresence,
  listSessions,
  listViewers,
  postJson,
  type AccessRequest,
  type InviteResponse,
  type NotificationEvent,
  type PairingRequest,
  type PeerRow,
  type PresenceRow,
  type SessionRow,
  type ViewerRow,
} from "./api.js";
import { byId } from "./dom.js";
import { render } from "./list.js";
import { state } from "./state.js";
import { escapeHtml, timeAgo } from "./util.js";

/**
 * The devices modal: pairing with another device, approving what arrives, and the browser
 * access requests that share its UI.
 */


let devicesLoaded = false;
let devicesPollTimer: ReturnType<typeof setInterval> | null = null;
const seenRequestIds = new Set<string>();
// requestId -> "approve" | "deny" while that action's fetch is in flight — the periodic
// poll (every 4s while the modal is open) rebuilds these rows from scratch, and approve
// in particular can take a few seconds (network round-trip to the other device), so
// without this a poll landing mid-request would revert the row to its normal buttons
// and make the click look like it did nothing.
export const pendingRequestActions = new Map<string, "approve" | "deny">();

export async function loadDeviceInfo(): Promise<void> {
  try {
    const d = await getDeviceInfo();
    state.isHostBrowser = !!d.isHostBrowser;
    if (state.thisDeviceId !== d.id) {
      state.thisDeviceId = d.id;
      render(state.allTodos); // "Other devices" counted/filtered against thisDeviceId, unknown until now
    }
    byId("this-device-name").textContent = d.name + (d.role === "guest" ? " (guest)" : "");
    const canManage = d.role !== "guest" && d.isHostBrowser;
    byId("devices-pair-section").hidden = !canManage;
    const noteEl = byId("guest-note");
    noteEl.hidden = canManage;
    if (!canManage) {
      noteEl.innerHTML =
        d.role === "guest"
          ? `This device joined an existing group via someone else's invite, so it's a
             <strong>guest</strong> — it stays in sync, but only the device that invited
             it can invite or approve further devices. Unpair to leave and become a
             host again.`
          : "Only this device's own browser can manage pairing and approve new connections.";
    }
    byId("devices-requests").hidden = !state.isHostBrowser;
    if (canManage && !devicesLoaded) {
      devicesLoaded = true;
      generateInvite();
    }
  } catch {
    byId("this-device-name").textContent = "unknown";
  }
}

/**
 * Background poll (host browser only) for pairing + viewer-access requests. Updates the
 * badge on the Devices icon, and pops the modal open the moment a request this browser
 * hasn't seen yet shows up — closing it again without acting doesn't re-trigger the popup
 * for the same request.
 */
export async function pollNotifications(): Promise<void> {
  if (!state.isHostBrowser) {
    byId("notif-badge").hidden = true;
    return;
  }
  try {
    const [pairing, access] = await Promise.all([
      fetch("/api/pair/incoming").then((r) => r.json()),
      fetch("/api/access/pending").then((r) => r.json()),
    ]);
    const requests = [...(pairing.requests ?? []), ...(access.requests ?? [])];
    const notifBadge = byId("notif-badge");
    notifBadge.hidden = requests.length === 0;
    notifBadge.textContent = String(requests.length);

    const hasUnseen = requests.some((r) => !seenRequestIds.has(r.requestId));
    for (const r of requests) seenRequestIds.add(r.requestId);
    if (hasUnseen && !byId<HTMLDialogElement>("devices-panel").open) openDevicesModal();
  } catch {
    // quiet — background nicety, not core functionality
  }
}

// Approve in particular involves a real network round-trip to the requesting device
// (up to a few seconds) — render its busy state (both buttons disabled, the clicked
// one relabeled) whenever this id is mid-flight, so a periodic poll landing during
// that window doesn't revert it to plain "Approve"/"Deny" and make the click look
// like it did nothing.
function incomingRowHtml(id: string, name: string, meta: string, sas?: string): string {
  const action = pendingRequestActions.get(id);
  const approveLabel = action === "approve" ? "Approving…" : "Approve";
  const denyLabel = action === "deny" ? "Denying…" : "Deny";
  const disabled = action ? "disabled" : "";
  // sas: only pairing requests carry this — a code derived from both devices' public keys,
  // shown so the human can compare it against what the OTHER device's screen shows before
  // approving. A mismatch means someone tampered with the exchange (active MITM).
  const sasLineHtml = sas
    ? `<span class="meta sas-verify">Verify code: <strong>${sas.slice(0, 3)} ${sas.slice(3)}</strong> — must match on the other device</span>`
    : "";
  return `
    <div class="incoming-row" data-id="${id}">
      <span>
        <span class="name">${name}</span>
        <span class="meta">${meta}</span>
        ${sasLineHtml}
      </span>
      <button class="approve" data-id="${id}" type="button" ${disabled}>${approveLabel}</button>
      <button class="deny" data-id="${id}" type="button" ${disabled}>${denyLabel}</button>
    </div>`;
}

export async function refreshDevicesPanel(): Promise<void> {
  try {
    const { peers } = await listPeers();
    const listEl = byId("devices-list");
    const TRUST_LABELS: Record<string, string> = { trusted: "Trusted", verified: "Verified", pending: "Pending", revoked: "Revoked" };
    listEl.innerHTML = peers
      .map((p: PeerRow) => {
        const skew = typeof p.clockSkewMs === "number" ? `${p.clockSkewMs >= 0 ? "+" : ""}${Math.round(p.clockSkewMs / 1000)}s skew` : null;
        const chips = [
          p.fingerprint ? `fp ${escapeHtml(p.fingerprint)}` : null,
          typeof p.protocolVersion === "number" ? `protocol v${p.protocolVersion}` : null,
          skew,
        ].filter(Boolean);
        return `
        <div class="device-row" data-id="${p.id}">
          <span class="dot ${p.trustState === "trusted" ? "ok" : "fail"}"></span>
          <span class="name">${escapeHtml(p.name)}</span>
          <span class="row-badge sync">Sync</span>
          <span class="row-badge trust-${p.trustState}">${TRUST_LABELS[p.trustState] || p.trustState}</span>
          <span class="meta">synced ${timeAgo(p.lastSyncAt)}</span>
          <button class="peer-revoke" data-id="${p.id}" data-action="${p.revoked ? "restore" : "revoke"}" type="button">${p.revoked ? "Restore" : "Revoke"}</button>
          <button class="unpair" data-id="${p.id}" type="button">Unpair</button>
          <div class="device-row-details">
            ${chips.map((c) => `<span>${c}</span>`).join("")}
            ${p.lastError ? `<span class="err">${escapeHtml(p.lastError)}</span>` : ""}
            <button class="peer-update-address" data-id="${p.id}" data-name="${escapeHtml(p.name)}" type="button">Update address…</button>
          </div>
        </div>`;
      })
      .join("");
  } catch (err) {
    console.error("devices refresh failed", err);
  }

  try {
    const { viewers } = await listViewers();
    const viewersEl = byId("access-viewers-list");
    viewersEl.innerHTML = viewers
      .map(
        (v: ViewerRow) => `
        <div class="device-row" data-id="${v.id}">
          <span class="dot ok"></span>
          <span class="name">${escapeHtml(v.label)}</span>
          <span class="row-badge viewer">Viewer</span>
          <span class="meta">seen ${timeAgo(v.lastSeenAt)}</span>
          <button class="unpair viewer-revoke" data-id="${v.id}" type="button">Revoke</button>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error("access refresh failed", err);
  }

  const connectedCount = byId("devices-list").children.length + byId("access-viewers-list").children.length;
  if (connectedCount === 0) {
    byId("devices-list").innerHTML = '<div class="phone-panel-hint">Nothing connected yet.</div>';
  }
  const devicesTabBadge = byId("devices-tab-badge");
  devicesTabBadge.hidden = connectedCount === 0;
  devicesTabBadge.textContent = String(connectedCount);

  try {
    const { presence } = await listPresence();
    const presenceEl = byId("presence-list");
    const presenceHeading = byId("presence-heading");
    presenceHeading.hidden = presence.length === 0;
    presenceEl.innerHTML = presence
      .map(
        (p: PresenceRow) => `
        <div class="presence-row">
          <span class="dot ${p.active ? "active" : "idle"}"></span>
          <span class="who">${escapeHtml(p.identity)}</span>
          <span>${p.active ? "active" : `idle ${timeAgo(p.lastActiveAt)}`}</span>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error("presence refresh failed", err);
  }

  // Live sessions sit ABOVE recent activity on purpose: "which terminal is open in this
  // project" is actionable right now, where "what did codex last touch" is history.
  try {
    const { sessions } = await listSessions();
    const sessionsEl = byId("sessions-list");
    byId("sessions-heading").hidden = sessions.length === 0;
    sessionsEl.innerHTML = sessions
      .map(
        (s: SessionRow) => `
        <div class="presence-row">
          <span class="dot ${Date.now() - Date.parse(s.lastSeenAt) < 60000 ? "active" : "idle"}"></span>
          <span class="who">${escapeHtml(s.agent || "unknown")}</span>
          <span>${escapeHtml(s.workspace || "unfiled")} · ${escapeHtml(timeAgo(s.lastSeenAt))}</span>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error("sessions refresh failed", err);
  }

  if (state.isHostBrowser) {
    try {
      const { requests: pairingRequests } = await listPairingRequests();
      const incomingEl = byId("devices-incoming");
      incomingEl.hidden = pairingRequests.length === 0;
      incomingEl.innerHTML = pairingRequests
        .map(
          (r: PairingRequest) => incomingRowHtml(r.requestId, `Pairing request from ${escapeHtml(r.deviceName)}`, "wants to share this list with this device", r.sas)
        )
        .join("");

      const { requests: accessRequests } = await listAccessRequests();
      const accessIncomingEl = byId("access-incoming");
      accessIncomingEl.hidden = accessRequests.length === 0;
      accessIncomingEl.innerHTML = accessRequests
        .map(
          (r: AccessRequest) => incomingRowHtml(r.requestId, `Access request from ${escapeHtml(r.ip)}`, "wants to view/edit this list in a browser")
        )
        .join("");

      // Resolved/expired history — the still-"pending" ones above already have their own cards.
      const { events } = await listNotifications();
      const past = events.filter((e) => e.status !== "pending");
      const logEl = byId("activity-log");
      logEl.hidden = past.length === 0;
      logEl.innerHTML = past
        .map(
          (e: NotificationEvent) => `
        <div class="activity-row">
          <span class="status ${e.status}">${e.status}</span>
          <span class="label">${e.kind === "pairing" ? "Pairing" : "Access"} request from ${escapeHtml(e.label)}</span>
          <span class="when">${timeAgo(new Date(e.resolvedAt ?? e.createdAt).toISOString())}</span>
        </div>`
        )
        .join("");
    } catch (err) {
      console.error("requests refresh failed", err);
    }
  }
}

export async function generateInvite(): Promise<void> {
  const textarea = byId<HTMLTextAreaElement>("pair-invite-text");
  const shortCode = byId("pair-short-code");
  const img = byId<HTMLImageElement>("pair-qr");
  const loading = byId("pair-qr-loading");
  textarea.value = "Generating…";
  shortCode.textContent = "······";
  img.hidden = true;
  loading.style.display = "grid";
  try {
    const invite = await postJson<InviteResponse>("/api/pair/invite");
    if (invite.error) {
      textarea.value = invite.error;
      loading.style.display = "none";
      return;
    }
    // pk carries this device's real public key through the SAME out-of-band channel as the
    // code (QR / pasted line) — the other device anchors trust in it before any network call,
    // so an active LAN attacker can't just swap in their own key mid-exchange unnoticed.
    const code = `${invite.url}?pair=${invite.token}&pk=${encodeURIComponent(invite.publicKeyX)}`;
    textarea.value = code;
    shortCode.textContent = invite.token;
    img.onload = () => {
      loading.style.display = "none";
      img.hidden = false;
    };
    img.src = `/api/qr?text=${encodeURIComponent(code)}`;
  } catch {
    textarea.value = "Couldn't generate a code — is this device on a network?";
    shortCode.textContent = "······";
    loading.style.display = "none";
  }
}

export async function openDevicesModal(): Promise<void> {
  const panel = byId<HTMLDialogElement>("devices-panel");
  if (!panel.open) panel.showModal();
  byId("this-device-name").textContent = "…";
  await loadDeviceInfo();
  refreshDevicesPanel();
  if (devicesPollTimer !== null) clearInterval(devicesPollTimer);
  devicesPollTimer = setInterval(refreshDevicesPanel, 4000);
}

export function closeDevicesModal(): void {
  const panel = byId<HTMLDialogElement>("devices-panel");
  if (panel.open) panel.close();
  if (devicesPollTimer !== null) clearInterval(devicesPollTimer);
  devicesPollTimer = null;
}

/**
 * A click on the ::backdrop lands on the <dialog> element itself, not on its content — but
 * so does a click in the dialog's own padding, and the target alone cannot tell them apart.
 * Comparing against the dialog's box can.
 */
export function closeOnBackdropClick(panel: HTMLDialogElement, close: () => void): void {
  panel.addEventListener("click", (e: MouseEvent) => {
    if (e.target !== panel) return;
    const r = panel.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close();
  });
}


/** Every listener this module owns. Called once, from main.ts — never at import time. */
export function initDevices(): void {
  byId("devices-toggle").addEventListener("click", () => void openDevicesModal());
  byId("devices-modal-close").addEventListener("click", closeDevicesModal);
  byId<HTMLDialogElement>("devices-panel").addEventListener("close", closeDevicesModal);
  closeOnBackdropClick(byId<HTMLDialogElement>("devices-panel"), closeDevicesModal);
  
  byId("export-toggle").addEventListener("click", () => {
    byId<HTMLDialogElement>("export-panel").showModal();
  });
  byId("export-modal-close").addEventListener("click", () => {
    byId<HTMLDialogElement>("export-panel").close();
  });
  closeOnBackdropClick(byId<HTMLDialogElement>("export-panel"), () => byId<HTMLDialogElement>("export-panel").close());
}
