'use strict';
/**
 * db.mongo.js — REAL MongoDB-backed data layer.
 *
 * Used automatically by db.js when a MONGO_URI env var is set AND the
 * `mongodb` npm package is installed (it's listed in package.json, so
 * `npm install` on your hosting picks it up — this sandbox just can't
 * reach npm's registry to install it itself).
 *
 * Get a free MongoDB: https://www.mongodb.com/cloud/atlas/register
 * (free M0 cluster), then set:
 *   MONGO_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/mtc
 */
const { MongoClient } = require('mongodb');

let _client = null;
let _db = null;

async function getDb() {
  if (_db) return _db;
  _client = new MongoClient(process.env.MONGO_URI, {});
  await _client.connect();
  const dbName = process.env.MONGO_DB_NAME || 'multi_tabs_controller';
  _db = _client.db(dbName);
  // Helpful indexes; ignore errors if they already exist.
  await Promise.all([
    _db.collection('codes').createIndex({ code: 1 }, { unique: true }).catch(() => {}),
    _db.collection('admins').createIndex({ username: 1 }, { unique: true }).catch(() => {}),
    _db.collection('logs').createIndex({ ts: -1 }).catch(() => {}),
  ]);
  return _db;
}

function wrap(name) {
  return {
    async find(query) { const db = await getDb(); return db.collection(name).find(query || {}).toArray(); },
    async findOne(query) { const db = await getDb(); return db.collection(name).findOne(query || {}); },
    async insertOne(doc) { const db = await getDb(); const r = await db.collection(name).insertOne(doc); return { insertedId: r.insertedId, ...doc }; },
    async updateOne(query, update) { const db = await getDb(); return db.collection(name).updateOne(query, update); },
    async updateMany(query, update) { const db = await getDb(); return db.collection(name).updateMany(query, update); },
    async deleteOne(query) { const db = await getDb(); return db.collection(name).deleteOne(query); },
    async countDocuments(query) { const db = await getDb(); return db.collection(name).countDocuments(query || {}); },
  };
}

const cache = {};
function collection(name) {
  if (!cache[name]) cache[name] = wrap(name);
  return cache[name];
}

// Only used by the JSON fallback's admin "raw state" helper; real Mongo
// doesn't need it, so give server.js a harmless shape if it ever calls it.
function _state() { return { note: 'using real MongoDB, no in-memory state' }; }

module.exports = { collection, _state };
