// ═══════════════════════════════════════════════════════════════
//  SERVICE — Inventory
//
//  Manages the player's owned items and their active effects.
//  This is the GAMEPLAY LAYER — it knows nothing about Pi or money.
//
//  WalletService handles payment → InventoryService handles effect.
//  They are always called sequentially by the shop route:
//    1. WalletService.spend()   → debit credits (reversible)
//    2. InventoryService.grant() → activate item (may fail)
//    3. On failure → WalletService.refund()
//
//  MongoDB collections:
//    inventory    — active and historical item grants
//      { piUsername, itemId, status, grantedAt, expiresAt,
//        activatedAt, effect, meta }
//      status: 'active' | 'expired' | 'consumed' | 'cancelled'
//
//  Effect kinds (interpreted by this service + front-end):
//    cell_shield   — dome items: cells locked against overwrite
//    pixel_charge  — charger items: bonus pixels in reservoir
//    shield_bypass — vengeance: ignore other shields temporarily
//
//  Front-end integration:
//    GET /api/shop/inventory  — returns active items for HUD display
//    The front-end polls this on load and after any purchase.
//    Each active item tells the front-end what to show/enable.
// ═══════════════════════════════════════════════════════════════

'use strict';

const { getItem, ITEMS } = require('./catalogue');

let _db = null;
function injectDb(db) { _db = db; }

const inv = () => _db.collection('inventory');

