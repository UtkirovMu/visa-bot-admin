// Adminga Telegram orqali xabar yuborish (bot tokeni bilan). Token log qilinmaydi.

import { config } from "./config.js";
import { maskPassport, fullName } from "./validate.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const KR = { "발급": "Viza berilgan", "허가": "Ruxsat berilgan", "유학.연수": "O'qish / malaka oshirish" };
const tr = (v) => (v ? (KR[v] ? `${KR[v]} · ${v}` : v) : "");

async function sendMessage(chatId, text) {
  try {
    const res = await fetch(`${config.telegramApi}/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      console.warn("[telegram] sendMessage:", res.status, body?.description ?? "");
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[telegram] sendMessage xatosi:", e?.name ?? "unknown");
    return false;
  }
}

/** Viza chiqqani haqida barcha adminlarga xabar. Kamida bittasiga yetib borsa — true. */
export async function notifyIssued(person, result) {
  const v = result.visa || {};
  const lines = [
    "🎉 <b>Viza chiqdi!</b>",
    "",
    `👤 <b>${esc(fullName(person))}</b>`,
    `🛂 ${esc(maskPassport(person.passport))}`,
  ];
  if (person.note) lines.push(`📝 ${esc(person.note)}`);
  lines.push("", `📌 Holat: <b>${esc(v.status || tr(v.progressStatus))}</b>`);
  if (v.progressStatus) lines.push(`🏛 Elchixonada: ${esc(tr(v.progressStatus))}`);
  if (v.applicationDate) lines.push(`📅 Ariza sanasi: ${esc(v.applicationDate)}`);
  if (v.visaType) lines.push(`🗂 Viza turi: ${esc(tr(v.visaType))}`);
  lines.push("", "Batafsil — admin panelda.");

  let delivered = false;
  for (const id of config.adminIds) delivered = (await sendMessage(id, lines.join("\n"))) || delivered;
  return delivered;
}
