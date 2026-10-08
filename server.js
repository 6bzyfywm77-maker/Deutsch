'use strict';
/* ============================================================
   Deutsch School — backend
   - Kutubxonasiz HTTP server (faqat `pg` Postgres uchun)
   - Ma'lumot: DATABASE_URL bo'lsa Postgres, aks holda data/db.json
   - Login: scrypt bilan xeshlangan parollar, imzolangan HttpOnly cookie
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 12 * 1024 * 1024; // 12 MB (rasm/zaxira uchun)
const SESSION_DAYS = 30;

/* ---------------- yordamchilar ---------------- */

const log = (...a) => console.log(new Date().toISOString(), ...a);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const clone = v => JSON.parse(JSON.stringify(v));

let chain = Promise.resolve();
const serial = fn => {
  const p = chain.then(() => fn());
  chain = p.catch(() => {});
  return p;
};

/* ---------------- saqlash (storage) ---------------- */

async function createStore() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)/.test(url);
    const noSsl = local || /sslmode=disable/.test(url);
    const pool = new Pool({
      connectionString: url,
      ssl: noSsl ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    });
    pool.on('error', e => log('pg pool xatosi:', e.message));
    await pool.query(
      'create table if not exists kv(key text primary key, value jsonb not null, updated_at timestamptz not null default now())'
    );
    return {
      kind: 'postgres',
      async get(k) {
        const r = await pool.query('select value from kv where key=$1', [k]);
        return r.rows[0] ? r.rows[0].value : null;
      },
      async set(k, v) {
        await pool.query(
          'insert into kv(key,value,updated_at) values($1,$2::jsonb,now()) on conflict (key) do update set value=excluded.value, updated_at=now()',
          [k, JSON.stringify(v)]
        );
      },
      async del(k) {
        await pool.query('delete from kv where key=$1', [k]);
      },
      async keys(prefix) {
        const r = await pool.query('select key from kv where key like $1 order by key', [prefix + '%']);
        return r.rows.map(x => x.key);
      },
      async close() {
        await pool.end();
      }
    };
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'db.json');
  let mem = {};
  try {
    mem = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    mem = {};
  }
  const flush = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mem));
    fs.renameSync(tmp, file);
  };
  return {
    kind: 'file',
    async get(k) {
      return k in mem ? clone(mem[k]) : null;
    },
    async set(k, v) {
      mem[k] = clone(v);
      flush();
    },
    async del(k) {
      delete mem[k];
      flush();
    },
    async keys(prefix) {
      return Object.keys(mem).filter(k => k.startsWith(prefix)).sort();
    },
    async close() {}
  };
}

/* ---------------- parollar ---------------- */

function scrypt(pw, salt) {
  return new Promise((res, rej) =>
    crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k)))
  );
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw), salt);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}
async function verifyPassword(pw, stored) {
  try {
    const [alg, s, k] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !s || !k) return false;
    const key = await scrypt(String(pw), Buffer.from(s, 'hex'));
    const want = Buffer.from(k, 'hex');
    return key.length === want.length && crypto.timingSafeEqual(key, want);
  } catch (e) {
    return false;
  }
}
let DUMMY_HASH = null; // login vaqtini tenglashtirish uchun

/* ---------------- holat (xotirada, har o'zgarishda saqlanadi) ---------------- */

let store;
let DOC = { rev: 0, data: {} }; // asosiy ma'lumot
let ADMIN = null; // { user, hash, ver }
let CREDS = {}; // teacherId -> { login, hash, ver, t }
let META = { secret: '' };

const persistDoc = () => serial(() => store.set('doc', DOC));
const persistAdmin = () => serial(() => store.set('admin', ADMIN));
const persistCreds = () => serial(() => store.set('creds', CREDS));

/* ---------------- sessiya ---------------- */

const b64u = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', META.secret).update(s).digest('base64url');

