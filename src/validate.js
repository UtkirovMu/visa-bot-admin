// Kiruvchi ma'lumotni qat'iy tekshirish (allowlist). Sayt bilan bir xil qoidalar.

const PASSPORT_RE = /^[A-Z0-9]{6,12}$/;
const NAME_PART_RE = /^[A-Z][A-Z' -]{0,39}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const normName = (v) =>
  typeof v === "string"
    ? v.normalize("NFKC").replace(/[`ʻʼ‘’]/g, "'").replace(/\s+/g, " ").trim().toUpperCase()
    : "";

export function parsePerson(body) {
  if (!body || typeof body !== "object") return { ok: false, message: "Noto'g'ri so'rov." };

  const passport = typeof body.passport === "string" ? body.passport.replace(/\s+/g, "").toUpperCase() : "";
  if (!PASSPORT_RE.test(passport)) return { ok: false, message: "Pasport raqami noto'g'ri." };

  const surname = normName(body.surname);
  const name = normName(body.name);
  const patronymic = normName(body.patronymic);
  if (!NAME_PART_RE.test(surname)) return { ok: false, message: "Familiyani lotin harflarida kiriting." };
  if (!NAME_PART_RE.test(name)) return { ok: false, message: "Ismni lotin harflarida kiriting." };
  if (patronymic && !NAME_PART_RE.test(patronymic)) return { ok: false, message: "Otasining ismini lotin harflarida kiriting." };

  const birthDate = typeof body.birthDate === "string" ? body.birthDate : "";
  const m = DATE_RE.exec(birthDate);
  if (!m) return { ok: false, message: "Tug'ilgan sana noto'g'ri." };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const valid =
    d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] &&
    +m[1] >= 1920 && d.getTime() <= Date.now();
  if (!valid) return { ok: false, message: "Tug'ilgan sana noto'g'ri." };

  const note = typeof body.note === "string" ? body.note.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : "";

  return { ok: true, person: { passport, surname, name, patronymic, birthDate, note } };
}

export const fullName = (p) => [p.surname, p.name, p.patronymic].filter(Boolean).join(" ");

export function maskPassport(p) {
  return p.length > 6 ? `${p.slice(0, 4)}${"•".repeat(Math.max(3, p.length - 6))}${p.slice(-2)}` : p;
}
