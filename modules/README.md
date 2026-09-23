# Installed modules

These modules were copied from `C:\Users\shann\Documents\Projects\Modules` as reusable building blocks for the standalone Nadine Kay application.

## Installed

1. `cloudflare-magic-link-auth`
   - Customer, editor, and admin identities
   - Magic-link login and D1-backed sessions
2. `catalog-and-media-admin`
   - Product catalog, prices, descriptions, publishing, and R2 images
3. `operations-admin`
   - Protected admin overview API and Astro admin shell
4. `quote-to-order-workflow`
   - Quote intake, customer order visibility, and staff order management

## Integration order

1. Configure the Nadine Kay D1 database and apply `cloudflare-magic-link-auth/migrations`.
2. Apply the catalog and order migrations to the same database.
3. Configure the Nadine Kay R2 product-media bucket.
4. Configure Resend and the Nadine Kay application origin.
5. Compose the module request handlers behind the Nadine Kay API routes.
6. Replace the temporary `/admin` test login with module-backed authentication.
7. Connect the storefront catalog to the public catalog API.
8. Add and connect the Square checkout/payment module.

## Update workflow

When a shared module is improved, review its migration and configuration notes, then replace the corresponding directory in this folder with the updated shared module. Project-specific branding and wiring must remain outside these module directories so module updates stay straightforward.
