# Turan Int. School — Viza admin paneli

Telegram Web App. Admin o'z odamlarini (pasport, F.I.Sh, tug'ilgan sana) kiritadi. Tizim **har kuni 3 marta** ularning viza holatini avtomatik tekshiradi, natijalarni panelda ko'rsatadi va **viza chiqsa, adminga Telegram'da xabar yuboradi**.

Panel [visabot](https://github.com/UtkirovMu/visabot) orqali ochiladi: adminda `/admin` buyrug'i va «🛠 Admin panel» tugmasi paydo bo'ladi.

## Imkoniyatlar

- Odam qo'shish, ro'yxatni ko'rish, qidirish, filtrlash (viza chiqqan / jarayonda / topilmadi), o'chirish.
- Avtomatik tekshiruv: `CHECK_TIMES` vaqtlarida (standart 09:00, 14:00, 20:00, Toshkent vaqti). Odamlar ketma-ket, orasida pauza bilan tekshiriladi.
- «Hozir tekshirish» (bitta odam) va «Hammasini tekshirish».
- Har bir odam uchun oxirgi holat va tekshiruvlar tarixi (oxirgi 60 ta).
- Viza chiqsa (elchixona holati `발급` yoki `허가`), adminga **bir marta** Telegram xabari yuboriladi. Xabar yetib bormasa, keyingi tekshiruvda qayta yuboriladi.
- **Elektron viza (PDF):** viza chiqqanda API `pdf_url` va `pdf_params` qaytarsa, PDF avtomatik yaratilib, adminga Telegram'da hujjat bo'lib yuboriladi (bir marta). Panelda «Elektron vizani yuklab olish» tugmasi uni istalgan payt qayta yuboradi.
- Viza berilgan sana, amal qilish muddati (`expiry_date`) va viza toifasi (`D-4-1`) ham ko'rsatiladi.

### Elektron viza PDF qanday olinadi

`pdf_url` visa.go.kr'ning chop etish sahifasi bo'lib, unga `pdf_params` POST forma bilan yuboriladi.

1. Server avval sahifani to'g'ridan-to'g'ri so'raydi. Javob PDF bo'lsa, o'zini yuboradi.
2. HTML bo'lsa, server ichidagi headless Chromium (DevTools protokoli orqali) formani yuborib, sahifani xuddi brauzerdagidek cookie va surat bilan ochadi va PDF'ga chop etadi.

Bu jarayonda Chromium faqat `*.go.kr` manzillariga so'rov yubora oladi, qolganlari bloklanadi. Bir vaqtda faqat bitta PDF yaratiladi (60 soniyalik chegara bilan), vaqtinchalik fayllar darhol o'chiriladi. `pdf_params` da shaxsiy ma'lumot bor, shuning uchun bazada shifrlangan holda saqlanadi.

## Xavfsizlik

| Himoya | Qanday |
|---|---|
| Kirish | Parol yo'q. Telegram imzolagan `initData` (HMAC-SHA256, bot tokeni bilan) har bir so'rovda tekshiriladi. Faqat `ADMIN_IDS` dagi foydalanuvchilarga ruxsat. initData 24 soatdan keyin eskiradi |
| CSRF | Cookie yoki sessiya yo'q, avtorizatsiya faqat `Authorization` sarlavhasida, shuning uchun CSRF imkonsiz |
| Shaxsiy ma'lumot | Pasport, ism, tug'ilgan sana va izoh bazada **AES-256-GCM** bilan shifrlangan. Kalit `DATA_KEY` dan HKDF orqali olinadi. Takroriy pasportni aniqlash uchun HMAC "ko'r indeks" ishlatiladi, ochiq raqam saqlanmaydi |
| Brute-force | Bitta IP'dan 15 daqiqada 20 ta noto'g'ri urinishdan keyin vaqtincha blok. Umumiy limit: daqiqasiga 240 so'rov |
| Kiruvchi ma'lumot | Qat'iy allowlist validatsiya, JSON tanasi 4 KB bilan cheklangan |
| XSS | CSP: `script-src 'self'`, inline skript va stil yo'q. Interfeys ma'lumotni faqat `textContent` orqali chiqaradi |
| Clickjacking | `frame-ancestors 'self' https://web.telegram.org` |
| Statik fayllar | Faqat 4 ta ruxsat etilgan fayl, path traversal imkonsiz |
| Tashqi so'rovlar | visadoctors va Telegram manzillari kodda qat'iy belgilangan (SSRF yo'q), timeout va javob hajmi cheklangan. Elektron viza havolasi faqat `https://www.visa.go.kr` bo'lsa qabul qilinadi |
| Chromium | Faqat PDF uchun, `*.go.kr` dan boshqa barcha tarmoq so'rovlari bloklanadi, root'siz ishlaydi |
| Loglar | Pasport va ism log qilinmaydi, Telegram xabarida pasport yashiriladi (`FB24•••48`) |
| Konteyner | Ilova root emas, `node` foydalanuvchisi sifatida ishlaydi. Baza papkasi `700` huquqli |
| Bog'liqliklar | **Tashqi npm paketlar yo'q** (`node:http`, `node:sqlite`, `node:crypto`, ichki `WebSocket`/`FormData`). Docker image'ga faqat Debian'ning `chromium` va shrift paketlari qo'shilgan |

## Railway'ga joylash

1. **New → GitHub Repo → `UtkirovMu/visa-bot-admin`**.
2. **Volume qo'shing:** servis sozlamalarida **Volumes → Add Volume**, Mount path `/data`. Baza shu yerda saqlanadi, busiz har deployda ma'lumotlar o'chib ketadi.
3. **Variables:**

   | Nomi | Qiymati |
   |---|---|
   | `BOT_TOKEN` | Bot tokeni (visabot bilan bir xil) |
   | `ADMIN_IDS` | `1830068413` |
   | `DATA_KEY` | 64 belgili hex kalit (pastga qarang) |
   | `CHECK_TIMES` | `09:00,14:00,20:00` (ixtiyoriy) |

   `DATA_KEY` ni yaratish:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   ⚠️ **Bu kalitni xavfsiz joyda zaxira qiling.** U yo'qolsa, bazadagi ma'lumotlarni hech kim, siz ham, ocha olmaydi.

4. **Settings → Networking → Generate Domain** orqali domen oling (masalan, `visa-bot-admin-production.up.railway.app`).
5. **Bot** (`visabot`) servisiga qo'shing:
   - `ADMIN_IDS` = `1830068413`
   - `ADMIN_APP_URL` = 4-qadamdagi domen (`https://...`)
6. Deploy qiling. Botda `/admin` yuboring.

Servis bitta nusxada ishlashi kerak (`railway.json` da `numReplicas: 1`), chunki rejalashtirgich va SQLite bitta jarayonda.

## Ishlab chiqish

```bash
npm test     # 31 ta test: shifrlash, Telegram imzosi, rejalashtirgich, elektron viza PDF, to'liq API oqimi
npm start    # BOT_TOKEN, ADMIN_IDS, DATA_KEY, DB_PATH kerak
```

Node.js 22.13+ (yoki 24) kerak, chunki ichki `node:sqlite` ishlatiladi.

## Eslatma

Tekshiruvlar visadoctors.uz ning hujjatlanmagan API'si orqali bajariladi. U o'zgarishi yoki bloklanishi mumkin, shuning uchun odamlar soni ko'p bo'lsa `CHECK_DELAY_MS` ni oshiring.
