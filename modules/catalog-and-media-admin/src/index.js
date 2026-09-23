const encoder = new TextEncoder();
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });
const id = () => crypto.randomUUID();
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function hash(value) { const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value)); return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""); }
function session(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const prefix = "auth_session=";
  return (request.headers.get("Cookie") || "").split("; ").find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}
async function staff(request, env, adminOnly = false) {
  const raw = session(request);
  if (!raw) throw new HttpError(401, "Sign in required");
  const user = await env.DB.prepare("SELECT u.id, u.role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP").bind(await hash(raw)).first();
  if (!user || !["editor", "admin"].includes(user.role) || (adminOnly && user.role !== "admin")) throw new HttpError(403, adminOnly ? "Admin access required" : "Staff access required");
  return user;
}
const text = (value, max = 500) => String(value || "").trim().slice(0, max);
const slug = value => text(value, 100).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const generatedSku = productId => "SKU-" + productId.replace(/[^a-z0-9]/gi, "").toUpperCase();
async function publicProducts(env) {
  const result = await env.DB.prepare("SELECT p.id,p.name,p.slug,p.sku,p.description,p.price_cents,p.metadata_json,c.id AS category_id,c.name AS category,c.slug AS category_slug,v.name AS vendor,(SELECT public_url FROM catalog_product_assets a WHERE a.product_id=p.id ORDER BY position LIMIT 1) AS image_url FROM catalog_products p LEFT JOIN catalog_categories c ON c.id=p.category_id LEFT JOIN catalog_vendors v ON v.id=p.vendor_id WHERE p.status='published' ORDER BY c.name,p.name").all();
  return Response.json({ products: result.results }, { headers: { "Cache-Control": "public, max-age=60" } });
}
async function listAdminProducts(request, env) {
  await staff(request, env);
  const result = await env.DB.prepare("SELECT p.id,p.category_id,p.vendor_id,p.name,p.slug,p.sku,p.description,p.price_cents,p.status,p.metadata_json,p.updated_at,c.name AS category,(SELECT public_url FROM catalog_product_assets a WHERE a.product_id=p.id ORDER BY position LIMIT 1) AS image_url FROM catalog_products p LEFT JOIN catalog_categories c ON c.id=p.category_id ORDER BY p.updated_at DESC LIMIT 250").all();
  return json({ products: result.results });
}
async function listCategories(request, env, requireStaff = false) {
  if (requireStaff) await staff(request, env);
  const result = await env.DB.prepare("SELECT id,name,slug,created_at FROM catalog_categories ORDER BY name").all();
  return json({ categories: result.results });
}
async function createCategory(request, env) {
  await staff(request, env);
  const body = await request.json().catch(() => null);
  const name = text(body?.name, 120);
  const categorySlug = slug(body?.slug || name);
  if (!name || !categorySlug) throw new HttpError(400, "Name and slug are required");
  const categoryId = id();
  await env.DB.prepare("INSERT INTO catalog_categories (id,name,slug) VALUES (?, ?, ?)").bind(categoryId, name, categorySlug).run();
  return json({ id: categoryId, name, slug: categorySlug }, 201);
}
async function createProduct(request, env) {
  await staff(request, env);
  const body = await request.json().catch(() => null);
  const name = text(body?.name, 200);
  const productSlug = slug(body?.slug || name);
  if (!name || !productSlug) throw new HttpError(400, "Name and slug are required");
  const productId = id();
  const sku = text(body?.sku, 100) || generatedSku(productId);
  await env.DB.prepare("INSERT INTO catalog_products (id,vendor_id,category_id,name,slug,sku,description,price_cents,metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(productId, body?.vendorId || null, body?.categoryId || null, name, productSlug, sku, text(body?.description, 20_000) || null, Number.isInteger(body?.priceCents) ? body.priceCents : null, JSON.stringify(body?.metadata || null)).run();
  return json({ id: productId, slug: productSlug, sku, status: "draft" }, 201);
}
async function updateProduct(request, env, productId) {
  await staff(request, env);
  const body = await request.json().catch(() => null);
  const existing = await env.DB.prepare("SELECT sku FROM catalog_products WHERE id=?").bind(productId).first();
  if (!existing) throw new HttpError(404, "Product not found");
  const name = text(body?.name, 200);
  const productSlug = slug(body?.slug || name);
  const sku = text(body?.sku, 100) || existing.sku || generatedSku(productId);
  if (!name || !productSlug) throw new HttpError(400, "Name and slug are required");
  const result = await env.DB.prepare("UPDATE catalog_products SET vendor_id=?,category_id=?,name=?,slug=?,sku=?,description=?,price_cents=?,metadata_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(body?.vendorId || null, body?.categoryId || null, name, productSlug, sku, text(body?.description, 20_000) || null, Number.isInteger(body?.priceCents) ? body.priceCents : null, JSON.stringify(body?.metadata || null), productId).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "Product not found");
  return json({ ok: true, slug: productSlug, sku });
}
async function deleteProduct(request, env, productId) {
  await staff(request, env, true);
  const assets = await env.DB.prepare("SELECT r2_key FROM catalog_product_assets WHERE product_id=?").bind(productId).all();
  if (assets.results.length && (!env.MEDIA_BUCKET || typeof env.MEDIA_BUCKET.delete !== "function")) throw new HttpError(503, "Media storage is unavailable");
  await Promise.all(assets.results.map(asset => env.MEDIA_BUCKET.delete(asset.r2_key)));
  const result = await env.DB.prepare("DELETE FROM catalog_products WHERE id=?").bind(productId).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "Product not found");
  return json({ ok: true });
}
async function setStatus(request, env, productId, status) {
  await staff(request, env);
  const result = await env.DB.prepare("UPDATE catalog_products SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(status, productId).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "Product not found");
  return json({ ok: true, status });
}
async function uploadAsset(request, env, productId) {
  await staff(request, env);
  const type = request.headers.get("Content-Type") || "";
  const size = Number(request.headers.get("Content-Length") || 0);
  if (!/^image\//.test(type) || !request.body) throw new HttpError(400, "Upload an image");
  if (!size || size > Number(env.MAX_MEDIA_BYTES || 10_485_760)) throw new HttpError(413, "Image is too large");
  const exists = await env.DB.prepare("SELECT id FROM catalog_products WHERE id=?").bind(productId).first();
  if (!exists) throw new HttpError(404, "Product not found");
  const assetId = id();
  const key = "catalog/" + productId + "/" + assetId + "." + type.split("/")[1].replace(/[^a-z0-9]/gi, "");
  await env.MEDIA_BUCKET.put(key, request.body, { httpMetadata: { contentType: type } });
  const url = env.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, "") + "/" + key;
  await env.DB.prepare("INSERT INTO catalog_product_assets (id,product_id,r2_key,public_url,content_type,alt_text,position) VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(position)+1 FROM catalog_product_assets WHERE product_id=?),0))")
    .bind(assetId, productId, key, url, type, text(request.headers.get("X-Alt-Text"), 250) || null, productId).run();
  return json({ id: assetId, url }, 201);
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const product = path.match(/^\/api\/admin\/catalog\/products\/([^/]+)(?:\/(publish|hide|assets))?$/);
    try {
      if (request.method === "GET" && path === "/health") return json({ ok: true });
      if (request.method === "GET" && path === "/api/catalog/products") return publicProducts(env);
      if (request.method === "GET" && path === "/api/catalog/categories") return await listCategories(request, env);
      if (request.method === "GET" && path === "/api/admin/catalog/categories") return await listCategories(request, env, true);
      if (request.method === "POST" && path === "/api/admin/catalog/categories") return await createCategory(request, env);
      if (request.method === "GET" && path === "/api/admin/catalog/products") return await listAdminProducts(request, env);
      if (request.method === "POST" && path === "/api/admin/catalog/products") return await createProduct(request, env);
      if (request.method === "PATCH" && product && !product[2]) return await updateProduct(request, env, product[1]);
      if (request.method === "DELETE" && product && !product[2]) return await deleteProduct(request, env, product[1]);
      if (request.method === "POST" && product?.[2] === "publish") return await setStatus(request, env, product[1], "published");
      if (request.method === "POST" && product?.[2] === "hide") return await setStatus(request, env, product[1], "hidden");
      if (request.method === "POST" && product?.[2] === "assets") return await uploadAsset(request, env, product[1]);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "Unexpected server error" }, 500);
    }
  },
};
