'use strict';
/* Sinov: node test/smoke.js  (server o'zi vaqtincha papkada ishga tushadi) */
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
process.env.PORT = '3911';
process.env.ADMIN_USER = 'boss';
process.env.ADMIN_PASSWORD = 'secret123';
delete process.env.DATABASE_URL;
const { init, server } = require('../server.js');

const base = 'http://localhost:3911';
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log('XATO:', m); } };

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, body) {
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie, Origin: base },
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  }
}

(async () => {
  await init();
  const admin = new Client(), t = new Client(), anon = new Client();

  let r = await anon.call('GET', '/api/data'); ok(r.s === 401, 'kirishsiz data');
  r = await anon.call('POST', '/api/auth/login', { user: 'boss', password: 'xato' }); ok(r.s === 401, 'noto‘g‘ri parol');
  r = await admin.call('POST', '/api/auth/login', { user: 'BOSS', password: 'secret123', remember: true }); ok(r.s === 200, 'admin login');
  r = await admin.call('GET', '/api/session'); ok(r.j.role === 'admin' && r.j.adminUser === 'boss', 'session');
  r = await admin.call('GET', '/api/data'); ok(r.j.fresh === true, 'fresh');

  // admin ma'lumot yozadi
  const ops = [
    { p: ['groups'], v: [{ id: 'g1', name: '5-A' }] },
    { p: ['subjects'], v: [{ id: 's1', name: 'Deutsch' }] },
    { p: ['teachers'], v: [{ id: 't1', name: 'Anna', login: 'anna', pwHash: 'x' }] },
    { p: ['timetable'], v: [{ groupId: 'g1', subjectId: 's1', teacherId: 't1', day: 'MO', periodId: 'p1' }] },
    { p: ['payments', '2026-10', 'st1'], v: { paid: 5 } }
  ];
  r = await admin.call('POST', '/api/data', { ops }); ok(r.s === 200 && r.j.rev === 1, 'admin yozdi');

  // login yaratish
  r = await admin.call('POST', '/api/credentials', { teacherId: 't1', login: 'anna', password: 'ab' }); ok(r.s === 400, 'qisqa parol');
  r = await admin.call('POST', '/api/credentials', { teacherId: 't1', login: 'boss', password: 'abcd' }); ok(r.s === 409, 'admin logini band');
  r = await admin.call('POST', '/api/credentials', { teacherId: 't1', login: 'anna', password: 'abcd' }); ok(r.s === 200, 'login yaratildi');

  // o'qituvchi kirishi
  r = await t.call('POST', '/api/auth/login', { user: 'anna', password: 'abcd' }); ok(r.s === 200 && r.j.role === 'teacher', 'o‘qituvchi login');
  r = await t.call('GET', '/api/data'); ok(r.j.data.payments === undefined, 'to‘lovlar yashirin');
  ok(r.j.data.teachers[0].pwHash === 'set' && !JSON.stringify(r.j).includes('scrypt'), 'xesh sizmaydi');

  // ruxsatlar
  r = await t.call('POST', '/api/data', { ops: [{ p: ['weekly', 'g1|s1|2026-10-05', 'st1'], v: { total: 10, correct: 8 } }] }); ok(r.s === 200, 'o‘z sinfiga yozdi');
  r = await t.call('POST', '/api/data', { ops: [{ p: ['weekly', 'g2|s1|2026-10-05', 'st1'], v: { total: 1 } }] }); ok(r.s === 403, 'boshqa sinf taqiqlangan');
  r = await t.call('POST', '/api/data', { ops: [{ p: ['payments', 'x'], v: 1 }] }); ok(r.s === 403, 'to‘lov taqiqlangan');
  r = await t.call('POST', '/api/data', { ops: [{ p: ['students'], v: [] }] }); ok(r.s === 403, 'o‘quvchilar taqiqlangan');
  r = await t.call('POST', '/api/credentials', { teacherId: 't1', login: 'z', password: 'abcd' }); ok(r.s === 403, 'o‘qituvchi login o‘zgartira olmaydi');
  r = await admin.call('POST', '/api/data', { ops: [{ p: ['__proto__', 'x'], v: 1 }] }); ok(r.s === 400, 'proto himoya');

  // admin o'qituvchi yozganini ko'radi
  r = await admin.call('GET', '/api/data'); ok(r.j.data.weekly['g1|s1|2026-10-05'].st1.correct === 8, 'admin natijani ko‘radi');
  ok(r.j.data.payments['2026-10'].st1.paid === 5, 'to‘lov saqlangan');
  r = await admin.call('GET', '/api/data?rev=' + r.j.rev); ok(r.j.unchanged === true, 'unchanged');

  // o'chirish (delete op)
  r = await admin.call('POST', '/api/data', { ops: [{ p: ['weekly', 'g1|s1|2026-10-05', 'st1'], d: 1 }] }); ok(r.s === 200, 'delete op');

  // o'qituvchini ro'yxatdan olib tashlash — login ham o'chadi (2 daqiqa kutmasdan: t sini eskirtiramiz)
  r = await admin.call('POST', '/api/auth/password', { old: 'secret123', new: 'newpass1' }); ok(r.s === 200, 'parol almashdi');
  r = await admin.call('GET', '/api/session'); ok(r.s === 200, 'yangi cookie bilan davom');
  const old = new Client(); r = await old.call('POST', '/api/auth/login', { user: 'boss', password: 'secret123' }); ok(r.s === 401, 'eski parol ishlamaydi');

  // logout
  r = await t.call('POST', '/api/auth/logout'); t.cookie = 'ds_sid='; r = await t.call('GET', '/api/data'); ok(r.s === 401, 'logoutdan keyin');

  // CSRF: begona origin
  const rr = await fetch(base + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, Origin: 'https://evil.example' }, body: '{"ops":[]}' });
  ok(rr.status === 403, 'begona origin rad etildi');

  // statik
  const h = await fetch(base + '/', { headers: { 'Accept-Encoding': 'gzip' } });
  ok(h.status === 200 && h.headers.get('content-encoding') === 'gzip' && h.headers.get('content-security-policy'), 'sahifa + gzip + CSP');
  const hh = await fetch(base + '/api/health'); ok((await hh.text()) === 'ok', 'health');
  const tr = await fetch(base + '/..%2f..%2fetc/passwd'); ok(tr.status !== 200 || !(await tr.text()).includes('root:'), 'path traversal');

  // qayta ishga tushganda ma'lumot saqlanganmi
  console.log(`\n${pass} ta o‘tdi, ${failN} ta xato`);
  server.close();
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
