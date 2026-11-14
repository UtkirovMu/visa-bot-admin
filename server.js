// Turan Int. School — Viza admin paneli (Telegram Web App).
// Tashqi paketlar yo'q: node:http, node:sqlite, node:crypto.
// Ishga tushirish: node server.js   (sozlamalar — README va .env.example)

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyInitData } from "./src/auth.js";
import { config, validateConfig } from "./src/config.js";
import { initCrypto } from "./src/crypto.js";
import { addPerson, countPeople, deletePerson, getPerson, history, initDb, listPeople } from "./src/db.js";
import { checkPerson, deliverPdf, runAll, schedulerStatus, startScheduler, stopScheduler } from "./src/scheduler.js";
import { fullName, maskPassport, parsePerson } from "./src/validate.js";

const ROOT = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/*  Statik fayllar — faqat ruxsat etilgan ro'yxat (path traversal yo'q) */
/* ------------------------------------------------------------------ */

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/mark.png": ["mark.png", "image/png"],
};
const staticCache = new Map(
  Object.entries(STATIC).map(([route, [file, type]]) => [route, { body: readFileSync(join(ROOT, "public", file)), type }]),
);

/* ------------------------------------------------------------------ */
/*  Xavfsizlik sarlavhalari                                            */
/* ------------------------------------------------------------------ */

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  // Faqat Telegram Web ichida (iframe) ochilishi mumkin; mobil/desktop ilovalar iframe ishlatmaydi
  "frame-ancestors 'self' https://web.telegram.org",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow",
};

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...extra });
  res.end(body);
}
const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", { "Cache-Control": "no-store", ...extra });
const fail = (res, status, message, extra) => json(res, status, { ok: false, message }, extra);

/* ------------------------------------------------------------------ */
/*  Rate limit (xotirada)                                               */
/* ------------------------------------------------------------------ */

const buckets = new Map();
function limited(key, limit, windowMs) {
  const now = Date.now();
  if (buckets.size > 20_000) for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  let b = buckets.get(key);
  if (!b || b.reset <= now) buckets.set(key, (b = { n: 0, reset: now + windowMs }));
  b.n++;
  return b.n > limit ? Math.ceil((b.reset - now) / 1000) : 0;
}

// Muvaffaqiyatsiz autentifikatsiyalar: bitta IP'dan 15 daqiqada 20 tadan ko'p bo'lsa — vaqtincha blok
const authFails = new Map();
function authBlocked(ip) {
  const b = authFails.get(ip);
  return b && b.reset > Date.now() && b.n >= 20 ? Math.ceil((b.reset - Date.now()) / 1000) : 0;
}
function authFailed(ip) {
  const now = Date.now();
  if (authFails.size > 20_000) for (const [k, b] of authFails) if (b.reset <= now) authFails.delete(k);
  let b = authFails.get(ip);
  if (!b || b.reset <= now) authFails.set(ip, (b = { n: 0, reset: now + 15 * 60_000 }));
  b.n++;
}

function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0].trim().slice(0, 64);
  }
  return req.socket.remoteAddress || "unknown";
}

/* ------------------------------------------------------------------ */
/*  So'rov tanasi                                                      */
/* ------------------------------------------------------------------ */

const TOO_LARGE = Symbol("too_large");

