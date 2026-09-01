// Le capteur du suivi Hinneni — Cloudflare Pages, mode "_worker.js" (à plat).
// Un seul fichier gère /api/* ; tout le reste sert les fichiers statiques (index.html).
// Protections :
//   - CAPTEUR_CODE  : code administrateur (pasteur). Voit tout.
//   - INGEST_TOKEN  : jeton pour DÉPOSER une inscription depuis la page publique.
//   - TG_TOKEN      : (facultatif) jeton du bot Telegram. S'il est absent, aucune alerte n'est envoyée
//                     et tout le reste fonctionne comme avant. Créé gratuitement via @BotFather.
//   - TG_SECRET     : (facultatif) secret du webhook Telegram (setWebhook ...&secret_token=...).
// Stockage KV (binding CAPTEUR_KV). Un enregistrement = une clé :
//   churches / entry:<id> / inscr:<id> / tgchat:<église> / tgpasteur

const INSCR_FIELDS = ["prenom", "nom", "eglise", "telephone", "email", "remarques"];

// Cible de santé d'un groupe : 6 sœurs inscrites (l'animatrice en plus, elle ne s'inscrit pas).
// Doit rester égale à CIBLE dans index.html, pour que le message « au complet » tombe quand le voyant passe au vert.
const CIBLE = 6;

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
function getCookie(request, name) {
  const c = request.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}
function newId() { return Date.now() + "-" + Math.random().toString(36).slice(2, 7); }

// --- Téléphone : clé de dédoublonnage (9 derniers chiffres, ignore espaces/points/+262) ---
function digits(s) { return String(s == null ? "" : s).replace(/\D+/g, ""); }
function phoneKey(s) { return digits(s).slice(-9); }

