// ═══════════════════════════════════════════════════════════════
//  ROUTES — Gold Pixel Shop
//
//  Mount in server.js with:
//    const shopRoutes = require('./shop/routes');
//    shopRoutes.inject(db);
//    app.use('/api/shop', shopRoutes.router);
//
//  All purchase flows follow the same safe pattern:
//    1. Validate request
//    2. WalletService.spend()     — debit credits (can refund)
//    3. InventoryService.grant()  — apply effect
//    4. On step 3 failure: WalletService.refund()
//
//  Pi payment flow for bundle purchase:
//    Client ──Pi.createPayment()──▶ Pi Network
//    Pi Network ──webhook──▶ POST /api/shop/bundle/complete
//                       ──▶ WalletService.creditFromPiPayment()
//
//  FUTURE Pi SDK INTEGRATION POINTS are marked with:
//    // ⚡ PI SDK
// ═══════════════════════════════════════════════════════════════

'use strict';

const express   = require('express');
const Wallet    = require('./walletService');
const Inventory = require('./inventoryService');
const { getPublicCatalogue, getItem, getBundle } = require('./catalogue');

const router = express.Router();

let _withPiUser, _piApiKey;
function inject(db, withPiUser, piApiKey) {
  _withPiUser = withPiUser;
  _piApiKey   = piApiKey;
  Wallet.injectDb(db);
  Inventory.injectDb(db);
}

// ── Auth shortcut ──
const auth  = (req, res, next) => _withPiUser(true)(req, res, next);
const noAuth = (req, res, next) => _withPiUser(false)(req, res, next);

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme';
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}


// ═══════════════════════════════════════════════════════════════
//  PUBLIC — no auth required
// ═══════════════════════════════════════════════════════════════

// ── GET /api/shop/catalogue ────────────────────────────────────
// Returns all enabled items + bundles + Elite Pack info.
// Called on shop open. No auth needed — public price list.
router.get('/catalogue', (req, res) => {
  res.json(getPublicCatalogue());
});


// ═══════════════════════════════════════════════════════════════
//  WALLET ROUTES — Pi auth required
// ═══════════════════════════════════════════════════════════════

