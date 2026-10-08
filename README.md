# Deutsch School

Frontend (`public/index.html`) + backend (`server.js`). Ma'lumotlar serverda (Postgres) saqlanadi, kirish parollari xeshlangan, o'qituvchilar faqat o'z sinflariga yoza oladi.

## 1. GitHub'ga yuklash
1. github.com → **New repository** (nomi: `deutsch-school`, **Private** tavsiya etiladi).
2. Shu papkadagi hamma fayllarni yuklang (**Add file → Upload files**), `node_modules` va `.env` bo'lmasin. **Commit changes**.

## 2. Bepul baza (Neon) — ma'lumot yo'qolmasligi uchun
Render'ning bepul Postgres bazasi 30 kundan keyin o'chadi, Neon'nikida muddat yo'q.
1. neon.tech → ro'yxatdan o'ting → yangi project yarating.
2. **Connection string** (`postgresql://...`) ni nusxalang. Bu `DATABASE_URL` bo'ladi.

## 3. Render'da joylash
1. render.com → **New → Blueprint** → GitHub repo'ni tanlang (`render.yaml` avtomatik o'qiladi).
2. So'ralganda kiriting:
   - `ADMIN_USER` — masalan `deutsch_schuleee`
   - `ADMIN_PASSWORD` — kuchli parol (8+ belgi)
   - `DATABASE_URL` — Neon'dan nusxalangan satr
3. **Apply** bosing. 2–3 daqiqada sayt `https://deutsch-school.onrender.com` kabi manzilda ochiladi.

## Muhim
- Bepul Render xizmati 15 daqiqa ishlatilmasa uxlaydi; birinchi ochilish ~30–60 soniya oladi.
- Eski brauzerdagi ma'lumotni ko'chirish: avvalgi saytni ochgan brauzerda administrator bo'lib kiring — ko'chirish taklifi chiqadi. O'qituvchilar parolini qayta o'rnating.
- Parolni unutsangiz: Render → Environment: `ADMIN_PASSWORD` ni yangilab, `RESET_ADMIN=1` qo'shing, qayta deploy qiling, keyin `RESET_ADMIN` ni o'chiring.
- Kunlik zaxira nusxalar (14 kun): administrator sifatida kirib, `/api/backups` ni oching; yuklab olish: `/api/backups/2026-10-08`.

## Mahalliy sinov
```
cp .env.example .env   # yoki o'zgaruvchilarni qo'lda bering
ADMIN_USER=admin ADMIN_PASSWORD=parol1234 npm start
npm test
```
