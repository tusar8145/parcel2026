/*
 * Rider app: proof of delivery with time and place, and camera scanning.
 *
 * - DF.proof.capture() → { capturedAt, lat?, lng?, accuracy? }: the device time and a GPS fix
 *   (requested when the delivery dialog opens, so it's usually ready by the time the rider saves).
 * - DF.proof.stampPhoto(file, stamp) / stampCanvas(canvas, stamp): the photo or signature with a
 *   visible band: tracking ID, rider, date and time (Dhaka) and coordinates. The API stores the
 *   same values on the proof (GET /parcels/:trackingId/proof), so the stamp can be checked.
 * - DF.proof.view(trackingId): proof viewer (Scan page → Recent scans → "View proof").
 * - Scan page: a camera button next to the tracking ID field (DF.scanner, shared/scanner.js);
 *   typing the ID or a keyboard-mode scanner keeps working.
 */
(() => {
  const DF = window.DF;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const FIX_MAX_AGE_MS = 2 * 60_000;
  const MAX_SIDE = 1600;

  let pendingFix = null; // { promise, startedAt }

  /** One GPS fix: high accuracy, short timeout; resolves null when unavailable or refused. */
  function locate(timeout = 10_000) {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp || Date.now() }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
      );
    });
  }
  function prefetch() {
    if (!pendingFix || Date.now() - pendingFix.startedAt > FIX_MAX_AGE_MS) pendingFix = { promise: locate(), startedAt: Date.now() };
    return pendingFix.promise;
  }

  /** The best fix we have: the prefetched one, the live tracker's last fix, or a new one. */
  async function bestFix() {
    const fresh = await Promise.race([prefetch(), new Promise(resolve => setTimeout(() => resolve(undefined), 6000))]);
    if (fresh && Date.now() - fresh.at < FIX_MAX_AGE_MS) return fresh;
    const tracked = DF.gps?.last;
    if (tracked && Date.now() - tracked.at < FIX_MAX_AGE_MS) return tracked;
    return fresh || null;
  }

  async function capture() {
    const fix = await bestFix();
    const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
    return {
      capturedAt: new Date().toISOString(),
      ...(fix ? { lat: round(fix.lat, 6), lng: round(fix.lng, 6), accuracy: Math.min(100_000, Math.round(fix.accuracy)) } : {}),
    };
  }

  const dhakaTime = iso =>
    `${new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} (Dhaka)`;
  const place = c => (c?.lat != null ? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} · ±${Math.round(c.accuracy ?? 0)} m` : "Location unavailable");
  const stampLines = s => [`Delivery Fast · ${s.trackingId}${s.rider ? ` · ${s.rider}` : ""}`, dhakaTime(s.capture.capturedAt), place(s.capture)];

  /** Draws the stamp band at the bottom of ctx's canvas (band already sized). */
  function drawBand(ctx, width, top, height, lines, dark) {
    ctx.fillStyle = dark ? "rgba(17,24,39,.78)" : "#f3f4f6";
    ctx.fillRect(0, top, width, height);
    const size = Math.max(12, Math.round(height / (lines.length + 1.2)));
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = dark ? "#ffffff" : "#1f2937";
    ctx.textBaseline = "top";
    const pad = Math.round(size * 0.6);
    lines.forEach((line, i) => ctx.fillText(line, pad, top + pad * 0.6 + i * size * 1.15, width - pad * 2));
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("That photo couldn't be read. Try another image."));
      image.src = URL.createObjectURL(file);
    });
  }

  /** The photo (at most 1600 px) as JPEG with the time/place band over its lower edge. */
  async function stampPhoto(file, stamp) {
    const image = await loadImage(file);
    try {
      const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const lines = stampLines(stamp);
      const band = Math.max(54, Math.round(canvas.height * 0.13));
      drawBand(ctx, canvas.width, canvas.height - band, band, lines, true);
      return canvas.toDataURL("image/jpeg", 0.85);
    } finally {
      URL.revokeObjectURL(image.src);
    }
  }

  /** The signature on white with the time/place band below it, as PNG. */
  async function stampCanvas(source, stamp) {
    const lines = stampLines(stamp);
    const band = Math.max(60, Math.round(source.height * 0.28));
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height + band;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0);
    drawBand(ctx, canvas.width, source.height, band, lines, false);
    return canvas.toDataURL("image/png");
  }

  // ───────────── delivery dialog: get the fix early and show it ─────────────

  const baseOpenModal = window.openModal;
  window.openModal = function (type, id) {
    baseOpenModal(type, id);
    if (type !== "delivery") return;
    const box = $("proofFields");
    if (!box) return;
    box.insertAdjacentHTML(
      "beforeend",
      `<small id="dfProofStamp" class="panel-subtitle" style="display:block;margin-top:8px">Getting your location for the proof stamp…</small>`,
    );
    const otp = $("otpProof");
    if (otp && navigator.onLine === false) otp.insertAdjacentHTML("beforeend", `<small style="display:block;color:#b87913">You're offline: the code is checked when this update syncs.</small>`);
    prefetch().then(fix => {
      const label = $("dfProofStamp");
      if (!label) return;
      label.textContent = fix
        ? `Proof will be stamped with the time and your location (${place({ ...fix })}).`
        : "Location unavailable (GPS off or permission refused). The proof will be stamped with the time only.";
    });
  };

  // ───────────── proof viewer ─────────────

  async function view(trackingId) {
    activeAction = { type: "df-proof", id: trackingId };
    $("modalTitle").textContent = `Proof of delivery · ${trackingId}`;
    $("modalDescription").textContent = "Loading…";
    $("modalFields").innerHTML = "";
    $("submitAction").textContent = "Close";
    $("actionModal").classList.add("open");
    try {
      const proof = await DF.api(`/parcels/${encodeURIComponent(trackingId)}/proof`);
      const file = proof.image ? await DF.api(`/files/${proof.image.fileId}`, { headers: { accept: "application/json" } }).catch(() => null) : null;
      if (activeAction?.id !== trackingId) return;
      const loc = proof.location;
      const map = loc ? `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}` : null;
      const row = (label, value) => `<div class="earnings-row"><span>${esc(label)}</span><strong>${value}</strong></div>`;
      $("modalDescription").textContent = `Delivered to ${proof.receivedBy}.`;
      $("modalFields").innerHTML = `<div class="field full">${
        file ? `<img class="proof-preview" src="${esc(file.dataUrl)}" alt="Proof of delivery for ${esc(trackingId)}" style="display:block;max-width:100%;border-radius:8px">` : ""
      }${row("Method", proof.method === "OTP" ? `Recipient code${proof.otpVerified ? " · verified" : ""}` : proof.method === "PHOTO" ? "Photo" : "Signature")}${row("Captured", esc(proof.capturedAt ? dhakaTime(proof.capturedAt) : "—"))}${row(
        "Recorded",
        esc(dhakaTime(proof.recordedAt)),
      )}${row("Location", loc ? `<a href="${esc(map)}" target="_blank" rel="noopener">${esc(place(loc))}</a>` : "Not recorded")}${proof.rider ? row("Rider", esc(`${proof.rider.code} · ${proof.rider.name}`)) : ""}${
        proof.note ? row("Note", esc(proof.note)) : ""
      }</div>`;
    } catch (error) {
      if (activeAction?.id === trackingId) $("modalDescription").textContent = DF.describe(error);
    }
  }

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "actionForm" || activeAction?.type !== "df-proof") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeModal();
    },
    true,
  );
  window.addEventListener(
    "click",
    event => {
      const button = event.target.closest("[data-df-proof]");
      if (!button) return;
      event.stopImmediatePropagation();
      void view(button.dataset.dfProof);
    },
    true,
  );

  // The signature photo was removed with the file control's ×: hide its preview too.
  window.addEventListener("change", event => {
    if (event.target.id !== "deliveryPhoto" || event.target.files?.length) return;
    const preview = $("photoPreview");
    if (preview) {
      preview.hidden = true;
      preview.removeAttribute("src");
    }
  });

  // ───────────── scan page: proof links and camera scanning ─────────────

  const baseRender = render;
  render = function (name) {
    baseRender(name);
    if (name !== "Scan parcel") return;
    try {
      const recent = DF.riderState?.summary?.recent || [];
      const items = document.querySelectorAll("#scanHistory .activity");
      recent.forEach((e, i) => {
        if (e.status !== "DELIVERED" || !items[i]) return;
        items[i].querySelector(".activity-copy")?.insertAdjacentHTML("beforeend", ` <button type="button" class="button button-sm" style="margin-top:6px" data-df-proof="${esc(e.trackingId)}">View proof</button>`);
      });
      const input = $("trackingInput");
      if (input && DF.scanner?.attach && !input.dataset.dfScanner) {
        DF.scanner.attach(input, { onScan: code => DF.toast?.(`Scanned ${code}. Choose the event and record it.`) });
        for (const note of document.querySelectorAll("#mainContent .panel-subtitle")) if (/^Type the tracking ID/.test(note.textContent)) note.textContent = "Scan the barcode with the camera, or type the tracking ID (keyboard-mode scanners work too).";
      }
    } catch (error) {
      console.error("Delivery Fast: scan page extras failed", error);
    }
  };

  DF.proof = { capture, stampPhoto, stampCanvas, view, locate };
})();
