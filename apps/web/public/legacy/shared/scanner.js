/*
 * Camera barcode scanning for every panel (docs/architecture-contracts.md → Barcode scanning).
 *
 *   DF.scanner.start(videoElement, onCode)   camera on a <video> you own; onCode(code) per new read
 *   DF.scanner.stop()                        releases the camera
 *   DF.scanner.open({ title, onCode, continuous })   a ready-made camera dialog (resolves with the
 *                                            first code unless continuous)
 *   DF.scanner.attach(input, { onScan, continuous }) adds a "Scan" camera button next to a typed
 *                                            input; a read fills the input and calls onScan(code, "CAMERA")
 *
 * Uses the browser's BarcodeDetector (Code 39 / 128, QR, EAN…) and falls back to ZXing
 * (/vendor/zxing/zxing-browser.min.js, loaded on first use). The typed input always stays
 * usable: USB/Bluetooth scanners in keyboard mode and people typing an ID work as before.
 */
(() => {
  const DF = (window.DF = window.DF || {});
  const FORMATS = ["code_39", "code_128", "qr_code", "ean_13", "ean_8", "upc_a", "itf", "codabar", "data_matrix"];
  const REPEAT_MS = 2500; // the same code seen again within this window is ignored
  let session = null; // { stream, video, stopLoop }
  let zxingLoading = null;

  /** "*PP-261015-1001*" / " pp-261015-1001 " → "PP-261015-1001". */
  const normalize = code => String(code || "").trim().replace(/^\*+|\*+$/g, "").toUpperCase();

  const supported = () => !!navigator.mediaDevices?.getUserMedia && window.isSecureContext !== false;

  function loadZxing() {
    if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
    zxingLoading ??= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/zxing/zxing-browser.min.js";
      script.async = true;
      script.onload = () => (window.ZXingBrowser ? resolve(window.ZXingBrowser) : reject(new Error("ZXing did not load")));
      script.onerror = () => {
        zxingLoading = null;
        reject(new Error("The barcode reader could not be loaded"));
      };
      document.head.append(script);
    });
    return zxingLoading;
  }

  async function nativeDetector() {
    if (!("BarcodeDetector" in window)) return null;
    try {
      const available = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter(f => available.includes(f));
      return formats.includes("code_39") || formats.includes("code_128") ? new window.BarcodeDetector({ formats }) : null;
    } catch {
      return null;
    }
  }

  function feedback() {
    try {
      navigator.vibrate?.(60);
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      osc.frequency.value = 880;
      osc.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
      osc.onended = () => ctx.close();
    } catch {}
  }

  /** Starts the camera on `video` and calls onCode(code) for each new read. */
  async function start(video, onCode) {
    stop();
    if (!supported()) throw new Error("This browser can't use the camera here. Type or scan the code with a keyboard scanner instead.");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    video.muted = true;
    await video.play().catch(() => undefined);
    let last = { code: "", at: 0 };
    const emit = raw => {
      const code = normalize(raw);
      if (!code) return;
      const now = Date.now();
      if (code === last.code && now - last.at < REPEAT_MS) return;
      last = { code, at: now };
      feedback();
      try {
        onCode(code);
      } catch (error) {
        console.error(error);
      }
    };
    const current = { stream, video, stopLoop: () => undefined };
    session = current;
    const detector = await nativeDetector();
    if (detector) {
      let running = true;
      current.stopLoop = () => (running = false);
      const tick = async () => {
        if (!running || session !== current) return;
        try {
          if (video.readyState >= 2) for (const result of await detector.detect(video)) emit(result.rawValue);
        } catch {}
        setTimeout(tick, 180);
      };
      void tick();
    } else {
      const ZX = await loadZxing();
      if (session !== current) return;
      const reader = new ZX.BrowserMultiFormatReader();
      const controls = await reader.decodeFromStream(stream, video, result => result && emit(result.getText()));
      current.stopLoop = () => controls?.stop();
    }
  }

  /** Releases the camera. */
  function stop() {
    const current = session;
    session = null;
    if (!current) return;
    try {
      current.stopLoop();
    } catch {}
    for (const track of current.stream?.getTracks() || []) track.stop();
    if (current.video) current.video.srcObject = null;
  }

  /**
   * A camera dialog. Resolves with the first code (or null when closed) unless `continuous`,
   * in which case onCode is called for every code until the person closes it.
   */
  function open({ title = "Scan barcode", hint = "Point the camera at the barcode on the label.", onCode, continuous = false } = {}) {
    return new Promise(resolve => {
      document.getElementById("dfScannerBackdrop")?.remove();
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div id="dfScannerBackdrop" role="dialog" aria-modal="true" aria-labelledby="dfScannerTitle" style="position:fixed;inset:0;z-index:120;background:#14203399;display:grid;place-items:center;padding:16px"><section style="width:min(520px,100%);background:#fff;border-radius:12px;padding:18px;box-shadow:0 24px 70px #10182840"><header style="display:flex;justify-content:space-between;align-items:center;gap:12px"><h2 id="dfScannerTitle" style="margin:0;font-size:17px"></h2><button type="button" class="button" id="dfScannerClose" aria-label="Close scanner">×</button></header><p id="dfScannerHint" style="margin:6px 0 12px;color:#647184;font-size:13px"></p><div style="position:relative;border-radius:10px;overflow:hidden;background:#101828;aspect-ratio:4/3"><video id="dfScannerVideo" style="width:100%;height:100%;object-fit:cover" muted playsinline></video><div aria-hidden="true" style="position:absolute;left:12%;right:12%;top:38%;height:24%;border:2px solid #fcc118;border-radius:8px;box-shadow:0 0 0 999px #10182855"></div></div><p id="dfScannerStatus" aria-live="polite" style="margin:10px 0 0;color:#455265;font-size:13px;min-height:18px"></p><form id="dfScannerManual" style="display:flex;gap:8px;margin-top:10px"><input class="table-search" id="dfScannerTyped" style="flex:1" placeholder="Or type the code" aria-label="Type the code" autocomplete="off"><button class="button" type="submit">Use code</button></form></section></div>`,
      );
      const backdrop = document.getElementById("dfScannerBackdrop");
      document.getElementById("dfScannerTitle").textContent = title;
      document.getElementById("dfScannerHint").textContent = hint;
      const status = document.getElementById("dfScannerStatus");
      let done = false;
      const close = code => {
        if (done) return;
        done = true;
        stop();
        backdrop.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(code ?? null);
      };
      const accept = (code, source) => {
        code = normalize(code);
        if (!code) return;
        if (continuous) {
          status.textContent = `Read ${code}`;
          onCode?.(code, source);
        } else {
          onCode?.(code, source);
          close(code);
        }
      };
      const onKey = event => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close(null);
        }
      };
      document.addEventListener("keydown", onKey, true);
      document.getElementById("dfScannerClose").addEventListener("click", () => close(null));
      backdrop.addEventListener("click", event => event.target === backdrop && close(null));
      document.getElementById("dfScannerManual").addEventListener("submit", event => {
        event.preventDefault();
        const input = document.getElementById("dfScannerTyped");
        accept(input.value, "KEYBOARD");
        input.value = "";
      });
      status.textContent = "Starting the camera…";
      start(document.getElementById("dfScannerVideo"), code => accept(code, "CAMERA"))
        .then(() => !done && (status.textContent = continuous ? "Scanning · close when you're done." : "Looking for a barcode…"))
        .catch(error => {
          status.textContent = error?.name === "NotAllowedError" ? "Camera permission was denied. Type the code instead." : error?.message || "The camera isn't available. Type the code instead.";
          document.getElementById("dfScannerTyped")?.focus();
        });
    });
  }

  /** Adds a camera button after a typed input; the typed input keeps working. */
  function attach(input, { onScan, continuous = false, title, label = "Scan" } = {}) {
    if (!input || input.dataset.dfScanner) return input;
    input.dataset.dfScanner = "1";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-sm";
    button.textContent = label;
    button.title = "Scan with the camera";
    button.setAttribute("aria-label", `${label} with the camera`);
    button.style.marginLeft = "6px";
    button.addEventListener("click", () =>
      open({
        title: title || "Scan barcode",
        continuous,
        onCode: code => {
          input.value = code;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          onScan?.(code, "CAMERA");
        },
      }),
    );
    input.after(button);
    return input;
  }

  /**
   * The same scan result for every scan box: a short high beep (ok) or a long low one (error), a
   * vibration on phones, and the box flashing green or red. `input` is an element or its id (looked up
   * now, so a box redrawn after the scan still flashes); `message` (optional) is announced in a polite
   * live region next to it. The box gets data-scan-result="ok|error" (browser tests read it).
   *   DF.scanner.feedback(input, ok, message?)
   */
  let feedbackCtx = null;
  function scanFeedback(input, ok, message) {
    try {
      navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
      feedbackCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const osc = feedbackCtx.createOscillator();
      const gain = feedbackCtx.createGain();
      osc.frequency.value = ok ? 880 : 220;
      gain.gain.value = 0.06;
      osc.connect(gain).connect(feedbackCtx.destination);
      osc.start();
      osc.stop(feedbackCtx.currentTime + (ok ? 0.08 : 0.25));
    } catch {}
    const el = typeof input === "string" ? document.getElementById(input) : input;
    if (!el) return;
    el.dataset.scanResult = ok ? "ok" : "error";
    const colour = ok ? "#12a150" : "#d92d20";
    el.style.transition = "box-shadow .15s, border-color .15s";
    el.style.boxShadow = `0 0 0 3px ${ok ? "#12a15033" : "#d92d2033"}`;
    el.style.borderColor = colour;
    clearTimeout(el._dfScanTimer);
    el._dfScanTimer = setTimeout(() => {
      el.style.boxShadow = "";
      el.style.borderColor = "";
    }, 900);
    if (message != null) {
      let live = el.parentElement?.querySelector(":scope > .df-scan-result");
      if (!live) {
        live = document.createElement("small");
        live.className = "df-scan-result";
        live.setAttribute("role", "status");
        live.setAttribute("aria-live", "polite");
        live.style.cssText = "display:block;margin-top:4px;font-size:12px;font-weight:600";
        (el.nextElementSibling?.matches?.("button") ? el.nextElementSibling : el).after(live);
      }
      live.textContent = message;
      live.style.color = colour;
    }
  }

  DF.scanner = { start, stop, open, attach, normalize, supported, feedback: scanFeedback };
})();
