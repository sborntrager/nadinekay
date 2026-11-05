// Free-tier usage alerts for Cloudflare D1 and R2.
// Runs on a cron trigger, reads the GraphQL Analytics API, and emails through Resend
// when a metric crosses WARN_PERCENT / CRITICAL_PERCENT of its free-tier limit.
//
// Secrets:  CF_API_TOKEN (Account Analytics: Read), RESEND_API_KEY, ALERT_TO_EMAIL
// Optional: TRIGGER_KEY (enables GET /run?key=... for manual tests)
// Bindings: ALERT_STATE (KV, de-duplicates alerts; without it every run re-sends)

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const GB = 1024 ** 3;

// Free-tier defaults. Override with LIMIT_* vars if the account moves to a paid plan.
const DEFAULT_LIMITS = {
  d1_rows_read_daily: 5_000_000,
  d1_rows_written_daily: 100_000,
  d1_storage_bytes: 5 * GB,
  r2_storage_bytes: 10 * GB,
  r2_class_a_monthly: 1_000_000,
  r2_class_b_monthly: 10_000_000,
};

const R2_CLASS_A = new Set([
  "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload",
  "CreateMultipartUpload", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts",
  "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration",
]);
const R2_CLASS_B = new Set([
  "HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation",
  "GetBucketCors", "GetBucketLifecycleConfiguration",
]);

function limits(env) {
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(out)) {
    const override = Number(env["LIMIT_" + key.toUpperCase()]);
    if (override > 0) out[key] = override;
  }
  return out;
}

async function graphql(env, query, variables) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { accountTag: env.CF_ACCOUNT_ID, ...variables } }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.errors?.length) {
    const detail = body?.errors?.map(error => error.message).join("; ") || "HTTP " + response.status;
    throw new Error("GraphQL query failed: " + detail);
  }
  return body.data.viewer.accounts[0] || {};
}

const idList = (env, name) => {
  const ids = String(env[name] || "").split(",").map(value => value.trim()).filter(Boolean);
  return ids.length ? ids : null;
};

async function d1Daily(env, now) {
  const today = now.toISOString().slice(0, 10);
  const databaseIds = idList(env, "D1_DATABASE_IDS");
  const filter = databaseIds ? "{ date: $date, databaseId_in: $ids }" : "{ date: $date }";
  const data = await graphql(env, `
    query ($accountTag: String!, $date: Date!, $ids: [string!]) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(limit: 1000, filter: ${filter}) { sum { rowsRead rowsWritten } }
      } }
    }`, { date: today, ids: databaseIds });
  const groups = data.d1AnalyticsAdaptiveGroups || [];
  return {
    rowsRead: groups.reduce((total, group) => total + (group.sum?.rowsRead || 0), 0),
    rowsWritten: groups.reduce((total, group) => total + (group.sum?.rowsWritten || 0), 0),
  };
}

async function d1Storage(env, now) {
  const start = new Date(now.getTime() - 48 * 3600_000).toISOString();
  const databaseIds = idList(env, "D1_DATABASE_IDS");
  const filter = databaseIds
    ? "{ datetime_geq: $start, datetime_leq: $end, databaseId_in: $ids }"
    : "{ datetime_geq: $start, datetime_leq: $end }";
  const data = await graphql(env, `
    query ($accountTag: String!, $start: Time!, $end: Time!, $ids: [string!]) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        d1StorageAdaptiveGroups(limit: 1000, filter: ${filter}) { max { databaseSizeBytes } dimensions { databaseId } }
      } }
    }`, { start, end: now.toISOString(), ids: databaseIds });
  const perDatabase = new Map();
  for (const group of data.d1StorageAdaptiveGroups || []) {
    const id = group.dimensions?.databaseId;
    perDatabase.set(id, Math.max(perDatabase.get(id) || 0, group.max?.databaseSizeBytes || 0));
  }
  return [...perDatabase.values()].reduce((total, size) => total + size, 0);
}

