const express = require('express');
const path    = require('path');
const { MongoClient } = require('mongodb');
const { v4: uuid }    = require('uuid');

const app  = express();
const PORT = process.env.PORT || 10000;

// ─── Variables d'environnement (Render) ───
// MONGO_URI          → MongoDB Atlas
// ANTHROPIC_API_KEY  → Clé Claude pour la modération IA
// ADMIN_PASSWORD     → Mot de passe admin (page /admin)
// FORMSPREE_URL      → https://formspree.io/f/xwvoaroz
const uri             = process.env.MONGO_URI;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || 'goldadmin2024';
const FORMSPREE_URL   = process.env.FORMSPREE_URL  || 'https://formspree.io/f/xwvoaroz';

const client = new MongoClient(uri);
let gallery, pending; // pending = œuvres bloquées en attente de contrôle humain

async function connectDB() {
  try {
    if (!uri) { console.error('❌ MONGO_URI manquante !'); return; }
    await client.connect();
    const db = client.db('goldpixel_db');
    gallery  = db.collection('artworks');
    pending  = db.collection('pending_review'); // nouvelle collection
    console.log('✅ Gold Pixel connecté à MongoDB Atlas');
  } catch (e) { console.error('❌ Erreur DB:', e); }
}
connectDB();

// ════════════════════════════════════════════
//  CORS
// ════════════════════════════════════════════
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,PUT,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

// ════════════════════════════════════════════
//  RÈGLES DE MODÉRATION
//  ► Modifie ce tableau pour ajouter/retirer des règles.
// ════════════════════════════════════════════
const MODERATION_RULES = [
  'Nudité ou contenu sexuel explicite (organes génitaux, formes suggestives claires, scènes sexuelles)',
  'Violence graphique (sang, mutilations, torture)',
  'Symboles de haine : croix gammée, symboles nazis, KKK, etc.',
  'Représentation de drogue (seringues, pipes, lignes de poudre)',
  'Mots ou abréviations grossiers/insultants écrits en pixel art',
  "Représentation menaçante d'armes",
];

const BANNED_WORDS = [
  'PD','PEDE','CON','CONNE','CONNARD','CONNASSE',
  'MERDE','FUCK','SHIT','BITCH','SALOPE','PUTE','PUTAIN',
  'BITE','PINE','COUILLE','CUL','CHIER','NIQUER','BAISER',
  'NAZI','HITLER','KKK','NIGGER','NEGRE',
  'SEX','SEXY','PORN','CACA','PIPI',
];

function buildVisualPrompt() {
  const rules = MODERATION_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');
  return `Tu es modérateur strict d'un jeu de pixel art familial "Gold Pixel", accessible aux enfants.
L'image est agrandie — chaque carré de couleur est un pixel original.
Réponds UNIQUEMENT par un JSON sur une seule ligne, sans rien d'autre.
REJETTE si l'image contient clairement :
${rules}
NOTES : Lis attentivement toute forme ressemblant à des lettres. 2-3 lettres formant un mot interdit = rejet. En cas de doute sur un texte = rejette.
{"ok":true} si acceptable
{"ok":false,"reason":"règle enfreinte en français"} si refusé`;
}

function buildTextPrompt() {
  return `Tu es un détecteur de texte dans un pixel art agrandi.
Lis TOUTES les formes ressemblant à des lettres ou mots, même imparfaits.
Mots interdits (insensible à la casse) : ${BANNED_WORDS.join(', ')}
Réponds UNIQUEMENT par un JSON sur une seule ligne :
{"text_found":false}
{"text_found":true,"word":"MOT_DÉTECTÉ"}`;
}

async function upscaleImage(base64img) {
  try {
    const { createCanvas, loadImage } = require('canvas');
    const img = await loadImage(base64img);
    const cv  = createCanvas(img.width * 2, img.height * 2);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, img.width * 2, img.height * 2);
    return cv.toDataURL('image/jpeg', 0.92);
  } catch (_) { return base64img; }
}

