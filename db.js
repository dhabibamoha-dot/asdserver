'use strict';
/**
 * db.js — chooses the real MongoDB layer (db.mongo.js) when MONGO_URI is
 * set, otherwise falls back to a local JSON file (db.local.js) so the
 * server still runs without a database for quick local testing.
 *
 * Both files expose the exact same API: collection(name).find/findOne/
 * insertOne/updateOne/updateMany/deleteOne/countDocuments — server.js
 * and admin.js never know which one is actually in use.
 */
if (process.env.MONGO_URI) {
  console.log('[db] MONGO_URI set -> using real MongoDB (db.mongo.js)');
  module.exports = require('./db.mongo.js');
} else {
  console.log('[db] no MONGO_URI set -> using local JSON file for now (db.local.js). Set MONGO_URI to use real MongoDB.');
  module.exports = require('./db.local.js');
}
