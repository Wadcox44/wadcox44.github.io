// ═══════════════════════════════════════════════════════════════
//  SERVICE — World Expansion
//
//  The canvas starts at initialCols × initialRows and grows
//  every time the approved artwork count crosses a multiple of
//  artworksPerExpansion.  The calculation is deterministic and
//  stateless — no extra DB writes needed.
//
//  Future enhancement:
//    Store the "expansion epoch" in season_state so the front-end
//    can subscribe to growth events without polling.
// ═══════════════════════════════════════════════════════════════

'use strict';

const _cfgModule = require('../config/gameConfig');
// Dynamic accessor — always reads the live (possibly patched) config object.
const getConfig = () => _cfgModule.GAME_CONFIG;

let _artworks = null;
function injectDb(db) { _artworks = db.collection('artworks'); }

// ─────────────────────────────────────────────────────────────
//  getCurrentDimensions()
//
//  Returns the live canvas size based on approved artwork count.
//  If disabled: always returns the initialCols × initialRows.
// ─────────────────────────────────────────────────────────────
async function getCurrentDimensions() {
  const cfg = getConfig().world_expansion;
  const base = { cols: cfg.initialCols, rows: cfg.initialRows };

  if (!cfg.enabled) {
    return { ...base, expansions: 0, approvedCount: null, expanded: false };
  }

  const approvedCount = await _artworks.countDocuments({
    status: 'approved', archived: { $ne: true },
  });

  const expansions = Math.floor(approvedCount / cfg.artworksPerExpansion);
  const step       = cfg.expansionStep;

  let cols = cfg.initialCols;
  let rows = cfg.initialRows;

  if (cfg.expansionAxis === 'both' || cfg.expansionAxis === 'cols') {
    cols = Math.min(cfg.maxCols, cfg.initialCols + expansions * step);
  }
  if (cfg.expansionAxis === 'both' || cfg.expansionAxis === 'rows') {
    rows = Math.min(cfg.maxRows, cfg.initialRows + expansions * step);
  }

  const atMax = cols >= cfg.maxCols && rows >= cfg.maxRows;

  return {
    cols,
    rows,
    expansions,
    approvedCount,
    expanded: expansions > 0,
    atMax,
    nextExpansionAt: atMax
      ? null
      : (expansions + 1) * cfg.artworksPerExpansion,
    progressToNext: atMax
      ? 1
      : (approvedCount % cfg.artworksPerExpansion) / cfg.artworksPerExpansion,
  };
}

// ─────────────────────────────────────────────────────────────
//  isInBounds(col, row)
//
//  Validates a cell coordinate against the current world size.
//  Used by goldPixelGuard middleware.
// ─────────────────────────────────────────────────────────────
async function isInBounds(col, row) {
  const { cols, rows } = await getCurrentDimensions();
  return col >= 0 && col < cols && row >= 0 && row < rows;
}

module.exports = { injectDb, getCurrentDimensions, isInBounds };
