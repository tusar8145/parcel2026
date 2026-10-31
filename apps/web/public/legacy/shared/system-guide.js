/*
 * System guide (GET /guide, from packages/shared/src/system-guide.ts): what the platform's numbers (PP, MR, HS…),
 * the parcel lifecycle and how SMS / email / push reach each panel and app (both in Bangla, with the option names as
 * on screen), money steps and roles, and where things are changed. Tabs: Numbers · Parcel lifecycle · Notifications ·
 * Money flow · Roles · Where to change. Used by super admin › System guide (super-admin/bridge-guide.js) and
 * Courier Operations › Settings › System guide (a dialog, courier-operation/bridge-guide.js).
 *   DF.systemGuide.mount(element)   draws the guide into element (loads it once)
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const TABS = [
    ["numbers", "Numbers"],
    ["lifecycle", "Parcel lifecycle"],
    ["notifications", "Notifications"],
    ["money", "Money flow"],
    ["roles", "Roles"],
    ["settings", "Where to change"],
  ];
  const S = { data: null, error: "", tab: "numbers", q: "", area: "" };
  let host = null;

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="sgStyles">
.sg{display:grid;gap:14px}
.sg-tabs{display:inline-flex;gap:4px;flex-wrap:wrap;padding:4px;border-radius:11px;background:#eef1f5;max-width:100%;justify-self:start}
.sg-tabs button{border:0;background:transparent;color:#556274;padding:7px 13px;border-radius:8px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.sg-tabs button:hover{background:#e3e7ee;color:#1d2939}
.sg-tabs button[aria-selected="true"]{background:#fff;color:#2f55c9;box-shadow:0 1px 2px rgba(16,24,40,.08),0 1px 3px rgba(16,24,40,.06)}
.sg-card{border:1px solid #e6e9ef;border-radius:14px;background:#fff;overflow:hidden}
.sg-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid #eef0f4}
.sg-head h3{margin:0;font-size:15px;color:#1d2939}
.sg-head p{margin:2px 0 0;color:#667085;font-size:12.5px}
.sg-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.sg-tools input{height:34px;min-width:220px;border:1px solid #dfe4ec;border-radius:8px;padding:0 10px;font:inherit;font-size:13px}
.sg-chip{border:1px solid #dfe4ec;background:#fff;color:#475467;border-radius:999px;padding:5px 11px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.sg-chip[aria-pressed="true"]{background:#eff4ff;border-color:#b2c5f5;color:#2f55c9}
.sg table{width:100%;border-collapse:collapse;font-size:13px}
.sg th{text-align:left;padding:10px 14px;background:#f8fafc;color:#667085;font-size:11.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;border-bottom:1px solid #eef0f4}
.sg td{padding:11px 14px;border-bottom:1px solid #f1f3f6;vertical-align:top;color:#344054;line-height:1.45}
.sg tr:last-child td{border-bottom:0}
.sg .sg-prefix{display:inline-block;padding:3px 9px;border-radius:7px;background:#1d2939;color:#fff;font:700 12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}
.sg .sg-prefix.manual{background:#eef1f5;color:#344054}
.sg code{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#2f55c9;background:#f5f8ff;padding:1px 5px;border-radius:5px;white-space:nowrap}
.sg .sub{display:block;color:#667085;font-size:12px;margin-top:2px}
.sg .sg-pill{display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;border-radius:999px;background:#f2f4f7;color:#344054;font-size:11.5px;font-weight:600;white-space:nowrap}
.sg-steps{display:grid;gap:10px;padding:14px 16px}
.sg-step{display:grid;grid-template-columns:34px 1fr auto;gap:12px;align-items:start;padding:12px 14px;border:1px solid #e6e9ef;border-radius:12px}
.sg-step b.n{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#eff4ff;color:#2f55c9;font-size:13px}
.sg-step strong{display:block;color:#1d2939;font-size:14px}
.sg-step span{color:#475467;font-size:13px}
.sg-roles{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;padding:14px 16px}
.sg-role{border:1px solid #e6e9ef;border-radius:12px;padding:12px 14px;display:grid;gap:6px;align-content:start}
.sg-role strong{color:#1d2939}
.sg-role details summary{cursor:pointer;color:#2f55c9;font-size:12.5px;font-weight:600}
.sg table{table-layout:fixed}
.sg td,.sg td span{white-space:normal;overflow-wrap:anywhere}
.sg .sub b{color:#475467;font-weight:600}
.sg-empty{padding:16px;color:#667085;font-size:13px;text-align:center}
.sg-bn td,.sg-bn p,.sg-bn li{line-height:1.6}
.sg-actor{display:inline-block;margin:1px 4px 1px 0;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap}
.sg-actor.MERCHANT{background:#f4ebff;color:#6941c6}.sg-actor.OPERATIONS{background:#eff4ff;color:#2f55c9}.sg-actor.RIDER{background:#fff4e5;color:#b54708}.sg-actor.SYSTEM{background:#f2f4f7;color:#475467}.sg-actor.CUSTOMER{background:#ecfdf3;color:#067647}
.sg-legend{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px 16px;padding:14px 16px}
.sg-legend div{display:grid;gap:3px;justify-items:start;color:#475467;font-size:13px}
.sg-stage-n{display:inline-grid;place-items:center;width:26px;height:26px;margin-right:8px;border-radius:50%;background:#2f55c9;color:#fff;font-size:13px;vertical-align:middle}
.sg-way{padding:12px 16px 4px}
.sg-way h4{margin:0 0 8px;color:#1d2939;font-size:14px}
.sg-way table{border:1px solid #eef0f4}
.sg-status{display:inline-block;padding:2px 8px;border-radius:7px;background:#f8fafc;border:1px solid #e6e9ef;color:#1d2939;font-size:12px;font-weight:600}
.sg-note{margin:8px 16px 12px;padding:9px 12px;border-left:3px solid #fcc118;border-radius:6px;background:#fffaeb;color:#7a5b00;font-size:13px}
.sg-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;padding:14px 16px}
.sg-cols ul{margin:6px 0 0;padding-left:18px;color:#475467;font-size:13px}
.sg-cols li{margin:4px 0}
.sg-bottom{margin:0 16px 14px;padding:11px 13px;border-radius:10px;background:#eff4ff;color:#1d2939;font-size:13.5px}
.sg-dash{color:#98a2b3}
@media(max-width:720px){.sg-tools input{min-width:0;width:100%}.sg-step{grid-template-columns:30px 1fr}.sg-step code{grid-column:2}}
</style>`,
  );

  const pills = list => (list.length ? list.map(x => `<span class="sg-pill">${esc(x)}</span>`).join("") : `<span class="sub">—</span>`);

  function numbersHtml(d) {
    const areas = [...new Set(d.numbers.map(n => n.area))];
    const words = S.q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = d.numbers
      .filter(n => (!S.area || n.area === S.area) && words.every(w => `${n.prefix} ${n.name} ${n.meaning} ${n.where} ${n.example}`.toLowerCase().includes(w)))
      .map(
        n => `<tr><td><span class="sg-prefix${n.manual ? " manual" : ""}">${esc(n.prefix)}</span></td><td><strong>${esc(n.name)}</strong><span class="sub">${esc(n.area)}</span></td><td><code>${esc(n.example)}</code><span class="sub">${esc(n.format)}</span></td><td>${esc(n.meaning)}<span class="sub"><b>Made:</b> ${esc(n.created)}</span><span class="sub"><b>Where:</b> ${esc(n.where)}</span></td></tr>`,
      )
      .join("");
    return `<div class="sg-card"><div class="sg-head"><div><h3>Numbers and codes</h3><p>What each prefix means, when it is made and where to find it. YYMMDD = the day (Dhaka), YYMM = the month, NNNN = running number.</p></div>
      <div class="sg-tools"><input type="search" data-sg-q placeholder="Search: PP, slip, bill…" value="${esc(S.q)}" aria-label="Search numbers"><button type="button" class="sg-chip" data-sg-area="" aria-pressed="${!S.area}">All</button>${areas.map(a => `<button type="button" class="sg-chip" data-sg-area="${esc(a)}" aria-pressed="${S.area === a}">${esc(a)}</button>`).join("")}</div></div>
      <div style="overflow:auto"><table><thead><tr><th style="width:90px">Prefix</th><th style="width:22%">Name</th><th style="width:20%">Example</th><th>Meaning</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="sg-empty">Nothing matches.</td></tr>`}</tbody></table></div></div>`;
  }

  // Option names in **bold** in the guide's own text (escaped first).
  const rich = v => esc(v).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const actor = (d, key) => `<span class="sg-actor ${esc(key)}">${esc(d.actors?.[key]?.label || key)}</span>`;
  const cell = v => (!v || v === "—" ? `<span class="sg-dash">—</span>` : esc(v));
  const notes = list => (list || []).map(n => `<div class="sg-note">${rich(n)}</div>`).join("");

  function lifecycleHtml(d) {
    const L = d.lifecycle;
    const legend = `<div class="sg-legend">${Object.keys(d.actors).map(key => `<div>${actor(d, key)}<span>${rich(d.actors[key].where)}</span></div>`).join("")}</div>`;
    const step = (st, j) =>
      `<tr><td>${j + 1}</td><td>${st.actors.map(a => actor(d, a)).join(`<span class="sub" style="display:inline">অথবা </span>`)}</td><td>${rich(st.where)}</td><td>${rich(st.what)}</td><td>${st.status ? `<span class="sg-status">${esc(st.status)}</span>` : `<span class="sg-dash">একই থাকে</span>`}</td></tr>`;
    const way = w =>
      `<div class="sg-way"><h4>${esc(w.title)}</h4><div style="overflow:auto"><table><thead><tr><th style="width:44px">#</th><th style="width:150px">কে</th><th style="width:30%">কোথায় / Option</th><th>কী হয়</th><th style="width:22%">স্ট্যাটাস</th></tr></thead><tbody>${w.steps.map(step).join("")}</tbody></table></div></div>${notes(w.notes)}`;
    const stages = L.stages
      .map((stage, i) => `<div class="sg-card"><div class="sg-head"><div><h3><span class="sg-stage-n">${i + 1}</span>${esc(stage.title)}</h3><p>${esc(stage.summary)}</p></div></div>${stage.ways.map(way).join("")}${notes(stage.notes)}</div>`)
      .join("");
    const journeys = `<div class="sg-card"><div class="sg-head"><div><h3>তিন ধরনের পার্সেল কোন পথে যায়</h3></div></div><div style="overflow:auto"><table><thead><tr><th>ধরন</th><th>First mile</th><th>Middle mile</th><th>Last mile</th></tr></thead><tbody>${L.journeys
      .map(j => `<tr><td><strong>${esc(j.name)}</strong></td><td>${esc(j.first)}</td><td>${esc(j.middle)}</td><td>${esc(j.last)}</td></tr>`)
      .join("")}</tbody></table></div></div>`;
    const tasks = `<div class="sg-card"><div class="sg-head"><div><h3>এক নজরে: কে কী করেন</h3></div></div><div class="sg-cols">${L.tasks
      .map(t => `<div>${actor(d, t.actor)}<ul>${t.items.map(([option, what]) => `<li><b>${esc(option)}</b>: ${esc(what)}</li>`).join("")}</ul></div>`)
      .join("")}</div><div class="sg-bottom"><b>মূল কথা:</b> ${esc(L.bottomLine)}</div></div>`;
    return `<div class="sg sg-bn"><div class="sg-card"><div class="sg-head"><div><h3>পার্সেল লাইফসাইকেল</h3><p>পার্সেল তিন ভাগে যায়: First mile (প্রথম হাবে আসা), Middle mile (হাব থেকে হাবে), Last mile (গ্রাহকের হাতে)। প্রতিটি ধাপে কে আর কোথায় কাজটি করেন, নিচে দেওয়া আছে।</p></div></div>${legend}</div>${stages}${journeys}${tasks}</div>`;
  }

  function notificationsHtml(d) {
    const N = d.notifications;
    const channels = `<div class="sg-card"><div class="sg-head"><div><h3>কোন মাধ্যমে কী যায়</h3><p>SMS, Email, Push আর প্যানেলের Bell: কে পান আর কীভাবে আসে।</p></div></div><div style="overflow:auto"><table><thead><tr><th style="width:130px">মাধ্যম</th><th style="width:30%">কে পান</th><th>কীভাবে</th></tr></thead><tbody>${N.channels
      .map(c => `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.to)}</td><td>${esc(c.detail)}</td></tr>`)
      .join("")}</tbody></table></div></div>`;
    const moments = `<div class="sg-card"><div class="sg-head"><div><h3>পার্সেল লাইফসাইকেলের সাথে</h3><p>প্রেরক = যিনি পার্সেল পাঠান (মার্চেন্ট বা গ্রাহক), প্রাপক = যিনি পার্সেল পান। "—" মানে কিছু যায় না।</p></div></div><div style="overflow:auto"><table><thead><tr><th style="width:110px">ভাগ</th><th style="width:20%">ধাপ (স্ট্যাটাস)</th><th>SMS</th><th>Email</th><th>Push ও Bell</th></tr></thead><tbody>${N.moments
      .map(m => `<tr><td><span class="sub" style="margin:0">${esc(m.stage)}</span></td><td><span class="sg-status">${esc(m.moment)}</span></td><td>${cell(m.sms)}</td><td>${cell(m.email)}</td><td>${cell(m.push)}</td></tr>`)
      .join("")}</tbody></table></div></div>`;
    const apps = `<div class="sg-card"><div class="sg-head"><div><h3>প্যানেল ও অ্যাপ অনুযায়ী</h3></div></div><div style="overflow:auto"><table><tbody>${N.apps
      .map(a => `<tr><td style="width:28%"><strong>${esc(a.app)}</strong></td><td>${esc(a.gets)}</td></tr>`)
      .join("")}</tbody></table></div></div>`;
    const rules = `<div class="sg-card"><div class="sg-head"><div><h3>নিয়ম</h3></div></div><div class="sg-cols" style="grid-template-columns:1fr"><ul style="margin:0">${N.rules.map(r => `<li>${rich(r)}</li>`).join("")}</ul></div></div>`;
    return `<div class="sg sg-bn">${channels}${moments}${apps}${rules}</div>`;
  }

  function moneyHtml(d) {
    return `<div class="sg-card"><div class="sg-head"><div><h3>Money flow</h3><p>How COD and charges move from the parcel to the merchant (Courier Operations › Accounts).</p></div></div>
      <div class="sg-steps">${d.money.map((m, i) => `<div class="sg-step"><b class="n">${i + 1}</b><div><strong>${esc(m.step)}</strong><span>${esc(m.detail)}</span></div>${m.number ? `<code>${esc(m.number)}</code>` : "<span></span>"}</div>`).join("")}</div></div>`;
  }

  function rolesHtml(d) {
    return `<div class="sg-card"><div class="sg-head"><div><h3>Roles</h3><p>Who does what, and which panel each role signs in to. Permissions can be changed in super admin › Admin users & roles.</p></div></div>
      <div class="sg-roles">${d.roles
        .map(
          r => `<div class="sg-role"><strong>${esc(r.label)}</strong><span class="sub" style="margin:0">${r.panel ? `Panel: <code>${esc(r.panel)}</code>` : "No panel"}</span><span style="color:#475467;font-size:13px">${esc(r.description)}</span><details><summary>${r.permissions.length} permission${r.permissions.length === 1 ? "" : "s"}</summary><div style="margin-top:6px">${pills(r.permissions)}</div></details></div>`,
        )
        .join("")}</div></div>`;
  }

  function settingsHtml(d) {
    return `<div class="sg-card"><div class="sg-head"><div><h3>Where to change things</h3><p>The page where each setting lives.</p></div></div>
      <div style="overflow:auto"><table><thead><tr><th>What</th><th>Where</th></tr></thead><tbody>${d.settings.map(s => `<tr><td><strong>${esc(s.what)}</strong></td><td>${esc(s.where)}</td></tr>`).join("")}</tbody></table></div></div>`;
  }

  function paint() {
    if (!host?.isConnected) return;
    const d = S.data;
    const body = !d ? `<div class="sg-card sg-empty">${esc(S.error || "Loading the guide…")}</div>` : { numbers: numbersHtml, lifecycle: lifecycleHtml, notifications: notificationsHtml, money: moneyHtml, roles: rolesHtml, settings: settingsHtml }[S.tab](d);
    host.innerHTML = `<div class="sg"><div class="sg-tabs" role="tablist" aria-label="System guide">${TABS.map(([k, label]) => `<button type="button" role="tab" data-sg-tab="${k}" aria-selected="${k === S.tab}">${label}</button>`).join("")}</div>${body}</div>`;
  }

  async function mount(element) {
    host = element;
    paint();
    if (S.data) return;
    try {
      S.data = await DF.api("/guide");
      S.error = "";
    } catch (error) {
      S.error = DF.describe(error);
    }
    paint();
  }

  document.addEventListener("click", event => {
    const t = event.target instanceof Element ? event.target : null;
    if (!t || !host?.contains(t)) return;
    let el;
    if ((el = t.closest("[data-sg-tab]"))) {
      S.tab = el.dataset.sgTab;
      return paint();
    }
    if ((el = t.closest("[data-sg-area]"))) {
      S.area = el.dataset.sgArea;
      return paint();
    }
  });
  document.addEventListener("input", event => {
    const t = event.target;
    if (!(t instanceof HTMLInputElement) || !t.matches("[data-sg-q]") || !host?.contains(t)) return;
    S.q = t.value;
    const at = t.selectionStart;
    paint();
    const input = host.querySelector("[data-sg-q]");
    input?.focus();
    input?.setSelectionRange(at, at);
  });

  DF.systemGuide = { mount };
})();
