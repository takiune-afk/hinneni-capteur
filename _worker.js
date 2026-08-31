const INSCR_FIELDS = ["prenom", "nom", "eglise", "telephone", "email", "remarques"];
const FIELDS = [
  "eglise", "mois", "cercle", "presentes", "envoyees", "nouvelles",
  "binome", "aTenu", "coince", "aPorter", "ecoutee", "boucler", "besoin", "pourquoi",
];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-capteur-code,x-ingest-token",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}
function clean(v) { return String(v == null ? "" : v).slice(0, 2000); }
function newId() { return Date.now() + "-" + Math.random().toString(36).slice(2, 7); }

async function listByPrefix(kv, prefix) {
  const out = [];
  let cursor;
  do {
    const res = await kv.list({ prefix, cursor });
    for (const k of res.keys) {
      const v = await kv.get(k.name, "json");
      if (v) out.push(v);
    }
    if (res.list_complete) break;
    cursor = res.cursor;
  } while (cursor);
  out.sort((a, b) => (+a.ts || 0) - (+b.ts || 0));
  return out;
}

async function handleApi(request, env) {
  const kv = env.CAPTEUR_KV;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!kv) return json({ error: "kv_not_bound" }, 500);

  if (method === "POST" && path.endsWith("/inscription")) {
    if (!env.INGEST_TOKEN) return json({ error: "ingest_not_configured" }, 500);
    if ((request.headers.get("x-ingest-token") || "") !== env.INGEST_TOKEN) return json({ error: "unauthorized" }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!body || !clean(body.eglise).trim()) return json({ error: "missing_eglise" }, 400);
    const rec = {};
    for (const f of INSCR_FIELDS) rec[f] = clean(body[f]);
    rec.id = newId(); rec.ts = String(Date.now());
    await kv.put("inscr:" + rec.id, JSON.stringify(rec));
    return json({ ok: true });
  }

  if (!env.CAPTEUR_CODE) return json({ error: "server_not_configured" }, 500);
  if ((request.headers.get("x-capteur-code") || "") !== env.CAPTEUR_CODE) return json({ error: "unauthorized" }, 401);

  if (method === "GET" && path.endsWith("/state")) {
    const eglises = (await kv.get("roster", "json")) || [];
    const entries = await listByPrefix(kv, "entry:");
    return json({ eglises, entries });
  }
  if (method === "GET" && path.endsWith("/inscriptions")) {
    const inscriptions = await listByPrefix(kv, "inscr:");
    return json({ inscriptions });
  }
  if (method === "POST" && path.endsWith("/entry")) {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!body || !clean(body.eglise).trim()) return json({ error: "missing_eglise" }, 400);
    const entry = {};
    for (const f of FIELDS) entry[f] = clean(body[f]);
    entry.id = newId(); entry.ts = String(Date.now());
    await kv.put("entry:" + entry.id, JSON.stringify(entry));
    const eglises = (await kv.get("roster", "json")) || [];
    const entries = await listByPrefix(kv, "entry:");
    return json({ ok: true, state: { eglises, entries } });
  }
  if (method === "POST" && path.endsWith("/roster")) {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const eglises = Array.isArray(body.eglises)
      ? body.eglises.map((x) => clean(x).trim()).filter(Boolean).slice(0, 50) : [];
    await kv.put("roster", JSON.stringify(eglises));
    const entries = await listByPrefix(kv, "entry:");
    return json({ ok: true, state: { eglises, entries } });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
