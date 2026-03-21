// ═══════════════════════════════════════════════════════════════
//  MIDDLEWARE — goldPixelGuard
//
//  Express middleware applied to POST /api/goldpixel/place-pixel.
//  Chains all active system guards in a fixed priority order.
//  First refusal short-circuits — later guards are not evaluated.
//
//  Guard order (least expensive first):
//    1. World bounds          — sync, pure arithmetic
//    2. Season logo zone      — 1 DB read (cached in future)
//    3. Terrain fatigue       — 1 DB count
//    4. First-pixel protection— 2 DB reads (cell owner + shield)
//
//  Every guard follows the same pattern:
//    if system disabled → pass through (allowed: true)
//    else → check condition → 403/429 or next()
//
//  Usage:
//    app.post('/api/goldpixel/place-pixel',
//      withPiUser(false),
//      goldPixelGuard,
//      placePixelHandler
//    );
// ═══════════════════════════════════════════════════════════════

'use strict';

const WorldExpansion  = require('../services/worldExpansion');
const SeasonLogo      = require('../services/seasonLogo');
const TerrainFatigue  = require('../services/terrainFatigue');
const FirstPixelProt  = require('../services/firstPixelProt');

async function goldPixelGuard(req, res, next) {
  const col      = parseInt(req.body.col);
  const row      = parseInt(req.body.row);
  const username = req.piUser?.username ?? 'anonymous';

  /* Basic coordinate validation */
  if (isNaN(col) || isNaN(row) || col < 0 || row < 0) {
    return res.status(400).json({ error: 'INVALID_COORDS', message: 'col and row must be non-negative integers' });
  }

  /* ── Guard 1: World Bounds ── */
  const inBounds = await WorldExpansion.isInBounds(col, row);
  if (!inBounds) {
    return res.status(403).json({
      error:   'OUT_OF_BOUNDS',
      message: 'This cell is outside the current canvas boundaries.',
    });
  }

  /* ── Guard 2: Season Logo ── */
  const isLogoCel = await SeasonLogo.isProtectedCell(col, row);
  if (isLogoCel) {
    const logoStatus = await SeasonLogo.getStatus();
    return res.status(403).json({
      error:    'LOGO_PROTECTED',
      message:  'This zone is protected by the season logo.',
      expiresAt: logoStatus.expiresAt,
      msLeft:   logoStatus.msLeft,
    });
  }

  /* ── Guard 3: Terrain Fatigue ── */
  const fatigue = await TerrainFatigue.check(username, col, row);
  if (!fatigue.allowed) {
    return res.status(429).json({
      error:         'CELL_FATIGUED',
      message:       'This cell is temporarily locked due to high repaint activity.',
      cooldownUntil: fatigue.cooldownUntil,
      msLeft:        fatigue.msLeft,
      repaints:      fatigue.repaints,
      maxRepaints:   fatigue.maxRepaints,
    });
  }

  /* ── Guard 4: First-Pixel Protection ── */
  const cellProtected = await FirstPixelProt.isProtectedCell(col, row, username);
  if (cellProtected) {
    return res.status(403).json({
      error:   'CELL_PROTECTED',
      message: 'This cell belongs to a player who is under new-player protection.',
    });
  }

  /* All guards passed — attach computed data for the handler */
  req.gpGuardData = { col, row, username, fatigue };
  next();
}

module.exports = goldPixelGuard;
