/*
 * Courier Operations → Merchants / Riders: "Log in as" (support access).
 *
 * A "Log in as" button on each merchant row (choose which member; the owner by default) and each
 * rider row, for people who may (Ops.me.can.loginAs: super admins with user:impersonate,
 * operations managers with user:login-as). The dialog asks for the reason (required), the
 * duration (5–60 minutes, default 15) and the access: read-only, or full access for super admins
 * only (with a warning step). Then a NEW TAB opens the account's panel (/ecommerce-merchant,
 * /banking-merchant, /rider) on a short-lived impersonation token (shared/api.js
 * DF.startSupportAccess); this tab's own session is untouched.
 *
 *   Candidates   GET  /admin/impersonations/targets?merchantId=… | ?riderId=…
 *   Start        POST /admin/impersonations { merchantId, userId? | riderId, reason, minutes, readOnly, notifyUser }
 *
 * The opened tab shows a banner (who, read-only / full access, a countdown, End), blocks changes
 * server-side when read-only, and ends on its own; the account holder is told (SMS / email /
 * in-app) and every request is recorded under your name. Super admin → Audit shows the sessions.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;

  const allowed = () => Ops.can("loginAs");
  const button = attrs => `<button type="button" class="button button-sm" ${attrs} title="Open this account in a new tab (support access: reason, time limit, recorded)">Log in as</button>`;

  // ───────────── buttons on the lists ─────────────

  const baseMerchants = Ops.enhance.Merchants;
  Ops.enhance.Merchants = page => {
    baseMerchants?.(page);
    if (!allowed()) return;
    const merchants = Ops.cache.merchants?.value || [];
    const head = q("#mainContent table.generic-table thead tr");
    if (head && !q("[data-login-as-head]", head)) head.insertAdjacentHTML("beforeend", `<th data-login-as-head></th>`);
    // The register lists the merchants in the API's order (bridge-pages.js Ops.prepare.Merchants); search only hides rows.
    qa("#genericBody tr").forEach((row, i) => {
      const m = merchants[i];
      if (!m || q("[data-login-as-merchant]", row)) return;
      row.insertAdjacentHTML("beforeend", `<td>${button(`data-login-as-merchant="${esc(m.id)}"`)}</td>`);
    });
  };

  const baseRiders = Ops.enhance.Riders;
  Ops.enhance.Riders = page => {
    baseRiders?.(page);
    if (!allowed()) return;
    for (const runSheet of qa("#mainContent [data-run-sheet]")) {
      if (runSheet.parentElement.querySelector("[data-login-as-rider]")) continue;
      runSheet.insertAdjacentHTML("afterend", ` ${button(`data-login-as-rider="${esc(runSheet.dataset.runSheet)}"`)}`);
    }
  };

  // ───────────── the dialog ─────────────

  async function riderByCode(code) {
    let rider = (DF.state.riders || []).find(r => r.code === code);
    if (!rider) {
      DF.state.riders = await DF.api("/riders?active=true").catch(() => DF.state.riders);
      rider = (DF.state.riders || []).find(r => r.code === code);
    }
    return rider;
  }

  /** subject: { merchantId, name } or { riderId, name }. */
  async function open(subject) {
    const query = subject.merchantId ? `merchantId=${subject.merchantId}` : `riderId=${subject.riderId}`;
    let candidates;
    try {
      candidates = await DF.api(`/admin/impersonations/targets?${query}`);
    } catch (error) {
      return void showToast(DF.describe(error));
    }
    const usable = candidates.items.filter(t => t.allowed);
    if (!usable.length) {
      const why = candidates.items[0]?.refusal;
      return void showToast(candidates.items.length ? `${subject.name}: ${why || "this account can't be opened."}` : `${subject.name} has no account to open.`);
    }
    const full = !!candidates.fullAccess && Ops.can("loginAsFull");
    const label = t => `${t.name} · ${t.roleLabel} · ${DF.localPhone(t.phone)}`;
    const blocked = candidates.items.filter(t => !t.allowed);
    const fields = [
      usable.length > 1
        ? { id: "member", label: "Whose account", type: "select", required: true, value: usable[0].userId, options: usable.map(t => ({ value: t.userId, label: label(t) })), full: true, hint: blocked.length ? `${blocked.length} other member${blocked.length === 1 ? "" : "s"} can't be opened (staff or inactive).` : "" }
        : { id: "member", type: "static", label: "Account", value: label(usable[0]) },
      { id: "reason", label: "Reason (recorded and shown in the audit log)", type: "textarea", required: true, maxLength: 300, rows: 2, placeholder: "e.g. Ticket TK-1042: merchant can't see yesterday's pickups" },
      { id: "minutes", label: "Duration (minutes, 5–60)", type: "number", required: true, value: "15", min: 5, max: 60, step: 1 },
      full
        ? { id: "access", label: "Access", type: "select", required: true, value: "ro", options: [{ value: "ro", label: "Read-only (recommended)" }, { value: "full", label: "Full access (changes allowed)" }] }
        : { id: "access", label: "Access", type: "static", value: "Read-only: you can look, nothing can be changed." },
      ...(full
        ? [
            { id: "fullWarning", type: "static", label: "Warning", html: `<span style="color:#b42318;font-weight:600">Full access lets you make changes as this person (bookings, payments, settings). Every action is recorded under your name.</span>`, show: v => v.access === "full" },
            { id: "notify", label: "Tell them", type: "select", value: "yes", options: [{ value: "yes", label: "Yes, by SMS / email / in-app (recommended)" }, { value: "no", label: "No" }] },
          ]
        : [{ id: "notifyInfo", type: "static", label: "Tell them", value: "They are told by SMS / email / in-app that support is viewing their account." }]),
    ];
    Ops.form({
      title: `Log in as ${subject.name}`,
      description: "Opens their account in a new tab with a time limit. Passwords, two-step verification and sessions can't be reached; every request is recorded under your name.",
      submit: "Open in a new tab",
      fields,
      validate: {
        reason: v => (v.length < 10 ? "Say why you need access (at least 10 characters)" : ""),
        minutes: v => (!/^\d+$/.test(v) || Number(v) < 5 || Number(v) > 60 ? "Choose 5 to 60 minutes" : ""),
      },
      review: v => (v.access === "full" ? [["Account", usable.length > 1 ? label(usable.find(t => t.userId === v.member) || usable[0]) : label(usable[0])], ["Access", "Full access: changes allowed"], ["Duration", `${v.minutes} minutes`], ["Reason", v.reason]] : null),
      reviewTitle: "Open with full access?",
      reviewNote: "Full access lets you make changes as this person. Every action is recorded under your name and they are told unless you chose not to.",
      confirm: "Open with full access",
      onSubmit: async v => {
        const target = usable.length > 1 ? usable.find(t => t.userId === v.member) || usable[0] : usable[0];
        const readOnly = v.access !== "full";
        // Opened during the click (pop-up blockers), then pointed at the panel once the session exists.
        const tab = window.open("about:blank", "_blank");
        const body = { reason: v.reason, minutes: Number(v.minutes), readOnly, ...(full ? { notifyUser: v.notify !== "no" } : {}) };
        if (subject.merchantId) Object.assign(body, { merchantId: subject.merchantId, userId: target.userId });
        else body.riderId = subject.riderId;
        const result = await DF.startSupportAccess(body, { tab, panel: target.panel });
        return result.opened
          ? `Opened ${result.user.name}'s account in a new tab (${readOnly ? "read-only" : "full access"}, ${v.minutes} min).`
          : `Session started for ${result.user.name}, but the browser blocked the new tab. Allow pop-ups for this site and try again.`;
      },
    });
  }

  document.addEventListener("click", event => {
    const merchantButton = event.target.closest?.("[data-login-as-merchant]");
    const riderButton = event.target.closest?.("[data-login-as-rider]");
    if (!merchantButton && !riderButton) return;
    event.preventDefault();
    if (!Ops.require("loginAs", "log in as merchants or riders")) return;
    if (merchantButton) {
      const m = (Ops.cache.merchants?.value || []).find(x => x.id === merchantButton.dataset.loginAsMerchant);
      return void open({ merchantId: merchantButton.dataset.loginAsMerchant, name: m?.name || "this merchant" });
    }
    const code = riderButton.dataset.loginAsRider;
    void riderByCode(code).then(rider => (rider ? open({ riderId: rider.id, name: `${rider.code} · ${rider.name}` }) : showToast(`Rider ${code} wasn't found among active riders.`)));
  });
})();
