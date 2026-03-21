// ═══════════════════════════════════════════════════════════════
//  SERVICE — Terrain Fatigue
//
//  Prevents pixel-war loops by tracking how often each cell (or
//  zone) has been repainted within a rolling time window.
//  When the repaint count exceeds config.maxRepaints the cell
//  enters cooldown and further overwrites are blocked.
//
//  MongoDB collection: cell_repaints
//  Document shape:
//    { cellKey: "col,row", piUsername: string, ts: Date }
//
//  Index required (created in connectDB):
//    db.cell_repaints.createIndex({ cellKey: 1, ts: -1 })
//    db.cell_repaints.createIndex({ ts: 1 }, { expireAfterSeconds: 7200 })
//    → TTL index auto-cleans entries older than 2 hours.
// ═══════════════════════════════════════════════════════════════

'use strict';

const _cfgModule = require('../config/gameConfig');
// Dynamic accessor — always reads the live (possibly patched) config object.
const getConfig = () => _cfgModule.GAME_CONFIG;

/* ── Mutable reference to the DB (injected after connectDB) ── */
let _db = null;
function injectDb(db) { _db = db; }

/* ── Collection accessor ── */
const col = () => _db.collection('cell_repaints');

// ─────────────────────────────────────────────────────────────
//  check(piUsername, col, row)
//
//  Returns:
//    { allowed: true }
//    { allowed: false, reason: 'CELL_FATIGUED', repaints, cooldownUntil }
//
//  Guard pattern: if disabled, always allow.
// ─────────────────────────────────────────────────────────────
async function check(piUsername, cellCol, cellRow) {
  const cfg = getConfig().terrain_fatigue;
  if (!cfg.enabled) return { allowed: true };

  const cellKey     = _cellKey(cfg, cellCol, cellRow);
  const windowStart = new Date(Date.now() - cfg.windowMs);

  /* Count how many repaints happened on this cell in the window */
  const filter = { cellKey, ts: { $gte: windowStart } };
  if (!cfg.trackAllUsers) filter.piUsername = piUsername;

  const repaints = await col().countDocuments(filter);

  if (repaints >= cfg.maxRepaints) {
    /* Find the oldest repaint in the window to calculate cooldown */
    const oldest = await col()
      .find(filter)
      .sort({ ts: 1 })
      .limit(1)
      .toArray();

    const oldestTs       = oldest[0]?.ts ?? new Date();
    const windowExpiresAt = new Date(oldestTs.getTime() + cfg.windowMs);
    const cooldownUntil  = new Date(
      windowExpiresAt.getTime() + cfg.cooldownMs
    );

    return {
      allowed:      false,
      reason:       'CELL_FATIGUED',
      repaints,
      maxRepaints:  cfg.maxRepaints,
      cooldownUntil,
      msLeft:       Math.max(0, cooldownUntil - Date.now()),
    };
  }

  return { allowed: true, repaints };
}

// ─────────────────────────────────────────────────────────────
//  record(piUsername, col, row)
//
//  Persists a repaint event. Call AFTER the pixel is written
//  and check() returned allowed: true.
// ─────────────────────────────────────────────────────────────
async function record(piUsername, cellCol, cellRow) {
  const cfg = getConfig().terrain_fatigue;
  if (!cfg.enabled) return;

  await col().insertOne({
    cellKey:     _cellKey(cfg, cellCol, cellRow),
    piUsername,
    ts: new Date(),
  });
  /* TTL index handles cleanup — no manual deleteMany needed */
}

// ─────────────────────────────────────────────────────────────
//  heatmap(topN)
//
//  Returns the N most-repainted cells in the current window.
//  Used by GET /api/goldpixel/fatigue for front-end heatmap.
// ─────────────────────────────────────────────────────────────
async function heatmap(topN = 50) {
  const cfg = getConfig().terrain_fatigue;
  if (!cfg.enabled) return { enabled: false, cells: [] };

  const windowStart = new Date(Date.now() - cfg.windowMs);

  const cells = await col().aggregate([
    { $match: { ts: { $gte: windowStart } } },
    { $group: { _id: '$cellKey', repaints: { $sum: 1 } } },
    { $sort:  { repaints: -1 } },
    { $limit: topN },
    { $project: {
        _id: 0,
        cellKey:  '$_id',
        repaints: 1,
        fatigued: { $gte: ['$repaints', cfg.maxRepaints] },
    }},
  ]).toArray();

  return { enabled: true, threshold: cfg.maxRepaints, cells };
}

// ─────────────────────────────────────────────────────────────
//  _cellKey(cfg, col, row) — internal
//
//  If scope='zone', collapses the coordinate to its block
//  centre so the whole NxN block shares one fatigue counter.
//  If scope='cell', uses the raw coordinate.
// ─────────────────────────────────────────────────────────────
function _cellKey(cfg, cellCol, cellRow) {
  if (cfg.scope === 'zone') {
    const sz = cfg.zoneSize || 5;
    return `zone:${Math.floor(cellCol / sz)},${Math.floor(cellRow / sz)}`;
  }
  return `${cellCol},${cellRow}`;
}

module.exports = { injectDb, check, record, heatmap };