// ── GET /api/shop/wallet ───────────────────────────────────────
// Returns current credit balance for the authenticated player.
router.get('/wallet', auth, async (req, res) => {
  try {
    const wallet = await Wallet.getBalance(req.piUser.username);
    res.json(wallet);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/shop/wallet/ledger ────────────────────────────────
// Returns recent transaction history.
router.get('/wallet/ledger', auth, async (req, res) => {
  try {
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const ledger = await Wallet.getLedger(req.piUser.username, limit);
    res.json(ledger);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/shop/bundle/initiate ────────────────────────────
// Step 1 of bundle purchase: returns the Pi payment metadata
// that the client needs to call Pi.createPayment().
//
// ⚡ PI SDK — Client then calls:
//   Pi.createPayment({
//     amount:  bundle.pricePi,
//     memo:    bundle.label,
//     metadata: { bundleId, piUsername }
//   }, callbacks)
//
// Body: { bundleId }
router.post('/bundle/initiate', auth, async (req, res) => {
  try {
    const { bundleId } = req.body;
    if (!bundleId) return res.status(400).json({ error: 'bundleId required' });

    const bundle = getBundle(bundleId);  // throws if unknown

    // Return the payment descriptor — client uses this to call Pi SDK
    res.json({
      ok:        true,
      payment: {
        amount:   bundle.pricePi,
        memo:     `Gold Pixel — ${bundle.label}`,
        metadata: {
          type:        'credit_bundle',
          bundleId:    bundle.bundleId,
          piUsername:  req.piUser.username,
          credits:     bundle.credits + (bundle.bonusCredits || 0),
        },
      },
      bundle,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/shop/bundle/approve ─────────────────────────────
// ⚡ PI SDK — Called from Pi.createPayment() onReadyForServerApproval
// Proxies to Pi Network's /v2/payments/:id/approve
// Body: { paymentId }
router.post('/bundle/approve', noAuth, async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

  try {
    // ⚡ PI SDK — Forward approval to Pi Network
    const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
      method:  'POST',
      headers: { Authorization: `Key ${_piApiKey}`, 'Content-Type': 'application/json' },
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/shop/bundle/complete ────────────────────────────
// ⚡ PI SDK — Called from Pi.createPayment() onReadyForServerCompletion
// Completes the Pi payment AND credits the wallet.
// Body: { paymentId, txid, bundleId, piUsername }
router.post('/bundle/complete', noAuth, async (req, res) => {
  const { paymentId, txid, bundleId, piUsername } = req.body;
  if (!paymentId || !txid || !bundleId || !piUsername) {
    return res.status(400).json({ error: 'paymentId, txid, bundleId, piUsername required' });
  }

  try {
    // ── Step 1: Complete on Pi Network ──
    // ⚡ PI SDK
    const piRes = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method:  'POST',
      headers: { Authorization: `Key ${_piApiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ txid }),
    });
    if (!piRes.ok) {
      const err = await piRes.json().catch(() => ({}));
      return res.status(502).json({ error: 'PI_COMPLETE_FAILED', detail: err });
    }

    // ── Step 2: Credit the wallet (idempotent) ──
    const result = await Wallet.creditFromPiPayment(piUsername, bundleId, paymentId);

    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[bundle/complete]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ═══════════════════════════════════════════════════════════════
//  SHOP — buy items with credits
// ═══════════════════════════════════════════════════════════════

// ── POST /api/shop/buy ─────────────────────────────────────────
// Purchase an item using Gold Credits.
// This is the main shop purchase endpoint.
//
// Body: { itemId }
// Auth: Pi required (piUser identifies the buyer)
//
// Transaction safety:
//   spend() → grant() → if grant fails → refund()
router.post('/buy', auth, async (req, res) => {
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });

  const piUsername = req.piUser.username;
  let spent = false;

  try {
    const item = getItem(itemId);  // throws if unknown or disabled

    // ── Step 1: Deduct credits ──
    await Wallet.spend(
      piUsername,
      item.costCredits,
      itemId,
      { itemName: item.name }
    );
    spent = true;

    // ── Step 2: Grant item ──
    const inventoryDoc = await Inventory.grant(piUsername, itemId, {
      purchasedAt: new Date(),
    });

    // ── Step 3: Return updated wallet + item summary ──
    const wallet = await Wallet.getBalance(piUsername);

    res.json({
      ok:        true,
      item:      { itemId, name: item.name, type: item.type, durationMs: item.durationMs },
      inventory: {
        inventoryId: inventoryDoc._id?.toString(),
        expiresAt:   inventoryDoc.expiresAt,
        status:      inventoryDoc.status,
      },
      wallet: { balance: wallet.balance },
    });

  } catch (e) {
    // ── Rollback: refund credits if item grant failed ──
    if (spent) {
      try {
        const item = ITEMS[itemId];
        await Wallet.refund(piUsername, item?.costCredits ?? 0, itemId);
      } catch (refundErr) {
        // Log for manual resolution — balance is at risk
        console.error(`[shop/buy] REFUND FAILED for @${piUsername} item ${itemId}:`, refundErr.message);
      }
    }

    const status =
      e.message.startsWith('INSUFFICIENT_CREDITS')  ? 402 :
      e.message.startsWith('ITEM_ALREADY_ACTIVE')   ? 409 :
      e.message.startsWith('PIXEL_CAP_EXCEEDED')    ? 422 :
      e.message.startsWith('ITEM_DISABLED')         ? 404 : 400;

    res.status(status).json({ error: e.message });
  }
});

// ── POST /api/shop/buy/gift ────────────────────────────────────
// [STUB] Gift an item to another player.
// Deducts from buyer, grants to recipient.
// Body: { itemId, recipientUsername }
router.post('/buy/gift', auth, async (_req, res) => {
  // TODO: implement gifting flow
  // 1. Validate item.giftable === true
  // 2. WalletService.spend(buyer, cost, ref)
  // 3. InventoryService.grant(recipient, itemId)
  // 4. On failure: WalletService.refund(buyer, ...)
  res.status(501).json({ error: 'GIFT_NOT_IMPLEMENTED', message: 'Coming soon.' });
});


// ═══════════════════════════════════════════════════════════════
//  INVENTORY ROUTES
// ═══════════════════════════════════════════════════════════════

// ── GET /api/shop/inventory ────────────────────────────────────
// Returns active items for the authenticated player.
// Called by the HUD on load and after purchases.
// Response includes grouped summary ready for front-end.
router.get('/inventory', auth, async (req, res) => {
  try {
    const result = await Inventory.getActiveItems(req.piUser.username);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/shop/inventory/history ───────────────────────────
// Returns full item history (active + expired + consumed).
router.get('/inventory/history', auth, async (req, res) => {
  try {
    const limit   = Math.min(50, parseInt(req.query.limit) || 20);
    const history = await Inventory.getHistory(req.piUser.username, limit);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ═══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════

// ── POST /api/shop/admin/grant-credits ────────────────────────
// Grants credits to a player without Pi payment.
// Use for bug compensation, events, beta rewards.
// Body: { piUsername, amount, reason }
router.post('/admin/grant-credits', requireAdmin, async (req, res) => {
  const { piUsername, amount, reason } = req.body;
  if (!piUsername || !amount) {
    return res.status(400).json({ error: 'piUsername and amount required' });
  }
  try {
    const result = await Wallet.adminGrant(
      piUsername,
      Number(amount),
      reason || 'admin grant',
      req.headers['x-admin-id'] || 'admin'
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/shop/admin/grant-item ───────────────────────────
// Grants an item directly without charging credits.
// Body: { piUsername, itemId, reason }
router.post('/admin/grant-item', requireAdmin, async (req, res) => {
  const { piUsername, itemId, reason } = req.body;
  if (!piUsername || !itemId) {
    return res.status(400).json({ error: 'piUsername and itemId required' });
  }
  try {
    const doc = await Inventory.grant(piUsername, itemId, {
      adminGrant: true,
      reason: reason || 'admin grant',
    });
    res.json({ ok: true, inventory: doc });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /api/shop/admin/wallet/:username ──────────────────────
// Inspect a player's wallet (admin only).
router.get('/admin/wallet/:username', requireAdmin, async (req, res) => {
  try {
    const [wallet, ledger] = await Promise.all([
      Wallet.getBalance(req.params.username),
      Wallet.getLedger(req.params.username, 50),
    ]);
    res.json({ wallet, ledger });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, inject };
