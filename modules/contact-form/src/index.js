const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
const clean = (value, max) => String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

async function submitContact(request, env) {
  const missing = ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "CONTACT_TO_EMAIL", "APP_ORIGIN"].filter(key => !env[key]);
  if (missing.length) return json({ error: "Contact form is not configured" }, 503);
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && requestOrigin !== new URL(env.APP_ORIGIN).origin) return json({ error: "Origin not allowed" }, 403);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid request" }, 400);
  // Honeypot: real visitors never fill this hidden field. Pretend success so bots move on.
  if (body.website) return json({ ok: true });

  const name = clean(body.name, 120);
  const email = clean(body.email, 254).toLowerCase();
  const message = String(body.message || "").trim().slice(0, 5000);
  if (!name || !message) return json({ error: "Name and message are required" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address" }, 400);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [env.CONTACT_TO_EMAIL],
      reply_to: email,
      subject: "Website message from " + name,
      html: "<p><strong>" + escapeHtml(name) + "</strong> (" + escapeHtml(email) + ")</p><p style=\"white-space:pre-wrap\">" + escapeHtml(message) + "</p>",
    }),
  });
  if (!response.ok) {
    console.error("Contact delivery failed", response.status, (await response.text().catch(() => "")).slice(0, 500));
    return json({ error: "Your message could not be sent. Please try again later." }, 502);
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === "POST" && new URL(request.url).pathname === "/api/contact") return await submitContact(request, env);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: "Unexpected error" }, 500);
    }
  },
};