async function callClaude(base64img, prompt, maxTokens) {
  const match = base64img.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-opus-4-5', max_tokens: maxTokens,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } },
        { type: 'text', text: prompt }
      ]}]
    })
  });
  if (!resp.ok) { console.error('❌ Claude API:', resp.status); return null; }
  const data = await resp.json();
  return (data.content?.[0]?.text || '').trim();
}

async function moderateImage(base64img) {
  if (!ANTHROPIC_KEY) { console.warn('⚠️ Modération désactivée (pas de clé)'); return { ok: true }; }
  try {
    const img  = await upscaleImage(base64img);
    const raw1 = await callClaude(img, buildVisualPrompt(), 80);
    if (!raw1) return { ok: true };
    let r1;
    try { r1 = JSON.parse(raw1); } catch (_) { r1 = { ok: true }; }
    console.log('  Passe 1:', r1);
    if (!r1.ok) return r1;
    const raw2 = await callClaude(img, buildTextPrompt(), 60);
    if (!raw2) return { ok: true };
    let r2;
    try { r2 = JSON.parse(raw2); } catch (_) { r2 = { text_found: false }; }
    console.log('  Passe 2:', r2);
    if (r2.text_found) return { ok: false, reason: `Mot interdit détecté : "${r2.word || '?'}"` };
    return { ok: true };
  } catch (e) { console.error('❌ Erreur modération:', e.message); return { ok: true }; }
}

// ════════════════════════════════════════════
//  NOTIFICATION EMAIL — Formspree
// ════════════════════════════════════════════
async function sendReviewEmail({ name, title, reason, reviewId }) {
  try {
    const adminUrl = `https://gold-pixel.onrender.com/admin`;
    const body = {
      _subject: `[Gold Pixel] Contrôle humain demandé — "${title}" par @${name}`,
      message:  `Une œuvre a été bloquée par la modération IA et le joueur demande un contrôle humain.\n\n` +
                `Pseudo    : @${name}\n` +
                `Titre     : ${title}\n` +
                `Raison IA : ${reason}\n` +
                `ID review : ${reviewId}\n\n` +
                `👉 Valider ou rejeter ici : ${adminUrl}`,
      name,
      title,
      reason,
      reviewId,
    };
    const resp = await fetch(FORMSPREE_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify(body)
    });
    if (resp.ok) console.log('📧 Email admin envoyé via Formspree');
    else console.error('❌ Formspree error:', resp.status, await resp.text());
  } catch (e) { console.error('❌ Erreur envoi email:', e.message); }
}

// ════════════════════════════════════════════
//  MIDDLEWARE AUTH ADMIN
// ════════════════════════════════════════════
function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.body?.adminPassword || req.query?.adminPassword;
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

// ════════════════════════════════════════════
//  ROUTES API — GALERIE
// ════════════════════════════════════════════

// GET — Toutes les œuvres publiées
app.get('/api/gallery', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const arts = await gallery
      .find({}, { projection: { deleteCode: 0 } })
      .sort({ createdAt: -1 }).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// GET — Top 10 par œuvre (votes)
app.get('/api/top10', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const arts = await gallery
      .find({}, { projection: { deleteCode: 0 } })
      .sort({ votes: -1 }).limit(10).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// GET — Top 10 par pseudo (somme des votes de toutes leurs œuvres)
app.get('/api/top10-players', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const players = await gallery.aggregate([
      { $group: {
          _id:        '$name',
          totalVotes: { $sum: '$votes' },
          artCount:   { $sum: 1 },
          bestTitle:  { $first: '$title' },
          bestImg:    { $first: '$img' },
      }},
      { $sort: { totalVotes: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, name: '$_id', totalVotes: 1, artCount: 1, bestTitle: 1, bestImg: 1 } }
    ]).toArray();
    res.json(players);
  } catch (e) { res.status(500).json([]); }
});

// GET — TOUS les joueurs (annuaire complet, trié par nombre d'œuvres puis votes)
app.get('/api/all-players', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const players = await gallery.aggregate([
      { $group: {
          _id:        '$name',
          totalVotes: { $sum: '$votes' },
          artCount:   { $sum: 1 },
          lastArtAt:  { $max: '$createdAt' },
          bestImg:    { $first: '$img' },
      }},
      { $sort: { artCount: -1, totalVotes: -1 } }, // tri : le plus actif en premier
      { $project: { _id: 0, name: '$_id', totalVotes: 1, artCount: 1, lastArtAt: 1, bestImg: 1 } }
    ]).toArray();
    res.json(players);
  } catch (e) { res.status(500).json([]); }
});

