UPDATE catalog_products
SET sku = 'SKU-' || UPPER(REPLACE(id, '-', ''))
WHERE sku IS NULL OR TRIM(sku) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_products_sku
ON catalog_products(sku)
WHERE sku IS NOT NULL;
