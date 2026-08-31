// Le capteur du suivi Hinneni — Cloudflare Pages, mode "_worker.js" (à plat).
// Un seul fichier gère /api/* ; tout le reste sert les fichiers statiques (index.html).
// Protections :
//   - CAPTEUR_CODE  : code des responsables (lecture tableau de bord, remontées, inscriptions).
//   - INGEST_TOKEN  : jeton secret de l'Apps Script, pour DÉPOSER une inscription.
// Stockage KV (binding CAPTEUR_KV). Un enregistrement = une clé :
//   roster / entry:<id> / inscr:<id>

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

  // PORTE PUBLIQUE : dépôt d'une inscription (jeton d'ingestion)
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

  // --- Authentification par RÔLE ---
  // Admin (env CAPTEUR_CODE) = voit tout. Sinon, le code d'une église = ne voit QUE cette église.
  if (!env.CAPTEUR_CODE) return json({ error: "server_not_configured" }, 500);
  const given = request.headers.get("x-capteur-code") || "";
  const churches = (await kv.get("churches", "json")) || []; // [{name, code}]
  const isAdmin = given === env.CAPTEUR_CODE;
  let myEglise = "";
  if (!isAdmin) {
    const found = churches.find((c) => c && c.code && c.code === given);
    if (found) myEglise = found.name;
  }
  if (!isAdmin && !myEglise) return json({ error: "unauthorized" }, 401);
  const churchNames = churches.map((c) => c && c.name).filter(Boolean);
  const mine = (arr) => (isAdmin ? arr : arr.filter((x) => x.eglise === myEglise));

  if (method === "GET" && path.endsWith("/state")) {
    const entries = mine(await listByPrefix(kv, "entry:"));
    return json({
      role: isAdmin ? "admin" : "church",
      eglise: myEglise,
      eglises: churchNames,
      churches: isAdmin ? churches : [], // codes visibles seulement pour l'admin
      entries,
    });
  }
  if (method === "GET" && path.endsWith("/inscriptions")) {
    const inscriptions = mine(await listByPrefix(kv, "inscr:"));
    return json({ inscriptions, role: isAdmin ? "admin" : "church", eglise: myEglise });
  }

  if (method === "POST" && path.endsWith("/inscription/delete")) {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const id = clean(body && body.id);
    if (!id) return json({ error: "missing_id" }, 400);
    if (!isAdmin) {
      const rec = await kv.get("inscr:" + id, "json");
      if (!rec || rec.eglise !== myEglise) return json({ error: "forbidden" }, 403);
    }
    await kv.delete("inscr:" + id);
    return json({ ok: true });
  }
  if (method === "POST" && path.endsWith("/entry")) {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const entry = {};
    for (const f of FIELDS) entry[f] = clean(body[f]);
    if (!isAdmin) entry.eglise = myEglise; // une responsable remonte forcément pour SON église
    if (!clean(entry.eglise).trim()) return json({ error: "missing_eglise" }, 400);
    entry.id = newId(); entry.ts = String(Date.now());
    await kv.put("entry:" + entry.id, JSON.stringify(entry));
    const entries = mine(await listByPrefix(kv, "entry:"));
    return json({ ok: true, state: { eglises: churchNames, entries } });
  }
  // Gestion des églises + codes — ADMIN uniquement
  if (method === "POST" && path.endsWith("/roster")) {
    if (!isAdmin) return json({ error: "forbidden" }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const arr = Array.isArray(body.churches)
      ? body.churches
          .map((c) => ({ name: clean(c && c.name).trim(), code: clean(c && c.code).trim() }))
          .filter((c) => c.name)
          .slice(0, 100)
      : [];
    await kv.put("churches", JSON.stringify(arr));
    return json({ ok: true, churches: arr, eglises: arr.map((c) => c.name) });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    // tout le reste : les fichiers statiques (index.html, etc.)
    return env.ASSETS.fetch(request);
  },
};