function readJson(req, max = 4096) {
  return new Promise((resolve) => {
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.startsWith("application/json")) return resolve(null);
    if (Number(req.headers["content-length"] || 0) > max) {
      req.resume(); // qolgan qismini o'qimasdan tashlab yuboramiz
      return resolve(TOO_LARGE);
    }
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      if (size > max) return;
      size += c.length;
      if (size > max) resolve(TOO_LARGE);
      else chunks.push(c);
    });
    req.on("end", () => {
      if (size > max) return;
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

const publicPerson = (p) => ({
  id: p.id,
  passport: p.passport,
  passportMasked: maskPassport(p.passport),
  surname: p.surname,
  name: p.name,
  patronymic: p.patronymic,
  fullName: fullName(p),
  birthDate: p.birthDate,
  note: p.note || "",
  createdAt: p.createdAt,
  lastCheckedAt: p.lastCheckedAt,
  lastState: p.lastState,
  lastStatus: p.lastStatus,
  lastProgress: p.lastProgress,
  lastColor: p.lastColor,
  lastText: p.lastText,
  lastAppDate: p.lastAppDate,
  lastVisaType: p.lastVisaType,
  lastEta: p.lastEta,
  lastError: p.lastError,
  lastExpiry: p.lastExpiry,
  lastReviewDate: p.lastReviewDate,
  lastStayQual: p.lastStayQual,
  hasPdf: p.hasPdf,
  pdfSentAt: p.pdfSentAt,
  issued: ["발급", "허가"].includes(p.lastProgress),
});

async function api(req, res, path, admin) {
  const m = path.match(/^\/api\/people\/(\d{1,9})(\/check|\/pdf)?$/);

  if (path === "/api/me" && req.method === "GET") {
    return json(res, 200, { ok: true, admin: { firstName: admin.firstName } });
  }

  if (path === "/api/status" && req.method === "GET") {
    return json(res, 200, { ok: true, scheduler: schedulerStatus(), people: countPeople() });
  }

  if (path === "/api/people" && req.method === "GET") {
    return json(res, 200, { ok: true, people: listPeople().map(publicPerson) });
  }

  if (path === "/api/people" && req.method === "POST") {
    const body = await readJson(req);
    if (body === TOO_LARGE) return fail(res, 413, "So'rov juda katta.", { Connection: "close" });
    const parsed = parsePerson(body);
    if (!parsed.ok) return fail(res, 400, parsed.message);
    const p = addPerson(parsed.person);
    if (!p) return fail(res, 409, "Bu pasport raqami bilan odam allaqachon qo'shilgan.");
    console.log(`[admin ${admin.id}] qo'shildi: #${p.id}`); // shaxsiy ma'lumot log qilinmaydi
    return json(res, 201, { ok: true, person: publicPerson(p) });
  }

  if (m && !m[2] && req.method === "GET") {
    const p = getPerson(Number(m[1]));
    if (!p) return fail(res, 404, "Topilmadi.");
    return json(res, 200, { ok: true, person: publicPerson(p), history: history(p.id) });
  }

  if (m && !m[2] && req.method === "DELETE") {
    if (!deletePerson(Number(m[1]))) return fail(res, 404, "Topilmadi.");
    console.log(`[admin ${admin.id}] o'chirildi: #${m[1]}`);
    return json(res, 200, { ok: true });
  }

  if (m && m[2] === "/pdf" && req.method === "POST") {
    const wait = limited(`pdf:${admin.id}`, 10, 10 * 60_000);
    if (wait) return fail(res, 429, "Juda ko'p urinish. Birozdan so'ng urinib ko'ring.", { "Retry-After": String(wait) });
    const r = await deliverPdf(Number(m[1]));
    if (r.notFound) return fail(res, 404, "Topilmadi.");
    if (!r.ok) return fail(res, 502, r.message);
    console.log(`[admin ${admin.id}] PDF so'radi: #${m[1]}`);
    return json(res, 200, { ok: true, message: "Elektron viza Telegram'ga yuborildi." });
  }

  if (m && m[2] === "/check" && req.method === "POST") {
    const wait = limited(`check:${admin.id}`, 30, 10 * 60_000);
    if (wait) return fail(res, 429, "Juda ko'p tekshiruv. Birozdan so'ng urinib ko'ring.", { "Retry-After": String(wait) });
    const r = await checkPerson(Number(m[1]));
    if (r.notFound) return fail(res, 404, "Topilmadi.");
    if (r.busy) return fail(res, 409, "Bu odam hozir tekshirilmoqda.");
    return json(res, 200, { ok: true, person: publicPerson(getPerson(Number(m[1]))), history: history(Number(m[1])) });
  }

  if (path === "/api/check-all" && req.method === "POST") {
    const wait = limited(`checkall:${admin.id}`, 6, 60 * 60_000);
    if (wait) return fail(res, 429, "Juda ko'p urinish. Birozdan so'ng urinib ko'ring.", { "Retry-After": String(wait) });
    const started = runAll(`admin ${admin.id}`);
    return json(res, started ? 202 : 409, { ok: started, message: started ? "Tekshiruv boshlandi." : "Tekshiruv allaqachon ketmoqda.", scheduler: schedulerStatus() });
  }

  return fail(res, 404, "Topilmadi.");
}

/* ------------------------------------------------------------------ */
/*  Server                                                             */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    return fail(res, 400, "Noto'g'ri so'rov.");
  }
  const path = url.pathname;
  const ip = clientIp(req);

  if (path === "/healthz") return send(res, 200, "ok", "text/plain; charset=utf-8", { "Cache-Control": "no-store" });

  if (!path.startsWith("/api/")) {
    const f = staticCache.get(path);
    if (!f || (req.method !== "GET" && req.method !== "HEAD")) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    return send(res, 200, f.body, f.type, { "Cache-Control": path === "/" ? "no-store" : "public, max-age=300" });
  }

  // --- API: rate limit -> autentifikatsiya -> marshrut ---
  const wait = limited(`ip:${ip}`, 240, 60_000);
  if (wait) return fail(res, 429, "Juda ko'p so'rov.", { "Retry-After": String(wait) });
  const blocked = authBlocked(ip);
  if (blocked) return fail(res, 429, "Juda ko'p muvaffaqiyatsiz urinish.", { "Retry-After": String(blocked) });

  const auth = String(req.headers.authorization || "");
  const v = verifyInitData(auth.startsWith("tma ") ? auth.slice(4) : "", {
    botToken: config.botToken,
    adminIds: config.adminIds,
    maxAgeSec: config.initDataMaxAgeSec,
  });
  if (!v.ok) {
    if (v.reason !== "missing") {
      authFailed(ip);
      console.warn(`[auth] rad etildi: ${v.reason} (${ip})`);
    }
    return fail(res, v.reason === "not_admin" ? 403 : 401, v.reason === "not_admin" ? "Sizda ruxsat yo'q." : "Avtorizatsiya talab qilinadi. Panelni bot orqali oching.");
  }

  return api(req, res, path, v.user);
}

function main() {
  const errors = validateConfig();
  if (errors.length) {
    for (const e of errors) console.error(`[config] ${e}`);
    process.exit(1);
  }
  initCrypto(config.dataKeyHex);
  initDb(config.dbPath);
  startScheduler();

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("[server] xato:", e?.message);
      if (!res.headersSent) fail(res, 500, "Serverda xatolik.");
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000; // "Hozir tekshirish" 1–2 daqiqagacha cho'zilishi mumkin
  server.keepAliveTimeout = 5_000;
  server.listen(config.port, () => console.log(`[server] admin panel: http://0.0.0.0:${config.port} (adminlar: ${config.adminIds.size})`));

  const stop = () => {
    stopScheduler();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
