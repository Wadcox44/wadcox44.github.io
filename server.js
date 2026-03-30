// ═══════════════════════════════════════════════════════════════
//  JEUXVIDEO.PI — Server v3.6
//  Hébergement : Render  |  DB : MongoDB Atlas
//  Architecture : portail Pi Network + 6 systèmes configurables + Shop Gold Credits
//               + Pont Portail (snapshot mensuel, scores déportés, galerie des saisons)
//
//  NOUVEAUX SYSTÈMES (v3.0) — tous config-driven, enable/disable par flag :
//    1. TERRAIN_FATIGUE   — fatigue locale des cellules surchargées
//    2. WORLD_EXPANSION   — expansion progressive du canvas
//    3. SOCIAL_SPAWN      — spawn intelligent pour les nouveaux joueurs
//    4. FIRST_PIXEL_PROT  — protection 10 min après 1er pixel
//    5. SEASON_LOGO       — logo central protégé 48h par saison
//    6. SEASON_RESET      — reset mensuel de saison
//
//  Toutes les routes existantes sont préservées et non modifiées.
//
//  SHOP (v3.1) :
//    goldpixel-backend/shop/catalogue.js   — items & bundles
//    goldpixel-backend/shop/walletService.js — crédits & ledger
//    goldpixel-backend/shop/inventoryService.js — items actifs
//    goldpixel-backend/shop/routes.js      — /api/shop/*
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const http     = require('http');
const { Server: SocketIO } = require('socket.io');
const path     = require('path');
const cors     = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { v4: uuid } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new SocketIO(server, {
  cors: {
    origin: [
      'https://app-cdn.minepi.com',
      'https://minepi.com',
      'https://jeuxvideo.onrender.com'
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});
const PORT = process.env.PORT || 10000;

// ── ENV ──────────────────────────────────────────────────────────
const MONGO_URI    = process.env.MONGO_URI             || '';
const PI_API_KEY   = process.env.PI_API_KEY_JEUXVIDEO  || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET          || 'changeme';
const CRON_SECRET  = process.env.CRON_SECRET           || '';


// ── MODULES SHOP Gold Credits (v3.1) ──────────────────────────
// Chargés ici pour être disponibles dès que connectDB() a fourni `db`.
// L'injection db se fait dans le bloc INIT EN FIN DE FICHIER.
const ShopRoutes = require('./goldpixel-backend/shop/routes');

// ╔═══════════════════════════════════════════════════════════════
// ║  GAME CONFIG — fichier de configuration central
// ║
// ║  Chaque système possède :
// ║    enabled  : boolean — activer/désactiver sans toucher la logique
// ║    ...params : paramètres métier du système
// ║
// ║  Convention de nommage :
// ║    GAME_CONFIG.<SYSTEM>.enabled = false   → système inactif, routes retournent
// ║                                             des réponses neutres/vides
// ║    GAME_CONFIG.<SYSTEM>.enabled = true    → système actif et opérationnel
// ╚═══════════════════════════════════════════════════════════════
/* Canvas Gold Pixel — dimensions courantes (modifiées au runtime via Socket.io) */
let _gpCanvasW = 3000;
let _gpCanvasH = 3000;

const GAME_CONFIG = {

  // ─────────────────────────────────────────────────────────────
  // 1. TERRAIN_FATIGUE
  //    Quand une cellule est repeinte trop souvent, elle devient
  //    "fatiguée" et impose un coût supplémentaire (delai, pénalité).
  //    Cela décourage les guerres de pixels répétitives sur la même zone.
  //
  //    windowMs    : fenêtre de temps pour compter les repaints
  //    maxRepaints : nombre de repaints autorisés dans la fenêtre
  //    cooldownMs  : délai imposé au joueur qui dépasse la limite
  //    scope       : 'cell' (par cellule) | 'zone' (grille NxN) | 'global'
  // ─────────────────────────────────────────────────────────────
  terrain_fatigue: {
    enabled:    false,
    windowMs:   60 * 60 * 1000,    // 1 heure
    maxRepaints: 5,                 // 5 repaints par cellule/heure
    cooldownMs:  5 * 60 * 1000,    // 5 min de cooldown
    scope:      'cell',            // granularité : cellule individuelle
  },

  // ─────────────────────────────────────────────────────────────
  // 2. WORLD_EXPANSION
  //    Le canvas commence petit et s'agrandit progressivement selon
  //    le nombre de joueurs actifs ou le nombre total d'œuvres publiées.
  //
  //    initialCols/Rows  : dimensions de départ
  //    maxCols/Rows      : dimensions maximales autorisées
  //    artworksPerExpansion : nb d'œuvres approuvées avant expansion
  //    expansionStep     : nb de colonnes/lignes ajoutées à chaque étape
  //    expansionAxis     : 'both' | 'cols' | 'rows'
  // ─────────────────────────────────────────────────────────────
  world_expansion: {
    enabled:              false,
    initialCols:          80,
    initialRows:          45,
    maxCols:              160,
    maxRows:              90,
    artworksPerExpansion: 100,   // toutes les 100 œuvres approuvées
    expansionStep:        10,    // +10 cols ET/OU +10 rows
    expansionAxis:        'both',
  },

  // ─────────────────────────────────────────────────────────────
  // 3. SOCIAL_SPAWN
  //    Les nouveaux joueurs apparaissent près d'une zone active
  //    plutôt qu'en (0,0). Favorise les rencontres et l'activité.
  //
  //    strategy        : 'most-active' | 'random-active' | 'center'
  //    radiusCells     : rayon en cellules autour du point d'intérêt
  //    minActivePixels : seuil minimum de pixels dans la zone cible
  //    fallbackToCenter: si aucune zone active → centre du canvas
  // ─────────────────────────────────────────────────────────────
  social_spawn: {
    enabled:         false,
    strategy:        'most-active',
    radiusCells:     15,
    minActivePixels: 10,
    fallbackToCenter: true,
  },

  // ─────────────────────────────────────────────────────────────
  // 4. FIRST_PIXEL_PROT
  //    Les 10 premières minutes après le 1er pixel d'un joueur,
  //    ses cellules ne peuvent pas être écrasées par d'autres.
  //    Donne le temps aux débutants de s'installer.
  //
  //    durationMs      : durée de la protection (ms)
  //    appliesTo       : 'first-session' | 'every-session'
  //    notifyOnAttempt : envoyer une notif si quelqu'un tente d'écraser
  // ─────────────────────────────────────────────────────────────
  first_pixel_prot: {
    enabled:         false,
    durationMs:      10 * 60 * 1000,   // 10 minutes
    appliesTo:       'first-session',
    notifyOnAttempt: false,
  },

  // ─────────────────────────────────────────────────────────────
  // 5. SEASON_LOGO
  //    Un logo central est placé sur le canvas en début de saison.
  //    Il est protégé en lecture seule pendant 48h.
  //    Après expiration, il devient dessinable normalement.
  //
  //    durationMs  : durée de protection (ms)
  //    centerCol   : colonne du coin haut-gauche du logo
  //    centerRow   : ligne du coin haut-gauche
  //    logoWidth   : largeur en cellules
  //    logoHeight  : hauteur en cellules
  //    seasonLabel : identifiant lisible (ex: '2026-S1')
  // ─────────────────────────────────────────────────────────────
  season_logo: {
    enabled:     false,
    durationMs:  48 * 60 * 60 * 1000, // 48 heures
    centerCol:   35,
    centerRow:   18,
    logoWidth:   10,
    logoHeight:   9,
    seasonLabel: '2026-S1',
  },

  // ─────────────────────────────────────────────────────────────
  // 6. SEASON_RESET
  //    Réinitialisation mensuelle de la saison :
  //    - archive les œuvres actuelles
  //    - remet le canvas à zéro (ou partiellement)
  //    - incrémente le compteur de saison
  //    - optionnellement, préserve certaines zones protégées
  //
  //    schedule         : 'monthly' | 'manual' | cron string
  //    archiveBeforeReset : sauvegarder les œuvres avant reset
  //    preserveZones    : liste de zones [{col,row,w,h}] non effacées
  //    notifyUsersMs    : notif anticipée avant reset (ms), 0 = désactivé
  // ─────────────────────────────────────────────────────────────
  season_reset: {
    enabled:            false,
    schedule:           'monthly',
    archiveBeforeReset: true,
    preserveZones:      [],          // [] = tout effacer
    notifyUsersMs:      24 * 60 * 60 * 1000, // notif 24h avant
  },
};


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

    // Index existants
    await artworks.createIndex({ createdAt: -1 });
    await artworks.createIndex({ votes: -1 });
    await artworks.createIndex({ views: -1 });
    await artworks.createIndex({ 'author.name': 1 });
    await users.createIndex({ piUsername: 1 }, { unique: true });
    await db.collection('contacts').createIndex({ receivedAt: -1 });
    await db.collection('contacts').createIndex({ type: 1 });
    await db.collection('neonbreaker_scores').createIndex({ score: -1 });

    // ── Index pour les nouveaux systèmes ──
    // Terrain fatigue : recherche par cellule + timestamp
    await db.collection('cell_repaints').createIndex({ cellKey: 1, ts: -1 });
    // First pixel prot : recherche par joueur
    await db.collection('pixel_protections').createIndex({ piUsername: 1 });
    // Season logo : recherche par label de saison
    await db.collection('season_state').createIndex({ seasonLabel: 1 }, { unique: true });

    // ── Index pour les systèmes configurables (v3.0) ──
    // (déjà créés par les services si manquants — pas de risque)

    // ── Index shop (v3.1) ──
    await db.collection('credit_wallets').createIndex({ piUsername: 1 }, { unique: true });
    await db.collection('credit_ledger').createIndex({ piUsername: 1, createdAt: -1 });
    await db.collection('credit_ledger').createIndex({ ref: 1 });
    await db.collection('inventory').createIndex({ piUsername: 1, status: 1 });
    await db.collection('inventory').createIndex({ piUsername: 1, itemId: 1, status: 1 });

    // Injecter db dans le shop
    ShopRoutes.inject(db, withPiUser, PI_API_KEY);
    ensurePixelwarIndexes(); // Gold Pixel indexes

    console.log('✅ JEUXVIDEO.PI — MongoDB connecté (v3.1)');
  } catch (e) {
    console.error('❌ MongoDB erreur :', e.message);
    process.exit(1);
  }
}
connectDB();


