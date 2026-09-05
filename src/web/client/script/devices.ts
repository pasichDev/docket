/*
 * The devices modal: pairing with another device, approving what arrives, and the browser
 * access requests that share its UI.
 *
 * A TEMPLATE LITERAL, not a module. Everything below is text that becomes the page.
 *
 * Two rules follow from that and there is no compiler to enforce either:
 *  - a literal backtick ends the string. Write \\` , or reword. views.backtick.test.ts
 *    fails with the exact line number when one slips into a comment, which is where it
 *    always happens — a backtick is the natural way to quote an identifier in prose.
 *  - ${...} interpolates. Write \\${ for a dollar-brace that should reach the browser.
 */
export const DEVICES = `
// --- Devices: pairing + sync modal ---

let devicesLoaded = false;
let devicesPollTimer = null;
let outgoingPollTimer = null;
let isHostBrowserFlag = false;
let thisDeviceId = null;
const seenRequestIds = new Set();
// requestId -> "approve" | "deny" while that action's fetch is in flight — the periodic
// poll (every 4s while the modal is open) rebuilds these rows from scratch, and approve
// in particular can take a few seconds (network round-trip to the other device), so
// without this a poll landing mid-request would revert the row to its normal buttons
// and make the click look like it did nothing.
const pendingRequestActions = new Map();

function timeAgo(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return \`\${s}s ago\`;
  if (s < 3600) return \`\${Math.round(s / 60)}m ago\`;
  if (s < 86400) return \`\${Math.round(s / 3600)}h ago\`;
  return \`\${Math.round(s / 86400)}d ago\`;
}

async function loadDeviceInfo() {
  try {
    const d = await (await fetch("/api/device")).json();
    isHostBrowserFlag = !!d.isHostBrowser;
    if (thisDeviceId !== d.id) {
      thisDeviceId = d.id;
      render(allTodos); // "Other devices" counted/filtered against thisDeviceId, unknown until now
    }
    document.getElementById("this-device-name").textContent = d.name + (d.role === "guest" ? " (guest)" : "");
    const canManage = d.role !== "guest" && d.isHostBrowser;
    document.getElementById("devices-pair-section").hidden = !canManage;
    const noteEl = document.getElementById("guest-note");
    noteEl.hidden = canManage;
    if (!canManage) {
      noteEl.innerHTML =
        d.role === "guest"
          ? \`This device joined an existing group via someone else's invite, so it's a
             <strong>guest</strong> — it stays in sync, but only the device that invited
             it can invite or approve further devices. Unpair to leave and become a
             host again.\`
          : "Only this device's own browser can manage pairing and approve new connections.";
    }
    document.getElementById("devices-requests").hidden = !isHostBrowserFlag;
    if (canManage && !devicesLoaded) {
      devicesLoaded = true;
      generateInvite();
    }
  } catch {
    document.getElementById("this-device-name").textContent = "unknown";
  }
}

/**
 * Background poll (host browser only) for pairing + viewer-access requests. Updates the
 * badge on the Devices icon, and pops the modal open the moment a request this browser
 * hasn't seen yet shows up — closing it again without acting doesn't re-trigger the popup
 * for the same request.
 */
async function pollNotifications() {
  if (!isHostBrowserFlag) {
    document.getElementById("notif-badge").hidden = true;
    return;
  }
  try {
    const [pairing, access] = await Promise.all([
      fetch("/api/pair/incoming").then((r) => r.json()),
      fetch("/api/access/pending").then((r) => r.json()),
    ]);
    const requests = [...(pairing.requests ?? []), ...(access.requests ?? [])];
    const notifBadge = document.getElementById("notif-badge");
    notifBadge.hidden = requests.length === 0;
    notifBadge.textContent = String(requests.length);

    const hasUnseen = requests.some((r) => !seenRequestIds.has(r.requestId));
    for (const r of requests) seenRequestIds.add(r.requestId);
    if (hasUnseen && !document.getElementById("devices-panel").open) openDevicesModal();
  } catch {
    // quiet — background nicety, not core functionality
  }
}

// Approve in particular involves a real network round-trip to the requesting device
// (up to a few seconds) — render its busy state (both buttons disabled, the clicked
// one relabeled) whenever this id is mid-flight, so a periodic poll landing during
// that window doesn't revert it to plain "Approve"/"Deny" and make the click look
// like it did nothing.
function incomingRowHtml(id, name, meta, sas) {
  const action = pendingRequestActions.get(id);
  const approveLabel = action === "approve" ? "Approving…" : "Approve";
  const denyLabel = action === "deny" ? "Denying…" : "Deny";
  const disabled = action ? "disabled" : "";
  // sas: only pairing requests carry this — a code derived from both devices' public keys,
  // shown so the human can compare it against what the OTHER device's screen shows before
  // approving. A mismatch means someone tampered with the exchange (active MITM).
  const sasLineHtml = sas
    ? \`<span class="meta sas-verify">Verify code: <strong>\${sas.slice(0, 3)} \${sas.slice(3)}</strong> — must match on the other device</span>\`
    : "";
  return \`
    <div class="incoming-row" data-id="\${id}">
      <span>
        <span class="name">\${name}</span>
        <span class="meta">\${meta}</span>
        \${sasLineHtml}
      </span>
      <button class="approve" data-id="\${id}" type="button" \${disabled}>\${approveLabel}</button>
      <button class="deny" data-id="\${id}" type="button" \${disabled}>\${denyLabel}</button>
    </div>\`;
}

async function refreshDevicesPanel() {
  try {
    const { peers } = await (await fetch("/api/peers")).json();
    const listEl = document.getElementById("devices-list");
    const TRUST_LABELS = { trusted: "Trusted", verified: "Verified", pending: "Pending", revoked: "Revoked" };
    listEl.innerHTML = peers
      .map((p) => {
        const skew = typeof p.clockSkewMs === "number" ? \`\${p.clockSkewMs >= 0 ? "+" : ""}\${Math.round(p.clockSkewMs / 1000)}s skew\` : null;
        const chips = [
          p.fingerprint ? \`fp \${escapeHtml(p.fingerprint)}\` : null,
          typeof p.protocolVersion === "number" ? \`protocol v\${p.protocolVersion}\` : null,
          skew,
        ].filter(Boolean);
        return \`
        <div class="device-row" data-id="\${p.id}">
          <span class="dot \${p.trustState === "trusted" ? "ok" : "fail"}"></span>
          <span class="name">\${escapeHtml(p.name)}</span>
          <span class="row-badge sync">Sync</span>
          <span class="row-badge trust-\${p.trustState}">\${TRUST_LABELS[p.trustState] || p.trustState}</span>
          <span class="meta">synced \${timeAgo(p.lastSyncAt)}</span>
          <button class="peer-revoke" data-id="\${p.id}" data-action="\${p.revoked ? "restore" : "revoke"}" type="button">\${p.revoked ? "Restore" : "Revoke"}</button>
          <button class="unpair" data-id="\${p.id}" type="button">Unpair</button>
          <div class="device-row-details">
            \${chips.map((c) => \`<span>\${c}</span>\`).join("")}
            \${p.lastError ? \`<span class="err">\${escapeHtml(p.lastError)}</span>\` : ""}
            <button class="peer-update-address" data-id="\${p.id}" data-name="\${escapeHtml(p.name)}" type="button">Update address…</button>
          </div>
        </div>\`;
      })
      .join("");
  } catch (err) {
    console.error("devices refresh failed", err);
  }

  try {
    const { viewers } = await (await fetch("/api/access/viewers")).json();
    const viewersEl = document.getElementById("access-viewers-list");
    viewersEl.innerHTML = viewers
      .map(
        (v) => \`
        <div class="device-row" data-id="\${v.id}">
          <span class="dot ok"></span>
          <span class="name">\${escapeHtml(v.label)}</span>
          <span class="row-badge viewer">Viewer</span>
          <span class="meta">seen \${timeAgo(v.lastSeenAt)}</span>
          <button class="unpair viewer-revoke" data-id="\${v.id}" type="button">Revoke</button>
        </div>\`
      )
      .join("");
  } catch (err) {
    console.error("access refresh failed", err);
  }

  const connectedCount = document.getElementById("devices-list").children.length + document.getElementById("access-viewers-list").children.length;
  if (connectedCount === 0) {
    document.getElementById("devices-list").innerHTML = '<div class="phone-panel-hint">Nothing connected yet.</div>';
  }
  const devicesTabBadge = document.getElementById("devices-tab-badge");
  devicesTabBadge.hidden = connectedCount === 0;
  devicesTabBadge.textContent = String(connectedCount);

  try {
    const { presence } = await (await fetch("/api/presence")).json();
    const presenceEl = document.getElementById("presence-list");
    const presenceHeading = document.getElementById("presence-heading");
    presenceHeading.hidden = presence.length === 0;
    presenceEl.innerHTML = presence
      .map(
        (p) => \`
        <div class="presence-row">
          <span class="dot \${p.active ? "active" : "idle"}"></span>
          <span class="who">\${escapeHtml(p.identity)}</span>
          <span>\${p.active ? "active" : \`idle \${timeAgo(p.lastActiveAt)}\`}</span>
        </div>\`
      )
      .join("");
  } catch (err) {
    console.error("presence refresh failed", err);
  }

  // Live sessions sit ABOVE recent activity on purpose: "which terminal is open in this
  // project" is actionable right now, where "what did codex last touch" is history.
  try {
    const { sessions } = await (await fetch("/api/sessions")).json();
    const sessionsEl = document.getElementById("sessions-list");
    document.getElementById("sessions-heading").hidden = sessions.length === 0;
    sessionsEl.innerHTML = sessions
      .map(
        (s) => \`
        <div class="presence-row">
          <span class="dot \${Date.now() - Date.parse(s.lastSeenAt) < 60000 ? "active" : "idle"}"></span>
          <span class="who">\${escapeHtml(s.agent || "unknown")}</span>
          <span>\${escapeHtml(s.workspace || "unfiled")} · \${escapeHtml(timeAgo(s.lastSeenAt))}</span>
        </div>\`
      )
      .join("");
  } catch (err) {
    console.error("sessions refresh failed", err);
  }

  if (isHostBrowserFlag) {
    try {
      const { requests: pairingRequests } = await (await fetch("/api/pair/incoming")).json();
      const incomingEl = document.getElementById("devices-incoming");
      incomingEl.hidden = pairingRequests.length === 0;
      incomingEl.innerHTML = pairingRequests
        .map(
          (r) => incomingRowHtml(r.requestId, \`Pairing request from \${escapeHtml(r.deviceName)}\`, "wants to share this list with this device", r.sas)
        )
        .join("");

      const { requests: accessRequests } = await (await fetch("/api/access/pending")).json();
      const accessIncomingEl = document.getElementById("access-incoming");
      accessIncomingEl.hidden = accessRequests.length === 0;
      accessIncomingEl.innerHTML = accessRequests
        .map(
          (r) => incomingRowHtml(r.requestId, \`Access request from \${escapeHtml(r.ip)}\`, "wants to view/edit this list in a browser")
        )
        .join("");

      // Resolved/expired history — the still-"pending" ones above already have their own cards.
      const { events } = await (await fetch("/api/notifications")).json();
      const past = events.filter((e) => e.status !== "pending");
      const logEl = document.getElementById("activity-log");
      logEl.hidden = past.length === 0;
      logEl.innerHTML = past
        .map(
          (e) => \`
        <div class="activity-row">
          <span class="status \${e.status}">\${e.status}</span>
          <span class="label">\${e.kind === "pairing" ? "Pairing" : "Access"} request from \${escapeHtml(e.label)}</span>
          <span class="when">\${timeAgo(new Date(e.resolvedAt ?? e.createdAt).toISOString())}</span>
        </div>\`
        )
        .join("");
    } catch (err) {
      console.error("requests refresh failed", err);
    }
  }
}

async function generateInvite() {
  const textarea = document.getElementById("pair-invite-text");
  const shortCode = document.getElementById("pair-short-code");
  const img = document.getElementById("pair-qr");
  const loading = document.getElementById("pair-qr-loading");
  textarea.value = "Generating…";
  shortCode.textContent = "······";
  img.hidden = true;
  loading.style.display = "grid";
  try {
    const invite = await (await fetch("/api/pair/invite", { method: "POST" })).json();
    if (invite.error) {
      textarea.value = invite.error;
      loading.style.display = "none";
      return;
    }
    // pk carries this device's real public key through the SAME out-of-band channel as the
    // code (QR / pasted line) — the other device anchors trust in it before any network call,
    // so an active LAN attacker can't just swap in their own key mid-exchange unnoticed.
    const code = \`\${invite.url}?pair=\${invite.token}&pk=\${encodeURIComponent(invite.publicKeyX)}\`;
    textarea.value = code;
    shortCode.textContent = invite.token;
    img.onload = () => {
      loading.style.display = "none";
      img.hidden = false;
    };
    img.src = \`/api/qr?text=\${encodeURIComponent(code)}\`;
  } catch {
    textarea.value = "Couldn't generate a code — is this device on a network?";
    shortCode.textContent = "······";
    loading.style.display = "none";
  }
}

async function openDevicesModal() {
  const panel = document.getElementById("devices-panel");
  if (!panel.open) panel.showModal();
  document.getElementById("this-device-name").textContent = "…";
  await loadDeviceInfo();
  refreshDevicesPanel();
  clearInterval(devicesPollTimer);
  devicesPollTimer = setInterval(refreshDevicesPanel, 4000);
}

function closeDevicesModal() {
  const panel = document.getElementById("devices-panel");
  if (panel.open) panel.close();
  clearInterval(devicesPollTimer);
  devicesPollTimer = null;
}

/**
 * A click on the ::backdrop lands on the <dialog> element itself, not on its content — but
 * so does a click in the dialog's own padding, and the target alone cannot tell them apart.
 * Comparing against the dialog's box can.
 */
function closeOnBackdropClick(panel, close) {
  panel.addEventListener("click", (e) => {
    if (e.target !== panel) return;
    const r = panel.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close();
  });
}

document.getElementById("devices-toggle").addEventListener("click", openDevicesModal);
document.getElementById("devices-modal-close").addEventListener("click", closeDevicesModal);
document.getElementById("devices-panel").addEventListener("close", closeDevicesModal);
closeOnBackdropClick(document.getElementById("devices-panel"), closeDevicesModal);

document.getElementById("export-toggle").addEventListener("click", () => {
  document.getElementById("export-panel").showModal();
});
document.getElementById("export-modal-close").addEventListener("click", () => {
  document.getElementById("export-panel").close();
});
closeOnBackdropClick(document.getElementById("export-panel"), () => document.getElementById("export-panel").close());

`;