// GET — Œuvres d'un joueur par pseudo
app.get('/api/player/:name', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const name = decodeURIComponent(req.params.name);
    const arts = await gallery
      .find({ name }, { projection: { deleteCode: 0 } })
      .sort({ votes: -1 }).toArray();
    const totalVotes = arts.reduce((sum, a) => sum + (a.votes || 0), 0);
    res.json({ name, arts, totalVotes });
  } catch (e) { res.status(500).json({ arts: [], totalVotes: 0 }); }
});

// POST — Sauvegarder une œuvre
app.post('/api/save', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const { name, title, img, deleteCode } = req.body;
    if (!name || !title || !img) return res.status(400).json({ error: 'Données manquantes' });
    const code = String(deleteCode || '').trim();
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Code : exactement 4 chiffres' });

    console.log(`\n🎨 Publication de "${title}" par @${name}`);
    const mod = await moderateImage(img);
    if (!mod.ok) {
      console.warn(`🚫 Bloqué : ${mod.reason}`);
      return res.status(422).json({
        error:         'CONTENU_INAPPROPRIÉ',
        message:       mod.reason || 'Image non conforme',
        canRequestReview: true // le client sait qu'il peut demander un contrôle humain
      });
    }

    const artwork = {
      id: uuid(), name: name.trim().substring(0, 50),
      title: title.trim().substring(0, 80), img,
      votes: 0, voters: [], deleteCode: code, createdAt: new Date()
    };
    await gallery.insertOne(artwork);
    console.log(`✅ "${title}" sauvegardée`);
    res.json({ id: artwork.id, success: true });
  } catch (e) {
    console.error('Erreur /api/save:', e);
    res.status(500).json({ error: 'Échec sauvegarde' });
  }
});

// POST — Demande de contrôle humain (après rejet IA)
// L'œuvre est stockée dans pending_review en attente de validation admin
app.post('/api/request-review', async (req, res) => {
  try {
    if (!pending) return res.status(503).json({ error: 'DB non connectée' });
    const { name, title, img, deleteCode, reason } = req.body;
    if (!name || !title || !img) return res.status(400).json({ error: 'Données manquantes' });
    const code = String(deleteCode || '').trim();
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Code : exactement 4 chiffres' });

    // Vérifier qu'il n'y a pas déjà une demande identique en attente
    const existing = await pending.findOne({ name: name.trim(), title: title.trim(), status: 'pending' });
    if (existing) return res.status(409).json({ error: 'Une demande est déjà en attente pour cette œuvre' });

    const reviewId = uuid();
    const doc = {
      reviewId,
      name:       name.trim().substring(0, 50),
      title:      title.trim().substring(0, 80),
      img,
      deleteCode: code,
      reason:     reason || 'Raison IA inconnue',
      status:     'pending', // pending | approved | rejected
      createdAt:  new Date()
    };
    await pending.insertOne(doc);
    console.log(`📋 Demande de contrôle humain #${reviewId} pour "${title}" par @${name}`);

    // Envoyer l'email de notification via Formspree
    await sendReviewEmail({ name: doc.name, title: doc.title, reason: doc.reason, reviewId });

    res.json({ success: true, reviewId, message: 'Demande envoyée — tu seras notifié par l\'admin' });
  } catch (e) {
    console.error('Erreur /api/request-review:', e);
    res.status(500).json({ error: 'Échec de la demande' });
  }
});

// POST — Vote
app.post('/api/vote', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID manquant' });
    const art = await gallery.findOne({ id });
    if (!art) return res.status(404).json({ error: 'Œuvre introuvable' });
    await gallery.updateOne({ id }, { $inc: { votes: 1 } });
    const updated = await gallery.findOne({ id });
    res.json({ votes: updated ? updated.votes : 0 });
  } catch (e) { res.status(500).json({ error: 'Erreur vote' }); }
});