function makeToken(who, ver, remember) {
  const exp = Date.now() + (remember ? SESSION_DAYS : 1) * 86400000;
  const body = b64u(JSON.stringify({ w: who, v: ver, e: exp }));
  return body + '.' + sign(body);
}
function readToken(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || p.e < Date.now()) return null;
    return p;
  } catch (e) {
    return null;
  }
}
function parseCookies(h) {
  const out = {};
  String(h || '')
    .split(';')
    .forEach(x => {
      const i = x.indexOf('=');
      if (i > 0) out[x.slice(0, i).trim()] = decodeURIComponent(x.slice(i + 1).trim());
    });
  return out;
}
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
}
function setSessionCookie(req, res, who, ver, remember) {
  const parts = ['ds_sid=' + makeToken(who, ver, remember), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (remember) parts.push('Max-Age=' + SESSION_DAYS * 86400);
  if (PROD || isHttps(req)) parts.push('Secure');
  addHeader(res, 'Set-Cookie', parts.join('; '));
}
function clearSessionCookie(req, res) {
  const parts = ['ds_sid=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (PROD || isHttps(req)) parts.push('Secure');
  addHeader(res, 'Set-Cookie', parts.join('; '));
}
function addHeader(res, k, v) {
  const cur = res.getHeader(k);
  if (!cur) res.setHeader(k, v);
  else res.setHeader(k, [].concat(cur, v));
}

/** Joriy foydalanuvchi: { role:'admin' } | { role:'teacher', id } | null */
function sessionOf(req) {
  const tok = parseCookies(req.headers.cookie).ds_sid;
  const p = readToken(tok);
  if (!p) return null;
  if (p.w === 'admin') {
    if (!ADMIN || p.v !== ADMIN.ver) return null;
    return { role: 'admin', id: 'admin' };
  }
  const c = CREDS[p.w];
  if (!c || c.ver !== p.v) return null;
  return { role: 'teacher', id: p.w };
}

/* ---------------- login urinishlarini cheklash ---------------- */

const attempts = new Map();
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}
function tooMany(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) return false;
  return a.n >= 8;
}
function addAttempt(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) attempts.set(key, { n: 1, reset: now + 15 * 60000 });
  else a.n++;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
}, 10 * 60000).unref();

/* ---------------- HTTP yordamchilari ---------------- */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
const fail = (res, code, msg) => send(res, code, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Hajm juda katta'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('JSON noto‘g‘ri'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return new URL(o).host === req.headers.host;
  } catch (e) {
    return false;
  }
}

