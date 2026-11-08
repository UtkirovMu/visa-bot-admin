// Testlar: npm test  (tashqi paketlarsiz, node:test)
// Soxta visadoctors va Telegram serverlari bilan to'liq oqim tekshiriladi.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

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

/* ------------------------- Integratsion test ------------------------- */

describe("server (to'liq oqim)", () => {
  let server, upstream, telegram, base, dbPath;
  const tgMessages = [];
  const jobs = new Map();

  before(async () => {
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
        res.end(JSON.stringify({ id, status: "COMPLETED", response_data: { status: "success", visa_data: {
          progress_status: issued ? "발급" : "접수", status: issued ? "Viza berilgan" : "Qabul qilingan",
          visa_type: "유학.연수", color_background: issued ? "#43A047" : "#2196F3",
          response_text: issued ? "Vizangiz berildi." : "Qabul qilingan.", application_date: "2026-10-28",
          processing_info: { average_days: 21.9, is_delayed: false, status_message: "Taxminan 13 kunda" },
        } } }));
      });
    }).listen(0);

    // Soxta Telegram
    telegram = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        tgMessages.push({ path: req.url, body: JSON.parse(b) });
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
        TRUST_PROXY: "true",
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

  test("viza chiqsa adminga bir marta xabar", async () => {
    const r = await call("/api/people", { method: "POST", body: { ...person, passport: "AP1234567", surname: "Valiyev", name: "Ali", patronymic: "" } });
    const id = (await r.json()).person.id;
    const before = tgMessages.length;
    const d = await (await call(`/api/people/${id}/check`, { method: "POST", body: {} })).json();
    assert.equal(d.person.issued, true);
    await call(`/api/people/${id}/check`, { method: "POST", body: {} });
    const sent = tgMessages.slice(before);
    assert.equal(sent.length, 1, "faqat bir marta");
    assert.equal(sent[0].body.chat_id, ADMIN);
    assert.match(sent[0].body.text, /Viza chiqdi/);
    assert.match(sent[0].body.text, /AP12•••67/);
    assert.ok(!sent[0].body.text.includes("AP1234567"), "pasport yashirilgan");
    assert.equal(sent[0].path, `/bot${BOT_TOKEN}/sendMessage`);
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
