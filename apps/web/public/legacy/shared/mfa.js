/*
 * Two-step verification (TOTP) for the signed-in user: DF.mfa.manage() opens a dialog to set
 * it up (QR code + first code → recovery codes), create new recovery codes, or turn it off
 * (not allowed for roles that require it). Works on any panel: the dialog brings its own styles.
 * Sign-in challenges are handled by the website's sign-in screens.
 */
(() => {
  const DF = window.DF;
  if (!DF || DF.mfa) return;

  const css = `
.dfmfa-backdrop{position:fixed;inset:0;z-index:2147482000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px}
.dfmfa{background:#fff;color:#0f172a;border-radius:14px;max-width:440px;width:100%;max-height:calc(100vh - 32px);overflow:auto;padding:22px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 20px 50px rgba(0,0,0,.3)}
.dfmfa h2{margin:0 0 6px;font-size:18px}
.dfmfa p{margin:0 0 12px;color:#475569}
.dfmfa label{display:block;font-weight:600;margin:10px 0 4px}
.dfmfa input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;letter-spacing:.08em}
.dfmfa .dfmfa-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:16px}
.dfmfa button{border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
.dfmfa button.primary{background:#ea580c;border-color:#ea580c;color:#fff}
.dfmfa button.danger{color:#b91c1c;border-color:#fecaca}
.dfmfa button:disabled{opacity:.6;cursor:default}
.dfmfa .dfmfa-qr{display:block;margin:8px auto;width:200px;height:200px}
.dfmfa code{display:block;word-break:break-all;background:#f1f5f9;border-radius:8px;padding:8px 10px;font-size:13px}
.dfmfa .dfmfa-codes{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0;font:600 14px ui-monospace,monospace}
.dfmfa .dfmfa-codes span{background:#f1f5f9;border-radius:6px;padding:6px 8px;text-align:center}
.dfmfa .dfmfa-error{color:#b91c1c;font-weight:600;min-height:1em;margin-top:6px}
.dfmfa .dfmfa-pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700}
.dfmfa .on{background:#dcfce7;color:#166534}.dfmfa .off{background:#fee2e2;color:#991b1b}`;

  function dialog() {
    if (!document.getElementById("dfmfa-style")) {
      const style = document.createElement("style");
      style.id = "dfmfa-style";
      style.textContent = css;
      document.head.append(style);
    }
    const backdrop = document.createElement("div");
    backdrop.className = "dfmfa-backdrop";
    const box = document.createElement("div");
    box.className = "dfmfa";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    backdrop.append(box);
    document.body.append(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener("click", e => e.target === backdrop && close());
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", esc);
      }
    });
    return { box, close };
  }

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const describe = error => (DF.describe ? DF.describe(error) : error?.message || "Something went wrong");

  /** A form asking for a code; resolves when `submit(code)` succeeds. */
  function codeForm(box, { title, text, label, button, danger, onSubmit, pattern }) {
    box.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p><form novalidate><label for="dfmfa-code">${escapeHtml(label)}</label><input id="dfmfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="20" required><div class="dfmfa-error" role="alert"></div><div class="dfmfa-row"><button type="button" data-close>Cancel</button><button type="submit" class="${danger ? "danger" : "primary"}">${escapeHtml(button)}</button></div></form>`;
    const form = box.querySelector("form");
    const input = form.querySelector("input");
    const error = form.querySelector(".dfmfa-error");
    input.focus();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const code = input.value.trim().replace(/\s+/g, "");
      if (!(pattern || /^(\d{6}|[A-Za-z0-9]{5}-?[A-Za-z0-9]{5})$/).test(code)) {
        error.textContent = pattern ? "Enter the 6-digit code from your authenticator app" : "Enter a 6-digit code or a recovery code";
        return;
      }
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      error.textContent = "";
      try {
        await onSubmit(code);
      } catch (e) {
        error.textContent = describe(e);
        submit.disabled = false;
        input.select();
      }
    });
    return form;
  }

  function showRecoveryCodes(box, codes, done) {
    box.innerHTML = `<h2>Save your recovery codes</h2><p>Each code signs you in once if you lose your phone. Keep them somewhere safe: they are shown only now.</p><div class="dfmfa-codes">${codes.map(c => `<span>${escapeHtml(c)}</span>`).join("")}</div><div class="dfmfa-row"><button type="button" data-copy>Copy</button><button type="button" data-download>Download</button><button type="button" class="primary" data-done>I've saved them</button></div>`;
    const text = `Paira Express recovery codes (${new Date().toLocaleDateString()})\n\n${codes.join("\n")}\n`;
    box.querySelector("[data-copy]").addEventListener("click", e => {
      navigator.clipboard?.writeText(text).then(() => (e.target.textContent = "Copied"), () => undefined);
    });
    box.querySelector("[data-download]").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = "paira-express-recovery-codes.txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    box.querySelector("[data-done]").addEventListener("click", done);
  }

  async function manage({ onChange } = {}) {
    const { box, close } = dialog();
    box.addEventListener("click", e => e.target.closest?.("[data-close]") && close());
    const changed = () => onChange?.();
    box.innerHTML = `<p>Loading…</p>`;
    let status;
    try {
      status = await DF.api("/auth/mfa");
    } catch (error) {
      box.innerHTML = `<h2>Two-step verification</h2><p>${escapeHtml(describe(error))}</p><div class="dfmfa-row"><button type="button" data-close>Close</button></div>`;
      return;
    }

    const overview = () => {
      const on = status.enabled;
      box.innerHTML = `<h2>Two-step verification <span class="dfmfa-pill ${on ? "on" : "off"}">${on ? "On" : "Off"}</span></h2>
        <p>${
          on
            ? `Signing in needs a code from your authenticator app${status.enabledAt ? ` (on since ${new Date(status.enabledAt).toLocaleDateString()})` : ""}. ${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? "" : "s"} left.`
            : "Protect your account with a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) in addition to your password or SMS code."
        }${status.required ? " Your role requires it." : ""}</p>
        <div class="dfmfa-row">${
          on
            ? `${status.required ? "" : `<button type="button" class="danger" data-off>Turn off</button>`}<button type="button" data-codes>New recovery codes</button><button type="button" class="primary" data-close>Done</button>`
            : `<button type="button" data-close>Not now</button><button type="button" class="primary" data-setup>Set up</button>`
        }</div>`;
      box.querySelector("[data-setup]")?.addEventListener("click", setup);
      box.querySelector("[data-codes]")?.addEventListener("click", newCodes);
      box.querySelector("[data-off]")?.addEventListener("click", turnOff);
    };

    async function setup() {
      box.innerHTML = `<p>Preparing…</p>`;
      let data;
      try {
        data = await DF.api("/auth/mfa/setup", { method: "POST", body: {} });
      } catch (error) {
        box.innerHTML = `<h2>Two-step verification</h2><p>${escapeHtml(describe(error))}</p><div class="dfmfa-row"><button type="button" data-close>Close</button></div>`;
        return;
      }
      const form = codeForm(box, {
        title: "Scan the QR code",
        text: "Scan it with your authenticator app, then enter the 6-digit code it shows.",
        label: "Code from the app",
        button: "Turn on",
        pattern: /^\d{6}$/,
        onSubmit: async code => {
          const result = await DF.api("/auth/mfa/enable", { method: "POST", body: { code } });
          status = await DF.api("/auth/mfa");
          changed();
          showRecoveryCodes(box, result.recoveryCodes, overview);
        },
      });
      form.insertAdjacentHTML(
        "beforebegin",
        `<img class="dfmfa-qr" alt="QR code for your authenticator app" src="${escapeHtml(data.qrDataUrl)}"><p>Can't scan? Enter this key in the app:</p><code>${escapeHtml((data.secret || "").replace(/(.{4})/g, "$1 ").trim())}</code>`,
      );
    }

    function newCodes() {
      codeForm(box, {
        title: "New recovery codes",
        text: "Your old recovery codes stop working. Confirm with a code from your authenticator app.",
        label: "Code from the app",
        button: "Create new codes",
        pattern: /^\d{6}$/,
        onSubmit: async code => {
          const result = await DF.api("/auth/mfa/recovery-codes", { method: "POST", body: { code } });
          status = await DF.api("/auth/mfa");
          showRecoveryCodes(box, result.recoveryCodes, overview);
        },
      });
    }

    function turnOff() {
      codeForm(box, {
        title: "Turn off two-step verification",
        text: "Signing in will only need your password or SMS code. Confirm with a code from your app or a recovery code.",
        label: "Code",
        button: "Turn off",
        danger: true,
        onSubmit: async code => {
          await DF.api("/auth/mfa/disable", { method: "POST", body: { code } });
          status = await DF.api("/auth/mfa");
          changed();
          overview();
        },
      });
    }

    overview();
  }

  DF.mfa = { manage };
})();