// --- Envoi Telegram (gratuit). N'échoue jamais l'inscription : tout est try/catch + timeout. ---
async function tgSend(env, chatId, text) {
  if (!env.TG_TOKEN || !chatId) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch("https://api.telegram.org/bot" + env.TG_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return r.ok;
  } catch (e) { return false; }
}

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

    // Dédoublonnage : même église + même téléphone (ou, faute de tel, même prénom+nom).
    // Un double clic ou un rafraîchissement ne crée plus une seconde inscription ni une seconde alerte.
    const existing = (await listByPrefix(kv, "inscr:")).filter((x) => x.eglise === rec.eglise);
    const pk = phoneKey(rec.telephone);
    const nameKey = (clean(rec.prenom) + "|" + clean(rec.nom)).toLowerCase().trim();
    const isDup = existing.some((x) => {
      if (pk && pk.length >= 6) return phoneKey(x.telephone) === pk;
      return nameKey !== "|" && (clean(x.prenom) + "|" + clean(x.nom)).toLowerCase().trim() === nameKey;
    });
    if (isDup) return json({ ok: true, duplicate: true });

    await kv.put("inscr:" + rec.id, JSON.stringify(rec));

    // Notification Telegram privée à la responsable de l'église. Si l'église n'est pas liée
    // (ou « Autre »), repli sur le pasteur pour qu'il relaie. L'envoi ne bloque jamais la réponse.
    let chatId = await kv.get("tgchat:" + rec.eglise);
    let head = "🕊️ Nouvelle inscription au suivi";
    if (!chatId) {
      chatId = await kv.get("tgpasteur");
      head = "⚠️ Inscription à relayer — église « " + (rec.eglise || "?") + " » non liée";
    }
    if (chatId) {
      const lines = [head, "", "Église : " + (rec.eglise || "—"), (clean(rec.prenom) + " " + clean(rec.nom)).trim()];
      if (clean(rec.telephone)) lines.push("📞 " + rec.telephone);
      if (clean(rec.email)) lines.push("✉️ " + rec.email);
      if (clean(rec.remarques)) lines.push("« " + rec.remarques + " »");
      lines.push("", "Recontacte-la : donne-lui la date, mets-la en binôme. Elle ne repart pas seule.");
      await tgSend(env, chatId, lines.join("\n"));
    }

    // Message « au complet » : une seule fois, quand l'église atteint tout juste la cible (6 sœurs inscrites).
    // On compte l'inscription qu'on vient d'ajouter ; on ne renvoie rien au-delà de la cible.
    const total = existing.length + 1;
    if (total === CIBLE && chatId) {
      await tgSend(env, chatId, [
        "🎉 Ton groupe est au complet",
        "",
        "Église : " + (rec.eglise || "—"),
        "La cible est atteinte : " + CIBLE + " sœurs inscrites (l'animatrice en plus).",
        "",
        "Tu peux lancer quand tu le sens : fixe la date, le lieu, l'heure. C'est une invitation, pas une obligation.",
      ].join("\n"));
    }
    return json({ ok: true });
  }

  // PORTE TELEGRAM : webhook appelé par Telegram. Une responsable envoie le CODE de son église
  // au bot → on mémorise son chat_id pour lui pousser les inscriptions. Le pasteur lie via le code admin.
  if (method === "POST" && path.endsWith("/tg")) {
    if (!env.TG_TOKEN) return json({ ok: true });
    if (env.TG_SECRET && (request.headers.get("x-telegram-bot-api-secret-token") || "") !== env.TG_SECRET) return json({ ok: true });
    let upd;
    try { upd = await request.json(); } catch { return json({ ok: true }); }
    const msg = upd && (upd.message || upd.edited_message);
    const chatId = msg && msg.chat && msg.chat.id;
    const text = clean(msg && msg.text).trim();
    if (chatId && text) {
      if (text === "/start") {
        await tgSend(env, chatId, "Bienvenue 🌿\nEnvoie-moi le code de ton église pour recevoir ici chaque inscription de tes sœurs.\n(Le pasteur envoie son code administrateur.)");
      } else if (env.CAPTEUR_CODE && text === env.CAPTEUR_CODE) {
        await kv.put("tgpasteur", String(chatId));
        await tgSend(env, chatId, "✅ Lié comme pasteur. Tu recevras en secours les inscriptions des églises non liées.");
      } else {
        const churches = (await kv.get("churches", "json")) || [];
        const found = churches.find((c) => c && c.code && c.code === text);
        if (found) {
          await kv.put("tgchat:" + found.name, String(chatId));
          await tgSend(env, chatId, "✅ C'est lié : « " + found.name + " ».\nTu recevras ici chaque nouvelle inscription pour ton église.");
        } else {
          await tgSend(env, chatId, "Code non reconnu. Envoie le code exact de ton église — le même que pour le tableau de bord.");
        }
      }
    }
    return json({ ok: true });
  }

  // --- Authentification par RÔLE ---
  // Admin (env CAPTEUR_CODE) = voit tout. Sinon, le code d'une église = ne voit QUE cette église.
  if (!env.CAPTEUR_CODE) return json({ error: "server_not_configured" }, 500);
  // Le code arrive par en-tête (fetch de l'app) OU par cookie (ouverture directe d'un PDF dans le cadre).
  const given = request.headers.get("x-capteur-code") || getCookie(request, "capteur_code") || "";
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
    const r = json({
      role: isAdmin ? "admin" : "church",
      eglise: myEglise,
      eglises: churchNames,
      churches: isAdmin ? churches : [], // codes visibles seulement pour l'admin
      entries,
    });
    // Le serveur pose lui-même le cookie du code : ainsi l'ouverture d'un PDF dans un
    // nouvel onglet (qui n'envoie pas d'en-tête) est authentifiée sans dépendre du navigateur.
    r.headers.append("set-cookie", "capteur_code=" + encodeURIComponent(given) + "; Path=/; Max-Age=43200; SameSite=Lax; HttpOnly");
    return r;
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
    const dl = url.searchParams.get("dl") === "1";
    h.set("content-disposition", (dl ? "attachment" : "inline") + '; filename="' + f + '"');
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