// ─────────────────────────────────────────────────────────────
//  grant(piUsername, itemId, meta)
//
//  Adds an item to the player's inventory and activates its effect.
//  Called by the shop route AFTER WalletService.spend() succeeds.
//
//  For stackable items: extends the effect rather than creating
//  a second document (see _handleStack).
//
//  Returns the inventory document created/updated.
// ─────────────────────────────────────────────────────────────
async function grant(piUsername, itemId, meta = {}) {
  const item = getItem(itemId);  // throws if unknown/disabled
  const now  = new Date();

  // ── Compute expiry ──
  const expiresAt = item.durationMs
    ? new Date(now.getTime() + item.durationMs)
    : null;  // consumables don't expire — they are 'consumed' instead

  // ── Handle non-stackable active items ──
  if (!item.stackable) {
    const existing = await inv().findOne({
      piUsername,
      itemId,
      status: 'active',
    });
    if (existing) {
      // Extend timer for timed items instead of refusing
      if (item.type === 'timed' && expiresAt) {
        const extended = new Date(
          Math.max(existing.expiresAt?.getTime() ?? now.getTime(), now.getTime())
          + item.durationMs
        );
        await inv().updateOne(
          { _id: existing._id },
          { $set: { expiresAt: extended, updatedAt: now } }
        );
        return { ...existing, expiresAt: extended, extended: true };
      }
      // For other types: refuse duplicate grant
      throw new Error(`ITEM_ALREADY_ACTIVE: ${itemId}`);
    }
  }

  // ── Handle pixel_charge hard cap ──
  if (item.effect?.kind === 'pixel_charge') {
    await _enforcePixelChargeCap(piUsername, item.effect);
  }

  // ── Insert inventory record ──
  const doc = {
    piUsername,
    itemId,
    status:      'active',
    grantedAt:   now,
    activatedAt: now,
    expiresAt,             // null for consumables
    effect:      item.effect,
    meta: {
      itemName: item.name,
      costCredits: item.costCredits,
      ...meta,
    },
    updatedAt: now,
  };

  const result = await inv().insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

// ─────────────────────────────────────────────────────────────
//  getActiveItems(piUsername)
//
//  Returns all currently active items for a player.
//  Automatically expires items whose time has passed.
//  Called by GET /api/shop/inventory and the front-end HUD.
//
//  Returns a structured object grouped by effect kind,
//  easy to interpret on the front-end without extra logic.
// ─────────────────────────────────────────────────────────────
async function getActiveItems(piUsername) {
  const now = new Date();

  // Expire overdue timed items in one write
  await inv().updateMany(
    {
      piUsername,
      status: 'active',
      expiresAt: { $lt: now, $ne: null },
    },
    { $set: { status: 'expired', updatedAt: now } }
  );

  const active = await inv()
    .find({ piUsername, status: 'active' })
    .sort({ grantedAt: -1 })
    .toArray();

  // ── Group by effect kind for easy front-end consumption ──
  const grouped = {
    domes:         [],    // cell_shield effects
    pixelCharges:  [],    // pixel_charge effects
    vengeance:     null,  // shield_bypass (at most 1)
  };

  for (const item of active) {
    const kind = item.effect?.kind;
    const msLeft = item.expiresAt
      ? Math.max(0, item.expiresAt - now)
      : null;

    const summary = {
      inventoryId: item._id.toString(),
      itemId:      item.itemId,
      name:        item.meta?.itemName ?? item.itemId,
      effect:      item.effect,
      expiresAt:   item.expiresAt,
      msLeft,
      grantedAt:   item.grantedAt,
    };

    if (kind === 'cell_shield')   grouped.domes.push(summary);
    if (kind === 'pixel_charge')  grouped.pixelCharges.push(summary);
    if (kind === 'shield_bypass') grouped.vengeance = summary;
  }

  // ── Compute total bonus pixels from all active chargers ──
  grouped.totalBonusPixels = grouped.pixelCharges.reduce(
    (sum, c) => sum + (c.effect?.bonusPixels ?? 0), 0
  );

  // ── Is cell shield active? ──
  grouped.shieldActive = grouped.domes.length > 0;
  grouped.shieldExpiresAt = grouped.domes.length
    ? new Date(Math.max(...grouped.domes.map(d => d.expiresAt?.getTime() ?? 0)))
    : null;

  return { piUsername, active, grouped, asOf: now };
}

// ─────────────────────────────────────────────────────────────
//  consume(piUsername, itemId)
//
//  Marks a consumable item as consumed (single use).
//  For pixel_charge items: called when the player uses their
//  bonus pixels. For domes: expiry handles itself automatically.
// ─────────────────────────────────────────────────────────────
async function consume(piUsername, itemId) {
  const now = new Date();
  const doc = await inv().findOne({ piUsername, itemId, status: 'active' });

  if (!doc) throw new Error(`NO_ACTIVE_ITEM: ${itemId}`);

  await inv().updateOne(
    { _id: doc._id },
    { $set: { status: 'consumed', consumedAt: now, updatedAt: now } }
  );

  return { ok: true, consumed: itemId };
}

// ─────────────────────────────────────────────────────────────
//  isShieldActive(piUsername)
//
//  Quick check used by goldPixelGuard to protect shielded cells.
//  Returns { active, expiresAt } without full inventory load.
// ─────────────────────────────────────────────────────────────
async function isShieldActive(piUsername) {
  const now = new Date();

  // Auto-expire first
  await inv().updateMany(
    { piUsername, status: 'active', expiresAt: { $lt: now, $ne: null } },
    { $set: { status: 'expired', updatedAt: now } }
  );

  const shield = await inv().findOne({
    piUsername,
    status: 'active',
    'effect.kind': 'cell_shield',
  });

  return {
    active:    !!shield,
    expiresAt: shield?.expiresAt ?? null,
    msLeft:    shield?.expiresAt ? Math.max(0, shield.expiresAt - now) : 0,
  };
}

// ─────────────────────────────────────────────────────────────
//  hasVengeance(piUsername)
//
//  Quick check used by goldPixelGuard to bypass shields.
// ─────────────────────────────────────────────────────────────
async function hasVengeance(piUsername) {
  const now = new Date();
  const v = await inv().findOne({
    piUsername,
    status: 'active',
    'effect.kind': 'shield_bypass',
  });
  if (!v) return { active: false };

  // Auto-expire check
  if (v.expiresAt && v.expiresAt < now) {
    await inv().updateOne({ _id: v._id }, { $set: { status: 'expired', updatedAt: now } });
    return { active: false };
  }

  return {
    active:    true,
    expiresAt: v.expiresAt,
    msLeft:    Math.max(0, v.expiresAt - now),
    bypass:    v.effect,
  };
}

// ─────────────────────────────────────────────────────────────
//  getTotalBonusPixels(piUsername)
//
//  Returns the sum of all active pixel_charge bonuses.
//  Used by goldPixelGuard / place-pixel endpoint.
// ─────────────────────────────────────────────────────────────
async function getTotalBonusPixels(piUsername) {
  const { grouped } = await getActiveItems(piUsername);
  return grouped.totalBonusPixels;
}

// ─────────────────────────────────────────────────────────────
//  getHistory(piUsername, limit)
//
//  Returns recent inventory history (active + expired + consumed).
// ─────────────────────────────────────────────────────────────
async function getHistory(piUsername, limit = 20) {
  return inv()
    .find({ piUsername })
    .sort({ grantedAt: -1 })
    .limit(Math.min(50, limit))
    .project({ piUsername: 0, _id: 0 })
    .toArray();
}

// ─────────────────────────────────────────────────────────────
//  _enforcePixelChargeCap(piUsername, effect)  — internal
//
//  Prevents stacking pixel chargers beyond the hardCap.
//  Throws if adding would exceed the cap.
// ─────────────────────────────────────────────────────────────
async function _enforcePixelChargeCap(piUsername, effect) {
  const active = await inv()
    .find({ piUsername, status: 'active', 'effect.kind': 'pixel_charge' })
    .toArray();

  const currentBonus = active.reduce(
    (sum, d) => sum + (d.effect?.bonusPixels ?? 0), 0
  );

  if (currentBonus + effect.bonusPixels > effect.hardCap) {
    throw new Error(
      `PIXEL_CAP_EXCEEDED: current ${currentBonus} + new ${effect.bonusPixels} > cap ${effect.hardCap}`
    );
  }
}

module.exports = {
  injectDb,
  grant,
  getActiveItems,
  consume,
  isShieldActive,
  hasVengeance,
  getTotalBonusPixels,
  getHistory,
};
