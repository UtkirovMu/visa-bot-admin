// Elektron viza PDF'ini olish.
// visa.go.kr chop etish sahifasi POST forma bilan ochiladi (pdf_url + pdf_params).
//   1) Avval to'g'ridan-to'g'ri so'rov: javob PDF bo'lsa — o'zi qaytariladi.
//   2) Aks holda (HTML sahifa) — headless Chromium sahifani xuddi brauzerdagidek ochadi
//      (cookie va surat bilan) va PDF'ga chop etadi.
// Faqat visa.go.kr manzillari, bir vaqtda bitta Chromium, vaqt chegarasi, vaqtinchalik fayllar o'chiriladi.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { isAllowedPdfUrl } from "./visa.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const MAX_PDF = 15 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 60_000;

const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isPdf = (buf) => buf && buf.length > 100 && buf.subarray(0, 5).toString("latin1") === "%PDF-";

export function findChromium() {
  const candidates = [config.chromiumPath, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

/** 1-yo'l: to'g'ridan-to'g'ri POST. PDF bo'lsa Buffer, aks holda null. */
async function fetchDirect({ url, params }) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, Accept: "application/pdf,text/html;q=0.9,*/*;q=0.8" },
      body: new URLSearchParams(params),
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return null;
  }
  if (!isAllowedPdfUrl(res.url)) return null; // redirect boshqa domenga olib ketsa — rad
  const type = String(res.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("pdf")) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length <= MAX_PDF && isPdf(buf) ? buf : null;
}

/** Chromium faqat shu manzillarga so'rov yubora oladi (qolgani bloklanadi). */
function allowedForBrowser(u, formUrl) {
  if (u === formUrl) return true;
  if (u.startsWith("data:") || u.startsWith("blob:")) return true;
  try {
    const url = new URL(u);
    if (isAllowedPdfUrl(u)) return true;
    return url.protocol === "https:" && (url.hostname === "go.kr" || url.hostname.endsWith(".go.kr")); // davlat saytining resurslari
  } catch {
    return false;
  }
}

/** Chrome DevTools Protocol (CDP) — Node ichidagi WebSocket bilan, tashqi paketsiz. */
function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP ulanmadi")), { once: true });
  });
  return {
    opened,
    send(method, params = {}, sessionId) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    close() { try { ws.close(); } catch { /* */ } },
  };
}

/** 2-yo'l: headless Chromium bilan sahifani ochib, PDF'ga chop etish. */
async function renderWithChromium({ url, params }) {
  const chromium = findChromium();
  if (!chromium) throw new Error("Chromium o'rnatilmagan — PDF yaratib bo'lmaydi");

  const dir = await mkdtemp(join(tmpdir(), "visa-pdf-"));
  let proc = null;
  let cdp = null;
  let timer = null;
  try {
    const inputs = Object.entries(params)
      .map(([k, v]) => `<input type="hidden" name="${escAttr(k)}" value="${escAttr(v)}">`)
      .join("");
    // Mahalliy sahifa formani avtomatik yuboradi -> Chromium visa.go.kr sahifasini ochadi (cookie bilan)
    const html = `<!doctype html><meta charset="utf-8"><form id="f" method="post" action="${escAttr(url)}" accept-charset="UTF-8">${inputs}</form><script>document.getElementById("f").submit()</script>`;
    const formPath = join(dir, "form.html");
    const formUrl = `file://${formPath}`;
    await writeFile(formPath, html, { mode: 0o600 });

    proc = spawn(chromium, [
      "--headless=new",
      "--no-sandbox", // konteynerda kerak; tarmoq so'rovlari quyida faqat *.go.kr bilan cheklangan
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(dir, "profile")}`,
      `--user-agent=${UA}`,
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    const run = (async () => {
      // DevTools manzilini kutish
      const wsUrl = await new Promise((resolve, reject) => {
        let buf = "";
        proc.stderr.on("data", (d) => {
          buf += d;
          const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
          if (m) resolve(m[1]);
          if (buf.length > 100_000) buf = buf.slice(-2000);
        });
        proc.on("exit", (code) => reject(new Error(`Chromium ishga tushmadi (kod ${code})`)));
        proc.on("error", reject);
      });

      cdp = cdpClient(wsUrl);
      await cdp.opened;
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const S = (m, p) => cdp.send(m, p, sessionId);

      // Tarmoq filtri: faqat forma fayli va *.go.kr
      await S("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      cdp.on((msg) => {
        if (msg.sessionId !== sessionId || msg.method !== "Fetch.requestPaused") return;
        const { requestId, request } = msg.params;
        const ok = allowedForBrowser(request.url, formUrl);
        S(ok ? "Fetch.continueRequest" : "Fetch.failRequest", ok ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch(() => {});
      });

      await S("Page.enable");
      await S("Page.setLifecycleEventsEnabled", { enabled: true });

      // visa.go.kr sahifasi to'liq yuklanishini (tarmoq tinchlanishini) kutish
      let mainFrameId = null;
      let onTarget = false;
      const loaded = new Promise((resolve) => {
        cdp.on((msg) => {
          if (msg.sessionId !== sessionId) return;
          if (msg.method === "Page.frameNavigated" && !msg.params.frame.parentId) {
            mainFrameId = msg.params.frame.id;
            onTarget = isAllowedPdfUrl(msg.params.frame.url);
          }
          if (msg.method === "Page.lifecycleEvent" && onTarget && msg.params.frameId === mainFrameId && msg.params.name === "networkIdle") resolve();
        });
      });
      await S("Page.navigate", { url: formUrl });
      await loaded;
      await new Promise((r) => setTimeout(r, 500)); // rasm/shriftlar chizilishi uchun

      const { data } = await S("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
      return Buffer.from(data, "base64");
    })();

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("PDF yaratish vaqti tugadi")), RENDER_TIMEOUT_MS);
    });
    const buf = await Promise.race([run, timeout]);
    if (!isPdf(buf) || buf.length > MAX_PDF) throw new Error("PDF yaratilmadi");
    return buf;
  } finally {
    clearTimeout(timer);
    cdp?.close();
    if (proc && proc.exitCode === null) {
      proc.kill("SIGKILL");
      await new Promise((r) => { proc.once("exit", r); setTimeout(r, 2000); });
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Bir vaqtda faqat bitta PDF (Chromium xotira talab qiladi)
let queue = Promise.resolve();

/** Elektron viza PDF'ini qaytaradi (Buffer). Xato bo'lsa — Error. */
export function getVisaPdf(pdf) {
  if (!pdf || !isAllowedPdfUrl(pdf.url)) return Promise.reject(new Error("Elektron viza ma'lumoti yo'q"));
  const job = queue.then(async () => (await fetchDirect(pdf)) || (await renderWithChromium(pdf)));
  queue = job.catch(() => {});
  return job;
}
