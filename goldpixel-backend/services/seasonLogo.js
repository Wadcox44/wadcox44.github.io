// ═══════════════════════════════════════════════════════════════
//  SERVICE — Season Logo
//
//  A branded logo is placed at the centre of the canvas at the
//  start of each season.  Its bounding box is read-only for
//  config.durationMs (default 48h).  After expiry the cells
//  become regular paintable space.
//
//  MongoDB collection: season_state
//  Document shape (one document per season):
//    {
//      seasonLabel  : string,   — e.g. '2026-S1'
//      logoActive   : boolean,
//      logoExpiresAt: Date,
//      logoZone     : { col, row, width, height },
//      activatedAt  : Date,
//      activatedBy  : string,   — admin username
//    }
//
//  Workflow:
//    1. Admin calls POST /api/admin/season-logo/activate
//    2. Service writes a season_state document
//    3. goldPixelGuard calls isProtectedCell() on every write
//    4. After 48h the check returns false automatically
// ═══════════════════════════════════════════════════════════════

'use strict';

const _cfgModule = require('../config/gameConfig');
// Dynamic accessor — always reads the live (possibly patched) config object.
const getConfig = () => _cfgModule.GAME_CONFIG;

let _db = null;
function injectDb(db) { _db = db; }

const col = () => _db.collection('season_state');

// ─────────────────────────────────────────────────────────────
//  activate(seasonLabel, adminUsername)
//
//  Creates / updates the season_state doc and starts the clock.
//  Idempotent: calling again for the same season resets the timer.
// ─────────────────────────────────────────────────────────────
async function activate(seasonLabel, adminUsername = 'admin') {
  const cfg   = getConfig().season_logo;
  if (!cfg.enabled) return { ok: false, reason: 'DISABLED' };

  const label      = seasonLabel || cfg.seasonLabel;
  const expiresAt  = new Date(Date.now() + cfg.durationMs);
  const logoZone   = {
    col:    cfg.centerCol,
    row:    cfg.centerRow,
    width:  cfg.logoWidth,
    height: cfg.logoHeight,
  };

  await col().updateOne(
    { seasonLabel: label },
    {
      $set: {
        seasonLabel:   label,
        logoActive:    true,
        logoExpiresAt: expiresAt,
        logoZone,
        activatedAt:   new Date(),
        activatedBy:   adminUsername,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  console.log(`[SeasonLogo] Activated for season ${label} — expires ${expiresAt.toISOString()}`);
  return { ok: true, label, expiresAt, logoZone };
}

// ─────────────────────────────────────────────────────────────
//  isProtectedCell(col, row)
//
//  Returns true if the cell falls within the active logo zone
//  AND the protection has not yet expired.
//  Called on every pixel placement attempt.
// ─────────────────────────────────────────────────────────────
async function isProtectedCell(cellCol, cellRow) {
  const cfg = getConfig().season_logo;
  if (!cfg.enabled) return false;

  const state = await col().findOne({ seasonLabel: cfg.seasonLabel });
  if (!state?.logoActive) return false;
  if (state.logoExpiresAt < new Date()) return false;

  const z = state.logoZone;
  return (
    cellCol >= z.col &&
    cellCol <  z.col + z.width &&
    cellRow >= z.row &&
    cellRow <  z.row + z.height
  );
}

// ─────────────────────────────────────────────────────────────
//  getStatus()
//
//  Public status for GET /api/goldpixel/season
// ─────────────────────────────────────────────────────────────
async function getStatus() {
  const cfg = getConfig().season_logo;
  if (!cfg.enabled) return { enabled: false };

  const state = await col().findOne({ seasonLabel: cfg.seasonLabel });
  if (!state) return { enabled: true, active: false, neverActivated: true };

  const msLeft = Math.max(0, new Date(state.logoExpiresAt) - Date.now());
  return {
    enabled:     true,
    active:      msLeft > 0 && state.logoActive,
    label:       state.seasonLabel,
    zone:        state.logoZone,
    expiresAt:   state.logoExpiresAt,
    activatedAt: state.activatedAt,
    msLeft,
    hoursLeft:   +(msLeft / 3_600_000).toFixed(1),
  };
}

// ─────────────────────────────────────────────────────────────
//  deactivate()
//
//  Manually expire the logo before the 48h window.
//  Useful for corrections or early season transitions.
// ─────────────────────────────────────────────────────────────
async function deactivate() {
  const cfg = getConfig().season_logo;
  if (!cfg.enabled) return { ok: false, reason: 'DISABLED' };

  await col().updateOne(
    { seasonLabel: cfg.seasonLabel },
    { $set: { logoActive: false, logoExpiresAt: new Date() } }
  );
  return { ok: true };
}

module.exports = { injectDb, activate, isProtectedCell, getStatus, deactivate };
