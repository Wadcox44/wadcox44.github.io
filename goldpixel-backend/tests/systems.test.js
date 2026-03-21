// ═══════════════════════════════════════════════════════════════
//  TESTS — Gold Pixel configurable systems
//
//  Run with:  node tests/systems.test.js
//  No external test runner required — uses Node's built-in assert.
//
//  Each test builds a minimal MongoDB-shaped in-memory mock so
//  the service logic can be validated without a real DB connection.
// ═══════════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');

// ── Patch GAME_CONFIG before importing services ──────────────
// gameConfig freezes its objects, so for tests we re-require a
// mutable copy by swapping the module cache entry.
const configModule = require('../config/gameConfig');

// Unfreeze helper: rebuild the whole GAME_CONFIG as a plain mutable object.
function patchConfig(system, overrides) {
  // Replace the frozen inner object with a mutable one.
  // We use Object.defineProperty on the module's exported object.
  const current = configModule.GAME_CONFIG[system];
  const next = Object.assign({}, current, overrides);
  // The outer GAME_CONFIG was frozen — we need a different approach:
  // replace the export with a new mutable proxy-like object.
  if (!configModule.__mutableConfig) {
    // First patch: replace frozen export with a writable shallow copy.
    const mutable = Object.assign({}, configModule.GAME_CONFIG);
    configModule.__mutableConfig = mutable;
    // Redirect every service that reads GAME_CONFIG to our mutable version.
    Object.defineProperty(configModule, 'GAME_CONFIG', {
      get: () => configModule.__mutableConfig,
      configurable: true,
    });
  }
  configModule.__mutableConfig[system] = next;
}

// ── Minimal in-memory DB mock ─────────────────────────────────
function makeCollection(initialDocs = []) {
  let docs = [...initialDocs];

  // Deep-match a single doc against a Mongo-style filter
  function matchDoc(doc, filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        // Operator object: { $gte, $gt, $lt, $lte, $ne, $exists, $in }
        const docVal = doc[k];
        for (const [op, opVal] of Object.entries(v)) {
          if (op === '$gte'    && !(docVal >= opVal))                return false;
          if (op === '$gt'     && !(docVal >  opVal))                return false;
          if (op === '$lt'     && !(docVal <  opVal))                return false;
          if (op === '$lte'    && !(docVal <= opVal))                return false;
          if (op === '$ne'     && docVal === opVal)                  return false;
          if (op === '$exists' && (docVal !== undefined) !== opVal)  return false;
          if (op === '$in'     && !opVal.includes(docVal))           return false;
        }
      } else {
        if (doc[k] !== v) return false;
      }
    }
    return true;
  }

  // Fluent builder returned by find()
  function makeQuery(matched) {
    return {
      _docs: matched,
      sort()    { return this; },
      limit(n)  { this._docs = this._docs.slice(0, n); return this; },
      project() { return this; },
      async toArray() { return this._docs; },
    };
  }

  return {
    _docs: () => docs,
    async insertOne(doc)  { docs.push({ ...doc }); return doc; },
    async insertMany(arr) { docs.push(...arr.map(d => ({ ...d }))); },
    async findOne(filter) { return docs.find(d => matchDoc(d, filter)) ?? null; },
    find(filter = {}) {
      return makeQuery(docs.filter(d => matchDoc(d, filter)));
    },
    async countDocuments(filter = {}) {
      return docs.filter(d => matchDoc(d, filter)).length;
    },
    async updateOne(filter, update, opts = {}) {
      const idx = docs.findIndex(d => matchDoc(d, filter));
      if (idx >= 0) {
        if (update.$set) Object.assign(docs[idx], update.$set);
        if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) {
          docs[idx][k] = (docs[idx][k] || 0) + v;
        }
        if (update.$setOnInsert) { /* no-op on existing doc */ }
        const result = { modifiedCount: 1, value: docs[idx] };
        // findOneAndUpdate compat
        result.value = docs[idx];
        return docs[idx];   // findOneAndUpdate returns the doc directly in our mock
      }
      if (opts.upsert) {
        const doc = { ...update.$setOnInsert, ...update.$set };
        docs.push(doc);
        return doc;
      }
      return null;
    },
    async findOneAndUpdate(filter, update, opts = {}) {
      return this.updateOne(filter, update, opts);
    },
    async updateMany(filter, update) {
      let n = 0;
      for (const d of docs) {
        if (matchDoc(d, filter)) {
          if (update.$set) Object.assign(d, update.$set);
          n++;
        }
      }
      return { modifiedCount: n };
    },
    async deleteMany(filter = {}) {
      const before = docs.length;
      docs = docs.filter(d => !matchDoc(d, filter));
      return { deletedCount: before - docs.length };
    },
    aggregate(pipeline) {
      let result = [...docs];
      for (const stage of pipeline) {
        if (stage.$match)  result = result.filter(d => matchDoc(d, stage.$match));
        if (stage.$group) {
          const groups = {};
          for (const d of result) {
            const keyField = stage.$group._id?.replace?.('$', '') ?? '__all__';
            const key = d[keyField] ?? '__null__';
            if (!groups[key]) groups[key] = { _id: key, count: 0 };
            groups[key].count++;
          }
          result = Object.values(groups);
        }
        if (stage.$sort)  { /* simplified no-op */ }
        if (stage.$limit) result = result.slice(0, stage.$limit);
        if (stage.$project) { /* simplified no-op */ }
      }
      return { async toArray() { return result; } };
    },
  };
}