async function r2Storage(env, now) {
  const start = new Date(now.getTime() - 48 * 3600_000).toISOString();
  const buckets = idList(env, "R2_BUCKETS");
  const filter = buckets
    ? "{ datetime_geq: $start, datetime_leq: $end, bucketName_in: $buckets }"
    : "{ datetime_geq: $start, datetime_leq: $end }";
  const data = await graphql(env, `
    query ($accountTag: String!, $start: Time!, $end: Time!, $buckets: [string!]) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        r2StorageAdaptiveGroups(limit: 1000, filter: ${filter}) { max { payloadSize metadataSize } dimensions { bucketName } }
      } }
    }`, { start, end: now.toISOString(), buckets });
  const perBucket = new Map();
  for (const group of data.r2StorageAdaptiveGroups || []) {
    const name = group.dimensions?.bucketName;
    const size = (group.max?.payloadSize || 0) + (group.max?.metadataSize || 0);
    perBucket.set(name, Math.max(perBucket.get(name) || 0, size));
  }
  return [...perBucket.values()].reduce((total, size) => total + size, 0);
}

async function r2Operations(env, now) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const buckets = idList(env, "R2_BUCKETS");
  const filter = buckets
    ? "{ datetime_geq: $start, datetime_leq: $end, bucketName_in: $buckets }"
    : "{ datetime_geq: $start, datetime_leq: $end }";
  const data = await graphql(env, `
    query ($accountTag: String!, $start: Time!, $end: Time!, $buckets: [string!]) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        r2OperationsAdaptiveGroups(limit: 1000, filter: ${filter}) { sum { requests } dimensions { actionType } }
      } }
    }`, { start, end: now.toISOString(), buckets });
  let classA = 0;
  let classB = 0;
  for (const group of data.r2OperationsAdaptiveGroups || []) {
    const action = group.dimensions?.actionType;
    const requests = group.sum?.requests || 0;
    if (R2_CLASS_A.has(action)) classA += requests;
    else if (R2_CLASS_B.has(action)) classB += requests;
  }
  return { classA, classB };
}

const formatBytes = bytes => bytes >= GB ? (bytes / GB).toFixed(2) + " GB" : (bytes / 1024 ** 2).toFixed(2) + " MB";
const formatCount = value => Math.round(value).toLocaleString("en-US");

// Collects every metric. A failing query is reported on its own so one bad
// dataset never hides the rest.
async function collect(env, now = new Date()) {
  const max = limits(env);
  const metrics = [];
  const errors = [];
  const attempt = async (label, run) => {
    try { await run(); } catch (error) { errors.push(label + ": " + error.message); }
  };
  const today = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);

  await attempt("D1 rows", async () => {
    const usage = await d1Daily(env, now);
    metrics.push({ key: "d1_rows_read", period: today, label: "D1 rows read today", used: usage.rowsRead, limit: max.d1_rows_read_daily, format: formatCount });
    metrics.push({ key: "d1_rows_written", period: today, label: "D1 rows written today", used: usage.rowsWritten, limit: max.d1_rows_written_daily, format: formatCount });
  });
  await attempt("D1 storage", async () => {
    metrics.push({ key: "d1_storage", period: "current", label: "D1 storage", used: await d1Storage(env, now), limit: max.d1_storage_bytes, format: formatBytes });
  });
  await attempt("R2 storage", async () => {
    metrics.push({ key: "r2_storage", period: "current", label: "R2 storage", used: await r2Storage(env, now), limit: max.r2_storage_bytes, format: formatBytes });
  });
  await attempt("R2 operations", async () => {
    const usage = await r2Operations(env, now);
    metrics.push({ key: "r2_class_a", period: month, label: "R2 Class A operations this month", used: usage.classA, limit: max.r2_class_a_monthly, format: formatCount });
    metrics.push({ key: "r2_class_b", period: month, label: "R2 Class B operations this month", used: usage.classB, limit: max.r2_class_b_monthly, format: formatCount });
  });

  for (const metric of metrics) metric.percent = (metric.used / metric.limit) * 100;
  return { metrics, errors };
}

