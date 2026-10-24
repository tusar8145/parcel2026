/*
 * Courier Operations › "Phone scanner" (top bar; API: /phone-scanner). A phone becomes this tab's
 * barcode scanner:
 *
 *   1. Connect: POST /phone-scanner/links → a QR code and link, opened on the phone (/scanner/<token>,
 *      app/(scan)). The link belongs to this tab only: another tab or browser connects its own phone.
 *   2. Each code the phone reads arrives here (phone_scanner.scan on GET /events, this tab's link id)
 *      and goes into the open page's scan box as a camera read (DF.scanner.deliver, shared/scanner.js):
 *      Scan desk tabs, Parcel queue, Transfers, CN stock, Collect from hub… The page's result (✓ / ✗ and
 *      its message) goes back to the phone, which beeps and shows it.
 *   3. The link stays alive while this tab is open (every minute; kept across a reload) and
 *      Disconnect ends it at once. With no scan box open, the code is offered as "Open parcel".
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops || !DF.scanner) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const STORE = "df-phone-scanner";
  const KEEPALIVE_MS = 60_000;
  const state = { link: null, timer: null, last: null };

  // eslint-disable-next-line no-undef
  const toast = message => (typeof showToast === "function" ? showToast(message) : DF.toast?.(message));
  const remember = () => {
    try {
      if (state.link) sessionStorage.setItem(STORE, JSON.stringify(state.link));
      else sessionStorage.removeItem(STORE);
    } catch {}
  };

  // ───────────── top bar button ─────────────

  const ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10 6h4M10.5 18.5h3"/><path d="M4 8v8M20 8v8"/></svg>`;
  function button() {
    let b = $("phoneScannerButton");
    if (!b) {
      const bar = document.querySelector(".topbar .top-actions");
      if (!bar) return null;
      bar.insertAdjacentHTML(
        "afterbegin",
        `<button type="button" class="button button-sm" id="phoneScannerButton" aria-haspopup="dialog" title="Use a phone as this screen's barcode scanner" style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">${ICON}<span id="phoneScannerLabel">Phone scanner</span></button>`,
      );
      b = $("phoneScannerButton");
      b.addEventListener("click", openDialog);
    }
    return b;
  }
  function paint() {
    const b = button();
    if (!b) return;
    const link = state.link;
    const label = $("phoneScannerLabel");
    if (!link) {
      label.textContent = "Phone scanner";
      b.style.borderColor = b.style.color = "";
      b.dataset.state = "off";
    } else if (link.phoneConnected) {
      label.textContent = `Phone connected${link.scans ? ` · ${link.scans}` : ""}`;
      b.style.borderColor = "#12a150";
      b.style.color = "#0f7a3d";
      b.dataset.state = "connected";
    } else {
      label.textContent = "Phone: waiting…";
      b.style.borderColor = "#b87913";
      b.style.color = "#8a5a0b";
      b.dataset.state = "waiting";
    }
    if ($("phoneScannerBackdrop")) dialogBody();
  }

  // ───────────── the link ─────────────

  async function connect() {
    const link = await DF.api("/phone-scanner/links", { method: "POST" });
    state.link = { id: link.id, url: link.url, qrSvg: link.qrSvg, phoneConnected: false, scans: 0 };
    remember();
    keepAlive();
    paint();
  }

  function keepAlive() {
    clearInterval(state.timer);
    if (!state.link) return;
    state.timer = setInterval(() => void ping(), KEEPALIVE_MS);
  }
  async function ping() {
    if (!state.link) return;
    try {
      const v = await DF.api(`/phone-scanner/links/${encodeURIComponent(state.link.id)}/keepalive`, { method: "POST" });
      Object.assign(state.link, { phoneConnected: v.phoneConnected, scans: v.scans });
      remember();
      paint();
    } catch (error) {
      if (error?.status === 404) {
        ended();
        toast("The phone scanner was disconnected.");
      }
    }
  }
  function ended() {
    clearInterval(state.timer);
    state.link = null;
    remember();
    paint();
  }
  async function disconnect() {
    const link = state.link;
    if (!link) return;
    ended();
    await DF.api(`/phone-scanner/links/${encodeURIComponent(link.id)}`, { method: "DELETE" }).catch(() => undefined);
    toast("Phone scanner disconnected: its link no longer works.");
  }

  // ───────────── codes from the phone ─────────────

  async function received(event) {
    const link = state.link;
    if (!link || event.linkId !== link.id) return; // another tab's phone
    link.phoneConnected = true;
    link.scans = Math.max(link.scans || 0, event.n || 0);
    remember();
    paint();
    const result = await DF.scanner.deliver(event.code);
    if (!result.delivered) {
      notInBox(event.code);
      return report(event.n, false, "No scan box is open on the computer. Open a Scan desk tab or a scan page.");
    }
    report(event.n, result.ok, result.message);
  }
  function report(n, ok, message) {
    if (!state.link) return;
    void DF.api(`/phone-scanner/links/${encodeURIComponent(state.link.id)}/results`, { method: "POST", body: { n, ok, ...(message ? { message: String(message).slice(0, 200) } : {}) } }).catch(() => undefined);
  }
  /** A code with no scan box open: shown with "Open parcel". */
  function notInBox(code) {
    $("phoneScannerCode")?.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="phoneScannerCode" role="status" style="position:fixed;right:18px;bottom:18px;z-index:130;background:#fff;border:1px solid #e3e8ef;border-radius:10px;box-shadow:0 12px 40px #1018282e;padding:12px 14px;display:grid;gap:8px;max-width:320px;font-size:13px">
        <div><strong>Scanned on the phone</strong><div style="font-family:ui-monospace,monospace;margin-top:3px">${esc(code)}</div><small style="color:#647184">No scan box is open on this page.</small></div>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="button button-sm" data-psc="dismiss">Dismiss</button><button type="button" class="button button-sm button-primary" data-psc="open" data-code="${esc(code)}">Open parcel</button></div>
      </div>`,
    );
  }
  document.addEventListener("click", event => {
    const el = event.target.closest?.("[data-psc]");
    if (!el) return;
    if (el.dataset.psc === "open") void Ops.openParcel?.(el.dataset.code);
    $("phoneScannerCode")?.remove();
  });

  // ───────────── the dialog ─────────────

  function openDialog() {
    $("phoneScannerBackdrop")?.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="modal-backdrop open" id="phoneScannerBackdrop" role="dialog" aria-modal="true" aria-labelledby="phoneScannerTitle" style="z-index:125"><div class="modal" style="max-width:min(460px,calc(100vw - 32px))"><div class="modal-head"><div><h2 id="phoneScannerTitle">Phone scanner</h2><p>Use a phone as this screen's barcode scanner.</p></div><button type="button" class="modal-close" data-psd="close" aria-label="Close">×</button></div><div id="phoneScannerBody"></div><div class="modal-actions" id="phoneScannerActions"></div></div></div>`,
    );
    $("phoneScannerBackdrop").addEventListener("click", onDialogClick);
    dialogBody();
    if (!state.link) void connect().catch(error => {
      const body = $("phoneScannerBody");
      if (body) body.innerHTML = `<p role="alert" style="color:#b42318;font-weight:600">${esc(DF.describe(error))}</p>`;
    });
  }
  function dialogBody() {
    const body = $("phoneScannerBody");
    const actions = $("phoneScannerActions");
    if (!body || !actions) return;
    const link = state.link;
    if (!link) {
      body.innerHTML = `<p class="panel-subtitle" style="padding:24px 0;text-align:center">Creating the link…</p>`;
      actions.innerHTML = `<button type="button" class="button" data-psd="close">Close</button>`;
      return;
    }
    const status = link.phoneConnected
      ? `<span class="status status-good" id="phoneScannerStatus">Phone connected · ${link.scans || 0} scan${link.scans === 1 ? "" : "s"}</span>`
      : `<span class="status status-warn" id="phoneScannerStatus">Waiting for the phone…</span>`;
    body.innerHTML = `<div style="display:grid;gap:12px;justify-items:center;text-align:center">
      <div id="phoneScannerQr" style="width:220px;height:220px">${link.qrSvg}</div>
      ${status}
      <p style="margin:0;font-size:13px;color:#586577;line-height:1.5">Scan this QR code with the phone's camera, or open the link on the phone. Codes the phone reads go into the scan box of the page open here (Scan desk, Parcel queue, Transfers…), and the phone beeps with the result.</p>
      <div style="display:flex;gap:6px;width:100%"><input class="table-search" id="phoneScannerUrl" readonly value="${esc(link.url)}" style="flex:1;min-width:0" aria-label="Phone link"><button type="button" class="button button-sm" data-psd="copy">Copy</button></div>
      <small style="color:#8b96a4">The link works only for this tab, while it is open. Another tab or computer connects its own phone.</small>
    </div>`;
    const svg = body.querySelector("#phoneScannerQr svg");
    if (svg) svg.setAttribute("style", "width:100%;height:100%");
    actions.innerHTML = `<button type="button" class="button" data-psd="disconnect" id="phoneScannerDisconnect" style="color:#b42318;margin-right:auto">Disconnect</button><button type="button" class="button button-primary" data-psd="close">Done</button>`;
  }
  function onDialogClick(event) {
    const backdrop = $("phoneScannerBackdrop");
    if (event.target === backdrop) return backdrop.remove();
    const el = event.target.closest("[data-psd]");
    if (!el) return;
    const action = el.dataset.psd;
    if (action === "close") return backdrop?.remove();
    if (action === "copy") {
      const input = $("phoneScannerUrl");
      void navigator.clipboard?.writeText(input.value).then(() => toast("Link copied. Open it on the phone."), () => (input.select(), document.execCommand?.("copy")));
      return;
    }
    if (action === "disconnect") {
      backdrop?.remove();
      return void disconnect();
    }
  }

  // ───────────── start ─────────────

  DF.events.on("phone_scanner.scan", event => void received(event));
  DF.events.on("phone_scanner.status", event => {
    if (!state.link || event.linkId !== state.link.id) return;
    state.link.phoneConnected = !!event.phoneConnected;
    remember();
    paint();
    if (event.phoneConnected) toast("Phone connected: scan labels with it.");
  });
  try {
    state.link = JSON.parse(sessionStorage.getItem(STORE) || "null");
  } catch {}
  paint();
  // Kept across a reload of this tab: check it still works, then keep it alive.
  if (state.link) {
    keepAlive();
    void ping();
  }
  // The top bar is static, but wait for it if the scripts ran first.
  if (!$("phoneScannerButton")) document.addEventListener("DOMContentLoaded", paint, { once: true });
})();
