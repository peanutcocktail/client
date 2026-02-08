# Frontend PWA (static)

Goal: a simple chat-like UI that:
- logs the user into the relay (hosted bus)
- pairs with a local node via QR payload
- encrypts outgoing messages and decrypts incoming messages

v1 is kept intentionally static: no build step required.

## Security posture

- Avoid third-party scripts.
- Use a CSP meta tag in `index.html`.
- Render decrypted content as text (or sanitized markdown).

## TODO before production

- Re-enable and tighten the CSP meta tag in `index.html` (temporarily commented out for deployment testing with variable relay URLs).
