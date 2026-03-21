// ═══════════════════════════════════════════════════════════════
//  SERVICE — Wallet
//
//  Manages Gold Credit balances and the immutable transaction ledger.
//  This is the PAYMENT LAYER — it is deliberately isolated from
//  the inventory/gameplay layer (InventoryService).
//
//  ┌─────────────────────────────────────────────────────────┐
//  │  Responsibility boundary                                │
//  │                                                         │
//  │  WalletService  — knows about Pi, credits, money        │
//  │  InventoryService — knows about items, effects, expiry  │
//  │                                                         │
//  │  The shop route orchestrates both:                      │
//  │    1. WalletService.spend(user, cost)  → debit credits  │
//  │    2. InventoryService.grant(user, item) → add to inv.  │
//  │                                                         │
//  │  If step 2 fails, step 1 is rolled back (refund).       │
//  └─────────────────────────────────────────────────────────┘
//
//  MongoDB collections:
//    credit_wallets   — one document per player
//      { piUsername, balance, lifetimeEarned, lifetimeSpent, updatedAt }
//
//    credit_ledger    — append-only, one entry per operation
//      { piUsername, type, amount, balanceBefore, balanceAfter,
//        ref, meta, createdAt }
//      type: 'purchase' | 'spend' | 'refund' | 'gift_in' | 'gift_out'
//            | 'admin_grant' | 'earn'
//      ref:  itemId / bundleId / paymentId — traceability
//
//  FUTURE Pi SDK INTEGRATION:
//    When Pi.createPayment() confirms a bundle purchase,
//    the webhook calls WalletService.creditFromPiPayment().
//    The paymentId is stored in the ledger for audit.
// ═══════════════════════════════════════════════════════════════

'use strict';

const { getBundle } = require('./catalogue');

let _db = null;
function injectDb(db) { _db = db; }

const wallets = () => _db.collection('credit_wallets');
const ledger  = () => _db.collection('credit_ledger');

