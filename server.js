const express = require('express');
const path    = require('path');
const { MongoClient } = require('mongodb');
const { v4: uuid }    = require('uuid');

const app  = express();
const PORT = process.env.PORT || 10000;

// ════════════════════════════════════════════
//  VARIABLES D'ENVIRONNEMENT (Render)
//  MONGO_URI         → MongoDB Atlas
//  ANTHROPIC_API_KEY → Modération IA Claude
//  ADMIN_PASSWORD    → Mot de passe page /admin
//  FORMSPREE_URL     → Notifications email
//  PI_API_KEY        → Clé API Pi Network
// ════════════════════════════════════════════
const uri             = process.env.MONGO_URI;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || 'goldadmin2024';
const FORMSPREE_URL   = process.env.FORMSPREE_URL   || 'https://formspree.io/f/xwvoaroz';
const PI_API_KEY      = process.env.PI_API_KEY;
const PI_API_BASE     = 'https://api.minepi.com/v2';

// ── Collections MongoDB ──
const client = new MongoClient(uri);
let gallery;   // œuvres publiées
let pending;   // œuvres en attente de validation admin
let members;   // membres Gold (abonnement Pi)

async function connectDB() {
  try {
    if (!uri) { console.error('❌ MONGO_URI manquante'); return; }
    await client.connect();
    const db = client.db('goldpixel_db');
    gallery = db.collection('artworks');
    pending = db.collection('pending_review');
    members = db.collection('members');           // NEW : membres Gold
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
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-password');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

// ════════════════════════════════════════════
//  MIDDLEWARE AUTH ADMIN
// ════════════════════════════════════════════
function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.body?.adminPassword || req.query?.adminPassword;
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

// ════════════════════════════════════════════
//  HELPERS PI NETWORK
// ════════════════════════════════════════════

// Appelle l'API Pi Network
async function piCall(endpoint, method = 'GET', body = null) {
  if (!PI_API_KEY) throw new Error('PI_API_KEY manquante');
  const opts = {
    method,
    headers: {
      'Authorization': `Key ${PI_API_KEY}`,
      'Content-Type':  'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${PI_API_BASE}${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Pi API error ${res.status}`);
  return data;
}

// Vérifie si un joueur est Gold actif
async function isGoldMember(piUsername) {
  if (!members) return false;
  const member = await members.findOne({ piUsername: piUsername.toLowerCase() });
  if (!member) return false;
  // Vérifie que l'abonnement est encore valide
  return member.goldUntil && new Date(member.goldUntil) > new Date();
}

// Active ou renouvelle le statut Gold pour 30 jours
async function activateGold(piUid, piUsername) {
  if (!members) return;
  const now      = new Date();
  const existing = await members.findOne({ piUid });
  let goldUntil;

  if (existing && existing.goldUntil && new Date(existing.goldUntil) > now) {
    // Renouvellement : ajoute 30 jours à la date existante
    goldUntil = new Date(existing.goldUntil);
    goldUntil.setDate(goldUntil.getDate() + 30);
  } else {
    // Nouvelle activation : 30 jours depuis maintenant
    goldUntil = new Date(now);
    goldUntil.setDate(goldUntil.getDate() + 30);
  }

  await members.updateOne(
    { piUid },
    { $set: {
        piUid,
        piUsername: piUsername.toLowerCase(),
        goldUntil,
        updatedAt: now
      },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true }
  );
  console.log(`🌟 Gold activé pour @${piUsername} jusqu'au ${goldUntil.toLocaleDateString()}`);
}

// ════════════════════════════════════════════
//  RÈGLES DE MODÉRATION IA
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
  if (!ANTHROPIC_KEY) { console.warn('⚠️ Modération désactivée'); return { ok: true }; }
  try {
    const img  = await upscaleImage(base64img);
    const raw1 = await callClaude(img, buildVisualPrompt(), 80);
    if (!raw1) return { ok: true };
    let r1; try { r1 = JSON.parse(raw1); } catch (_) { r1 = { ok: true }; }
    console.log('  Passe 1:', r1);
    if (!r1.ok) return r1;
    const raw2 = await callClaude(img, buildTextPrompt(), 60);
    if (!raw2) return { ok: true };
    let r2; try { r2 = JSON.parse(raw2); } catch (_) { r2 = { text_found: false }; }
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
    await fetch(FORMSPREE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject: `[Gold Pixel] Contrôle humain demandé — "${title}" par @${name}`,
        message:  `Œuvre bloquée par l'IA.\n\nPseudo: @${name}\nTitre: ${title}\nRaison: ${reason}\nID: ${reviewId}\n\nValider: https://gold-pixel.onrender.com/admin`,
        name, title, reason, reviewId
      })
    });
    console.log('📧 Email admin envoyé');
  } catch (e) { console.error('❌ Erreur email:', e.message); }
}

