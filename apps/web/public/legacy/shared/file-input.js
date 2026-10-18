/*
 * "Choose file" controls for every panel: DF.fileInput(input, opts).
 *
 * Every visible <input type="file"> becomes a small control: a "Choose file" button, the chosen
 * file's name and size (or "3 files · 820 KB"), an accept hint ("Excel .xlsx or .csv, up to
 * 10 MB"), a clear (×) button and drag-and-drop. The native input stays inside the control (moved
 * one level down, same form, same id / name), so labels, `required`, FormData and every existing
 * upload handler keep working; choosing, dropping and clearing fire the input's normal
 * `input` + `change` events.
 *
 * Applied automatically to file inputs as they appear (MutationObserver). Inputs that are hidden
 * on purpose (the `hidden` attribute or display:none, opened by their own button) and
 * data-file-ui="off" are left alone. Options / attributes:
 *   drop / data-file-drop   → a larger dashed drop zone (imports, documents) instead of the compact row
 *   hint / data-file-hint   → the hint text (default: from `accept`, data-max-mb and `multiple`)
 *   maxMb / data-max-mb     → shown in the hint; dropped files over it are refused with a message
 *   file                    → a File to show as already chosen (forms re-rendered after a pick)
 *   button / data-file-button → the button text (default "Choose file" / "Choose files")
 */
