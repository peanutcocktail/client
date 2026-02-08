const els = {
  relayUrl: document.getElementById("relayUrl"),
  pairingPayload: document.getElementById("pairingPayload"),
  btnPair: document.getElementById("btnPair"),
  pairStatus: document.getElementById("pairStatus"),
  pairDetails: document.getElementById("pairDetails"),
  nodeDeviceId: document.getElementById("nodeDeviceId"),
  inboxDeviceId: document.getElementById("inboxDeviceId"),
  btnEnablePush: document.getElementById("btnEnablePush"),
  pushStatus: document.getElementById("pushStatus"),
  curlHint: document.getElementById("curlHint"),
  messages: document.getElementById("messages"),
  msgInput: document.getElementById("msgInput"),
  btnSend: document.getElementById("btnSend"),
};

const CLIENT_DEVICE_ID_STORAGE_KEY = "bus_client_device_id_v1";
const PAIRING_STATE_STORAGE_KEY = "bus_pairing_state_v1";

function getOrCreateClientDeviceId() {
  try {
    const existing = localStorage.getItem(CLIENT_DEVICE_ID_STORAGE_KEY);
    if (existing && existing.trim()) return existing.trim();
  } catch {
    // Ignore localStorage errors and fall back to ephemeral ID.
  }
  const fresh = crypto.randomUUID();
  try {
    localStorage.setItem(CLIENT_DEVICE_ID_STORAGE_KEY, fresh);
  } catch {
    // Ignore localStorage write errors.
  }
  return fresh;
}

let state = {
  paired: false,
  relayUrl: null,
  nodeDeviceId: null,
  pairCode: null,
  pskB64: null,
  clientDeviceId: getOrCreateClientDeviceId(),
  seq: 0,
  pollTimer: null,
  pollInFlight: false,
  pushEnabled: false,
};

function decodeUrlsafeB64ToString(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function hydrateFromQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const payloadB64 = params.get("pair_b64");
  const payloadRaw = params.get("pair_payload");
  const relayFromQuery = params.get("relay_url");

  if (relayFromQuery && !els.relayUrl.value.trim()) {
    els.relayUrl.value = relayFromQuery;
  }

  if (payloadB64) {
    try {
      els.pairingPayload.value = decodeUrlsafeB64ToString(payloadB64);
      return;
    } catch (err) {
      els.pairStatus.textContent = "Failed to decode pair_b64 URL param.";
      return;
    }
  }

  if (payloadRaw) {
    els.pairingPayload.value = payloadRaw;
  }
}

function addMessage(text) {
  const div = document.createElement("div");
  div.className = "msg";
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function encodeTextB64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeTextB64(value) {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "[unreadable payload]";
  }
}

function relayPath(path, params = {}) {
  const url = new URL(path, state.relayUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function urlBase64ToUint8Array(base64String) {
  const normalized = base64String.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  const rawData = atob(padded);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function setPushStatus(text) {
  els.pushStatus.textContent = text;
}

function savePairingState() {
  const payload = {
    relayUrl: state.relayUrl,
    nodeDeviceId: state.nodeDeviceId,
    pairCode: state.pairCode,
    pskB64: state.pskB64,
    clientDeviceId: state.clientDeviceId,
  };
  try {
    localStorage.setItem(PAIRING_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage failures.
  }
}

function restorePairingState() {
  let raw = null;
  try {
    raw = localStorage.getItem(PAIRING_STATE_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return false;

  let saved = null;
  try {
    saved = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!saved || !saved.relayUrl || !saved.nodeDeviceId || !saved.clientDeviceId) {
    return false;
  }

  state.relayUrl = String(saved.relayUrl);
  state.nodeDeviceId = String(saved.nodeDeviceId);
  state.pairCode = saved.pairCode ? String(saved.pairCode) : null;
  state.pskB64 = saved.pskB64 ? String(saved.pskB64) : null;
  state.clientDeviceId = String(saved.clientDeviceId);
  state.paired = true;

  els.relayUrl.value = state.relayUrl;
  setPairDetails();
  els.pairStatus.textContent = "Restored previous pairing session.";
  addMessage(`[system] restored pairing; web inbox=${state.clientDeviceId}; local node=${state.nodeDeviceId}`);
  refreshPushStatusAfterPair();
  startPolling();
  return true;
}

async function fetchPushConfig() {
  const res = await fetch(relayPath("/v1/push/config"));
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = (data && data.detail) ? data.detail : `push config failed (${res.status})`;
    throw new Error(detail);
  }
  return data || {};
}

async function ensureServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported in this browser.");
  }
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    throw new Error("Push requires HTTPS.");
  }
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  return reg;
}

async function enablePush() {
  if (!state.paired) {
    setPushStatus("Pair first.");
    return;
  }
  if (!("Notification" in window) || !("PushManager" in window)) {
    setPushStatus("Push is not supported by this browser.");
    return;
  }

  els.btnEnablePush.disabled = true;
  setPushStatus("Enabling push...");
  try {
    const cfg = await fetchPushConfig();
    if (!cfg.enabled || !cfg.vapid_public_key) {
      throw new Error("Relay push is not configured.");
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error(`Notification permission is ${permission}.`);
    }

    const reg = await ensureServiceWorkerRegistration();
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.vapid_public_key),
      });
    }

    const subRes = await fetch(relayPath("/v1/push/subscribe"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to_device_id: state.clientDeviceId,
        subscription: subscription.toJSON(),
      }),
    });
    let subData = null;
    try {
      subData = await subRes.json();
    } catch {
      subData = null;
    }
    if (!subRes.ok) {
      const detail = (subData && subData.detail) ? subData.detail : `push subscribe failed (${subRes.status})`;
      throw new Error(detail);
    }

    state.pushEnabled = true;
    setPushStatus("Push enabled for this browser.");
    addMessage("[system] push enabled");
  } catch (err) {
    setPushStatus(`Push setup failed: ${err.message}`);
  } finally {
    els.btnEnablePush.disabled = false;
  }
}

