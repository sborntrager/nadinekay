# Operations admin

Shared operations dashboard layer for the modules in this collection. The Worker
expects the magic-link auth tables in a shared D1 database, then detects optional
module tables rather than failing when a module has not been installed.

## Implemented

- GET /api/admin/overview — protected metrics and installed-module status.
- Admin-only session validation from cloudflare-magic-link-auth.
- Astro/Tailwind AdminShell component with navigation slots for content, inbox,
  mail, and social modules.

## Integration

Copy astro/AdminShell.astro into an Astro project, create an admin page, and
load /api/admin/overview server-side or from a protected client island. Deploy
the Worker against the same D1 database as the installed modules.

This is intentionally a composition shell. It does not duplicate mail, CMS,
social, contact, or authentication business logic.
