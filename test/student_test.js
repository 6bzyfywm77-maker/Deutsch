'use strict';
/* Sinov: node test/student.js — o'quvchi roli, maxfiylik, ota-ona akkaunti va alohida chat, parolni tasdiqlash */
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-'));
process.env.PORT = '3913';
process.env.ADMIN_USER = 'boss';
process.env.ADMIN_PASSWORD = 'secret123';
delete process.env.DATABASE_URL;
delete process.env.PUBLIC_URL;
const { init, server } = require('../server.js');

const base = 'http://localhost:3913';
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log('XATO:', m); } };

class Client {
  async call(method, url, body, headers) {
    const isBuf = Buffer.isBuffer(body);
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie || '', Origin: base, ...(headers || {}) },
      body: body ? (isBuf ? body : JSON.stringify(body)) : undefined
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  }
  async raw(method, url, headers) {
    const r = await fetch(base + url, { method, headers: { Cookie: this.cookie || '', Origin: base, ...(headers || {}) } });
    const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
    return { s: r.status, h, b: Buffer.from(await r.arrayBuffer()) };
  }
}
(async () => {
  await init();
  const admin = new Client(), teacher = new Client(), stu = new Client(), stu2 = new Client(), par = new Client(), par2 = new Client(), anon = new Client();
  let r = await admin.call('POST', '/api/auth/login', { user: 'boss', password: 'secret123' }); ok(r.s === 200, 'admin kirdi');

  const MK = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7);
  r = await admin.call('POST', '/api/data', { ops: [
    { p: ['subjects'], v: [{ id: 'sub0', name: 'Nemis tili', color: '#2F6BFF' }, { id: 'sub1', name: 'Matematika', color: '#E8A317' }] },
    { p: ['teachers'], v: [{ id: 't1', name: 'Anna Ivanova', login: 'anna' }] },
    { p: ['groups'], v: [{ id: 'g1', name: '10-A' }, { id: 'g2', name: '10-B' }] },
    { p: ['periods'], v: [{ id: 'p1', n: 1, start: '09:00', end: '09:45' }] },
    { p: ['students'], v: [
      { id: 'sa', first: 'Ali', last: 'Valiyev', groupId: 'g1', joined: '2026-01-10', fee: 300000, login: 'ali' },
      { id: 'sb', first: 'Vali', last: 'Karimov', groupId: 'g1', joined: '2026-01-10', fee: 400000 },
      { id: 'sc', first: 'Gulnora', last: 'Sodiqova', groupId: 'g2', joined: '2026-01-10', fee: 500000 }
    ] },
    { p: ['timetable'], v: [{ id: 'x1', groupId: 'g1', day: 'MO', periodId: 'p1', subjectId: 'sub0', teacherId: 't1' }, { id: 'x2', groupId: 'g2', day: 'TU', periodId: 'p1', subjectId: 'sub0', teacherId: 't1' }, { id: 'x3', groupId: 'g1', day: 'WE', periodId: 'p1', subjectId: 'sub1', teacherId: 't1' }] },
    { p: ['weekly'], v: { 'g1|sub0|2026-10-05': { sa: { total: 20, correct: 15 }, sb: { total: 20, correct: 5 } }, 'g2|sub0|2026-10-05': { sc: { total: 10, correct: 9 } } } },
    { p: ['grades'], v: { 'g1|Nemis tili|2026-10-06': { sa: 5, sb: 2 }, 'g1|Matem|2026-10-07': { sa: 4 } } },
    { p: ['attendance'], v: { 'g1|2026-10-06|Nemis tili': { sa: 'ok', sb: 'dq' } } },
    { p: ['satRes'], v: { 'g1|Nemis tili|2026-10-10': { total: 50, r: { sa: 40, sb: 10 } } } }
  ] }); ok(r.s === 200, 'ma‘lumot yozildi');
  await admin.call('POST', '/api/credentials', { teacherId: 't1', login: 'anna', password: 'abcd' });

  // ---- login yaratish ----
  r = await admin.call('POST', '/api/credentials', { studentId: 'sa', login: 'ali', password: 'abcd' }); ok(r.s === 200, 'o‘quvchi logini yaratildi');
  r = await admin.call('POST', '/api/credentials', { studentId: 'sb', login: 'ali', password: 'abcd' }); ok(r.s === 409, 'takroriy login rad');
  r = await admin.call('POST', '/api/credentials', { studentId: 'sb', login: 'anna', password: 'abcd' }); ok(r.s === 409, 'o‘qituvchi logini bilan to‘qnashuv rad');
  r = await admin.call('POST', '/api/credentials', { studentId: 'sb', login: 'BOSS', password: 'abcd' }); ok(r.s === 409, 'admin logini bilan to‘qnashuv rad');
  r = await admin.call('POST', '/api/credentials', { studentId: 'sb', login: 'vali', password: 'ab' }); ok(r.s === 400, 'qisqa parol rad');
  r = await admin.call('POST', '/api/credentials', { studentId: 'sb', login: 'Vali', password: 'abcd' }); ok(r.s === 200, 'ikkinchi o‘quvchi logini');
  r = await admin.call('POST', '/api/credentials', { teacherId: 'sa', login: 'zzz', password: 'abcd' }); ok(r.s === 409, 'o‘quvchi identifikatori o‘qituvchi sifatida band');

  // ---- admin va o'qituvchi ko'rinishi ----
  r = await admin.call('GET', '/api/data');
  const sa = r.j.data.students.find(x => x.id === 'sa');
  ok(sa.login === 'ali' && sa.pwHash === 'set', 'admin o‘quvchi loginini ko‘radi (parol xeshisiz)');
  ok(!JSON.stringify(r.j).includes('$'), 'parol xeshlari chiqmaydi');
  await teacher.call('POST', '/api/auth/login', { user: 'anna', password: 'abcd' });
  r = await teacher.call('GET', '/api/data');
  ok(r.s === 200 && r.j.data.students.every(x => x.login === undefined && x.pwHash === undefined), 'o‘qituvchi o‘quvchi loginlarini ko‘rmaydi');

  // ---- o'quvchi kirishi ----
  r = await stu.call('POST', '/api/auth/login', { user: 'ali', password: 'xato' }); ok(r.s === 401, 'noto‘g‘ri parol');
  r = await stu.call('POST', '/api/auth/login', { user: 'ALI', password: 'abcd' }); ok(r.s === 200 && r.j.role === 'student' && r.j.id === 'sa', 'o‘quvchi kirdi (login katta-kichik harfga befarq)');
  r = await stu.call('GET', '/api/session'); ok(r.j.role === 'student', 'sessiya roli');

  // ---- ruxsatlar ----
  r = await stu.call('GET', '/api/data'); ok(r.s === 403, 'o‘quvchi /api/data ni o‘qiy olmaydi');
  r = await stu.call('POST', '/api/data', { ops: [{ p: ['students'], v: [] }] }); ok(r.s === 403, 'o‘quvchi yoza olmaydi');
  r = await stu.call('POST', '/api/credentials', { studentId: 'sa', login: 'ali', password: 'newpass' }); ok(r.s === 403, 'o‘quvchi parol o‘zgartira olmaydi');
  r = await stu.call('GET', '/api/chat'); ok(r.s === 403, 'o‘quvchi chatni ko‘ra olmaydi');
  r = await stu.call('POST', '/api/chat', { text: 'salom' }); ok(r.s === 403, 'o‘quvchi chatga yoza olmaydi');
  r = await stu.call('GET', '/api/backups'); ok(r.s === 403, 'o‘quvchi zaxiraga kira olmaydi');
  r = await stu.call('POST', '/api/auth/verify', { password: 'secret123' }); ok(r.s === 403, 'o‘quvchi verify qila olmaydi');
  r = await anon.call('GET', '/api/me'); ok(r.s === 401, 'kirishsiz /api/me yopiq');
  r = await teacher.call('GET', '/api/me'); ok(r.s === 403, 'o‘qituvchi /api/me ga kira olmaydi');

  // ---- /api/me: faqat o'zining ma'lumoti ----
  r = await stu.call('GET', '/api/me');
  const me = r.j;
  ok(r.s === 200 && me.first === 'Ali' && me.last === 'Valiyev' && me.group === '10-A' && me.fee === 300000, 'o‘z ma‘lumoti');
  const raw = JSON.stringify(me);
  ok(!/Vali\b|Karimov|Gulnora|Sodiqova|anna|\$|10-B/.test(raw.replace(/Valiyev/g, '')), 'boshqalarning ma‘lumoti yo‘q');
  ok(me.weekly.length === 1 && me.weekly[0].correct === 15 && me.weekly[0].total === 20 && me.weekly[0].subject === 'Nemis tili', 'haftalik natija (faqat o‘ziniki)');
  ok(me.grades.length === 2 && me.grades.find(g => g.subject === 'Nemis tili').grade === 5 && me.grades.find(g => g.subject === 'Matem').grade === 4, 'baholar (kanonik fan kaliti bilan)');
  ok(me.attendance.length === 1 && me.attendance[0].code === 'ok', 'davomat');
  ok(me.sat.length === 1 && me.sat[0].correct === 40, 'shanba testi');
  ok(me.schedule.cells.length === 2 && me.schedule.cells.find(c => c.day === 'MO').teacher === 'Anna Ivanova' && me.schedule.periods.length === 1, 'dars jadvali (faqat o‘z sinfi)');
  ok(me.subjects.length === 2 && me.subjects[0].key === 'Matem' && me.subjects[0].name === 'Matematika' && me.subjects[0].days.join() === 'WE' && me.subjects[1].key === 'Nemis tili', 'baholar jadvali uchun fanlar (Matematika = Matem)');
  ok(me.labels.Matem === 'Matematika', 'fan yorliqlari');
  ok(!('timetable' in me), 'eski timetable maydoni yo‘q');
  ok(me.payments.length >= 10 && me.payments[0].mk === MK && me.payments[0].paid === false && me.debt === me.payments.length * 300000, 'to‘lovlar va qarz');

  r = await stu.call('GET', '/api/pchat'); ok(r.s === 403, 'o‘quvchi ota-onalar chatiga kira olmaydi');
  r = await stu.call('POST', '/api/me/pay', { mk: MK }); ok(r.s === 403, 'onlayn to‘lov endi yo‘q');
  ok(!('pay' in me), 'to‘lov tizimlari maydoni yo‘q');

  // ---- admin login/parolni o'zgartirsa eski sessiya yaroqsiz ----
  r = await admin.call('POST', '/api/credentials', { studentId: 'sa', login: 'ali', password: 'yangi1' }); ok(r.s === 200, 'parol yangilandi');
  r = await stu.call('GET', '/api/me'); ok(r.s === 401, 'eski sessiya tugadi');
  r = await stu.call('POST', '/api/auth/login', { user: 'ali', password: 'abcd' }); ok(r.s === 401, 'eski parol ishlamaydi');
  r = await stu.call('POST', '/api/auth/login', { user: 'ali', password: 'yangi1' }); ok(r.s === 200, 'yangi parol ishlaydi');

  // ---- login tozalansa kirish yopiladi ----
  r = await admin.call('GET', '/api/data');
  const studs = r.j.data.students.map(x => (x.id === 'sa' ? { ...x, login: '', pwHash: '' } : x));
  r = await admin.call('POST', '/api/data', { ops: [{ p: ['students'], v: studs }] }); ok(r.s === 200, 'login tozalandi');
  r = await stu.call('GET', '/api/me'); ok(r.s === 401, 'login o‘chirilgach sessiya yopiladi');
  r = await anon.call('POST', '/api/auth/login', { user: 'ali', password: 'yangi1' }); ok(r.s === 401, 'login o‘chirilgach kirib bo‘lmaydi');
  r = await admin.call('GET', '/api/data');
  ok(r.j.data.students.find(x => x.id === 'sb').login === 'Vali', 'boshqa o‘quvchi logini saqlanib qoldi');

  // ---- parolni tasdiqlash ----
  r = await admin.call('POST', '/api/auth/verify', { password: 'xato' }); ok(r.s === 400, 'verify: noto‘g‘ri');
  r = await admin.call('POST', '/api/auth/verify', { password: 'secret123' }); ok(r.s === 200, 'verify: to‘g‘ri');
  r = await teacher.call('POST', '/api/auth/verify', { password: 'secret123' }); ok(r.s === 403, 'verify: o‘qituvchi emas');

  // ---- chat ----
  r = await teacher.call('POST', '/api/chat', { text: '  Salom  ' }); ok(r.s === 200 && r.j.msg.text === 'Salom' && r.j.msg.role === 'teacher' && r.j.msg.name === 'Anna Ivanova' && r.j.msg.uid === 't1', 'o‘qituvchi chatga yozdi');
  const mid = r.j.msg.id;
  r = await teacher.call('POST', '/api/chat', { text: '   ' }); ok(r.s === 400, 'bo‘sh xabar rad');
  r = await admin.call('POST', '/api/chat', { text: 'Salom, Anna' }); ok(r.s === 200 && r.j.msg.uid === 'admin' && r.j.msg.role === 'admin', 'admin yozdi');
  r = await admin.call('GET', '/api/chat?since=0'); ok(r.j.msgs.length === 2 && r.j.last >= 2, 'admin xabarlarni oldi');
  const last = r.j.last;
  r = await teacher.call('GET', '/api/chat?since=' + last); ok(r.j.msgs.length === 0, 'yangi xabar yo‘q');
  r = await teacher.call('POST', '/api/chat/delete', { id: mid }); ok(r.s === 403, 'o‘qituvchi xabar o‘chira olmaydi');
  r = await admin.call('POST', '/api/chat/delete', { id: mid }); ok(r.s === 200, 'admin xabarni o‘chirdi');
  r = await teacher.call('GET', '/api/chat?since=' + last);
  ok(r.j.msgs.length === 1 && r.j.msgs[0].x === true && r.j.msgs[0].text === '' && r.j.msgs[0].seq < last, 'o‘chirilgan xabar o‘z o‘rnida, matnsiz');

  // ---- ota-ona akkaunti ----
  r = await admin.call('POST', '/api/credentials', { parentOf: 'sa', login: 'vali', password: 'abcd' }); ok(r.s === 409, 'ota-ona logini o‘quvchi logini bilan to‘qnashsa rad');
  r = await admin.call('POST', '/api/credentials', { parentOf: 'sb', login: 'ota_vali', password: 'ab' }); ok(r.s === 400, 'ota-ona uchun qisqa parol rad');
  r = await admin.call('POST', '/api/credentials', { parentOf: 'sb', login: 'ota_vali', password: 'abcd' }); ok(r.s === 200, 'ota-ona logini yaratildi');
  r = await admin.call('POST', '/api/credentials', { parentOf: 'sa', login: 'OTA_VALI', password: 'abcd' }); ok(r.s === 409, 'ota-ona logini band');
  r = await admin.call('POST', '/api/credentials', { parentOf: 'sa', login: 'ota_ali', password: 'abcd' }); ok(r.s === 200, 'ikkinchi ota-ona logini');
  r = await admin.call('GET', '/api/data');
  const sbv = r.j.data.students.find(x => x.id === 'sb');
  ok(sbv.pLogin === 'ota_vali' && sbv.pSet === 'set' && !JSON.stringify(r.j).includes('$'), 'admin ota-ona loginini ko‘radi (xeshsiz)');
  r = await teacher.call('GET', '/api/data');
  ok(r.j.data.students.every(x => x.pLogin === undefined && x.pSet === undefined), 'o‘qituvchi ota-ona loginini ko‘rmaydi');

  r = await par.call('POST', '/api/auth/login', { user: 'Ota_Vali', password: 'abcd' }); ok(r.s === 200 && r.j.role === 'parent', 'ota-ona kirdi');
  r = await par2.call('POST', '/api/auth/login', { user: 'ota_ali', password: 'abcd' }); ok(r.s === 200 && r.j.role === 'parent', 'ikkinchi ota-ona kirdi');
  r = await par.call('GET', '/api/me');
  ok(r.s === 200 && r.j.parent === true && r.j.first === 'Vali' && r.j.chat.enabled === true && r.j.chat.unread === 0, 'ota-ona faqat farzandining panelini oladi');
  ok(!/Ali\b|Valiyev|Gulnora|Sodiqova/.test(JSON.stringify(r.j).replace(/Valiyev/g, '')), 'ota-ona boshqa o‘quvchi ma‘lumotini ko‘rmaydi');
  r = await par.call('GET', '/api/data'); ok(r.s === 403, 'ota-ona /api/data ga kira olmaydi');
  r = await par.call('POST', '/api/data', { ops: [{ p: ['students'], v: [] }] }); ok(r.s === 403, 'ota-ona yoza olmaydi');
  r = await par.call('GET', '/api/chat'); ok(r.s === 403, 'ota-ona xodimlar chatini ko‘ra olmaydi');
  r = await par.call('POST', '/api/chat', { text: 'x' }); ok(r.s === 403, 'ota-ona xodimlar chatiga yoza olmaydi');
  r = await par.call('POST', '/api/credentials', { parentOf: 'sb', login: 'ota_vali', password: 'zzzz' }); ok(r.s === 403, 'ota-ona parol o‘zgartira olmaydi');

  // ---- ota-onalar + administrator: bitta umumiy chat ----
  const stuV = new Client(); r = await stuV.call('POST', '/api/auth/login', { user: 'vali', password: 'abcd' }); ok(r.s === 200 && r.j.role === 'student', 'o‘quvchi (Vali) kirdi');
  r = await par.call('POST', '/api/pchat', { text: '   ' }); ok(r.s === 400, 'bo‘sh xabar rad');
  r = await par.call('POST', '/api/pchat', { text: '  Assalomu alaykum  ' }); ok(r.s === 200 && r.j.msg.text === 'Assalomu alaykum' && r.j.msg.role === 'parent' && r.j.msg.me === true, 'ota-ona yozdi');
  const pm1 = r.j.msg.id;
  r = await par2.call('POST', '/api/pchat', { text: 'Salom, savolim bor' }); ok(r.s === 200, 'ikkinchi ota-ona yozdi');
  r = await par.call('GET', '/api/pchat?since=0&peek=1');
  ok(r.j.msgs.length === 2 && r.j.msgs[0].me === true && r.j.msgs[1].me === false && !JSON.stringify(r.j).includes('p:'), 'umumiy chat: ikkala ota-ona ham hamma xabarni ko‘radi (ichki id oshkor emas)');
  r = await par2.call('GET', '/api/pchat?since=0&peek=1'); ok(r.j.msgs.length === 2 && r.j.unread === 0, 'yozgan ota-ona shu paytgacha hammasini ko‘rgan hisoblanadi');
  r = await teacher.call('GET', '/api/pchat'); ok(r.s === 403, 'o‘qituvchi ota-onalar chatiga kira olmaydi');
  r = await teacher.call('POST', '/api/pchat', { text: 'x' }); ok(r.s === 403, 'o‘qituvchi yoza olmaydi');
  r = await stuV.call('GET', '/api/pchat'); ok(r.s === 403, 'o‘quvchi chatga kira olmaydi');
  r = await admin.call('GET', '/api/pchat/unread'); ok(r.j.unread === 2 && r.j.enabled === true, 'admin: 2 ta o‘qilmagan');
  r = await admin.call('GET', '/api/pchat?since=0'); ok(r.j.msgs.length === 2 && r.j.msgs.every(m => m.me === false), 'admin barcha xabarni ko‘rdi');
  r = await admin.call('GET', '/api/pchat/unread'); ok(r.j.unread === 0, 'ochilgach o‘qilgan');
  r = await admin.call('POST', '/api/pchat', { text: 'Hammaga salom' }); ok(r.s === 200 && r.j.msg.role === 'admin' && r.j.msg.name === 'Administrator', 'admin hammaga yozdi');
  r = await par.call('GET', '/api/me'); ok(r.j.chat.unread === 2 && r.j.chat.enabled === true, 'ota-onaga o‘qilmagan soni (ikkinchi ota-ona + admin)');
  r = await par.call('GET', '/api/pchat?since=0'); r = await par.call('GET', '/api/me'); ok(r.j.chat.unread === 0, 'ochilgach o‘qilgan');
  r = await par2.call('GET', '/api/pchat?since=2'); ok(r.j.msgs.length === 1 && r.j.msgs[0].role === 'admin', 'since bo‘yicha faqat yangilari');
  // to'xtatish
  r = await par.call('POST', '/api/pchat/lock', { locked: true }); ok(r.s === 403, 'ota-ona chatni to‘xtata olmaydi');
  r = await admin.call('POST', '/api/pchat/lock', { locked: true }); ok(r.s === 200 && r.j.enabled === false, 'admin chatni to‘xtatdi');
  r = await par.call('POST', '/api/pchat', { text: 'x' }); ok(r.s === 403, 'to‘xtatilganda ota-ona yoza olmaydi');
  r = await par2.call('POST', '/api/pchat', { text: 'x' }); ok(r.s === 403, 'to‘xtatilganda hech bir ota-ona yoza olmaydi');
  r = await par.call('GET', '/api/pchat?since=0&peek=1'); ok(r.j.msgs.length === 3 && r.j.enabled === false, 'to‘xtatilganda ham o‘qiy oladi');
  r = await par.call('GET', '/api/me'); ok(r.j.chat.enabled === false, 'panelda chat to‘xtatilgani ko‘rinadi');
  r = await admin.call('POST', '/api/pchat', { text: 'Admin yozishda davom etadi' }); ok(r.s === 200, 'admin to‘xtatilganda ham yoza oladi');
  r = await admin.call('POST', '/api/pchat/lock', { locked: false }); r = await par.call('POST', '/api/pchat', { text: 'rahmat' }); ok(r.s === 200, 'yoqilgach yozish tiklandi');
  // o'chirish
  r = await par.call('POST', '/api/pchat/delete', { id: pm1 }); ok(r.s === 403, 'ota-ona xabar o‘chira olmaydi');
  r = await admin.call('POST', '/api/pchat/delete', { id: pm1 }); ok(r.s === 200, 'admin xabarni o‘chirdi');
  r = await par2.call('GET', '/api/pchat?since=0&peek=1'); const gone = r.j.msgs.find(m => m.id === pm1); ok(gone.x === true && gone.text === '', 'o‘chirilgan xabar matnsiz');

  // ---- yangiliklar ----
  const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  r = await par.call('GET', '/api/news'); ok(r.s === 200 && r.j.items.length === 0 && r.j.unread === 0, 'ota-ona yangiliklar ro‘yxatini ochadi');
  r = await teacher.call('GET', '/api/news'); ok(r.s === 403, 'o‘qituvchi yangiliklarni ko‘rmaydi');
  r = await par.call('POST', '/api/news', { text: 'x' }); ok(r.s === 403, 'ota-ona yangilik yoza olmaydi');
  r = await stuV.call('POST', '/api/news', { text: 'x' }); ok(r.s === 403, 'o‘quvchi yangilik yoza olmaydi');
  r = await par.call('POST', '/api/news/media', tiny, { 'Content-Type': 'image/png' }); ok(r.s === 403, 'ota-ona fayl yuklay olmaydi');
  r = await admin.call('POST', '/api/news/media', tiny, { 'Content-Type': 'text/html' }); ok(r.s === 415, 'HTML fayl rad');
  r = await admin.call('POST', '/api/news/media', tiny, { 'Content-Type': 'image/svg+xml' }); ok(r.s === 415, 'SVG rad');
  r = await admin.call('POST', '/api/news/media', Buffer.alloc(9 * 1024 * 1024, 1), { 'Content-Type': 'image/png' }); ok(r.s === 413, 'katta rasm rad');
  r = await admin.call('POST', '/api/news/media', tiny, { 'Content-Type': 'image/png' }); ok(r.s === 200 && r.j.kind === 'image' && r.j.size === tiny.length, 'rasm yuklandi');
  const img = r.j;
  const vid = Buffer.alloc(300000, 7);
  r = await admin.call('POST', '/api/news/media', vid, { 'Content-Type': 'video/mp4' }); ok(r.s === 200 && r.j.kind === 'video', 'video yuklandi');
  const vidMeta = r.j;
  r = await admin.call('POST', '/api/news', { title: '', text: '', media: [] }); ok(r.s === 400, 'bo‘sh yangilik rad');
  r = await admin.call('POST', '/api/news', { text: 'x', media: ['0'.repeat(24)] }); ok(r.s === 400, 'noma‘lum fayl rad');
  r = await admin.call('POST', '/api/news', { title: 'Bayram', text: 'Ertaga dars yo‘q', media: [img.id, vidMeta.id] });
  ok(r.s === 200 && r.j.item.media.length === 2, 'yangilik e‘lon qilindi');
  const nid = r.j.item.id;
  r = await admin.call('POST', '/api/news', { text: 'Ikkinchi', media: [img.id] }); ok(r.s === 400, 'biriktirilgan fayl qayta ishlatilmaydi');
  r = await par.call('GET', '/api/me'); ok(r.j.news.unread === 1, 'ota-onada 1 ta yangi yangilik');
  r = await stuV.call('GET', '/api/me'); ok(r.j.news.unread === 1, 'o‘quvchida ham 1 ta');
  r = await par.call('GET', '/api/news'); ok(r.j.items.length === 1 && r.j.items[0].title === 'Bayram' && r.j.unread === 1, 'ro‘yxat o‘qilganni belgilamaydi');
  r = await par.call('POST', '/api/news/seen', {}); r = await par.call('GET', '/api/me'); ok(r.j.news.unread === 0, 'ko‘rilgach belgilandi');
  r = await stuV.call('GET', '/api/me'); ok(r.j.news.unread === 1, 'boshqa akkauntda alohida hisoblanadi');
  // media xizmati
  let m = await par.raw('GET', img.url); ok(m.s === 200 && m.h['content-type'] === 'image/png' && m.b.equals(tiny) && m.h['x-content-type-options'] === 'nosniff', 'rasm ko‘rsatiladi');
  m = await par.raw('GET', vidMeta.url, { Range: 'bytes=0-99' }); ok(m.s === 206 && m.b.length === 100 && m.h['content-range'] === 'bytes 0-99/300000', 'video Range qo‘llab-quvvatlanadi');
  m = await par.raw('GET', vidMeta.url, { Range: 'bytes=299990-' }); ok(m.s === 206 && m.b.length === 10, 'ochiq oxirli Range');
  m = await par.raw('GET', vidMeta.url, { Range: 'bytes=999999-' }); ok(m.s === 416, 'chegaradan tashqari Range rad');
  m = await teacher.raw('GET', img.url); ok(m.s === 403, 'o‘qituvchi faylni ocha olmaydi');
  m = await (new Client()).raw('GET', img.url); ok(m.s === 401, 'kirmagan odam faylni ocha olmaydi');
  m = await par.raw('GET', '/api/news/media/..%2f..%2fserver.js'); ok(m.s === 404, 'yo‘l chetlab o‘tish rad');
  // o'chirish
  r = await par.call('POST', '/api/news/delete', { id: nid }); ok(r.s === 403, 'ota-ona yangilikni o‘chira olmaydi');
  r = await admin.call('POST', '/api/news/delete', { id: nid }); ok(r.s === 200, 'admin yangilikni o‘chirdi');
  m = await par.raw('GET', img.url); ok(m.s === 404, 'yangilik o‘chgach fayl ham o‘chadi');
  // yuklangan, lekin e'lon qilinmagan fayl
  r = await admin.call('POST', '/api/news/media', tiny, { 'Content-Type': 'image/png' }); const orph = r.j;
  r = await admin.call('POST', '/api/news/media-delete', { id: orph.id }); m = await admin.raw('GET', orph.url); ok(m.s === 404, 'bekor qilingan fayl o‘chadi');

  // ota-ona loginini o'chirish
  r = await admin.call('POST', '/api/credentials', { parentOf: 'sb', remove: true }); ok(r.s === 200, 'ota-ona logini o‘chirildi');
  r = await par.call('GET', '/api/me'); ok(r.s === 401, 'o‘chirilgach ota-ona sessiyasi yopiladi');

  console.log(`\n${pass} ta o‘tdi, ${failN} ta xato`);
  server.close();
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
