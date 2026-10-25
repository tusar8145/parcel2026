/*
 * System guide (GET /guide, from packages/shared/src/system-guide.ts): what the platform's numbers (PP, MR, HS…),
 * parcel statuses, money steps and roles mean, and where things are changed. Tabs: Numbers · Parcel statuses ·
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
    ["statuses", "Parcel statuses"],
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
.sg .sg-pill.final{background:#ecfdf3;color:#067647}
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
.sg .sg-next{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin-bottom:4px}
.sg .sg-next b{min-width:84px;color:#667085;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.sg .sub b{color:#475467;font-weight:600}
.sg-empty{padding:16px;color:#667085;font-size:13px;text-align:center}
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

  function statusesHtml(d) {
    const rows = d.statuses
      .map(
        s => `<tr><td><strong>${esc(s.label)}</strong>${s.final ? ` <span class="sg-pill final">Final</span>` : ""}<span class="sub"><code>${esc(s.status)}</code></span></td><td>${esc(s.meaning)}</td><td>${s.final ? `<span class="sub">Nothing: the parcel's journey ends here.</span>` : `<div class="sg-next"><b>Operations</b>${pills(s.next.operations)}</div><div class="sg-next"><b>Rider</b>${pills(s.next.rider)}</div>`}</td></tr>`,
      )
      .join("");
    return `<div class="sg-card"><div class="sg-head"><div><h3>Parcel statuses</h3><p>Every status a parcel can have, and what operations and the rider can move it to next.</p></div></div>
      <div style="overflow:auto"><table><thead><tr><th style="width:24%">Status</th><th style="width:34%">Meaning</th><th>Can move to next</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
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
    const body = !d ? `<div class="sg-card sg-empty">${esc(S.error || "Loading the guide…")}</div>` : { numbers: numbersHtml, statuses: statusesHtml, money: moneyHtml, roles: rolesHtml, settings: settingsHtml }[S.tab](d);
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