function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  if (PROD || isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/* ---------------- ma'lumotga ruxsat va tozalash ---------------- */

const TEACHER_KEYS = new Set(['weekly', 'weeklyMeta', 'weeklyBy', 'attendance']);
const GEN_SUBJECT = '__general__';

function teacherLessons(data, tid) {
  return (data.timetable || []).filter(x => x && x.teacherId === tid && x.subjectId && x.groupId);
}
function teacherMayWrite(data, tid, p) {
  if (!TEACHER_KEYS.has(p[0])) return false;
  if (p.length < 2) return false; // butun bo'limni almashtira olmaydi
  const parts = String(p[1]).split('|');
  const gid = parts[0];
  const lessons = teacherLessons(data, tid).filter(x => x.groupId === gid);
  if (!lessons.length) return false;
  if (p[0] !== 'attendance' && parts[1] && parts[1] !== GEN_SUBJECT) {
    if (!lessons.some(x => x.subjectId === parts[1])) return false;
  }
  return true;
}

/** Mijozga beriladigan ko'rinish (parol xeshlari hech qachon chiqmaydi) */
function viewFor(sess) {
  const d = clone(DOC.data);
  if (Array.isArray(d.teachers)) {
    d.teachers = d.teachers.map(t => {
      const c = CREDS[t.id];
      const o = { ...t };
      delete o.pwHash;
      o.pwHash = c ? 'set' : '';
      if (c) o.login = c.login;
      return o;
    });
  }
  if (sess.role === 'teacher') {
    delete d.payments;
    delete d.studentDeleteLog;
    delete d.subjectDeleteLog;
    delete d.teacherDeleteLog;
    delete d.groupDeleteLog;
    if (d.profile) d.profile = { name: d.profile.name, photo: '' };
  }
  return d;
}

function applyOps(data, ops, sess) {
  if (!Array.isArray(ops) || ops.length > 20000) throw httpErr(400, 'Noto‘g‘ri so‘rov');
  for (const op of ops) {
    const p = op && op.p;
    if (!Array.isArray(p) || p.length < 1 || p.length > 8) throw httpErr(400, 'Noto‘g‘ri yo‘l');
    for (const seg of p) {
      if (typeof seg !== 'string' || BAD_KEYS.has(seg) || seg.length > 300) throw httpErr(400, 'Noto‘g‘ri kalit');
    }
    if (sess.role === 'teacher' && !teacherMayWrite(data, sess.id, p)) {
      throw httpErr(403, 'Bu o‘zgarishga ruxsat yo‘q');
    }
  }
  for (const op of ops) {
    const p = op.p;
    let cur = data;
    for (let i = 0; i < p.length - 1; i++) {
      if (!isObj(cur[p[i]])) {
        if (op.d) {
          cur = null;
          break;
        }
        cur[p[i]] = {};
      }
      cur = cur[p[i]];
    }
    if (!cur) continue;
    const last = p[p.length - 1];
    if (op.d) delete cur[last];
    else cur[last] = op.v === undefined ? null : op.v;
  }
}

function httpErr(code, msg) {
  return Object.assign(new Error(msg), { code });
}

/** teachers[] o'zgarganda login ma'lumotlarini moslash */
function syncCreds() {
  let changed = false;
  const list = Array.isArray(DOC.data.teachers) ? DOC.data.teachers : [];
  const byId = new Map(list.map(t => [t.id, t]));
  const taken = new Set();
  if (ADMIN) taken.add(ADMIN.user.toLowerCase());
  for (const [id, c] of Object.entries(CREDS)) {
    const t = byId.get(id);
    if (!t) {
      if (Date.now() - (c.t || 0) > 120000) {
        delete CREDS[id];
        changed = true;
      }
      continue;
    }
    const login = String(t.login || '').trim();
    if (!login) {
      delete CREDS[id];
      changed = true;
      continue;
    }
    if (login.toLowerCase() !== c.login.toLowerCase()) {
      const clash =
        taken.has(login.toLowerCase()) ||
        Object.entries(CREDS).some(([o, x]) => o !== id && x.login.toLowerCase() === login.toLowerCase());
      if (clash) throw httpErr(409, 'Bu login band');
      c.login = login;
      c.ver = (c.ver || 0) + 1;
      changed = true;
    }
  }
  // doimiy xesh maydonlarini hujjatdan olib tashlash
  for (const t of list) {
    if ('pwHash' in t) delete t.pwHash;
  }
  return changed;
}

/* ---------------- kunlik zaxira ---------------- */

async function dailyBackup() {
  try {
    const key = 'backup:' + new Date().toISOString().slice(0, 10);
    const have = await store.get(key);
    if (!have && DOC.rev > 0) {
      await store.set(key, { rev: DOC.rev, data: DOC.data });
      const keys = await store.keys('backup:');
      const old = keys.slice(0, Math.max(0, keys.length - 14));
      for (const k of old) await store.del(k);
    }
  } catch (e) {
    log('zaxira xatosi:', e.message);
  }
}

/* ---------------- API ---------------- */

async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;

  if (route === 'GET /api/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    return fail(res, 403, 'Ruxsat etilmagan manba');
  }

  if (route === 'GET /api/status') {
    return send(res, 200, { needsSetup: !ADMIN });
  }

  /* ---- birinchi administrator ---- */
  if (route === 'POST /api/auth/setup') {
    if (ADMIN) return fail(res, 409, 'Administrator allaqachon yaratilgan');
    const b = await readBody(req);
    const user = String(b.user || '').trim();
    const pw = String(b.password || '');
    if (!user || user.length > 60) return fail(res, 400, 'Login kiriting');
    if (pw.length < 4) return fail(res, 400, 'Parol kamida 4 belgidan iborat bo‘lsin');
    ADMIN = { user, hash: await hashPassword(pw), ver: 1 };
    await persistAdmin();
    setSessionCookie(req, res, 'admin', ADMIN.ver, true);
    return send(res, 200, { ok: true });
  }

  /* ---- kirish ---- */
  if (route === 'POST /api/auth/login') {
    const b = await readBody(req);
    const user = String(b.user || '').trim();
    const pw = String(b.password || '');
    const key = clientIp(req) + '|' + user.toLowerCase();
    if (tooMany(key) || tooMany(clientIp(req) + '|*')) {
      return fail(res, 429, 'Juda ko‘p urinish. 15 daqiqadan keyin qayta urinib ko‘ring');
    }
    if (!DUMMY_HASH) DUMMY_HASH = await hashPassword('dummy');
    let who = null;
    let ver = 0;

    if (ADMIN && user.toLowerCase() === ADMIN.user.toLowerCase()) {
      if (await verifyPassword(pw, ADMIN.hash)) {
        who = 'admin';
        ver = ADMIN.ver;
      }
    } else {
      const entry = Object.entries(CREDS).find(([, c]) => c.login.toLowerCase() === user.toLowerCase());
      if (entry) {
        if (await verifyPassword(pw, entry[1].hash)) {
          who = entry[0];
          ver = entry[1].ver;
        }
      } else {
        await verifyPassword(pw, DUMMY_HASH);
      }
    }

    if (!who) {
      addAttempt(key);
      addAttempt(clientIp(req) + '|*');
      return fail(res, 401, 'Login yoki parol noto‘g‘ri');
    }
    setSessionCookie(req, res, who, ver, !!b.remember);
    return send(res, 200, { ok: true, role: who === 'admin' ? 'admin' : 'teacher', id: who });
  }

  if (route === 'POST /api/auth/logout') {
    clearSessionCookie(req, res);
    return send(res, 200, { ok: true });
  }

  /* ---- bundan keyingilari faqat kirgan foydalanuvchilar uchun ---- */
  const sess = sessionOf(req);
  if (!sess) return fail(res, 401, 'Kirish talab qilinadi');

  if (route === 'GET /api/session') {
    return send(res, 200, {
      role: sess.role,
      id: sess.id,
      adminUser: sess.role === 'admin' ? ADMIN.user : undefined
    });
  }

  if (route === 'POST /api/auth/password') {
    if (sess.role !== 'admin') return fail(res, 403, 'Faqat administrator');
    const b = await readBody(req);
    if (!(await verifyPassword(String(b.old || ''), ADMIN.hash))) return fail(res, 400, 'Joriy parol noto‘g‘ri');
    const nw = String(b.new || '');
    if (nw.length < 4) return fail(res, 400, 'Yangi parol kamida 4 belgidan iborat bo‘lsin');
    ADMIN.hash = await hashPassword(nw);
    ADMIN.ver++;
    await persistAdmin();
    setSessionCookie(req, res, 'admin', ADMIN.ver, true);
    return send(res, 200, { ok: true });
  }

  /* ---- ma'lumot ---- */
  if (route === 'GET /api/data') {
    const since = Number(url.searchParams.get('rev'));
    if (since && since === DOC.rev) return send(res, 200, { rev: DOC.rev, unchanged: true });
    return send(res, 200, { rev: DOC.rev, fresh: DOC.rev === 0, data: viewFor(sess) });
  }

  if (route === 'POST /api/data') {
    const b = await readBody(req);
    const result = await serial(async () => {
      const draft = clone(DOC.data);
      applyOps(draft, b.ops, sess);
      const prevDoc = DOC.data;
      const prevCreds = clone(CREDS);
      DOC.data = draft;
      let credsChanged = false;
      try {
        if (b.ops.some(o => o.p[0] === 'teachers')) credsChanged = syncCreds();
      } catch (e) {
        DOC.data = prevDoc;
        CREDS = prevCreds;
        throw e;
      }
      const prev = DOC.rev;
      DOC.rev = prev + 1;
      await store.set('doc', DOC);
      if (credsChanged) await store.set('creds', CREDS);
      return { rev: DOC.rev, prev };
    });
    dailyBackup();
    return send(res, 200, result);
  }

  /* ---- o'qituvchi login/paroli (faqat admin) ---- */
  if (route === 'POST /api/credentials') {
    if (sess.role !== 'admin') return fail(res, 403, 'Faqat administrator');
    const b = await readBody(req);
    const id = String(b.teacherId || '');
    const login = String(b.login || '').trim();
    const pw = String(b.password || '');
    if (!id || BAD_KEYS.has(id)) return fail(res, 400, 'O‘qituvchi aniqlanmadi');
    if (!login || login.length > 60) return fail(res, 400, 'Login kiriting');
    if (login.toLowerCase() === ADMIN.user.toLowerCase()) {
      return fail(res, 409, 'Bu login administratorga tegishli. Boshqa login tanlang');
    }
    if (Object.entries(CREDS).some(([o, c]) => o !== id && c.login.toLowerCase() === login.toLowerCase())) {
      return fail(res, 409, 'Bu login boshqa o‘qituvchida bor');
    }
    const cur = CREDS[id];
    if (!cur && pw.length < 4) return fail(res, 400, 'Parol kamida 4 belgidan iborat bo‘lsin');
    if (pw && pw.length < 4) return fail(res, 400, 'Parol kamida 4 belgidan iborat bo‘lsin');
    const hash = pw ? await hashPassword(pw) : cur.hash;
    CREDS[id] = { login, hash, ver: (cur ? cur.ver : 0) + 1, t: Date.now() };
    await persistCreds();
    return send(res, 200, { ok: true });
  }

  /* ---- zaxiralar (faqat admin) ---- */
  if (route === 'GET /api/backups') {
    if (sess.role !== 'admin') return fail(res, 403, 'Faqat administrator');
    const keys = await store.keys('backup:');
    return send(res, 200, { dates: keys.map(k => k.slice(7)) });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/backups/')) {
    if (sess.role !== 'admin') return fail(res, 403, 'Faqat administrator');
    const date = url.pathname.slice('/api/backups/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'Sana noto‘g‘ri');
    const b = await store.get('backup:' + date);
    if (!b) return fail(res, 404, 'Topilmadi');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="deutsch-school-' + date + '.json"',
      'Cache-Control': 'no-store'
    });
    return res.end(JSON.stringify(b.data, null, 1));
  }

  return fail(res, 404, 'Topilmadi');
}

