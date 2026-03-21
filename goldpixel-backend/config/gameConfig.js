// ═══════════════════════════════════════════════════════════════
//  GOLD PIXEL — GAME CONFIG
//  Single source of truth for all 6 configurable systems.
//
//  HOW TO USE:
//    • Set enabled: true/false to activate or freeze a system.
//    • Change params here — no logic files need to be touched.
//    • Hot-reload via POST /api/admin/config/update (admin only).
//
//  SAFE DEFAULTS:
//    All systems ship with enabled: false so a fresh deploy
//    cannot accidentally break existing gameplay.
//    Flip to true one system at a time after validation.
//
//  ENV OVERRIDES (optional):
//    Set GP_TERRAIN_FATIGUE=1, GP_WORLD_EXPANSION=1 etc.
//    in Render env-vars to enable systems without a redeploy.
// ═══════════════════════════════════════════════════════════════

'use strict';

/* ── Helper: read a boolean from env, fallback to default ── */
const envBool = (key, fallback) =>
  process.env[key] !== undefined ? process.env[key] === '1' : fallback;

const GAME_CONFIG = {

  // ─────────────────────────────────────────────────────────────
  // 1. TERRAIN FATIGUE
  //
  //  Purpose:
  //    Cells that are repainted too frequently become "fatigued".
  //    While fatigued, further overwrites are blocked or slowed,
  //    preventing pixel-war loops on the same tiny zone.
  //
  //  When to enable:
  //    After the game sees sustained activity. Keep disabled
  //    during beta/low-traffic periods.
  //
  //  Params:
  //    windowMs      — rolling time window to count repaints (ms)
  //    maxRepaints   — max allowed repaints per cell in that window
  //    cooldownMs    — additional lock duration when limit hit
  //    scope         — 'cell' : per individual cell (safest)
  //                    'zone' : aggregate over a NxN block
  //    zoneSize      — block size when scope='zone' (cells per side)
  //    trackAllUsers — true  : count ALL users on the same cell
  //                    false : count only the requesting user
  // ─────────────────────────────────────────────────────────────
  terrain_fatigue: {
    enabled:       envBool('GP_TERRAIN_FATIGUE', false),
    windowMs:      60 * 60 * 1000,   // 1 hour
    maxRepaints:   5,
    cooldownMs:    5 * 60 * 1000,    // 5 minutes
    scope:         'cell',
    zoneSize:      5,
    trackAllUsers: true,
  },

  // ─────────────────────────────────────────────────────────────
  // 2. WORLD EXPANSION
  //
  //  Purpose:
  //    The canvas starts at a comfortable size and grows as the
  //    community publishes more artworks, rewarding growth
  //    without overwhelming new players with empty space.
  //
  //  When to enable:
  //    Once the first 100+ artworks are approved and the game
  //    has enough players to fill the expanded area.
  //
  //  Params:
  //    initialCols/Rows     — starting canvas size
  //    maxCols/Rows         — hard ceiling (never exceeded)
  //    artworksPerExpansion — approved artwork count that
  //                           triggers each new expansion step
  //    expansionStep        — cells added per axis per step
  //    expansionAxis        — 'both' | 'cols' | 'rows'
  //    broadcastOnExpand    — emit a server-sent event when
  //                           the canvas grows (future websocket)
  // ─────────────────────────────────────────────────────────────
  world_expansion: {
    enabled:              envBool('GP_WORLD_EXPANSION', false),
    initialCols:          80,
    initialRows:          45,
    maxCols:              320,
    maxRows:              180,
    artworksPerExpansion: 100,
    expansionStep:        10,
    expansionAxis:        'both',
    broadcastOnExpand:    false,   // future: websocket notify
  },

  // ─────────────────────────────────────────────────────────────
  // 3. SOCIAL SPAWN
  //
  //  Purpose:
  //    New players are directed to an active zone rather than
  //    the raw origin (0,0). This creates organic clustering
  //    and makes the canvas feel alive from the first visit.
  //
  //  When to enable:
  //    As soon as active zones exist (≥ minActiveArtworks).
  //    Safe to enable early; falls back gracefully to center.
  //
  //  Params:
  //    strategy          — 'most-active'  : densest recent zone
  //                        'random-active': random among top 5
  //                        'center'       : fixed canvas center
  //    lookbackMs        — how far back to search for activity
  //    minActiveArtworks — minimum artworks needed before using
  //                        a non-center strategy
  //    radiusCells       — jitter radius around the spawn point
  //                        (so not every player lands exactly
  //                        on the same cell)
  //    fallbackToCenter  — true: use center when no zone found
  // ─────────────────────────────────────────────────────────────
  social_spawn: {
    enabled:          envBool('GP_SOCIAL_SPAWN', false),
    strategy:         'most-active',
    lookbackMs:       24 * 60 * 60 * 1000,  // last 24 hours
    minActiveArtworks: 5,
    radiusCells:      8,
    fallbackToCenter: true,
  },

  // ─────────────────────────────────────────────────────────────
  // 4. FIRST-PIXEL PROTECTION
  //
  //  Purpose:
  //    For 10 minutes after placing their very first pixel,
  //    a new player's cells cannot be overwritten by others.
  //    Gives beginners a brief safe window to establish a foothold
  //    without being immediately erased by veterans.
  //
  //  When to enable:
  //    Once /api/goldpixel/place-pixel is the canonical write
  //    path and the pixel_grid collection is in use.
  //    Keep disabled until the server tracks cell ownership.
  //
  //  Params:
  //    durationMs       — protection window (ms)
  //    appliesTo        — 'first-session' : one-time, ever
  //                       'every-session' : resets on each login
  //    notifyAttacker   — warn the attacker instead of silently
  //                       blocking (friendlier UX)
  //    protectMaxCells  — max number of cells covered (prevent
  //                       abuse by players painting 10k cells
  //                       and holding them locked for 10 min)
  // ─────────────────────────────────────────────────────────────
  first_pixel_prot: {
    enabled:          envBool('GP_FIRST_PIXEL_PROT', false),
    durationMs:       10 * 60 * 1000,   // 10 minutes
    appliesTo:        'first-session',
    notifyAttacker:   true,
    protectMaxCells:  50,
  },

  // ─────────────────────────────────────────────────────────────
  // 5. SEASON LOGO
  //
  //  Purpose:
  //    At the start of each season a branded logo is painted
  //    at the centre of the canvas. It is read-only for 48 hours,
  //    acting as a landmark and reinforcing the seasonal identity.
  //    After expiry it becomes a regular paintable zone.
  //
  //  When to enable:
  //    Manually, at the beginning of each season, via the admin
  //    endpoint POST /api/admin/season-logo/activate.
  //
  //  Params:
  //    durationMs   — lock duration from activation (ms)
  //    centerCol    — top-left col of the logo bounding box
  //    centerRow    — top-left row of the logo bounding box
  //    logoWidth    — width in cells
  //    logoHeight   — height in cells
  //    seasonLabel  — human-readable season ID (e.g. '2026-S1')
  //                   also used as the MongoDB document key
  // ─────────────────────────────────────────────────────────────
  season_logo: {
    enabled:     envBool('GP_SEASON_LOGO', false),
    durationMs:  48 * 60 * 60 * 1000,  // 48 hours
    centerCol:   35,
    centerRow:   18,
    logoWidth:   10,
    logoHeight:   9,
    seasonLabel: '2026-S1',
  },

  // ─────────────────────────────────────────────────────────────
  // 6. SEASON RESET
  //
  //  Purpose:
  //    Monthly wipe of the active canvas, keeping competitive
  //    seasons bounded in time. Artworks are archived before
  //    the reset so history is preserved.
  //
  //  When to enable:
  //    Only when you're ready to commit to seasonal cycles.
  //    Test the full flow in staging first with a short
  //    testWindowMs before switching to 'monthly'.
  //
  //  Params:
  //    schedule           — 'monthly' : first day of month (cron)
  //                         'manual'  : only via admin endpoint
  //    archiveBeforeReset — save all approved artworks to a
  //                         timestamped archive collection
  //    preserveZones      — array of {col,row,w,h} rectangles
  //                         that survive the reset (e.g. hall-of-fame)
  //    notifyBeforeMs     — send a global warning N ms before
  //                         (0 = no advance notice)
  //    wipeUserCounters   — reset dailyCount for all users
  // ─────────────────────────────────────────────────────────────
  season_reset: {
    enabled:            envBool('GP_SEASON_RESET', false),
    schedule:           'manual',
    archiveBeforeReset: true,
    preserveZones:      [],
    notifyBeforeMs:     24 * 60 * 60 * 1000,  // 24 h warning
    wipeUserCounters:   true,
  },
};

// ── Freeze to prevent accidental mutation at runtime ──
// Use /api/admin/config/update for intentional changes.
Object.freeze(GAME_CONFIG);
for (const sys of Object.values(GAME_CONFIG)) Object.freeze(sys);

module.exports = { GAME_CONFIG };
