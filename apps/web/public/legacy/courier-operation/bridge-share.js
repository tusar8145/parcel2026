/*
 * Courier Operations › "Share files" (top bar; API: /file-shares). Files from another device, by QR code:
 *
 *   1. The dialog opens a link: POST /file-shares → a QR code and link, opened on the other device
 *      (/share/<token>, app/(scan)), which drops or chooses files.
 *   2. Each file arrives here (file_share.received on GET /events, or GET /file-shares/:id while the
 *      dialog is open: it also keeps the link alive) and is listed with Download.
 *   3. Closing the dialog ends the link and deletes the files (DELETE /file-shares/:id). Nothing is kept.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const POLL_MS = 20_000;
  const state = { share: null, files: [], timer: null, error: "" };

  // eslint-disable-next-line no-undef
  const toast = message => (typeof showToast === "function" ? showToast(message) : DF.toast?.(message));
  const size = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  // ───────────── top bar button ─────────────

  const ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg>`;
  function button() {
    if ($("fileShareButton")) return;
    const bar = document.querySelector(".topbar .top-actions");
    if (!bar || !Ops.me || !Ops.can("dispatch")) return;
    bar.insertAdjacentHTML(
      "afterbegin",
      `<button type="button" class="button button-sm" id="fileShareButton" aria-haspopup="dialog" title="Receive files from a phone or another computer (QR code)" style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">${ICON}<span>Share files</span></button>`,
    );
    $("fileShareButton").addEventListener("click", openDialog);
  }

  // ───────────── the dialog ─────────────

  function openDialog() {
    if ($("fileShareBackdrop")) return;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="modal-backdrop open" id="fileShareBackdrop" role="dialog" aria-modal="true" aria-labelledby="fileShareTitle" style="z-index:125"><div class="modal" style="max-width:min(560px,calc(100vw - 32px))"><div class="modal-head"><div><h2 id="fileShareTitle">Share files</h2><p>Send files here from a phone or another computer.</p></div><button type="button" class="modal-close" data-fsh="close" aria-label="Close">×</button></div><div id="fileShareBody"></div><div class="modal-actions"><small style="color:#8b96a4;margin-right:auto;align-self:center">Closing this window ends the link and deletes these files.</small><button type="button" class="button button-primary" data-fsh="close">Close</button></div></div></div>`,
    );
    $("fileShareBackdrop").addEventListener("click", onClick);
    Object.assign(state, { share: null, files: [], error: "" });
    paint();
    void (async () => {
      try {
        state.share = await DF.api("/file-shares", { method: "POST" });
        if (!$("fileShareBackdrop")) return void end(state.share); // closed while opening
        state.timer = setInterval(() => void refresh(), POLL_MS);
      } catch (error) {
        state.error = DF.describe(error);
      }
      paint();
    })();
  }

  function paint() {
    const body = $("fileShareBody");
    if (!body) return;
    const s = state.share;
    if (!s) {
      body.innerHTML = state.error ? `<p role="alert" style="color:#b42318;font-weight:600">${esc(state.error)}</p>` : `<p class="panel-subtitle" style="padding:24px 0;text-align:center">Creating the link…</p>`;
      return;
    }
    const files = state.files.length
      ? `<ul style="list-style:none;margin:0;padding:0;display:grid;gap:6px;max-height:260px;overflow:auto">${state.files
          .map(
            f =>
              `<li style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e6e9ef;border-radius:8px"><span style="flex:1;min-width:0"><strong style="display:block;font-size:13px;overflow-wrap:anywhere">${esc(f.name)}</strong><small style="color:#7b8594">${esc(size(f.size))} · ${esc(new Date(f.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }))}</small></span><button type="button" class="button button-sm" data-fsh="download" data-file="${esc(f.id)}">Download</button></li>`,
          )
          .join("")}</ul>`
      : `<p style="margin:0;padding:14px;border:1px dashed #d0d7e2;border-radius:8px;text-align:center;color:#7b8594;font-size:13px">No files yet. They appear here as soon as they are sent.</p>`;
    body.innerHTML = `<div style="display:grid;gap:14px">
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <div id="fileShareQr" style="width:170px;height:170px;flex:none">${s.qrSvg}</div>
        <div style="display:grid;gap:8px;flex:1;min-width:220px">
          <p style="margin:0;font-size:13px;color:#586577;line-height:1.5">Scan the QR code with the phone's camera, or open the link on another device, then drop or choose files (up to ${esc(s.maxFileMb)} MB each).</p>
          <div style="display:flex;gap:6px"><input class="table-search" id="fileShareUrl" readonly value="${esc(s.url)}" style="flex:1;min-width:0" aria-label="Share link"><button type="button" class="button button-sm" data-fsh="copy">Copy</button></div>
        </div>
      </div>
      <div><strong style="display:block;font-size:13px;margin-bottom:6px">Files received · ${state.files.length}</strong>${files}</div>
      ${state.error ? `<p role="alert" style="margin:0;color:#b42318;font-size:13px">${esc(state.error)}</p>` : ""}
    </div>`;
    const svg = body.querySelector("#fileShareQr svg");
    if (svg) svg.setAttribute("style", "width:100%;height:100%");
  }

  async function refresh() {
    const s = state.share;
    if (!s || !$("fileShareBackdrop")) return;
    try {
      const r = await DF.api(`/file-shares/${encodeURIComponent(s.id)}`);
      if (state.share !== s) return;
      const changed = r.files.length !== state.files.length;
      state.files = r.files;
      if (changed) paint();
    } catch (error) {
      if (error?.status === 404 && state.share === s) {
        clearInterval(state.timer);
        state.error = "The link expired. Close this window and open Share files again.";
        paint();
      }
    }
  }

  function end(share) {
    if (share) void DF.api(`/file-shares/${encodeURIComponent(share.id)}`, { method: "DELETE" }).catch(() => undefined);
  }
  function close() {
    clearInterval(state.timer);
    $("fileShareBackdrop")?.remove();
    end(state.share);
    Object.assign(state, { share: null, files: [], timer: null, error: "" });
  }

  async function download(fileId) {
    const s = state.share;
    const file = state.files.find(f => f.id === fileId);
    if (!s || !file) return;
    try {
      const response = await DF.apiRaw(`/file-shares/${encodeURIComponent(s.id)}/files/${encodeURIComponent(fileId)}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      toast(DF.describe(error));
    }
  }

  function onClick(event) {
    const el = event.target.closest("[data-fsh]");
    if (!el) return;
    const action = el.dataset.fsh;
    if (action === "close") return close();
    if (action === "download") return void download(el.dataset.file);
    if (action === "copy") {
      const input = $("fileShareUrl");
      void navigator.clipboard?.writeText(input.value).then(() => toast("Link copied."), () => (input.select(), document.execCommand?.("copy")));
    }
  }
  document.addEventListener("keydown", event => event.key === "Escape" && $("fileShareBackdrop") && close());
  // The tab closes or reloads with the dialog open: end the link too.
  window.addEventListener("pagehide", () => state.share && void DF.apiRaw(`/file-shares/${encodeURIComponent(state.share.id)}`, { method: "DELETE", keepalive: true }).catch(() => undefined));

  // ───────────── start ─────────────

  DF.events.on("file_share.received", event => {
    if (!state.share || event.shareId !== state.share.id || state.files.some(f => f.id === event.file?.id)) return;
    state.files = [...state.files, event.file];
    paint();
    toast(`File received: ${event.file.name}`);
  });
  // The top bar is static; the button waits for the signed-in user (only staff who can dispatch).
  let tries = 0;
  const whenReady = () => (Ops.me ? button() : ++tries < 60 && setTimeout(whenReady, 500));
  whenReady();
})();
