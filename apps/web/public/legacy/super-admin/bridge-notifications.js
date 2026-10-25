/*
 * Super admin: notifications and messaging gateways on the API.
 *
 * - Global notifications ("Platform settings", Platform control): every message except the Parcel ones,
 *   in tabs per group with their counts (GET /notifications/events). Per event × channel on/off
 *   switches and a template editor (variables, live preview, reset to default).
 * - Parcel notifications (Merchant management): the Parcel group's messages, the same list and editor.
 * - SMS & Email Integrations ("Integrations", Platform control), tab "Channels & limits": Notification
 *   channels (SMS / email on or off; the page's own platform-config, saved as before) and the SMS / OTP
 *   limits and message settings (GET/PUT /notifications/settings). More settings go here later.
 * - SMS & Email Integrations, tab "Gateways": real status cards for the SMS (mram) and email (Mailjet) gateways
 *   (GET /notifications/gateways): settings with write-only keys, health, 24 h counts, a
 *   "Send test" action that sends one real message, and the most recent messages.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;

  const esc = value =>
    String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (typeof showToast === "function" ? showToast(message) : DF.toast?.(message));
  const fail = error => toast(DF.describe(error));
  const CHANNEL_NAME = { sms: "SMS", email: "Email" };
  const when = value =>
    value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never";
  const pill = (text, tone) => `<span class="status status-${tone}">${esc(text)}</span>`;
  const panel = (title, subtitle, body, attrs = "") =>
    `<section class="panel" ${attrs}><div class="panel-heading"><div><h2 class="panel-title">${esc(title)}</h2><p class="panel-subtitle">${esc(subtitle)}</p></div></div>${body}</section>`;
  const areaStyle = "width:100%;min-height:96px;font:inherit;padding:9px 11px;border:1px solid #d9e2dc;border-radius:9px;resize:vertical";
  async function busy(button, work) {
    if (button) button.disabled = true;
    try {
      return await work();
    } finally {
      if (button) button.disabled = false;
    }
  }

  const S = { catalog: null, settings: null, editing: null, gateways: null, outbox: [], scope: "others" };
  let current = null;
  const PARCEL_GROUP = "Parcel";
  const PARCEL_PAGE = "Parcel notifications";
  // Old links to the Settings page open SMS & Email Integrations › Channels & limits.
  const SETTINGS_PAGE = "Settings";

  // The base renderer (01.js) draws unknown pages from its `generic` table: give the new pages an empty entry.
  try {
    for (const [page, desc] of [[PARCEL_PAGE, "Parcel messages"]])
      if (typeof generic === "object" && !generic[page]) generic[page] = { desc, cols: [], rows: [] };
  } catch {}

  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) {
    if (page === SETTINGS_PAGE) {
      S.intTab = "settings";
      page = "Integrations";
    }
    baseShowPage(page);
    current = page;
    if (page === "Platform settings" || page === PARCEL_PAGE) void notificationsPage(page);
    if (page === "Integrations") void integrationsPage();
  };
  const still = page => current === page && document.getElementById("mainContent");

  // ───────────────────────────── Global notifications ─────────────────────────────

  /** Global notifications (every group but Parcel, in tabs) or Parcel notifications (the Parcel group). */
  async function notificationsPage(page) {
    const parcel = page === PARCEL_PAGE;
    if (parcel)
      document.getElementById("mainContent").innerHTML =
        `<div class="page-heading"><div><p class="eyebrow">Merchant management</p><h1>Parcel notifications</h1><p class="subtitle">The SMS and emails about a parcel (booked, picked up, out for delivery, delivered, returned…) that merchants, senders and recipients get. Switch them on or off and edit their texts.</p></div></div><div class="config-layout" id="ntParcelLayout"><p class="panel-subtitle">Loading…</p></div>`;
    else {
      // The channel switches and the SMS limits have their own page now (Settings).
      const sub = document.querySelector("#mainContent .page-heading .subtitle");
      if (sub) sub.textContent = "Messages about merchants, money, support, accounts, operations, riders and partners. Parcel messages are in Merchant management › Parcel notifications; SMS / email switches and limits in Settings.";
      document.querySelector("#mainContent .page-heading [data-config-save]")?.remove();
      const old = document.querySelector("#mainContent .config-layout");
      if (old) old.innerHTML = `<p class="panel-subtitle">Loading…</p>`;
    }
    try {
      S.catalog = await DF.api("/notifications/events");
    } catch (error) {
      return fail(error);
    }
    if (!still(page)) return;
    S.scope = parcel ? "parcel" : "others";
    S.editing = null;
    const layout = document.querySelector("#mainContent .config-layout");
    if (!layout) return;
    layout.style.display = "block";
    layout.innerHTML = `${eventsPanel()}<div style="height:16px"></div>${editorPanel()}`;
    wireEvents();
    wireEditor();
  }

  // ───────────────────────────── Settings ─────────────────────────────

  /** The page's own platform-config channel switches (02.js), or defaults if it isn't there. */
  const pageChannels = () => {
    try {
      return adminChannels; // eslint-disable-line no-undef
    } catch {
      return null;
    }
  };

  /** Channels & limits tab: notification channels and the SMS limits (more settings will be added here). */
  async function settingsTab(box) {
    const channels = pageChannels() || { sms: true, email: true };
    box.innerHTML = `<div class="config-layout" id="sysSettings" style="align-items:start">
        ${panel("Notification channels", "SMS and email can be switched off for the whole platform (security messages are always sent); public tracking is always available.", `<form class="config-form" id="sysChannelsForm"><label class="config-check"><input type="checkbox" name="sms" ${channels.sms ? "checked" : ""}> SMS notifications enabled</label><label class="config-check"><input type="checkbox" name="email" ${channels.email ? "checked" : ""}> Email notifications enabled</label><label class="config-check"><input type="checkbox" checked disabled> Website tracking for everyone · always on</label><button class="button button-primary" type="submit">Save channels</button></form>`, 'id="sysChannelsPanel"')}
        <div id="sysLimits">${panel("SMS limits and message settings", "Loading…", "")}</div>
      </div>`;
    try {
      S.settings = await DF.api("/notifications/settings");
    } catch (error) {
      return fail(error);
    }
    if (!still("Integrations") || !document.getElementById("sysLimits")) return;
    document.getElementById("sysLimits").innerHTML = limitsPanel();
    wireNotifications();
  }
  // The channel switches: the same platform-config save the old page used (02.js), staying on this page.
  window.addEventListener(
    "submit",
    event => {
      if (event.target?.id !== "sysChannelsForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const form = event.target;
      const channels = pageChannels();
      if (!channels) return fail(new Error("The settings could not be saved here; reload the page."));
      channels.sms = form.elements.sms.checked;
      channels.email = form.elements.email.checked;
      try {
        persistAdminConfig(); // eslint-disable-line no-undef -- 02.js: saved to the server (bridge.js)
        toast(`Notification channels saved: SMS ${channels.sms ? "on" : "off"}, email ${channels.email ? "on" : "off"}.`);
      } catch (error) {
        fail(error);
      }
    },
    true,
  );

  // List filters survive re-renders (a switch or a saved template redraws the list).
  const F = { q: "", channel: "", state: "", group: "" };
  const isCustomized = e => Object.values(e.channels).some(c => c.customized);
  const isDisabled = e => Object.values(e.channels).some(c => !c.locked && !c.enabledByAdmin);

  function eventsPanel() {
    const order = S.catalog.groups || [];
    const groups = [];
    const inScope = e => (S.scope === "parcel" ? e.group === PARCEL_GROUP : e.group !== PARCEL_GROUP);
    for (const e of S.catalog.events.filter(inScope)) {
      let g = groups.find(x => x.name === e.group);
      if (!g) groups.push((g = { name: e.group, events: [] }));
      g.events.push(e);
    }
    groups.sort((a, b) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99));
    // Global notifications: one group at a time, in tabs with their counts.
    const tabbed = S.scope !== "parcel" && groups.length > 1;
    if (tabbed && !groups.some(g => g.name === F.group)) F.group = groups[0]?.name || "";
    const shownGroups = tabbed ? groups.filter(g => g.name === F.group) : groups;
    const scoped = shownGroups.reduce((n, g) => n + g.events.length, 0);
    const tabs = tabbed
      ? `<div class="nt-tabs" role="tablist" aria-label="Message groups" style="display:inline-flex;gap:4px;flex-wrap:wrap;padding:4px;border-radius:11px;background:#eef1f5;margin:0 16px 12px">${groups
          .map(
            g =>
              `<button type="button" role="tab" class="button button-sm${g.name === F.group ? " button-primary" : ""}" data-nt-tab="${esc(g.name)}" aria-selected="${g.name === F.group}" style="${g.name === F.group ? "" : "background:transparent;border:0;box-shadow:none;color:#556274"}">${esc(g.name)} <span style="display:inline-block;min-width:20px;margin-left:4px;padding:0 6px;border-radius:999px;background:${g.name === F.group ? "#ffffff33" : "#dfe4ec"};font-size:11px;line-height:18px">${g.events.length}</span></button>`,
          )
          .join("")}</div>`
      : "";
    const cell = (e, channel) => {
      const c = e.channels[channel];
      if (!c) return `<td><span class="panel-subtitle">No ${CHANNEL_NAME[channel].toLowerCase()}</span></td>`;
      const checkbox = `<label class="config-check"><input type="checkbox" data-nt-toggle="${esc(e.event)}|${channel}" ${c.enabledByAdmin || c.locked ? "checked" : ""} ${c.locked ? "disabled" : ""}> ${c.locked ? "Always on" : "On"}</label>`;
      const edit = `<button class="button button-sm" type="button" data-nt-edit="${esc(e.event)}|${channel}">Edit${c.customized ? " · customised" : ""}</button>`;
      return `<td>${checkbox}${edit}</td>`;
    };
    const badges = e =>
      [
        e.mandatory ? pill("Security · always sent", "good") : "",
        isCustomized(e) ? `<span data-nt-badge="customised">${pill("Customised", "blue")}</span>` : "",
        isDisabled(e) ? pill(Object.values(e.channels).every(c => !c.locked && !c.enabledByAdmin) ? "Off" : "Partly off", "warn") : "",
      ]
        .filter(Boolean)
        .join(" ");
    const channelList = e => Object.keys(e.channels).map(c => CHANNEL_NAME[c]).join(" + ");
    const rows = shownGroups
      .map(
        g =>
          `<tr data-nt-group="${esc(g.name)}"><td colspan="4" style="background:#f6f8fb"><strong>${esc(g.name)}</strong> <span class="panel-subtitle" data-nt-group-count>${g.events.length} message${g.events.length === 1 ? "" : "s"}</span></td></tr>` +
          g.events
            .map(
              e =>
                `<tr data-nt-event="${esc(e.event)}" data-nt-row-group="${esc(g.name)}" data-nt-channels="${esc(Object.keys(e.channels).join(" "))}" data-nt-search="${esc(`${e.label} ${e.event} ${e.audience} ${g.name}`.toLowerCase())}"><td><div class="primary-cell" data-nt-hover="${esc(e.event)}" tabindex="0" aria-describedby="ntTemplateCard" style="cursor:help"><strong>${esc(e.label)}</strong> ${badges(e)}<span class="subcell">${esc(e.event)} · ${esc(channelList(e))}</span></div></td><td>${esc(e.audience)}</td>${cell(e, "sms")}${cell(e, "email")}</tr>`,
            )
            .join(""),
      )
      .join("");
    const off = ["sms", "email"].filter(c => !S.catalog.channels[c]).map(c => CHANNEL_NAME[c]);
    const note = off.length
      ? `${off.join(" and ")} notifications are switched off in Settings: only security messages (codes, alerts) are sent.`
      : `${S.scope === "parcel" ? `The parcel messages (${scoped})` : `${F.group} messages (${scoped})`}. Switch them on or off per channel and edit their texts. Security messages (codes, alerts) are always sent.`;
    const option = (value, label, current) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
    const tools = `<input class="table-search" id="ntSearch" type="search" placeholder="Search messages..." aria-label="Search notification messages" value="${esc(F.q)}" style="width:190px">
      <select class="select-small" id="ntChannelFilter" aria-label="Filter by channel">${option("", "SMS and email", F.channel)}${option("sms", "Has SMS", F.channel)}${option("email", "Has email", F.channel)}</select>
      <select class="select-small" id="ntStateFilter" aria-label="Filter by state">${option("", "All messages", F.state)}${option("customised", "Customised", F.state)}${option("disabled", "Switched off", F.state)}${option("security", "Security messages", F.state)}</select>`;
    return `<section class="panel table-panel" id="notificationEventsPanel"><div class="panel-heading" style="flex-wrap:wrap;gap:10px"><div><h2 class="panel-title">Notification messages</h2><p class="panel-subtitle">${esc(note)}</p></div><div class="table-tools" style="flex-wrap:wrap">${tools}</div></div>${tabs}<div class="table-scroll"><table id="notificationEventsTable"><thead><tr><th>MESSAGE</th><th>RECIPIENT</th><th>SMS</th><th>EMAIL</th></tr></thead><tbody>${rows}</tbody></table></div><div class="table-footer" style="padding:11px 16px;border-top:1px solid var(--line);color:#98a2ae;font-size:12px"><span id="ntShowing"></span></div></section>`;
  }

  /** Shows the rows matching the search box and filters; hides group headers left empty. */
  function applyEventFilters() {
    const table = document.getElementById("notificationEventsTable");
    if (!table) return;
    const words = F.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    const visibleByGroup = new Map();
    for (const row of table.querySelectorAll("tr[data-nt-event]")) {
      const e = S.catalog.events.find(x => x.event === row.dataset.ntEvent);
      const ok =
        !!e &&
        words.every(w => row.dataset.ntSearch.includes(w)) &&
        (!F.channel || !!e.channels[F.channel]) &&
        (F.state !== "customised" || isCustomized(e)) &&
        (F.state !== "disabled" || isDisabled(e)) &&
        (F.state !== "security" || e.mandatory);
      row.hidden = !ok;
      if (ok) {
        shown++;
        visibleByGroup.set(row.dataset.ntRowGroup, (visibleByGroup.get(row.dataset.ntRowGroup) || 0) + 1);
      }
    }
    for (const header of table.querySelectorAll("tr[data-nt-group]")) header.hidden = !visibleByGroup.get(header.dataset.ntGroup);
    const total = table.querySelectorAll("tr[data-nt-event]").length;
    const showing = document.getElementById("ntShowing");
    if (showing) showing.textContent = shown === total ? `Showing all ${total} messages` : shown ? `Showing ${shown} of ${total} messages` : "No messages match the search and filters.";
  }

  function editorPanel() {
    const t = S.editing && S.catalog.events.find(e => e.event === S.editing.event);
    if (!t) return `<section class="panel" id="notificationTemplateEditor" hidden></section>`;
    const channel = S.editing.channel;
    const c = t.channels[channel];
    const vars = [...t.vars, ...S.catalog.commonVars];
    const email = channel === "email";
    const body = `<form class="config-form" id="notificationTemplateForm" novalidate>
      <p class="panel-subtitle">Variables (click to insert): ${vars.map(v => `<button type="button" class="config-chip" data-nt-var="${esc(v)}">{{${esc(v)}}}</button>`).join(" ")}${t.required.length ? ` · must include ${t.required.map(v => `{{${esc(v)}}}`).join(", ")}` : ""}. Optional text: {{#var}}…{{/var}} shows only when var has a value.</p>
      ${email ? `<label>Subject<input id="ntSubject" name="subject" maxlength="200" value="${esc(c.subject)}"></label>` : ""}
      <label>${email ? "Plain-text body" : "SMS text"}<textarea id="ntBody" name="body" maxlength="4000" style="${areaStyle}">${esc(c.body)}</textarea></label>
      ${email ? `<label>HTML body<textarea id="ntHtml" name="html" maxlength="50000" style="${areaStyle};min-height:140px;font-family:monospace;font-size:12px">${esc(c.html)}</textarea></label>` : ""}
      <div class="row-actions" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="button button-primary" type="submit">Save template</button>
        <button class="button" type="button" data-nt-preview>Preview</button>
        <button class="button" type="button" data-nt-reset ${c.customized ? "" : "disabled"}>Reset to default</button>
        <button class="button" type="button" data-nt-close>Close</button>
      </div>
      <div id="ntPreview" aria-live="polite"></div>
    </form>`;
    return panel(`${t.label} · ${CHANNEL_NAME[channel]}`, `${t.audience}. ${c.customized ? `Customised ${when(c.updatedAt)}.` : "Default text."}`, body, 'id="notificationTemplateEditor"');
  }

  function limitsPanel() {
    const { sms, otp } = S.settings.limits;
    const brand = S.settings.brand;
    const d = S.settings.defaults.limits;
    const num = (id, label, value, min, max, hint) =>
      `<label>${esc(label)}<input id="${id}" type="number" min="${min}" max="${max}" step="1" value="${esc(value)}" required><small class="panel-subtitle">${esc(hint)}</small></label>`;
    const body = `<form class="config-form" id="notificationLimitsForm" novalidate>
      ${num("ntMinInterval", "Seconds between SMS to one number", sms.minIntervalSeconds, 0, 3600, `Later messages wait, they aren't dropped. Default ${d.sms.minIntervalSeconds}.`)}
      ${num("ntPerHour", "SMS per number per hour", sms.perRecipientPerHour, 1, 1000, `Default ${d.sms.perRecipientPerHour}.`)}
      ${num("ntPerDay", "SMS per number per day", sms.perRecipientPerDay, 1, 5000, `Over this, non-urgent SMS are not sent. Default ${d.sms.perRecipientPerDay}.`)}
      ${num("ntGlobal", "SMS per minute, whole platform", sms.globalPerMinute, 1, 100000, `Default ${d.sms.globalPerMinute}.`)}
      ${num("ntOtpCooldown", "Seconds before a new code can be requested", otp.cooldownSeconds, 15, 900, `Shown as a countdown. Default ${d.otp.cooldownSeconds}.`)}
      ${num("ntOtpPhone", "Codes per number per hour", otp.perPhonePerHour, 1, 50, `Default ${d.otp.perPhonePerHour}.`)}
      ${num("ntOtpIp", "Codes per IP address per hour", otp.perIpPerHour, 1, 1000, `Default ${d.otp.perIpPerHour}.`)}
      <label>Name in messages<input id="ntAppName" maxlength="40" value="${esc(brand.appName)}" required></label>
      <label>How to reach support ({{support}})<input id="ntSupport" maxlength="60" value="${esc(brand.support)}" required></label>
      <button class="button button-primary" type="submit">Save limits</button>
    </form>`;
    return panel("SMS limits and message settings", "Codes and security messages skip the per-number limits but count towards them.", body, 'id="notificationLimitsPanel"');
  }

  function rerenderEditor() {
    const old = document.getElementById("notificationTemplateEditor");
    if (!old) return;
    old.outerHTML = editorPanel();
    wireEditor();
    if (S.editing) document.getElementById("notificationTemplateEditor")?.scrollIntoView({ block: "nearest" });
  }
  function replaceEvent(view) {
    const i = S.catalog.events.findIndex(e => e.event === view.event);
    if (i >= 0) S.catalog.events[i] = view;
    const old = document.getElementById("notificationEventsPanel");
    if (old) {
      old.outerHTML = eventsPanel();
      wireEvents();
    }
  }

  function wireNotifications() {
    wireEvents();
    wireEditor();
    const form = document.getElementById("notificationLimitsForm");
    if (!form) return;
    const intIn = (min, max) => value => {
      const n = Number(value);
      return value === "" || !Number.isInteger(n) ? "Enter a whole number" : n < min || n > max ? `Between ${min} and ${max}` : "";
    };
    DF.validate(form, {
      ntMinInterval: intIn(0, 3600),
      ntPerHour: intIn(1, 1000),
      ntPerDay: value => intIn(1, 5000)(value) || (Number(value) < Number(form.querySelector("#ntPerHour").value) ? "Can't be lower than the hourly limit" : ""),
      ntGlobal: intIn(1, 100000),
      ntOtpCooldown: intIn(15, 900),
      ntOtpPhone: intIn(1, 50),
      ntOtpIp: intIn(1, 1000),
      ntAppName: value => (value.trim() ? "" : "Enter a name"),
      ntSupport: value => (value.trim() ? "" : "Enter a phone number or address"),
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const v = id => Number(form.querySelector(`#${id}`).value);
      const body = {
        limits: {
          sms: { minIntervalSeconds: v("ntMinInterval"), perRecipientPerHour: v("ntPerHour"), perRecipientPerDay: v("ntPerDay"), globalPerMinute: v("ntGlobal") },
          otp: { cooldownSeconds: v("ntOtpCooldown"), perPhonePerHour: v("ntOtpPhone"), perIpPerHour: v("ntOtpIp") },
        },
        brand: { appName: form.querySelector("#ntAppName").value.trim(), support: form.querySelector("#ntSupport").value.trim() },
      };
      void busy(form.querySelector('button[type="submit"]'), async () => {
        try {
          S.settings = await DF.api("/notifications/settings", { method: "PUT", body });
          toast("Notification limits saved.");
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  // Hover (or keyboard focus) on a message name shows its current SMS / email text.
  const PREVIEW_LIMIT = 700;
  const clip = text => (text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT).trimEnd()}… (Edit shows the full text)` : text);
  function templateCardHtml(e) {
    const block = (title, c, parts) =>
      `<div style="display:grid;gap:4px"><div style="display:flex;gap:6px;align-items:center"><strong style="font-size:12px;letter-spacing:.04em;text-transform:uppercase">${esc(title)}</strong>${c.customized ? pill("Customised", "blue") : '<span class="panel-subtitle">Default text</span>'}${!c.locked && !c.enabledByAdmin ? pill("Off", "warn") : ""}</div>${parts}</div>`;
    const text = value => `<div style="white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.5;color:#3c4859">${esc(clip(value || ""))}</div>`;
    const sections = [];
    if (e.channels.sms) sections.push(block("SMS", e.channels.sms, text(e.channels.sms.body)));
    if (e.channels.email)
      sections.push(block("Email", e.channels.email, `<div style="font-size:13px"><span class="panel-subtitle">Subject:</span> ${esc(e.channels.email.subject || "")}</div>${text(e.channels.email.body)}`));
    return `<div style="font-size:13px;font-weight:700">${esc(e.label)}</div>${sections.join('<hr style="border:0;border-top:1px solid var(--line,#e4e8ee);margin:2px 0">') || '<p class="panel-subtitle">No template.</p>'}`;
  }
  function templateCard() {
    let card = document.getElementById("ntTemplateCard");
    if (!card) {
      card = document.createElement("div");
      card.id = "ntTemplateCard";
      card.setAttribute("role", "tooltip");
      card.style.cssText =
        "position:fixed;z-index:60;max-width:min(440px,calc(100vw - 32px));max-height:min(420px,calc(100vh - 32px));overflow:auto;display:none;gap:10px;padding:12px 14px;background:#fff;border:1px solid var(--line,#e4e8ee);border-radius:10px;box-shadow:0 14px 40px #1018282e;pointer-events:none";
      document.body.appendChild(card);
    }
    return card;
  }
  let hoverAnchor = null;
  function showTemplateCard(anchor) {
    const e = S.catalog?.events.find(x => x.event === anchor.dataset.ntHover);
    if (!e) return;
    const card = templateCard();
    card.innerHTML = templateCardHtml(e);
    card.style.display = "grid";
    hoverAnchor = anchor;
    placeTemplateCard(card, anchor);
  }
  function placeTemplateCard(card, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const left = Math.max(16, Math.min(r.left, window.innerWidth - w - 16));
    const below = r.bottom + 8;
    card.style.left = `${left}px`;
    card.style.top = `${below + h > window.innerHeight - 16 ? Math.max(16, r.top - h - 8) : below}px`;
  }
  const hideTemplateCard = () => {
    hoverAnchor = null;
    const card = document.getElementById("ntTemplateCard");
    if (card) card.style.display = "none";
  };
  // Follow the message while the page scrolls; hide once it is gone from the page.
  window.addEventListener(
    "scroll",
    () => {
      const card = document.getElementById("ntTemplateCard");
      if (!card || card.style.display === "none") return;
      if (hoverAnchor?.isConnected) placeTemplateCard(card, hoverAnchor);
      else hideTemplateCard();
    },
    true,
  );

  function wireEvents() {
    const table = document.getElementById("notificationEventsTable");
    if (!table) return;
    table.addEventListener("mouseover", event => {
      const anchor = event.target.closest("[data-nt-hover]");
      if (anchor && !anchor.contains(event.relatedTarget)) showTemplateCard(anchor);
    });
    table.addEventListener("mouseout", event => {
      const anchor = event.target.closest("[data-nt-hover]");
      if (anchor && !anchor.contains(event.relatedTarget)) hideTemplateCard();
    });
    table.addEventListener("focusin", event => {
      const anchor = event.target.closest("[data-nt-hover]");
      if (anchor) showTemplateCard(anchor);
    });
    table.addEventListener("focusout", hideTemplateCard);
    table.addEventListener("keydown", event => event.key === "Escape" && hideTemplateCard());
    const search = document.getElementById("ntSearch");
    search?.addEventListener("input", () => {
      F.q = search.value;
      applyEventFilters();
    });
    for (const [id, key] of [["ntChannelFilter", "channel"], ["ntStateFilter", "state"]])
      document.getElementById(id)?.addEventListener("change", event => {
        F[key] = event.target.value;
        applyEventFilters();
      });
    applyEventFilters();
    table.addEventListener("change", event => {
      const box = event.target.closest("[data-nt-toggle]");
      if (!box) return;
      const [name, channel] = box.dataset.ntToggle.split("|");
      void busy(box, async () => {
        try {
          const view = await DF.api(`/notifications/templates/${encodeURIComponent(name)}/${channel}`, { method: "PUT", body: { enabled: box.checked } });
          replaceEvent(view);
          toast(`${view.label} ${CHANNEL_NAME[channel]} ${box.checked ? "switched on" : "switched off"}.`);
        } catch (error) {
          box.checked = !box.checked;
          fail(error);
        }
      });
    });
    table.addEventListener("click", event => {
      const button = event.target.closest("[data-nt-edit]");
      if (!button) return;
      const [name, channel] = button.dataset.ntEdit.split("|");
      S.editing = { event: name, channel };
      rerenderEditor();
    });
  }

  document.addEventListener("click", event => {
    const tab = event.target instanceof Element ? event.target.closest("[data-nt-tab]") : null;
    if (!tab || !S.catalog) return;
    F.group = tab.dataset.ntTab;
    const old = document.getElementById("notificationEventsPanel");
    if (!old) return;
    old.outerHTML = eventsPanel();
    wireEvents();
  });

  function draft(form) {
    const value = id => form.querySelector(`#${id}`)?.value;
    return { subject: value("ntSubject"), body: value("ntBody"), html: value("ntHtml") };
  }

  function wireEditor() {
    const form = document.getElementById("notificationTemplateForm");
    if (!form) return;
    const { event: name, channel } = S.editing;
    let lastField = form.querySelector("#ntBody");
    form.addEventListener("focusin", e => {
      if (e.target.matches("input,textarea")) lastField = e.target;
    });
    DF.validate(form, {
      ntSubject: value => (value.trim() ? "" : "Enter a subject"),
      ntBody: value => (value.trim() ? "" : "Enter the message text"),
      ntHtml: value => (value.trim() ? "" : "Enter the HTML body"),
    });
    form.addEventListener("click", event => {
      const chip = event.target.closest("[data-nt-var]");
      if (chip) {
        const field = lastField || form.querySelector("#ntBody");
        const token = `{{${chip.dataset.ntVar}}}`;
        const at = field.selectionStart ?? field.value.length;
        field.value = field.value.slice(0, at) + token + field.value.slice(field.selectionEnd ?? at);
        field.focus();
        field.selectionStart = field.selectionEnd = at + token.length;
        return;
      }
      if (event.target.closest("[data-nt-close]")) {
        S.editing = null;
        rerenderEditor();
        return;
      }
      const previewButton = event.target.closest("[data-nt-preview]");
      if (previewButton) void busy(previewButton, () => preview(form));
      const resetButton = event.target.closest("[data-nt-reset]");
      if (resetButton)
        void DF.confirm({ title: "Restore the default text?", message: "Your edits to this message are replaced by the default text.", confirm: "Restore default" }).then(ok => ok && busy(resetButton, async () => {
          try {
            replaceEvent(await DF.api(`/notifications/templates/${encodeURIComponent(name)}/${channel}/reset`, { method: "POST" }));
            rerenderEditor();
            toast("Default text restored.");
          } catch (error) {
            fail(error);
          }
        }));
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const body = Object.fromEntries(Object.entries(draft(form)).filter(([, v]) => v !== undefined));
      void busy(form.querySelector('button[type="submit"]'), async () => {
        try {
          replaceEvent(await DF.api(`/notifications/templates/${encodeURIComponent(name)}/${channel}`, { method: "PUT", body }));
          rerenderEditor();
          toast("Template saved.");
        } catch (error) {
          showPreview(`<p class="df-field-error" style="color:#c2410c">${esc(DF.describe(error))}</p>`);
          fail(error);
        }
      });
    });
  }

  function showPreview(html) {
    const box = document.getElementById("ntPreview");
    if (box) box.innerHTML = html;
  }

  async function preview(form) {
    const { event: name, channel } = S.editing;
    try {
      const r = await DF.api("/notifications/preview", { method: "POST", body: { event: name, channel, ...draft(form) } });
      if (channel === "sms") {
        showPreview(
          `<div class="callout" style="margin-top:10px"><strong>SMS preview</strong><p style="white-space:pre-wrap;margin:6px 0">${esc(r.body)}</p><small class="panel-subtitle">${r.sms.length} characters · ${r.sms.encoding} · ${r.sms.segments} SMS part${r.sms.segments === 1 ? "" : "s"}${r.sms.encoding === "UCS-2" ? " (Bangla/Unicode: 70 characters per part)" : ""}</small></div>`,
        );
      } else {
        showPreview(
          `<div class="callout" style="margin-top:10px"><strong>Subject:</strong> ${esc(r.subject)}<div data-email-preview role="document" aria-label="Email preview" style="display:block;max-height:420px;overflow:auto;margin-top:8px;border:1px solid #d9e2dc;border-radius:9px;background:#fff"></div></div>`,
        );
        // Shadow DOM keeps the email styles apart from the page; scripts and handlers are stripped.
        const doc = new DOMParser().parseFromString(r.html, "text/html");
        doc.querySelectorAll("script,iframe,object,embed,link,meta,base,form").forEach(el => el.remove());
        doc.querySelectorAll("*").forEach(el => {
          for (const attr of [...el.attributes])
            if (/^on/i.test(attr.name) || (/^(href|src)$/i.test(attr.name) && /^s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name);
        });
        const host = document.querySelector("#ntPreview [data-email-preview]");
        host.attachShadow({ mode: "open" }).innerHTML = doc.body.innerHTML;
      }
    } catch (error) {
      showPreview(`<p class="df-field-error" style="color:#c2410c">${esc(DF.describe(error))}</p>`);
    }
  }

  // ───────────────────────────── Integrations ─────────────────────────────

  /** SMS & Email Integrations: Channels & limits (first) · Recent messages · Gateways (status, keys, test). */
  const INT_TABS = [
    ["settings", "Channels & limits"],
    ["messages", "Recent messages"],
    ["gateways", "Gateway Settings"],
  ];
  async function integrationsPage() {
    const main = document.getElementById("mainContent");
    const tab = INT_TABS.some(([k]) => k === S.intTab) ? S.intTab : "settings";
    const tabs = INT_TABS;
    main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Platform connections</p><h1>SMS & Email Integrations</h1><p class="subtitle">The SMS and email gateways (keys are stored encrypted and never shown again), which channels are on, and the SMS limits and message settings.</p></div></div>
      <div class="int-tabs" role="tablist" aria-label="SMS and email" style="display:inline-flex;gap:4px;flex-wrap:wrap;margin:0 0 16px;padding:4px;border-radius:11px;background:#eef1f5">${tabs
        .map(([k, label]) => `<button type="button" role="tab" class="button button-sm${k === tab ? " button-primary" : ""}" data-int-tab="${k}" aria-selected="${k === tab}" style="${k === tab ? "" : "background:transparent;border:0;box-shadow:none;color:#556274"}">${label}</button>`)
        .join("")}</div>
      <div id="intBody"><p class="panel-subtitle">Loading…</p></div>`;
    const crumb = document.getElementById("breadcrumbPage");
    if (crumb) crumb.textContent = "SMS & Email Integrations";
    const box = document.getElementById("intBody");
    if (tab === "settings") return settingsTab(box);
    if (tab === "messages") {
      try {
        S.outbox = await DF.api("/notifications/outbox?limit=50");
      } catch (error) {
        return fail(error);
      }
      if (!still("Integrations") || !box.isConnected) return;
      box.innerHTML = outboxPanel();
      return;
    }
    try {
      S.gateways = await DF.api("/notifications/gateways");
    } catch (error) {
      return fail(error);
    }
    if (!still("Integrations") || !box.isConnected) return;
    box.innerHTML = `<section class="metrics" id="gatewayMetrics">${S.gateways.map(metric).join("")}</section>
      <div class="config-layout" id="gatewayCards">${S.gateways.map(gatewayCard).join("")}</div>`;
    wireIntegrations();
  }
  // The menu item opens Channels & limits (redraws after data loads keep the tab; a ?tab= link clicks its tab, shared/panel-nav.js).
  document.addEventListener(
    "click",
    event => {
      if (event.target instanceof Element && event.target.closest('#navigation [data-page="Integrations"]')) S.intTab = "settings";
    },
    true,
  );
  document.addEventListener("click", event => {
    const tab = event.target instanceof Element ? event.target.closest("[data-int-tab]") : null;
    if (!tab || current !== "Integrations") return;
    S.intTab = tab.dataset.intTab;
    void integrationsPage();
  });

  const STATUS = g => (g.mode === "live" ? ["Live", "good"] : g.configured && g.enabled ? ["Log only (development)", "blue"] : g.configured ? ["Disabled", "warn"] : ["Not configured", "bad"]);

  function metric(g) {
    const [label] = STATUS(g);
    return `<article class="metric" data-gateway-metric="${g.channel}"><div class="metric-head"><span>${g.channel === "SMS" ? "SMS · mram" : "Email · Mailjet"}</span></div><div class="metric-value">${esc(label)}</div><div class="metric-foot"><span class="trend">${g.last24h.sent} sent</span><span>${g.last24h.failed} failed · ${g.last24h.pending} waiting (24 h)</span></div></article>`;
  }

  function gatewayCard(g) {
    const sms = g.channel === "SMS";
    const [label, tone] = STATUS(g);
    const s = g.settings;
    const key = (id, name, masked, placeholder) =>
      `<label>${esc(name)}<input id="${id}" type="password" autocomplete="new-password" maxlength="500" placeholder="${esc(masked ? `Saved (${masked}) · leave empty to keep` : placeholder)}"></label>`;
    const fields = sms
      ? `${key("gwSmsKey", "API key", s.apiKey, "mram API key")}
         <label>Sender ID<input id="gwSmsSender" maxlength="30" value="${esc(s.senderId)}" placeholder="Approved sender ID or masking"></label>
         <label>API base URL<input id="gwSmsUrl" maxlength="300" value="${esc(s.baseUrl)}"></label>`
      : `${key("gwMailKey", "API key", s.apiKey, "Mailjet API key")}
         ${key("gwMailSecret", "Secret key", s.apiSecret, "Mailjet secret key")}
         <label>From email<input id="gwMailFrom" type="email" maxlength="200" value="${esc(s.fromEmail)}" placeholder="no-reply@your-domain"></label>
         <label>From name<input id="gwMailName" maxlength="100" value="${esc(s.fromName)}"></label>
         <label>API base URL<input id="gwMailUrl" maxlength="300" value="${esc(s.baseUrl)}"></label>`;
    const health = `<p class="panel-subtitle">${pill(label, tone)} ${pill(g.configured ? "Credentials saved" : "No credentials", g.configured ? "good" : "warn")} · Last success: ${esc(when(g.lastSuccessAt))} · Last error: ${esc(when(g.lastErrorAt))}${g.lastError ? ` — ${esc(g.lastError)}` : ""}</p>${g.warning ? `<div class="callout" role="status" style="margin:10px 0">${esc(g.warning)}</div>` : ""}`;
    const settings = `<form class="config-form" id="${sms ? "smsGatewayForm" : "emailGatewayForm"}" novalidate>
        <label class="config-check"><input type="checkbox" name="enabled" ${g.enabled ? "checked" : ""}> Send through ${sms ? "mram" : "Mailjet"} in production</label>
        ${fields}
        <button class="button button-primary" type="submit">Save ${sms ? "SMS" : "email"} gateway</button>
      </form>`;
    const test = `<form class="config-form" id="${sms ? "smsTestForm" : "emailTestForm"}" novalidate style="margin-top:14px">
        ${sms ? `<label>Send a test SMS to<input id="gwTestPhone" required></label>` : `<label>Send a test email to<input id="gwTestEmail" type="email" maxlength="200" required placeholder="you@example.com"></label>`}
        <button class="button" type="submit" ${g.configured ? "" : "disabled"}>Send test ${sms ? "SMS" : "email"}</button>
        <small class="panel-subtitle">Sends one real message now${g.configured ? "" : " (save the credentials first)"}.</small>
        <div data-test-result aria-live="polite"></div>
      </form>`;
    return panel(sms ? "SMS gateway · mram" : "Email gateway · Mailjet", sms ? "Codes, delivery codes and parcel updates by SMS." : "Account, invoice and parcel emails.", health + settings + test, `data-gateway="${g.channel}"`);
  }

  function outboxPanel() {
    const rows = S.outbox.length
      ? S.outbox
          .map(
            m =>
              `<tr><td>${esc(when(m.createdAt))}</td><td>${esc(m.channel)}</td><td>${esc(m.template)}</td><td>${esc(m.to)}</td><td>${pill(m.state === "PENDING" && m.notBefore ? "Waiting" : m.state === "SENT" ? "Sent" : m.state === "FAILED" ? "Failed" : "Pending", m.state === "SENT" ? "good" : m.state === "FAILED" ? "bad" : "warn")}</td><td>${esc(m.provider || "—")}${m.lastError ? ` · ${esc(m.lastError)}` : ""}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="6">No messages yet.</td></tr>`;
    return panel(
      "Recent messages",
      "The latest 50 SMS and emails (message text is hidden: it can contain codes).",
      `<div class="table-scroll"><table id="outboxTable"><thead><tr><th>TIME</th><th>CHANNEL</th><th>EVENT</th><th>TO</th><th>STATUS</th><th>GATEWAY</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    );
  }

  function wireIntegrations() {
    const url = value => {
      try {
        return /^https?:$/.test(new URL(value).protocol) ? "" : "Use an http(s) address";
      } catch {
        return "Enter a full address, e.g. https://…";
      }
    };
    const emailProblem = value => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? "" : "Enter a valid email address");

    const smsForm = document.getElementById("smsGatewayForm");
    DF.validate(smsForm, { gwSmsUrl: url, gwSmsSender: value => (value.length > 30 ? "At most 30 characters" : "") });
    smsForm?.addEventListener("submit", event => {
      event.preventDefault();
      const v = id => smsForm.querySelector(`#${id}`).value.trim();
      const body = { enabled: smsForm.elements.enabled.checked, senderId: v("gwSmsSender"), baseUrl: v("gwSmsUrl"), ...(v("gwSmsKey") ? { apiKey: v("gwSmsKey") } : {}) };
      void saveGateway("sms", body, smsForm);
    });

    const emailForm = document.getElementById("emailGatewayForm");
    DF.validate(emailForm, { gwMailUrl: url, gwMailFrom: value => (value.trim() ? emailProblem(value) : ""), gwMailName: value => (value.trim() ? "" : "Enter a sender name") });
    emailForm?.addEventListener("submit", event => {
      event.preventDefault();
      const v = id => emailForm.querySelector(`#${id}`).value.trim();
      const body = {
        enabled: emailForm.elements.enabled.checked,
        fromName: v("gwMailName"),
        baseUrl: v("gwMailUrl"),
        ...(v("gwMailFrom") ? { fromEmail: v("gwMailFrom") } : {}),
        ...(v("gwMailKey") ? { apiKey: v("gwMailKey") } : {}),
        ...(v("gwMailSecret") ? { apiSecret: v("gwMailSecret") } : {}),
      };
      void saveGateway("email", body, emailForm);
    });

    const smsTest = document.getElementById("smsTestForm");
    const phone = smsTest?.querySelector("#gwTestPhone");
    if (phone) DF.phoneInput(phone);
    smsTest?.addEventListener("submit", event => {
      event.preventDefault();
      if (DF.phoneProblem(phone.value)) {
        phone.dispatchEvent(new Event("blur")); // shows the inline message
        phone.focus();
        return;
      }
      void sendTest("sms", { phone: DF.normalizePhone(phone.value) }, smsTest);
    });
    const emailTest = document.getElementById("emailTestForm");
    DF.validate(emailTest, { gwTestEmail: emailProblem });
    emailTest?.addEventListener("submit", event => {
      event.preventDefault();
      void sendTest("email", { email: emailTest.querySelector("#gwTestEmail").value.trim() }, emailTest);
    });
  }

  async function saveGateway(channel, body, form) {
    await busy(form.querySelector('button[type="submit"]'), async () => {
      try {
        await DF.api(`/notifications/gateways/${channel}`, { method: "PUT", body });
        toast(`${CHANNEL_NAME[channel]} gateway saved.`);
        await integrationsPage();
      } catch (error) {
        fail(error);
      }
    });
  }

  async function sendTest(channel, body, form) {
    const result = form.querySelector("[data-test-result]");
    await busy(form.querySelector('button[type="submit"]'), async () => {
      try {
        const r = await DF.api(`/notifications/gateways/${channel}/test`, { method: "POST", body });
        result.innerHTML = r.ok
          ? `<p>${pill("Sent", "good")} ${r.providerMessageId ? `Gateway reference ${esc(r.providerMessageId)}` : ""}</p>`
          : `<p>${pill("Failed", "bad")} ${esc(r.error || "The gateway rejected the message")}</p>`;
        toast(r.ok ? `Test ${CHANNEL_NAME[channel].toLowerCase()} sent.` : `Test ${CHANNEL_NAME[channel].toLowerCase()} failed.`);
      } catch (error) {
        result.innerHTML = `<p>${pill("Failed", "bad")} ${esc(DF.describe(error))}</p>`;
      }
    });
  }
})();