(() => {
  const DF = window.DF || (window.DF = {});
  const done = new WeakMap(); // input → control
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const filesProto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");

  const css = `
.df-file{position:relative;display:flex;align-items:center;gap:10px;box-sizing:border-box;width:100%;min-width:0;padding:7px 8px 7px 10px;border:1px solid var(--line,#e4e8ee);border-radius:8px;background:#fff;color:var(--ink,#172033);font:inherit;font-size:13px;line-height:1.3;text-align:left;transition:border-color .15s,background .15s}
.df-file *{box-sizing:border-box}
.df-file-native{position:absolute!important;left:12px;bottom:0;width:1px!important;height:1px!important;margin:0!important;padding:0!important;opacity:0!important;pointer-events:none;border:0!important}
.df-file-icon{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:7px;background:var(--blue-soft,var(--mint,#edf2ff));color:var(--blue,var(--green,#3766e8))}
.df-file-icon svg{width:16px;height:16px}
.df-file-body{flex:1;min-width:0;display:grid;gap:2px}
.df-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--muted,#7b8796)}
.df-file.df-file--has .df-file-name{color:var(--ink,#172033)}
.df-file-hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--muted,#8792a2);font-weight:400}
.df-file-hint.df-file-error{color:#c2410c;white-space:normal}
.df-file-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:0;margin:0;padding:7px 11px;border:1px solid var(--line,#dfe5ee);border-radius:7px;background:#fff;color:#45536a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;box-shadow:none}
.df-file-btn:hover{border-color:var(--blue,var(--green,#3766e8));color:var(--blue,var(--green,#3766e8))}
.df-file-btn:focus-visible,.df-file-clear:focus-visible{outline:2px solid var(--blue,var(--green,#3766e8));outline-offset:2px}
.df-file-clear{flex:none;display:grid;place-items:center;width:28px;height:28px;min-height:0;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:var(--muted,#7b8796);font:inherit;font-size:18px;line-height:1;cursor:pointer}
.df-file-clear:hover{background:var(--red-soft,#fff0ef);color:var(--red,#c34d4d)}
.df-file-clear[hidden]{display:none}
.df-file.df-file--over{border-color:var(--blue,var(--green,#3766e8));background:var(--blue-soft,var(--mint,#edf2ff))}
.df-file.df-file--disabled{opacity:.6}
.df-file.df-file--disabled .df-file-btn,.df-file.df-file--disabled .df-file-clear{cursor:not-allowed}
.df-file.df-file--drop{flex-wrap:wrap;justify-content:center;gap:8px 12px;padding:20px 16px;border:2px dashed #c7d2e0;border-radius:12px;text-align:center}
.df-file.df-file--drop .df-file-icon{width:40px;height:40px;border-radius:50%}
.df-file.df-file--drop .df-file-icon svg{width:20px;height:20px}
.df-file.df-file--drop .df-file-body{flex:1 1 100%;justify-items:center}
.df-file.df-file--drop .df-file-name{font-size:14px;max-width:100%}
.df-file.df-file--drop .df-file-clear{position:absolute;top:8px;right:8px}
.df-file.df-file--drop.df-file--over{border-style:solid}
@media (max-width:480px){.df-file:not(.df-file--drop){flex-wrap:wrap}.df-file:not(.df-file--drop) .df-file-body{flex:1 1 calc(100% - 80px)}.df-file-btn{padding:8px 12px}}
`;
  function injectStyles() {
    if (document.getElementById("df-file-input-css")) return;
    const style = document.createElement("style");
    style.id = "df-file-input-css";
    style.textContent = css;
    document.head.append(style);
  }

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>`;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const size = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`);

  /** "Excel .xlsx or .csv" / "PNG, JPEG, WebP or PDF" / "Photo" from the accept attribute. */
  function describeAccept(accept) {
    const a = String(accept || "").toLowerCase();
    if (!a) return "";
    const has = re => re.test(a);
    if (has(/xlsx|spreadsheet/) && has(/csv/)) return "Excel .xlsx or .csv";
    if (has(/xlsx|spreadsheet/)) return "Excel .xlsx";
    if (has(/csv/) && !has(/image|pdf/)) return "CSV file (.csv)";
    const kinds = [];
    if (has(/image\/\*/)) kinds.push("Photo");
    else {
      if (has(/png/)) kinds.push("PNG");
      if (has(/jpe?g/)) kinds.push("JPEG");
      if (has(/webp/)) kinds.push("WebP");
    }
    if (has(/pdf/)) kinds.push("PDF");
    if (!kinds.length) return a.split(",").map(s => s.trim()).filter(Boolean).join(", ");
    return kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(", ")} or ${kinds.at(-1)}`;
  }

  /** Whether a dropped file matches `accept` (extensions, exact types, type/*). */
  function accepts(input, file) {
    const list = String(input.accept || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return true;
    const name = file.name.toLowerCase();
    const type = (file.type || "").toLowerCase();
    return list.some(a => (a.startsWith(".") ? name.endsWith(a) : a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a));
  }

  const intentionallyHidden = input => input.hidden || input.style.display === "none" || input.dataset.fileUi === "off" || getComputedStyle(input).display === "none" || Object.keys(input).some(k => k.startsWith("__react"));

  function fileInput(input, opts = {}) {
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return null;
    injectStyles();
    let control = done.get(input);
    if (control?.isConnected && control.contains(input)) {
      control.dfFile.configure(opts);
      return control.dfFile;
    }
    const cfg = {};
    control = document.createElement("div");
    control.className = "df-file";
    control.dataset.dfFile = input.id || input.name || "";
    control.innerHTML = `<span class="df-file-icon">${ICON}</span><span class="df-file-body"><span class="df-file-name"></span><span class="df-file-hint"></span></span><button type="button" class="df-file-btn"></button><button type="button" class="df-file-clear" aria-label="Remove the chosen file" title="Remove" hidden>×</button>`;
    input.before(control);
    control.prepend(input);
    input.classList.add("df-file-native");
    input.tabIndex = -1;
    done.set(input, control);
    const nameEl = control.querySelector(".df-file-name");
    const hintEl = control.querySelector(".df-file-hint");
    const button = control.querySelector(".df-file-btn");
    const clear = control.querySelector(".df-file-clear");
    if (!input.id) input.id = `df-file-${Math.random().toString(36).slice(2, 9)}`;
    nameEl.id = `${input.id}-name`;
    hintEl.id = `${input.id}-hint`;
    button.setAttribute("aria-describedby", `${nameEl.id} ${hintEl.id}`);
    const label = input.labels?.[0]?.textContent?.trim();
    if (label) button.setAttribute("aria-label", `${input.multiple ? "Choose files" : "Choose file"}: ${label.replace(/\s*\*$/, "")}`);
    let error = "";

    function hintText() {
      if (cfg.hint) return cfg.hint;
      const parts = [describeAccept(input.accept)];
      if (cfg.maxMb) parts.push(`up to ${cfg.maxMb} MB${input.multiple ? " each" : ""}`);
      const text = parts.filter(Boolean).join(", ");
      return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
    }
    function refresh() {
      const files = [...(filesProto.get.call(input) || [])];
      const has = files.length > 0;
      control.classList.toggle("df-file--has", has);
      control.classList.toggle("df-file--drop", !!cfg.drop);
      if (has) {
        const total = files.reduce((s, f) => s + f.size, 0);
        nameEl.textContent = files.length === 1 ? `${files[0].name} · ${size(total)}` : `${files.length} files · ${size(total)}`;
        nameEl.title = files.map(f => f.name).join("\n");
      } else {
        nameEl.textContent = cfg.drop ? `Drop ${input.multiple ? "files" : "a file"} here or choose ${input.multiple ? "them" : "one"}` : input.multiple ? "No files chosen" : "No file chosen";
        nameEl.title = "";
      }
      hintEl.textContent = error || hintText();
      hintEl.classList.toggle("df-file-error", !!error);
      hintEl.hidden = !hintEl.textContent;
      button.textContent = cfg.button || (has ? (input.multiple ? "Change files" : "Change file") : input.multiple ? "Choose files" : "Choose file");
      clear.hidden = !has || input.disabled;
      clear.setAttribute("aria-label", files.length > 1 ? "Remove the chosen files" : "Remove the chosen file");
      sync();
    }
    function sync() {
      control.hidden = input.hidden || input.style.display === "none";
      control.classList.toggle("df-file--disabled", input.disabled);
      button.disabled = input.disabled;
      clear.disabled = input.disabled;
    }
    function fire() {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function setFiles(list, notify) {
      const dt = new DataTransfer();
      for (const f of list) dt.items.add(f);
      filesProto.set.call(input, dt.files);
      error = "";
      refresh();
      if (notify) fire();
    }
    // Scripts that reset the input (input.value = "" / input.files = …) update the control too.
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => proto.get.call(input),
      set: v => {
        proto.set.call(input, v);
        error = "";
        refresh();
      },
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      get: () => filesProto.get.call(input),
      set: v => {
        filesProto.set.call(input, v);
        refresh();
      },
    });

    input.addEventListener("change", () => {
      error = "";
      refresh();
    });
    input.form?.addEventListener("reset", () => setTimeout(refresh));
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (!input.disabled) input.click();
    });
    clear.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (input.disabled) return;
      proto.set.call(input, "");
      error = "";
      refresh();
      fire();
      button.focus();
    });
    // The whole drop zone opens the picker (the compact row: only its button, so text stays selectable).
    control.addEventListener("click", event => {
      if (!cfg.drop || input.disabled || event.target.closest("button") || event.target === input || event.target.closest("label")) return;
      input.click();
    });

    // Drag and drop.
    let depth = 0;
    control.addEventListener("dragenter", event => {
      if (input.disabled || !event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      depth++;
      control.classList.add("df-file--over");
    });
    control.addEventListener("dragover", event => {
      if (input.disabled || !event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    control.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) control.classList.remove("df-file--over");
    });
    control.addEventListener("drop", event => {
      if (input.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      control.classList.remove("df-file--over");
      let files = [...(event.dataTransfer?.files || [])];
      if (!files.length) return;
      if (!input.multiple) files = files.slice(0, 1);
      const wrong = files.find(f => !accepts(input, f));
      if (wrong) {
        error = `${wrong.name} isn't accepted here. ${hintText() ? `Use: ${hintText()}.` : ""}`.trim();
        return refresh();
      }
      const big = cfg.maxMb && files.find(f => f.size > cfg.maxMb * 1048576);
      if (big) {
        error = `${big.name} is ${size(big.size)}; the limit is ${cfg.maxMb} MB.`;
        return refresh();
      }
      setFiles(files, true);
    });

    new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ["disabled", "hidden", "style"] });

    function configure(next = {}) {
      Object.assign(cfg, {
        drop: next.drop ?? cfg.drop ?? input.hasAttribute("data-file-drop"),
        hint: next.hint ?? cfg.hint ?? input.dataset.fileHint,
        maxMb: next.maxMb ?? cfg.maxMb ?? (Number(input.dataset.maxMb) || undefined),
        button: next.button ?? cfg.button ?? input.dataset.fileButton,
      });
      if (next.file) setFiles([next.file], false);
      else refresh();
    }
    control.dfFile = { control, input, configure, refresh, clear: () => clear.click() };
    configure(opts);
    return control.dfFile;
  }

  function scan(root) {
    const list = root.querySelectorAll ? root.querySelectorAll('input[type="file"]') : [];
    for (const input of list) if (!done.has(input) && !intentionallyHidden(input)) fileInput(input);
  }
  const start = () => {
    injectStyles();
    scan(document);
    new MutationObserver(records => {
      for (const r of records) for (const node of r.addedNodes) if (node.nodeType === 1) node.matches?.('input[type="file"]') ? !done.has(node) && !intentionallyHidden(node) && fileInput(node) : scan(node);
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });

  DF.fileInput = fileInput;
})();
