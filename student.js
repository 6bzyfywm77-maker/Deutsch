'use strict';
/* ============================================================
   O'quvchi paneli uchun ma'lumot — FAQAT shu o'quvchining o'z ma'lumoti.
   Boshqa o'quvchilar, o'qituvchi loginlari va umumiy to'lovlar bu yerdan chiqmaydi.
   ============================================================ */

const GEN = '__general__';
// Admin baholarni fanning "kanonik" nomi bilan saqlaydi (masalan Matematika -> Matem)
const FIXED_SUBS = ['Matem', 'Algebra', 'Ingliz tili', 'Fizika', 'Nemis tili', 'IT', 'Biologiya', 'Kimyo'];
const canonSub = n => {
  const l = String(n || '').toLowerCase().trim();
  return FIXED_SUBS.find(f => l.startsWith(f.toLowerCase())) || n;
};
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const todayUz = () => new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 48) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

module.exports = function buildStudentView(data, sid, pay) {
  const students = Array.isArray(data.students) ? data.students : [];
  const st = students.find(s => s && s.id === sid);
  if (!st) return null;
  const subs = new Map((data.subjects || []).filter(Boolean).map(s => [s.id, s.name]));
  const teachers = new Map((data.teachers || []).filter(Boolean).map(t => [t.id, t.name]));
  const gid = st.groupId;
  const grp = (data.groups || []).find(g => g && g.id === gid);
  const fee = Math.round(Number(st.fee) || 0);
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const weekly = [];
  for (const [k, rec] of Object.entries(data.weekly || {})) {
    const [g, sb, wk] = k.split('|');
    const r = rec && rec[sid];
    if (g !== gid || !r) continue;
    const total = num(r.total);
    if (total <= 0) continue;
    weekly.push({ week: wk, subject: sb === GEN ? '' : subs.get(sb) || '', total, correct: Math.min(Math.max(num(r.correct), 0), total) });
  }
  weekly.sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0));

  const grades = [];
  for (const [k, rec] of Object.entries(data.grades || {})) {
    const [g, sb, date] = k.split('|');
    if (g !== gid || !rec || typeof rec[sid] !== 'number') continue;
    grades.push({ date, subject: sb, grade: rec[sid] });
  }
  grades.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const attendance = [];
  for (const [k, rec] of Object.entries(data.attendance || {})) {
    const [g, date, sb] = k.split('|');
    const code = rec && rec[sid];
    if (g !== gid || !code) continue;
    attendance.push({ date, subject: sb || '', code: String(code) });
  }
  attendance.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const sat = [];
  for (const [k, rec] of Object.entries(data.satRes || {})) {
    const [g, sb, date] = k.split('|');
    if (g !== gid || !rec || !rec.r || typeof rec.r[sid] !== 'number' || !(num(rec.total) > 0)) continue;
    sat.push({ date, subject: sb, total: num(rec.total), correct: Math.min(rec.r[sid], num(rec.total)) });
  }
  sat.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // dars jadvali (faqat shu sinf) — adminnikiga o'xshash katak ko'rinishi uchun
  const colors = new Map((data.subjects || []).filter(Boolean).map(x => [x.id, x.color || '']));
  const labelByKey = new Map();
  const colorByKey = new Map();
  for (const x of (data.subjects || []).filter(Boolean)) {
    const k = canonSub(x.name);
    if (!labelByKey.has(k)) {
      labelByKey.set(k, x.name);
      colorByKey.set(k, x.color || '');
    }
  }
  const periodsAll = (data.periods || []).filter(Boolean).slice().sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  const lessonPeriods = periodsAll.filter(p => !p.lunch);
  const periodsOut = lessonPeriods.map((p, i) => ({
    id: p.id,
    n: p.n || 0,
    start: p.start || '',
    end: p.end || '',
    lunchSep: i > 0 && lessonPeriods[i - 1].n === 5 && p.n === 6
  }));
  const pids = new Set(lessonPeriods.map(p => p.id));
  const cells = [];
  const gsub = new Map();
  for (const x of data.timetable || []) {
    if (!x || x.groupId !== gid || !x.subjectId || !DAYS.includes(x.day) || !pids.has(x.periodId)) continue;
    const nm = subs.get(x.subjectId);
    if (!nm) continue;
    const key = canonSub(nm);
    cells.push({ day: x.day, pid: x.periodId, subject: nm, color: colors.get(x.subjectId) || '', teacher: teachers.get(x.teacherId) || '' });
    const o = gsub.get(key) || { key, name: labelByKey.get(key) || nm, color: colors.get(x.subjectId) || '', days: new Set() };
    o.days.add(x.day);
    gsub.set(key, o);
  }
  // baholar jadvali uchun fanlar: jadvaldagi fanlar + baho/shanba natijasi bor fanlar
  for (const g of [...grades, ...sat]) {
    if (!gsub.has(g.subject)) gsub.set(g.subject, { key: g.subject, name: labelByKey.get(g.subject) || g.subject, color: colorByKey.get(g.subject) || '', days: new Set() });
  }
  const subjects = [...gsub.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(o => ({ key: o.key, name: o.name, color: o.color, days: [...o.days] }));
  const labels = {};
  for (const [k, v] of labelByKey) labels[k] = v;
  for (const a of attendance) if (a.subject && !labels[a.subject]) labels[a.subject] = a.subject;

  // to'lovlar: qo'shilgan oydan joriy oygacha
  const nowMk = todayUz().slice(0, 7);
  const joinedMk = /^\d{4}-\d{2}/.test(String(st.joined || '')) ? String(st.joined).slice(0, 7) : nowMk;
  const set = new Set(monthsBetween(joinedMk > nowMk ? nowMk : joinedMk, nowMk));
  const pays = data.payments || {};
  for (const mk of Object.keys(pays)) if (pays[mk] && pays[mk][sid] && pays[mk][sid].paid) set.add(mk);
  const payments = [...set]
    .sort()
    .reverse()
    .map(mk => {
      const rec = (pays[mk] && pays[mk][sid]) || {};
      return {
        mk,
        paid: !!rec.paid,
        date: rec.paid ? rec.date || '' : '',
        method: rec.paid ? rec.method || '' : '',
        amount: rec.paid ? num(rec.amount) || fee : fee
      };
    });
  const debt = fee > 0 ? payments.filter(p => !p.paid && p.mk <= nowMk).length * fee : 0;

  return {
    school: (data.settings && data.settings.schoolName) || 'Deutsch School',
    first: st.first || '',
    last: st.last || '',
    group: grp ? grp.name : '',
    fee,
    debt,
    thisMonth: nowMk,
    weekly: weekly.slice(0, 300),
    grades: grades.slice(0, 300),
    attendance: attendance.slice(0, 300),
    sat: sat.slice(0, 100),
    subjects,
    labels,
    schedule: { periods: periodsOut, cells },
    payments,
    pay: { payme: !!(pay && pay.payme), click: !!(pay && pay.click) }
  };
};