function levelFor(percent, env) {
  const warn = Number(env.WARN_PERCENT) || 80;
  const critical = Number(env.CRITICAL_PERCENT) || 95;
  if (percent >= critical) return "critical";
  if (percent >= warn) return "warning";
  return null;
}

async function sendEmail(env, subject, html) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM_EMAIL, to: [env.ALERT_TO_EMAIL], subject, html }),
  });
  if (!response.ok) throw new Error("Alert email failed: " + response.status + " " + (await response.text().catch(() => "")).slice(0, 300));
}

// Sends one email per run listing metrics whose alert level has not been sent for the current
// period. KV remembers the highest level already sent, so a metric alerts at most twice per
// period (warning, then critical) instead of every hour.
async function evaluate(env, { dryRun = false } = {}) {
  const { metrics, errors } = await collect(env);
  const pending = [];
  for (const metric of metrics) {
    const level = levelFor(metric.percent, env);
    if (!level) continue;
    const stateKey = `alert:${metric.key}:${metric.period}`;
    const sent = env.ALERT_STATE ? await env.ALERT_STATE.get(stateKey) : null;
    if (sent === "critical" || sent === level) continue;
    pending.push({ ...metric, level, stateKey });
  }

  if (pending.length && !dryRun) {
    const project = env.PROJECT_NAME || "Project";
    const worst = pending.some(item => item.level === "critical") ? "CRITICAL" : "Warning";
    const rows = pending.map(item =>
      `<li><strong>${item.label}</strong>: ${item.format(item.used)} of ${item.format(item.limit)} (${item.percent.toFixed(1)}%) - ${item.level}</li>`).join("");
    await sendEmail(env, `[${worst}] ${project}: Cloudflare free-tier usage`,
      `<p>These ${project} Cloudflare usage limits are close to the free-tier threshold:</p><ul>${rows}</ul>` +
      "<p>Daily limits reset at 00:00 UTC. Monthly limits reset on the 1st.</p>");
    if (env.ALERT_STATE) {
      await Promise.all(pending.map(item => env.ALERT_STATE.put(item.stateKey, item.level, { expirationTtl: 60 * 60 * 24 * 40 })));
    }
  }
  return {
    metrics: metrics.map(metric => ({ key: metric.key, used: metric.used, limit: metric.limit, percent: Number(metric.percent.toFixed(2)) })),
    alerts: pending.map(item => ({ key: item.key, level: item.level })),
    emailed: pending.length > 0 && !dryRun,
    errors,
  };
}

function checkConfig(env) {
  return ["CF_API_TOKEN", "CF_ACCOUNT_ID", "RESEND_API_KEY", "ALERT_TO_EMAIL", "ALERT_FROM_EMAIL"].filter(key => !env[key]);
}

export default {
  async scheduled(event, env, context) {
    const missing = checkConfig(env);
    if (missing.length) { console.error("usage-alerts not configured, missing: " + missing.join(", ")); return; }
    context.waitUntil(evaluate(env).then(result => {
      if (result.errors.length) console.error("usage-alerts errors:", result.errors.join(" | "));
    }));
  },

  // Manual test route. Disabled unless TRIGGER_KEY is set.
  //   GET /run?key=...            checks usage and emails if needed
  //   GET /run?key=...&dry=1      checks usage, never emails or records state
  //   GET /run?key=...&test=1     sends a test email to confirm delivery
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run" || !env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY) {
      return new Response("Not found", { status: 404 });
    }
    const missing = checkConfig(env);
    if (missing.length) return Response.json({ error: "Missing configuration", missing }, { status: 503 });
    try {
      if (url.searchParams.get("test")) {
        await sendEmail(env, `${env.PROJECT_NAME || "Project"}: usage alert test`, "<p>Usage alert email delivery works.</p>");
        return Response.json({ ok: true, sent: "test email" });
      }
      return Response.json(await evaluate(env, { dryRun: Boolean(url.searchParams.get("dry")) }));
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  },
};
