const encoder = new TextEncoder();
const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
});
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const id = () => crypto.randomUUID();
const token = () => crypto.getRandomValues(new Uint8Array(32)).reduce((out, byte) => out + byte.toString(16).padStart(2, "0"), "");
const future = (amount, unit) => new Date(Date.now() + amount * unit).toISOString();

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function origin(env) {
  return new URL(env.APP_ORIGIN).origin;
}
function bearer(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}
function cookie(request, name) {
  const prefix = name + "=";
  return (request.headers.get("Cookie") || "").split("; ").find(part => part.startsWith(prefix))?.slice(prefix.length) || null;
}
function sessionToken(request) {
  return bearer(request) || cookie(request, "auth_session");
}
function sessionCookie(env, value, expires) {
  const secure = origin(env).startsWith("https://") ? "; Secure" : "";
  return "auth_session=" + value + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + expires + secure;
}
async function audit(env, userId, type) {
  return env.DB.prepare("INSERT INTO auth_audit_events (id, user_id, event_type) VALUES (?, ?, ?)")
    .bind(id(), userId, type).run();
}
function safeReturnPath(value, fallback = "/account") {
  return ["/account", "/admin"].includes(value) ? value : fallback;
}
function validateConfiguration(env) {
  const missing = [];
  if (!env.DB || typeof env.DB.prepare !== "function") missing.push("DB");
  if (!env.APP_ORIGIN) missing.push("APP_ORIGIN");
  if (!env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!env.RESEND_FROM_EMAIL) missing.push("RESEND_FROM_EMAIL");
  return missing;
}
async function deliver(env, email, rawToken, returnTo) {
  const missing = validateConfiguration(env);
  if (missing.length) throw new HttpError(503, "Authentication is not configured: missing " + missing.join(", "));
  const link = new URL("/api/auth/verify", origin(env));
  link.searchParams.set("token", rawToken);
  link.searchParams.set("returnTo", safeReturnPath(returnTo, env.AUTH_SUCCESS_PATH || "/account"));
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [email],
      subject: "Your sign-in link",
      html: '<p><a href="' + link.href + '">Sign in securely</a></p><p>This single-use link expires shortly.</p>',
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Resend delivery failed", response.status, detail.slice(0, 500));
    throw new HttpError(502, "The sign-in email could not be sent. Check the verified sender configuration.");
  }
}
async function requestLink(request, env) {
  const missing = validateConfiguration(env);
  if (missing.length) throw new HttpError(503, "Authentication is not configured: missing " + missing.join(", "));
  if (request.headers.get("Origin") && request.headers.get("Origin") !== origin(env)) return json({ error: "Origin not allowed" }, 403);
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address" }, 400);
  const emailHash = await hash(email);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM auth_request_log WHERE email_hash = ? AND requested_at > datetime('now', '-15 minutes')")
    .bind(emailHash).first("count");
  if (Number(count) >= 5) return json({ error: "Please wait before requesting another link" }, 429);
  await env.DB.prepare("INSERT INTO auth_request_log (id, email_hash) VALUES (?, ?)").bind(id(), emailHash).run();
  let user = await env.DB.prepare("SELECT id FROM auth_users WHERE email = ?").bind(email).first();
  if (!user && env.ALLOW_SELF_SIGNUP !== "true") return json({ ok: true });
  if (!user) {
    user = { id: id() };
    await env.DB.prepare("INSERT INTO auth_users (id, email) VALUES (?, ?)").bind(user.id, email).run();
  }
  const rawToken = token();
  await env.DB.prepare("INSERT INTO auth_magic_links (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id(), user.id, await hash(rawToken), future(Number(env.MAGIC_LINK_TTL_MINUTES || 15), 60_000)).run();
  await deliver(env, email, rawToken, body.returnTo);
  await audit(env, user.id, "magic_link_requested");
  return json({ ok: true });
}
async function verify(request, env) {
  const rawToken = new URL(request.url).searchParams.get("token");
  if (!rawToken || rawToken.length !== 64) return json({ error: "Invalid sign-in link" }, 400);
  const hashedToken = await hash(rawToken);
  const link = await env.DB.prepare("SELECT user_id FROM auth_magic_links WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP")
    .bind(hashedToken).first();
  if (!link) return json({ error: "This link has expired or was already used" }, 401);
  const sessionToken = token();
  const consumed = await env.DB.prepare("UPDATE auth_magic_links SET consumed_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND consumed_at IS NULL")
    .bind(hashedToken).run();
  if (consumed.meta.changes !== 1) return json({ error: "This link has expired or was already used" }, 401);
  const days = Number(env.SESSION_TTL_DAYS || 30);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)").bind(id(), link.user_id, await hash(sessionToken), future(days, 86_400_000)),
    env.DB.prepare("UPDATE auth_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").bind(link.user_id),
  ]);
  await audit(env, link.user_id, "magic_link_consumed");
  const headers = { "Set-Cookie": sessionCookie(env, sessionToken, days * 86_400) };
  if (request.headers.get("Accept")?.includes("text/html")) {
    const returnTo = safeReturnPath(new URL(request.url).searchParams.get("returnTo"), env.AUTH_SUCCESS_PATH || "/account");
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL(returnTo, origin(env)).href,
        "Set-Cookie": headers["Set-Cookie"],
        "Cache-Control": "no-store",
      },
    });
  }
  return json({ ok: true }, 200, headers);
}
async function session(request, env) {
  const rawToken = sessionToken(request);
  if (!rawToken) return json({ user: null }, 401);
  const user = await env.DB.prepare("SELECT u.id, u.email, u.role FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP")
    .bind(await hash(rawToken)).first();
  return user ? json({ user }) : json({ user: null }, 401);
}
async function logout(request, env) {
  const rawToken = sessionToken(request);
  if (rawToken) await env.DB.prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?").bind(await hash(rawToken)).run();
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(env, "", 0) });
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "POST" && path === "/api/auth/request-link") return await requestLink(request, env);
      if (request.method === "GET" && path === "/api/auth/verify") return await verify(request, env);
      if (request.method === "GET" && path === "/api/auth/session") return await session(request, env);
      if (request.method === "POST" && path === "/api/auth/logout") return await logout(request, env);
      if (request.method === "GET" && path === "/health") {
        const missing = validateConfiguration(env);
        return json({ ok: missing.length === 0, module: "cloudflare-magic-link-auth", missing }, missing.length ? 503 : 200);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "Unexpected authentication error" }, 500);
    }
  },
};
