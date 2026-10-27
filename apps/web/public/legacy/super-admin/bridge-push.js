/*
 * Super admin › SMS, Email & Push › "Push notifications" (window.DFPushTab, opened by bridge-notifications.js):
 *
 * - Firebase: the service account file (uploaded or pasted; stored encrypted, never shown again), on / off,
 *   status (project, phones registered per app, last success / error) and a test push to a chosen person
 *   (GET/PUT /notifications/push, POST /notifications/push/test).
 * - Send a message: to every merchant and rider, all merchants, all riders, or chosen people (search by name,
 *   phone, merchant or rider code). It lands in their notifications and as a push on their phones; merchants
 *   get the push when their service plan has "Firebase push notifications" (POST /notifications/push/broadcasts).
 * - History: every message sent, with its audience and counts (GET /notifications/push/broadcasts).
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (typeof showToast === "function" ? showToast(message) : DF.toast?.(message));
  const pill = (text, tone) => `<span class="status status-${tone}">${esc(text)}</span>`;
  const when = value => (value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never");
  const AUDIENCE = { ALL: "All merchants & riders", MERCHANTS: "All merchants", RIDERS: "All riders", USERS: "Chosen people" };
  const fieldStyle = "width:100%;font:inherit;padding:9px 11px;border:1px solid #d9e2dc;border-radius:9px";

  const S = { status: null, history: [], chosen: new Map(), testUser: null, audience: "ALL", stillHere: () => true };

  async function busy(button, work) {
    if (button) button.disabled = true;
    try {
      return await work();
    } catch (error) {
      toast(DF.describe(error));
    } finally {
      if (button) button.disabled = false;
    }
  }

  function statusCard() {
    const s = S.status;
    const [label, tone] = s.active ? (s.source === "file" ? ["On (development key file)", "blue"] : ["On", "good"]) : s.configured ? ["Off", "warn"] : ["Not set up", "bad"];
    const apps = s.devicesByApp || {};
    return `<section class="panel" id="pushSettings"><div class="panel-heading"><div><h2 class="panel-title">Firebase push</h2><p class="panel-subtitle">Push notifications for the Delivery Fast Merchant, Rider and Operations apps (Firebase Cloud Messaging).</p></div></div>
      <div style="padding:0 18px 16px;display:grid;gap:12px">
        <p class="panel-subtitle">${pill(label, tone)} ${pill(s.configured ? "Key saved" : "No key", s.configured ? "good" : "warn")}${s.projectId ? ` · Project <strong>${esc(s.projectId)}</strong>` : ""} · Phones: ${apps.merchant || 0} merchant, ${apps.rider || 0} rider, ${apps.operations || 0} operations · Last success: ${esc(when(s.lastSuccessAt))} · Last error: ${esc(when(s.lastErrorAt))}${s.lastError ? ` — ${esc(s.lastError)}` : ""}</p>
        <label style="display:grid;gap:6px">Service account file (Firebase › Project settings › Service accounts › Generate new private key)
          <input type="file" id="pushKeyFile" accept=".json,application/json">
          <textarea id="pushKeyText" rows="3" style="${fieldStyle};font-family:monospace;font-size:12px" placeholder="${s.configured ? `Saved for ${esc(s.clientEmail || "")} · choose a new file or paste it only to replace the key` : "…or paste the file's contents here"}"></textarea>
        </label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="pushEnabled" ${s.enabled ? "checked" : ""}> Send push notifications</label>
        <div><button type="button" class="button button-primary" data-push-save>Save</button></div>
        <hr style="border:0;border-top:1px solid var(--line, #e9edf2);margin:4px 0">
        <div style="display:grid;gap:6px"><strong>Send a test</strong><span class="panel-subtitle">Choose someone who has the app signed in on a phone.</span>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${picker("pushTestSearch", "Name, phone, merchant or rider code")}<span id="pushTestChosen" class="panel-subtitle"></span><button type="button" class="button" data-push-test>Send test push</button></div>
          <div id="pushTestResults"></div>
        </div>
      </div></section>`;
  }

  const picker = (id, placeholder) => `<input id="${id}" type="search" autocomplete="off" placeholder="${esc(placeholder)}" style="${fieldStyle};max-width:340px">`;

  function composeCard() {
    const radios = Object.entries(AUDIENCE)
      .map(([k, label]) => `<label style="display:inline-flex;gap:6px;align-items:center;margin-right:14px"><input type="radio" name="pushAudience" value="${k}" ${S.audience === k ? "checked" : ""}> ${esc(label)}</label>`)
      .join("");
    return `<section class="panel" id="pushCompose"><div class="panel-heading"><div><h2 class="panel-title">Send a message</h2><p class="panel-subtitle">It appears in each person's notifications and as a push on their phone. Merchants get the push when their service plan has "Firebase push notifications".</p></div></div>
      <div style="padding:0 18px 16px;display:grid;gap:12px">
        <label style="display:grid;gap:6px">Title<input id="pushTitle" maxlength="120" style="${fieldStyle}" placeholder="e.g. Eid holiday schedule"></label>
        <label style="display:grid;gap:6px">Message<textarea id="pushBody" maxlength="500" rows="3" style="${fieldStyle}" placeholder="What do you want to tell them?"></textarea></label>
        <div><strong style="display:block;margin-bottom:6px">Send to</strong>${radios}</div>
        <div id="pushChooser" ${S.audience === "USERS" ? "" : "hidden"} style="display:grid;gap:8px">
          ${picker("pushUserSearch", "Search: name, phone, merchant or rider code")}
          <div id="pushUserResults"></div>
          <div id="pushChosen" style="display:flex;gap:6px;flex-wrap:wrap"></div>
        </div>
        <div><button type="button" class="button button-primary" data-push-send>Send message</button></div>
      </div></section>`;
  }

  function historyCard() {
    const rows = S.history.length
      ? S.history
          .map(
            h => `<tr><td>${esc(when(h.createdAt))}</td><td><strong>${esc(h.title)}</strong><br><span class="panel-subtitle">${esc(h.body)}</span></td><td>${esc(AUDIENCE[h.audience] || h.audience)}${h.audience === "USERS" ? ` (${h.chosen})` : ""}</td><td>${h.recipients}</td><td>${h.sending ? pill("Sending…", "blue") : `${h.delivered} of ${h.devices}${h.failed ? ` · ${pill(`${h.failed} failed`, "warn")}` : ""}`}</td><td>${esc(h.createdBy || "")}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="6" class="panel-subtitle" style="text-align:center;padding:18px">No messages sent yet.</td></tr>`;
    return `<section class="panel table-panel" id="pushHistory"><div class="panel-heading"><div><h2 class="panel-title">Message history</h2><p class="panel-subtitle">Every message sent from here, newest first. Phones: pushes Firebase accepted of the phones it went to.</p></div><div class="table-tools"><button type="button" class="button button-sm" data-push-reload>Refresh</button></div></div>
      <div class="table-scroll"><table id="pushHistoryTable"><thead><tr><th>SENT</th><th>MESSAGE</th><th>TO</th><th>PEOPLE</th><th>PHONES</th><th>BY</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function drawChosen() {
    const box = document.getElementById("pushChosen");
    if (!box) return;
    box.innerHTML = [...S.chosen.values()]
      .map(u => `<span class="status status-blue" style="display:inline-flex;gap:6px;align-items:center">${esc(u.name)} · ${esc(u.detail)}<button type="button" data-push-unchoose="${esc(u.id)}" aria-label="Remove" style="border:0;background:transparent;cursor:pointer;font-weight:700">×</button></span>`)
      .join("");
  }

  function results(list, mode) {
    if (!list.length) return `<p class="panel-subtitle">Nobody found.</p>`;
    return `<div style="display:grid;gap:4px;max-width:620px">${list
      .map(
        u => `<button type="button" class="button button-sm" data-push-pick="${mode}" data-user='${esc(JSON.stringify(u))}' style="justify-content:space-between;display:flex;text-align:left"><span><strong>${esc(u.name)}</strong> · ${esc(u.detail)}${u.phone ? ` · ${esc(u.phone)}` : ""}</span><span class="panel-subtitle">${u.devices ? `${u.devices} phone(s)` : "no app yet"}</span></button>`,
      )
      .join("")}</div>`;
  }

  let searchTimer = null;
  function search(input, target, mode) {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) return void (document.getElementById(target).innerHTML = "");
    searchTimer = setTimeout(async () => {
      try {
        const r = await DF.api(`/notifications/push/recipients?q=${encodeURIComponent(q)}`);
        const box = document.getElementById(target);
        if (box) box.innerHTML = results(r.items, mode);
      } catch (error) {
        toast(DF.describe(error));
      }
    }, 300);
  }

  async function loadHistory() {
    S.history = (await DF.api("/notifications/push/broadcasts?limit=50")).items;
    const card = document.getElementById("pushHistory");
    if (card) card.outerHTML = historyCard();
  }

  async function draw(box) {
    try {
      const [status, history] = await Promise.all([DF.api("/notifications/push"), DF.api("/notifications/push/broadcasts?limit=50")]);
      S.status = status;
      S.history = history.items;
    } catch (error) {
      box.innerHTML = `<p class="panel-subtitle">${esc(DF.describe(error))}</p>`;
      return;
    }
    if (!S.stillHere() || !box.isConnected) return;
    box.innerHTML = `${statusCard()}${composeCard()}${historyCard()}`;
    drawChosen();
    const testChosen = document.getElementById("pushTestChosen");
    if (testChosen && S.testUser) testChosen.textContent = `To: ${S.testUser.name}`;
  }

  window.DFPushTab = (box, stillHere) => {
    S.stillHere = stillHere || (() => true);
    void draw(box);
  };

  document.addEventListener("change", async event => {
    const t = event.target;
    if (!(t instanceof Element)) return;
    if (t.id === "pushKeyFile" && t.files?.[0]) {
      const text = await t.files[0].text();
      const area = document.getElementById("pushKeyText");
      if (area) area.value = text;
      return;
    }
    if (t.name === "pushAudience") {
      S.audience = t.value;
      const chooser = document.getElementById("pushChooser");
      if (chooser) chooser.hidden = S.audience !== "USERS";
    }
  });

  document.addEventListener("input", event => {
    const t = event.target;
    if (!(t instanceof Element)) return;
    if (t.id === "pushUserSearch") search(t, "pushUserResults", "send");
    if (t.id === "pushTestSearch") search(t, "pushTestResults", "test");
  });

  document.addEventListener("click", async event => {
    const t = event.target instanceof Element ? event.target : null;
    if (!t || !t.closest("#pushSettings, #pushCompose, #pushHistory")) return;
    const pick = t.closest("[data-push-pick]");
    if (pick) {
      const user = JSON.parse(pick.dataset.user);
      if (pick.dataset.pushPick === "test") {
        S.testUser = user;
        document.getElementById("pushTestChosen").textContent = `To: ${user.name}`;
        document.getElementById("pushTestResults").innerHTML = "";
      } else {
        S.chosen.set(user.id, user);
        drawChosen();
      }
      return;
    }
    const unchoose = t.closest("[data-push-unchoose]");
    if (unchoose) {
      S.chosen.delete(unchoose.dataset.pushUnchoose);
      return drawChosen();
    }
    const save = t.closest("[data-push-save]");
    if (save)
      return busy(save, async () => {
        const key = document.getElementById("pushKeyText").value.trim();
        S.status = await DF.api("/notifications/push", { method: "PUT", body: { enabled: document.getElementById("pushEnabled").checked, ...(key ? { serviceAccount: key } : {}) } });
        document.getElementById("pushSettings").outerHTML = statusCard();
        toast("Push settings saved.");
      });
    const test = t.closest("[data-push-test]");
    if (test) {
      if (!S.testUser) return toast("Choose who gets the test first.");
      return busy(test, async () => {
        const r = await DF.api("/notifications/push/test", { method: "POST", body: { userId: S.testUser.id } });
        toast(r.delivered ? `Test sent to ${r.delivered} phone(s).` : `Firebase refused the test (${r.failed} failed). See the last error.`);
        S.status = await DF.api("/notifications/push");
        document.getElementById("pushSettings").outerHTML = statusCard();
      });
    }
    const send = t.closest("[data-push-send]");
    if (send) {
      const title = document.getElementById("pushTitle").value.trim();
      const body = document.getElementById("pushBody").value.trim();
      if (title.length < 3) return toast("Write a title (at least 3 characters).");
      if (!body) return toast("Write the message.");
      if (S.audience === "USERS" && !S.chosen.size) return toast("Choose at least one person.");
      const who = S.audience === "USERS" ? `${S.chosen.size} chosen people` : AUDIENCE[S.audience].toLowerCase();
      if (!window.confirm(`Send "${title}" to ${who}?`)) return;
      return busy(send, async () => {
        const r = await DF.api("/notifications/push/broadcasts", { method: "POST", body: { title, body, audience: S.audience, userIds: S.audience === "USERS" ? [...S.chosen.keys()] : [] } });
        toast(`Sent to ${r.recipients} people. Phones are counted in the history.`);
        document.getElementById("pushTitle").value = "";
        document.getElementById("pushBody").value = "";
        S.chosen.clear();
        drawChosen();
        await loadHistory();
        // The phone counts arrive when Firebase has answered.
        setTimeout(() => void loadHistory().catch(() => {}), 4000);
      });
    }
    const reload = t.closest("[data-push-reload]");
    if (reload) return busy(reload, loadHistory);
  });
})();
