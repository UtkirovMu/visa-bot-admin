// Testlar: npm test  (tashqi paketlarsiz, node:test)
// Soxta visadoctors va Telegram serverlari bilan to'liq oqim tekshiriladi.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { start as startGovKr, log as govLog } from "./mock-govkr.js";

const HAS_CHROMIUM = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", process.env.CHROMIUM_PATH]
  .filter(Boolean).some((p) => existsSync(p));

const BOT_TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const ADMIN = 1830068413;
const DATA_KEY = randomBytes(32).toString("hex");

/** Telegram kabi initData yaratish (test uchun). */
function makeInitData(userId, { token = BOT_TOKEN, authDate = Math.floor(Date.now() / 1000) } = {}) {
  const fields = {
    auth_date: String(authDate),
    query_id: "AAHtest",
    user: JSON.stringify({ id: userId, first_name: "Admin", username: "admin" }),
  };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

/* ------------------------- Birlik testlari ------------------------- */

describe("crypto", async () => {
  const { initCrypto, seal, unseal, blindIndex } = await import("../src/crypto.js");
  initCrypto(DATA_KEY);

  test("shifrlash va ochish", () => {
    const obj = { passport: "FB2452648", name: "ALI" };
    const s = seal(obj);
    assert.ok(!s.includes("FB2452648"));
    assert.deepEqual(unseal(s), obj);
    assert.notEqual(seal(obj), s, "har safar yangi IV");
  });

  test("o'zgartirilgan shifr rad etiladi", () => {
    const s = seal({ a: 1 });
    const buf = Buffer.from(s.slice(3), "base64url");
    buf[buf.length - 1] ^= 1;
    assert.throws(() => unseal(`v1.${buf.toString("base64url")}`));
  });

  test("ko'r indeks barqaror va pasportni ochmaydi", () => {
    assert.equal(blindIndex("FB2452648"), blindIndex("FB2452648"));
    assert.notEqual(blindIndex("FB2452648"), blindIndex("FB2452649"));
    assert.ok(!blindIndex("FB2452648").includes("FB"));
  });
});

describe("auth (Telegram initData)", async () => {
  const { verifyInitData } = await import("../src/auth.js");
  const opts = { botToken: BOT_TOKEN, adminIds: new Set([ADMIN]), maxAgeSec: 86400 };

  test("admin qabul qilinadi", () => {
    const r = verifyInitData(makeInitData(ADMIN), opts);
    assert.equal(r.ok, true);
    assert.equal(r.user.id, ADMIN);
  });
  test("admin bo'lmagan foydalanuvchi rad etiladi", () => {
    assert.equal(verifyInitData(makeInitData(555), opts).reason, "not_admin");
  });
  test("boshqa token bilan imzolangan rad etiladi", () => {
    assert.equal(verifyInitData(makeInitData(ADMIN, { token: "999:Other" }), opts).reason, "bad_signature");
  });
  test("user maydoni o'zgartirilsa rad etiladi", () => {
    const d = makeInitData(555).replace(/%22id%22%3A555/, `%22id%22%3A${ADMIN}`);
    assert.equal(verifyInitData(d, opts).ok, false);
  });
  test("eskirgan initData rad etiladi", () => {
    const old = Math.floor(Date.now() / 1000) - 2 * 86400;
    assert.equal(verifyInitData(makeInitData(ADMIN, { authDate: old }), opts).reason, "expired");
  });
  test("bo'sh / buzuq rad etiladi", () => {
    assert.equal(verifyInitData("", opts).ok, false);
    assert.equal(verifyInitData("hash=zz", opts).ok, false);
  });
});

describe("scheduler vaqtlari", async () => {
  const { config } = await import("../src/config.js");
  const { nextRunAt } = await import("../src/scheduler.js");
  config.checkTimes = [9 * 60, 14 * 60, 20 * 60];
  config.tzOffsetMin = 300;
  const at = (iso) => Date.parse(iso);

  test("ertalab 08:00 → 09:00", () => assert.equal(nextRunAt(at("2026-11-08T03:00:00Z")), at("2026-11-08T04:00:00Z")));
  test("10:00 → 14:00", () => assert.equal(nextRunAt(at("2026-11-08T05:00:00Z")), at("2026-11-08T09:00:00Z")));
  test("21:00 → ertaga 09:00", () => assert.equal(nextRunAt(at("2026-11-08T16:00:00Z")), at("2026-11-09T04:00:00Z")));
  test("Toshkentda yarim tun (UTC 19:30) → 09:00", () => assert.equal(nextRunAt(at("2026-11-08T19:30:00Z")), at("2026-11-09T04:00:00Z")));
});

describe("elektron viza ma'lumoti (toResult)", async () => {
  const { toResult } = await import("../src/visa.js");
  const base = (vd) => ({ status: "COMPLETED", response_data: { status: "success", visa_data: {
    progress_status: "허가", status: "Tasdiqlangan", requires_pdf: true, expiry_date: "2027-02-13", review_date: "2026-11-13",
    stay_qualification: "D-4-1", pdf_url: "https://www.visa.go.kr/biz/ap/ev/selectElectronicVisaPrint3.do",
    pdf_params: { EV_SEQ: "UZ26VC023437", ENG_NM: "A B", IN_PHOTO: "https://www.visa.go.kr/biz/ap/ev/selectInviteeXvarmImage.do" }, ...vd } } });

  test("visa.go.kr havolasi qabul qilinadi", () => {
    const v = toResult(base({})).visa;
    assert.equal(v.pdf.url, "https://www.visa.go.kr/biz/ap/ev/selectElectronicVisaPrint3.do");
    assert.equal(v.pdf.params.EV_SEQ, "UZ26VC023437");
    assert.equal(v.expiryDate, "2027-02-13");
    assert.equal(v.reviewDate, "2026-11-13");
    assert.equal(v.stayQualification, "D-4-1");
  });
  test("boshqa domen rad etiladi", () => {
    assert.equal(toResult(base({ pdf_url: "https://evil.example/x" })).visa.pdf, null);
    assert.equal(toResult(base({ pdf_url: "https://www.visa.go.kr.evil.example/x" })).visa.pdf, null);
    assert.equal(toResult(base({ pdf_url: "http://www.visa.go.kr/x" })).visa.pdf, null, "faqat https");
  });
  test("parametr ichidagi tashqi URL rad etiladi", () => {
    assert.equal(toResult(base({ pdf_params: { IN_PHOTO: "https://evil.example/p.png" } })).visa.pdf, null);
  });
  test("requires_pdf bo'lmasa — PDF yo'q", () => {
    assert.equal(toResult(base({ requires_pdf: false })).visa.pdf, null);
  });
});

describe("PDF olish: javob to'g'ridan-to'g'ri PDF bo'lsa", () => {
  test("Chromium ishlatilmaydi, PDF o'zi qaytadi", async () => {
    const { config } = await import("../src/config.js");
    const { getVisaPdf } = await import("../src/pdf.js");
    const srv = startGovKr(0, { directPdf: true });
    await new Promise((r) => srv.once("listening", r));
    const host = `127.0.0.1:${srv.address().port}`;
    config.pdfHostsDev = [host];
    try {
      const buf = await getVisaPdf({ url: `http://${host}/biz/ap/ev/selectElectronicVisaPrint3.do`, params: { EV_SEQ: "X" } });
      assert.match(buf.toString("latin1"), /direct test pdf/);
    } finally {
      config.pdfHostsDev = [];
      srv.close();
    }
  });
  test("ruxsat etilmagan manzil rad etiladi", async () => {
    const { getVisaPdf } = await import("../src/pdf.js");
    await assert.rejects(getVisaPdf({ url: "https://evil.example/x", params: {} }));
  });
});

/* ------------------------- Integratsion test ------------------------- */

describe("server (to'liq oqim)", () => {
  let server, upstream, telegram, base, dbPath;
  const tgMessages = [];
  const jobs = new Map();

  let govkr, blocked;
  const blockedHits = [];

  before(async () => {
    // Ruxsat etilmagan "tashqi" server — Chromium unga murojaat qilmasligi kerak
    blocked = createServer((req, res) => { blockedHits.push(req.url); res.end(); }).listen(0);
    await new Promise((r) => blocked.once("listening", r));
    // Soxta visa.go.kr
    govkr = startGovKr(0, { blockedUrl: `http://127.0.0.1:${blocked.address().port}/tracker.png` });
    await new Promise((r) => govkr.once("listening", r));
    // Soxta visadoctors
    upstream = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "POST") {
          const body = JSON.parse(b);
          const id = `4f3b0db6-232d-46e7-8d7e-${String(jobs.size).padStart(12, "0")}`;
          jobs.set(id, { n: 0, passport: body.passport_number });
          return res.end(JSON.stringify({ id, status: "PENDING", response_data: null }));
        }
        const id = req.url.split("/").filter(Boolean).pop();
        const j = jobs.get(id);
        if (!j) { res.statusCode = 404; return res.end("{}"); }
        if (++j.n < 2) return res.end(JSON.stringify({ id, status: "PENDING", response_data: null }));
        if (j.passport === "AA0000000") return res.end(JSON.stringify({ id, status: "COMPLETED", response_data: { status: "error", message: "Topilmadi" } }));
        const issued = j.passport.startsWith("AP");
        const gov = `http://127.0.0.1:${govkr.address().port}`;
        res.end(JSON.stringify({ id, status: "COMPLETED", response_data: { status: "success", visa_data: {
          progress_status: issued ? "허가" : "접수", status: issued ? "Tasdiqlangan" : "Qabul qilingan",
          visa_type: "유학.연수", color_background: issued ? "#4CAF50" : "#2196F3",
          response_text: issued ? "Sizga 2026-11-13 sanasida viza berildi" : "Qabul qilingan.", application_date: "2026-10-28",
          ...(issued ? {
            requires_pdf: true, expiry_date: "2027-02-13", review_date: "2026-11-13", stay_qualification: "D-4-1",
            pdf_url: `${gov}/biz/ap/ev/selectElectronicVisaPrint3.do`,
            pdf_params: { EV_SEQ: "UZ26VC023437", INVITEE_SEQ: "0", APPL_NO: "", ENG_NM: "VALIYEV ALI", BIRTH_YMD: "20080828",
              sBUSI_GB: "PASS_NO", sBUSI_GBNO: j.passport, TRAN_TYPE: "ComSubmit", IN_PHOTO: `${gov}/biz/ap/ev/selectInviteeXvarmImage.do`, SE_FLAG_YN: "", LANG_TYPE: "KO" },
          } : { processing_info: { average_days: 21.9, is_delayed: false, status_message: "Taxminan 13 kunda" } }),
        } } }));
      });
    }).listen(0);

    // Soxta Telegram
    telegram = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const multipart = String(req.headers["content-type"] || "").startsWith("multipart/");
        tgMessages.push({ path: req.url, body: multipart ? null : JSON.parse(raw.toString("utf8")), raw: multipart ? raw : null });
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true,"result":{}}');
      });
    }).listen(0);

    const dir = mkdtempSync(join(tmpdir(), "visa-admin-"));
    dbPath = join(dir, "test.db");
    const port = 20000 + Math.floor(Math.random() * 20000);
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
      env: {
        ...process.env, NODE_ENV: "development", PORT: String(port), BOT_TOKEN, ADMIN_IDS: String(ADMIN),
        DATA_KEY, DB_PATH: dbPath, VISA_UPSTREAM_DEV: `http://127.0.0.1:${upstream.address().port}/x/`,
        TELEGRAM_API_DEV: `http://127.0.0.1:${telegram.address().port}`, POLL_INTERVAL_DEV_MS: "30", CHECK_DELAY_MS: "30",
        TRUST_PROXY: "true", VISA_PDF_HOST_DEV: `127.0.0.1:${govkr.address().port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* hali ishga tushmagan */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  after(() => {
    server?.kill();
    upstream?.close();
    telegram?.close();
    govkr?.close();
    blocked?.close();
  });

  let ipN = 0;
  const call = (path, { method = "GET", body, user = ADMIN, init, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        Authorization: `tma ${init ?? makeInitData(user)}`,
        "X-Forwarded-For": `10.9.0.${++ipN % 250}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });

  const person = { passport: "fb 2452648", surname: "Sobirova", name: "Mubinakhon", patronymic: "Dilmurod kizi", birthDate: "2008-08-20", note: "3-guruh" };

  test("xavfsizlik sarlavhalari va statik fayllar", async () => {
    const r = await fetch(base + "/");
    assert.equal(r.status, 200);
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'self' https:\/\/web\.telegram\.org/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    for (const p of ["/../server.js", "/src/config.js", "/.env", "/public/app.js", "/%2e%2e/server.js"]) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
  });

  test("autentifikatsiyasiz va admin bo'lmaganlar rad etiladi", async () => {
    assert.equal((await fetch(base + "/api/people")).status, 401);
    assert.equal((await call("/api/people", { user: 555 })).status, 403);
    assert.equal((await call("/api/people", { init: makeInitData(ADMIN, { token: "1:x" }) })).status, 401);
  });

  test("odam qo'shish, validatsiya va takror", async () => {
    let r = await call("/api/people", { method: "POST", body: person });
    assert.equal(r.status, 201);
    const d = await r.json();
    assert.equal(d.person.passport, "FB2452648");
    assert.equal(d.person.fullName, "SOBIROVA MUBINAKHON DILMUROD KIZI");

    r = await call("/api/people", { method: "POST", body: { ...person, passport: "FB2452648" } });
    assert.equal(r.status, 409, "takroriy pasport");

    for (const bad of [{ ...person, passport: "<script>" }, { ...person, surname: "Собирова" }, { ...person, birthDate: "2099-01-01" }]) {
      assert.equal((await call("/api/people", { method: "POST", body: bad })).status, 400);
    }
    assert.equal((await call("/api/people", { method: "POST", body: "x".repeat(5000) })).status, 413, "katta so'rov");
    assert.equal((await call("/api/people", { method: "POST", body: person, headers: { "Content-Type": "text/plain" } })).status, 400);
  });

  test("bazada shaxsiy ma'lumot ochiq ko'rinmaydi", () => {
    const dir = join(dbPath, "..");
    const raw = readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("");
    for (const s of ["FB2452648", "SOBIROVA", "MUBINAKHON", "2008-08-20", "3-guruh"]) assert.ok(!raw.includes(s), s);
  });

  test("hozir tekshirish → natija va tarix", async () => {
    const list = await (await call("/api/people")).json();
    const id = list.people[0].id;
    const r = await call(`/api/people/${id}/check`, { method: "POST", body: {} });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.person.lastStatus, "Qabul qilingan");
    assert.equal(d.person.issued, false);
    assert.equal(d.history.length, 1);
  });

  test("viza chiqsa adminga bir marta xabar va PDF", async () => {
    const r = await call("/api/people", { method: "POST", body: { ...person, passport: "AP1234567", surname: "Valiyev", name: "Ali", patronymic: "" } });
    const id = (await r.json()).person.id;
    const before = tgMessages.length;
    const d = await (await call(`/api/people/${id}/check`, { method: "POST", body: {} })).json();
    assert.equal(d.person.issued, true);
    assert.equal(d.person.lastExpiry, "2027-02-13");
    assert.equal(d.person.lastStayQual, "D-4-1");
    assert.equal(d.person.hasPdf, true);
    await call(`/api/people/${id}/check`, { method: "POST", body: {} });
    const sent = tgMessages.slice(before);
    const texts = sent.filter((m) => m.path.endsWith("/sendMessage"));
    assert.equal(texts.length, 1, "matnli xabar faqat bir marta");
    assert.equal(texts[0].body.chat_id, ADMIN);
    assert.match(texts[0].body.text, /Viza chiqdi/);
    assert.match(texts[0].body.text, /2027-02-13/);
    assert.match(texts[0].body.text, /AP12•••67/);
    assert.ok(!texts[0].body.text.includes("AP1234567"), "pasport yashirilgan");
    assert.equal(texts[0].path, `/bot${BOT_TOKEN}/sendMessage`);

    const docs = sent.filter((m) => m.path.endsWith("/sendDocument"));
    if (!HAS_CHROMIUM) return; // Chromium yo'q muhitda PDF bosqichi o'tkazib yuboriladi
    assert.equal(docs.length, 1, "PDF avtomatik, faqat bir marta");
    const raw = docs[0].raw.toString("latin1");
    assert.ok(raw.includes("%PDF-"), "hujjat PDF");
    assert.match(raw, /filename="Viza_VALIYEV_ALI\.pdf"/);
    assert.match(raw, new RegExp(`name="chat_id"\\r\\n\\r\\n${ADMIN}`));
    const after = await (await call(`/api/people/${id}`)).json();
    assert.ok(after.person.pdfSentAt);
    // Chromium visa.go.kr sahifasini cookie bilan ochgan (surat yuklangan)
    assert.ok(govLog.some((l) => l.url.startsWith("/biz/ap/ev/selectInviteeXvarmImage.do") && l.cookie.includes("JSESSIONID")));
    // Ruxsat etilmagan tashqi resurs bloklangan
    assert.deepEqual(blockedHits, [], "Chromium begona serverga murojaat qilmasligi kerak");
  });

  test("PDF tugmasi: qayta yuborish", { skip: !HAS_CHROMIUM && "Chromium yo'q" }, async () => {
    const people = (await (await call("/api/people")).json()).people;
    const id = people.find((p) => p.passport === "AP1234567").id;
    const before = tgMessages.length;
    const r = await call(`/api/people/${id}/pdf`, { method: "POST", body: {} });
    assert.equal(r.status, 200);
    const docs = tgMessages.slice(before).filter((m) => m.path.endsWith("/sendDocument"));
    assert.equal(docs.length, 1);
  });

  test("viza chiqmagan odam uchun PDF yo'q", async () => {
    const people = (await (await call("/api/people")).json()).people;
    const id = people.find((p) => p.passport === "FB2452648").id;
    const r = await call(`/api/people/${id}/pdf`, { method: "POST", body: {} });
    assert.equal(r.status, 502);
    assert.match((await r.json()).message, /hali yo'q/);
  });

  test("PDF parametrlari bazada shifrlangan", () => {
    const dir = join(dbPath, "..");
    const raw = readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("");
    for (const s of ["UZ26VC023437", "VALIYEV ALI", "AP1234567", "20080828"]) assert.ok(!raw.includes(s), s);
  });

  test("hammasini tekshirish (fon rejimida)", async () => {
    await call("/api/people", { method: "POST", body: { ...person, passport: "AA0000000", surname: "Test", name: "User" } });
    const r = await call("/api/check-all", { method: "POST", body: {} });
    assert.equal(r.status, 202);
    assert.equal((await call("/api/check-all", { method: "POST", body: {} })).status, 409, "ikkinchisi — allaqachon ketmoqda");
    for (let i = 0; i < 100; i++) {
      const s = (await (await call("/api/status")).json()).scheduler;
      if (!s.running) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const people = (await (await call("/api/people")).json()).people;
    assert.equal(people.length, 3);
    assert.equal(people.find((p) => p.passport === "AA0000000").lastState, "not_found");
    assert.ok(people.every((p) => p.lastCheckedAt));
  });

  test("o'chirish", async () => {
    const people = (await (await call("/api/people")).json()).people;
    const id = people.find((p) => p.passport === "AA0000000").id;
    assert.equal((await call(`/api/people/${id}`, { method: "DELETE" })).status, 200);
    assert.equal((await call(`/api/people/${id}`)).status, 404);
  });

  test("ko'p muvaffaqiyatsiz urinishdan keyin IP bloklanadi", async () => {
    const h = { "X-Forwarded-For": "6.6.6.6" };
    for (let i = 0; i < 20; i++) await fetch(base + "/api/people", { headers: { ...h, Authorization: `tma ${makeInitData(ADMIN, { token: "1:bad" })}` } });
    const r = await fetch(base + "/api/people", { headers: { ...h, Authorization: `tma ${makeInitData(ADMIN)}` } });
    assert.equal(r.status, 429);
  });
});