async function refreshPushStatusAfterPair() {
  if (!state.paired) {
    setPushStatus("");
    return;
  }
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
    setPushStatus("Push not supported in this browser.");
    return;
  }
  if (Notification.permission === "denied") {
    setPushStatus("Notifications are blocked in this browser.");
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      setPushStatus("Push not enabled yet.");
      return;
    }
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      setPushStatus("Browser has a push subscription. Click Enable Push to sync with relay.");
      return;
    }
    setPushStatus("Push not enabled yet.");
  } catch {
    setPushStatus("Push not enabled yet.");
  }
}

async function claimPairingOnRelay() {
  const claimBody = {
    node_device_id: state.nodeDeviceId,
    pair_code: state.pairCode,
    client_device_id: state.clientDeviceId,
  };

  let lastErr = "pairing claim failed";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const res = await fetch(relayPath("/v1/pairing/claim"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimBody),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.ok) return data;

    const detail = (data && data.detail) ? data.detail : `pairing claim failed (${res.status})`;
    lastErr = detail;
    if (res.status !== 404 || attempt === 6) break;
    await sleep(500);
  }

  throw new Error(lastErr);
}

function setPairDetails() {
  els.pairDetails.hidden = false;
  els.nodeDeviceId.textContent = state.nodeDeviceId;
  els.inboxDeviceId.textContent = state.clientDeviceId;
  els.curlHint.textContent = `curl -X POST ${relayPath("/v1/envelopes")} \\
  -H "Content-Type: application/json" \\
  -d '{"v":1,"msg_id":"test-ui-1","conv_id":"demo","from_device_id":"manual","to_device_id":"${state.clientDeviceId}","dir":"to_local","seq":1,"created_ms":${Date.now()},"nonce_b64":"AA==","ciphertext_b64":"SGVsbG8gZnJvbSBjdXJs"}'`;
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);

  const poll = async () => {
    if (!state.paired || state.pollInFlight) return;
    state.pollInFlight = true;
    try {
      const res = await fetch(relayPath("/v1/poll", {
        to_device_id: state.clientDeviceId,
        limit: 50,
      }));
      if (!res.ok) throw new Error(`poll failed (${res.status})`);
      const data = await res.json();
      const envelopes = Array.isArray(data.envelopes) ? data.envelopes : [];
      for (const env of envelopes) {
        const text = decodeTextB64(env.ciphertext_b64);
        const from = env.from_device_id || "unknown";
        const tag = from === state.clientDeviceId ? "echo" : "remote";
        addMessage(`[${tag}] ${text}`);
      }
    } catch (err) {
      els.pairStatus.textContent = `Paired, but polling failed: ${err.message}`;
    } finally {
      state.pollInFlight = false;
    }
  };

  state.pollTimer = setInterval(poll, 1000);
  poll();
}

async function pair() {
  try {
    const payload = JSON.parse(els.pairingPayload.value.trim());
    if (payload.v !== 1) throw new Error("Unsupported pairing payload version");
    state.relayUrl = (els.relayUrl.value || payload.relay_url || "").trim();
    state.nodeDeviceId = payload.node_device_id;
    state.pairCode = payload.pair_code;
    state.pskB64 = payload.psk_b64;

    if (!state.relayUrl) throw new Error("Missing relayUrl");
    if (!state.nodeDeviceId || !state.pairCode || !state.pskB64) throw new Error("Incomplete pairing payload");

    await claimPairingOnRelay();
    state.paired = true;
    els.pairStatus.textContent = "Paired and claimed. UI is now polling the relay inbox.";
    setPairDetails();
    savePairingState();
    refreshPushStatusAfterPair();
    addMessage(`[system] paired; web inbox=${state.clientDeviceId}; local node=${state.nodeDeviceId}`);
    startPolling();
  } catch (err) {
    els.pairStatus.textContent = "Pairing failed: " + err.message;
    els.pairDetails.hidden = true;
  }
}

async function sendMessage() {
  if (!state.paired) {
    addMessage("[system] not paired yet");
    return;
  }
  const text = els.msgInput.value.trim();
  if (!text) return;
  els.msgInput.value = "";

  const nextSeq = state.seq + 1;
  const env = {
    v: 1,
    msg_id: crypto.randomUUID(),
    conv_id: "demo",
    from_device_id: state.clientDeviceId,
    to_device_id: state.nodeDeviceId,
    dir: "to_local",
    seq: nextSeq,
    created_ms: Date.now(),
    nonce_b64: "AA==",
    ciphertext_b64: encodeTextB64(text),
  };

  try {
    const res = await fetch(relayPath("/v1/envelopes"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(env),
    });
    if (!res.ok) throw new Error(`send failed (${res.status})`);
    state.seq = nextSeq;
    addMessage("[you] " + text);
  } catch (err) {
    addMessage("[system] send failed: " + err.message);
  }
}

els.btnPair.addEventListener("click", pair);
els.btnSend.addEventListener("click", sendMessage);
els.btnEnablePush.addEventListener("click", enablePush);
els.msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

hydrateFromQueryParams();
if (!els.pairingPayload.value.trim()) {
  restorePairingState();
}
