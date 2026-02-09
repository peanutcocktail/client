# Frontend PWA (static)

Goal: a simple chat-like UI that:
- logs the user into the relay (hosted bus)
- pairs with a local node via QR payload
- encrypts outgoing messages and decrypts incoming messages

v1 is kept intentionally static: no build step required.

## Pairing URL params

The client can prefill pairing fields from query params:
- `pair_b64`: URL-safe base64 encoded pairing JSON (preferred)
- `pair_payload`: raw JSON string (URL-encoded)
- `relay_url`: optional relay URL override/prefill

## Pairing via QR camera

The UI opens camera scan mode automatically when not connected.
It supports QR values containing:
- raw pairing payload JSON
- deep-link URL containing `pair_b64` / `pair_payload` / `relay_url`
- bare `pair_b64` value

## Install to Home Screen

The UI includes an `Install` button:
- Chrome/Edge/Android: uses the native install prompt when available.
- iPhone Safari: shows guidance to use `Share -> Add to Home Screen`.

## Web push notifications

After pairing:
1. The app attempts push setup automatically.
2. If browser permission needs interaction, tap the `Push` button.
3. The client remembers pairing state in `localStorage` and restores it on next load.

Requirements:
- Client must run in a secure context (`https://...`).
- Relay must expose VAPID config via `GET /v1/push/config` (enabled when VAPID env vars are set).

## Security posture

- Avoid third-party scripts.
- Use a CSP meta tag in `index.html`.
- Render decrypted content as text (or sanitized markdown).

## TODO before production

- Re-enable and tighten the CSP meta tag in `index.html` (temporarily commented out for deployment testing with variable relay URLs).
