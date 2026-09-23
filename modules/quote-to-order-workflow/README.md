# Quote-to-order workflow

Provider-neutral workflow for high-consideration services and commerce. It
requires the magic-link auth tables in the shared D1 database.

## Implemented

- Public quote-request intake.
- Staff review, quote details, status, and expiry management.
- Authenticated customers can view their own quotes and converted orders.
- Admin-only conversion of accepted quotes into immutable order records.

## Before use

1. Apply auth migration, then this migration, to the shared D1 database.
2. Protect the public quote form with contact-intake safeguards or an equivalent
   Turnstile/rate-limit layer before exposing it.
3. Connect order confirmation and payments through a separate reviewed provider
   module. This starter intentionally does not charge cards.
