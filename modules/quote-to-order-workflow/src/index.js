const encoder = new TextEncoder();
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const id = () => crypto.randomUUID();
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function hash(value) { const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value)); return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""); }
function token(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const prefix = "auth_session=";
  return (request.headers.get("Cookie") || "").split("; ").find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}
async function signedIn(request, env) {
  const raw = token(request);
  if (!raw) throw new HttpError(401, "Sign in required");
  const user = await env.DB.prepare("SELECT u.id,u.email,u.role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP").bind(await hash(raw)).first();
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
}
async function staff(request, env, adminOnly = false) {
  const user = await signedIn(request, env);
  if (!["editor", "admin"].includes(user.role) || (adminOnly && user.role !== "admin")) throw new HttpError(403, "Staff access required");
  return user;
}
const text = (value, max = 1000) => String(value || "").trim().slice(0, max);
async function submitQuote(request, env) {
  const body = await request.json().catch(() => null);
  const email = text(body?.email, 254).toLowerCase();
  const name = text(body?.name, 160) || null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !body?.request || typeof body.request !== "object") throw new HttpError(400, "Email and request details are required");
  const quoteId = id();
  await env.DB.prepare("INSERT INTO quote_requests (id,customer_email,customer_name,request_json) VALUES (?, ?, ?, ?)")
    .bind(quoteId, email, name, JSON.stringify(body.request)).run();
  return json({ ok: true, id: quoteId }, 201);
}
async function adminList(request, env) {
  await staff(request, env);
  const results = await env.DB.prepare("SELECT id,customer_email,customer_name,status,expires_at,created_at,updated_at FROM quote_requests ORDER BY updated_at DESC LIMIT 250").all();
  return json({ quotes: results.results });
}
async function updateQuote(request, env, quoteId) {
  await staff(request, env);
  const body = await request.json().catch(() => null);
  const statuses = ["new", "reviewing", "quoted", "accepted", "declined", "expired"];
  if (!statuses.includes(body?.status)) throw new HttpError(400, "Invalid quote status");
  const result = await env.DB.prepare("UPDATE quote_requests SET status=?,quote_json=?,expires_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(body.status, body?.quote && typeof body.quote === "object" ? JSON.stringify(body.quote) : null, body?.expiresAt || null, quoteId).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "Quote not found");
  return json({ ok: true });
}
async function convert(request, env, quoteId) {
  await staff(request, env, true);
  const quote = await env.DB.prepare("SELECT * FROM quote_requests WHERE id=? AND status='accepted'").bind(quoteId).first();
  if (!quote?.quote_json) throw new HttpError(409, "An accepted quote with quote details is required");
  const quoteData = JSON.parse(quote.quote_json);
  const orderId = id();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sales_orders (id,quote_request_id,customer_email,total_cents,order_json) VALUES (?, ?, ?, ?, ?)")
        .bind(orderId, quote.id, quote.customer_email, Number.isInteger(quoteData.totalCents) ? quoteData.totalCents : null, JSON.stringify({ request: JSON.parse(quote.request_json), quote: quoteData })),
      env.DB.prepare("UPDATE quote_requests SET status='converted',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(quote.id),
    ]);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "This quote was already converted");
    throw error;
  }
  return json({ id: orderId, status: "pending" }, 201);
}
async function adminOrders(request, env) {
  await staff(request, env);
  const result = await env.DB.prepare("SELECT id,quote_request_id,customer_email,status,total_cents,order_json,created_at,updated_at FROM sales_orders ORDER BY created_at DESC LIMIT 250").all();
  return json({ orders: result.results.map(row => ({ ...row, order: JSON.parse(row.order_json), order_json: undefined })) });
}
async function updateOrder(request, env, orderId) {
  await staff(request, env);
  const body = await request.json().catch(() => null);
  const statuses = ["pending", "confirmed", "fulfilled", "cancelled"];
  if (!statuses.includes(body?.status)) throw new HttpError(400, "Invalid order status");
  const result = await env.DB.prepare("UPDATE sales_orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(body.status, orderId).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "Order not found");
  return json({ ok: true, status: body.status });
}
async function accountQuotes(request, env) {
  const user = await signedIn(request, env);
  const result = await env.DB.prepare("SELECT id,status,quote_json,expires_at,created_at,updated_at FROM quote_requests WHERE customer_email=? ORDER BY created_at DESC").bind(user.email).all();
  return json({ quotes: result.results.map(row => ({ ...row, quote: row.quote_json ? JSON.parse(row.quote_json) : null, quote_json: undefined })) });
}
async function accountOrders(request, env) {
  const user = await signedIn(request, env);
  const result = await env.DB.prepare("SELECT id,quote_request_id,status,total_cents,order_json,created_at,updated_at FROM sales_orders WHERE customer_email=? ORDER BY created_at DESC").bind(user.email).all();
  return json({ orders: result.results.map(row => ({ ...row, order: JSON.parse(row.order_json), order_json: undefined })) });
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const quote = path.match(/^\/api\/admin\/quotes\/([^/]+)(?:\/convert)?$/);
    const order = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
    try {
      if (request.method === "GET" && path === "/health") return json({ ok: true });
      if (request.method === "POST" && path === "/api/quotes") return await submitQuote(request, env);
      if (request.method === "GET" && path === "/api/admin/quotes") return await adminList(request, env);
      if (request.method === "GET" && path === "/api/admin/orders") return await adminOrders(request, env);
      if (request.method === "PATCH" && order) return await updateOrder(request, env, order[1]);
      if (request.method === "PATCH" && quote && !path.endsWith("/convert")) return await updateQuote(request, env, quote[1]);
      if (request.method === "POST" && quote && path.endsWith("/convert")) return await convert(request, env, quote[1]);
      if (request.method === "GET" && path === "/api/account/quotes") return await accountQuotes(request, env);
      if (request.method === "GET" && path === "/api/account/orders") return await accountOrders(request, env);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "Unexpected server error" }, 500);
    }
  },
};
