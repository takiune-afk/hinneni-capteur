// Le capteur du suivi Hinneni — Cloudflare Pages, mode "_worker.js" (à plat).
// Un seul fichier gère /api/* ; tout le reste sert les fichiers statiques (index.html).
// Protections :
//   - CAPTEUR_CODE  : code des responsables (lecture tableau de bord, remontées, inscriptions).
//   - INGEST_TOKEN  : jeton secret de l'Apps Script, pour DÉPOSER une inscription.
// Stockage KV (binding CAPTEUR_KV). Un enregistrement = une clé :
//   roster / entry:<id> / inscr:<id>

const INSCR_FIELDS = ["prenom", "nom", "eglise", "telephone", "email", "remarques"];

// Documents servis dans l'onglet « Ressources », gardés par le code.
// Fichiers déposés dans public/docs/. Accès direct à /docs/* bloqué : tout passe par /api/doc.
const DOCS_RESP = [
  "25_Manuel_de_l_animatrice.pdf",
  "13_Guide_du_suivi_local.pdf", "14_Les_quatre_cercles.pdf", "24_Le_suivi_a_deux.pdf",
  "15_Fiche_de_remontee.pdf", "18_Tu_arrives_en_cours_de_route.pdf", "17_Activites_pratiques.pdf",
  "16_Auto_evaluation_Ou_j_en_suis.pdf", "23_Amener_une_amie.pdf", "21_La_carte_de_la_responsable.pdf",
];
const DOCS_ADMIN = [
  "00_Sommaire_Hinneni3.pdf", "19_Former_les_responsables.pdf", "20_Le_cercle_des_responsables.pdf",
  "22_Les_traces_du_fruit.pdf", "Hinneni_3_KIT_COMPLET.pdf",
];
function docAllowed(f, isAdmin) {
  if (DOCS_RESP.includes(f)) return true;
  if (isAdmin && DOCS_ADMIN.includes(f)) return true;
  return false;
}
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

  // Téléchargement d'un document du kit — gardé par le code, filtré par rôle.
  if (method === "GET" && path.endsWith("/doc")) {
    const f = url.searchParams.get("f") || "";
    if (!docAllowed(f, isAdmin)) return json({ error: "forbidden" }, 403);
    const assetUrl = new URL(request.url);
    assetUrl.pathname = "/docs/" + f;
    assetUrl.search = "";
    const res = await env.ASSETS.fetch(new Request(assetUrl.toString()));
    if (!res.ok) return json({ error: "not_found" }, 404);
    const h = new Headers(res.headers);
    h.set("content-disposition", 'attachment; filename="' + f + '"');
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
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
    // Accès direct aux documents bloqué : ils ne sortent que par /api/doc, après le code.
    if (url.pathname.startsWith("/docs/")) return new Response("Not found", { status: 404 });
    // tout le reste : les fichiers statiques (index.html, etc.)
    return env.ASSETS.fetch(request);
  },
};
