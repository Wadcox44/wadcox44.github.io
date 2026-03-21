// ═══════════════════════════════════════════════════════════════
//  JEUXVIDEO.PI — Server v3.1
//  Hébergement : Render  |  DB : MongoDB Atlas
//  Architecture : portail Pi Network + 6 systèmes configurables + Shop Gold Credits
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
const path     = require('path');
const cors     = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { v4: uuid } = require('uuid');

const app  = express();
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
  const { paymentId, txid, artId, type } = req.body;
  try {
    await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, { method: 'POST', headers: { Authorization: `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ txid }) });
    if (type === 'feature_24h' && artId) await artworks.updateOne({ id: artId }, { $set: { featured: true, featuredUntil: new Date(Date.now() + 86400000) } });
    if (type === 'gold_pixels' && artId) await artworks.updateOne({ id: artId }, { $set: { goldPixels: true } });
    if (type === 'extra_slots') {
      const slotUsername = req.body.username || req.body.piUsername;
      if (slotUsername) { const today = new Date(); today.setHours(0,0,0,0); await users.updateOne({ piUsername: slotUsername }, { $set: { extraSlots: true, extraSlotsDate: today } }, { upsert: false }); }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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


// ═══════════════════════════════════════════════════════════════
//  FICHIERS STATIQUES (inchangés)
// ═══════════════════════════════════════════════════════════════
app.get('/validation-key.txt', (req, res) => res.send(PI_API_KEY));
app.get('/health', (req, res) => { res.header('Access-Control-Allow-Origin', '*'); res.status(200).send('OK'); });
app.get('/ping',   (req, res) => { res.header('Access-Control-Allow-Origin', '*'); res.status(200).json({ status: 'alive', ts: new Date().toISOString() }); });

app.use('/goldpixel', express.static(path.join(__dirname, 'Games', 'Goldpixel')));
app.get('/goldpixel', (req, res) => res.sendFile(path.join(__dirname, 'Games', 'Goldpixel', 'goldpixel.html'), err => { if (err) res.status(404).send('goldpixel.html introuvable'); }));

app.use('/breakout', express.static(path.join(__dirname, 'Games', 'Breakout')));
app.get('/breakout', (req, res) => res.sendFile(path.join(__dirname, 'Games', 'Breakout', 'breakout.html'), err => { if (err) res.status(404).send('breakout.html introuvable'); }));

app.use('/stacker', express.static(path.join(__dirname, 'Games', 'Stacker')));
app.get('/stacker', (req, res) => res.sendFile(path.join(__dirname, 'Games', 'Stacker', 'index.html'), err => { if (err) res.status(404).send('index.html introuvable'); }));

app.use('/2048', express.static(path.join(__dirname, 'Games', '2048')));
app.get('/2048', (req, res) => res.sendFile(path.join(__dirname, 'Games', '2048', 'index.html'), err => { if (err) res.status(404).send('index.html introuvable'); }));

app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => console.log(`🚀 JEUXVIDEO.PI v3.1 actif sur le port ${PORT}`));
