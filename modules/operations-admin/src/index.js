const encoder = new TextEncoder();
const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function token(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const prefix = "auth_session=";
  return (request.headers.get("Cookie") || "").split("; ").find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}
async function admin(request, env) {
  const raw = token(request);
  if (!raw) throw new HttpError(401, "Sign in required");
  const user = await env.DB.prepare("SELECT u.id, u.email, u.role FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP")
    .bind(await sha256(raw)).first();
  if (!user || user.role !== "admin") throw new HttpError(403, "Admin access required");
  return user;
}
async function installedTables(env) {
  const result = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return new Set(result.results.map(row => row.name));
}
async function count(env, enabled, table, where = "", bindings = []) {
  if (!enabled.has(table)) return null;
  return env.DB.prepare("SELECT COUNT(*) AS count FROM " + table + where).bind(...bindings).first("count");
}
async function overview(request, env) {
  const user = await admin(request, env);
  const tables = await installedTables(env);
  const [users, products, orders, openOrders, revenueCents] = await Promise.all([
    count(env, tables, "auth_users"),
    count(env, tables, "catalog_products"),
    count(env, tables, "sales_orders"),
    count(env, tables, "sales_orders", " WHERE status IN ('pending', 'confirmed')"),
    tables.has("sales_orders")
      ? env.DB.prepare("SELECT COALESCE(SUM(total_cents), 0) AS total FROM sales_orders WHERE status != 'cancelled'").first("total")
      : null,
  ]);
  return json({
    user,
    modules: {
      auth: tables.has("auth_users"),
      catalog: tables.has("catalog_products"),
      orders: tables.has("sales_orders"),
      media: tables.has("catalog_product_assets"),
    },
    cards: {
      users: Number(users || 0),
      products: Number(products || 0),
      orders: Number(orders || 0),
      openOrders: Number(openOrders || 0),
      revenueCents: Number(revenueCents || 0),
    },
  });
}
async function listUsers(request, env) {
  await admin(request, env);
  const result = await env.DB.prepare("SELECT id,email,role,created_at,last_login_at FROM auth_users ORDER BY created_at DESC LIMIT 250").all();
  return json({ users: result.results });
}
async function updateUser(request, env, userId) {
  const actor = await admin(request, env);
  const body = await request.json().catch(() => null);
  const role = String(body?.role || "");
  if (!["member", "editor", "admin"].includes(role)) throw new HttpError(400, "Invalid role");
  if (actor.id === userId && role !== "admin") throw new HttpError(409, "You cannot remove your own admin access");
  const result = await env.DB.prepare("UPDATE auth_users SET role=? WHERE id=?").bind(role, userId).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "User not found");
  return json({ ok: true, role });
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const user = path.match(/^\/api\/admin\/users\/([^/]+)$/);
    try {
      if (request.method === "GET" && path === "/health") return json({ ok: true });
      if (request.method === "GET" && path === "/api/admin/overview") return await overview(request, env);
      if (request.method === "GET" && path === "/api/admin/users") return await listUsers(request, env);
      if (request.method === "PATCH" && user) return await updateUser(request, env, user[1]);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "Unexpected server error" }, 500);
    }
  },
};
