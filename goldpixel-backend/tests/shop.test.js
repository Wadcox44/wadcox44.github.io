// ═══════════════════════════════════════════════════════════════
//  TESTS — Gold Pixel Shop (Wallet + Inventory + Catalogue)
//  Run with:  node tests/shop.test.js
// ═══════════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');

// ── Minimal in-memory DB mock (same as systems.test.js) ───────
function makeCollection(initial = []) {
  let docs = initial.map(d => ({ ...d }));

  // Resolve dot-notation paths: 'effect.kind' → doc.effect.kind
  function getPath(doc, path) {
    return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), doc);
  }

  function match(doc, filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$and') { if (!v.every(f => match(doc, f))) return false; continue; }
      // Support MongoDB dot-notation for nested fields
      const dv = k.includes('.') ? getPath(doc, k) : doc[k];
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        for (const [op, ov] of Object.entries(v)) {
          if (op === '$lt'  && !(dv <  ov)) return false;
          if (op === '$lte' && !(dv <= ov)) return false;
          if (op === '$gt'  && !(dv >  ov)) return false;
          if (op === '$gte' && !(dv >= ov)) return false;
          if (op === '$ne'  && dv === ov)   return false;
          if (op === '$exists' && Boolean(dv !== undefined) !== Boolean(ov)) return false;
          if (op === '$in' && !ov.includes(dv)) return false;
        }
      } else {
        if (dv !== v) return false;
      }
    }
    return true;
  }

  let nextId = 1;
  function makeQuery(matched) {
    let _d = [...matched];
    const q = {
      sort(s) {
        const [field, dir] = Object.entries(s)[0];
        _d.sort((a, b) => (a[field] > b[field] ? dir : -dir));
        return q;
      },
      limit(n) { _d = _d.slice(0, n); return q; },
      project(p) { return q; },
      async toArray() { return _d; },
    };
    return q;
  }

  return {
    _docs: () => docs,
    async insertOne(doc) {
      const _id = { toString: () => String(nextId++), _n: nextId };
      const d = { ...doc, _id };
      docs.push(d);
      return { insertedId: _id };
    },
    async findOne(filter) { return docs.find(d => match(d, filter)) ?? null; },
    find(filter = {}) { return makeQuery(docs.filter(d => match(d, filter))); },
    async updateOne(filter, update, opts = {}) {
      const idx = docs.findIndex(d => match(d, filter));
      if (idx >= 0) {
        if (update.$set)        Object.assign(docs[idx], update.$set);
        if (update.$inc)        for (const [k, v] of Object.entries(update.$inc)) docs[idx][k] = (docs[idx][k] ?? 0) + v;
        if (update.$setOnInsert){ /* no-op on existing */ }
        return { matchedCount: 1, modifiedCount: 1, value: docs[idx] };
      }
      if (opts.upsert) {
        const d = { ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) };
        docs.push(d);
        return { upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    async updateMany(filter, update) {
      let n = 0;
      for (const d of docs) {
        if (match(d, filter)) {
          if (update.$set) Object.assign(d, update.$set);
          if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) d[k] = (d[k] ?? 0) + v;
          n++;
        }
      }
      return { modifiedCount: n };
    },
    async countDocuments(filter = {}) { return docs.filter(d => match(d, filter)).length; },
    async deleteMany(filter = {}) {
      const before = docs.length;
      docs = docs.filter(d => !match(d, filter));
      return { deletedCount: before - docs.length };
    },
  };
}

function makeDb(cols = {}) {
  const cache = {};
  return {
    collection(name) {
      if (!cache[name]) cache[name] = makeCollection(cols[name] ?? []);
      return cache[name];
    },
  };
}

// ── Test runner ───────────────────────────────────────────────
let passed = 0, failed = 0;
async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✅  ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ❌  ${label}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