function makeDb(collections = {}) {
  const cols = {};
  return {
    collection(name) {
      if (!cols[name]) cols[name] = makeCollection(collections[name] || []);
      return cols[name];
    },
  };
}

// ── Test runner ───────────────────────────────────────────────
let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌  ${name}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}


async function main() {

// ═══════════════════════════════════════════════════════════════
//  TERRAIN FATIGUE
// ═══════════════════════════════════════════════════════════════
console.log('\n── Terrain Fatigue ──');
const TF = require('../services/terrainFatigue');

await test('disabled → always allowed', async () => {
  patchConfig('terrain_fatigue', { enabled: false });
  TF.injectDb(makeDb());
  const r = await TF.check('alice', 10, 5);
  assert.strictEqual(r.allowed, true);
});

await test('below threshold → allowed', async () => {
  patchConfig('terrain_fatigue', { enabled: true, maxRepaints: 5, windowMs: 60_000, scope: 'cell', trackAllUsers: true });
  const db = makeDb({ cell_repaints: [
    { cellKey: '10,5', piUsername: 'alice', ts: new Date() },
    { cellKey: '10,5', piUsername: 'bob',   ts: new Date() },
  ]});
  TF.injectDb(db);
  const r = await TF.check('alice', 10, 5);
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.repaints, 2);
});

await test('at threshold → blocked', async () => {
  patchConfig('terrain_fatigue', { enabled: true, maxRepaints: 2, windowMs: 3_600_000, cooldownMs: 300_000, scope: 'cell', trackAllUsers: true });
  const db = makeDb({ cell_repaints: [
    { cellKey: '10,5', piUsername: 'alice', ts: new Date() },
    { cellKey: '10,5', piUsername: 'bob',   ts: new Date() },
  ]});
  TF.injectDb(db);
  const r = await TF.check('charlie', 10, 5);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'CELL_FATIGUED');
  assert.ok(r.cooldownUntil instanceof Date);
});

await test('record() inserts document', async () => {
  patchConfig('terrain_fatigue', { enabled: true, windowMs: 3_600_000, scope: 'cell' });
  const db = makeDb();
  TF.injectDb(db);
  await TF.record('alice', 3, 7);
  const docs = db.collection('cell_repaints')._docs();
  assert.strictEqual(docs.length, 1);
  assert.strictEqual(docs[0].cellKey, '3,7');
});


// ═══════════════════════════════════════════════════════════════
//  WORLD EXPANSION
// ═══════════════════════════════════════════════════════════════
console.log('\n── World Expansion ──');
const WE = require('../services/worldExpansion');

await test('disabled → returns initial dims', async () => {
  patchConfig('world_expansion', { enabled: false, initialCols: 80, initialRows: 45 });
  WE.injectDb(makeDb({ artworks: [] }));
  const d = await WE.getCurrentDimensions();
  assert.strictEqual(d.cols, 80);
  assert.strictEqual(d.rows, 45);
  assert.strictEqual(d.expanded, false);
});

await test('0 artworks → no expansion', async () => {
  patchConfig('world_expansion', { enabled: true, initialCols: 80, initialRows: 45, maxCols: 160, maxRows: 90, artworksPerExpansion: 10, expansionStep: 5, expansionAxis: 'both' });
  WE.injectDb(makeDb({ artworks: [] }));
  const d = await WE.getCurrentDimensions();
  assert.strictEqual(d.cols, 80);
  assert.strictEqual(d.expansions, 0);
});