// ════════════════════════════════════════════
//  ROUTES API — MEMBRES & STATUT
// ════════════════════════════════════════════

// GET — Statut Gold d'un joueur
// Retourne isGold, goldUntil, daysLeft
app.get('/api/member/status/:piUsername', async (req, res) => {
  try {
    if (!members) return res.status(503).json({ error: 'DB non connectée' });
    const piUsername = req.params.piUsername.toLowerCase();
    const member = await members.findOne({ piUsername });
    if (!member || !member.goldUntil || new Date(member.goldUntil) <= new Date()) {
      return res.json({ isGold: false, goldUntil: null, daysLeft: 0 });
    }
    const daysLeft = Math.ceil((new Date(member.goldUntil) - new Date()) / (1000 * 60 * 60 * 24));
    res.json({ isGold: true, goldUntil: member.goldUntil, daysLeft });
  } catch (e) { res.status(500).json({ isGold: false }); }
});

// ════════════════════════════════════════════
//  ROUTES API — PI NETWORK PAYMENTS
// ════════════════════════════════════════════

// POST /api/pi/approve
// Appelé par le frontend quand Pi SDK est prêt à soumettre le paiement
// On vérifie le montant et le memo, puis on dit OK à Pi
app.post('/api/pi/approve', async (req, res) => {
  try {
    const { paymentId, piUsername, piUid } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'paymentId manquant' });

    console.log(`\n💰 Approbation paiement ${paymentId} pour @${piUsername}`);

    // Récupère les détails du paiement depuis l'API Pi
    const payment = await piCall(`/payments/${paymentId}`);
    console.log('  Paiement Pi:', { amount: payment.amount, memo: payment.memo, status: payment.status });

    // Vérifications de sécurité
    if (payment.amount !== 1) {
      return res.status(400).json({ error: `Montant incorrect: ${payment.amount} Pi (attendu: 1 Pi)` });
    }
    if (payment.memo !== 'Gold Pixel - Abonnement Gold 1 mois') {
      return res.status(400).json({ error: 'Memo incorrect' });
    }

    // Approuver le paiement auprès de Pi
    await piCall(`/payments/${paymentId}/approve`, 'POST');
    console.log(`  ✅ Paiement ${paymentId} approuvé`);

    // Stocker en attente de completion (avec piUid et piUsername)
    if (members) {
      await members.updateOne(
        { piUid },
        { $set: { piUid, piUsername: piUsername?.toLowerCase(), pendingPaymentId: paymentId, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    res.json({ success: true });
  } catch (e) {
    console.error('❌ Erreur /api/pi/approve:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pi/complete
// Appelé par le frontend quand la transaction blockchain est confirmée
// On complète le paiement et on active le statut Gold
app.post('/api/pi/complete', async (req, res) => {
  try {
    const { paymentId, txid, piUsername, piUid } = req.body;
    if (!paymentId || !txid) return res.status(400).json({ error: 'paymentId ou txid manquant' });

    console.log(`\n✅ Completion paiement ${paymentId} (txid: ${txid}) pour @${piUsername}`);

    // Compléter le paiement auprès de Pi
    await piCall(`/payments/${paymentId}/complete`, 'POST', { txid });
    console.log(`  Paiement ${paymentId} complété sur Pi Network`);

    // Activer le statut Gold dans MongoDB
    await activateGold(piUid, piUsername);

    res.json({ success: true, message: `Statut Gold activé pour @${piUsername} !` });
  } catch (e) {
    console.error('❌ Erreur /api/pi/complete:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pi/incomplete
// Appelé automatiquement par Pi SDK au démarrage de l'app
// si un paiement précédent n'a pas été finalisé
// C'est le remplacement de ton handler Vercel
app.post('/api/pi/incomplete', async (req, res) => {
  try {
    const { payment } = req.body;
    if (!payment) return res.status(400).json({ error: 'Données paiement manquantes' });

    const paymentId = payment.identifier;
    const txid      = payment.transaction?.txid;
    console.log(`\n🔄 Paiement incomplet détecté: ${paymentId} (txid: ${txid || 'aucun'})`);

    if (txid) {
      // Transaction blockchain confirmée → compléter
      await piCall(`/payments/${paymentId}/complete`, 'POST', { txid });
      console.log(`  ✅ Paiement incomplet complété: ${paymentId}`);

      // Activer Gold si on a l'info du joueur
      const piUid      = payment.user_uid;
      const piUsername = payment.memo?.includes('@') ? payment.memo.split('@')[1] : 'unknown';
      if (piUid) await activateGold(piUid, piUsername);
    } else {
      // Pas de transaction → annuler
      await piCall(`/payments/${paymentId}/cancel`, 'POST');
      console.log(`  🚫 Paiement incomplet annulé: ${paymentId}`);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('❌ Erreur /api/pi/incomplete:', e.message);
    // On retourne 200 même en cas d'erreur pour ne pas bloquer Pi SDK
    res.status(200).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
//  ROUTES API — GALERIE
// ════════════════════════════════════════════

// GET — Toutes les œuvres (tri par date ou votes)
app.get('/api/gallery', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    // ?sort=votes → mieux notées | ?sort=new (défaut) → nouveautés
    const sortField = req.query.sort === 'votes' ? 'votes' : 'createdAt';
    const arts = await gallery
      .find({}, { projection: { deleteCode: 0 } })
      .sort({ [sortField]: -1 }).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// GET — Œuvres d'un joueur (pour filtre "Les miens")
app.get('/api/gallery/player/:name', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const name = decodeURIComponent(req.params.name);
    const arts = await gallery
      .find({ name }, { projection: { deleteCode: 0 } })
      .sort({ createdAt: -1 }).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// GET — Top 10 par œuvre
app.get('/api/top10', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const arts = await gallery
      .find({}, { projection: { deleteCode: 0 } })
      .sort({ votes: -1 }).limit(10).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// GET — Top 10 par joueur
app.get('/api/top10-players', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const players = await gallery.aggregate([
      { $group: { _id: '$name', totalVotes: { $sum: '$votes' }, artCount: { $sum: 1 }, bestTitle: { $first: '$title' }, bestImg: { $first: '$img' } } },
      { $sort: { totalVotes: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, name: '$_id', totalVotes: 1, artCount: 1, bestTitle: 1, bestImg: 1 } }
    ]).toArray();
    res.json(players);
  } catch (e) { res.status(500).json([]); }
});

// GET — Tous les joueurs (annuaire)
app.get('/api/all-players', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const players = await gallery.aggregate([
      { $group: { _id: '$name', totalVotes: { $sum: '$votes' }, artCount: { $sum: 1 }, lastArtAt: { $max: '$createdAt' }, bestImg: { $first: '$img' } } },
      { $sort: { artCount: -1, totalVotes: -1 } },
      { $project: { _id: 0, name: '$_id', totalVotes: 1, artCount: 1, lastArtAt: 1, bestImg: 1 } }
    ]).toArray();

    // Enrichit avec le statut Gold
    const now = new Date();
    const goldMembers = await members?.find({ goldUntil: { $gt: now } }, { projection: { piUsername: 1 } }).toArray() || [];
    const goldSet = new Set(goldMembers.map(m => m.piUsername));

    const enriched = players.map(p => ({
      ...p,
      isGold: goldSet.has(p.name.toLowerCase())
    }));

    res.json(enriched);
  } catch (e) { res.status(500).json([]); }
});

// GET — Profil d'un joueur
app.get('/api/player/:name', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const name = decodeURIComponent(req.params.name);
    const arts = await gallery.find({ name }, { projection: { deleteCode: 0 } }).sort({ votes: -1 }).toArray();
    const totalVotes = arts.reduce((s, a) => s + (a.votes || 0), 0);
    const isGold = await isGoldMember(name);
    res.json({ name, arts, totalVotes, isGold });
  } catch (e) { res.status(500).json({ arts: [], totalVotes: 0, isGold: false }); }
});

// ════════════════════════════════════════════
//  ROUTES API — PUBLICATION
// ════════════════════════════════════════════

// POST — Sauvegarder une œuvre
// Vérifie les limites : 1/24h gratuit, 1/30min Gold
app.post('/api/save', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json({ error: 'DB non connectée' });
    const { name, title, img, deleteCode, piUsername } = req.body;
    if (!name || !title || !img) return res.status(400).json({ error: 'Données manquantes' });
    const code = String(deleteCode || '').trim();
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Code : exactement 4 chiffres' });

    // ── Vérification des limites de publication ──
    const authorName = piUsername || name;
    const gold = await isGoldMember(authorName);
    const now  = new Date();

    // Dernière publication de ce joueur
    const lastArt = await gallery.findOne({ name }, { sort: { createdAt: -1 }, projection: { createdAt: 1 } });

    if (lastArt) {
      const diffMs  = now - new Date(lastArt.createdAt);
      const diffMin = diffMs / 60000;

      if (gold) {
        // Gold : délai minimum 30 minutes entre publications
        if (diffMin < 30) {
          const waitMin = Math.ceil(30 - diffMin);
          return res.status(429).json({
            error: 'DÉLAI_GOLD',
            message: `Membre Gold : attends encore ${waitMin} minute${waitMin > 1 ? 's' : ''} avant ta prochaine publication.`
          });
        }
      } else {
        // Gratuit : 1 publication max par 24h
        if (diffMin < 1440) {
          const waitH = Math.ceil((1440 - diffMin) / 60);
          return res.status(429).json({
            error: 'LIMITE_GRATUIT',
            message: `Joueur gratuit : 1 publication / 24h. Reviens dans ${waitH}h ou deviens Membre Gold 🌟`
          });
        }
      }
    }

    // ── Modération IA ──
    console.log(`\n🎨 Publication "${title}" par @${name} (${gold ? 'Gold🌟' : 'Gratuit'})`);
    const mod = await moderateImage(img);
    if (!mod.ok) {
      console.warn(`🚫 Bloqué: ${mod.reason}`);
      return res.status(422).json({ error: 'CONTENU_INAPPROPRIÉ', message: mod.reason, canRequestReview: true });
    }

    const artwork = {
      id:         uuid(),
      name:       name.trim().substring(0, 50),
      title:      title.trim().substring(0, 80),
      img,
      votes:      0,
      voters:     [],
      deleteCode: code,
      isGoldAuthor: gold,   // badge Gold archivé sur l'œuvre
      createdAt:  new Date()
    };
    await gallery.insertOne(artwork);
    console.log(`✅ "${title}" sauvegardée`);
    res.json({ id: artwork.id, success: true });

  } catch (e) {
    console.error('Erreur /api/save:', e);
    res.status(500).json({ error: 'Échec sauvegarde' });
  }
});

// POST — Demande de contrôle humain après rejet IA
app.post('/api/request-review', async (req, res) => {
  try {
    if (!pending) return res.status(503).json({ error: 'DB non connectée' });
    const { name, title, img, deleteCode, reason } = req.body;
    if (!name || !title || !img) return res.status(400).json({ error: 'Données manquantes' });
    const code = String(deleteCode || '').trim();
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Code : exactement 4 chiffres' });

    const existing = await pending.findOne({ name: name.trim(), title: title.trim(), status: 'pending' });
    if (existing) return res.status(409).json({ error: 'Une demande est déjà en attente pour cette œuvre' });

    const reviewId = uuid();
    await pending.insertOne({ reviewId, name: name.trim().substring(0, 50), title: title.trim().substring(0, 80), img, deleteCode: code, reason: reason || 'Raison IA inconnue', status: 'pending', createdAt: new Date() });
    await sendReviewEmail({ name: name.trim(), title: title.trim(), reason: reason || '?', reviewId });
    res.json({ success: true, reviewId });
  } catch (e) { res.status(500).json({ error: 'Échec de la demande' }); }
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
    res.json({ votes: updated?.votes || 0 });
  } catch (e) { res.status(500).json({ error: 'Erreur vote' }); }
});

// DELETE — Créateur (code 4 chiffres) ou Admin
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
    console.log(`🗑  "${art.title}" supprimée`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

// ════════════════════════════════════════════
//  ROUTES ADMIN
// ════════════════════════════════════════════

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const [totalArts, pendingCount, totalVotesRes, goldCount] = await Promise.all([
      gallery.countDocuments(),
      pending.countDocuments({ status: 'pending' }),
      gallery.aggregate([{ $group: { _id: null, total: { $sum: '$votes' } } }]).toArray(),
      members.countDocuments({ goldUntil: { $gt: now } })
    ]);
    res.json({ totalArts, pendingCount, totalVotes: totalVotesRes[0]?.total || 0, goldCount });
  } catch (e) { res.status(500).json({}); }
});

app.get('/api/admin/pending', requireAdmin, async (req, res) => {
  try {
    const docs = await pending.find({ status: 'pending' }).sort({ createdAt: -1 }).toArray();
    res.json(docs);
  } catch (e) { res.status(500).json([]); }
});

app.put('/api/admin/approve/:reviewId', requireAdmin, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const doc = await pending.findOne({ reviewId });
    if (!doc) return res.status(404).json({ error: 'Demande introuvable' });
    const artwork = { id: uuid(), name: doc.name, title: doc.title, img: doc.img, votes: 0, voters: [], deleteCode: doc.deleteCode, createdAt: new Date(), approvedByAdmin: true };
    await gallery.insertOne(artwork);
    await pending.updateOne({ reviewId }, { $set: { status: 'approved', resolvedAt: new Date() } });
    console.log(`✅ ADMIN a approuvé "${doc.title}"`);
    res.json({ success: true, artworkId: artwork.id });
  } catch (e) { res.status(500).json({ error: 'Erreur approbation' }); }
});

app.put('/api/admin/reject/:reviewId', requireAdmin, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { rejectReason } = req.body;
    const doc = await pending.findOne({ reviewId });
    if (!doc) return res.status(404).json({ error: 'Demande introuvable' });
    await pending.updateOne({ reviewId }, { $set: { status: 'rejected', rejectReason: rejectReason || 'Non conforme', resolvedAt: new Date() } });
    console.log(`🚫 ADMIN a rejeté "${doc.title}"`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur rejet' }); }
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

app.listen(PORT, () => console.log(`🚀 Gold Pixel v4.0 (Pi Network) prêt sur le port ${PORT}`));
