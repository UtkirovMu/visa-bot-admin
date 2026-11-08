"use strict";
// Admin panel (Telegram Web App). Tashqi skript yo'q. Barcha ma'lumot textContent orqali chiqariladi (XSS yo'q).

(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  /* ---------------- Telegram Web App ---------------- */

  function tgPost(type, data) {
    const payload = JSON.stringify(data || {});
    try {
      if (window.TelegramWebviewProxy && window.TelegramWebviewProxy.postEvent) {
        window.TelegramWebviewProxy.postEvent(type, payload);
      } else if (window.external && "notify" in window.external) {
        window.external.notify(JSON.stringify({ eventType: type, eventData: data || {} }));
      } else if (window.parent !== window) {
        window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data || {} }), "https://web.telegram.org");
      }
    } catch (_) { /* Telegram'dan tashqarida — e'tiborsiz */ }
  }

  function getInitData() {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData");
    try {
      if (fromHash) sessionStorage.setItem("tgInitData", fromHash);
      return fromHash || sessionStorage.getItem("tgInitData") || "";
    } catch (_) {
      return fromHash || "";
    }
  }
  const initData = getInitData();

  /* ---------------- API ---------------- */

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, {
        method: opts.method || "GET",
        headers: {
          Authorization: `tma ${initData}`,
          Accept: "application/json",
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
        credentials: "omit",
      });
    } catch (_) {
      throw new ApiError(0, "Internet aloqasini tekshiring.");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      if (res.status === 401 || res.status === 403) showGate(res.status);
      throw new ApiError(res.status, (data && data.message) || `Xatolik (${res.status})`);
    }
    return data;
  }

  /* ---------------- Formatlash ---------------- */

  const TZ = "Asia/Tashkent";
  const MON = ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"];
  const partsOf = (ms) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
        .formatToParts(ms).map((x) => [x.type, x.value]),
    );
  const fmtDateTime = (ms) => {
    const p = partsOf(ms);
    return `${Number(p.day)}-${MON[Number(p.month) - 1]}, ${p.hour}:${p.minute}`;
  };
  const fmtTime = (ms) => {
    const p = partsOf(ms);
    return `${p.hour}:${p.minute}`;
  };
  const dayKey = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(ms);

  function relTime(ms) {
    if (!ms) return "hali tekshirilmagan";
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return "hozirgina";
    if (s < 3600) return `${Math.floor(s / 60)} daqiqa oldin`;
    if (s < 86400) return `${Math.floor(s / 3600)} soat oldin`;
    return fmtDateTime(ms);
  }

  const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
  const fmtDate = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    return m ? `${+m[3]}-${MONTHS[+m[2] - 1]}, ${m[1]}` : iso || "—";
  };

  const KR = {
    "유학.연수": "O'qish / malaka oshirish", "유학": "O'qish", "연수": "Malaka oshirish", "취업": "Ishga kirish",
    "방문": "Tashrif", "관광": "Turizm", "접수": "Qabul qilingan", "심사중": "Ko'rib chiqilmoqda", "심사": "Ko'rib chiqilmoqda",
    "허가": "Ruxsat berilgan", "발급": "Viza berilgan", "불허": "Rad etilgan", "보완": "Qo'shimcha hujjat kerak",
    "반려": "Qaytarilgan", "취소": "Bekor qilingan",
  };
  const tr = (v) => (v ? (KR[v] ? `${KR[v]} · ${v}` : v) : "");

  /** Holat toifasi: issued | rejected | warn | progress | notfound | error | none */
  function category(p) {
    if (p.issued) return "issued";
    if (["불허", "반려", "취소"].includes(p.lastProgress)) return "rejected";
    if (p.lastProgress === "보완") return "warn";
    if (p.lastState === "done") return "progress";
    if (p.lastState === "not_found") return "notfound";
    if (p.lastError) return "error";
    return "none";
  }
  const BADGE = {
    issued: ["b-ok", "Viza chiqdi"], rejected: ["b-bad", "Rad etilgan"], warn: ["b-warn", "Hujjat kerak"],
    progress: ["b-info", null], notfound: ["b-bad", "Topilmadi"], error: ["b-warn", "Xato"], none: ["b-none", "Kutilmoqda"],
  };
  function badge(p) {
    const c = category(p);
    const [cls, label] = BADGE[c];
    return el("span", `badge ${cls}`, label || (KR[p.lastProgress] || p.lastStatus || "Jarayonda"));
  }

  /* ---------------- Holat ---------------- */

  let people = [];
  let filter = "all";
  let query = "";
  let current = null; // tafsilotda ochiq odam
  let pollTimer = null;

  const toastEl = $("toast");
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3200);
  }

  function showGate(status) {
    $("app").classList.add("hidden");
    $("gate").classList.remove("hidden");
    document.querySelector(".gate-mark").classList.remove("spin");
    if (!initData) {
      $("gateTitle").textContent = "Faqat Telegram orqali";
      $("gateText").textContent = "Admin panel faqat bot ichida ochiladi. Botda /admin buyrug'ini yuboring.";
    } else if (status === 403) {
      $("gateTitle").textContent = "Ruxsat yo'q";
      $("gateText").textContent = "Bu panel faqat administratorlar uchun.";
    } else {
      $("gateTitle").textContent = "Sessiya muddati tugagan";
      $("gateText").textContent = "Panelni bot orqali qaytadan oching (/admin).";
    }
  }

  /* ---------------- Ro'yxat ---------------- */

  const matches = (p) => {
    const c = category(p);
    if (filter === "issued" && c !== "issued") return false;
    if (filter === "progress" && !["progress", "warn", "none"].includes(c)) return false;
    if (filter === "problem" && !["notfound", "error", "rejected"].includes(c)) return false;
    if (!query) return true;
    const q = query.toUpperCase();
    return p.fullName.includes(q) || p.passport.includes(q) || (p.note || "").toUpperCase().includes(q);
  };

  function renderStats() {
    const count = (f) => people.filter((p) => f(category(p))).length;
    $("stAll").textContent = people.length;
    $("stIssued").textContent = count((c) => c === "issued");
    $("stProgress").textContent = count((c) => ["progress", "warn", "none"].includes(c));
    $("stProblem").textContent = count((c) => ["notfound", "error", "rejected"].includes(c));
    document.querySelectorAll(".stat").forEach((b) => b.classList.toggle("active", b.dataset.filter === filter && filter !== "all"));
  }

  function renderList() {
    const list = $("list");
    list.replaceChildren();
    const shown = people.filter(matches);
    shown.forEach((p, i) => {
      const b = el("button", "person");
      b.type = "button";
      b.style.animationDelay = `${Math.min(i, 12) * 30}ms`;
      const initials = (p.surname[0] || "") + (p.name[0] || "");
      b.append(el("span", "avatar", initials));
      const main = el("div", "p-main");
      main.append(el("div", "p-name", p.fullName));
      const sub = [p.passportMasked, relTime(p.lastCheckedAt)];
      if (p.note) sub.unshift(p.note);
      main.append(el("div", "p-sub", sub.join(" · ")));
      b.append(main, badge(p));
      b.addEventListener("click", () => openDetail(p.id));
      list.append(b);
    });
    $("empty").classList.toggle("hidden", people.length > 0);
    const fi = $("filterInfo");
    if (people.length && (filter !== "all" || query)) {
      fi.textContent = shown.length ? `${shown.length} ta natija` : "Hech narsa topilmadi";
      fi.classList.remove("hidden");
    } else fi.classList.add("hidden");
    renderStats();
  }

  async function loadPeople() {
    const d = await api("/api/people");
    people = d.people;
    renderList();
  }

  /* ---------------- Rejalashtirgich ---------------- */

  function renderSched(s) {
    const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    $("times").textContent = `Har kuni: ${s.checkTimes.map(fmtMin).join(", ")}`;
    if (s.nextRunAt) {
      const today = dayKey(Date.now()) === dayKey(s.nextRunAt);
      $("nextRun").textContent = `${today ? "Bugun" : "Ertaga"} ${fmtTime(s.nextRunAt)}`;
    }
    const run = $("runBox");
    if (s.running) {
      run.classList.remove("hidden");
      $("runBar").style.width = `${s.total ? Math.round((s.done / s.total) * 100) : 0}%`;
      $("runText").textContent = `Tekshirilmoqda: ${s.done} / ${s.total}`;
      $("checkAllBtn").disabled = true;
    } else {
      run.classList.add("hidden");
      $("checkAllBtn").disabled = false;
    }
  }

  async function loadStatus() {
    const d = await api("/api/status");
    renderSched(d.scheduler);
    clearTimeout(pollTimer);
    if (d.scheduler.running) {
      pollTimer = setTimeout(async () => {
        try {
          const wasRunning = d.scheduler.running;
          await loadStatus();
          if (wasRunning) await loadPeople();
        } catch (_) { /* keyingi safar */ }
      }, 4000);
    }
  }

  /* ---------------- Oynalar (sheet) ---------------- */

  function openSheet(id) {
    $(id).classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }
  function closeSheet(id) {
    $(id).classList.add("hidden");
    document.body.style.overflow = "";
    if (id === "detailSheet") current = null;
  }
  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => closeSheet(b.closest(".sheet").id)),
  );

  /* ---------------- Tafsilot ---------------- */

  function renderDetail(p, hist) {
    current = p;
    $("dName").textContent = p.fullName;

    const st = $("dStatus");
    st.replaceChildren();
    const c = category(p);
    const color = c === "issued" ? "#1f9d55" : c === "rejected" || c === "notfound" ? "#d64545" : c === "error" ? "#b26a00" : p.lastColor || "#9a9a9a";
    st.style.background = /^#[0-9a-f]{6}$/i.test(color) ? color : "#9a9a9a";
    st.append(el("small", "", "Oxirgi holat"));
    const title = c === "none" ? "Hali tekshirilmagan" : c === "notfound" ? "Ariza topilmadi" : c === "error" && !p.lastStatus ? "Tekshirib bo'lmadi" : p.lastStatus || tr(p.lastProgress);
    st.append(el("b", "", title));
    const text = c === "error" ? p.lastError : p.lastText;
    if (text) st.append(el("p", "", text));
    if (p.lastEta) st.append(el("p", "", `⏳ ${p.lastEta}`));

    const dl = $("dInfo");
    dl.replaceChildren();
    const rows = [
      ["Pasport", p.passport],
      ["Tug'ilgan sana", fmtDate(p.birthDate)],
      ["Ariza sanasi", p.lastAppDate ? fmtDate(p.lastAppDate) : ""],
      ["Viza turi", tr(p.lastVisaType)],
      ["Elchixonada", tr(p.lastProgress)],
      ["Izoh", p.note],
      ["Oxirgi tekshiruv", p.lastCheckedAt ? fmtDateTime(p.lastCheckedAt) : "—"],
      ["Qo'shilgan", fmtDateTime(p.createdAt)],
    ];
    if (p.lastError && c !== "error") rows.push(["Oxirgi xato", p.lastError]);
    for (const [k, v] of rows) {
      if (!v) continue;
      const row = el("div");
      row.append(el("dt", "", k), el("dd", "", v));
      dl.append(row);
    }

    const ul = $("dHistory");
    ul.replaceChildren();
    if (!hist.length) ul.append(el("li", "", "Hali tekshiruv bo'lmagan"));
    for (const h of hist) {
      const li = el("li");
      const label = h.state === "done" ? (h.status || tr(h.progress) || "Natija") : h.state === "not_found" ? "Topilmadi" : "Xato";
      li.append(el("span", "", fmtDateTime(h.at)), el("span", "", label));
      ul.append(li);
    }

    const del = $("dDelete");
    del.classList.remove("confirm");
    del.textContent = "O'chirish";
  }

  async function openDetail(id) {
    try {
      const d = await api(`/api/people/${id}`);
      renderDetail(d.person, d.history);
      openSheet("detailSheet");
    } catch (e) {
      toast(e.message);
    }
  }

  async function checkNow(id, btn) {
    const label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Tekshirilmoqda…"; }
    try {
      const d = await api(`/api/people/${id}/check`, { method: "POST", body: {} });
      const i = people.findIndex((x) => x.id === id);
      if (i >= 0) people[i] = d.person;
      renderList();
      if (current && current.id === id) renderDetail(d.person, d.history);
      toast(d.person.issued ? "🎉 Viza chiqqan!" : "Tekshiruv tugadi");
    } catch (e) {
      toast(e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  $("dCheck").addEventListener("click", (e) => current && checkNow(current.id, e.currentTarget));

  $("dDelete").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!current) return;
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm");
      btn.textContent = "Tasdiqlang";
      setTimeout(() => { btn.classList.remove("confirm"); btn.textContent = "O'chirish"; }, 4000);
      return;
    }
    try {
      await api(`/api/people/${current.id}`, { method: "DELETE" });
      people = people.filter((p) => p.id !== current.id);
      closeSheet("detailSheet");
      renderList();
      toast("O'chirildi");
    } catch (err) {
      toast(err.message);
    }
  });

  /* ---------------- Qo'shish ---------------- */

  const form = $("addForm");
  const latin = (v) => v.replace(/[^A-Za-z\s'`ʻʼ‘’-]/g, "");
  form.passport.addEventListener("input", () => { form.passport.value = form.passport.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
  ["surname", "name", "patronymic"].forEach((n) => form[n].addEventListener("input", () => { form[n].value = latin(form[n].value); }));
  form.birthDate.max = new Date().toISOString().slice(0, 10);

  $("addBtn").addEventListener("click", () => {
    form.reset();
    $("addError").classList.add("hidden");
    openSheet("addSheet");
    setTimeout(() => form.passport.focus(), 250);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("addError");
    err.classList.add("hidden");
    const body = {
      passport: form.passport.value,
      surname: form.surname.value,
      name: form.name.value,
      patronymic: form.patronymic.value,
      birthDate: form.birthDate.value,
      note: form.note.value,
    };
    const btn = $("addSubmit");
    btn.disabled = true;
    try {
      const d = await api("/api/people", { method: "POST", body });
      people.unshift(d.person);
      renderList();
      closeSheet("addSheet");
      toast("Qo'shildi");
      if (form.checkNow.checked) checkNow(d.person.id);
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------- Boshqalar ---------------- */

  $("search").addEventListener("input", (e) => { query = e.target.value.trim(); renderList(); });
  document.querySelectorAll(".stat").forEach((b) =>
    b.addEventListener("click", () => { filter = filter === b.dataset.filter ? "all" : b.dataset.filter; renderList(); }),
  );

  $("checkAllBtn").addEventListener("click", async () => {
    try {
      const d = await api("/api/check-all", { method: "POST", body: {} });
      toast(d.message);
      renderSched(d.scheduler);
      loadStatus();
    } catch (e) {
      toast(e.message);
    }
  });

  $("refreshBtn").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.classList.add("loading");
    try { await Promise.all([loadPeople(), loadStatus()]); } catch (err) { toast(err.message); }
    b.classList.remove("loading");
  });

  /* ---------------- Ishga tushirish ---------------- */

  async function start() {
    tgPost("web_app_ready");
    tgPost("web_app_expand");
    if (!initData) return showGate(0);
    try {
      const me = await api("/api/me");
      $("hello").textContent = `Salom, ${me.admin.firstName || "admin"} · Turan Int. School`;
      await Promise.all([loadPeople(), loadStatus()]);
      $("gate").classList.add("hidden");
      $("app").classList.remove("hidden");
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) {
        $("gateTitle").textContent = "Xatolik";
        $("gateText").textContent = e.message;
      }
    }
  }

  start();
})();