// ═══════════════════════════════════════════════════════════════
//  HELPER — vérification token Pi Network (inchangé)
// ═══════════════════════════════════════════════════════════════
async function verifyPiToken(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch('https://api.minepi.com/v2/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function withPiUser(required = false) {
  return async (req, res, next) => {
    const auth   = req.headers.authorization || '';
    const token  = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const piUser = token ? await verifyPiToken(token) : null;
    if (required && !piUser) return res.status(401).json({ error: 'Pi authentication required' });
    req.piUser = piUser;
    next();
  };
}


// ╔═══════════════════════════════════════════════════════════════
// ║  SERVICES — un fichier par système, logique isolée
// ║
// ║  Chaque service expose :
// ║    .check(params) → { allowed: bool, reason?: string, data?: any }
// ║    .apply(params) → void (écriture en DB)
// ║    .info(params)  → { ...état courant }
// ║
// ║  Pattern guard :
// ║    if (!GAME_CONFIG.<system>.enabled) return { allowed: true }
// ║    // → comportement neutre quand désactivé
// ╚═══════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════
//  SERVICE 1 — TERRAIN FATIGUE
// ═══════════════════════════════════════════════════════════════
const TerrainFatigueService = {

  /**
   * Vérifie si une cellule peut être repeinte.
   * @param {string} piUsername
   * @param {number} col
   * @param {number} row
   * @returns {{ allowed: boolean, cooldownUntil?: Date, repaints?: number }}
   */
  async check(piUsername, col, row) {
    if (!GAME_CONFIG.terrain_fatigue.enabled) return { allowed: true };

    const cfg = GAME_CONFIG.terrain_fatigue;
    const col_ = db.collection('cell_repaints');
    const cellKey = `${col},${row}`;
    const windowStart = new Date(Date.now() - cfg.windowMs);

    // Compter les repaints récents sur cette cellule (tous joueurs)
    const repaints = await col_.countDocuments({
      cellKey,
      ts: { $gte: windowStart },
    });

    if (repaints >= cfg.maxRepaints) {
      const cooldownUntil = new Date(Date.now() + cfg.cooldownMs);
      return { allowed: false, reason: 'CELL_FATIGUED', repaints, cooldownUntil };
    }

    return { allowed: true, repaints };
  },

  /**
   * Enregistre un repaint en base.
   * Appelé APRÈS avoir vérifié check() et appliqué le pixel.
   */
  async record(piUsername, col, row) {
    if (!GAME_CONFIG.terrain_fatigue.enabled) return;
    await db.collection('cell_repaints').insertOne({
      cellKey: `${col},${row}`,
      piUsername,
      ts: new Date(),
    });
    // Nettoyage TTL : supprimer les entrées plus vieilles que windowMs
    const expire = new Date(Date.now() - GAME_CONFIG.terrain_fatigue.windowMs);
    await db.collection('cell_repaints').deleteMany({ ts: { $lt: expire } });
  },

  /**
   * Retourne l'état de fatigue d'une zone (pour affichage front-end).
   * Utilisé par GET /api/goldpixel/fatigue?col=X&row=Y&radius=N
   */
  async zoneInfo(col, row, radius = 5) {
    if (!GAME_CONFIG.terrain_fatigue.enabled) return { enabled: false };
    const cfg  = GAME_CONFIG.terrain_fatigue;
    const window_ = new Date(Date.now() - cfg.windowMs);
    // Agréger par cellKey dans le rayon
    const cells = await db.collection('cell_repaints').aggregate([
      { $match: { ts: { $gte: window_ } } },
      { $group: { _id: '$cellKey', count: { $sum: 1 } } },
    ]).toArray();

    const fatigued = cells
      .filter(c => c.count >= cfg.maxRepaints)
      .map(c => ({ cellKey: c._id, repaints: c.count }));

    return { enabled: true, fatigued, threshold: cfg.maxRepaints };
  },
};


// ═══════════════════════════════════════════════════════════════
//  SERVICE 2 — WORLD EXPANSION
// ═══════════════════════════════════════════════════════════════
const WorldExpansionService = {

  /**
   * Retourne les dimensions courantes du canvas.
   * Si désactivé : retourne les dimensions par défaut fixes.
   */
  async getCurrentDimensions() {
    const cfg = GAME_CONFIG.world_expansion;
    if (!cfg.enabled) {
      return { cols: cfg.initialCols, rows: cfg.initialRows, expanded: false };
    }

    // Compter les œuvres approuvées pour calculer le niveau d'expansion
    const approvedCount = await artworks.countDocuments({ status: 'approved', archived: { $ne: true } });
    const expansions = Math.floor(approvedCount / cfg.artworksPerExpansion);

    let cols = cfg.initialCols;
    let rows = cfg.initialRows;

    if (cfg.expansionAxis === 'both' || cfg.expansionAxis === 'cols') {
      cols = Math.min(cfg.maxCols, cfg.initialCols + expansions * cfg.expansionStep);
    }
    if (cfg.expansionAxis === 'both' || cfg.expansionAxis === 'rows') {
      rows = Math.min(cfg.maxRows, cfg.initialRows + expansions * cfg.expansionStep);
    }

    return {
      cols,
      rows,
      expansions,
      approvedCount,
      nextExpansionAt: (expansions + 1) * cfg.artworksPerExpansion,
      expanded: expansions > 0,
    };
  },

  /**
   * Valide qu'une cellule (col, row) est dans les limites courantes.
   */
  async isInBounds(col, row) {
    const { cols, rows } = await this.getCurrentDimensions();
    return col >= 0 && col < cols && row >= 0 && row < rows;
  },
};


// ═══════════════════════════════════════════════════════════════
//  SERVICE 3 — SOCIAL SPAWN
// ═══════════════════════════════════════════════════════════════
const SocialSpawnService = {

  /**
   * Calcule le point de spawn recommandé pour un nouveau joueur.
   * Stratégies :
   *   most-active  : zone la plus dense en pixels récents
   *   random-active: zone active choisie aléatoirement parmi les top 5
   *   center       : centre fixe du canvas
   *
   * @returns {{ col: number, row: number, strategy: string }}
   */
  async getSpawnPoint() {
    const cfg = GAME_CONFIG.social_spawn;
    const { cols, rows } = await WorldExpansionService.getCurrentDimensions();
    const center = { col: Math.floor(cols / 2), row: Math.floor(rows / 2), strategy: 'center' };

    if (!cfg.enabled) return center;

    if (cfg.strategy === 'center') return center;

    try {
      // Agréger les œuvres récentes par zone (blocs 10×10)
      // On utilise les métadonnées des artworks si disponibles.
      // TODO: quand le pixel-grid est stocké en base, utiliser une vraie
      //       agrégation géospatiale sur les cellules.
      //
      // Pour l'instant : retourner une zone active basée sur les
      // dernières œuvres publiées (leur zone approximative).
      const recentArtworks = await artworks
        .find({ status: 'approved', archived: { $ne: true } })
        .sort({ createdAt: -1 })
        .limit(20)
        .project({ 'spawnHint.col': 1, 'spawnHint.row': 1 })
        .toArray();

      // Filtrer ceux qui ont un hint de zone
      const withHint = recentArtworks.filter(a => a.spawnHint?.col != null);

      if (withHint.length < cfg.minActivePixels) {
        // Pas assez de données : fallback
        return cfg.fallbackToCenter ? center : center;
      }

      if (cfg.strategy === 'random-active') {
        const pick = withHint[Math.floor(Math.random() * Math.min(5, withHint.length))];
        return { col: pick.spawnHint.col, row: pick.spawnHint.row, strategy: 'random-active' };
      }

      // most-active : prendre le 1er (plus récent)
      const best = withHint[0];
      return { col: best.spawnHint.col, row: best.spawnHint.row, strategy: 'most-active' };

    } catch (e) {
      console.warn('SocialSpawn fallback:', e.message);
      return center;
    }
  },
};


// ═══════════════════════════════════════════════════════════════
//  SERVICE 4 — FIRST PIXEL PROTECTION
// ═══════════════════════════════════════════════════════════════
const FirstPixelProtService = {

  /**
   * Enregistre la protection d'un joueur dès son premier pixel.
   * Doit être appelé côté client via POST /api/goldpixel/first-pixel.
   */
  async activate(piUsername) {
    if (!GAME_CONFIG.first_pixel_prot.enabled) return { ok: true, active: false };

    const cfg = GAME_CONFIG.first_pixel_prot;
    const col_ = db.collection('pixel_protections');

    // Vérifier si déjà activé précédemment (appliesTo === 'first-session')
    if (cfg.appliesTo === 'first-session') {
      const existing = await col_.findOne({ piUsername, type: 'first-session' });
      if (existing) return { ok: true, active: false, reason: 'ALREADY_USED' };
    }

    const expiresAt = new Date(Date.now() + cfg.durationMs);
    await col_.updateOne(
      { piUsername },
      { $set: { piUsername, type: cfg.appliesTo, expiresAt, createdAt: new Date() } },
      { upsert: true }
    );

    return { ok: true, active: true, expiresAt };
  },

  /**
   * Vérifie si un joueur est sous protection.
   * Utilisé avant d'autoriser l'écrasement d'une cellule.
   */
  async isProtected(piUsername) {
    if (!GAME_CONFIG.first_pixel_prot.enabled) return false;

    const prot = await db.collection('pixel_protections').findOne({ piUsername });
    if (!prot) return false;
    return prot.expiresAt > new Date();
  },

  /**
   * Retourne les infos de protection d'un joueur.
   */
  async getStatus(piUsername) {
    if (!GAME_CONFIG.first_pixel_prot.enabled) return { enabled: false };

    const prot = await db.collection('pixel_protections').findOne({ piUsername });
    if (!prot) return { enabled: true, active: false };

    const msLeft = Math.max(0, prot.expiresAt - Date.now());
    return {
      enabled:   true,
      active:    msLeft > 0,
      expiresAt: prot.expiresAt,
      msLeft,
    };
  },
};


// ═══════════════════════════════════════════════════════════════
//  SERVICE 5 — SEASON LOGO
// ═══════════════════════════════════════════════════════════════
const SeasonLogoService = {

  /**
   * Active le logo central pour la saison courante.
   * Appelé par POST /api/admin/season-logo/activate
   */
  async activate(seasonLabel) {
    if (!GAME_CONFIG.season_logo.enabled) return { ok: false, reason: 'DISABLED' };

    const cfg = GAME_CONFIG.season_logo;
    const label = seasonLabel || cfg.seasonLabel;
    const expiresAt = new Date(Date.now() + cfg.durationMs);

    await db.collection('season_state').updateOne(
      { seasonLabel: label },
      {
        $set: {
          seasonLabel:  label,
          logoActive:   true,
          logoExpiresAt: expiresAt,
          logoZone: {
            col:    cfg.centerCol,
            row:    cfg.centerRow,
            width:  cfg.logoWidth,
            height: cfg.logoHeight,
          },
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    return { ok: true, label, expiresAt };
  },

  /**
   * Vérifie si une cellule (col, row) est dans la zone protégée du logo.
   * Retourne false si le logo a expiré ou est désactivé.
   */
  async isProtectedCell(col, row) {
    if (!GAME_CONFIG.season_logo.enabled) return false;

    const cfg = GAME_CONFIG.season_logo;
    const state = await db.collection('season_state').findOne({ seasonLabel: cfg.seasonLabel });
    if (!state?.logoActive) return false;
    if (state.logoExpiresAt < new Date()) return false;

    const z = state.logoZone;
    return col >= z.col && col < z.col + z.width &&
           row >= z.row && row < z.row + z.height;
  },

  /**
   * Retourne l'état courant du logo de saison.
   */
  async getStatus() {
    if (!GAME_CONFIG.season_logo.enabled) return { enabled: false };

    const cfg   = GAME_CONFIG.season_logo;
    const state = await db.collection('season_state').findOne({ seasonLabel: cfg.seasonLabel });
    if (!state) return { enabled: true, active: false };

    const msLeft = Math.max(0, new Date(state.logoExpiresAt) - Date.now());
    return {
      enabled:  true,
      active:   msLeft > 0 && state.logoActive,
      label:    state.seasonLabel,
      zone:     state.logoZone,
      expiresAt: state.logoExpiresAt,
      msLeft,
    };
  },
};


// ═══════════════════════════════════════════════════════════════
//  SERVICE 6 — SEASON RESET
// ═══════════════════════════════════════════════════════════════
const SeasonResetService = {

  /**
   * Exécute le reset de saison :
   * 1. Archive les œuvres actives (si archiveBeforeReset)
   * 2. Incrémente le compteur de saison
   * 3. Marque le canvas comme "reset" (le front-end charge une grille vide)
   * 4. Préserve les zones protégées définies dans preserveZones
   *
   * Appelé par POST /api/admin/season-reset/run (protégé x-admin-secret)
   */
  async run() {
    if (!GAME_CONFIG.season_reset.enabled) return { ok: false, reason: 'DISABLED' };

    const cfg  = GAME_CONFIG.season_reset;
    const now  = new Date();
    const label = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // ── Étape 1 : archive si demandé ──
    let archived = 0;
    if (cfg.archiveBeforeReset) {
      const col_ = db.collection(`archive_${label}`);
      const toArchive = await artworks.find({ status: 'approved', archived: { $ne: true } }).toArray();
      if (toArchive.length) {
        await col_.insertMany(toArchive);
        await artworks.updateMany(
          { status: 'approved', archived: { $ne: true } },
          { $set: { archived: true } }
        );
        archived = toArchive.length;
      }
    }

    // ── Étape 2 : incrémenter compteur de saison ──
    const seasonCol = db.collection('season_state');
    await seasonCol.updateOne(
      { seasonLabel: label },
      {
        $set: {
          seasonLabel:  label,
          resetAt:      now,
          preserveZones: cfg.preserveZones,
          archivedCount: archived,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    // ── Étape 3 : désactiver le logo de saison (nouvelle saison) ──
    await seasonCol.updateMany({}, { $set: { logoActive: false } });

    // ── Étape 4 : réinitialiser les protections first-pixel ──
    // (optionnel — en commentaire par défaut)
    // await db.collection('pixel_protections').deleteMany({});

    console.log(`🔄 Season reset — ${label} — ${archived} œuvres archivées`);
    return { ok: true, label, archived, preserveZones: cfg.preserveZones };
  },

  /**
   * Pré-notification (à brancher sur un cron si besoin).
   * Appelé notifyUsersMs avant le reset prévu.
   */
  async notifyUpcoming() {
    if (!GAME_CONFIG.season_reset.enabled) return;
    if (!GAME_CONFIG.season_reset.notifyUsersMs) return;
    // TODO : déclencher une notification push / email / toast global
    console.log('⚠️ Season reset — notification anticipée envoyée');
  },
};


// ═══════════════════════════════════════════════════════════════
//  MIDDLEWARE GOLD PIXEL — appliqué sur les routes de placement
//  Vérifie les systèmes actifs avant d'autoriser un pixel
//
//  Utilisé par : POST /api/goldpixel/place-pixel (route à créer)
//  Pattern : chaîne de guards, court-circuite dès le 1er refus
// ═══════════════════════════════════════════════════════════════
async function goldPixelGuard(req, res, next) {
  const { col, row } = req.body;
  const username = req.piUser?.username;

  // ── Guard 1 : Limites du monde (expansion) ──
  const inBounds = await WorldExpansionService.isInBounds(col, row);
  if (!inBounds) {
    return res.status(403).json({ error: 'OUT_OF_BOUNDS', message: 'Cellule hors des limites actuelles du canvas' });
  }

  // ── Guard 2 : Logo de saison protégé ──
  const isLogoCell = await SeasonLogoService.isProtectedCell(col, row);
  if (isLogoCell) {
    return res.status(403).json({ error: 'LOGO_PROTECTED', message: 'Cette zone est protégée par le logo de saison' });
  }

  // ── Guard 3 : Fatigue du terrain ──
  if (username) {
    const fatigue = await TerrainFatigueService.check(username, col, row);
    if (!fatigue.allowed) {
      return res.status(429).json({
        error: 'CELL_FATIGUED',
        message: 'Cette cellule est temporairement fatiguée',
        cooldownUntil: fatigue.cooldownUntil,
        repaints: fatigue.repaints,
      });
    }
  }

  // ── Guard 4 : Protection first-pixel d'un autre joueur ──
  // (Nécessite de connaître le propriétaire de la cellule — future implémentation)
  // const cellOwner = await getCellOwner(col, row);
  // if (cellOwner && await FirstPixelProtService.isProtected(cellOwner)) {
  //   return res.status(403).json({ error: 'CELL_PROTECTED', owner: cellOwner });
  // }

  next();
}


// ═══════════════════════════════════════════════════════════════
//  ROUTES EXISTANTES — inchangées (copie intégrale)
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/signin
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/me', withPiUser(true), async (req, res) => {
  const u = await users.findOne({ piUsername: req.piUser.username });
  res.json(u || {});
});

app.patch('/api/user/country', withPiUser(true), async (req, res) => {
  const { country } = req.body;
  if (!country || country.length > 3) return res.status(400).json({ error: 'Pays invalide' });
  await users.updateOne({ piUsername: req.piUser.username }, { $set: { country } });
  res.json({ ok: true });
});

app.get('/api/gallery', async (req, res) => {
  if (!artworks) return res.status(503).json([]);
  const sortMap = { votes: { votes: -1 }, views: { views: -1 }, name: { title: 1 }, date: { createdAt: -1 } };
  const sort   = sortMap[req.query.sort] || sortMap.date;
  const page   = Math.max(0, parseInt(req.query.page) || 0);
  const limit  = 30;
  try {
    const data = await artworks
      .find({ status: 'approved', archived: { $ne: true } })
      .sort(sort).skip(page * limit).limit(limit)
      .project({ img: 1, title: 1, 'author.name': 1, votes: 1, views: 1, createdAt: 1, featured: 1, id: 1 })
      .toArray();
    res.json(data);
  } catch (e) { res.status(500).json([]); }
});

app.post('/api/gallery/save', withPiUser(false), async (req, res) => {
  const { title, img, password, authorName } = req.body;
  if (!title || !img || !password) return res.status(400).json({ error: 'Données incomplètes' });
  const username = req.piUser?.username || authorName || 'anonymous';
  const user = await users.findOne({ piUsername: username });
  const today = new Date(); today.setHours(0,0,0,0);
  const lastReset = user?.dailyReset ? new Date(user.dailyReset) : new Date(0);
  lastReset.setHours(0,0,0,0);
  let dailyCount = (lastReset.getTime() === today.getTime()) ? (user?.dailyCount || 0) : 0;
  const extraSlotsDate = user?.extraSlotsDate ? new Date(user.extraSlotsDate) : new Date(0);
  extraSlotsDate.setHours(0,0,0,0);
  const extraSlotsValid = user?.extraSlots && (extraSlotsDate.getTime() === today.getTime());
  const maxDaily = extraSlotsValid ? 8 : 3;
  if (dailyCount >= maxDaily) return res.status(429).json({ error: 'Quota journalier atteint', quota: maxDaily });
  const artwork = {
    id: uuid(), title: title.slice(0, 60), img, password,
    author: { name: username, uid: req.piUser?.uid || null },
    votes: 0, views: 0, status: 'pending', featured: false, archived: false,
    createdAt: new Date(), goldPixels: false,
  };
  await artworks.insertOne(artwork);
  await users.updateOne({ piUsername: username }, { $set: { dailyCount: dailyCount + 1, dailyReset: today } });
  setTimeout(() => moderateArtwork(artwork.id), 30_000);
  res.json({ ok: true, id: artwork.id, status: 'pending' });
});

async function moderateArtwork(artId) {
  try {
    const safe = true;
    await artworks.updateOne({ id: artId }, { $set: { status: safe ? 'approved' : 'rejected' } });
    console.log(`🤖 Modération ${artId} → ${safe ? 'approved' : 'rejected'}`);
  } catch (e) {
    await artworks.updateOne({ id: artId }, { $set: { status: 'approved' } });
  }
}

app.delete('/api/gallery/:id', async (req, res) => {
  const { password } = req.body;
  const art = await artworks.findOne({ id: req.params.id });
  if (!art) return res.status(404).json({ error: 'Introuvable' });
  if (art.password !== password) return res.status(403).json({ error: 'Mot de passe incorrect' });
  await artworks.deleteOne({ id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/gallery/:id/vote', withPiUser(true), async (req, res) => {
  const artId = req.params.id;
  const username = req.piUser.username;
  const art = await artworks.findOne({ id: artId });
  if (!art) return res.status(404).json({ error: 'Introuvable' });
  if (art.author?.name === username) return res.status(403).json({ error: 'Interdit de voter pour sa propre œuvre' });
  const voters = art.voters || [];
  if (voters.includes(username)) return res.status(409).json({ error: 'Déjà voté' });
  const updated = await artworks.findOneAndUpdate(
    { id: artId }, { $inc: { votes: 1 }, $push: { voters: username } }, { returnDocument: 'after' }
  );
  res.json({ ok: true, votes: updated.votes });
});

app.post('/api/gallery/:id/view', async (req, res) => {
  await artworks.updateOne({ id: req.params.id }, { $inc: { views: 1 } });
  res.json({ ok: true });
});

app.post('/api/save', async (req, res) => {
  const { name, title, img } = req.body;
  if (!artworks) return res.status(503).json({ error: 'DB non prête' });
  const artwork = { id: uuid(), title, img, password: '', author: { name: name || 'anonymous' }, votes: 0, views: 0, status: 'approved', archived: false, createdAt: new Date() };
  await artworks.insertOne(artwork);
  res.json({ id: artwork.id, success: true });
});

app.get('/api/game/goldpixel/top10', async (req, res) => {
  if (!artworks) return res.json([]);
  const data = await artworks.find({ status: 'approved', archived: { $ne: true } }).sort({ votes: -1 }).limit(10).project({ img: 1, title: 1, 'author.name': 1, votes: 1, id: 1 }).toArray();
  res.json(data);
});

app.get('/api/game/goldpixel/top10-players', async (req, res) => {
  if (!artworks) return res.json([]);
  const pipeline = [
    { $match: { status: 'approved', archived: { $ne: true } } },
    { $group: { _id: '$author.name', totalVotes: { $sum: '$votes' }, artCount: { $sum: 1 }, bestImg: { $first: '$img' } } },
    { $sort: { totalVotes: -1 } }, { $limit: 10 },
    { $project: { name: '$_id', totalVotes: 1, artCount: 1, bestImg: 1 } }
  ];
  const data = await artworks.aggregate(pipeline).toArray();
  res.json(data);
});

app.get('/api/game/goldpixel/player/:name', async (req, res) => {
  if (!artworks) return res.json({ arts: [], totalVotes: 0 });
  const arts = await artworks.find({ 'author.name': req.params.name, status: 'approved', archived: { $ne: true } }).sort({ createdAt: -1 }).toArray();
  const totalVotes = arts.reduce((s, a) => s + (a.votes || 0), 0);
  res.json({ arts, totalVotes });
});

app.get('/api/game/goldpixel/all-players', async (req, res) => {
  if (!artworks) return res.json([]);
  const pipeline = [
    { $match: { status: 'approved', archived: { $ne: true } } },
    { $group: { _id: '$author.name', totalVotes: { $sum: '$votes' }, artCount: { $sum: 1 }, bestImg: { $first: '$img' } } },
    { $sort: { totalVotes: -1 } },
    { $project: { name: '$_id', totalVotes: 1, artCount: 1, bestImg: 1 } }
  ];
  res.json(await artworks.aggregate(pipeline).toArray());
});

app.get('/api/top10',        (req, res) => res.redirect('/api/game/goldpixel/top10'));
app.get('/api/top10-players',(req, res) => res.redirect('/api/game/goldpixel/top10-players'));
app.get('/api/all-players',  (req, res) => res.redirect('/api/game/goldpixel/all-players'));
app.get('/api/vote',         (req, res) => res.json([]));
app.post('/api/vote', withPiUser(false), async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id requis' });
  const updated = await artworks.findOneAndUpdate({ id }, { $inc: { votes: 1 } }, { returnDocument: 'after' });
  if (!updated) return res.status(404).json({ error: 'Introuvable' });
  res.json({ ok: true, votes: updated.votes });
});
app.get('/api/player/:name', (req, res) => res.redirect(`/api/game/goldpixel/player/${req.params.name}`));

app.post('/api/game/neonbreaker/score', async (req, res) => {
  try {
    const { name, score, level, combo, bricks } = req.body;
    if (!name || typeof score !== 'number') return res.status(400).json({ error: 'name + score requis' });
    const col_ = db.collection('neonbreaker_scores');
    const existing = await col_.findOne({ name: name.slice(0,20) });
    if (existing && existing.score >= score) return res.json({ ok: true, best: existing.score });
    await col_.updateOne({ name: name.slice(0,20) }, { $set: { name: name.slice(0,20), score, level: level||1, combo: combo||0, bricks: bricks||0, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true, newBest: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/game/neonbreaker/scores', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit)||20);
    const data  = await db.collection('neonbreaker_scores').find({}).sort({ score: -1 }).limit(limit).toArray();
    res.json(data);
  } catch (e) { res.status(500).json([]); }
});

app.post('/api/contact', async (req, res) => {
  try {
    const { type, ...fields } = req.body;
    if (!type) return res.status(400).json({ error: 'type requis' });
    await db.collection('contacts').insertOne({ type, fields, receivedAt: new Date(), status: 'new' });
    res.json({ ok: true });
  } catch (e) { console.error('Contact save error:', e.message); res.json({ ok: true }); }
});

app.get('/api/contact/list', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const type = req.query.type;
    const data = await db.collection('contacts').find(type ? { type } : {}).sort({ receivedAt: -1 }).limit(200).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/contact/:id/status', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { status } = req.body;
  if (!['new','read','replied'].includes(status)) return res.status(400).json({ error: 'status invalide' });
  await db.collection('contacts').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
  res.json({ ok: true });
});

app.post('/api/payment/approve', async (req, res) => {
  const { paymentId } = req.body;
  try {
    const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, { method: 'POST', headers: { Authorization: `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payment/complete', async (req, res) => {
  const { paymentId, txid, artId, type, piUsername } = req.body;
  try {
    // ── 1. Compléter la transaction côté Pi Network (toujours en premier) ──
    await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method:  'POST',
      headers: { Authorization: `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ txid }),
    });

    const now = new Date();

    // ── 2. Anciens types portail (conservés intacts) ──
    if (type === 'feature_24h' && artId)
      await artworks.updateOne({ id: artId }, { $set: { featured: true, featuredUntil: new Date(now.getTime() + 86400000) } });
    if (type === 'gold_pixels' && artId)
      await artworks.updateOne({ id: artId }, { $set: { goldPixels: true } });
    if (type === 'extra_slots') {
      const u = req.body.username || piUsername;
      if (u) {
        const today = new Date(); today.setHours(0,0,0,0);
        await users.updateOne({ piUsername: u }, { $set: { extraSlots: true, extraSlotsDate: today } }, { upsert: false });
      }
    }

    // ── 3. Nouveaux items Gold Pixel shop (persistance MongoDB) ──
    // Chaque effet est idempotent : relancer avec le même paymentId ne double pas l'effet.

    if (piUsername && users) {

      // ── Boucliers — écriture de shieldExpiry en base ──
      // Au rechargement, /api/goldpixel/my-status lira ce champ et restaurera le bouclier.
      if (type === 'dome_4h') {
        const expiry = new Date(now.getTime() + 4 * 60 * 60 * 1000); // +4h
        await users.updateOne(
          { piUsername },
          { $set: { shieldExpiry: expiry, shieldPaymentId: paymentId } },
          { upsert: false }
        );
        console.log(`[shop] dome_4h → @${piUsername} shieldExpiry=${expiry.toISOString()}`);
      }

      if (type === 'dome_8h') {
        const expiry = new Date(now.getTime() + 8 * 60 * 60 * 1000); // +8h
        await users.updateOne(
          { piUsername },
          { $set: { shieldExpiry: expiry, shieldPaymentId: paymentId } },
          { upsert: false }
        );
        console.log(`[shop] dome_8h → @${piUsername} shieldExpiry=${expiry.toISOString()}`);
      }

      // ── Pixels chargeurs — incrément de bonusPixels en base ──
      // Le front lit ce champ au démarrage via /api/goldpixel/my-status.
      // bonusPixels est décrémenté à chaque pixel Or utilisé (implémentation future côté moteur).
      // Pour l'instant : le montant est crédité et utilisé en session locale.
      if (type === 'pixels_100') {
        await users.updateOne(
          { piUsername },
          { $inc: { bonusPixels: 100 } },
          { upsert: false }
        );
        console.log(`[shop] pixels_100 → @${piUsername} +100 bonusPixels`);
      }

      if (type === 'pixels_250') {
        await users.updateOne(
          { piUsername },
          { $inc: { bonusPixels: 250 } },
          { upsert: false }
        );
        console.log(`[shop] pixels_250 → @${piUsername} +250 bonusPixels`);
      }

      // ── Pack Vengeance — abonnement mensuel ──
      // Actif 30 jours à partir de l'achat (renouvelable).
      if (type === 'vengeance_pack') {
        const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // +30 jours
        await users.updateOne(
          { piUsername },
          { $set: { vengeanceActive: true, vengeanceExpiry: expiry, vengeancePaymentId: paymentId } },
          { upsert: false }
        );
        console.log(`[shop] vengeance_pack → @${piUsername} expiry=${expiry.toISOString()}`);
      }

      // ── Distinction — don de 0,1 Pi pour valoriser une œuvre ──
      // Enregistré dans la collection 'donations' pour historique et galerie.
      if (type === 'distinction') {
        if (db) {
          const donations = db.collection('donations');
          await donations.insertOne({
            type:      'distinction',
            fromUser:  piUsername,
            paymentId,
            txid,
            amount:    0.1,
            createdAt: now,
          });
        }
        console.log(`[shop] distinction → @${piUsername} don enregistré`);
      }

      // ── Don Elite — offrir le pack Elite à un autre joueur ──
      // Le recipient est passé dans les metadata (à implémenter côté front).
      if (type === 'gift_elite') {
        const recipient = req.body.recipient || null;
        if (db) {
          const donations = db.collection('donations');
          await donations.insertOne({
            type:      'gift_elite',
            fromUser:  piUsername,
            toUser:    recipient,
            paymentId,
            txid,
            amount:    10,
            createdAt: now,
          });
        }
        // Si le destinataire est connu, lui activer l'Elite 30 jours
        if (recipient) {
          const giftExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          await users.updateOne(
            { piUsername: recipient },
            { $set: { isGold: true, goldExpiry: giftExpiry, goldSource: 'gift', goldGiftFrom: piUsername } },
            { upsert: false }
          );
          console.log(`[shop] gift_elite → @${piUsername} offre Elite à @${recipient}`);
        }
      }

      // ── Don anonyme — montant libre ──
      if (type === 'anon_don') {
        const recipient = req.body.recipient || 'ANONYME';
        if (db) {
          const donations = db.collection('donations');
          await donations.insertOne({
            type:      'anon_don',
            fromUser:  req.body.anonymous ? 'ANONYME' : piUsername,
            toUser:    recipient,
            paymentId,
            txid,
            amount:    req.body.amount || null,
            createdAt: now,
          });
        }
        console.log(`[shop] anon_don → don enregistré`);
      }

    } // fin if (piUsername && users)

    res.json({ ok: true });
  } catch (e) {
    console.error('[payment/complete] erreur:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  GOLD PIXEL — ROUTES STATUT JOUEUR
//  Ces deux routes sont appelées par goldpixel.html au démarrage.
// ═══════════════════════════════════════════════════════════════

// ── GET /api/member/status/:username ─────────────────────────
// Appelé par checkGoldStatus() dans goldpixel.html juste après
// l'authentification Pi. Retourne :
//   { isGold, daysLeft, isElite }
//
// isGold / isElite correspondent au Pack Elite (abonnement 1 Pi/mois).
// La distinction "Gold" vs "Elite" est historique — le terme en base
// est `isGold` mais l'UI affiche "Elite".
app.get('/api/member/status/:username', async (req, res) => {
  const { username } = req.params;
  if (!username) return res.status(400).json({ error: 'username requis' });

  try {
    if (!users) return res.json({ isGold: false, daysLeft: 0 });

    const user = await users.findOne(
      { piUsername: username },
      { projection: { isGold: 1, goldExpiry: 1, goldSource: 1 } }
    );

    if (!user) return res.json({ isGold: false, daysLeft: 0 });

    // Vérifier si l'abonnement Elite est encore valide
    const now       = new Date();
    const expiry    = user.goldExpiry ? new Date(user.goldExpiry) : null;
    const isActive  = user.isGold && expiry && expiry > now;
    const daysLeft  = isActive
      ? Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
      : 0;

    // Si l'abonnement a expiré, mettre à jour la base (lazy expiry)
    if (user.isGold && !isActive) {
      await users.updateOne(
        { piUsername: username },
        { $set: { isGold: false } }
      );
    }

    res.json({
      isGold:   isActive,   // compatibilité front existant
      isElite:  isActive,   // alias — même valeur
      daysLeft: daysLeft,
    });
  } catch (e) {
    console.error('[member/status]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── GET /api/goldpixel/my-status ─────────────────────────────
// Appelé par goldpixel.html au démarrage (après authenticate).
// Restaure l'état de jeu persisté en base :
//   • bouclier actif + secondes restantes
//   • pixels bonus restants (overfill)
//   • pack vengeance actif
//
// Requiert le header Authorization: Bearer <Pi accessToken>
// (utilise withPiUser existant)
app.get('/api/goldpixel/my-status', withPiUser(false), async (req, res) => {
  try {
    if (!users || !req.piUser) return res.json({ ok: true });

    const user = await users.findOne(
      { piUsername: req.piUser.username },
      {
        projection: {
          shieldExpiry:     1,
          bonusPixels:      1,
          vengeanceActive:  1,
          vengeanceExpiry:  1,
          isGold:           1,
          goldExpiry:       1,
        }
      }
    );

    if (!user) return res.json({ ok: true });

    const now = new Date();

    // ── Bouclier ──
    const shieldExpiry  = user.shieldExpiry ? new Date(user.shieldExpiry) : null;
    const shieldActive  = shieldExpiry && shieldExpiry > now;
    const shieldSecsLeft = shieldActive
      ? Math.ceil((shieldExpiry - now) / 1000)
      : 0;

    // Si le bouclier a expiré, on le nettoie (lazy)
    if (user.shieldExpiry && !shieldActive) {
      await users.updateOne(
        { piUsername: req.piUser.username },
        { $unset: { shieldExpiry: '', shieldPaymentId: '' } }
      );
    }

    // ── Vengeance ──
    const vengeanceExpiry  = user.vengeanceExpiry ? new Date(user.vengeanceExpiry) : null;
    const vengeanceActive  = user.vengeanceActive && vengeanceExpiry && vengeanceExpiry > now;

    if (user.vengeanceActive && !vengeanceActive) {
      await users.updateOne(
        { piUsername: req.piUser.username },
        { $set: { vengeanceActive: false } }
      );
    }

    // ── Bonus pixels ──
    const bonusPixels = Math.max(0, user.bonusPixels || 0);

    // ── Elite ──
    const goldExpiry  = user.goldExpiry ? new Date(user.goldExpiry) : null;
    const isElite     = user.isGold && goldExpiry && goldExpiry > now;

    res.json({
      ok:             true,
      shieldActive:   shieldActive,
      shieldSecsLeft: shieldSecsLeft,
      bonusPixels:    bonusPixels,
      vengeanceActive: vengeanceActive,
      isElite:        isElite,
    });
  } catch (e) {
    console.error('[my-status]', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/leaderboard/countries', async (req, res) => {
  if (!artworks) return res.json([]);
  const pipeline = [
    { $match: { status: 'approved', archived: { $ne: true } } },
    { $lookup: { from: 'users', localField: 'author.name', foreignField: 'piUsername', as: 'userInfo' } },
    { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
    { $group: { _id: '$userInfo.country', totalVotes: { $sum: '$votes' }, artCount: { $sum: 1 } } },
    { $match: { _id: { $ne: null } } }, { $sort: { totalVotes: -1 } }, { $limit: 10 }
  ];
  res.json(await artworks.aggregate(pipeline).toArray());
});

app.post('/api/archive/run', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const now   = new Date();
  const label = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const col_  = db.collection(`archive_${label}`);
  const toArchive = await artworks.find({ status: 'approved', archived: { $ne: true } }).toArray();
  if (toArchive.length) { await col_.insertMany(toArchive); await artworks.updateMany({ status: 'approved', archived: { $ne: true } }, { $set: { archived: true } }); }
  res.json({ ok: true, archived: toArchive.length, label });
});

app.get('/api/archive/list', async (req, res) => {
  const cols = await db.listCollections().toArray();
  res.json(cols.map(c => c.name).filter(n => n.startsWith('archive_')).sort().reverse());
});

app.get('/api/archive/:label', async (req, res) => {
  const data = await db.collection(`archive_${req.params.label}`).find({}).sort({ votes: -1 }).limit(100).toArray();
  res.json(data);
});


// ═══════════════════════════════════════════════════════════════
//  NOUVELLES ROUTES — Systèmes configurables Gold Pixel
// ═══════════════════════════════════════════════════════════════

// ── GET /api/goldpixel/config ──────────────────────────────────
// Expose la config publique au front-end (flags enabled + params non-secrets).
// Le front-end peut ajuster son comportement selon l'état des systèmes.
app.get('/api/goldpixel/config', (req, res) => {
  const pub = {};
  for (const [key, cfg] of Object.entries(GAME_CONFIG)) {
    // N'exposer que enabled + params non-sensibles
    pub[key] = { enabled: cfg.enabled };
    // Ajouter les paramètres utiles au client
    if (key === 'world_expansion')  pub[key].dimensions = { initialCols: cfg.initialCols, initialRows: cfg.initialRows, maxCols: cfg.maxCols, maxRows: cfg.maxRows };
    if (key === 'first_pixel_prot') pub[key].durationMs = cfg.durationMs;
    if (key === 'season_logo')      pub[key].seasonLabel = cfg.seasonLabel;
    if (key === 'terrain_fatigue')  pub[key].maxRepaints = cfg.maxRepaints;
  }
  res.json(pub);
});

// ── GET /api/goldpixel/world ───────────────────────────────────
// Dimensions courantes du canvas + point de spawn recommandé.
app.get('/api/goldpixel/world', async (req, res) => {
  try {
    const [dims, spawn] = await Promise.all([
      WorldExpansionService.getCurrentDimensions(),
      SocialSpawnService.getSpawnPoint(),
    ]);
    res.json({ dimensions: dims, spawn });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/goldpixel/season ──────────────────────────────────
// État de la saison courante : logo, reset, etc.
app.get('/api/goldpixel/season', async (req, res) => {
  try {
    const logoStatus = await SeasonLogoService.getStatus();
    res.json({ logo: logoStatus, seasonLabel: GAME_CONFIG.season_logo.seasonLabel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/goldpixel/fatigue ─────────────────────────────────
// Zones fatiguées autour d'une cellule (pour heatmap front-end).
app.get('/api/goldpixel/fatigue', async (req, res) => {
  try {
    const col    = parseInt(req.query.col) || 40;
    const row    = parseInt(req.query.row) || 22;
    const radius = Math.min(20, parseInt(req.query.radius) || 10);
    const info   = await TerrainFatigueService.zoneInfo(col, row, radius);
    res.json(info);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/goldpixel/first-pixel ───────────────────────────
// Active la protection 10 min pour un nouveau joueur.
// Appelé dès que le joueur place son 1er pixel.
app.post('/api/goldpixel/first-pixel', withPiUser(true), async (req, res) => {
  try {
    const result = await FirstPixelProtService.activate(req.piUser.username);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/goldpixel/protection/:username ───────────────────
// État de protection d'un joueur (pour le front-end).
app.get('/api/goldpixel/protection/:username', async (req, res) => {
  try {
    const status = await FirstPixelProtService.getStatus(req.params.username);
    res.json(status);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/goldpixel/place-pixel ───────────────────────────
// Route de placement de pixel — stub avec goldPixelGuard.
// À implémenter quand le pixel-grid est stocké en base.
// Pour l'instant : valide les guards et retourne ok.
app.post('/api/goldpixel/place-pixel', withPiUser(false), goldPixelGuard, async (req, res) => {
  const { col, row, color } = req.body;
  const username = req.piUser?.username || 'anonymous';

  // ── Enregistrer le repaint pour la fatigue ──
  await TerrainFatigueService.record(username, col, row);

  // TODO : stocker le pixel en base quand le modèle est prêt
  // await db.collection('pixel_grid').updateOne(
  //   { cellKey: `${col},${row}` },
  //   { $set: { color, piUsername: username, updatedAt: new Date() } },
  //   { upsert: true }
  // );

  res.json({ ok: true, col, row, color });
});

// ── Routes admin — protégées x-admin-secret ────────────────────

// POST /api/admin/season-logo/activate
app.post('/api/admin/season-logo/activate', async (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const result = await SeasonLogoService.activate(req.body.seasonLabel);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/season-reset/run
app.post('/api/admin/season-reset/run', async (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const result = await SeasonResetService.run();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/config/update — modifier un param de config à chaud
// ⚠️ En prod, ce endpoint doit être restreint et loggué.
app.post('/api/admin/config/update', async (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { system, key, value } = req.body;
  if (!GAME_CONFIG[system] || !(key in GAME_CONFIG[system])) {
    return res.status(400).json({ error: 'Système ou clé invalide' });
  }
  const oldValue = GAME_CONFIG[system][key];
  GAME_CONFIG[system][key] = value;
  console.log(`⚙️ Config update: ${system}.${key} : ${oldValue} → ${value}`);
  res.json({ ok: true, system, key, oldValue, newValue: value });
});


// ═══════════════════════════════════════════════════════════════
//  ROUTES SHOP — Gold Credits (v3.1)
//  Montées ici pour être après withPiUser et les helpers existants.
// ═══════════════════════════════════════════════════════════════

// Injection db dans le shop (db est disponible après connectDB())
// Note : ShopRoutes.inject() est appelé dans connectDB() ci-dessus,
//        mais on monte les routes Express ici (ordre important).
app.use('/api/shop', ShopRoutes.router);


// ═══════════════════════════════════════════════════════════════════════════
//  ██████╗  ██████╗ ███╗   ██╗████████╗    ██████╗  ██████╗ ██████╗ ████████╗
//  ██╔══██╗██╔═══██╗████╗  ██║╚══██╔══╝    ██╔══██╗██╔═══██╗██╔══██╗╚══██╔══╝
//  ██████╔╝██║   ██║██╔██╗ ██║   ██║       ██████╔╝██║   ██║██████╔╝   ██║
//  ██╔═══╝ ██║   ██║██║╚██╗██║   ██║       ██╔═══╝ ██║   ██║██╔══██╗   ██║
//  ██║     ╚██████╔╝██║ ╚████║   ██║       ██║     ╚██████╔╝██║  ██║   ██║
//  ╚═╝      ╚═════╝ ╚═╝  ╚═══╝   ╚═╝       ╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝
//
//  GOLD PIXEL → PORTAIL JEUXVIDEO.PI
//  ══════════════════════════════════════════════════════════════════════════
//  Ce bloc est le "pont" (bridge) entre le moteur de jeu Gold Pixel
//  et la page publique du jeu sur le portail JeuxVideo.Pi.
//
//  Il implémente 3 fonctionnalités :
//
//  1. SNAPSHOT MENSUEL (reset + galerie des saisons)
//     - Chaque dernier jour du mois à 23h59 : capture HD du canevas final
//       sous forme d'image base64 + export JSON de toutes les œuvres actives
//     - Stocké dans la collection MongoDB `season_snapshots`
//     - Mis à disposition du portail via GET /api/portal/seasons
//
//  2. DÉPORT DES SCORES (top10, classements, annuaire)
//     - Les données ne sont plus chargées dans le moteur de jeu
//     - Nouvelles routes publiques pour la page du portail :
//         GET /api/portal/goldpixel/top10
//         GET /api/portal/goldpixel/top10-players
//         GET /api/portal/goldpixel/all-players
//         GET /api/portal/goldpixel/gallery
//         GET /api/portal/goldpixel/seasons
//
//  3. PONT CRON (keep-alive et déclencheurs automatiques)
//     - POST /api/cron/season-snapshot  → déclenché par GitHub Actions cron
//     - POST /api/cron/monthly-reset    → déclenché le 1er du mois à 00h00
//
//  ARCHITECTURE :
//
//    GitHub Actions cron (keep-alive.yml)
//         │
//         ├─ toutes les 9 min  → GET  /ping              (keep-alive Render)
//         ├─ 23h59 dernier jr  → POST /api/cron/season-snapshot  (capture)
//         └─ 00h00 1er du mois → POST /api/cron/monthly-reset    (reset)
//
//    Page portail JeuxVideo.Pi
//         │
//         ├─ GET /api/portal/goldpixel/gallery    (galerie publique)
//         ├─ GET /api/portal/goldpixel/top10      (top 10 œuvres)
//         ├─ GET /api/portal/goldpixel/top10-players
//         ├─ GET /api/portal/goldpixel/all-players
//         └─ GET /api/portal/goldpixel/seasons    (archives mensuelles)
//
//  SÉCURITÉ :
//    Les routes /api/cron/* sont protégées par le header :
//      x-cron-secret: <CRON_SECRET>   (variable d'environnement Render)
//    Les routes /api/portal/* sont publiques (lecture seule, pas de mutation).
//
// ═══════════════════════════════════════════════════════════════════════════


// ───────────────────────────────────────────────────────────────────────────
//  SECTION A — SNAPSHOT MENSUEL
//  Fonctions utilitaires pour capturer l'état du canevas à la fin du mois
// ───────────────────────────────────────────────────────────────────────────

// detectLastDayOfMonth()
// Retourne true si aujourd'hui est le dernier jour du mois calendaire.
// Utilisé par le cron pour décider s'il doit déclencher le snapshot.
function detectLastDayOfMonth() {
  const now      = new Date();                      // date/heure actuelle
  const tomorrow = new Date(now);                   // copie de la date
  tomorrow.setDate(tomorrow.getDate() + 1);         // avancer d'un jour
  return tomorrow.getDate() === 1;                  // si demain = 1er → c'est le dernier jour
}

// detectFirstDayOfMonth()
// Retourne true si aujourd'hui est le 1er du mois.
// Utilisé par le cron mensuel pour déclencher le "Grand Nettoyage".
function detectFirstDayOfMonth() {
  return new Date().getDate() === 1;                // vrai si le jour courant est le 1er
}

// buildSeasonLabel()
// Construit le label de saison au format "YYYY-MM" (ex: "2026-03").
// Ce label sert de clé unique pour chaque archive mensuelle.
function buildSeasonLabel(date = new Date()) {
  const y = date.getFullYear();                     // année sur 4 chiffres
  const m = String(date.getMonth() + 1).padStart(2, '0'); // mois 01–12
  return `${y}-${m}`;                              // ex: "2026-03"
}

// buildMonthLabel(date)
// Construit un libellé humain pour affichage sur le portail.
// Ex: "Mars 2026"
function buildMonthLabel(date = new Date()) {
  // Noms des mois en français pour l'affichage portail
  const mois = [
    'Janvier','Février','Mars','Avril','Mai','Juin',
    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'
  ];
  return `${mois[date.getMonth()]} ${date.getFullYear()}`; // ex: "Mars 2026"
}

// takeSeasonSnapshot(triggeredBy)
// Fonction principale de capture. Appelée par le cron à 23h59
// le dernier jour du mois. Elle :
//   1. Récupère toutes les œuvres approuvées non archivées
//   2. Calcule les stats du mois (top joueurs, total pixels, etc.)
//   3. Construit un document snapshot complet
//   4. L'insère dans la collection `season_snapshots`
//   5. Retourne le résultat pour logging
//
// NOTE CANVAS HD :
//   Le canevas est rendu côté client (navigateur) avec un <canvas> HTML.
//   Le serveur Node.js n'a pas accès au DOM. Il existe deux approches :
//   A. Le dernier joueur connecté envoie la capture via POST /api/snapshot/upload
//      (déclenché côté client à 23h59 par un setInterval)
//   B. Un service headless (Puppeteer) prend une screenshot — plus complexe.
//   → On implémente l'approche A (recommandée pour Render sans headless).
//   La capture base64 est stockée dans `canvasImageB64` du snapshot.
//
async function takeSeasonSnapshot(triggeredBy = 'cron') {
  try {
    // ── Récupérer les œuvres actives du mois ──────────────────────
    const currentArtworks = await artworks               // collection MongoDB `artworks`
      .find({ status: 'approved', archived: { $ne: true } }) // uniquement les approuvées non archivées
      .sort({ votes: -1 })                               // triées par votes décroissants
      .toArray();                                        // convertir en tableau JS

    // ── Calculer les statistiques du mois ─────────────────────────
    // Agréger par auteur pour calculer le top joueurs du mois
    const playerStats = {};                              // dictionnaire piUsername → stats
    for (const art of currentArtworks) {               // parcourir chaque œuvre
      const name = art.author?.name || 'anonymous';    // récupérer le pseudo de l'auteur
      if (!playerStats[name]) {                         // initialiser si premier artwork
        playerStats[name] = { name, artCount: 0, totalVotes: 0, bestImg: art.img };
      }
      playerStats[name].artCount++;                    // incrémenter le nombre d'œuvres
      playerStats[name].totalVotes += (art.votes || 0); // additionner les votes
    }

    // Convertir en tableau trié par votes puis par nombre d'œuvres
    const topPlayers = Object.values(playerStats)      // extraire les valeurs
      .sort((a, b) =>                                  // trier :
        b.totalVotes - a.totalVotes ||                 //   1. par votes décroissants
        b.artCount   - a.artCount                      //   2. par nombre d'œuvres en cas d'égalité
      )
      .slice(0, 10);                                   // garder seulement le top 10

    // ── Construire le document snapshot ───────────────────────────
    const now       = new Date();                      // timestamp de la capture
    const label     = buildSeasonLabel(now);           // ex: "2026-03"
    const monthName = buildMonthLabel(now);            // ex: "Mars 2026"

    const snapshot = {
      // Identifiants
      seasonLabel:    label,                           // clé unique de la saison
      monthName,                                       // libellé humain pour le portail
      capturedAt:     now,                             // date/heure exacte de la capture
      triggeredBy,                                     // 'cron' | 'admin' | 'manual'

      // Données du mois
      artworks: currentArtworks.map(a => ({           // liste simplifiée des œuvres
        id:         a.id,                             //   ID unique
        title:      a.title,                          //   titre de l'œuvre
        img:        a.img,                            //   image base64 WebP
        authorName: a.author?.name || 'anonymous',   //   pseudo de l'auteur
        votes:      a.votes || 0,                    //   nombre de votes
        views:      a.views || 0,                    //   nombre de vues
        createdAt:  a.createdAt,                     //   date de création
      })),
      totalArtworks: currentArtworks.length,          // nombre total d'œuvres du mois

      // Classements
      topArtworks: currentArtworks.slice(0, 10).map(a => ({ // top 10 œuvres par votes
        id: a.id, title: a.title, votes: a.votes,
        authorName: a.author?.name, img: a.img,
      })),
      topPlayers,                                      // top 10 joueurs calculé ci-dessus

      // Capture canvas HD — null jusqu'à l'upload client (voir POST /api/snapshot/upload)
      canvasImageB64: null,                            // sera rempli par le client à 23h59
      canvasUploadedAt: null,                          // timestamp upload client

      // Métadonnées
      status: 'pending_canvas',                        // attend la capture canvas du client
    };

    // ── Vérifier si un snapshot existe déjà pour ce mois ──────────
    // Idempotent : évite les doublons si le cron est déclenché deux fois
    const existing = await db.collection('season_snapshots') // collection des archives
      .findOne({ seasonLabel: label });                // chercher par label du mois

    if (existing) {
      // Snapshot déjà présent → mettre à jour les stats sans écraser la capture canvas
      await db.collection('season_snapshots').updateOne(
        { seasonLabel: label },                        // filtre : même mois
        { $set: {                                      // mise à jour partielle
            artworks:      snapshot.artworks,          //   œuvres actualisées
            totalArtworks: snapshot.totalArtworks,     //   compteur actualisé
            topArtworks:   snapshot.topArtworks,       //   top 10 actualisé
            topPlayers:    snapshot.topPlayers,        //   classement actualisé
            updatedAt:     now,                        //   timestamp MAJ
          }
        }
      );
      console.log(`[Snapshot] Mis à jour — saison ${label} (${currentArtworks.length} œuvres)`);
      return { ok: true, updated: true, label, total: currentArtworks.length };
    }

    // Snapshot inexistant → insertion
    await db.collection('season_snapshots').insertOne(snapshot);
    console.log(`[Snapshot] Créé — saison ${label} (${currentArtworks.length} œuvres)`);
    return { ok: true, created: true, label, total: currentArtworks.length };

  } catch (e) {
    // Toujours logger les erreurs de snapshot
    console.error('[Snapshot] Erreur :', e.message);
    throw e;                                           // re-throw pour la gestion d'erreur HTTP
  }
}

// runMonthlyReset(label)
// Effectue le "Grand Nettoyage" du 1er du mois à 00h00 :
//   1. Archive toutes les œuvres actives (marquées archived: true)
//   2. Réinitialise les compteurs quotidiens des joueurs
//   3. Désactive le logo de saison
//   4. Enregistre le reset dans `season_snapshots`
//
async function runMonthlyReset(label) {
  try {
    // ── 1. Archiver les œuvres actives ───────────────────────────
    const result = await artworks.updateMany(
      { status: 'approved', archived: { $ne: true } }, // toutes les œuvres visibles
      { $set: { archived: true, archivedAt: new Date() } } // marquées archivées
    );
    console.log(`[Reset] ${result.modifiedCount} œuvres archivées pour la saison ${label}`);

    // ── 2. Réinitialiser les compteurs quotidiens des joueurs ─────
    // Le quota de publication repart à 0 pour la nouvelle saison
    await users.updateMany(
      {},                                              // tous les joueurs
      { $set: { dailyCount: 0, dailyReset: new Date() } } // reset du compteur
    );
    console.log(`[Reset] Compteurs joueurs réinitialisés`);

    // ── 3. Mettre à jour le snapshot avec le statut "reset complet" ──
    await db.collection('season_snapshots').updateOne(
      { seasonLabel: label },                          // même mois
      {
        $set: {
          status:  'complete',                         // snapshot finalisé
          resetAt: new Date(),                         // heure du reset
        }
      },
      { upsert: false }                               // ne pas créer si inexistant (le snapshot doit déjà être là)
    );

    return { ok: true, archived: result.modifiedCount };

  } catch (e) {
    console.error('[Reset] Erreur :', e.message);
    throw e;
  }
}


// ───────────────────────────────────────────────────────────────────────────
//  SECTION B — ROUTES CRON (déclenchées par GitHub Actions)
// ───────────────────────────────────────────────────────────────────────────

// POST /api/cron/season-snapshot
// ─────────────────────────────
// Déclenché par GitHub Actions à 23h59 le dernier jour du mois.
// Capture l'état du mois (stats, classements, liste œuvres).
// La capture canvas HD est fournie par le client (voir POST /api/snapshot/upload).
//
// Sécurité : header x-cron-secret obligatoire
//
// Exemple GitHub Actions step :
//   - name: Season Snapshot
//     run: |
//       curl -X POST https://jeuxvideo.onrender.com/api/cron/season-snapshot \
//            -H "x-cron-secret: ${{ secrets.CRON_SECRET }}"
//
app.post('/api/cron/season-snapshot', async (req, res) => {
  // ── Vérifier l'authentification cron ──
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' }); // refus si secret incorrect
  }

  try {
    // Déclencher la capture mensuelle
    const result = await takeSeasonSnapshot('cron'); // label 'cron' pour le logging
    res.json(result);                                // retourner le résultat au cron
  } catch (e) {
    res.status(500).json({ error: e.message });     // erreur serveur
  }
});

// POST /api/cron/monthly-reset
// ────────────────────────────
// Déclenché par GitHub Actions le 1er du mois à 00h00.
// Lance le Grand Nettoyage : archive les œuvres, reset les compteurs.
//
// Ce endpoint vérifie automatiquement qu'on est bien le 1er du mois
// pour éviter une exécution accidentelle le reste du mois.
//
// Exemple GitHub Actions step :
//   - name: Monthly Reset
//     run: |
//       curl -X POST https://jeuxvideo.onrender.com/api/cron/monthly-reset \
//            -H "x-cron-secret: ${{ secrets.CRON_SECRET }}"
//
app.post('/api/cron/monthly-reset', async (req, res) => {
  // ── Vérifier l'authentification cron ──
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ── Vérifier qu'on est bien le 1er du mois ──
  // Protection contre une exécution accidentelle un autre jour
  if (!detectFirstDayOfMonth()) {
    return res.status(400).json({
      error: 'NOT_FIRST_DAY',
      message: "Ce cron ne s'exécute que le 1er du mois",
      today: new Date().getDate(),                   // jour actuel pour debug
    });
  }

  try {
    // Calculer le label du MOIS PRÉCÉDENT (le mois qui vient de se terminer)
    const now       = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1); // 1er du mois précédent
    const label     = buildSeasonLabel(lastMonth);   // ex: "2026-02" si on est en mars

    // Lancer le reset
    const result = await runMonthlyReset(label);
    res.json({ ...result, label, monthName: buildMonthLabel(lastMonth) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/snapshot/upload
// ─────────────────────────
// Reçoit la capture canvas HD depuis le client JavaScript.
// Le client appelle cette route à 23h59 le dernier jour du mois,
// en envoyant l'image base64 du canvas (toDataURL).
//
// Le client (goldpixel.html) est responsable de détecter l'heure
// et d'envoyer la capture. Cela évite d'avoir besoin de Puppeteer.
//
// Corps de la requête :
//   { canvasImageB64: string, seasonLabel: string, piUsername?: string }
//
app.post('/api/snapshot/upload', async (req, res) => {
  // ── Extraire les données de la requête ──
  const { canvasImageB64, seasonLabel, piUsername } = req.body;

  // ── Validation basique ──
  if (!canvasImageB64 || !seasonLabel) {
    return res.status(400).json({ error: 'canvasImageB64 et seasonLabel requis' });
  }

  // ── Vérifier que le label correspond bien au mois courant ou précédent ──
  // (empêche d'injecter une image pour un mois futur ou très ancien)
  const currentLabel  = buildSeasonLabel();          // label du mois en cours
  const now           = new Date();
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastLabel     = buildSeasonLabel(lastMonthDate); // label du mois précédent

  if (seasonLabel !== currentLabel && seasonLabel !== lastLabel) {
    return res.status(400).json({
      error: 'INVALID_SEASON',
      message: `Label de saison invalide. Attendu: ${currentLabel} ou ${lastLabel}`,
    });
  }

  // ── Vérifier que l'image est bien un base64 valide ──
  if (!canvasImageB64.startsWith('data:image/')) {
    return res.status(400).json({ error: "Format d'image invalide (attendu base64 data:image/...)" });
  }

  // ── Limiter la taille de l'image (max 5 Mo) pour éviter les abus ──
  const imageSizeBytes = canvasImageB64.length * 0.75; // estimation taille base64 → bytes
  const maxSizeBytes   = 5 * 1024 * 1024;             // 5 Mo
  if (imageSizeBytes > maxSizeBytes) {
    return res.status(413).json({ error: 'Image trop grande (max 5 Mo)' });
  }

  try {
    // ── Mettre à jour le snapshot existant avec la capture canvas ──
    const updateResult = await db.collection('season_snapshots').updateOne(
      { seasonLabel },                               // trouver le snapshot du mois
      {
        $set: {
          canvasImageB64,                            // stocker l'image base64
          canvasUploadedAt:  new Date(),             // timestamp de l'upload
          canvasUploadedBy:  piUsername || 'client', // qui a envoyé la capture
          status:           'canvas_received',       // statut mis à jour
        }
      }
    );

    if (updateResult.matchedCount === 0) {
      // Snapshot pas encore créé (le cron n'a pas encore tourné) → créer directement
      await db.collection('season_snapshots').insertOne({
        seasonLabel,                                 // label de la saison
        capturedAt:       new Date(),               // date/heure de l'upload
        triggeredBy:      'client_upload',          // source : client
        canvasImageB64,                             // image canvas
        canvasUploadedAt: new Date(),               // timestamp upload
        canvasUploadedBy: piUsername || 'client',   // auteur de l'upload
        artworks:         [],                       // sera complété par le cron
        status:           'canvas_only',            // capture seule, stats manquantes
      });
    }

    res.json({ ok: true, seasonLabel, size: Math.round(imageSizeBytes / 1024) + ' Ko' });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ───────────────────────────────────────────────────────────────────────────
//  SECTION C — ROUTES PORTAIL (publiques, lecture seule)
//  Consommées par la page Gold Pixel sur JeuxVideo.Pi
// ───────────────────────────────────────────────────────────────────────────

// GET /api/portal/goldpixel/top10
// ────────────────────────────────
// Top 10 des œuvres par votes. Utilisé par le portail pour afficher
// le classement des meilleures créations de la saison en cours.
//
// Réponse : tableau de 10 œuvres { id, title, img, authorName, votes, createdAt }
//
app.get('/api/portal/goldpixel/top10', async (req, res) => {
  if (!artworks) return res.json([]);                // DB pas encore prête → tableau vide

  try {
    // Chercher les 10 meilleures œuvres approuvées non archivées
    const data = await artworks
      .find({ status: 'approved', archived: { $ne: true } }) // filtre : actives
      .sort({ votes: -1 })                           // tri : plus de votes d'abord
      .limit(10)                                     // 10 résultats max
      .project({                                     // sélectionner seulement les champs utiles
        img: 1, title: 1, 'author.name': 1,          //   image, titre, auteur
        votes: 1, views: 1, createdAt: 1, id: 1      //   stats, dates, ID
      })
      .toArray();                                    // convertir en tableau

    res.json(data);                                  // envoyer au portail
  } catch (e) {
    res.status(500).json({ error: e.message });     // erreur serveur
  }
});

// GET /api/portal/goldpixel/top10-players
// ─────────────────────────────────────────
// Top 10 des joueurs par votes cumulés sur la saison en cours.
// Utilisé par le portail pour le classement des artistes.
//
// Réponse : tableau de joueurs { name, totalVotes, artCount, bestImg }
//
app.get('/api/portal/goldpixel/top10-players', async (req, res) => {
  if (!artworks) return res.json([]);

  try {
    // Agrégation MongoDB : grouper par auteur et sommer les votes
    const pipeline = [
      { $match: { status: 'approved', archived: { $ne: true } } }, // filtre actives
      { $group: {                                                    // grouper par auteur
          _id:        '$author.name',                              //   clé = pseudo auteur
          totalVotes: { $sum: '$votes' },                          //   somme des votes
          artCount:   { $sum: 1 },                                 //   nombre d'œuvres
          bestImg:    { $first: '$img' },                          //   image de la meilleure
        }
      },
      { $sort: { totalVotes: -1 } },                               // trier par votes
      { $limit: 10 },                                              // top 10
      { $project: {                                                // renommer les champs
          name: '$_id', totalVotes: 1, artCount: 1, bestImg: 1    //   pour l'API publique
        }
      },
    ];

    const data = await artworks.aggregate(pipeline).toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/portal/goldpixel/all-players
// ──────────────────────────────────────
// Liste complète de tous les joueurs ayant au moins une œuvre.
// Utilisé par le portail pour l'annuaire des artistes.
//
// Query params : ?limit=50 (défaut 100)
//
app.get('/api/portal/goldpixel/all-players', async (req, res) => {
  if (!artworks) return res.json([]);

  try {
    const limit = Math.min(500, parseInt(req.query.limit) || 100); // max 500

    const pipeline = [
      { $match: { status: 'approved', archived: { $ne: true } } }, // filtre actives
      { $group: {
          _id:        '$author.name',
          totalVotes: { $sum: '$votes' },
          artCount:   { $sum: 1 },
          bestImg:    { $first: '$img' },
          lastArt:    { $max: '$createdAt' },        // date dernière œuvre
        }
      },
      { $sort: { totalVotes: -1 } },
      { $limit: limit },
      { $project: { name: '$_id', totalVotes: 1, artCount: 1, bestImg: 1, lastArt: 1 } },
    ];

    const data = await artworks.aggregate(pipeline).toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/portal/goldpixel/gallery
// ───────────────────────────────────
// Galerie publique des créations. Utilisé par le portail.
// Paramètres : ?sort=votes|views|date|name&page=0&limit=30
//
app.get('/api/portal/goldpixel/gallery', async (req, res) => {
  if (!artworks) return res.status(503).json([]);

  // ── Parser les paramètres de la requête ──
  const sortMap = {
    votes: { votes: -1 },                            // tri par votes décroissants
    views: { views: -1 },                            // tri par vues décroissantes
    name:  { title:  1 },                            // tri alphabétique
    date:  { createdAt: -1 },                        // tri par date (récent d'abord)
  };
  const sort  = sortMap[req.query.sort] || sortMap.date; // tri appliqué
  const page  = Math.max(0, parseInt(req.query.page)  || 0); // page courante (0-indexed)
  const limit = Math.min(60, parseInt(req.query.limit) || 30); // résultats par page

  try {
    const data = await artworks
      .find({ status: 'approved', archived: { $ne: true } }) // actives seulement
      .sort(sort)                                    // ordre demandé
      .skip(page * limit)                            // pagination : sauter les pages précédentes
      .limit(limit)                                  // limiter le nombre de résultats
      .project({                                     // champs utiles pour le portail
        img: 1, title: 1, 'author.name': 1,
        votes: 1, views: 1, createdAt: 1, featured: 1, id: 1
      })
      .toArray();

    // ── Compter le total pour la pagination ──
    const total = await artworks.countDocuments({
      status: 'approved', archived: { $ne: true }
    });

    res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/portal/goldpixel/seasons
// ───────────────────────────────────
// Liste toutes les archives de saisons disponibles (pour la Galerie des Saisons).
// Utilisé par le portail pour afficher les captures mensuelles classées par mois.
//
// Réponse : tableau de snapshots triés par date décroissante
//   [{ seasonLabel, monthName, capturedAt, totalArtworks, topArtworks, topPlayers,
//      canvasImageB64?, status }]
//
// Query params : ?includeCanvas=true pour inclure les images canvas (lourdes)
//               par défaut les images canvas sont exclues (trop volumineuses)
//
app.get('/api/portal/goldpixel/seasons', async (req, res) => {
  try {
    // ── Décider si les images canvas sont incluses ──
    const includeCanvas = req.query.includeCanvas === 'true'; // opt-in explicite

    // ── Construire la projection MongoDB ──
    const project = {
      seasonLabel:   1,                              // label "YYYY-MM"
      monthName:     1,                              // libellé "Mars 2026"
      capturedAt:    1,                              // date de capture
      totalArtworks: 1,                              // nombre d'œuvres
      topArtworks:   1,                              // top 10 œuvres
      topPlayers:    1,                              // top 10 joueurs
      status:        1,                              // état du snapshot
      resetAt:       1,                              // date du reset
    };

    // Inclure l'image canvas seulement si demandé explicitement
    if (includeCanvas) project.canvasImageB64 = 1;  // image lourde, opt-in uniquement

    // ── Récupérer les snapshots triés par date décroissante ──
    const seasons = await db.collection('season_snapshots')
      .find({})                                      // tous les snapshots
      .sort({ capturedAt: -1 })                      // plus récent en premier
      .project(project)                              // champs sélectionnés
      .toArray();

    res.json(seasons);                               // retourner au portail
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/portal/goldpixel/seasons/:label
// ─────────────────────────────────────────
// Détail d'une saison spécifique. Inclut l'image canvas.
// Utilisé quand le joueur clique sur un mois dans la Galerie des Saisons.
//
// Param : label = "YYYY-MM" (ex: "2026-03")
//
app.get('/api/portal/goldpixel/seasons/:label', async (req, res) => {
  try {
    const { label } = req.params;                    // ex: "2026-03"

    // ── Valider le format du label ──
    if (!/^\d{4}-\d{2}$/.test(label)) {
      return res.status(400).json({ error: 'Format invalide. Attendu: YYYY-MM' });
    }

    // ── Récupérer le snapshot complet (avec image canvas) ──
    const season = await db.collection('season_snapshots')
      .findOne({ seasonLabel: label });              // chercher par label

    if (!season) {
      return res.status(404).json({ error: `Saison ${label} non trouvée` });
    }

    res.json(season);                               // retourner le snapshot complet
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/portal/goldpixel/player/:name
// ────────────────────────────────────────
// Profil public d'un joueur avec ses œuvres.
// Utilisé par le portail pour la page de profil artiste.
//
app.get('/api/portal/goldpixel/player/:name', async (req, res) => {
  if (!artworks) return res.json({ arts: [], totalVotes: 0 });

  try {
    // ── Récupérer les œuvres du joueur ──
    const arts = await artworks
      .find({
        'author.name': req.params.name,              // filtre par pseudo
        status: 'approved',                          // seulement les approuvées
        archived: { $ne: true }                      // non archivées
      })
      .sort({ createdAt: -1 })                      // plus récente d'abord
      .toArray();                                    // convertir en tableau

    // ── Calculer les stats globales du joueur ──
    const totalVotes = arts.reduce(                  // sommer les votes de toutes ses œuvres
      (sum, a) => sum + (a.votes || 0), 0
    );

    res.json({ name: req.params.name, arts, totalVotes, artCount: arts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/season-snapshot/manual
// ────────────────────────────────────────
// Déclenchement manuel du snapshot par l'admin.
// Utile pour tester ou forcer une capture hors cycle cron.
//
app.post('/api/admin/season-snapshot/manual', async (req, res) => {
  // ── Vérifier les droits admin ──
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await takeSeasonSnapshot('admin_manual'); // label 'admin_manual'
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  FICHIERS STATIQUES (inchangés)
// ═══════════════════════════════════════════════════════════════
app.get('/validation-key.txt', (req, res) => {
  res.send(PI_API_KEY);
});

app.get('/health', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.status(200).send('OK');
});

app.get('/ping', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.status(200).json({ status: 'alive', ts: new Date().toISOString() });
});


/* ═══════════════════════════════════════════════════════════════
   Gold Pixel V1 — Routes API
   Collections MongoDB :
     pixelwar_grid    : { col, row, color, user, ts }
     pixelwar_players : { username, stock, rechargeTs, lastPixelTs }
   ─────────────────────────────────────────────────────────────
   Règles V1 :
     Stock de départ : 10 pixels
     Recharge        : 1 pixel toutes les 3 minutes (180s)
     Plafond stock   : 10 (20 avec achat boutique)
     Pas de cooldown global — c'est le stock qui limite
═══════════════════════════════════════════════════════════════ */

const PW_STOCK_DEFAULT = 15;    // réservoir de base
const PW_STOCK_CAP     = 60;    // plafond max (Ultra Tank)
const PW_RECHARGE_MS   = 10 * 1000; // 10 secondes (cooldown client)

/* ── Init indexes ── */
async function ensurePixelwarIndexes() {
  try {
    await db.collection('pixelwar_grid').createIndex({ col: 1, row: 1 }, { unique: true });
    await db.collection('pixelwar_grid').createIndex({ ts: -1 });
    await db.collection('pixelwar_players').createIndex({ username: 1 }, { unique: true });
    /* Initialiser le compteur en mémoire depuis MongoDB */
    _gpPixelCount = await db.collection('pixelwar_grid').countDocuments();
    console.log(`Gold Pixel : indexes OK — ${_gpPixelCount} pixels en base`);
  } catch (e) {
    console.error('Gold Pixel index error:', e.message);
  }
}

/* ── Helpers ── */
function pwNormalizeUser(username) {
  const u = String(username || 'anonyme').slice(0, 30).replace(/^@+/, '');
  return u;
}

/* Calculer le stock actuel d'un joueur (recharge + plafond tank) */
function pwCalcStock(player) {
  if (!player) return { stock: PW_STOCK_DEFAULT, rechargeLeft: PW_RECHARGE_MS / 1000, rechargeTs: Date.now() };
  const now = Date.now();

  /* ── Plafond actif selon le tank (vérifié côté serveur) ── */
  const PW_TANK_CAPS = {
    decouverte: { std: 25, gold: 7  },
    middle:     { std: 40, gold: 9  },
    giga:       { std: 55, gold: 12 },
    base:       { std: PW_STOCK_DEFAULT, gold: 5 },
  };
  const tankExpired = player.tankType && player.tankType !== 'base'
    && player.tankExpiry && now > player.tankExpiry;
  const activeTank  = (!tankExpired && player.tankType) ? player.tankType : 'base';
  const stockCap    = (PW_TANK_CAPS[activeTank] || PW_TANK_CAPS.base).std;

  let stock      = Math.min(player.stock ?? PW_STOCK_DEFAULT, stockCap);
  let rechargeTs = player.rechargeTs || now;

  /* Créditer les pixels rechargés depuis la dernière mise à jour */
  if (stock < stockCap) {
    const elapsed = now - rechargeTs;
    const gained  = Math.floor(elapsed / PW_RECHARGE_MS);
    if (gained > 0) {
      stock      = Math.min(stockCap, stock + gained);
      rechargeTs = rechargeTs + gained * PW_RECHARGE_MS;
    }
  }

  const rechargeLeft = stock >= stockCap
    ? 0
    : Math.max(0, Math.ceil((rechargeTs + PW_RECHARGE_MS - now) / 1000));

  return { stock, rechargeLeft, rechargeTs, stockCap, tankExpired };
}

/* ─────────────────────────────────────────────────────────────
   GET /api/pixelwar/grid[?since=ts]
   Retourne la grille (ou delta depuis since), ts, online
───────────────────────────────────────────────────────────── */
app.get('/api/pixelwar/grid', async (req, res) => {
  try {
    const since = parseInt(req.query.since) || 0;
    const query = since > 0 ? { ts: { $gt: since } } : {};
    const pixels = await db.collection('pixelwar_grid')
      .find(query, { projection: { _id:0, col:1, row:1, color:1, user:1, ts:1 } })
      .toArray();
    const fiveMin = Date.now() - 5 * 60 * 1000;
    const online = await db.collection('pixelwar_grid')
      .distinct('user', { ts: { $gt: fiveMin } });
    res.json({ ok: true, pixels, ts: Date.now(), online: online.length, canvasW: _gpCanvasW || 3000, canvasH: _gpCanvasH || 3000 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /api/pixelwar/place
   Body : { col, row, color, username }
   Vérifie le stock, décrémente, pose le pixel
───────────────────────────────────────────────────────────── */
app.post('/api/pixelwar/place', async (req, res) => {
  try {
    const { col, row, color, username } = req.body;
    if (typeof col !== 'number' || typeof row !== 'number')
      return res.status(400).json({ ok: false, error: 'col et row requis (number)' });
    if (col < 0 || col >= _gpCanvasW || row < 0 || row >= _gpCanvasH)
      return res.status(400).json({ ok: false, error: 'Coordonnées hors-limites' });
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color))
      return res.status(400).json({ ok: false, error: 'Couleur invalide' });

    const user = pwNormalizeUser(username);
    const now  = Date.now();

    /* Créer joueur si nécessaire */
    await db.collection('pixelwar_players').updateOne(
      { username: user },
      { $setOnInsert: { username: user, stock: PW_STOCK_DEFAULT, rechargeTs: now, lastPixelTs: 0, totalPlaced: 0, covered: 0 } },
      { upsert: true }
    );

    /* Recalculer le stock avec recharge écoulée */
    const player = await db.collection('pixelwar_players').findOne({ username: user });
    const { stock: currentStock, rechargeLeft, rechargeTs } = pwCalcStock(player);
    if (currentStock !== player.stock) {
      await db.collection('pixelwar_players').updateOne({ username: user }, { $set: { stock: currentStock, rechargeTs } });
    }
    if (currentStock <= 0) {
      return res.status(429).json({ ok: false, error: `Stock vide — +1 pixel dans ${rechargeLeft}s`, stock: 0, rechargeLeft });
    }

    /* Décrémentation atomique */
    const decResult = await db.collection('pixelwar_players').findOneAndUpdate(
      { username: user, stock: { $gt: 0 } },
      { $inc: { stock: -1, totalPlaced: 1 }, $set: { lastPixelTs: now } },
      { returnDocument: 'after' }
    );
    if (!decResult) {
      return res.status(429).json({ ok: false, error: 'Stock vide', stock: 0, rechargeLeft: 0 });
    }
    const newStock = decResult.stock;

    /* Pixel recouvert ? */
    const existing = await db.collection('pixelwar_grid').findOne({ col, row }, { projection: { user: 1 } });
    const coveredUser = (existing && existing.user && existing.user !== '@' + user) ? existing.user : null;
    if (coveredUser) {
      await db.collection('pixelwar_players').updateOne({ username: user }, { $inc: { covered: 1 } });
    }

    /* Poser le pixel */
    const isNewHTTP = !existing;
    await db.collection('pixelwar_grid').updateOne(
      { col, row },
      { $set: { col, row, color, user: '@' + user, ts: now } },
      { upsert: true }
    );
    if (isNewHTTP) _gpPixelCount++;

    const newRechargeTs   = newStock < PW_STOCK_DEFAULT ? (rechargeTs || now) : now;
    const newRechargeLeft = newStock >= PW_STOCK_DEFAULT
      ? 0 : Math.max(0, Math.ceil((newRechargeTs + PW_RECHARGE_MS - now) / 1000));

    res.json({ ok: true, col, row, color, ts: now, stock: newStock, rechargeLeft: newRechargeLeft });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/pixelwar/player?username=xxx
   Renvoie le stock et le temps avant recharge du joueur
───────────────────────────────────────────────────────────── */
app.get('/api/pixelwar/player', async (req, res) => {
  try {
    const user = pwNormalizeUser(req.query.username);
    let player = await db.collection('pixelwar_players').findOne({ username: user });
    if (!player) {
      /* Premier accès — créer le profil */
      const now = Date.now();
      player = { username: user, stock: PW_STOCK_DEFAULT, rechargeTs: now, lastPixelTs: 0 };
      await db.collection('pixelwar_players').insertOne(player);
    }
    const { stock, rechargeLeft } = pwCalcStock(player);
    res.json({ ok: true, username: user, stock, rechargeLeft });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/pixelwar/leaderboard
   Top 10 joueurs par pixels posés
───────────────────────────────────────────────────────────── */
app.get('/api/pixelwar/leaderboard', async (req, res) => {
  try {
    /* Pixels actuels sur la grille + données joueur (covered) */
    const gridRows = await db.collection('pixelwar_grid').aggregate([
      { $group: { _id: '$user', pixels: { $sum: 1 } } },
      { $sort:  { pixels: -1 } },
      { $limit: 10 },
      { $project: { _id:0, user:'$_id', pixels:1 } },
    ]).toArray();

    /* Enrichir avec le compteur covered depuis pixelwar_players */
    const enriched = await Promise.all(gridRows.map(async row => {
      const uname = (row.user || '').replace(/^@/, '');
      const player = await db.collection('pixelwar_players').findOne(
        { username: uname }, { projection: { covered:1 } }
      );
      return { ...row, covered: (player && player.covered) || 0 };
    }));

    res.json({ ok: true, leaderboard: enriched });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/pixelwar/leaderboard/countries
   Top 10 pays par pixels posés actuellement sur la grille
───────────────────────────────────────────────────────────── */
app.get('/api/pixelwar/leaderboard/countries', async (req, res) => {
  try {
    /* Joindre pixelwar_grid avec pixelwar_players pour connaître le pays */
    const rows = await db.collection('pixelwar_grid').aggregate([
      /* Récupérer le nom de joueur unique */
      { $group: { _id: '$user', pixels: { $sum: 1 } } },
      /* Lookup vers pixelwar_players */
      { $lookup: {
          from: 'pixelwar_players',
          let:  { uname: { $ltrim: { input: '$_id', chars: '@' } } },
          pipeline: [
            { $match: { $expr: { $eq: ['$username', '$$uname'] } } },
            { $project: { country: 1 } },
          ],
          as: 'pdata',
        }
      },
      { $set: { country: { $ifNull: [{ $arrayElemAt: ['$pdata.country', 0] }, 'XX'] } } },
      /* Grouper par pays */
      { $group: { _id: '$country', pixels: { $sum: '$pixels' } } },
      { $sort:  { pixels: -1 } },
      { $limit: 10 },
      { $project: { _id:0, country:'$_id', pixels:1 } },
    ]).toArray();
    res.json({ ok: true, leaderboard: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /api/pixelwar/shop/approve   (délégation Pi SDK)
   POST /api/pixelwar/shop/complete  (créditer stock après paiement)
───────────────────────────────────────────────────────────── */
app.post('/api/pixelwar/shop/approve', async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ ok: false, error: 'paymentId requis' });
    const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' },
    });
    const data = await r.json();
    res.json({ ok: r.ok, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/pixelwar/shop/complete', async (req, res) => {
  try {
    const { paymentId, txid, type, username } = req.body;
    if (!paymentId || !txid) return res.status(400).json({ ok: false, error: 'paymentId et txid requis' });

    /* Finaliser côté Pi */
    const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid }),
    });
    if (!r.ok) return res.status(400).json({ ok: false, error: 'Echec finalisation Pi' });

    /* Table des packs — source de vérité côté serveur */
    const PW_PACKS = {
      decouverte: { std: 25, gold: 7  },
      middle:     { std: 40, gold: 9  },
      giga:       { std: 55, gold: 12 },
    };
    const user = pwNormalizeUser(username);
    const now  = Date.now();

    if (PW_PACKS[type]) {
      /* Pack réservoir : créditer std + gold + stocker tank en base */
      const pack   = PW_PACKS[type];
      const player = await db.collection('pixelwar_players').findOne({ username: user });
      const { stock: curStock } = player ? pwCalcStock(player) : { stock: PW_STOCK_DEFAULT };
      const newStock    = Math.min(PW_STOCK_CAP, curStock + pack.std);
      const tankExpiry  = now + 7 * 24 * 60 * 60 * 1000; // 7 jours depuis maintenant
      await db.collection('pixelwar_players').updateOne(
        { username: user },
        { $set: { stock: newStock, goldStock: pack.gold, rechargeTs: now,
                  tankType: type, tankExpiry } },
        { upsert: true }
      );
      return res.json({ ok: true, stock: newStock, goldStock: pack.gold, tankType: type, tankExpiry });
    }

    /* Don : pas de crédit pixels */
    res.json({ ok: true, stock: null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /api/pixelwar/player/country
   Body : { username, country }
   Enregistre le pays du joueur (1 seule fois, modifiable)
───────────────────────────────────────────────────────────── */
app.post('/api/pixelwar/player/country', async (req, res) => {
  try {
    const { username, country } = req.body;
    if (!username || !country) return res.status(400).json({ ok:false, error:'username et country requis' });
    const validCodes = [
      'FR','US','GB','DE','ES','IT','BR','CN','JP','KR','IN','NG','GH',
      'KE','PH','VN','ID','TR','MX','MA','DZ','SN','CI','CM','TN','PL',
      'PT','AR','CO','ZA',
    ];
    if (!validCodes.includes(country)) return res.status(400).json({ ok:false, error:'Code pays invalide' });
    const user = pwNormalizeUser(username);
    await db.collection('pixelwar_players').updateOne(
      { username: user },
      { $set: { country } },
      { upsert: true }
    );
    res.json({ ok: true, country });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ROUTES JEUX — assets statiques + HTML entry point
//  app.use sert les assets du dossier (CSS, JS, images, sons…)
//  app.get sert le fichier HTML principal sur la route exacte
//  Les deux coexistent sans conflit : app.use intercepte les
//  sous-chemins (/2048/style.css), app.get intercepte la route
//  racine exacte (/2048).
// ══════════════════════════════════════════════════════════════════

// Gold Pixel — Games/Goldpixel/
app.use('/goldpixel', express.static(path.join(__dirname, 'Games', 'Goldpixel')));

app.get('/goldpixel', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games', 'Goldpixel', 'goldpixel.html'));
});

// Breaker — Games/Breakout/
app.use('/breakout', express.static(path.join(__dirname, 'Games', 'Breakout')));
app.get('/breakout', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games', 'Breakout', 'index.html'), (err) => {
    if (err) res.status(404).send('File not found: Games/Breakout/index.html');
  });
});

// Stacker — Games/Stacker/
app.use('/stacker', express.static(path.join(__dirname, 'Games', 'Stacker')));
app.get('/stacker', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games', 'Stacker', 'index.html'), (err) => {
    if (err) res.status(404).send('File not found: Games/Stacker/index.html');
  });
});

// 2048 — Games/2048/
app.use('/2048', express.static(path.join(__dirname, 'Games', '2048')));
app.get('/2048', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games', '2048', 'index.html'), (err) => {
    if (err) res.status(404).send('File not found: Games/2048/index.html');
  });
});

// ── PI PIXEL WAR ─────────────────────────────────────────────────────────────
// /pixelwar → redirige vers /goldpixel (renommage du projet)
app.get('/pixelwar', (req, res) => res.redirect(301, '/goldpixel'));

// Route racine — portail (index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) res.status(404).send('File not found: index.html');
  });
});

// Assets statiques (images, CSS, JS…) servis depuis la racine
app.use(express.static(path.join(__dirname)));

// ══════════════════════════════════════════════════════════════
//  SOCKET.IO — GOLD PIXEL CANVAS TEMPS RÉEL
// ══════════════════════════════════════════════════════════════

/* Dimensions courantes du canvas — déclarées en haut du fichier */
const EXPAND_THRESHOLD = 0.01;  // 1% de 9M = 90k pixels → atteignable en production
const EXPAND_FACTOR    = 1.5;   // +50% surface → dim × √1.5 ≈ ×1.22

/* Cooldown d'expansion */
let _gpLastExpand  = 0;
const EXPAND_COOLDOWN_MS = 60000; // 60s entre deux expansions

/* Compteur en mémoire — évite countDocuments() à chaque pixel */
let _gpPixelCount  = 0;  // initialisé au démarrage dans ensurePixelwarIndexes

io.on('connection', (socket) => {
  console.log(`[GP Socket] Client connecté : ${socket.id}`);

  /* ── Envoi de l'état initial au nouveau client ── */
  (async () => {
    try {
      const pixels = await db.collection('pixelwar_grid')
        .find({}, { projection: { _id:0, col:1, row:1, color:1, user:1, ts:1 } })
        .toArray();
      socket.emit('canvas:state', {
        pixels,
        canvasW: _gpCanvasW,
        canvasH: _gpCanvasH,
        ts: Date.now(),
      });
    } catch (e) {
      console.error('[GP Socket] canvas:state error:', e.message);
    }
  })();

  /* ── Pose d'un pixel ── */
  socket.on('pixel:place', async ({ col, row, color, username, ts }) => {
    try {
      // Validation
      if (typeof col !== 'number' || typeof row !== 'number') return;
      if (col < 0 || col >= _gpCanvasW || row < 0 || row >= _gpCanvasH) {
        socket.emit('pixel:ack', { col, row, ok: false, error: 'Hors limites' });
        return;
      }
      if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
        socket.emit('pixel:ack', { col, row, ok: false, error: 'Couleur invalide' });
        return;
      }

      const user = pwNormalizeUser(username);
      const now  = Date.now();

      /* ── Rate limiting par socket : 1 pixel / 500ms max ── */
      if (!socket._gpLastPixel) socket._gpLastPixel = 0;
      if (now - socket._gpLastPixel < 500) {
        socket.emit('pixel:ack', { col, row, ok: false, error: 'Trop rapide — attends un peu' });
        return;
      }
      socket._gpLastPixel = now;

      /* ── Décrémenter le stock de façon ATOMIQUE (anti-race condition) ── */
      /* Créer d'abord le joueur s'il n'existe pas */
      await db.collection('pixelwar_players').updateOne(
        { username: user },
        { $setOnInsert: { username: user, stock: PW_STOCK_DEFAULT, rechargeTs: now, lastPixelTs: 0, totalPlaced: 0, covered: 0 } },
        { upsert: true }
      );

      /* Recalculer le stock reçu (recharge écoulée depuis dernière màj) */
      const playerNow = await db.collection('pixelwar_players').findOne({ username: user });
      const { stock: currentStock, rechargeLeft, rechargeTs } = pwCalcStock(playerNow);

      /* Si la recharge a crédité des pixels, les appliquer d'abord en base */
      if (currentStock !== playerNow.stock) {
        await db.collection('pixelwar_players').updateOne(
          { username: user },
          { $set: { stock: currentStock, rechargeTs } }
        );
      }

      if (currentStock <= 0) {
        socket.emit('pixel:ack', { col, row, ok: false, error: `Stock vide — +1 dans ${rechargeLeft}s`, stock: 0 });
        return;
      }

      /* Décrémentation atomique avec condition (stock > 0) */
      const decResult = await db.collection('pixelwar_players').findOneAndUpdate(
        { username: user, stock: { $gt: 0 } },
        { $inc: { stock: -1, totalPlaced: 1 }, $set: { lastPixelTs: now } },
        { returnDocument: 'after' }
      );
      if (!decResult) {
        socket.emit('pixel:ack', { col, row, ok: false, error: 'Stock vide', stock: 0 });
        return;
      }
      const newStock = decResult.stock;

      /* Pixel recouvert ? */
      const existing = await db.collection('pixelwar_grid').findOne({ col, row }, { projection: { user:1 } });
      const coveredUser = (existing && existing.user && existing.user !== '@' + user) ? existing.user : null;
      if (coveredUser) {
        await db.collection('pixelwar_players').updateOne({ username: user }, { $inc: { covered: 1 } });
      }

      /* Poser le pixel */
      const isNew = !existing;
      await db.collection('pixelwar_grid').updateOne(
        { col, row },
        { $set: { col, row, color, user: '@' + user, ts: now } },
        { upsert: true }
      );
      if (isNew) _gpPixelCount++;

      /* Calculer rechargeLeft pour l'ACK */
      const newRechargeTs   = newStock < PW_STOCK_DEFAULT ? (rechargeTs || now) : now;
      const newRechargeLeft = newStock >= PW_STOCK_DEFAULT
        ? 0
        : Math.max(0, Math.ceil((newRechargeTs + PW_RECHARGE_MS - now) / 1000));

      /* ACK au poseur */
      socket.emit('pixel:ack', { col, row, ok: true, stock: newStock, rechargeLeft: newRechargeLeft });

      /* Broadcast à TOUS les autres clients */
      socket.broadcast.emit('pixel:update', { col, row, color, user: '@' + user, ts: now });

      /* ── Expansion : compteur mémoire, pas de countDocuments ── */
      const ratio      = _gpPixelCount / (_gpCanvasW * _gpCanvasH);
      const cooldownOk = Date.now() - _gpLastExpand > EXPAND_COOLDOWN_MS;

      if (ratio >= EXPAND_THRESHOLD && cooldownOk) {
        _gpLastExpand = Date.now();
        const factor  = Math.sqrt(EXPAND_FACTOR);
        const newW    = Math.round(_gpCanvasW * factor);
        const newH    = Math.round(_gpCanvasH * factor);
        _gpCanvasW    = newW;
        _gpCanvasH    = newH;
        io.emit('canvas:expanded', { newW, newH, ts: Date.now() });
        console.log(`[GP] Canvas étendu : ${newW}×${newH} (${_gpPixelCount} pixels)`);
      }

    } catch (e) {
      console.error('[GP Socket] pixel:place error:', e.message);
      socket.emit('pixel:ack', { col, row, ok: false, error: 'Erreur serveur' });
    }
  });

  /* ── Demande d'expansion manuelle (depuis client) ── */
  socket.on('canvas:expand', async ({ currentW, currentH }) => {
    // Le serveur recalcule lui-même — ignorer la demande si déjà géré côté serveur
    // (sécurité : l'expansion est décidée par le serveur, pas le client)
    console.log(`[GP Socket] canvas:expand demandé par ${socket.id} (ignoré — côté serveur)`);
  });

  socket.on('disconnect', () => {
    console.log(`[GP Socket] Client déconnecté : ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 JEUXVIDEO.PI v3.6 + Socket.io actif sur le port ${PORT}`);
});
