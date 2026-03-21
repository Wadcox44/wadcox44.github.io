// ═══════════════════════════════════════════════════════════════
//  SERVICE — First-Pixel Protection
//
//  When a player places their very first pixel, their cells
//  are locked against overwriting for config.durationMs.
//
//  MongoDB collection: pixel_protections
//  Document shape:
//    {
//      piUsername : string,   — player identifier
//      type       : string,   — 'first-session' | 'every-session'
//      expiresAt  : Date,     — when the shield drops
//      usedAt     : Date,     — when activate() was last called
//      cellCount  : number,   — how many cells are currently shielded
//    }
//
//  Activation:
//    POST /api/goldpixel/first-pixel  (called by the client on
//    the very first mousedown that places a pixel).
//
//  NOTE — cell ownership:
//    Full protection requires the server to know WHO painted each
//    cell.  Until pixel_grid is stored in MongoDB, isProtectedCell()
//    is a stub that returns false.  Flip OWNER_TRACKING_READY to
//    true when that collection is available.
//
//  Anti-abuse:
//    protectMaxCells caps the number of cells that can be shielded
//    simultaneously so a player cannot paint 10k cells and lock
//    a massive zone for 10 minutes.
// ═══════════════════════════════════════════════════════════════

'use strict';

const _cfgModule = require('../config/gameConfig');
// Dynamic accessor — always reads the live (possibly patched) config object.
const getConfig = () => _cfgModule.GAME_CONFIG;

/*
  Flip this to true once pixel_grid tracks cell ownership in MongoDB.
  Until then, isProtectedCell() returns false and the guard is a no-op.
*/
const OWNER_TRACKING_READY = false;

let _db = null;
function injectDb(db) { _db = db; }

const col = () => _db.collection('pixel_protections');
const grid = () => _db.collection('pixel_grid');

// ─────────────────────────────────────────────────────────────
//  activate(piUsername)
//
//  Grants protection to piUsername starting now.
//  For 'first-session': only fires once, ever.
//  For 'every-session': resets on each call.
//
//  Returns:
//    { ok, active, expiresAt }  — active=false if already used
// ─────────────────────────────────────────────────────────────
async function activate(piUsername) {
  const cfg = getConfig().first_pixel_prot;
  if (!cfg.enabled) return { ok: true, active: false, reason: 'DISABLED' };

  /* One-time: check if the player has used it before */
  if (cfg.appliesTo === 'first-session') {
    const existing = await col().findOne({ piUsername, type: 'first-session' });
    if (existing) {
      return { ok: true, active: false, reason: 'ALREADY_USED', usedAt: existing.usedAt };
    }
  }

  const expiresAt = new Date(Date.now() + cfg.durationMs);

  await col().updateOne(
    { piUsername },
    {
      $set: {
        piUsername,
        type:      cfg.appliesTo,
        expiresAt,
        usedAt:    new Date(),
        cellCount: 0,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return { ok: true, active: true, expiresAt };
}

// ─────────────────────────────────────────────────────────────
//  isShielded(piUsername)
//
//  True if the player currently has an active protection.
// ─────────────────────────────────────────────────────────────
async function isShielded(piUsername) {
  const cfg = getConfig().first_pixel_prot;
  if (!cfg.enabled) return false;

  const prot = await col().findOne({ piUsername });
  if (!prot) return false;
  return prot.expiresAt > new Date();
}

// ─────────────────────────────────────────────────────────────
//  isProtectedCell(col, row, attackerUsername)
//
//  Returns true if the cell at (col, row) belongs to a player
//  who is currently under first-pixel protection.
//
//  STUB — returns false until pixel_grid tracks ownership.
//  Flip OWNER_TRACKING_READY above when ready.
// ─────────────────────────────────────────────────────────────
async function isProtectedCell(cellCol, cellRow, attackerUsername) {
  const cfg = getConfig().first_pixel_prot;
  if (!cfg.enabled || !OWNER_TRACKING_READY) return false;

  /* Find who owns this cell */
  const cell = await grid().findOne({ cellKey: `${cellCol},${cellRow}` });
  if (!cell?.piUsername) return false;

  /* Attacker can always paint their own cells */
  if (cell.piUsername === attackerUsername) return false;

  /* Is the owner still shielded? */
  return isShielded(cell.piUsername);
}

// ─────────────────────────────────────────────────────────────
//  incrementCellCount(piUsername)
//
//  Tracks how many cells a protected player has painted.
//  If protectMaxCells is exceeded, deactivates the shield.
//  Call after each successful pixel placement while shielded.
// ─────────────────────────────────────────────────────────────
async function incrementCellCount(piUsername) {
  const cfg = getConfig().first_pixel_prot;
  if (!cfg.enabled) return;

  const doc = await col().findOneAndUpdate(
    { piUsername, expiresAt: { $gt: new Date() } },
    { $inc: { cellCount: 1 } },
    { returnDocument: 'after' }
  );

  if (doc && doc.cellCount >= cfg.protectMaxCells) {
    /* Cap reached — revoke shield early */
    await col().updateOne(
      { piUsername },
      { $set: { expiresAt: new Date() } }  // expire now
    );
    console.log(`[FirstPixelProt] Shield revoked for @${piUsername} — cell cap reached`);
  }
}

// ─────────────────────────────────────────────────────────────
//  getStatus(piUsername)
//
//  Full status for GET /api/goldpixel/protection/:username
// ─────────────────────────────────────────────────────────────
async function getStatus(piUsername) {
  const cfg = getConfig().first_pixel_prot;
  if (!cfg.enabled) return { enabled: false };

  const prot = await col().findOne({ piUsername });
  if (!prot) return { enabled: true, active: false, neverUsed: true };

  const msLeft = Math.max(0, prot.expiresAt - Date.now());
  return {
    enabled:    true,
    active:     msLeft > 0,
    expiresAt:  prot.expiresAt,
    msLeft,
    cellCount:  prot.cellCount || 0,
    maxCells:   cfg.protectMaxCells,
    ownerTrackingReady: OWNER_TRACKING_READY,
  };
}

module.exports = {
  injectDb,
  activate,
  isShielded,
  isProtectedCell,
  incrementCellCount,
  getStatus,
};