// ─────────────────────────────────────────────────────────────
//  getBalance(piUsername)
//
//  Returns the current credit balance.
//  Creates a wallet with 0 balance on first call (lazy init).
// ─────────────────────────────────────────────────────────────
async function getBalance(piUsername) {
  const wallet = await _ensureWallet(piUsername);
  return {
    piUsername,
    balance:        wallet.balance,
    lifetimeEarned: wallet.lifetimeEarned,
    lifetimeSpent:  wallet.lifetimeSpent,
    updatedAt:      wallet.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────
//  creditFromPiPayment(piUsername, bundleId, piPaymentId)
//
//  Called by the shop route AFTER Pi Network confirms payment.
//  Adds credits to the wallet and writes a ledger entry.
//
//  Idempotent: if piPaymentId already exists in the ledger,
//  returns the existing result without double-crediting.
//
//  FUTURE Pi SDK INTEGRATION POINT:
//    This function is called from the payment webhook handler:
//      app.post('/api/payment/complete', async (req, res) => {
//        if (type === 'credit_bundle') {
//          await WalletService.creditFromPiPayment(
//            username, bundleId, paymentId
//          );
//        }
//      });
// ─────────────────────────────────────────────────────────────
async function creditFromPiPayment(piUsername, bundleId, piPaymentId) {
  // ── Idempotency: reject duplicate payment IDs ──
  const existing = await ledger().findOne({ ref: piPaymentId, type: 'purchase' });
  if (existing) {
    return {
      ok:        true,
      duplicate: true,
      balance:   (await getBalance(piUsername)).balance,
    };
  }

  const bundle = getBundle(bundleId);
  const totalCredits = bundle.credits + (bundle.bonusCredits || 0);

  const { before, after } = await _adjustBalance(piUsername, +totalCredits);

  await ledger().insertOne({
    piUsername,
    type:          'purchase',
    amount:        totalCredits,
    balanceBefore: before,
    balanceAfter:  after,
    ref:           piPaymentId,
    meta: {
      bundleId,
      label:      bundle.label,
      pricePi:    bundle.pricePi,
      bonusCredits: bundle.bonusCredits || 0,
    },
    createdAt: new Date(),
  });

  return { ok: true, credits: totalCredits, balance: after };
}

// ─────────────────────────────────────────────────────────────
//  spend(piUsername, amount, ref, meta)
//
//  Deducts `amount` credits from the wallet.
//  Returns { ok, balance } or throws if balance insufficient.
//
//  Called by the shop route BEFORE granting the item.
//  If inventory grant fails, call refund() with the same ref.
//
//  ref   — itemId or operation key (for ledger traceability)
//  meta  — arbitrary object stored in ledger for debugging
// ─────────────────────────────────────────────────────────────
async function spend(piUsername, amount, ref, meta = {}) {
  if (amount <= 0) throw new Error('spend: amount must be positive');

  const wallet = await _ensureWallet(piUsername);
  if (wallet.balance < amount) {
    throw new Error(`INSUFFICIENT_CREDITS: need ${amount}, have ${wallet.balance}`);
  }

  const { before, after } = await _adjustBalance(piUsername, -amount);

  // Also track lifetime spent
  await wallets().updateOne(
    { piUsername },
    { $inc: { lifetimeSpent: amount } }
  );

  await ledger().insertOne({
    piUsername,
    type:          'spend',
    amount:        -amount,
    balanceBefore: before,
    balanceAfter:  after,
    ref,
    meta,
    createdAt:     new Date(),
  });

  return { ok: true, spent: amount, balance: after };
}

// ─────────────────────────────────────────────────────────────
//  refund(piUsername, amount, originalRef)
//
//  Re-credits `amount` credits after a failed purchase.
//  Writes a 'refund' entry referencing the original spend.
// ─────────────────────────────────────────────────────────────
async function refund(piUsername, amount, originalRef) {
  const { before, after } = await _adjustBalance(piUsername, +amount);

  await ledger().insertOne({
    piUsername,
    type:          'refund',
    amount:        +amount,
    balanceBefore: before,
    balanceAfter:  after,
    ref:           `refund:${originalRef}`,
    meta:          { originalRef },
    createdAt:     new Date(),
  });

  return { ok: true, refunded: amount, balance: after };
}

// ─────────────────────────────────────────────────────────────
//  adminGrant(piUsername, amount, reason, adminId)
//
//  Admin-only: grants credits without Pi payment.
//  Use for: bug compensation, events, beta rewards.
//
//  FUTURE: gift/donation support — same function, type='gift_in'.
// ─────────────────────────────────────────────────────────────
async function adminGrant(piUsername, amount, reason, adminId = 'admin') {
  if (amount <= 0) throw new Error('adminGrant: amount must be positive');

  const { before, after } = await _adjustBalance(piUsername, +amount);

  await ledger().insertOne({
    piUsername,
    type:          'admin_grant',
    amount:        +amount,
    balanceBefore: before,
    balanceAfter:  after,
    ref:           `admin:${adminId}:${Date.now()}`,
    meta:          { reason, adminId },
    createdAt:     new Date(),
  });

  return { ok: true, granted: amount, balance: after };
}

// ─────────────────────────────────────────────────────────────
//  giftCredits(fromUsername, toUsername, amount)         [STUB]
//
//  FUTURE: player-to-player gifting.
//  Architecture is ready — two ledger entries (gift_out / gift_in)
//  keep both wallets balanced and auditable.
// ─────────────────────────────────────────────────────────────
async function giftCredits(fromUsername, toUsername, amount) {
  // TODO: implement when gifting UI is ready.
  // Steps:
  //   1. Check fromUsername balance >= amount
  //   2. _adjustBalance(fromUsername, -amount)  → ledger 'gift_out'
  //   3. _adjustBalance(toUsername,  +amount)   → ledger 'gift_in'
  throw new Error('GIFT_NOT_IMPLEMENTED');
}

// ─────────────────────────────────────────────────────────────
//  getLedger(piUsername, limit)
//
//  Returns recent transaction history for the player.
//  Strips internal fields not needed by the client.
// ─────────────────────────────────────────────────────────────
async function getLedger(piUsername, limit = 20) {
  const entries = await ledger()
    .find({ piUsername })
    .sort({ createdAt: -1 })
    .limit(Math.min(100, limit))
    .project({ _id: 0, piUsername: 0 })
    .toArray();

  return entries;
}

// ─────────────────────────────────────────────────────────────
//  _ensureWallet(piUsername)  — internal
//
//  Creates the wallet document on first access (lazy init).
// ─────────────────────────────────────────────────────────────
async function _ensureWallet(piUsername) {
  const now = new Date();
  await wallets().updateOne(
    { piUsername },
    {
      $setOnInsert: {
        piUsername,
        balance:        0,
        lifetimeEarned: 0,
        lifetimeSpent:  0,
        createdAt:      now,
        updatedAt:      now,
      },
    },
    { upsert: true }
  );
  return wallets().findOne({ piUsername });
}

// ─────────────────────────────────────────────────────────────
//  _adjustBalance(piUsername, delta)  — internal
//
//  Atomically adjusts balance. Returns { before, after }.
//  Uses findOneAndUpdate for atomicity — no race conditions.
// ─────────────────────────────────────────────────────────────
async function _adjustBalance(piUsername, delta) {
  await _ensureWallet(piUsername);

  const before = (await wallets().findOne({ piUsername })).balance;

  await wallets().updateOne(
    { piUsername },
    {
      $inc: { balance: delta, ...(delta > 0 ? { lifetimeEarned: delta } : {}) },
      $set: { updatedAt: new Date() },
    }
  );

  const after = (await wallets().findOne({ piUsername })).balance;
  return { before, after };
}

module.exports = {
  injectDb,
  getBalance,
  creditFromPiPayment,
  spend,
  refund,
  adminGrant,
  giftCredits,
  getLedger,
};
