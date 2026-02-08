const els = {
  relayUrl: document.getElementById("relayUrl"),
  pairingPayload: document.getElementById("pairingPayload"),
  btnPair: document.getElementById("btnPair"),
  pairStatus: document.getElementById("pairStatus"),
  pairDetails: document.getElementById("pairDetails"),
  nodeDeviceId: document.getElementById("nodeDeviceId"),
  inboxDeviceId: document.getElementById("inboxDeviceId"),
  curlHint: document.getElementById("curlHint"),
  messages: document.getElementById("messages"),
  msgInput: document.getElementById("msgInput"),
  btnSend: document.getElementById("btnSend"),
};

let state = {
  paired: false,
  relayUrl: null,
  nodeDeviceId: null,
  pairCode: null,
  pskB64: null,
  clientDeviceId: crypto.randomUUID(),
  seq: 0,
  pollTimer: null,
  pollInFlight: false,
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

    state.paired = true;
    els.pairStatus.textContent = "Paired. UI is now polling the relay inbox.";
    setPairDetails();
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
els.msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

hydrateFromQueryParams();
