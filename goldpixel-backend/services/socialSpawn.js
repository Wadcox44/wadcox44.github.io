// ═══════════════════════════════════════════════════════════════
//  SERVICE — Social Spawn
//
//  Calculates a recommended landing point for new players so
//  they arrive near an active zone rather than the empty corner.
//
//  Strategy resolution order:
//    1. If disabled → canvas centre.
//    2. If not enough artworks → centre (fallback).
//    3. 'most-active'  → most-recently-published artwork zone.
//    4. 'random-active'→ random pick among top 5 recent zones.
//    5. 'center'       → explicit centre fallback.
//
//  spawnHint is an optional field on artwork documents:
//    { spawnHint: { col: number, row: number } }
//  If an artwork has no spawnHint, we approximate it as the
//  canvas centre until per-pixel storage is available.
//
//  Future enhancement:
//    When pixel_grid is in MongoDB, replace the artwork-lookup
//    heuristic with a real density aggregation over recent cells.
// ═══════════════════════════════════════════════════════════════

'use strict';

const _cfgModule = require('../config/gameConfig');
const getConfig = () => _cfgModule.GAME_CONFIG;
const WorldExpansion    = require('./worldExpansion');

let _artworks = null;
function injectDb(db) { _artworks = db.collection('artworks'); }

// ─────────────────────────────────────────────────────────────
//  getSpawnPoint()
//
//  Returns:
//    { col, row, strategy, jittered }
//
//  jittered: true if a random offset was applied within
//            config.radiusCells to spread players around the zone.
// ─────────────────────────────────────────────────────────────
async function getSpawnPoint() {
  const cfg    = getConfig().social_spawn;
  const dims   = await WorldExpansion.getCurrentDimensions();
  const centre = {
    col:      Math.floor(dims.cols / 2),
    row:      Math.floor(dims.rows / 2),
    strategy: 'center',
    jittered: false,
  };

  if (!cfg.enabled || cfg.strategy === 'center') return centre;

  try {
    const since = new Date(Date.now() - cfg.lookbackMs);

    /* Pull recent artworks that carry a spawnHint */
    const candidates = await _artworks
      .find({
        status:    'approved',
        archived:  { $ne: true },
        createdAt: { $gte: since },
        'spawnHint.col': { $exists: true },
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .project({ 'spawnHint.col': 1, 'spawnHint.row': 1 })
      .toArray();

    if (candidates.length < cfg.minActiveArtworks) {
      /* Not enough activity data yet */
      return cfg.fallbackToCenter ? centre : centre;
    }

    let pick;
    if (cfg.strategy === 'random-active') {
      const pool = candidates.slice(0, Math.min(5, candidates.length));
      pick = pool[Math.floor(Math.random() * pool.length)];
    } else {
      /* most-active: first = most recent */
      pick = candidates[0];
    }

    const baseCol = pick.spawnHint.col;
    const baseRow = pick.spawnHint.row;

    /* Apply jitter so players don't all land on the exact same pixel */
    const r = cfg.radiusCells;
    const jitteredCol = Math.max(0, Math.min(dims.cols - 1,
      baseCol + Math.floor((Math.random() * 2 - 1) * r)));
    const jitteredRow = Math.max(0, Math.min(dims.rows - 1,
      baseRow + Math.floor((Math.random() * 2 - 1) * r)));

    return {
      col:      jitteredCol,
      row:      jitteredRow,
      strategy: cfg.strategy,
      jittered: true,
    };

  } catch (err) {
    console.warn('[SocialSpawn] fallback triggered:', err.message);
    return centre;
  }
}

module.exports = { injectDb, getSpawnPoint };
