// ═══════════════════════════════════════════════════════════════
//  SERVICE — Season Reset
//
//  Performs a full monthly cycle:
//    1. (optional) Pre-notify players N ms before the reset
//    2. Archive all approved artworks to a dated collection
//    3. Wipe the active artwork list (mark archived)
//    4. (optional) Preserve specific canvas zones (hall of fame)
//    5. (optional) Reset user daily counters
//    6. Deactivate the current season logo
//    7. Write a reset record to season_state
//
//  Trigger paths:
//    A. Manual   — POST /api/admin/season-reset/run
//    B. Monthly  — schedule = 'monthly'  →  cron runs
//                  POST /api/archive/run  (existing cron endpoint)
//                  can be extended to call SeasonResetService.run()
//
//  Safety:
//    run() is idempotent within the same calendar month —
//    if called twice it detects the existing reset record and
//    returns early with { ok: true, alreadyRun: true }.
// ═══════════════════════════════════════════════════════════════

'use strict';

const _cfgModule = require('../config/gameConfig');
// Dynamic accessor — always reads the live (possibly patched) config object.
const getConfig = () => _cfgModule.GAME_CONFIG;
const SeasonLogo      = require('./seasonLogo');

let _db = null, _artworks = null, _users = null;
function injectDb(db) {
  _db       = db;
  _artworks = db.collection('artworks');
  _users    = db.collection('users');
}

const seasonCol = () => _db.collection('season_state');

// ─────────────────────────────────────────────────────────────
//  run(options)
//
//  Main entry point.  Returns a result summary.
//
//  options:
//    { dryRun: true }  — simulate without writing, logs output
//    { label: string } — override the auto-generated month label
// ─────────────────────────────────────────────────────────────
async function run({ dryRun = false, label: labelOverride } = {}) {
  const cfg = getConfig().season_reset;
  if (!cfg.enabled) return { ok: false, reason: 'DISABLED' };

  const now   = new Date();
  const label = labelOverride ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  /* ── Idempotency guard ── */
  const existing = await seasonCol().findOne({ seasonLabel: label, resetAt: { $exists: true } });
  if (existing && !dryRun) {
    return { ok: true, alreadyRun: true, label, resetAt: existing.resetAt };
  }

  console.log(`[SeasonReset] ${dryRun ? '[DRY RUN] ' : ''}Starting reset for ${label}`);

  /* ── Step 1: archive artworks ── */
  let archived = 0;
  if (cfg.archiveBeforeReset) {
    archived = await _archiveArtworks(label, dryRun);
  }

  /* ── Step 2: wipe pixel_grid (future) ── */
  // When pixel_grid is in MongoDB, call _wipeGrid(cfg.preserveZones, dryRun)
  // For now this is a documented stub.
  const gridWipe = { status: 'STUB — pixel_grid not yet in MongoDB' };

  /* ── Step 3: preserve zones ── */
  // preserveZones is passed through to the grid wipe stub.
  // When pixel_grid is available:
  //   for each zone in cfg.preserveZones — snapshot and restore after wipe.

  /* ── Step 4: reset user daily counters ── */
  let usersReset = 0;
  if (cfg.wipeUserCounters && !dryRun) {
    const result = await _users.updateMany(
      {},
      { $set: { dailyCount: 0, dailyReset: now } }
    );
    usersReset = result.modifiedCount;
  }

  /* ── Step 5: deactivate current season logo ── */
  if (!dryRun) {
    await SeasonLogo.deactivate();
  }

  /* ── Step 6: write reset record ── */
  if (!dryRun) {
    await seasonCol().updateOne(
      { seasonLabel: label },
      {
        $set: {
          seasonLabel:    label,
          resetAt:        now,
          archivedCount:  archived,
          usersReset,
          preserveZones:  cfg.preserveZones,
          gridWipe,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  }

  const summary = {
    ok:             true,
    dryRun,
    label,
    archived,
    usersReset,
    preserveZones:  cfg.preserveZones,
    gridWipe,
  };

  console.log('[SeasonReset] Completed:', summary);
  return summary;
}

// ─────────────────────────────────────────────────────────────
//  notifyUpcoming(targetDate)
//
//  Placeholder for pre-reset notifications.
//  Hook into your notification system here:
//    — push notifications, email, in-game toast via websocket, etc.
// ─────────────────────────────────────────────────────────────
async function notifyUpcoming(targetDate) {
  const cfg = getConfig().season_reset;
  if (!cfg.enabled || !cfg.notifyBeforeMs) return;

  const msUntil = targetDate - Date.now();
  const hUntil  = Math.round(msUntil / 3_600_000);

  console.log(`[SeasonReset] ⚠️  Season reset in ~${hUntil}h — notify players`);
  // TODO: implement push / SSE / websocket broadcast
}

// ─────────────────────────────────────────────────────────────
//  getStatus()
//
//  Latest reset info for /api/goldpixel/season
// ─────────────────────────────────────────────────────────────
async function getStatus() {
  const cfg = getConfig().season_reset;
  if (!cfg.enabled) return { enabled: false };

  const latest = await seasonCol()
    .find({ resetAt: { $exists: true } })
    .sort({ resetAt: -1 })
    .limit(1)
    .toArray();

  return {
    enabled:       true,
    schedule:      cfg.schedule,
    lastReset:     latest[0] ?? null,
    archivePolicy: cfg.archiveBeforeReset,
    preserveZones: cfg.preserveZones,
  };
}

// ─────────────────────────────────────────────────────────────
//  _archiveArtworks(label, dryRun) — internal
// ─────────────────────────────────────────────────────────────
async function _archiveArtworks(label, dryRun) {
  const toArchive = await _artworks
    .find({ status: 'approved', archived: { $ne: true } })
    .toArray();

  if (!toArchive.length) return 0;

  if (!dryRun) {
    const archiveCol = _db.collection(`archive_${label}`);

    /* Ensure idempotency: skip docs already in the archive */
    const existingIds = await archiveCol
      .find({ id: { $in: toArchive.map(a => a.id) } })
      .project({ id: 1 })
      .toArray()
      .then(docs => new Set(docs.map(d => d.id)));

    const fresh = toArchive.filter(a => !existingIds.has(a.id));
    if (fresh.length) await archiveCol.insertMany(fresh);

    await _artworks.updateMany(
      { status: 'approved', archived: { $ne: true } },
      { $set: { archived: true } }
    );
  }

  return toArchive.length;
}

module.exports = { injectDb, run, notifyUpcoming, getStatus };
