# Le capteur du suivi — version Cloudflare Pages

Même capteur que la version Netlify, porté sur **Cloudflare Pages + KV**.
La page (`public/index.html`) est identique ; seule la fonction serveur change
(`functions/api/[[path]].js`) et le stockage passe à **Cloudflare KV**.

## Structure

```
capteur-cloudflare/
  public/index.html            → le tableau de bord (statique)
  functions/api/[[path]].js    → la fonction, attrape tout /api/*
  wrangler.toml
```

## Les deux portes de la fonction

- `POST /api/inscription` — dépôt d'une inscription (page publique). Exige l'en-tête
  `x-ingest-token` = `INGEST_TOKEN`. Écriture seule.
- `GET /api/inscriptions` — lecture (onglet « Inscriptions »). Exige `x-capteur-code` = `CAPTEUR_CODE`.
- `GET /api/state`, `POST /api/entry`, `POST /api/roster` — comme avant, protégés par le code.

## Déployer (une seule fois)

### 1. Créer le stockage KV
```
npx wrangler kv namespace create CAPTEUR_KV
```
Copie l'`id` renvoyé dans `wrangler.toml` (ligne `id = "..."`).

### 2. Déployer la page + la fonction
Deux voies :

- **Par dépôt Git (recommandé).** Pousse ce dossier sur GitHub/GitLab, puis
  Cloudflare → **Workers & Pages → Create → Pages → Connect to Git**.
  Réglages de build : *Build command* vide, *Build output directory* = `public`.
  Cloudflare détecte le dossier `functions/` tout seul.
- **Par la CLI.** Depuis ce dossier : `npx wrangler pages deploy public`.

### 3. Lier le KV au projet Pages
Dashboard → ton projet Pages → **Settings → Functions → KV namespace bindings** →
*Add binding* : nom **`CAPTEUR_KV`**, choisir le namespace créé à l'étape 1.
(Si tu as déployé par Git avec le `wrangler.toml` rempli, le binding est déjà pris en compte.)

### 4. Les secrets
Dashboard → **Settings → Environment variables** (Production), ajoute :
- `CAPTEUR_CODE` — le code des responsables.
- `INGEST_TOKEN` — un mot secret différent, le même que dans l'Apps Script.

Puis **redéploie** une fois pour que variables et binding soient pris en compte.

### 5. Relier l'Apps Script
Dans `AppsScript_routage_suivi.gs`, mets :
- `CAPTEUR_URL` = l'adresse de ton projet Pages (ex. `https://hinneni-capteur.pages.dev`)
- `INGEST_TOKEN` = le même mot qu'à l'étape 4.
Redéploie l'Apps Script.

## Pourquoi « un enregistrement = une clé »

Le KV de Cloudflare est en cohérence *éventuelle* : réécrire une grande liste à
chaque inscription ferait perdre des écritures simultanées. Ici, chaque inscription
et chaque remontée ont leur propre clé (`inscr:<id>`, `entry:<id>`), donc deux
personnes qui enregistrent en même temps ne s'écrasent jamais. Le tableau de bord
relit tout par préfixe. À l'échelle de 400 femmes et dix églises, c'est large.
