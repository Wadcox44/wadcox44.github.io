// ═══════════════════════════════════════════════════════════════
//  JEUXVIDEO.PI — Server v2.1
//  Hébergement : Render  |  DB : MongoDB Atlas
//  Architecture : portail unique Pi Network
//  Contacts (dev + recrutement) loggés en MongoDB
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const path     = require('path');
const cors     = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { v4: uuid } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 10000;

// ── ENV ──────────────────────────────────────────────────────────
const MONGO_URI   = process.env.MONGO_URI        || '';
const PI_API_KEY  = process.env.PI_API_KEY_JEUXVIDEO || '';   // une seule clé, un seul portail
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme';     // pour /api/contact/list

// ── CORS ─────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://app-cdn.minepi.com',
    'https://minepi.com',
    'https://jeuxvideo.onrender.com'
  ],
  credentials: true
}));

// ── BODY PARSER ───────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));

// ── MONGODB ───────────────────────────────────────────────────────
const client = new MongoClient(MONGO_URI);
let db, artworks, users;

async function connectDB() {
  try {
    await client.connect();
    db       = client.db('jeuxvideo_db');
    artworks = db.collection('artworks');
    users    = db.collection('users');

    // Index utiles
    await artworks.createIndex({ createdAt: -1 });
    await artworks.createIndex({ votes: -1 });
    await artworks.createIndex({ views: -1 });
    await artworks.createIndex({ 'author.name': 1 });
    await users.createIndex({ piUsername: 1 }, { unique: true });
    await db.collection('contacts').createIndex({ receivedAt: -1 });
    await db.collection('contacts').createIndex({ type: 1 });
    await db.collection('neonbreaker_scores').createIndex({ score: -1 });

    console.log('✅ JEUXVIDEO.PI — MongoDB connecté');
  } catch (e) {
    console.error('❌ MongoDB erreur :', e.message);
    process.exit(1);
  }
}
connectDB();

// ═══════════════════════════════════════════════════════════════
//  HELPER — vérification token Pi Network
// ═══════════════════════════════════════════════════════════════
async function verifyPiToken(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch('https://api.minepi.com/v2/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) return null;
    return await res.json(); // { uid, username, ... }
  } catch {
    return null;
  }
}

// Middleware — authentification optionnelle (lit le token Bearer)
function withPiUser(required = false) {
  return async (req, res, next) => {
    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const piUser = token ? await verifyPiToken(token) : null;

    if (required && !piUser) {
      return res.status(401).json({ error: 'Pi authentication required' });
    }
    req.piUser = piUser; // peut être null si non requis
    next();
  };
}