await test('10 artworks → 1 expansion step', async () => {
  patchConfig('world_expansion', { enabled: true, initialCols: 80, initialRows: 45, maxCols: 160, maxRows: 90, artworksPerExpansion: 10, expansionStep: 5, expansionAxis: 'both' });
  const artworks = Array.from({ length: 10 }, () => ({ status: 'approved' }));
  WE.injectDb(makeDb({ artworks }));
  const d = await WE.getCurrentDimensions();
  assert.strictEqual(d.cols, 85);
  assert.strictEqual(d.rows, 50);
  assert.strictEqual(d.expansions, 1);
});

await test('isInBounds respects expanded dims', async () => {
  patchConfig('world_expansion', { enabled: true, initialCols: 10, initialRows: 10, maxCols: 20, maxRows: 20, artworksPerExpansion: 5, expansionStep: 5, expansionAxis: 'cols' });
  const artworks = Array.from({ length: 5 }, () => ({ status: 'approved' }));
  WE.injectDb(makeDb({ artworks }));
  assert.strictEqual(await WE.isInBounds(14, 9), true);
  assert.strictEqual(await WE.isInBounds(15, 9), false);
});


// ═══════════════════════════════════════════════════════════════
//  SOCIAL SPAWN
// ═══════════════════════════════════════════════════════════════
console.log('\n── Social Spawn ──');
const SS = require('../services/socialSpawn');

await test('disabled → returns canvas centre', async () => {
  patchConfig('world_expansion', { enabled: false, initialCols: 80, initialRows: 45 });
  patchConfig('social_spawn', { enabled: false });
  SS.injectDb(makeDb({ artworks: [] }));
  const p = await SS.getSpawnPoint();
  assert.strictEqual(p.col, 40);
  assert.strictEqual(p.strategy, 'center');
});

await test('not enough artworks → fallback to centre', async () => {
  patchConfig('social_spawn', { enabled: true, strategy: 'most-active', minActiveArtworks: 5, lookbackMs: 86_400_000, radiusCells: 0, fallbackToCenter: true });
  SS.injectDb(makeDb({ artworks: [
    { status: 'approved', createdAt: new Date(), spawnHint: { col: 20, row: 10 } },
  ]}));
  const p = await SS.getSpawnPoint();
  assert.strictEqual(p.strategy, 'center');
});


// ═══════════════════════════════════════════════════════════════
//  FIRST-PIXEL PROTECTION
// ═══════════════════════════════════════════════════════════════
console.log('\n── First-Pixel Protection ──');
const FP = require('../services/firstPixelProt');

await test('disabled → activate returns active:false', async () => {
  patchConfig('first_pixel_prot', { enabled: false });
  FP.injectDb(makeDb());
  const r = await FP.activate('alice');
  assert.strictEqual(r.active, false);
});

await test('first-session: activate grants protection', async () => {
  patchConfig('first_pixel_prot', { enabled: true, durationMs: 600_000, appliesTo: 'first-session', protectMaxCells: 50 });
  FP.injectDb(makeDb());
  const r = await FP.activate('bob');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.active, true);
  assert.ok(r.expiresAt > new Date());
});

await test('first-session: second call returns already-used', async () => {
  patchConfig('first_pixel_prot', { enabled: true, durationMs: 600_000, appliesTo: 'first-session', protectMaxCells: 50 });
  FP.injectDb(makeDb({ pixel_protections: [
    { piUsername: 'carol', type: 'first-session', expiresAt: new Date(Date.now() + 300_000), usedAt: new Date(), cellCount: 0 },
  ]}));
  const r = await FP.activate('carol');
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.reason, 'ALREADY_USED');
});

await test('isShielded returns true within window', async () => {
  patchConfig('first_pixel_prot', { enabled: true, durationMs: 600_000, appliesTo: 'first-session', protectMaxCells: 50 });
  FP.injectDb(makeDb({ pixel_protections: [
    { piUsername: 'dave', expiresAt: new Date(Date.now() + 300_000) },
  ]}));
  assert.strictEqual(await FP.isShielded('dave'), true);
});

await test('isShielded returns false after expiry', async () => {
  patchConfig('first_pixel_prot', { enabled: true });
  FP.injectDb(makeDb({ pixel_protections: [
    { piUsername: 'eve', expiresAt: new Date(Date.now() - 1000) },  // expired
  ]}));
  assert.strictEqual(await FP.isShielded('eve'), false);
});


