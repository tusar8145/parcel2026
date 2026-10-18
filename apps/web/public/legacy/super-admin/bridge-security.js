/*
 * Super admin: platform security on the API.
 *
 * - Admin users & roles: real two-step verification coverage, "my two-step verification"
 *   (shared/mfa.js), MFA reset for other users, the permission matrix (built-in roles with
 *   overrides and custom roles), the maker-checker queue of pending changes, and support
 *   access ("view as" another user, read-only by default, time-limited, reason required).
 * - Platform activity: the website traffic chart, visits, sources and tracking lookups come
 *   from first-party analytics (GET /analytics/traffic).
 * - Audit log and Platform settings: MFA coverage and security alerts from real data.
 * Loaded after bridge.js; wraps showPage again and adds to what it rendered.
 */
(() => {
  const DF = window.DF;
  const STAFF_ROLES = ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"];
  const ROLE_NAME = {
    CUSTOMER: "Customer",
    MERCHANT_OWNER: "Merchant owner",
    MERCHANT_STAFF: "Merchant staff",
    RIDER: "Rider",
    HUB_OPERATOR: "Hub manager",
    OPS_MANAGER: "Operations admin",
    FINANCE: "Finance admin",
    SUPPORT_AGENT: "Merchant support",
    SUPER_ADMIN: "Super admin",
  };
  const ALERT_ACTIONS = new Set(["auth.locked", "auth.mfa_locked", "auth.mfa_failed", "auth.login_failed"]);
  const me = () => DF.auth.user;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = n => Number(n || 0).toLocaleString("en-US");
  const fail = error => showToast(DF.describe(error));
  const when = iso =>
    iso ? new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Dhaka", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
  const can = permission => me()?.roles?.includes("SUPER_ADMIN") || false; // the panel is super admin only; the API checks the rest

  const SEC = { staff: [], roles: null, changes: [], recentChanges: [], supportSessions: [], traffic: null, overview: null, alerts: null };
  let page = "Overview";

  async function all(path) {
    const items = [];
    let cursor = null;
    do {
      const res = await DF.api(`${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? `&cursor=${cursor}` : ""}`);
      items.push(...res.items);
      cursor = res.nextCursor;
    } while (cursor && items.length < 2000);
    return items;
  }
  const loaders = {
    staff: async () => (SEC.staff = await all(`/users?roles=${STAFF_ROLES.join(",")}`)),
    roles: async () => (SEC.roles = await DF.api("/admin/roles")),
    changes: async () => {
      SEC.changes = (await DF.api("/admin/changes?status=PENDING&limit=50")).items;
      SEC.recentChanges = (await DF.api("/admin/changes?limit=10")).items.filter(c => c.status !== "PENDING");
    },
    support: async () => (SEC.supportSessions = (await DF.api("/admin/impersonations?limit=10")).items),
    traffic: async () => (SEC.traffic = await DF.api("/analytics/traffic?days=14")),
    overview: async () => (SEC.overview = await DF.api("/admin/overview")),
    alerts: async () => {
      const since = new Date(Date.now() - 7 * 864e5).toISOString();
      const items = (await DF.api(`/audit-logs?action=auth.&from=${encodeURIComponent(since)}&limit=200`)).items;
      SEC.alerts = items.filter(a => ALERT_ACTIONS.has(a.action));
    },
  };
  const load = (...names) => Promise.allSettled(names.map(n => loaders[n]())).then(results => results.find(r => r.status === "rejected")?.reason);

  // ───────────── page decorations ─────────────
  const $ = selector => document.querySelector(`#mainContent ${selector}`);
  function setMetric(index, value, trend, note) {
    const metric = document.querySelectorAll("#mainContent .metrics .metric")[index];
    if (!metric) return;
    metric.querySelector(".metric-value").textContent = value;
    const foot = metric.querySelectorAll(".metric-foot span");
    if (trend !== undefined && foot[0]) foot[0].textContent = trend;
    if (note !== undefined && foot[1]) foot[1].textContent = note;
    const label = metric.querySelector(".metric-label");
    return label;
  }

  function mfaCoverage() {
    const active = SEC.staff.filter(u => u.status === "ACTIVE");
    const supers = active.filter(u => u.roles.some(r => r.role === "SUPER_ADMIN"));
    return {
      staff: active.length,
      staffOn: active.filter(u => u.mfa?.enabled).length,
      supers: supers.length,
      supersOn: supers.filter(u => u.mfa?.enabled).length,
    };
  }
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");

  function decorate() {
    if (page === "Admin users") decorateAdmins();
    if (page === "Platform activity") decorateTraffic();
    if (page === "Audit log") decorateAudit();
    if (page === "Platform settings") decorateSettings();
  }

  // ── Admin users & roles ──
  function decorateAdmins() {
    const c = mfaCoverage();
    const callout = $(".callout");
    if (callout)
      callout.lastChild.textContent = ` Super admin actions are audited. Two-step verification is required for super admins (${c.supersOn} of ${c.supers} set up) and optional for other staff (${c.staffOn - c.supersOn} of ${c.staff - c.supers}). Sensitive changes need a second super admin's approval.`;
    const subtitle = $(".table-panel .panel-subtitle");
    if (subtitle) subtitle.textContent = `${SEC.staff.length} administrators · ${c.staffOn} with two-step verification`;
    // Two-step status and actions per administrator (rows follow the same /users order as bridge.js).
    const rows = document.querySelectorAll("#adminBody tr");
    const order = SEC.staff;
    rows.forEach((row, i) => {
      const u = order[i];
      if (!u || row.dataset.dfSec) return;
      row.dataset.dfSec = "1";
      const cells = row.querySelectorAll("td");
      const status = cells[3];
      if (status)
        status.insertAdjacentHTML(
          "beforeend",
          `<span class="subcell">${u.mfa?.enabled ? "Two-step on" : u.mfa?.required ? "Two-step: set up at next sign-in" : "Two-step off"}</span>`,
        );
      const actions = cells[5];
      if (!actions) return;
      if (u.mfa?.enabled && u.id !== me()?.id)
        actions.insertAdjacentHTML("beforeend", ` <button class="mini-button" data-sec-reset-mfa="${esc(u.id)}" title="Lost device: turn off two-step verification">Reset 2FA</button>`);
    });
    renderSecuritySections();
  }

  function renderSecuritySections() {
    document.getElementById("dfSecurity")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "dfSecurity";
    wrap.innerHTML = [myAccountPanel(), changesPanel(), matrixPanel(), customRolesPanel(), supportPanel()].join("");
    document.getElementById("mainContent").append(wrap);
  }

  function myAccountPanel() {
    const user = me();
    const on = SEC.staff.find(u => u.id === user?.id)?.mfa?.enabled;
    return `<section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h2 class="panel-title">Your sign-in security</h2><p class="panel-subtitle">Two-step verification is ${on ? "on" : "not set up yet"} for ${esc(user?.name || "your account")}. Super admins must use it.</p></div><button class="button button-primary" data-sec-my-mfa>${on ? "Manage two-step verification" : "Set up two-step verification"}</button></div></section>`;
  }

  const KIND_LABEL = {
    "rate_card.create": "Rate card",
    "rate_card.deactivate": "Rate card",
    "merchant_rate.set": "Merchant tariff",
    "role.permissions": "Role permissions",
    "custom_role.create": "Custom role",
    "custom_role.update": "Custom role",
    "custom_role.delete": "Custom role",
  };
  const STATUS_PILL = { PENDING: "status-warn", APPROVED: "status-good", REJECTED: "status-bad", CANCELLED: "status-blue", EXPIRED: "status-blue", FAILED: "status-bad" };
  function changesPanel() {
    const rows = [...SEC.changes, ...SEC.recentChanges];
    const body = rows.length
      ? rows
          .map(
            c => `<tr><td class="primary-cell">${esc(c.summary)}<span class="subcell">${esc(KIND_LABEL[c.kind] || c.kind)}</span></td><td>${esc(c.requestedBy.name)}<span class="subcell">${when(c.createdAt)}</span></td><td><span class="status ${STATUS_PILL[c.status] || ""}">${esc(c.status.charAt(0) + c.status.slice(1).toLowerCase())}</span>${
              c.reviewedBy ? `<span class="subcell">${esc(c.reviewedBy.name)}${c.reviewNote ? ` · ${esc(c.reviewNote)}` : ""}</span>` : c.error ? `<span class="subcell">${esc(c.error)}</span>` : ""
            }</td><td>${
              c.status === "PENDING"
                ? `${c.canApprove ? `<button class="mini-button" data-sec-approve="${esc(c.id)}">Approve</button> <button class="mini-button" data-sec-reject="${esc(c.id)}">Reject</button>` : ""}${
                    c.canCancel ? `<button class="mini-button" data-sec-cancel="${esc(c.id)}">Withdraw</button>` : ""
                  }${!c.canApprove && !c.canCancel ? `<span class="subcell">Waiting for another super admin</span>` : ""}`
                : ""
            }</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="4" class="empty-state">No changes waiting for approval.</td></tr>`;
    return `<section class="panel table-panel" style="margin-top:16px" id="dfChanges"><div class="panel-heading"><div><h2 class="panel-title">Changes waiting for approval</h2><p class="panel-subtitle">Rate cards, merchant tariffs, role permissions and custom roles need a second super admin (maker-checker). ${SEC.changes.length} pending.</p></div></div><div class="table-scroll"><table><thead><tr><th>CHANGE</th><th>REQUESTED BY</th><th>STATUS</th><th></th></tr></thead><tbody>${body}</tbody></table></div></section>`;
  }

  function matrixPanel() {
    const r = SEC.roles;
    if (!r) return "";
    const columns = [...r.builtInRoles.map(b => ({ key: b.role, label: ROLE_NAME[b.role] || b.role, perms: new Set(b.permissions), locked: new Set(b.locked), builtIn: true, users: b.users, changed: b.granted.length + b.revoked.length })), ...r.customRoles.map(c => ({ key: `custom:${c.id}`, id: c.id, label: c.name, perms: new Set(c.permissions), locked: new Set(), builtIn: false, users: c.users, active: c.active }))];
    let group = "";
    const body = r.permissions
      .map(p => {
        const head = p.group !== group ? `<tr><th colspan="${columns.length + 1}" style="text-align:left;background:#f8fafc">${esc((group = p.group))}</th></tr>` : "";
        const cells = columns
          .map(col => {
            const reserved = p.superAdminOnly && col.key !== "SUPER_ADMIN";
            const locked = col.locked.has(p.key) || reserved;
            return `<td style="text-align:center"><input type="checkbox" aria-label="${esc(col.label)}: ${esc(p.label)}" data-sec-perm="${esc(p.key)}" data-sec-col="${esc(col.key)}" ${col.perms.has(p.key) ? "checked" : ""} ${locked ? "disabled" : ""} title="${locked ? (reserved ? "Only super admins can hold this" : "Super admins always keep this") : ""}"></td>`;
          })
          .join("");
        return `${head}<tr><td class="primary-cell">${esc(p.label)}<span class="subcell">${esc(p.key)}</span></td>${cells}</tr>`;
      })
      .join("");
    const headers = columns
      .map(col => `<th style="text-align:center;white-space:nowrap">${esc(col.label)}<span class="subcell">${col.builtIn ? "built-in" : col.active ? "custom" : "custom · inactive"} · ${num(col.users)} user${col.users === 1 ? "" : "s"}${col.changed ? " · edited" : ""}</span></th>`)
      .join("");
    const saves = columns.map(col => `<td style="text-align:center"><button class="mini-button" data-sec-save-col="${esc(col.key)}">Save</button></td>`).join("");
    return `<section class="panel table-panel" style="margin-top:16px" id="dfMatrix"><div class="panel-heading"><div><h2 class="panel-title">Roles and permissions</h2><p class="panel-subtitle">Tick what each role may do, then save that column. Changes take effect on the next request for everyone holding the role, after a second super admin approves them.</p></div></div><div class="table-scroll"><table><thead><tr><th>PERMISSION</th>${headers}</tr></thead><tbody>${body}<tr><td></td>${saves}</tr></tbody></table></div></section>`;
  }

  function customRolesPanel() {
    const r = SEC.roles;
    if (!r) return "";
    const rows = r.customRoles.length
      ? r.customRoles
          .map(
            c => `<tr><td class="primary-cell">${esc(c.name)}<span class="subcell">${esc(c.description || "No description")}</span></td><td>${esc(ROLE_NAME[c.baseRole] || c.baseRole)}</td><td>${num(c.permissions.length)}</td><td>${num(c.users)}</td><td><span class="status ${c.active ? "status-good" : "status-blue"}">${c.active ? "Active" : "Inactive"}</span></td><td><button class="mini-button" data-sec-toggle-role="${esc(c.id)}" data-active="${c.active}">${c.active ? "Deactivate" : "Activate"}</button> <button class="mini-button" data-sec-delete-role="${esc(c.id)}">Delete</button></td></tr>`,
          )
          .join("")
      : `<tr><td colspan="6" class="empty-state">No custom roles yet.</td></tr>`;
    const bases = r.customRoleBases.map(b => `<option value="${b}">${esc(ROLE_NAME[b] || b)}</option>`).join("");
    return `<section class="panel table-panel" style="margin-top:16px"><div class="panel-heading"><div><h2 class="panel-title">Custom roles</h2><p class="panel-subtitle">A custom role opens the panel of its base role (scoped to a merchant or hub where the base role is) with exactly the permissions ticked in the matrix. Grant it from a user's roles (POST /users/:id/roles with customRoleId).</p></div></div><div class="table-scroll"><table><thead><tr><th>ROLE</th><th>BASED ON</th><th>PERMISSIONS</th><th>USERS</th><th>STATUS</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <form id="dfCustomRoleForm" class="form-grid" style="padding:16px" novalidate><div class="field"><label for="dfRoleName">Name</label><input id="dfRoleName" required maxlength="60" placeholder="e.g. Billing viewer"></div><div class="field"><label for="dfRoleBase">Based on</label><select id="dfRoleBase">${bases}</select></div><div class="field full"><label for="dfRoleDesc">Description</label><input id="dfRoleDesc" maxlength="300" placeholder="What this role is for"></div><div class="field full"><button class="button button-primary" type="submit">Create role with the base role's permissions</button></div></form></section>`;
  }

  function supportPanel() {
    const rows = SEC.supportSessions.length
      ? SEC.supportSessions
          .map(
            s => `<tr><td class="primary-cell">${esc(s.target.name)}<span class="subcell">${esc(s.reason)}</span></td><td>${esc(s.admin.name)}${s.admin.role ? `<span class="subcell">${esc(s.admin.role)}</span>` : ""}</td><td>${s.readOnly ? "Read-only" : "Full access"}</td><td>${when(s.createdAt)}<span class="subcell">${s.active ? `until ${when(s.expiresAt)}` : s.endedAt ? `ended ${when(s.endedAt)}` : "expired"}</span></td><td>${s.active ? `<button class="mini-button" data-sec-end-support="${esc(s.id)}">End</button>` : ""}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="5" class="empty-state">No support access sessions yet.</td></tr>`;
    return `<section class="panel table-panel" style="margin-top:16px"><div class="panel-heading"><div><h2 class="panel-title">Support access</h2><p class="panel-subtitle">View the platform as a merchant, rider or customer to help them. Read-only unless you choose full access; passwords and two-step verification can never be changed; every request is recorded; super admin and staff accounts can't be opened. Sessions started with "Log in as" from Courier Operations (including by operations managers, read-only) are listed here too.</p></div></div>
      <form id="dfSupportForm" class="form-grid" style="padding:16px" novalidate><div class="field"><label for="dfSupportQuery">User</label><input id="dfSupportQuery" placeholder="Name, phone or email" autocomplete="off"><select id="dfSupportUser" style="margin-top:6px"><option value="">Search, then choose a user</option></select></div><div class="field"><label for="dfSupportMinutes">For</label><select id="dfSupportMinutes"><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option></select></div><div class="field full"><label for="dfSupportReason">Reason (recorded and shown in the audit log)</label><input id="dfSupportReason" maxlength="300" placeholder="e.g. Ticket TK-1042: merchant can't see yesterday's pickups"></div><div class="field"><label for="dfSupportMode">Access</label><select id="dfSupportMode"><option value="ro">Read-only</option><option value="full">Full access (changes allowed)</option></select></div><div class="field"><label><input type="checkbox" id="dfSupportNotify" checked> Tell the user by SMS/email</label></div><div class="field full"><button class="button button-primary" type="submit">Open their view in a new tab</button></div></form>
      <div class="table-scroll"><table><thead><tr><th>USER / REASON</th><th>BY</th><th>ACCESS</th><th>STARTED</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  // ── Platform activity: real traffic ──
  function decorateTraffic() {
    const t = SEC.traffic;
    if (!t) return;
    const eyebrow = $(".page-heading .eyebrow");
    if (eyebrow) eyebrow.textContent = "Platform insights · First-party analytics";
    const prev7 = t.daily.slice(-14, -7).reduce((a, d) => ({ visits: a.visits + d.visits, lookups: a.lookups + d.trackingLookups }), { visits: 0, lookups: 0 });
    const change = (now, before) => (before ? `${now >= before ? "↑" : "↓"} ${Math.abs(((now - before) / before) * 100).toFixed(1)}%` : now ? "new" : "no data yet");
    setMetric(0, num(t.last7Days.visits), change(t.last7Days.visits, prev7.visits), `${num(t.last7Days.pageviews)} page views · 7 days`);
    setMetric(1, num(t.last7Days.trackingLookups), change(t.last7Days.trackingLookups, prev7.lookups), "last 7 days");
    const bars = document.querySelector("#mainContent .traffic-bars");
    if (bars) {
      const max = Math.max(1, ...t.hourly.map(h => h.visits));
      const hourLabel = iso => new Date(iso).toLocaleTimeString("en-US", { timeZone: "Asia/Dhaka", hour: "numeric" });
      bars.innerHTML = t.hourly
        .map(h => `<span class="traffic-bar" style="height:${Math.max(4, Math.round((h.visits / max) * 100))}%" data-value="${h.visits}" title="${hourLabel(h.hour)} · ${num(h.visits)} visits · ${num(h.pageviews)} page views"></span>`)
        .join("");
      bars.setAttribute("aria-label", `Website visits by hour, last 24 hours: ${num(t.hourly.reduce((a, h) => a + h.visits, 0))} in total`);
      const labels = document.querySelector("#mainContent .traffic-labels");
      if (labels) {
        const picks = [0, 4, 8, 12, 16, 20, 23];
        labels.innerHTML = picks.map(i => `<span>${esc(hourLabel(t.hourly[i].hour))}</span>`).join("");
      }
    }
    const tag = document.querySelectorAll("#mainContent section .panel-heading .activity-tag")[0];
    if (tag) tag.textContent = `${num(t.hourly.reduce((a, h) => a + h.visits, 0))} visits · 24 h`;
    const list = document.querySelector("#mainContent .activity-source-list");
    if (list) {
      const total = t.sources.reduce((a, s) => a + s.count, 0);
      const names = { direct: "Direct", search: "Search", social: "Social", referral: "Referral" };
      list.innerHTML = ["direct", "search", "social", "referral"]
        .map(key => {
          const count = t.sources.find(s => s.key === key)?.count || 0;
          const share = total ? Math.round((count / total) * 100) : 0;
          return `<div class="source-row"><span>${names[key]}</span><span class="source-track"><i style="width:${share}%"></i></span><strong>${share}%</strong></div>`;
        })
        .join("");
    }
    const footer = document.querySelector("#mainContent p.table-footer");
    if (footer) footer.textContent = "Website traffic comes from the site's own page-view counts (no cookies, bots excluded). Merchant, rider, tracking and user activity are live.";
  }

  // ── Audit log ──
  function decorateAudit() {
    const c = mfaCoverage();
    if (SEC.staff.length) setMetric(1, pct(c.staffOn, c.staff), `${c.supersOn} of ${c.supers} super admins`, `${c.staffOn} of ${c.staff} staff accounts`);
    if (SEC.alerts) {
      const locks = SEC.alerts.filter(a => a.action === "auth.locked" || a.action === "auth.mfa_locked").length;
      setMetric(2, num(SEC.alerts.length), `${num(locks)} lockout${locks === 1 ? "" : "s"}`, "failed sign-ins · last 7 days");
    }
  }

  // ── Platform settings ──
  function decorateSettings() {
    const card = [...document.querySelectorAll("#mainContent .setting-card")].find(c => c.querySelector("strong")?.textContent === "Identity & MFA");
    if (!card) return;
    const c = mfaCoverage();
    card.querySelector("p").textContent = "Two-step verification (authenticator app) is required for super admins and optional for everyone else.";
    const value = card.querySelector(".setting-value");
    if (value) value.textContent = `Required for super admins · ${c.supersOn}/${c.supers} set up`;
    const toggle = card.querySelector(".toggle");
    if (toggle) {
      toggle.disabled = true;
      toggle.title = "Always on for super admins";
    }
  }

  // ───────────── actions ─────────────
  // The support-access tab collects its token from DF.takeSupportAccess once (shared/api.js DF.startSupportAccess).

  const pendingNote = result =>
    result?.status === "PENDING" ? "Sent for approval: another super admin has to approve it before it takes effect." : "Saved: no other super admin can approve, so it took effect at once.";

  async function refreshAdmins(...names) {
    const error = await load(...names);
    if (error) fail(error);
    if (page === "Admin users") showPage(page);
  }

  async function act(button, work) {
    if (button) button.disabled = true;
    try {
      await work();
    } catch (error) {
      fail(error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  document.addEventListener("click", event => {
    const t = event.target;
    if (t.closest?.("[data-sec-my-mfa]")) return void DF.mfa.manage({ onChange: () => refreshAdmins("staff") });

    const reset = t.closest?.("[data-sec-reset-mfa]");
    if (reset) {
      const user = SEC.staff.find(u => u.id === reset.dataset.secResetMfa);
      if (!user) return;
      return void DF.confirm({ title: `Reset two-step verification for ${user.name}?`, message: `They are signed out everywhere${user.mfa?.required ? " and must set it up again at their next sign-in" : ""}.`, confirm: "Reset", danger: true }).then(
        ok =>
          ok &&
          act(reset, async () => {
            await DF.api(`/users/${user.id}/mfa/reset`, { method: "POST" });
            showToast(`${user.name}: two-step verification reset and signed out.`);
            await refreshAdmins("staff");
          }),
      );
    }

    for (const [attr, verb] of [
      ["secApprove", "approve"],
      ["secReject", "reject"],
      ["secCancel", "cancel"],
    ]) {
      const button = t.closest?.(`[data-${attr.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}]`);
      if (!button) continue;
      const id = button.dataset[attr];
      const run = body =>
        act(button, async () => {
          const result = await DF.api(`/admin/changes/${id}/${verb}`, { method: "POST", body });
          showToast(verb === "approve" ? `Approved: ${result.summary}` : verb === "reject" ? "Change rejected." : "Change withdrawn.");
          await refreshAdmins("changes", "roles");
        });
      if (verb === "reject")
        return void DF.prompt({ title: "Reject this change?", message: "The requester sees your reason.", label: "Why is it rejected?", required: true, multiline: true, maxLength: 500, confirm: "Reject change", danger: true, validate: v => (v.length < 3 ? "At least 3 characters" : "") }).then(note => note && run({ note }));
      if (verb === "approve") return void DF.confirm({ title: "Approve and apply this change now?", message: "It takes effect immediately and is recorded under your name.", confirm: "Approve and apply" }).then(ok => ok && run({}));
      return void run({});
    }

    const save = t.closest?.("[data-sec-save-col]");
    if (save) {
      const col = save.dataset.secSaveCol;
      const permissions = [...document.querySelectorAll(`#dfMatrix input[data-sec-col="${CSS.escape(col)}"]:checked`)].map(i => i.dataset.secPerm);
      return void act(save, async () => {
        const result = col.startsWith("custom:")
          ? await DF.api(`/admin/custom-roles/${col.slice(7)}`, { method: "PATCH", body: { permissions } })
          : await DF.api(`/admin/roles/${col}/permissions`, { method: "PUT", body: { permissions } });
        showToast(pendingNote(result));
        await refreshAdmins("roles", "changes");
      });
    }

    const toggle = t.closest?.("[data-sec-toggle-role]");
    if (toggle)
      return void act(toggle, async () => {
        const result = await DF.api(`/admin/custom-roles/${toggle.dataset.secToggleRole}`, { method: "PATCH", body: { active: toggle.dataset.active !== "true" } });
        showToast(pendingNote(result));
        await refreshAdmins("roles", "changes");
      });

    const del = t.closest?.("[data-sec-delete-role]");
    if (del) {
      const role = SEC.roles?.customRoles.find(c => c.id === del.dataset.secDeleteRole);
      if (!role) return;
      return void DF.confirm({ title: `Delete the role "${role.name}"?`, message: `${role.users} user${role.users === 1 ? "" : "s"} will lose it.`, confirm: "Delete role", danger: true }).then(
        ok =>
          ok &&
          act(del, async () => {
            const result = await DF.api(`/admin/custom-roles/${role.id}`, { method: "DELETE" });
            showToast(pendingNote(result));
            await refreshAdmins("roles", "changes");
          }),
      );
    }

    const end = t.closest?.("[data-sec-end-support]");
    if (end)
      return void act(end, async () => {
        await DF.api(`/admin/impersonations/${end.dataset.secEndSupport}/end`, { method: "POST" });
        showToast("Support access ended.");
        await refreshAdmins("support");
      });
  });

  // Searching users for support access.
  let searchTimer = null;
  document.addEventListener("input", event => {
    if (event.target.id !== "dfSupportQuery") return;
    clearTimeout(searchTimer);
    const q = event.target.value.trim();
    searchTimer = setTimeout(async () => {
      const select = document.getElementById("dfSupportUser");
      if (!select || q.length < 2) return;
      try {
        const STAFF = ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"];
        const users = (await DF.api(`/users?q=${encodeURIComponent(q)}&status=ACTIVE&limit=20`)).items.filter(u => !u.roles.some(r => STAFF.includes(r.role)));
        select.innerHTML = users.length
          ? users.map(u => `<option value="${esc(u.id)}">${esc(u.name)} · ${esc(DF.localPhone(u.phone))} · ${esc([...new Set(u.roles.map(r => ROLE_NAME[r.role] || r.role))].join(", "))}</option>`).join("")
          : `<option value="">No matching users (super admin and staff accounts can't be opened)</option>`;
      } catch (error) {
        fail(error);
      }
    }, 300);
  });

  document.addEventListener(
    "submit",
    event => {
      const form = event.target;
      if (form.id === "dfCustomRoleForm") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const name = form.querySelector("#dfRoleName").value.trim();
        const baseRole = form.querySelector("#dfRoleBase").value;
        if (name.length < 2) return showToast("Give the role a name (at least 2 characters).");
        const base = SEC.roles.builtInRoles.find(b => b.role === baseRole);
        const permissions = (base?.permissions || []).filter(p => !SEC.roles.permissions.find(x => x.key === p)?.superAdminOnly);
        return void act(form.querySelector('[type="submit"]'), async () => {
          const result = await DF.api("/admin/custom-roles", { method: "POST", body: { name, baseRole, description: form.querySelector("#dfRoleDesc").value.trim(), permissions } });
          showToast(pendingNote(result));
          await refreshAdmins("roles", "changes");
        });
      }
      if (form.id === "dfSupportForm") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const userId = form.querySelector("#dfSupportUser").value;
        const reason = form.querySelector("#dfSupportReason").value.trim();
        if (!userId) return showToast("Search for the user first, then choose them.");
        if (reason.length < 10) return showToast("Say why you need access (at least 10 characters).");
        const readOnly = form.querySelector("#dfSupportMode").value !== "full";
        // Full access: confirm in the page first. The tab opens right after the "Continue" click (the click's
        // user activation still lets it open), then points at the panel once ready.
        const start = () => {
        const tab = window.open("about:blank", "_blank");
        return void act(form.querySelector('[type="submit"]'), async () => {
          const result = await DF.startSupportAccess(
            { userId, reason, minutes: Number(form.querySelector("#dfSupportMinutes").value), readOnly, notifyUser: form.querySelector("#dfSupportNotify").checked },
            { tab },
          );
          if (!result.opened) showToast("Allow pop-ups for this site to open the support view.");
          showToast(`Support access to ${result.user.name} started (${readOnly ? "read-only" : "full access"}).`);
          await refreshAdmins("support");
        });
        };
        if (readOnly) return void start();
        return void DF.confirm({ title: "Start full-access support?", message: "Full access lets you make changes as this user. Every action is recorded under your name.", confirm: "Continue", danger: true }).then(ok => ok && start());
      }
    },
    true,
  );

  // ───────────── render hooks and live updates ─────────────
  const baseShowPage = window.showPage;
  window.showPage = showPage = function (next) {
    baseShowPage(next);
    page = next;
    try {
      decorate();
    } catch (error) {
      console.error("Security decorations failed", error);
    }
  };

  const NEEDS = {
    "Admin users": ["staff", "roles", "changes", "support"],
    "Platform activity": ["traffic"],
    "Audit log": ["staff", "alerts"],
    "Platform settings": ["staff"],
  };
  // Load what a page needs the first time it opens, then re-render it.
  const loaded = new Set();
  document.addEventListener(
    "click",
    event => {
      const link = event.target.closest?.("[data-page], [data-page-link]");
      const next = link?.dataset.page || link?.dataset.pageLink;
      const needs = (NEEDS[next] || []).filter(n => !loaded.has(n));
      if (!needs.length) return;
      needs.forEach(n => loaded.add(n));
      void load(...needs).then(error => {
        if (error) fail(error);
        if (page === next) showPage(next);
      });
    },
    true,
  );

  (DF.bridgeReady || Promise.resolve()).then(async () => {
    const error = await load("staff", "changes");
    loaded.add("staff").add("changes");
    if (error) console.warn("Security data could not be loaded", error);
    if (NEEDS[page]) showPage(page);
    if (SEC.changes.some(c => c.canApprove)) showToast(`${SEC.changes.filter(c => c.canApprove).length} change(s) wait for your approval (Admin users & roles).`);
  });

  DF.live?.(["change.updated"], async () => {
    await load("changes", ...(page === "Admin users" ? ["roles"] : []));
    if (page === "Admin users") showPage(page);
  });
})();