async function main() {

// ═══════════════════════════════════════════════════════════════
//  CATALOGUE
// ═══════════════════════════════════════════════════════════════
console.log('\n── Catalogue ──');
const { getPublicCatalogue, getItem, getBundle, ITEMS } = require('../shop/catalogue');

await test('getPublicCatalogue returns items and bundles', () => {
  const cat = getPublicCatalogue();
  assert.ok(Array.isArray(cat.items));
  assert.ok(cat.items.length > 0);
  assert.ok(Array.isArray(cat.creditBundles));
  assert.ok(cat.creditsPerPi === 10);
  assert.ok(cat.elitePack);
});

await test('all 5 items are present and enabled', () => {
  const ids = ['dome_4h', 'dome_8h', 'pixels_100', 'pixels_250', 'vengeance_pack'];
  for (const id of ids) {
    const item = getItem(id);
    assert.strictEqual(item.itemId, id);
    assert.ok(item.costCredits > 0);
  }
});

await test('item costs match spec', () => {
  assert.strictEqual(getItem('dome_4h').costCredits,       0.5);
  assert.strictEqual(getItem('dome_8h').costCredits,       1);
  assert.strictEqual(getItem('pixels_100').costCredits,    1);
  assert.strictEqual(getItem('pixels_250').costCredits,    2);
  assert.strictEqual(getItem('vengeance_pack').costCredits,1);
});

await test('getItem throws on unknown id', () => {
  assert.throws(() => getItem('fake_item'), /Unknown item/);
});

await test('getBundle throws on unknown id', () => {
  assert.throws(() => getBundle('fake_bundle'), /Unknown bundle/);
});

await test('public catalogue strips effect internals', () => {
  const cat = getPublicCatalogue();
  // effect should not be in public catalogue items
  for (const item of cat.items) {
    assert.strictEqual(item.effect, undefined);
  }
});


// ═══════════════════════════════════════════════════════════════
//  WALLET
// ═══════════════════════════════════════════════════════════════
console.log('\n── Wallet ──');
const Wallet = require('../shop/walletService');

await test('getBalance creates wallet at 0 on first call', async () => {
  Wallet.injectDb(makeDb());
  const b = await Wallet.getBalance('alice');
  assert.strictEqual(b.balance, 0);
  assert.strictEqual(b.piUsername, 'alice');
});

await test('adminGrant adds credits', async () => {
  Wallet.injectDb(makeDb());
  await Wallet.adminGrant('bob', 10, 'test grant');
  const b = await Wallet.getBalance('bob');
  assert.strictEqual(b.balance, 10);
});

await test('spend deducts credits and logs ledger', async () => {
  const db = makeDb();
  Wallet.injectDb(db);
  await Wallet.adminGrant('carol', 5, 'setup');
  const r = await Wallet.spend('carol', 3, 'dome_4h');
  assert.strictEqual(r.balance, 2);
  assert.strictEqual(r.spent, 3);
  const ledger = await Wallet.getLedger('carol');
  assert.ok(ledger.some(e => e.type === 'spend'));
});

await test('spend throws INSUFFICIENT_CREDITS when broke', async () => {
  Wallet.injectDb(makeDb());
  await assert.rejects(
    () => Wallet.spend('dave', 5, 'dome_4h'),
    /INSUFFICIENT_CREDITS/
  );
});

await test('refund restores credits', async () => {
  Wallet.injectDb(makeDb());
  await Wallet.adminGrant('eve', 3, 'setup');
  await Wallet.spend('eve', 3, 'dome_4h');
  const r = await Wallet.refund('eve', 3, 'dome_4h');
  assert.strictEqual(r.balance, 3);
});

await test('creditFromPiPayment adds bundle credits', async () => {
  Wallet.injectDb(makeDb());
  const r = await Wallet.creditFromPiPayment('frank', 'bundle_10', 'pi-payment-001');
  assert.strictEqual(r.credits, 10);
  assert.strictEqual(r.balance, 10);
});

await test('creditFromPiPayment is idempotent on duplicate paymentId', async () => {
  Wallet.injectDb(makeDb());
  await Wallet.creditFromPiPayment('grace', 'bundle_10', 'pi-dup-001');
  const r2 = await Wallet.creditFromPiPayment('grace', 'bundle_10', 'pi-dup-001');
  assert.strictEqual(r2.duplicate, true);
  const b = await Wallet.getBalance('grace');
  assert.strictEqual(b.balance, 10);  // not 20
});


// ═══════════════════════════════════════════════════════════════
//  INVENTORY
// ═══════════════════════════════════════════════════════════════
console.log('\n── Inventory ──');
const Inventory = require('../shop/inventoryService');

await test('grant adds active item to inventory', async () => {
  Inventory.injectDb(makeDb());
  const doc = await Inventory.grant('alice', 'dome_4h');
  assert.strictEqual(doc.status, 'active');
  assert.strictEqual(doc.itemId, 'dome_4h');
  assert.ok(doc.expiresAt > new Date());
});

await test('getActiveItems returns grouped summary', async () => {
  Inventory.injectDb(makeDb());
  await Inventory.grant('bob', 'dome_4h');
  const result = await Inventory.getActiveItems('bob');
  assert.strictEqual(result.grouped.shieldActive, true);
  assert.strictEqual(result.grouped.domes.length, 1);
});

await test('dome: non-stackable grant extends timer', async () => {
  Inventory.injectDb(makeDb());
  await Inventory.grant('carol', 'dome_4h');
  const second = await Inventory.grant('carol', 'dome_4h');
  assert.strictEqual(second.extended, true);
  // Only one active dome
  const { active } = await Inventory.getActiveItems('carol');
  const domes = active.filter(a => a.itemId === 'dome_4h');
  assert.strictEqual(domes.length, 1);
});

await test('pixel charger: bonus pixels summed correctly', async () => {
  Inventory.injectDb(makeDb());
  await Inventory.grant('dave', 'pixels_100');
  await Inventory.grant('dave', 'pixels_100');
  const { grouped } = await Inventory.getActiveItems('dave');
  assert.strictEqual(grouped.totalBonusPixels, 200);
});

await test('pixel charger: hard cap enforced', async () => {
  Inventory.injectDb(makeDb());
  // pixels_100 hardCap is 500, so 5 would be 500 (at cap)
  for (let i = 0; i < 5; i++) await Inventory.grant('eve', 'pixels_100');
  await assert.rejects(
    () => Inventory.grant('eve', 'pixels_100'),
    /PIXEL_CAP_EXCEEDED/
  );
});

await test('vengeance pack grants shield_bypass effect', async () => {
  Inventory.injectDb(makeDb());
  await Inventory.grant('frank', 'vengeance_pack');
  const v = await Inventory.hasVengeance('frank');
  assert.strictEqual(v.active, true);
  assert.ok(v.bypass.bypassDomeShield === true);
  assert.ok(v.bypass.bypassSeasonLogo === false);
  assert.ok(v.bypass.bypassElite === false);
});

await test('isShieldActive returns false for player with no dome', async () => {
  Inventory.injectDb(makeDb());
  const s = await Inventory.isShieldActive('grace');
  assert.strictEqual(s.active, false);
});

await test('isShieldActive returns true after dome grant', async () => {
  Inventory.injectDb(makeDb());
  await Inventory.grant('henry', 'dome_8h');
  const s = await Inventory.isShieldActive('henry');
  assert.strictEqual(s.active, true);
  assert.ok(s.msLeft > 0);
});

await test('expired items auto-cleaned on getActiveItems', async () => {
  Inventory.injectDb(makeDb());
  // Manually insert an already-expired item
  const db = makeDb();
  Inventory.injectDb(db);
  const col = db.collection('inventory');
  await col.insertOne({
    piUsername: 'ivy',
    itemId: 'dome_4h',
    status: 'active',
    expiresAt: new Date(Date.now() - 1000),  // already expired
    effect: { kind: 'cell_shield' },
    grantedAt: new Date(),
    meta: {},
    updatedAt: new Date(),
  });
  const { active } = await Inventory.getActiveItems('ivy');
  assert.strictEqual(active.length, 0);
});


// ═══════════════════════════════════════════════════════════════
//  SUMMARY
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50));
if (failed > 0) process.exit(1);

}

main().catch(e => { console.error(e); process.exit(1); });
