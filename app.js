const els = {
  connState: document.getElementById("connState"),
  btnOpenScanner: document.getElementById("btnOpenScanner"),
  btnInstall: document.getElementById("btnInstall"),
  btnEnablePush: document.getElementById("btnEnablePush"),
  btnToggleMeta: document.getElementById("btnToggleMeta"),
  scanOverlay: document.getElementById("scanOverlay"),
  qrScanner: document.getElementById("qrScanner"),
  scanStatus: document.getElementById("scanStatus"),
  btnStopScan: document.getElementById("btnStopScan"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  msgInput: document.getElementById("msgInput"),
  btnSend: document.getElementById("btnSend"),
  metaPanel: document.getElementById("metaPanel"),
  relayUrl: document.getElementById("relayUrl"),
  nodeDeviceId: document.getElementById("nodeDeviceId"),
  inboxDeviceId: document.getElementById("inboxDeviceId"),
  pairStatus: document.getElementById("pairStatus"),
  installStatus: document.getElementById("installStatus"),
  pushStatus: document.getElementById("pushStatus"),
  curlHint: document.getElementById("curlHint"),
  pairingPayloadView: document.getElementById("pairingPayloadView"),
};

const CLIENT_DEVICE_ID_STORAGE_KEY = "bus_client_device_id_v1";
const PAIRING_STATE_STORAGE_KEY = "bus_pairing_state_v1";

function getOrCreateClientDeviceId() {
  try {
    const existing = localStorage.getItem(CLIENT_DEVICE_ID_STORAGE_KEY);
    if (existing && existing.trim()) return existing.trim();
  } catch {
    // ignore storage errors
  }
  const fresh = crypto.randomUUID();
  try {
    localStorage.setItem(CLIENT_DEVICE_ID_STORAGE_KEY, fresh);
  } catch {
    // ignore storage errors
  }
  return fresh;
}

let state = {
  paired: false,
  relayUrl: "",
  nodeDeviceId: "",
  pairCode: "",
  pskB64: "",
  clientDeviceId: getOrCreateClientDeviceId(),
  seq: 0,
  pollTimer: null,
  pollInFlight: false,
  pushEnabled: false,
  qrScanner: null,
  qrScanning: false,
  connecting: false,
  deferredInstallPrompt: null,
};

function setConnState(text) {
  els.connState.textContent = text;
}

function setPairStatus(text) {
  els.pairStatus.textContent = text;
}

function setScanStatus(text) {
  els.scanStatus.textContent = text;
}

function setPushStatus(text) {
  els.pushStatus.textContent = text;
}

function setInstallStatus(text) {
  els.installStatus.textContent = text;
}

function setComposerEnabled(enabled) {
  els.composer.setAttribute("aria-disabled", enabled ? "false" : "true");
  els.msgInput.disabled = !enabled;
  els.btnSend.disabled = !enabled;
}

function showScanOverlay(show) {
  els.scanOverlay.hidden = !show;
}

function addMessage(kind, text) {
  const div = document.createElement("div");
  div.className = `msg msg-${kind}`;
  div.textContent = text;
  els.messages.appendChild(div);
  while (els.messages.children.length > 300) {
    els.messages.removeChild(els.messages.firstChild);
  }
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

function decodeUrlsafeB64ToString(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function urlBase64ToUint8Array(base64String) {
  const normalized = String(base64String).replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  const rawData = atob(padded);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function relayPath(path, params = {}) {
  const url = new URL(path, state.relayUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Missing pairing payload");
  if (Number(payload.v) !== 1) throw new Error("Unsupported pairing payload version");

  const normalized = {
    v: 1,
    relay_url: String(payload.relay_url || "").trim(),
    node_device_id: String(payload.node_device_id || "").trim(),
    pair_code: String(payload.pair_code || "").trim(),
    psk_b64: String(payload.psk_b64 || "").trim(),
    expires_at: Number(payload.expires_at || 0),
  };

  if (!normalized.relay_url || !normalized.node_device_id || !normalized.pair_code || !normalized.psk_b64) {
    throw new Error("Incomplete pairing payload");
  }
  return normalized;
}

function payloadFromQueryString(queryString) {
  const params = new URLSearchParams(queryString);
  const pairB64 = params.get("pair_b64");
  const pairPayload = params.get("pair_payload");
  const relayOverride = params.get("relay_url");

  if (pairB64) {
    const decoded = decodeUrlsafeB64ToString(pairB64);
    const payload = JSON.parse(decoded);
    if (!payload.relay_url && relayOverride) payload.relay_url = relayOverride;
    return normalizePayload(payload);
  }
  if (pairPayload) {
    const payload = JSON.parse(pairPayload);
    if (!payload.relay_url && relayOverride) payload.relay_url = relayOverride;
    return normalizePayload(payload);
  }
  return null;
}

function payloadFromScannedText(rawText) {
  const value = String(rawText || "").trim();
  if (!value) return null;

  try {
    return normalizePayload(JSON.parse(value));
  } catch {
    // not raw JSON
  }

  try {
    const parsedUrl = new URL(value);
    const fromQuery = payloadFromQueryString(parsedUrl.search);
    if (fromQuery) return fromQuery;
  } catch {
    // not URL
  }

  try {
    const decoded = decodeUrlsafeB64ToString(value);
    return normalizePayload(JSON.parse(decoded));
  } catch {
    // not pair_b64
  }

  return null;
}

function savePairingState() {
  const stored = {
    relayUrl: state.relayUrl,
    nodeDeviceId: state.nodeDeviceId,
    pairCode: state.pairCode,
    pskB64: state.pskB64,
    clientDeviceId: state.clientDeviceId,
  };
  try {
    localStorage.setItem(PAIRING_STATE_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // ignore storage errors
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

  try {
    const saved = JSON.parse(raw);
    if (!saved || !saved.relayUrl || !saved.nodeDeviceId || !saved.clientDeviceId) return false;
    state.relayUrl = String(saved.relayUrl);
    state.nodeDeviceId = String(saved.nodeDeviceId);
    state.pairCode = String(saved.pairCode || "");
    state.pskB64 = String(saved.pskB64 || "");
    state.clientDeviceId = String(saved.clientDeviceId);
    return true;
  } catch {
    return false;
  }
}

function renderMeta(payloadText = "") {
  els.relayUrl.textContent = state.relayUrl || "-";
  els.nodeDeviceId.textContent = state.nodeDeviceId || "-";
  els.inboxDeviceId.textContent = state.clientDeviceId || "-";
  els.curlHint.textContent = state.paired
    ? `curl -X POST ${relayPath("/v1/envelopes")} \\\n  -H "Content-Type: application/json" \\\n  -d '{"v":1,"msg_id":"test-ui-1","conv_id":"demo","from_device_id":"manual","to_device_id":"${state.clientDeviceId}","dir":"to_local","seq":1,"created_ms":${Date.now()},"nonce_b64":"AA==","ciphertext_b64":"SGVsbG8gZnJvbSBjdXJs"}'`
    : "Pair first.";
  if (payloadText) {
    els.pairingPayloadView.textContent = payloadText;
  }
}

function isIOSDevice() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandaloneWebApp() {
  try {
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    // ignore
  }
  return window.navigator.standalone === true;
}

function canScanQrNow() {
  // iPhone push + camera pairing flow is intended for Home Screen app context.
  if (isIOSDevice() && !isStandaloneWebApp()) return false;
  return true;
}

function updateInstallUi() {
  els.btnOpenScanner.disabled = !canScanQrNow();

  if (isStandaloneWebApp()) {
    els.btnInstall.hidden = true;
    setInstallStatus("Installed.");
    return;
  }

  if (state.deferredInstallPrompt) {
    els.btnInstall.hidden = false;
    setInstallStatus("Install app for quick access.");
    return;
  }

  if (isIOSDevice()) {
    els.btnInstall.hidden = false;
    setInstallStatus("iPhone: Share -> Add to Home Screen.");
    return;
  }

  els.btnInstall.hidden = false;
  setInstallStatus("Use browser menu to install to Home Screen.");
}

async function requestInstall() {
  if (isStandaloneWebApp()) {
    updateInstallUi();
    return;
  }

  if (state.deferredInstallPrompt) {
    const deferred = state.deferredInstallPrompt;
    state.deferredInstallPrompt = null;
    try {
      await deferred.prompt();
      if (deferred.userChoice) {
        const result = await deferred.userChoice;
        if (result && result.outcome === "accepted") {
          addMessage("system", "App installed.");
        }
      }
    } catch {
      // Ignore prompt errors.
    }
    updateInstallUi();
    return;
  }

  if (isIOSDevice()) {
    addMessage("system", "Install on iPhone: Share -> Add to Home Screen.");
    setInstallStatus("Install on iPhone: Share -> Add to Home Screen.");
    return;
  }

  addMessage("system", "Use browser menu and choose Install App / Add to Home Screen.");
  setInstallStatus("Use browser menu and choose Install App / Add to Home Screen.");
}

function showInstallFirstMessage() {
  setPairStatus("Install app first. Then open from Home Screen and scan QR.");
  setScanStatus("Scanner is available after opening the installed app.");
  addMessage("system", "Install first, then reopen from Home Screen to pair.");
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

async function enablePush(options = { interactive: true }) {
  if (!state.paired) return false;

  if (isIOSDevice() && !isStandaloneWebApp()) {
    setPushStatus("On iPhone, open from Home Screen app icon for push.");
    els.btnEnablePush.hidden = false;
    return false;
  }
  if (!("Notification" in window) || !("PushManager" in window)) {
    setPushStatus("Push unavailable on this browser.");
    els.btnEnablePush.hidden = false;
    return false;
  }

  try {
    const cfg = await fetchPushConfig();
    if (!cfg.enabled || !cfg.vapid_public_key) {
      setPushStatus("Relay push is not configured.");
      els.btnEnablePush.hidden = true;
      return false;
    }

    let permission = Notification.permission;
    if (permission !== "granted") {
      if (!options.interactive) {
        setPushStatus("Tap Push to enable notifications.");
        els.btnEnablePush.hidden = false;
        return false;
      }
      permission = await Notification.requestPermission();
    }

    if (permission !== "granted") {
      setPushStatus(`Notifications are ${permission}.`);
      els.btnEnablePush.hidden = false;
      return false;
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
    els.btnEnablePush.hidden = true;
    setPushStatus("Push enabled.");
    addMessage("system", "Push enabled on this device.");
    return true;
  } catch (err) {
    setPushStatus(`Push setup failed: ${err.message}`);
    els.btnEnablePush.hidden = false;
    return false;
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

    if (res.ok) return true;

    const detail = (data && data.detail) ? data.detail : `pairing claim failed (${res.status})`;
    lastErr = detail;
    if (res.status !== 404 || attempt === 6) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(lastErr);
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
        const kind = from === state.clientDeviceId ? "you" : "remote";
        addMessage(kind, text);
      }
    } catch (err) {
      setPairStatus(`Polling error: ${err.message}`);
    } finally {
      state.pollInFlight = false;
    }
  };

  state.pollTimer = setInterval(poll, 1000);
  poll();
}

async function sendMessage(text) {
  if (!state.paired) {
    addMessage("system", "Not connected yet.");
    return;
  }
  const bodyText = String(text || "").trim();
  if (!bodyText) return;

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
    ciphertext_b64: encodeTextB64(bodyText),
  };

  try {
    const res = await fetch(relayPath("/v1/envelopes"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(env),
    });
    if (!res.ok) throw new Error(`send failed (${res.status})`);
    state.seq = nextSeq;
    addMessage("you", bodyText);
  } catch (err) {
    addMessage("system", `Send failed: ${err.message}`);
  }
}

function ensureQrScannerInstance() {
  if (!window.Html5Qrcode) {
    throw new Error("QR scanner library failed to load.");
  }
  if (!state.qrScanner) {
    state.qrScanner = new Html5Qrcode("qrScanner");
  }
  return state.qrScanner;
}

async function stopScanner() {
  if (!state.qrScanner || !state.qrScanning) {
    state.qrScanning = false;
    showScanOverlay(false);
    return;
  }
  try {
    await state.qrScanner.stop();
  } catch {
    // ignore
  }
  try {
    await state.qrScanner.clear();
  } catch {
    // ignore
  }
  state.qrScanner = null;
  state.qrScanning = false;
  showScanOverlay(false);
}

async function startScanner() {
  if (!canScanQrNow()) {
    showScanOverlay(false);
    showInstallFirstMessage();
    updateInstallUi();
    return;
  }
  if (state.qrScanning) return;
  try {
    const scanner = ensureQrScannerInstance();
    showScanOverlay(true);
    setScanStatus("Opening camera...");
    state.qrScanning = true;

    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 240, height: 240 }, aspectRatio: 1.0 },
      async (decodedText) => {
        const payload = payloadFromScannedText(decodedText);
        if (!payload) {
          setScanStatus("QR format not recognized.");
          return;
        }
        setScanStatus("QR detected. Connecting...");
        await stopScanner();
        await connectWithPayload(payload, JSON.stringify(payload));
      },
      () => {}
    );

    setScanStatus("Point camera at pairing QR.");
  } catch (err) {
    state.qrScanning = false;
    showScanOverlay(true);
    setScanStatus(`Camera error: ${err.message}`);
  }
}

function setConnectedUi(connected) {
  state.paired = connected;
  setComposerEnabled(connected);
  if (connected) {
    setConnState("Connected");
  } else {
    setConnState("Not connected");
  }
}

async function connectWithPayload(payload, payloadText = "") {
  if (state.connecting) return;
  state.connecting = true;
  try {
    // Ensure scanner overlay is closed even if QR callback races.
    await stopScanner();
    showScanOverlay(false);

    const normalized = normalizePayload(payload);
    state.relayUrl = normalized.relay_url;
    state.nodeDeviceId = normalized.node_device_id;
    state.pairCode = normalized.pair_code;
    state.pskB64 = normalized.psk_b64;

    renderMeta(payloadText || JSON.stringify(normalized));
    setPairStatus("Claiming pairing...");
    await claimPairingOnRelay();

    setConnectedUi(true);
    savePairingState();
    setPairStatus("Connected.");
    addMessage("system", `Connected to ${state.nodeDeviceId}`);
    startPolling();

    const pushed = await enablePush({ interactive: false });
    if (!pushed) {
      els.btnEnablePush.hidden = false;
    }
  } catch (err) {
    setConnectedUi(false);
    setPairStatus(`Connection failed: ${err.message}`);
    addMessage("system", `Connection failed: ${err.message}`);
    els.btnEnablePush.hidden = true;
    await startScanner();
  } finally {
    state.connecting = false;
  }
}

function connectFromRestoredState() {
  setConnectedUi(true);
  renderMeta();
  setPairStatus("Restored previous session.");
  addMessage("system", `Restored session for ${state.nodeDeviceId}`);
  startPolling();
  enablePush({ interactive: false }).then((ok) => {
    if (!ok) els.btnEnablePush.hidden = false;
  });
}

function wireEvents() {
  els.btnOpenScanner.addEventListener("click", startScanner);
  els.btnStopScan.addEventListener("click", stopScanner);
  els.btnInstall.addEventListener("click", requestInstall);
  els.btnToggleMeta.addEventListener("click", () => {
    els.metaPanel.hidden = !els.metaPanel.hidden;
  });
  els.btnEnablePush.addEventListener("click", () => enablePush({ interactive: true }));
  els.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = els.msgInput.value;
    els.msgInput.value = "";
    await sendMessage(text);
  });
}

async function bootstrap() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    updateInstallUi();
  });

  window.addEventListener("appinstalled", () => {
    state.deferredInstallPrompt = null;
    updateInstallUi();
    addMessage("system", "App installed.");
  });

  setConnectedUi(false);
  setScanStatus("");
  setPairStatus("Scan local pairing QR to connect.");
  setInstallStatus("");
  setPushStatus("");
  renderMeta();
  wireEvents();
  updateInstallUi();

  let fromQuery = null;
  try {
    fromQuery = payloadFromQueryString(window.location.search);
  } catch {
    fromQuery = null;
  }

  if (fromQuery) {
    await connectWithPayload(fromQuery, JSON.stringify(fromQuery));
    return;
  }

  if (restorePairingState()) {
    connectFromRestoredState();
    return;
  }

  if (!canScanQrNow()) {
    showInstallFirstMessage();
    return;
  }

  await startScanner();
}

bootstrap();
