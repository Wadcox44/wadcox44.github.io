// ═══════════════════════════════════════════════════════════════
//  GOLD PIXEL — SHOP CATALOGUE
//  Single source of truth for:
//    • Credit bundles (Pi → Gold Credits)
//    • Purchasable items (Gold Credits → in-game effect)
//
//  ┌─────────────────────────────────────────────────────────┐
//  │  ARCHITECTURE OVERVIEW                                  │
//  │                                                         │
//  │  Pi Network ──payment──▶ Credit Wallet (server)         │
//  │                              │                          │
//  │                         consume()                       │
//  │                              │                          │
//  │                         Inventory (server)              │
//  │                              │                          │
//  │                         Effect applied in game (front)  │
//  └─────────────────────────────────────────────────────────┘
//
//  Two distinct layers:
//    1. WALLET  — credit balance, Pi payments, transaction log
//    2. INVENTORY — owned items, their effects, expiry tracking
//
//  These layers are intentionally separated so:
//    • The wallet can be audited independently of gameplay
//    • Items can be gifted, granted by admin, or earned without Pi
//    • A future donation system can credit the wallet directly
//
//  Naming convention:
//    itemId   — stable snake_case key, never rename once live
//    type     — 'consumable' | 'timed' | 'permanent'
//    effect   — what the item does (interpreted by InventoryService)
// ═══════════════════════════════════════════════════════════════

'use strict';

// ─────────────────────────────────────────────────────────────
//  CREDIT EXCHANGE RATE
//
//  1 Pi = CREDITS_PER_PI Gold Credits
//  Bundles are the only way to acquire credits via Pi payment.
//
//  Future: add bonus credits for larger bundles ("10 Pi = 110 credits")
//  to reward bigger purchases.
// ─────────────────────────────────────────────────────────────
const CREDITS_PER_PI = 10;  // 10 Gold Credits = 1 Pi

const CREDIT_BUNDLES = [
  {
    bundleId:    'bundle_10',
    label:       '10 Gold Credits',
    credits:     10,
    pricePi:     1,
    bonusCredits: 0,        // future loyalty bonus
    popular:     false,
  },
  {
    bundleId:    'bundle_25',
    label:       '25 Gold Credits',
    credits:     25,
    pricePi:     2.5,
    bonusCredits: 0,
    popular:     true,      // highlighted in UI
  },
  {
    bundleId:    'bundle_50',
    label:       '50 Gold Credits',
    credits:     50,
    pricepi:     5,
    bonusCredits: 5,        // 10% bonus at 50
    popular:     false,
  },
];

