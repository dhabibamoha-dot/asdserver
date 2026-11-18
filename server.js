'use strict';
/**
 * server.js — license + updates server for "Nightmare Controller" (v4)
 *
 * No external packages (express/mongodb driver is optional): plain Node http.
 *
 *   node server.js
 *   PORT=8787 ADMIN_USER=admin ADMIN_PASS=... MONGO_URI=... node server.js
 *
 * What it serves
 *   POST /api/auth/login              user login with an access code
 *   POST /api/auth/validate           re-check a session token
 *   GET  /api/update/check            "is there a newer build?" (polled by the userscript)
 *   GET  /api/update/download         the published userscript file
 *   GET  /api/health                  liveness + build info
 *   /admin                            admin panel (public/admin.html)
 *
 * Everything under /api/admin/* requires a bearer token from /api/admin/login.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const db = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SERVER_VERSION = '4.0.0';
const MAX_UPDATE_BYTES = 8 * 1024 * 1024;

// ─────────────────────────────────────────────────────────── basics ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    // Chromium Private Network Access: the userscript runs on a public origin and
    // may reach this server on localhost / a LAN address while testing.
    'Access-Control-Allow-Private-Network': 'true',
  };
}
function baseHeaders(extra) {
  return Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  }, corsHeaders(), extra || {});
}
function send(res, status, body, headers) {
  const isJson = !(body instanceof Buffer) && typeof body !== 'string';
  const h = baseHeaders(Object.assign(
    { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' },
    headers || {}
  ));
  res.writeHead(status, h);
  res.end(isJson ? JSON.stringify(body) : body);
}
function gzipMaybe(req, res, buf) {
  try {
    if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return buf;
    return zlib.gzipSync(buf, { level: 6 });
  } catch (_) { return buf; }
}

// ─────────────────────────────────────────────────── request helpers ──
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || '';
}
function readBody(req, limit) {
  limit = limit || 256 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        const e = new Error('body_too_large');
        e.status = 413;
        reject(e);
        try { req.destroy(); } catch (_) { }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { resolve({}); }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

// small in-memory rate limiter (per key + sliding window)
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 4000) {
    for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  }
  return { ok: b.n <= max, remaining: Math.max(0, max - b.n), reset: b.reset, retryAfter: Math.ceil((b.reset - now) / 1000) };
}
function tooMany(res, r) {
  return send(res, 429, { ok: false, error: 'too_many_requests', retryAfter: r.retryAfter }, { 'Retry-After': String(r.retryAfter) });
}

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) s += '-';
    s += alphabet[crypto.randomInt(alphabet.length)];
  }
  return s;
}
function defaultPermissions() {
  return {
    lines: true, pin: true, fps: true, colors: true,
    macro: true, clip: true, alerts: true, profiles: true, recorder: true,
    // Premium extras: OFF by default, an admin turns them on per code.
    colors_premium: false, rank: false, icons: false, skins: false, phys: false, respawn: false,
  };
}
function clampInt(v, lo, hi, def) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function log(type, extra) {
  try {
    await db.collection('logs').insertOne(Object.assign({ ts: Date.now(), type }, extra || {}));
    const st = db._state && db._state();
    if (st && Array.isArray(st.logs) && st.logs.length > 4000) st.logs.splice(0, st.logs.length - 4000);
  } catch (_) { }
}

// ────────────────────────────────────────────── admin bootstrap/auth ──
async function ensureAdmin() {
  const admins = db.collection('admins');
  const count = await admins.countDocuments({});
  if (count > 0) return;
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASS || crypto.randomBytes(6).toString('hex');
  const { salt, hash } = auth.hashPassword(pass);
  await admins.insertOne({ username: user, salt, hash, createdAt: Date.now() });
  console.log('================================================');
  console.log(' First-run admin account created:');
  console.log('   username:', user);
  console.log('   password:', pass);
  console.log(' (set ADMIN_USER / ADMIN_PASS env vars next run to pick your own)');
  console.log('================================================');
}
async function requireAdmin(req, url) {
  const hdr = String(req.headers['authorization'] || '');
  let token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  // A plain <a href> download can't set an Authorization header, so the one
  // admin-only file-download link is also allowed to pass ?token= instead.
  if (!token && url) { try { token = url.searchParams.get('token') || null; } catch (_) { } }
  const payload = token && auth.verify(token);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}

// ─────────────────────────────────────────────────────── update store ──
const UPDATE_COLL = 'updates';
const UPDATE_ID = 'current';

async function getCurrentUpdate() {
  try {
    const doc = await db.collection(UPDATE_COLL).findOne({ _id: UPDATE_ID });
    return doc || null;
  } catch (_) { return null; }
}
function publicUpdate(doc, clientVersion) {
  if (!doc) return null;
  const out = {
    version: doc.version,
    title: doc.title || '',
    notes: doc.notes || '',
    mode: doc.mode || 'notify',
    minVersion: doc.minVersion || '0.0.0',
    url: '/api/update/download',
    size: doc.size || 0,
    sha256: doc.sha256 || '',
    publishedAt: doc.publishedAt || null,
    downloads: doc.downloads || 0,
    force: doc.mode === 'force',
  };
  if (clientVersion) {
    const cmp = compareVersions(doc.version, clientVersion);
    out.available = cmp > 0;
    out.force = doc.mode === 'force' || compareVersions(clientVersion, out.minVersion) < 0;
  }
  return out;
}
function compareVersions(a, b) {
  const pa = String(a || '0').replace(/[^0-9.].*$/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').replace(/[^0-9.].*$/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
function detectVersion(text) {
  try {
    const m = String(text).slice(0, 4000).match(/@version\s+([0-9][0-9A-Za-z.\-]*)/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

// ───────────────────────────────────────────────────────── routes table ──
const routes = [];
function route(method, re, handler, opts) {
  routes.push({ method, re, handler, limit: (opts && opts.limit) || 256 * 1024, auth: !!(opts && opts.auth) });
}

// ── health ──
route('GET', /^\/api\/health$/, async (req, res) => {
  const codes = await db.collection('codes').countDocuments({});
  const upd = await getCurrentUpdate();
  send(res, 200, {
    ok: true, server: 'nm-license', version: SERVER_VERSION, time: Date.now(),
    codes, update: upd ? { version: upd.version, mode: upd.mode } : null,
    db: process.env.MONGO_URI ? 'mongo' : 'local-json',
  });
});

// ── user auth ──
route('POST', /^\/api\/auth\/login$/, async (req, res, m, body) => {
  const ip = clientIp(req);
  const rl = rateLimit('login:' + ip, 20, 5 * 60 * 1000);
  if (!rl.ok) return tooMany(res, rl);
  const code = String(body.code || '').trim().toUpperCase();
  const deviceId = String(body.deviceId || '').trim() || crypto.randomBytes(8).toString('hex');
  if (!code) return send(res, 400, { ok: false, error: 'missing_code' });

  const rec = await db.collection('codes').findOne({ code });
  if (!rec) { await log('login_fail', { code, ip, reason: 'not_found' }); return send(res, 401, { ok: false, error: 'invalid_code' }); }
  if (!rec.active) { await log('login_fail', { code, ip, reason: 'revoked' }); return send(res, 401, { ok: false, error: 'revoked' }); }
  if (rec.expiresAt && Date.now() > rec.expiresAt) { await log('login_fail', { code, ip, reason: 'expired' }); return send(res, 401, { ok: false, error: 'expired' }); }

  const usedBy = Array.isArray(rec.usedBy) ? rec.usedBy : [];
  const isKnown = usedBy.indexOf(deviceId) !== -1;
  if (!isKnown) {
    const maxDevices = Number(rec.maxDevices) || 1;
    if (usedBy.length >= maxDevices) {
      await log('login_fail', { code, ip, reason: 'device_limit', deviceId });
      return send(res, 401, { ok: false, error: 'device_limit' });
    }
    await db.collection('codes').updateOne({ code }, { $addToSet: { usedBy: deviceId } });
  }
  await db.collection('codes').updateOne({ code }, { $set: { lastLoginAt: Date.now(), lastIp: ip }, $inc: { loginCount: 1 } });

  const exp = Math.min(Date.now() + 12 * 3600 * 1000, rec.expiresAt || Infinity);
  const token = auth.sign({ role: 'user', code, deviceId, exp });
  await log('login_success', { code, ip, deviceId, newDevice: !isKnown });
  const upd = await getCurrentUpdate();
  send(res, 200, {
    ok: true, token, exp,
    permissions: rec.permissions || defaultPermissions(),
    expiresAt: rec.expiresAt || null,
    note: rec.note || '',
    // telling the tool about the newest build right away saves a round trip
    update: upd && upd.mode !== 'off' ? publicUpdate(upd, body.version) : null,
  });
});

route('POST', /^\/api\/auth\/validate$/, async (req, res, m, body) => {
  const payload = auth.verify(body.token);
  if (!payload || payload.role !== 'user') return send(res, 401, { valid: false, reason: 'bad_token' });
  const rec = await db.collection('codes').findOne({ code: payload.code });
  if (!rec || !rec.active) return send(res, 401, { valid: false, reason: 'revoked' });
  if (rec.expiresAt && Date.now() > rec.expiresAt) return send(res, 401, { valid: false, reason: 'expired' });
  send(res, 200, {
    valid: true,
    permissions: rec.permissions || defaultPermissions(),
    expiresAt: rec.expiresAt || null,
    exp: payload.exp,
  });
});

// ── update channel (public) ──
route('GET', /^\/api\/update\/check$/, async (req, res, m, body, url) => {
  const ip = clientIp(req);
  const rl = rateLimit('upd:' + ip, 120, 60 * 1000);
  if (!rl.ok) return tooMany(res, rl);
  const clientVersion = String((url && url.searchParams.get('version')) || '').trim();
  const doc = await getCurrentUpdate();
  if (!doc || doc.mode === 'off') {
    return send(res, 200, { ok: true, update: null, latest: doc ? doc.version : null });
  }
  const info = publicUpdate(doc, clientVersion || null);
  if (clientVersion && !info.available) {
    return send(res, 200, { ok: true, update: null, latest: doc.version });
  }
  if (!clientVersion) return send(res, 200, { ok: true, update: publicUpdate(doc, '0.0.0') });
  await log('update_seen', { version: clientVersion, latest: doc.version, ip, page: url.searchParams.get('page') || '' });
  send(res, 200, { ok: true, update: info, latest: doc.version });
});

route('GET', /^\/api\/update\/download$/, async (req, res, m, body, url) => {
  const doc = await getCurrentUpdate();
  if (!doc || !doc.content) return send(res, 404, 'no update published');
  if (doc.mode === 'off') return send(res, 404, 'update channel is off');
  const buf = Buffer.from(doc.content, 'base64');
  try { await db.collection(UPDATE_COLL).updateOne({ _id: UPDATE_ID }, { $inc: { downloads: 1 } }); } catch (_) { }
  const inline = url && url.searchParams.get('inline') === '1';
  const name = doc.filename || ('nightmare-controller-v' + doc.version + '.user.js');
  const headers = {
    'Content-Type': inline ? 'application/javascript; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename="' + name.replace(/[^A-Za-z0-9._\-]/g, '_') + '"',
    'X-Update-Version': String(doc.version || ''),
    'X-Content-SHA256': String(doc.sha256 || ''),
    'Cache-Control': 'no-store',
  };
  res.writeHead(200, baseHeaders(headers));
  res.end(buf);
});

// ── runtime config (public) ──────────────────────────────────────────────
// A userscript's own localStorage copy of "which server to talk to" can get
// stuck pointing at a dead URL after a redeploy (Railway/Render free tiers
// sometimes change their generated URL). As long as the OLD url is still
// reachable at least once after the move, this lets it learn the NEW one and
// remember it for next time - it cannot help a url that is already 404ing
// with nothing listening, that case still needs a fresh script build via the
// update channel above.
const CONFIG_COLL = 'config';
const CONFIG_ID = 'runtime';
async function getConfig() {
  try { return (await db.collection(CONFIG_COLL).findOne({ _id: CONFIG_ID })) || {}; } catch (_) { return {}; }
}
route('GET', /^\/api\/config$/, async (req, res) => {
  const cfg = await getConfig();
  send(res, 200, { ok: true, serverUrl: cfg.serverUrl || null, motd: cfg.motd || null, updatedAt: cfg.updatedAt || null });
});
route('GET', /^\/api\/admin\/config$/, async (req, res) => {
  if (!(await requireAdmin(req))) return send(res, 401, { ok: false, error: 'unauthorized' });
  const cfg = await getConfig();
  send(res, 200, { ok: true, serverUrl: cfg.serverUrl || '', motd: cfg.motd || '' });
});
route('POST', /^\/api\/admin\/config$/, async (req, res, m, body) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  const set = { updatedAt: Date.now() };
  if (body.serverUrl !== undefined) set.serverUrl = String(body.serverUrl || '').trim().replace(/\/+$/, '');
  if (body.motd !== undefined) set.motd = String(body.motd || '').slice(0, 500);
  const existing = await getConfig();
  if (existing && existing._id) {
    await db.collection(CONFIG_COLL).updateOne({ _id: CONFIG_ID }, { $set: set });
  } else {
    await db.collection(CONFIG_COLL).insertOne(Object.assign({ _id: CONFIG_ID }, set));
  }
  await log('config_updated', { by: p.username, serverUrl: set.serverUrl });
  send(res, 200, { ok: true });
}, { auth: true });

// ── script distribution: plain (admin-only) + obfuscated (shareable) ──────
// Separate from the auto-update channel above on purpose: this is the copy an
// admin hands out by link to end users, so it must look encrypted in the
// Tampermonkey editor while running byte-identical to the plain source.
// NOTE: true "impossible to crack" obfuscation of client-side JS does not
// exist - the browser has to be able to run it, so anyone with enough time
// can always get back to working code. What this does is gzip+XOR+base64 the
// script body behind a tiny loader stub, which stops a casual look in the
// Tampermonkey editor from reading anything, without being a false promise.
const SCRIPT_COLL = 'script_dist';
const SCRIPT_ID = 'current';
function obfuscateUserscript(plainText) {
  const headerMatch = /^([\s\S]*?\/\/\s*==\/UserScript==\s*\n)/.exec(plainText);
  const header = headerMatch ? headerMatch[1] : '// ==UserScript==\n// ==/UserScript==\n';
  const body = plainText.slice(header.length);
  const gz = zlib.gzipSync(Buffer.from(body, 'utf8'));
  const key = crypto.createHash('sha256').update('nm-dist-' + (process.env.NM_DIST_KEY || 'default')).digest();
  const xored = Buffer.alloc(gz.length);
  for (let i = 0; i < gz.length; i++) xored[i] = gz[i] ^ key[i % key.length];
  const b64 = xored.toString('base64');
  // Split into chunks so it doesn't read as one giant suspicious line, and so
  // very large scripts don't hit any single-string engine limits.
  const chunks = [];
  for (let i = 0; i < b64.length; i += 2000) chunks.push(b64.slice(i, i + 2000));
  const loader = `
(function(){
  var __d="${chunks.join('"+"')}";
  try {
    var bin = Uint8Array.from(atob(__d), function(c){ return c.charCodeAt(0); });
    var keyHex = "${key.toString('hex')}";
    var key = new Uint8Array(keyHex.length/2);
    for (var i=0;i<key.length;i++) key[i]=parseInt(keyHex.substr(i*2,2),16);
    var xo = new Uint8Array(bin.length);
    for (var i=0;i<bin.length;i++) xo[i]=bin[i]^key[i%key.length];
    var ds = new DecompressionStream('gzip');
    var stream = new Blob([xo]).stream().pipeThrough(ds);
    new Response(stream).text().then(function(src){
      (0, eval)(src);
    });
  } catch (e) { console.error('[nm] تعذر تشغيل النسخة المشفّرة', e); }
})();
`;
  return header + loader;
}
async function getScriptDist() {
  try { return (await db.collection(SCRIPT_COLL).findOne({ _id: SCRIPT_ID })) || null; } catch (_) { return null; }
}
route('GET', /^\/api\/admin\/script$/, async (req, res) => {
  if (!(await requireAdmin(req))) return send(res, 401, { ok: false, error: 'unauthorized' });
  const doc = await getScriptDist();
  send(res, 200, { ok: true, current: doc ? { version: doc.version, filename: doc.filename, size: doc.size, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy } : null });
});
route('POST', /^\/api\/admin\/script$/, async (req, res, m, body) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  if (!body || !body.content) return send(res, 400, { ok: false, error: 'missing_file' });
  let buf;
  try { buf = Buffer.from(String(body.content), 'base64'); } catch (_) { return send(res, 400, { ok: false, error: 'bad_base64' }); }
  if (!buf.length || buf.length > MAX_UPDATE_BYTES) return send(res, 400, { ok: false, error: 'bad_size' });
  const text = buf.toString('utf8');
  if (!/==UserScript==/.test(text.slice(0, 4000))) return send(res, 400, { ok: false, error: 'not_a_userscript' });
  const obf = obfuscateUserscript(text);
  const doc = {
    _id: SCRIPT_ID,
    version: detectVersion(text) || '',
    filename: String(body.filename || 'nightmare-controller.user.js').slice(0, 120),
    size: buf.length,
    plain: buf.toString('base64'),
    obfuscated: Buffer.from(obf, 'utf8').toString('base64'),
    updatedAt: Date.now(),
    updatedBy: p.username,
  };
  const existing = await getScriptDist();
  if (existing) await db.collection(SCRIPT_COLL).updateOne({ _id: SCRIPT_ID }, { $set: doc });
  else await db.collection(SCRIPT_COLL).insertOne(doc);
  await log('script_dist_updated', { by: p.username, version: doc.version, size: doc.size });
  send(res, 200, { ok: true, version: doc.version, size: doc.size });
}, { auth: true, limit: MAX_UPDATE_BYTES * 2 });
function sendUserscriptFile(res, buf, filename) {
  res.writeHead(200, baseHeaders({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': 'inline; filename="' + filename.replace(/[^A-Za-z0-9._\-]/g, '_') + '"',
    'Cache-Control': 'no-store',
  }));
  res.end(buf);
}
route('GET', /^\/api\/script\/obfuscated$/, async (req, res) => {
  const doc = await getScriptDist();
  if (!doc || !doc.obfuscated) return send(res, 404, 'no script published');
  sendUserscriptFile(res, Buffer.from(doc.obfuscated, 'base64'), doc.filename || 'nightmare-controller.user.js');
});
route('GET', /^\/api\/admin\/script\/plain$/, async (req, res, m, body, url) => {
  if (!(await requireAdmin(req, url))) return send(res, 401, { ok: false, error: 'unauthorized' });
  const doc = await getScriptDist();
  if (!doc || !doc.plain) return send(res, 404, 'no script published');
  sendUserscriptFile(res, Buffer.from(doc.plain, 'base64'), (doc.filename || 'nightmare-controller.user.js').replace(/\.user\.js$/, '.source.user.js'));
});

// ── admin auth ──
route('POST', /^\/api\/admin\/login$/, async (req, res, m, body) => {
  const ip = clientIp(req);
  const rl = rateLimit('admin:' + ip, 12, 10 * 60 * 1000);
  if (!rl.ok) return tooMany(res, rl);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const rec = await db.collection('admins').findOne({ username });
  if (!rec || !auth.checkPassword(password, rec.salt, rec.hash)) {
    await log('admin_login_fail', { username, ip });
    return send(res, 401, { ok: false, error: 'invalid_credentials' });
  }
  const token = auth.sign({ role: 'admin', username, exp: Date.now() + 8 * 3600 * 1000 });
  await log('admin_login', { username, ip });
  send(res, 200, { ok: true, token, username, exp: Date.now() + 8 * 3600 * 1000 });
});

route('GET', /^\/api\/admin\/me$/, async (req, res) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  send(res, 200, { ok: true, username: p.username, exp: p.exp, version: SERVER_VERSION });
}, { auth: true });

route('POST', /^\/api\/admin\/password$/, async (req, res, m, body) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  const rec = await db.collection('admins').findOne({ username: p.username });
  if (!rec || !auth.checkPassword(String(body.currentPassword || ''), rec.salt, rec.hash)) {
    return send(res, 403, { ok: false, error: 'wrong_password' });
  }
  const next = String(body.newPassword || '');
  if (next.length < 8) return send(res, 400, { ok: false, error: 'weak_password' });
  const { salt, hash } = auth.hashPassword(next);
  await db.collection('admins').updateOne({ username: p.username }, { $set: { salt, hash, updatedAt: Date.now() } });
  await log('admin_password_changed', { username: p.username, ip: clientIp(req) });
  send(res, 200, { ok: true });
}, { auth: true });

// ── admin: codes ──
route('GET', /^\/api\/admin\/codes$/, async (req, res) => {
  if (!(await requireAdmin(req))) return send(res, 401, { ok: false, error: 'unauthorized' });
  const codes = await db.collection('codes').find({});
  codes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  send(res, 200, { ok: true, codes });
});

route('POST', /^\/api\/admin\/codes$/, async (req, res, m, body) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  const howMany = clampInt(body.count, 1, 50, 1);
  const durationDays = clampInt(body.durationDays, 0, 3650, 30);
  const maxDevices = clampInt(body.maxDevices, 1, 20, 1);
  const permissions = Object.assign(defaultPermissions(), body.permissions || {});
  const created = [];
  for (let i = 0; i < howMany; i++) {
    let code = String(body.code || '').trim().toUpperCase();
    if (code && howMany > 1) code = '';
    if (!code) {
      let guard = 0;
      do { code = genCode(); guard++; } while (await db.collection('codes').findOne({ code }) && guard < 20);
    } else if (await db.collection('codes').findOne({ code })) {
      return send(res, 409, { ok: false, error: 'code_exists' });
    }
    const doc = {
      code,
      createdAt: Date.now(),
      expiresAt: durationDays > 0 ? Date.now() + durationDays * 86400000 : null,
      durationDays,
      permissions,
      maxDevices,
      usedBy: [],
      active: true,
      note: String(body.note || ''),
      loginCount: 0,
      createdBy: p.username,
    };
    const inserted = await db.collection('codes').insertOne(doc);
    created.push(inserted);
  }
  await log('code_created', { count: created.length, by: p.username, codes: created.map((c) => c.code) });
  send(res, 200, { ok: true, codes: created, code: created[0] });
}, { auth: true });

route('PATCH', /^\/api\/admin\/codes\/([^/]+)$/, async (req, res, m, body) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  const code = decodeURIComponent(m[1]).toUpperCase();
  const rec = await db.collection('codes').findOne({ code });
  if (!rec) return send(res, 404, { ok: false, error: 'not_found' });
  const set = {};
  if (body.active !== undefined) set.active = !!body.active;
  if (body.note !== undefined) set.note = String(body.note).slice(0, 200);
  if (body.maxDevices !== undefined) set.maxDevices = clampInt(body.maxDevices, 1, 20, 1);
  if (body.permissions) set.permissions = Object.assign({}, rec.permissions || defaultPermissions(), body.permissions);
  if (body.extendDays) {
    const base = rec.expiresAt && rec.expiresAt > Date.now() ? rec.expiresAt : Date.now();
    set.expiresAt = base + clampInt(body.extendDays, 1, 3650, 7) * 86400000;
  }
  if (body.setExpiresInDays !== undefined) {
    const d = clampInt(body.setExpiresInDays, 0, 3650, 0);
    set.expiresAt = d > 0 ? Date.now() + d * 86400000 : null;
  }
  if (body.resetDevices) set.usedBy = [];
  if (body.resetLogins) set.loginCount = 0;
  await db.collection('codes').updateOne({ code }, { $set: set });
  const updated = await db.collection('codes').findOne({ code });
  await log('code_updated', { code, by: p.username, fields: Object.keys(set) });
  send(res, 200, { ok: true, code: updated });
}, { auth: true });

route('DELETE', /^\/api\/admin\/codes\/([^/]+)$/, async (req, res, m) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  const code = decodeURIComponent(m[1]).toUpperCase();
  const r = await db.collection('codes').deleteOne({ code });
  await log('code_deleted', { code, by: p.username });
  send(res, 200, { ok: r.deletedCount > 0 });
}, { auth: true });

route('POST', /^\/api\/admin\/codes\/bulk$/, async (req, res, m, body) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  const list = Array.isArray(body.codes) ? body.codes.map((c) => String(c).toUpperCase()).slice(0, 500) : [];
  if (!list.length) return send(res, 400, { ok: false, error: 'no_codes' });
  const action = String(body.action || '');
  let affected = 0;
  for (const code of list) {
    const rec = await db.collection('codes').findOne({ code });
    if (!rec) continue;
    if (action === 'delete') { await db.collection('codes').deleteOne({ code }); affected++; continue; }
    const set = {};
    if (action === 'disable') set.active = false;
    else if (action === 'enable') set.active = true;
    else if (action === 'resetDevices') set.usedBy = [];
    else if (action === 'extend') {
      const base = rec.expiresAt && rec.expiresAt > Date.now() ? rec.expiresAt : Date.now();
      set.expiresAt = base + clampInt(body.days, 1, 3650, 7) * 86400000;
    } else continue;
    await db.collection('codes').updateOne({ code }, { $set: set });
    affected++;
  }
  await log('codes_bulk', { action, count: affected, by: p.username });
  send(res, 200, { ok: true, affected });
}, { auth: true, limit: 512 * 1024 });

// ── admin: logs / stats ──
route('GET', /^\/api\/admin\/logs$/, async (req, res, m, body, url) => {
  if (!(await requireAdmin(req))) return send(res, 401, { ok: false, error: 'unauthorized' });
  const limit = clampInt(url.searchParams.get('limit'), 1, 500, 120);
  const offset = clampInt(url.searchParams.get('offset'), 0, 100000, 0);
  const type = String(url.searchParams.get('type') || '').trim();
  const logs = await db.collection('logs').find({});
  const filtered = (type ? logs.filter((l) => l.type === type) : logs).sort((a, b) => b.ts - a.ts);
  send(res, 200, { ok: true, total: filtered.length, logs: filtered.slice(offset, offset + limit) });
});

route('GET', /^\/api\/admin\/stats$/, async (req, res) => {
  if (!(await requireAdmin(req))) return send(res, 401, { ok: false, error: 'unauthorized' });
  const codes = await db.collection('codes').find({});
  const logs = await db.collection('logs').find({});
  const now = Date.now();
  const day = 86400000;
  const isActive = (c) => c.active && (!c.expiresAt || c.expiresAt > now);
  const perms = defaultPermissions();
  const permUse = {};
  Object.keys(perms).forEach((k) => { permUse[k] = 0; });
  codes.forEach((c) => Object.keys(permUse).forEach((k) => { if (c.permissions && c.permissions[k]) permUse[k]++; }));
  const loginsPerDay = [];
  for (let i = 13; i >= 0; i--) {
    const from = now - (i + 1) * day, to = now - i * day;
    loginsPerDay.push({
      day: new Date(to).toISOString().slice(0, 10),
      n: logs.filter((l) => l.type === 'login_success' && l.ts >= from && l.ts < to).length,
    });
  }
  const upd = await getCurrentUpdate();
  send(res, 200, {
    ok: true,
    totalCodes: codes.length,
    activeCodes: codes.filter(isActive).length,
    expiredCodes: codes.filter((c) => c.expiresAt && c.expiresAt <= now).length,
    revokedCodes: codes.filter((c) => !c.active).length,
    expiringSoon: codes.filter((c) => c.expiresAt && c.expiresAt > now && c.expiresAt - now < 7 * day).length,
    totalLogins: logs.filter((l) => l.type === 'login_success').length,
    failedLogins: logs.filter((l) => l.type === 'login_fail').length,
    loginsToday: logs.filter((l) => l.type === 'login_success' && l.ts > now - day).length,
    devicesInUse: codes.reduce((s, c) => s + ((c.usedBy && c.usedBy.length) || 0), 0),
    permissionUsage: permUse,
    loginsPerDay,
    update: upd ? { version: upd.version, mode: upd.mode, publishedAt: upd.publishedAt, downloads: upd.downloads || 0, minVersion: upd.minVersion } : null,
    recent: logs.filter((l) => l.type === 'login_success').sort((a, b) => b.ts - a.ts).slice(0, 6),
    server: { version: SERVER_VERSION, uptime: Math.round(process.uptime()), db: process.env.MONGO_URI ? 'mongo' : 'local-json', node: process.version },
  });
});

// ── admin: update management ──
route('GET', /^\/api\/admin\/update$/, async (req, res) => {
  if (!(await requireAdmin(req))) return send(res, 401, { ok: false, error: 'unauthorized' });
  const doc = await getCurrentUpdate();
  let history = [];
  try { history = (await db.collection('update_history').find({})).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).slice(0, 15); } catch (_) { }
  send(res, 200, {
    ok: true,
    current: doc ? {
      version: doc.version, title: doc.title || '', notes: doc.notes || '',
      mode: doc.mode || 'notify', minVersion: doc.minVersion || '0.0.0',
      filename: doc.filename || '', size: doc.size || 0, sha256: doc.sha256 || '',
      publishedAt: doc.publishedAt || null, publishedBy: doc.publishedBy || '', downloads: doc.downloads || 0,
    } : null,
    history,
    limits: { maxBytes: MAX_UPDATE_BYTES },
  });
});

route('POST', /^\/api\/admin\/update$/, async (req, res, m, body) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  if (!body || !body.content) return send(res, 400, { ok: false, error: 'missing_file' });

  let buf;
  try { buf = Buffer.from(String(body.content), 'base64'); } catch (_) { return send(res, 400, { ok: false, error: 'bad_base64' }); }
  if (!buf.length) return send(res, 400, { ok: false, error: 'empty_file' });
  if (buf.length > MAX_UPDATE_BYTES) return send(res, 413, { ok: false, error: 'file_too_large', maxBytes: MAX_UPDATE_BYTES });

  const text = buf.toString('utf8');
  if (!/==UserScript==/.test(text.slice(0, 4000))) {
    return send(res, 400, { ok: false, error: 'not_a_userscript' });
  }
  const detected = detectVersion(text);
  const version = String(body.version || detected || '').trim();
  if (!/^[0-9][0-9A-Za-z.\-]{0,24}$/.test(version)) return send(res, 400, { ok: false, error: 'bad_version' });
  const mode = ['off', 'notify', 'force'].includes(body.mode) ? body.mode : 'notify';
  const minVersion = /^[0-9][0-9A-Za-z.\-]{0,24}$/.test(String(body.minVersion || '')) ? String(body.minVersion) : version;

  const prev = await getCurrentUpdate();
  const doc = {
    _id: UPDATE_ID,
    version,
    title: String(body.title || '').slice(0, 120),
    notes: String(body.notes || '').slice(0, 4000),
    mode,
    minVersion,
    filename: String(body.filename || ('nightmare-controller-v' + version + '.user.js')).slice(0, 120),
    size: buf.length,
    sha256: sha256(buf),
    content: buf.toString('base64'),
    publishedAt: Date.now(),
    publishedBy: p.username,
    downloads: 0,
  };
  if (prev) {
    await db.collection(UPDATE_COLL).updateOne({ _id: UPDATE_ID }, { $set: doc });
  } else {
    await db.collection(UPDATE_COLL).insertOne(doc);
  }
  await db.collection('update_history').insertOne({
    version, mode, minVersion, size: doc.size, sha256: doc.sha256,
    publishedAt: doc.publishedAt, publishedBy: p.username, notes: doc.notes,
  });
  await log('update_published', { version, mode, minVersion, size: doc.size, by: p.username });
  send(res, 200, { ok: true, current: publicUpdate(doc, null) });
}, { auth: true, limit: MAX_UPDATE_BYTES * 2 });

route('POST', /^\/api\/admin\/update\/mode$/, async (req, res, m, body) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  const doc = await getCurrentUpdate();
  if (!doc) return send(res, 404, { ok: false, error: 'no_update' });
  const set = {};
  if (['off', 'notify', 'force'].includes(body.mode)) set.mode = body.mode;
  if (body.minVersion && /^[0-9][0-9A-Za-z.\-]{0,24}$/.test(String(body.minVersion))) set.minVersion = String(body.minVersion);
  if (body.notes !== undefined) set.notes = String(body.notes).slice(0, 4000);
  await db.collection(UPDATE_COLL).updateOne({ _id: UPDATE_ID }, { $set: set });
  await log('update_mode_changed', { mode: set.mode, by: p.username });
  const next = await getCurrentUpdate();
  send(res, 200, { ok: true, current: publicUpdate(next, null) });
}, { auth: true });

route('DELETE', /^\/api\/admin\/update$/, async (req, res) => {
  const p = await requireAdmin(req);
  if (!p) return send(res, 401, { ok: false, error: 'unauthorized' });
  await db.collection(UPDATE_COLL).deleteOne({ _id: UPDATE_ID });
  await log('update_removed', { by: p.username });
  send(res, 200, { ok: true });
}, { auth: true });

// ── admin: backup export ──
route('GET', /^\/api\/admin\/backup$/, async (req, res) => {
  if (!(await requireAdmin(req))) return send(res, 401, { ok: false, error: 'unauthorized' });
  const codes = await db.collection('codes').find({});
  const upd = await getCurrentUpdate();
  const body = JSON.stringify({
    exportedAt: new Date().toISOString(), server: SERVER_VERSION,
    codes, update: upd ? { version: upd.version, mode: upd.mode, minVersion: upd.minVersion, sha256: upd.sha256 } : null,
  }, null, 2);
  res.writeHead(200, baseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="nm-backup-' + new Date().toISOString().slice(0, 10) + '.json"',
  }));
  res.end(body);
});

// ───────────────────────────────────────────────────── static files ──
function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = urlPath === '/' || urlPath === '/admin' || urlPath === '/admin/' ? '/admin.html' : urlPath;
    rel = decodeURIComponent(rel).replace(/^\/+/, '');
  } catch (_) { return send(res, 400, 'bad path'); }
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(full).toLowerCase();
    const headers = baseHeaders({ 'Content-Type': MIME[ext] || 'application/octet-stream' });
    if (ext === '.html' || ext === '.js' || ext === '.css') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ─────────────────────────────────────────────────────── dispatcher ──
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { return send(res, 400, 'bad request'); }
  if (req.method === 'OPTIONS') { res.writeHead(204, baseHeaders()); return res.end(); }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req, r.limit) : {};
      return await r.handler(req, res, m, body, url);
    } catch (e) {
      if (e && e.status === 413) return send(res, 413, { ok: false, error: 'body_too_large' });
      console.error('[route]', url.pathname, e);
      return send(res, 500, { ok: false, error: 'server_error' });
    }
  }
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  send(res, 404, { ok: false, error: 'not_found' });
});

// ───────────────────────────────────────────────────────────── boot ──
ensureAdmin().then(() => {
  server.listen(PORT, () => {
    console.log('───────────────────────────────────────────────');
    console.log(' [nm-license] v' + SERVER_VERSION + ' listening on http://localhost:' + PORT);
    console.log(' admin panel : http://localhost:' + PORT + '/admin');
    console.log(' db          : ' + (process.env.MONGO_URI ? 'MongoDB' : 'local JSON file'));
    console.log('───────────────────────────────────────────────');
  });
}).catch((e) => {
  console.error('[boot] failed:', e);
  process.exit(1);
});

module.exports = { server, compareVersions, detectVersion };
