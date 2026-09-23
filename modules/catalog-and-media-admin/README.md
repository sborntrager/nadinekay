# Catalog and media admin

Catalog foundation for product- or service-led sites. It relies on the shared
magic-link auth tables, D1, and a public R2 media domain.

## Implemented

- Vendors, categories, products, product status, and flexible metadata schema.
- Public published-products endpoint.
- Protected product list/create/update/publish/hide APIs.
- R2 product-image upload and ordered product assets.

## Before use

1. Apply auth migration, then this migration, to the shared D1 database.
2. Configure the R2 bucket and its public custom domain.
3. Add category/vendor CRUD and an Astro/Tailwind catalog editor in the next pass.
4. Keep checkout, payments, and inventory fulfillment as separate modules.
