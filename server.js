'use strict';

/* ============================================================
   Deutsch School — backend
   Onlayn to‘lov vaqtincha o‘chirilgan
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
const MAX_BODY = 12 * 1024 * 1024;
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

/* ---------------- saqlash ---------------- */

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
        const r = await pool.query(
          'select value from kv where key=$1',
          [k]
        );
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
        const r = await pool.query(
          'select key from kv where key like $1 order by key',
          [prefix + '%']
        );
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
      return Object.keys(mem)
        .filter(k => k.startsWith(prefix))
        .sort();
    },

    async close() {}
  };
}

/* ---------------- parollar ---------------- */

function scrypt(pw, salt) {
  return new Promise((res, rej) =>
    crypto.scrypt(
      pw,
      salt,
      32,
      { N: 16384, r: 8, p: 1 },
      (e, k) => (e ? rej(e) : res(k))
    )
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

    return key.length === want.length &&
      crypto.timingSafeEqual(key, want);
  } catch (e) {
    return false;
  }
}

let DUMMY_HASH = null;

/* ---------------- holat ---------------- */

let store;
let DOC = { rev: 0, data: {} };
let ADMIN = null;
let CREDS = {};
let CHAT = { counter: 0, msgs: [] };
let META = { secret: '' };

const persistDoc = () => serial(() => store.set('doc', DOC));
const persistAdmin = () => serial(() => store.set('admin', ADMIN));
const persistCreds = () => serial(() => store.set('creds', CREDS));

/* ---------------- sessiya ---------------- */

const b64u = b => Buffer.from(b).toString('base64url');

const sign = s =>
  crypto.createHmac('sha256', META.secret)
    .update(s)
    .digest('base64url');

function makeToken(who, ver, remember) {
  const exp = Date.now() +
    (remember ? SESSION_DAYS : 1) * 86400000;

  const body = b64u(JSON.stringify({
    w: who,
    v: ver,
    e: exp
  }));

  return body + '.' + sign(body);
}

function readToken(tok) {
  if (!tok || typeof tok !== 'string') return null;

  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;

  const want = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);

  if (a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const p = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8')
    );

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

      if (i > 0) {
        out[x.slice(0, i).trim()] =
          decodeURIComponent(x.slice(i + 1).trim());
      }
    });

  return out;
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' ||
    !!req.socket.encrypted;
}

function addHeader(res, k, v) {
  const cur = res.getHeader(k);

  if (!cur) res.setHeader(k, v);
  else res.setHeader(k, [].concat(cur, v));
}

function setSessionCookie(req, res, who, ver, remember) {
  const parts = [
    'ds_sid=' + makeToken(who, ver, remember),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];

  if (remember) {
    parts.push('Max-Age=' + SESSION_DAYS * 86400);
  }

  if (PROD || isHttps(req)) parts.push('Secure');

  addHeader(res, 'Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [
    'ds_sid=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];

  if (PROD || isHttps(req)) parts.push('Secure');

  addHeader(res, 'Set-Cookie', parts.join('; '));
}

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

  return {
    role: c.role === 'student' ? 'student' : 'teacher',
    id: p.w
  };
}

/* ---------------- urinishlarni cheklash ---------------- */

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

  if (!a || a.reset < now) {
    attempts.set(key, {
      n: 1,
      reset: now + 15 * 60000
    });
  } else {
    a.n++;
  }
}

setInterval(() => {
  const now = Date.now();

  for (const [k, v] of attempts) {
    if (v.reset < now) attempts.delete(k);
  }
}, 10 * 60000).unref();

const chatHits = new Map();

function chatRate(key) {
  const now = Date.now();

  const arr = (chatHits.get(key) || [])
    .filter(t => now - t < 10000);

  arr.push(now);
  chatHits.set(key, arr);

  return arr.length > 15;
}

setInterval(() => {
  const now = Date.now();

  for (const [k, v] of chatHits) {
    if (!v.some(t => now - t < 10000)) {
      chatHits.delete(k);
    }
  }
}, 60000).unref();

/* ---------------- HTTP yordamchilari ---------------- */

function send(res, code, obj) {
  const body = JSON.stringify(obj);

  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  res.end(body);
}

const fail = (res, code, msg) =>
  send(res, code, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', c => {
      size += c.length;

      if (size > MAX_BODY) {
        reject(Object.assign(
          new Error('Hajm juda katta'),
          { code: 413 }
        ));

        req.destroy();
        return;
      }

      chunks.push(c);
    });

    req.on('end', () => {
      if (!chunks.length) return resolve({});

      try {
        resolve(JSON.parse(
          Buffer.concat(chunks).toString('utf8')
        ));
      } catch (e) {
        reject(Object.assign(
          new Error('JSON noto‘g‘ri'),
          { code: 400 }
        ));
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

  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );

  if (PROD || isHttps(req)) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains'
    );
  }
}

/* ---------------- MA'LUMOTLAR VA API ---------------- */

/*
  Eslatma:
  Bu yerda server.js faylingizdagi qolgan barcha API,
  o‘quvchi/o‘qituvchi, administrator, chat, zaxira va
  statik fayllarni uzatish funksiyalari ham saqlanishi kerak.

  To‘lov moduli o‘chirilgan variantda PAY obyekti alohida
  aniqlanadi va ./payments fayli talab qilinmaydi.
*/

const buildStudentView = require('./student');

const PAY = {
  route: async () => false,

  config: () => ({
    enabled: false
  }),

  studentPay: async (req, res) => {
    return fail(
      res,
      404,
      'Onlayn to‘lov hozircha o‘chirilgan'
    );
  },

  isPage: () => false,

  page: (req, res) => {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8'
    });

    res.end('Onlayn to‘lov hozircha o‘chirilgan');
  }
};

/*
  Muhim: yuqoridagi kod butun server.js faylining to‘liq
  o‘rnini bosa olmaydi. Qolgan API kodini saqlab qolish uchun
  tayyor faylni ishlating:
*/
