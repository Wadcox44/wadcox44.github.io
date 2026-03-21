// ═══════════════════════════════════════════════════════════════
//  ROUTES — Gold Pixel systems
//
//  Mount in server.js with:
//    const gpRoutes = require('./routes/goldpixel');
//    gpRoutes.inject(db, withPiUser);
//    app.use('/api/goldpixel', gpRoutes.router);
//    app.use('/api/admin',     gpRoutes.adminRouter);
//
//  All existing routes (/api/gallery, /api/game/goldpixel/*, etc.)
//  are untouched in server.js.
// ═══════════════════════════════════════════════════════════════

'use strict';

const express        = require('express');
const { GAME_CONFIG } = require('../config/gameConfig');
const goldPixelGuard  = require('../middleware/goldPixelGuard');
const TerrainFatigue  = require('../services/terrainFatigue');
const WorldExpansion  = require('../services/worldExpansion');
const SocialSpawn     = require('../services/socialSpawn');
const FirstPixelProt  = require('../services/firstPixelProt');
const SeasonLogo      = require('../services/seasonLogo');
const SeasonReset     = require('../services/seasonReset');

const router      = express.Router();
const adminRouter = express.Router();

/* Injected after connectDB() */
let _withPiUser;
function inject(db, withPiUser) {
  _withPiUser = withPiUser;
  TerrainFatigue.injectDb(db);
  WorldExpansion.injectDb(db);
  SocialSpawn.injectDb(db);
  FirstPixelProt.injectDb(db);
  SeasonLogo.injectDb(db);
  SeasonReset.injectDb(db);
}


// ═══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════

// ── GET /api/goldpixel/config ──────────────────────────────────
// Exposes the non-secret config flags to the front-end so it
// can adapt its UI without a separate deployment.
router.get('/config', (req, res) => {
  const pub = {};
  for (const [key, cfg] of Object.entries(GAME_CONFIG)) {
    pub[key] = { enabled: cfg.enabled };
    // Append client-relevant non-secret params per system
    if (key === 'world_expansion') {
      pub[key].initial = { cols: cfg.initialCols, rows: cfg.initialRows };
      pub[key].max     = { cols: cfg.maxCols,     rows: cfg.maxRows };
    }
    if (key === 'first_pixel_prot') pub[key].durationMs = cfg.durationMs;
    if (key === 'season_logo')      pub[key].seasonLabel = cfg.seasonLabel;
    if (key === 'terrain_fatigue')  pub[key].maxRepaints = cfg.maxRepaints;
    if (key === 'social_spawn')     pub[key].strategy    = cfg.strategy;
  }
  res.json(pub);
});