// ═══════════════════════════════════════════════════════════════
//  /api/auth — Authentification Pi (SSO portail)
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/signin
// Body : { accessToken }
// Retourne le profil utilisateur (crée si nouveau)
app.post('/api/auth/signin', async (req, res) => {
  const { accessToken } = req.body;
  const piUser = await verifyPiToken(accessToken);
  if (!piUser) return res.status(401).json({ error: 'Token invalide' });

  try {
    const now = new Date();
    const doc = await users.findOneAndUpdate(
      { piUsername: piUser.username },
      {
        $set:         { piUid: piUser.uid, lastSeen: now },
        $setOnInsert: { piUsername: piUser.username, country: null, createdAt: now, dailyCount: 0, dailyReset: now }
      },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ ok: true, user: doc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  /api/user — Gestion profil
// ═══════════════════════════════════════════════════════════════

// GET /api/user/me
app.get('/api/user/me', withPiUser(true), async (req, res) => {
  const u = await users.findOne({ piUsername: req.piUser.username });
  res.json(u || {});
});

// PATCH /api/user/country
// Body : { country: 'FR' }
app.patch('/api/user/country', withPiUser(true), async (req, res) => {
  const { country } = req.body;
  if (!country || country.length > 3) return res.status(400).json({ error: 'Pays invalide' });
  await users.updateOne({ piUsername: req.piUser.username }, { $set: { country } });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
//  /api/gallery — Galerie Gold Pixel
// ═══════════════════════════════════════════════════════════════

// GET /api/gallery?sort=votes|views|date|name&page=0
app.get('/api/gallery', async (req, res) => {
  if (!artworks) return res.status(503).json([]);
  const sortMap = { votes: { votes: -1 }, views: { views: -1 }, name: { title: 1 }, date: { createdAt: -1 } };
  const sort   = sortMap[req.query.sort] || sortMap.date;
  const page   = Math.max(0, parseInt(req.query.page) || 0);
  const limit  = 30;
  try {
    const data = await artworks
      .find({ status: 'approved', archived: { $ne: true } })
      .sort(sort)
      .skip(page * limit)
      .limit(limit)
      .project({ img: 1, title: 1, 'author.name': 1, votes: 1, views: 1, createdAt: 1, featured: 1, id: 1 })
      .toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json([]);
  }
});

// POST /api/gallery/save — Sauvegarder une œuvre
// Body : { title, img, authorName, password }
// Auth Pi optionnelle : si non connecté, on utilise authorName envoyé par le client
app.post('/api/gallery/save', withPiUser(false), async (req, res) => {
  const { title, img, password, authorName } = req.body;
  if (!title || !img || !password) return res.status(400).json({ error: 'Données incomplètes' });

  // Username Pi en priorité, sinon authorName du client (fallback legacy)
  const username = req.piUser?.username || authorName || 'anonymous';

  // ── Vérif quota quotidien ──
  const user = await users.findOne({ piUsername: username });
  const today = new Date(); today.setHours(0,0,0,0);
  const lastReset = user?.dailyReset ? new Date(user.dailyReset) : new Date(0);
  lastReset.setHours(0,0,0,0);

  let dailyCount = (lastReset.getTime() === today.getTime()) ? (user?.dailyCount || 0) : 0;
  // extraSlots expire à minuit : valide seulement si acheté aujourd'hui
  const extraSlotsDate = user?.extraSlotsDate ? new Date(user.extraSlotsDate) : new Date(0);
  extraSlotsDate.setHours(0,0,0,0);
  const extraSlotsValid = user?.extraSlots && (extraSlotsDate.getTime() === today.getTime());
  const maxDaily = extraSlotsValid ? 8 : 3;
  if (dailyCount >= maxDaily) return res.status(429).json({ error: 'Quota journalier atteint', quota: maxDaily });

  // ── Insertion avec statut "pending" (modération IA) ──
  const artwork = {
    id:         uuid(),
    title:      title.slice(0, 60),
    img,
    password,   // stocké hashé en prod — simplifié ici
    author:     { name: username, uid: req.piUser?.uid || null },
    votes:      0,
    views:      0,
    status:     'pending',   // → 'approved' | 'rejected' après modération
    featured:   false,
    archived:   false,
    createdAt:  new Date(),
    goldPixels: false,
  };

  await artworks.insertOne(artwork);
  await users.updateOne(
    { piUsername: username },
    { $set: { dailyCount: dailyCount + 1, dailyReset: today } }
  );

  // ── Modération IA différée (simulée ici, à brancher sur votre service vision) ──
  setTimeout(() => moderateArtwork(artwork.id), 30_000); // 30 secondes

  res.json({ ok: true, id: artwork.id, status: 'pending' });
});

// Modération IA — squelette à compléter avec votre API vision
async function moderateArtwork(artId) {
  try {
    // TODO : appeler votre API vision (OpenAI, Google Vision, Replicate…)
    // const safe = await checkImageWithAI(artwork.img);
    const safe = true; // Placeholder — toujours approuvé pour l'instant

    await artworks.updateOne(
      { id: artId },
      { $set: { status: safe ? 'approved' : 'rejected' } }
    );
    console.log(`🤖 Modération ${artId} → ${safe ? 'approved' : 'rejected'}`);
  } catch (e) {
    // En cas d'erreur IA, on approuve par défaut pour ne pas bloquer les utilisateurs
    await artworks.updateOne({ id: artId }, { $set: { status: 'approved' } });
  }
}

// DELETE /api/gallery/:id — Suppression œuvre (avec mot de passe)
app.delete('/api/gallery/:id', async (req, res) => {
  const { password } = req.body;
  const art = await artworks.findOne({ id: req.params.id });
  if (!art)     return res.status(404).json({ error: 'Introuvable' });
  if (art.password !== password) return res.status(403).json({ error: 'Mot de passe incorrect' });
  await artworks.deleteOne({ id: req.params.id });
  res.json({ ok: true });
});

// POST /api/gallery/:id/vote
app.post('/api/gallery/:id/vote', withPiUser(true), async (req, res) => {
  const artId    = req.params.id;
  const username = req.piUser.username;
  const art      = await artworks.findOne({ id: artId });
  if (!art) return res.status(404).json({ error: 'Introuvable' });
  if (art.author?.name === username) return res.status(403).json({ error: 'Interdit de voter pour sa propre œuvre' });

  // Vérif vote unique
  const voters = art.voters || [];
  if (voters.includes(username)) return res.status(409).json({ error: 'Déjà voté' });

  const updated = await artworks.findOneAndUpdate(
    { id: artId },
    { $inc: { votes: 1 }, $push: { voters: username } },
    { returnDocument: 'after' }
  );
  res.json({ ok: true, votes: updated.votes });
});

// POST /api/gallery/:id/view — Incrémenter les vues
app.post('/api/gallery/:id/view', async (req, res) => {
  await artworks.updateOne({ id: req.params.id }, { $inc: { views: 1 } });
  res.json({ ok: true });
});

// ── Compatibilité ancienne route ──
app.get('/api/gallery', async (req, res) => { /* géré ci-dessus */ });
app.post('/api/save', async (req, res) => {
  // Route legacy — redirige vers la nouvelle logique sans auth Pi
  const { name, title, img } = req.body;
  if (!artworks) return res.status(503).json({ error: 'DB non prête' });
  const artwork = {
    id: uuid(), title, img, password: '',
    author: { name: name || 'anonymous' },
    votes: 0, views: 0, status: 'approved',
    archived: false, createdAt: new Date()
  };
  await artworks.insertOne(artwork);
  res.json({ id: artwork.id, success: true });
});

// ═══════════════════════════════════════════════════════════════
//  /api/game/goldpixel — Données spécifiques Gold Pixel
// ═══════════════════════════════════════════════════════════════

// GET /api/game/goldpixel/top10
app.get('/api/game/goldpixel/top10', async (req, res) => {
  if (!artworks) return res.json([]);
  const data = await artworks
    .find({ status: 'approved', archived: { $ne: true } })
    .sort({ votes: -1 })
    .limit(10)
    .project({ img: 1, title: 1, 'author.name': 1, votes: 1, id: 1 })
    .toArray();
  res.json(data);
});

// GET /api/game/goldpixel/top10-players
app.get('/api/game/goldpixel/top10-players', async (req, res) => {
  if (!artworks) return res.json([]);
  const pipeline = [
    { $match: { status: 'approved', archived: { $ne: true } } },
    { $group: {
      _id:        '$author.name',
      totalVotes: { $sum: '$votes' },
      artCount:   { $sum: 1 },
      bestImg:    { $first: '$img' }
    }},
    { $sort: { totalVotes: -1 } },
    { $limit: 10 },
    { $project: { name: '$_id', totalVotes: 1, artCount: 1, bestImg: 1 } }
  ];
  const data = await artworks.aggregate(pipeline).toArray();
  res.json(data);
});

// GET /api/game/goldpixel/player/:name
app.get('/api/game/goldpixel/player/:name', async (req, res) => {
  if (!artworks) return res.json({ arts: [], totalVotes: 0 });
  const arts = await artworks
    .find({ 'author.name': req.params.name, status: 'approved', archived: { $ne: true } })
    .sort({ createdAt: -1 })
    .toArray();
  const totalVotes = arts.reduce((s, a) => s + (a.votes || 0), 0);
  res.json({ arts, totalVotes });
});

// GET /api/game/goldpixel/all-players
app.get('/api/game/goldpixel/all-players', async (req, res) => {
  if (!artworks) return res.json([]);
  const pipeline = [
    { $match: { status: 'approved', archived: { $ne: true } } },
    { $group: {
      _id:        '$author.name',
      totalVotes: { $sum: '$votes' },
      artCount:   { $sum: 1 },
      bestImg:    { $first: '$img' }
    }},
    { $sort: { totalVotes: -1 } },
    { $project: { name: '$_id', totalVotes: 1, artCount: 1, bestImg: 1 } }
  ];
  const data = await artworks.aggregate(pipeline).toArray();
  res.json(data);
});

// Compatibilité routes legacy goldpixel
app.get('/api/top10',       (req, res) => res.redirect('/api/game/goldpixel/top10'));
app.get('/api/top10-players',(req,res)=> res.redirect('/api/game/goldpixel/top10-players'));
app.get('/api/all-players', (req, res) => res.redirect('/api/game/goldpixel/all-players'));
app.get('/api/vote',        (req, res) => res.json([]));

app.post('/api/vote', withPiUser(false), async (req, res) => {
  // Legacy vote sans auth stricte
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id requis' });
  const updated = await artworks.findOneAndUpdate(
    { id },
    { $inc: { votes: 1 } },
    { returnDocument: 'after' }
  );
  if (!updated) return res.status(404).json({ error: 'Introuvable' });
  res.json({ ok: true, votes: updated.votes });
});

app.get('/api/player/:name', async (req, res) => res.redirect(`/api/game/goldpixel/player/${req.params.name}`));



// ═══════════════════════════════════════════════════════════════
//  /api/game/neonbreaker — Classement Neon Breaker
// ═══════════════════════════════════════════════════════════════

// POST /api/game/neonbreaker/score
// Body : { name, score, level, combo, bricks }
app.post('/api/game/neonbreaker/score', async (req, res) => {
  try {
    const { name, score, level, combo, bricks } = req.body;
    if (!name || typeof score !== 'number') return res.status(400).json({ error: 'name + score requis' });
    const col = db.collection('neonbreaker_scores');
    // Garder seulement le meilleur score par joueur
    const existing = await col.findOne({ name: name.slice(0,20) });
    if (existing && existing.score >= score) return res.json({ ok: true, best: existing.score });
    await col.updateOne(
      { name: name.slice(0,20) },
      { $set: { name: name.slice(0,20), score, level: level||1, combo: combo||0, bricks: bricks||0, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true, newBest: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/game/neonbreaker/scores?limit=20
app.get('/api/game/neonbreaker/scores', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit)||20);
    const col   = db.collection('neonbreaker_scores');
    const data  = await col.find({}).sort({ score: -1 }).limit(limit).toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json([]);
  }
});

// ═══════════════════════════════════════════════════════════════
//  /api/contact — Formulaires développeurs & recrutement
//  Les données arrivent aussi via Formspree (email automatique)
//  Cette route permet en plus de les stocker en MongoDB
//  pour consultation/export via /api/contact/list
// ═══════════════════════════════════════════════════════════════

// POST /api/contact
// Body : { type: 'developer-integration'|'recruitment', ...fields }
app.post('/api/contact', async (req, res) => {
  try {
    const { type, ...fields } = req.body;
    if (!type) return res.status(400).json({ error: 'type requis' });

    const contacts = db.collection('contacts');
    const doc = {
      type,
      fields,
      receivedAt: new Date(),
      status: 'new',   // new | read | replied
    };
    await contacts.insertOne(doc);
    res.json({ ok: true });
  } catch (e) {
    // Ne pas faire échouer l'UX si MongoDB est indisponible
    console.error('Contact save error:', e.message);
    res.json({ ok: true }); // on répond ok quand même (Formspree gère l'email)
  }
});

// GET /api/contact/list — lister les candidatures (admin)
// Protégé par un secret header simple
app.get('/api/contact/list', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const contacts = db.collection('contacts');
    const type   = req.query.type;   // filtrer par type si besoin
    const filter = type ? { type } : {};
    const data   = await contacts.find(filter).sort({ receivedAt: -1 }).limit(200).toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/contact/:id/status — marquer lu/répondu
app.patch('/api/contact/:id/status', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { status } = req.body;
  if (!['new','read','replied'].includes(status)) return res.status(400).json({ error: 'status invalide' });
  const { ObjectId } = require('mongodb');
  const contacts = db.collection('contacts');
  await contacts.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
//  /api/payment — Monétisation Pi
// ═══════════════════════════════════════════════════════════════

// POST /api/payment/approve  (webhook Pi Network)
app.post('/api/payment/approve', async (req, res) => {
  const { paymentId } = req.body;
  // Approuver le paiement côté Pi Network
  try {
    const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payment/complete  (webhook Pi Network)
app.post('/api/payment/complete', async (req, res) => {
  const { paymentId, txid, artId, type } = req.body;
  try {
    // 1. Compléter côté Pi
    await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid })
    });

    // 2. Appliquer l'effet en base
    if (type === 'feature_24h' && artId) {
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await artworks.updateOne({ id: artId }, { $set: { featured: true, featuredUntil: until } });
    }
    if (type === 'gold_pixels' && artId) {
      await artworks.updateOne({ id: artId }, { $set: { goldPixels: true } });
    }
    if (type === 'extra_slots') {
      // Le frontend envoie username dans metadata / body
      const slotUsername = req.body.username || req.body.piUsername;
      if (slotUsername) {
        // Marquer extraSlots pour la journée en cours
        const today = new Date(); today.setHours(0,0,0,0);
        await users.updateOne(
          { piUsername: slotUsername },
          { $set: { extraSlots: true, extraSlotsDate: today } },
          { upsert: false }
        );
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  /api/leaderboard — Classements
// ═══════════════════════════════════════════════════════════════

// GET /api/leaderboard/countries
app.get('/api/leaderboard/countries', async (req, res) => {
  if (!artworks) return res.json([]);
  const pipeline = [
    { $match: { status: 'approved', archived: { $ne: true } } },
    { $lookup: { from: 'users', localField: 'author.name', foreignField: 'piUsername', as: 'userInfo' } },
    { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
    { $group: { _id: '$userInfo.country', totalVotes: { $sum: '$votes' }, artCount: { $sum: 1 } } },
    { $match: { _id: { $ne: null } } },
    { $sort: { totalVotes: -1 } },
    { $limit: 10 }
  ];
  const data = await artworks.aggregate(pipeline).toArray();
  res.json(data);
});

// ═══════════════════════════════════════════════════════════════
//  /api/archive — Archives mensuelles
// ═══════════════════════════════════════════════════════════════

// POST /api/archive/run  (à appeler via cron Render ou webhook)
app.post('/api/archive/run', async (req, res) => {
  // Sécurité basique — à améliorer avec un secret header en prod
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const now    = new Date();
  const label  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const archive = db.collection(`archive_${label}`);

  const toArchive = await artworks.find({ status: 'approved', archived: { $ne: true } }).toArray();
  if (toArchive.length) {
    await archive.insertMany(toArchive);
    await artworks.updateMany({ status: 'approved', archived: { $ne: true } }, { $set: { archived: true } });
  }
  res.json({ ok: true, archived: toArchive.length, label });
});

// GET /api/archive/list
app.get('/api/archive/list', async (req, res) => {
  const cols = await db.listCollections().toArray();
  const archives = cols
    .map(c => c.name)
    .filter(n => n.startsWith('archive_'))
    .sort()
    .reverse();
  res.json(archives);
});

// GET /api/archive/:label
app.get('/api/archive/:label', async (req, res) => {
  const col = db.collection(`archive_${req.params.label}`);
  const data = await col.find({}).sort({ votes: -1 }).limit(100).toArray();
  res.json(data);
});

// ═══════════════════════════════════════════════════════════════
//  FICHIERS STATIQUES
// ═══════════════════════════════════════════════════════════════

// Clé validation Pi Network (un seul portail)
app.get('/validation-key.txt', (req, res) => res.send(PI_API_KEY));

// Route santé
app.get('/health', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.status(200).send('OK');
});

// Route Keep Alive — pinguée toutes les 10 min par GitHub Actions
app.get('/ping', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.status(200).json({ status: 'alive', ts: new Date().toISOString() });
});

// Gold Pixel — dossier Games/Goldpixel
app.use('/goldpixel', express.static(path.join(__dirname, 'Games', 'Goldpixel')));
app.get('/goldpixel', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games', 'Goldpixel', 'goldpixel.html'), err => {
    if (err) res.status(404).send('goldpixel.html introuvable dans Games/Goldpixel');
  });
});

// Neon Breaker — dossier Games/Breakout
app.use('/breakout', express.static(path.join(__dirname, 'Games', 'Breakout')));
app.get('/breakout', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games', 'Breakout', 'breakout.html'), err => {
    if (err) res.status(404).send('breakout.html introuvable dans Games/Breakout');
  });
});

// Pi Stacker — dossier Games/Stacker
app.use('/stacker', express.static(path.join(__dirname, 'Games', 'Stacker')));
app.get('/stacker', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games', 'Stacker', 'index.html'), err => {
    if (err) res.status(404).send('index.html introuvable dans Games/Stacker');
  });
});

// 2048 Neon — dossier Games/2048
app.use('/2048', express.static(path.join(__dirname, 'Games', '2048')));
app.get('/2048', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games', '2048', 'index.html'), err => {
    if (err) res.status(404).send('index.html introuvable dans Games/2048');
  });
});

// Portail — racine (en dernier pour ne pas shadower les routes API)
app.use(express.static(path.join(__dirname)));

// ── Démarrage ────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 JEUXVIDEO.PI actif sur le port ${PORT}`));