/* ---------------- statik fayllar ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};
const cache = new Map();

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== PUBLIC_DIR) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  let st;
  try {
    st = fs.statSync(full);
    if (st.isDirectory()) throw new Error('dir');
  } catch (e) {
    // SPA: noma'lum yo'llar asosiy sahifaga
    if (!path.extname(rel)) return serveStatic(req, res, new URL('/', 'http://x'));
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Topilmadi');
  }
  const ext = path.extname(full).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const key = full + ':' + st.mtimeMs;
  let ent = cache.get(key);
  if (!ent) {
    const raw = fs.readFileSync(full);
    const compressible = /^(text|application\/(json|javascript)|image\/svg)/.test(type);
    ent = {
      raw,
      gz: compressible ? zlib.gzipSync(raw, { level: 9 }) : null,
      etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"'
    };
    cache.clear();
    cache.set(key, ent);
  }
  const headers = {
    'Content-Type': type,
    ETag: ent.etag,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    Vary: 'Accept-Encoding'
  };
  if (req.headers['if-none-match'] === ent.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const useGz = ent.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (useGz) headers['Content-Encoding'] = 'gzip';
  const body = useGz ? ent.gz : ent.raw;
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  try {
    securityHeaders(req, res);
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return serveStatic(req, res, url);
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) log('XATO:', e && e.stack ? e.stack : e);
    if (!res.headersSent) fail(res, code, code === 500 ? 'Server xatosi' : e.message);
    else res.end();
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

async function init() {
  store = await createStore();
  log('Saqlash turi:', store.kind);

  const d = await store.get('doc');
  if (d && isObj(d.data)) DOC = d;
  ADMIN = await store.get('admin');
  CREDS = (await store.get('creds')) || {};
  META = (await store.get('meta')) || { secret: '' };

  if (!META.secret) {
    META.secret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
    await store.set('meta', META);
  }
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET !== META.secret) {
    META.secret = process.env.SESSION_SECRET;
    await store.set('meta', META);
  }

  const envUser = (process.env.ADMIN_USER || '').trim();
  const envPass = process.env.ADMIN_PASSWORD || '';
  if (!ADMIN && envPass) {
    ADMIN = { user: envUser || 'admin', hash: await hashPassword(envPass), ver: 1 };
    await store.set('admin', ADMIN);
    log('Administrator yaratildi:', ADMIN.user);
  } else if (ADMIN && process.env.RESET_ADMIN === '1' && envPass) {
    ADMIN = { user: envUser || ADMIN.user, hash: await hashPassword(envPass), ver: (ADMIN.ver || 1) + 1 };
    await store.set('admin', ADMIN);
    log('Administrator paroli tiklandi:', ADMIN.user, '(RESET_ADMIN ni o‘chirib qo‘ying!)');
  } else if (!ADMIN) {
    log('DIQQAT: administrator yo‘q. Saytni birinchi ochgan odam hisob yaratadi. ADMIN_USER va ADMIN_PASSWORD o‘rnating.');
  }

  await new Promise(r => server.listen(PORT, '0.0.0.0', r));
  log('Deutsch School ishga tushdi: http://localhost:' + PORT);
}

async function shutdown(sig) {
  log(sig, 'qabul qilindi, to‘xtatilmoqda...');
  server.close();
  try {
    await chain;
    await store.close();
  } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => log('unhandledRejection:', e && e.stack ? e.stack : e));

if (require.main === module) {
  init().catch(e => {
    console.error('Ishga tushmadi:', e);
    process.exit(1);
  });
}

module.exports = { init, server };
