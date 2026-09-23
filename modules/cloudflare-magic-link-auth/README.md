# Cloudflare magic-link auth

A working starter for Resend-delivered passwordless sign-in on Cloudflare Workers
with D1-backed users, one-time magic links, secure cookie sessions, and audit events.

## Implemented routes

- POST /api/auth/request-link
- GET /api/auth/verify?token=...
- GET /api/auth/session
- POST /api/auth/logout
- GET /health

## Plug-in contract

The host application must provide:

- `DB`: D1 binding with `migrations/0001_auth.sql` applied.
- `APP_ORIGIN`: exact public application origin.
- `RESEND_API_KEY`: encrypted Cloudflare secret.
- `RESEND_FROM_EMAIL`: plain environment variable containing a Resend-verified sender.
- `AUTH_SUCCESS_PATH`: default safe redirect (`/account` or `/admin`).
- `ALLOW_SELF_SIGNUP`: `true` for customer account creation, otherwise pre-authorized users only.

Optional variables:

- `MAGIC_LINK_TTL_MINUTES` (default `15`).
- `SESSION_TTL_DAYS` (default `30`).

`GET /health` returns the exact missing bindings or variables. Login requests fail
with an actionable `503` before writing users or tokens when configuration is
incomplete. Provider failures return an actionable `502` and are logged without
exposing credentials.

The verification route sets an HttpOnly, `SameSite=Lax`, secure cookie and only
redirects to the allowlisted `/account` or `/admin` paths. Bearer-token validation
remains available for API clients.
