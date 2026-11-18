'use strict';
/**
 * db.local.js — fallback JSON-file data layer, same shape as db.mongo.js.
 *
 * db.js picks this automatically when no MONGO_URI is set (e.g. while
 * testing on your own machine without a Mongo cluster yet). Once you
 * deploy with MONGO_URI set, db.js switches to the real MongoDB driver
 * in db.mongo.js and this file is unused — no code changes needed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function nowId() {
  return crypto.randomBytes(12).toString('hex');
}

function loadRaw() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const seed = { codes: [], sessions: [], logs: [], admins: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    // Corrupt file: back it up instead of losing data silently.
    fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt.' + Date.now());
    const seed = { codes: [], sessions: [], logs: [], admins: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
}

let STATE = loadRaw();
let writeQueued = false;

function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setImmediate(() => {
    writeQueued = false;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(STATE, null, 2));
    fs.renameSync(tmp, DB_FILE);
  });
}

function matches(doc, query) {
  if (!query) return true;
  for (const k of Object.keys(query)) {
    const qv = query[k];
    if (qv && typeof qv === 'object' && !Array.isArray(qv)) {
      if (qv.$in) { if (!qv.$in.includes(doc[k])) return false; continue; }
      if (qv.$gt !== undefined) { if (!(doc[k] > qv.$gt)) return false; continue; }
      if (qv.$lt !== undefined) { if (!(doc[k] < qv.$lt)) return false; continue; }
      if (qv.$ne !== undefined) { if (doc[k] === qv.$ne) return false; continue; }
    }
    if (doc[k] !== qv) return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$unset) for (const k of Object.keys(update.$unset)) delete doc[k];
  if (update.$push) {
    for (const k of Object.keys(update.$push)) {
      if (!Array.isArray(doc[k])) doc[k] = [];
      doc[k].push(update.$push[k]);
    }
  }
  if (update.$addToSet) {
    for (const k of Object.keys(update.$addToSet)) {
      if (!Array.isArray(doc[k])) doc[k] = [];
      if (!doc[k].includes(update.$addToSet[k])) doc[k].push(update.$addToSet[k]);
    }
  }
  if (update.$inc) {
    for (const k of Object.keys(update.$inc)) doc[k] = (doc[k] || 0) + update.$inc[k];
  }
  // Plain object with no operators = full replace of fields (Mongo-ish convenience, not strict spec).
  const hasOp = Object.keys(update).some((k) => k.startsWith('$'));
  if (!hasOp) Object.assign(doc, update);
}

function makeCollection(name) {
  if (!STATE[name]) STATE[name] = [];
  const arr = () => STATE[name];

  return {
    async find(query) {
      return arr().filter((d) => matches(d, query)).map((d) => ({ ...d }));
    },
    async findOne(query) {
      const found = arr().find((d) => matches(d, query));
      return found ? { ...found } : null;
    },
    async insertOne(doc) {
      const toInsert = { _id: doc._id || nowId(), ...doc };
      arr().push(toInsert);
      persist();
      return { insertedId: toInsert._id, ...toInsert };
    },
    async updateOne(query, update) {
      const doc = arr().find((d) => matches(d, query));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(doc, update);
      persist();
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(query, update) {
      const docs = arr().filter((d) => matches(d, query));
      docs.forEach((d) => applyUpdate(d, update));
      if (docs.length) persist();
      return { matchedCount: docs.length, modifiedCount: docs.length };
    },
    async deleteOne(query) {
      const idx = arr().findIndex((d) => matches(d, query));
      if (idx === -1) return { deletedCount: 0 };
      arr().splice(idx, 1);
      persist();
      return { deletedCount: 1 };
    },
    async countDocuments(query) {
      return arr().filter((d) => matches(d, query)).length;
    },
  };
}

const collections = {};
function collection(name) {
  if (!collections[name]) collections[name] = makeCollection(name);
  return collections[name];
}

module.exports = { collection, _state: () => STATE };