// ── GET /api/goldpixel/world ───────────────────────────────────
// Current canvas dimensions + recommended spawn point.
// The front-end calls this on load to know the canvas size
// (relevant when world_expansion is enabled).
router.get('/world', async (req, res) => {
  try {
    const [dims, spawn] = await Promise.all([
      WorldExpansion.getCurrentDimensions(),
      SocialSpawn.getSpawnPoint(),
    ]);
    res.json({ dimensions: dims, spawn });
  } catch (e) {
    console.error('[/world]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/goldpixel/season ──────────────────────────────────
// Season logo + reset status for the HUD.
router.get('/season', async (req, res) => {
  try {
    const [logo, reset] = await Promise.all([
      SeasonLogo.getStatus(),
      SeasonReset.getStatus(),
    ]);
    res.json({ logo, reset, seasonLabel: GAME_CONFIG.season_logo.seasonLabel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/goldpixel/fatigue ─────────────────────────────────
// Heatmap of fatigued cells — used by the front-end overlay.
// Returns { enabled, cells: [{ cellKey, repaints, fatigued }] }
router.get('/fatigue', async (req, res) => {
  try {
    const topN = Math.min(200, parseInt(req.query.topN) || 50);
    res.json(await TerrainFatigue.heatmap(topN));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/goldpixel/protection/:username ────────────────────
// Check if a player is under first-pixel protection.
router.get('/protection/:username', async (req, res) => {
  try {
    res.json(await FirstPixelProt.getStatus(req.params.username));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/goldpixel/first-pixel ───────────────────────────
// Client calls this on the player's very first pixel placement.
// Activates the 10-minute protection window.
router.post('/first-pixel', async (req, res) => {
  const auth = req.headers.authorization || '';
  const username = req.body.piUsername;   // sent by client
  if (!username) return res.status(400).json({ error: 'piUsername required' });

  try {
    res.json(await FirstPixelProt.activate(username));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/goldpixel/place-pixel ───────────────────────────
// Canonical pixel write endpoint.
// Guarded by goldPixelGuard middleware (all 4 system checks).
// Body: { col, row, color, piUsername? }
//
// NOTE: This is a stub handler. Until pixel_grid is stored in
// MongoDB the actual canvas state lives in the browser's
// localStorage. When server-side pixel storage is ready,
// uncomment the DB write below.
router.post('/place-pixel', goldPixelGuard, async (req, res) => {
  const { col, row, color, piUsername } = req.body;
  const username = piUsername || 'anonymous';

  /* ── Record repaint for fatigue tracking ── */
  await TerrainFatigue.record(username, col, row);

  /* ── Increment first-pixel protection cell counter ── */
  if (username !== 'anonymous') {
    await FirstPixelProt.incrementCellCount(username);
  }

  /*
   * ── Future: store pixel in DB ──
   * await db.collection('pixel_grid').updateOne(
   *   { cellKey: `${col},${row}` },
   *   { $set: { color, piUsername: username, updatedAt: new Date() } },
   *   { upsert: true }
   * );
   */

  res.json({ ok: true, col, row, color });
});


// ═══════════════════════════════════════════════════════════════
//  ADMIN ROUTES  —  require header: x-admin-secret: <secret>
// ═══════════════════════════════════════════════════════════════

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme';

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ── POST /api/admin/season-logo/activate ──────────────────────
adminRouter.post('/season-logo/activate', requireAdmin, async (req, res) => {
  try {
    const result = await SeasonLogo.activate(
      req.body.seasonLabel,
      req.body.adminUsername
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/season-logo/deactivate ────────────────────
adminRouter.post('/season-logo/deactivate', requireAdmin, async (req, res) => {
  try {
    res.json(await SeasonLogo.deactivate());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/season-reset/run ──────────────────────────
// Body: { dryRun?: boolean, label?: string }
adminRouter.post('/season-reset/run', requireAdmin, async (req, res) => {
  try {
    const result = await SeasonReset.run({
      dryRun: !!req.body.dryRun,
      label:  req.body.label,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/config/update ─────────────────────────────
// Hot-update a single config key at runtime (in-memory only,
// resets on server restart — use env vars for persistence).
// Body: { system: 'terrain_fatigue', key: 'enabled', value: true }
adminRouter.post('/config/update', requireAdmin, (req, res) => {
  const { system, key, value } = req.body;

  /* Unfreeze: we need to mutate the frozen config via a workaround */
  const rawCfg = require('../config/gameConfig').GAME_CONFIG;
  if (!rawCfg[system] || !(key in rawCfg[system])) {
    return res.status(400).json({ error: 'Unknown system or key' });
  }

  /* Note: Object.freeze prevents direct mutation.
     For hot-reload, recreate the inner object (not production-safe
     for multi-instance deployments — use a DB flag there). */
  const oldValue = rawCfg[system][key];
  const mutable  = Object.assign({}, rawCfg[system], { [key]: value });
  Object.defineProperty(rawCfg, system, {
    value: Object.freeze(mutable),
    writable: false, configurable: true,
  });

  console.log(`[Config] ${system}.${key}: ${oldValue} → ${value}`);
  res.json({ ok: true, system, key, oldValue, newValue: value });
});

// ── GET /api/admin/status ──────────────────────────────────────
// Quick overview of all system states.
adminRouter.get('/status', requireAdmin, async (req, res) => {
  try {
    const [logo, reset, dims, fatigue] = await Promise.all([
      SeasonLogo.getStatus(),
      SeasonReset.getStatus(),
      WorldExpansion.getCurrentDimensions(),
      TerrainFatigue.heatmap(10),
    ]);
    res.json({
      config:    GAME_CONFIG,
      season:    { logo, reset },
      world:     dims,
      fatigue:   fatigue,
      ts:        new Date(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


module.exports = { router, adminRouter, inject };