// ═══════════════════════════════════════════════════════════════
//  SEASON LOGO
// ═══════════════════════════════════════════════════════════════
console.log('\n── Season Logo ──');
const SL = require('../services/seasonLogo');

await test('disabled → isProtectedCell returns false', async () => {
  patchConfig('season_logo', { enabled: false });
  SL.injectDb(makeDb());
  assert.strictEqual(await SL.isProtectedCell(37, 20), false);
});

await test('active logo protects cells inside zone', async () => {
  patchConfig('season_logo', { enabled: true, seasonLabel: 'TEST-S1', centerCol: 35, centerRow: 18, logoWidth: 10, logoHeight: 9, durationMs: 172_800_000 });
  SL.injectDb(makeDb({ season_state: [{
    seasonLabel: 'TEST-S1',
    logoActive: true,
    logoExpiresAt: new Date(Date.now() + 86_400_000),
    logoZone: { col: 35, row: 18, width: 10, height: 9 },
  }]}));
  assert.strictEqual(await SL.isProtectedCell(35, 18), true);   // corner
  assert.strictEqual(await SL.isProtectedCell(44, 26), true);   // far corner
  assert.strictEqual(await SL.isProtectedCell(34, 18), false);  // just outside
  assert.strictEqual(await SL.isProtectedCell(45, 26), false);  // just outside
});

await test('expired logo does not protect', async () => {
  patchConfig('season_logo', { enabled: true, seasonLabel: 'TEST-S1' });
  SL.injectDb(makeDb({ season_state: [{
    seasonLabel: 'TEST-S1',
    logoActive: true,
    logoExpiresAt: new Date(Date.now() - 1000),  // expired
    logoZone: { col: 35, row: 18, width: 10, height: 9 },
  }]}));
  assert.strictEqual(await SL.isProtectedCell(37, 20), false);
});


// ═══════════════════════════════════════════════════════════════
//  SEASON RESET
// ═══════════════════════════════════════════════════════════════
console.log('\n── Season Reset ──');
const SR = require('../services/seasonReset');

await test('disabled → run returns DISABLED', async () => {
  patchConfig('season_reset', { enabled: false });
  SR.injectDb(makeDb());
  const r = await SR.run();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'DISABLED');
});

await test('dryRun: does not write to DB', async () => {
  patchConfig('season_logo',  { enabled: true, seasonLabel: 'DRY-TEST', durationMs: 1 });
  patchConfig('season_reset', { enabled: true, schedule: 'manual', archiveBeforeReset: true, preserveZones: [], notifyBeforeMs: 0, wipeUserCounters: false });
  const artworks = [{ id: '1', status: 'approved' }, { id: '2', status: 'approved' }];
  const db = makeDb({ artworks, season_state: [], users: [] });
  SL.injectDb(db);
  SR.injectDb(db);
  const r = await SR.run({ dryRun: true, label: '2026-DRY' });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.archived, 2);
  // Nothing was written to artworks (dryRun)
  assert.strictEqual(db.collection('artworks')._docs().length, 2);
});

await test('real run: archives artworks', async () => {
  patchConfig('season_logo',  { enabled: false });
  patchConfig('season_reset', { enabled: true, schedule: 'manual', archiveBeforeReset: true, preserveZones: [], notifyBeforeMs: 0, wipeUserCounters: false });
  const artworks = [{ id: 'a1', status: 'approved' }, { id: 'a2', status: 'approved' }];
  const db = makeDb({ artworks, season_state: [], users: [] });
  SL.injectDb(db);
  SR.injectDb(db);
  const r = await SR.run({ label: '2026-01' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.archived, 2);
});

await test('idempotent: second run returns alreadyRun', async () => {
  patchConfig('season_logo',  { enabled: false });
  patchConfig('season_reset', { enabled: true, archiveBeforeReset: false, wipeUserCounters: false });
  const db = makeDb({ season_state: [
    { seasonLabel: '2026-02', resetAt: new Date() },
  ], artworks: [], users: [] });
  SL.injectDb(db);
  SR.injectDb(db);
  const r = await SR.run({ label: '2026-02' });
  assert.strictEqual(r.alreadyRun, true);
});


// ═══════════════════════════════════════════════════════════════
//  SUMMARY
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50));
if (failed > 0) process.exit(1);

} // end main()
main().catch(e => { console.error(e); process.exit(1); });
