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

## Security posture

- Avoid third-party scripts.
- Use a CSP meta tag in `index.html`.
- Render decrypted content as text (or sanitized markdown).

## TODO before production

- Re-enable and tighten the CSP meta tag in `index.html` (temporarily commented out for deployment testing with variable relay URLs).