// ─────────────────────────────────────────────────────────────
//  ITEM CATALOGUE
//
//  Each item has:
//    itemId      — immutable key used in DB and API
//    name        — display name
//    description — shown in shop UI
//    costCredits — price in Gold Credits (NOT Pi)
//    type        — 'timed'      : effect expires after durationMs
//                  'consumable' : single-use, depletes on activation
//                  'permanent'  : permanent once applied (rare)
//    durationMs  — for timed items: how long the effect lasts
//    effect      — object interpreted by InventoryService.applyEffect()
//    stackable   — can multiple be active at once?
//    giftable    — can be sent to another player (future feature)
//    enabled     — false = item hidden in shop (soft-disable without deploy)
//
//  ANTI-ABUSE NOTES per item — see InventoryService for enforcement.
// ─────────────────────────────────────────────────────────────
const ITEMS = {

  // ── 4H DOME ────────────────────────────────────────────────
  // Protects all player-owned cells from overwriting for 4 hours.
  // Anti-abuse: only covers cells painted BEFORE activation.
  //             New cells painted during dome are NOT protected.
  dome_4h: {
    itemId:      'dome_4h',
    name:        '4H Dome',
    description: 'Protège vos pixels pendant 4 heures.',
    costCredits:  0.5,
    type:        'timed',
    durationMs:   4 * 60 * 60 * 1000,    // 4 hours
    effect: {
      kind:        'cell_shield',
      coversNewCells: false,              // only cells at activation time
    },
    stackable:   false,   // activating a second dome extends the timer
    giftable:    true,
    enabled:     true,
  },

  // ── 8H DOME ────────────────────────────────────────────────
  dome_8h: {
    itemId:      'dome_8h',
    name:        '8H Dome',
    description: 'Protège vos pixels pendant 8 heures.',
    costCredits:  1,
    type:        'timed',
    durationMs:   8 * 60 * 60 * 1000,
    effect: {
      kind:        'cell_shield',
      coversNewCells: false,
    },
    stackable:   false,
    giftable:    true,
    enabled:     true,
  },

  // ── 100 PIXELS CHARGER ─────────────────────────────────────
  // Adds 100 extra paintable gold pixels to the session reservoir.
  // Anti-abuse: bonus expires at end of session / next canvas reset.
  //             Cannot stack beyond CHARGER_HARD_CAP total bonus pixels.
  pixels_100: {
    itemId:      'pixels_100',
    name:        '100 Pixels Charger',
    description: 'Ajoute 100 pixels Or supplémentaires à votre réservoir.',
    costCredits:  1,
    type:        'consumable',
    durationMs:   null,                   // no expiry — valid until reset
    effect: {
      kind:         'pixel_charge',
      bonusPixels:  100,
      hardCap:      500,                  // max total bonus across all chargers
    },
    stackable:   true,    // can buy multiple, capped at hardCap
    giftable:    false,   // pixel charges are personal to a session
    enabled:     true,
  },

  // ── 250 PIXELS CHARGER ─────────────────────────────────────
  pixels_250: {
    itemId:      'pixels_250',
    name:        '250 Pixels Charger',
    description: 'Ajoute 250 pixels Or supplémentaires à votre réservoir.',
    costCredits:  2,
    type:        'consumable',
    durationMs:   null,
    effect: {
      kind:         'pixel_charge',
      bonusPixels:  250,
      hardCap:      500,
    },
    stackable:   true,
    giftable:    false,
    enabled:     true,
  },

  // ── VENGEANCE PACK ─────────────────────────────────────────
  // Grants 10 minutes during which the player can overwrite
  // ANY cell, even those under another player's shield.
  //
  // Anti-abuse:
  //   • Cannot overwrite Season Logo zone.
  //   • Cannot overwrite cells of players with Elite Pack.
  //   • Server logs every overwrite during a vengeance window for audit.
  //   • One Vengeance Pack active at a time per player.
  vengeance_pack: {
    itemId:      'vengeance_pack',
    name:        'Vengeance Pack',
    description: 'Pendant 10 minutes, ignorez les boucliers adverses.',
    costCredits:  1,
    type:        'timed',
    durationMs:  10 * 60 * 1000,          // 10 minutes
    effect: {
      kind:            'shield_bypass',
      bypassDomeShield: true,
      bypassFirstProt:  false,            // cannot bypass first-pixel prot
      bypassSeasonLogo: false,            // never bypass the season logo
      bypassElite:      false,            // never bypass Elite Pack members
      auditLog:         true,             // every cell overwritten is logged
    },
    stackable:   false,   // does NOT extend timer if already active
    giftable:    false,   // too powerful to gift trivially
    enabled:     true,
  },
};

// ─────────────────────────────────────────────────────────────
//  ELITE PACK (direct Pi purchase — NOT credit-based)
//
//  Kept here for a single reference point, but payment flows
//  through the existing /api/payment/* routes, not the shop.
//  Listed here so the shop UI can display it alongside items.
// ─────────────────────────────────────────────────────────────
const ELITE_PACK = {
  itemId:      'elite_pack',
  name:        'Elite Pack',
  description: 'Abonnement mensuel Gold Pixel. Pixels illimités, publications toutes les 30 min, badge Elite.',
  pricepi:     1,           // 1 Pi/month directly
  type:        'permanent', // subscription handled separately
  usesCredits: false,       // paid directly in Pi
  enabled:     true,
};

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

/** Returns all enabled items as an array, safe to send to client. */
function getPublicCatalogue() {
  return {
    creditBundles: CREDIT_BUNDLES,
    items: Object.values(ITEMS)
      .filter(i => i.enabled)
      .map(({ itemId, name, description, costCredits, type, durationMs, stackable, giftable }) => ({
        itemId, name, description, costCredits, type,
        durationMs,  // null for consumables
        stackable, giftable,
      })),
    elitePack: ELITE_PACK,
    creditsPerPi: CREDITS_PER_PI,
  };
}

/** Returns a single item definition by ID. Throws if not found. */
function getItem(itemId) {
  const item = ITEMS[itemId];
  if (!item) throw new Error(`Unknown item: ${itemId}`);
  if (!item.enabled) throw new Error(`Item disabled: ${itemId}`);
  return item;
}

/** Returns a bundle definition by ID. Throws if not found. */
function getBundle(bundleId) {
  const bundle = CREDIT_BUNDLES.find(b => b.bundleId === bundleId);
  if (!bundle) throw new Error(`Unknown bundle: ${bundleId}`);
  return bundle;
}

module.exports = {
  CREDITS_PER_PI,
  CREDIT_BUNDLES,
  ITEMS,
  ELITE_PACK,
  getPublicCatalogue,
  getItem,
  getBundle,
};
