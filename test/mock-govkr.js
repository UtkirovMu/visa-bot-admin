// Test uchun soxta visa.go.kr: POST forma -> cookie + HTML (koreyscha matn, cookie talab qiladigan surat).
// blockedUrl berilsa, sahifa ruxsat etilmagan tashqi resursni ham yuklamoqchi bo'ladi (Chromium uni bloklashi kerak).
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
function png(w, h) { // oddiy qizil-sariq PNG
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 230; raw[o + 1] = 120 + (x % 100); raw[o + 2] = 40; } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
export const log = [];
export function start(port, { directPdf = false, blockedUrl = "" } = {}) {
  return createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      log.push({ method: req.method, url: req.url, cookie: req.headers.cookie || "", body: b });
      if (req.method === "POST" && req.url.startsWith("/biz/ap/ev/selectElectronicVisaPrint3.do")) {
        const p = new URLSearchParams(b);
        if (directPdf) { res.writeHead(200, { "content-type": "application/pdf" }); return res.end(Buffer.from("%PDF-1.4\n% direct test pdf " + "x".repeat(200) + "\n%%EOF")); }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "JSESSIONID=abc123; Path=/; HttpOnly" });
        return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>전자비자</title></head><body style="font-family:sans-serif">
          <h1>전자비자 확인서 ELECTRONIC VISA</h1><p>EV_SEQ: ${p.get("EV_SEQ")}</p><p>NAME: ${p.get("ENG_NM")}</p><p>BIRTH: ${p.get("BIRTH_YMD")}</p>
          <img id="ph" src="/biz/ap/ev/selectInviteeXvarmImage.do" width="120" height="160">${blockedUrl ? `<img src="${blockedUrl}">` : ""}<script>window.print && 0;</script></body></html>`);
      }
      if (req.url.startsWith("/biz/ap/ev/selectInviteeXvarmImage.do")) {
        if (!(req.headers.cookie || "").includes("JSESSIONID=abc123")) { res.writeHead(403); return res.end(); }
        res.writeHead(200, { "content-type": "image/png" }); return res.end(png(120, 160));
      }
      res.writeHead(404); res.end();
    });
  }).listen(port);
}