// DELETE — Créateur ou Admin
app.delete('/api/artwork/:id', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const { id } = req.params;
    const { deleteCode, adminPassword } = req.body;
    const art = await gallery.findOne({ id });
    if (!art) return res.status(404).json({ error: 'Œuvre introuvable' });
    const isAdmin   = adminPassword && adminPassword === ADMIN_PASSWORD;
    const isCreator = deleteCode    && deleteCode    === art.deleteCode;
    if (!isAdmin && !isCreator) return res.status(403).json({ error: 'Code incorrect' });
    await gallery.deleteOne({ id });
    console.log(`🗑  "${art.title}" supprimée par ${isAdmin ? 'ADMIN' : `@${art.name}`}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

// ════════════════════════════════════════════
//  ROUTES API — ADMIN (protégées)
// ════════════════════════════════════════════

// GET — Liste des œuvres en attente de contrôle humain
app.get('/api/admin/pending', requireAdmin, async (req, res) => {
  try {
    if (!pending) return res.status(503).json({ error: 'DB non connectée' });
    const docs = await pending.find({ status: 'pending' }).sort({ createdAt: -1 }).toArray();
    res.json(docs);
  } catch (e) { res.status(500).json([]); }
});

// PUT — Valider une œuvre en attente → la publier dans la galerie
app.put('/api/admin/approve/:reviewId', requireAdmin, async (req, res) => {
  try {
    if (!pending || !gallery) return res.status(503).json({ error: 'DB non connectée' });
    const { reviewId } = req.params;
    const doc = await pending.findOne({ reviewId });
    if (!doc) return res.status(404).json({ error: 'Demande introuvable' });

    // Publier dans la galerie
    const artwork = {
      id: uuid(), name: doc.name, title: doc.title, img: doc.img,
      votes: 0, voters: [], deleteCode: doc.deleteCode,
      createdAt: new Date(), approvedByAdmin: true
    };
    await gallery.insertOne(artwork);
    await pending.updateOne({ reviewId }, { $set: { status: 'approved', resolvedAt: new Date() } });
    console.log(`✅ ADMIN a approuvé "${doc.title}" de @${doc.name}`);
    res.json({ success: true, artworkId: artwork.id });
  } catch (e) { res.status(500).json({ error: 'Erreur approbation' }); }
});

// PUT — Rejeter définitivement une œuvre en attente
app.put('/api/admin/reject/:reviewId', requireAdmin, async (req, res) => {
  try {
    if (!pending) return res.status(503).json({ error: 'DB non connectée' });
    const { reviewId } = req.params;
    const { rejectReason } = req.body;
    const doc = await pending.findOne({ reviewId });
    if (!doc) return res.status(404).json({ error: 'Demande introuvable' });
    await pending.updateOne({ reviewId }, {
      $set: { status: 'rejected', rejectReason: rejectReason || 'Non conforme', resolvedAt: new Date() }
    });
    console.log(`🚫 ADMIN a rejeté "${doc.title}" de @${doc.name}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur rejet' }); }
});

// GET — Stats admin (nombre d'œuvres, en attente, votes totaux)
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [totalArts, pendingCount, totalVotesRes] = await Promise.all([
      gallery.countDocuments(),
      pending.countDocuments({ status: 'pending' }),
      gallery.aggregate([{ $group: { _id: null, total: { $sum: '$votes' } } }]).toArray()
    ]);
    res.json({
      totalArts,
      pendingCount,
      totalVotes: totalVotesRes[0]?.total || 0
    });
  } catch (e) { res.status(500).json({}); }
});

// ════════════════════════════════════════════
//  FICHIERS STATIQUES
// ════════════════════════════════════════════
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  next();
});
app.use(express.static(path.join(__dirname), { index: false }));
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/goldpixel', (req, res) => res.sendFile(path.join(__dirname, 'goldpixel.html')));
app.get('/admin',     (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.all('/api/*',     (req, res) => res.status(404).json({ error: `Route inconnue: ${req.method} ${req.path}` }));

app.listen(PORT, () => console.log(`🚀 Gold Pixel prêt sur le port ${PORT}`));
