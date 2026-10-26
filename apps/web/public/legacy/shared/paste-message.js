/*
 * Merchant panels › Create order: "Got the customer's details in a message? Paste it" (an optional box at the
 * top of the form). The text — an SMS, a chat, another platform's message, English or Bangla — is read by
 * POST /parse-message, and what it has goes into the form's EMPTY fields: the recipient's name and phone, the
 * full address (its district / zone / area then follow it, DF.autoPlace), COD (switched on with its amount),
 * weight and reference. The rest is typed by hand. The website's booking form has the same box (React,
 * src/features/website/react/PasteMessage.tsx).
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const $ = id => document.getElementById(id);
  const kind = () => (document.body.dataset.app === "banking-merchant" ? "document" : "ecommerce");

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="pasteMessageStyles">
.df-paste{grid-column:1/-1;border:1px dashed #b9c7e6;border-radius:12px;background:#f7f9ff;padding:10px 14px}
.df-paste>button{display:flex;width:100%;align-items:center;gap:10px;border:0;background:transparent;padding:0;cursor:pointer;text-align:left;font:inherit;color:inherit}
.df-paste .df-paste-ai{display:grid;place-items:center;flex:none;width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#2f55c9,#6b8cf0);color:#fff;box-shadow:0 4px 10px #2f55c930}
.df-paste strong{display:block;font-size:14px}
.df-paste small{color:#5d6b80;font-size:12.5px}
.df-paste textarea{width:100%;margin-top:10px;padding:10px 12px;border:1px solid #dfe4ec;border-radius:10px;font:inherit;font-size:13.5px;resize:vertical;background:#fff;min-height:110px}
.df-paste .df-paste-row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.df-paste [role=status]{margin:8px 0 0;font-size:13px}
.df-paste [role=status].ok{color:#067647}.df-paste [role=status].warn{color:#9a3412}
</style>`,
  );

  /** The "AI" badge text with a small sparkle at its corner. */
  const AI_ICON = `<span style="position:relative;font-size:14px;font-weight:850;letter-spacing:.02em;line-height:1">AI<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" style="position:absolute;top:-6px;right:-8px"><path d="M12 0c.4 0 .7.3.8.7l1 4.4a7 7 0 0 0 5.1 5.1l4.4 1a.8.8 0 0 1 0 1.6l-4.4 1a7 7 0 0 0-5.1 5.1l-1 4.4a.8.8 0 0 1-1.6 0l-1-4.4a7 7 0 0 0-5.1-5.1l-4.4-1a.8.8 0 0 1 0-1.6l4.4-1a7 7 0 0 0 5.1-5.1l1-4.4c.1-.4.4-.7.8-.7Z"/></svg></span>`;

  /** Sets an empty field and lets the page's scripts see it (validation, quotes, the address → place). */
  function setIfEmpty(el, value) {
    if (!el || !value || String(el.value || "").trim()) return false;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function apply(f) {
    const filled = [];
    const local = p => String(p || "").replace(/^\+?880/, "").replace(/^0(?=1)/, "");
    if (setIfEmpty($("customerName"), f.recipient_name)) filled.push("name");
    if (setIfEmpty($("customerPhone"), f.recipient_phone && local(f.recipient_phone))) filled.push("phone");
    if (setIfEmpty($("deliveryAddress"), f.address)) filled.push("full address");
    // COD (E-commerce): switch it on with the amount.
    const cod = $("merchantSvcCod");
    const amount = $("merchantSvcCodAmount");
    if (f.cod_amount && Number(f.cod_amount) > 0 && cod && amount && !amount.value) {
      if (!cod.checked) {
        cod.checked = true;
        cod.dispatchEvent(new Event("change", { bubbles: true }));
      }
      setIfEmpty(amount, String(Number(f.cod_amount)));
      filled.push(`COD ৳${Number(f.cod_amount).toLocaleString("en-US")}`);
    }
    const weight = $("merchantWeight");
    if (f.weight_kg && weight && (!weight.value || weight.value === "0.5")) {
      weight.value = "";
      if (setIfEmpty(weight, f.weight_kg)) filled.push("weight");
    }
    if (setIfEmpty($("merchantReferenceNo"), f.order_ref)) filled.push("reference");
    return filled;
  }

  function box() {
    const el = document.createElement("div");
    el.className = "df-paste";
    el.id = "dfPasteMessage";
    el.innerHTML = `<button type="button" data-paste-toggle aria-expanded="false"><span aria-hidden="true" class="df-paste-ai">${AI_ICON}</span><span style="flex:1"><strong>Got the customer's details in a message? Paste it</strong><small>Optional · we fill the name, phone, address and amount from it (English or বাংলা)</small></span><span aria-hidden="true" data-paste-caret>▾</span></button>
      <div data-paste-body hidden><textarea data-paste-text maxlength="3000" aria-label="Paste the message" placeholder="e.g.&#10;Name: Ayesha Rahman&#10;Phone: 01712345678&#10;Address: House 12, Road 5, Dhanmondi, Dhaka&#10;COD: 1250"></textarea>
      <div class="df-paste-row"><button type="button" class="button button-primary" data-paste-read>Fill the form</button><button type="button" class="button" data-paste-clear>Clear</button></div><p role="status" data-paste-note hidden></p></div>`;
    return el;
  }

  /** Keeps the box first in the order form (merchant-bridge.js lays its fields out at the top later). */
  function mount() {
    const grid = document.querySelector("#orderForm .form-grid");
    if (!grid) return;
    const el = $("dfPasteMessage") || box();
    if (grid.firstElementChild !== el) grid.prepend(el);
  }
  new MutationObserver(() => mount()).observe(document.body, { childList: true, subtree: true });
  mount();

  const note = (text, ok) => {
    const p = document.querySelector("#dfPasteMessage [data-paste-note]");
    if (!p) return;
    p.hidden = !text;
    p.className = ok ? "ok" : "warn";
    p.textContent = text;
  };

  document.addEventListener("click", async event => {
    const t = event.target instanceof Element ? event.target : null;
    const root = t?.closest("#dfPasteMessage");
    if (!root) return;
    if (t.closest("[data-paste-toggle]")) {
      const body = root.querySelector("[data-paste-body]");
      body.hidden = !body.hidden;
      root.querySelector("[data-paste-toggle]").setAttribute("aria-expanded", String(!body.hidden));
      root.querySelector("[data-paste-caret]").textContent = body.hidden ? "▾" : "▴";
      if (!body.hidden) root.querySelector("[data-paste-text]").focus();
      return;
    }
    if (t.closest("[data-paste-clear]")) {
      root.querySelector("[data-paste-text]").value = "";
      return note("", true);
    }
    const read = t.closest("[data-paste-read]");
    if (!read) return;
    const text = root.querySelector("[data-paste-text]").value;
    if (text.trim().length < 5) return note("Paste the message first.", false);
    read.disabled = true;
    read.textContent = "Reading…";
    try {
      const { fields } = await DF.api("/parse-message", { method: "POST", body: { text, kind: kind() } });
      const filled = apply(fields);
      note(
        filled.length
          ? `Filled: ${filled.join(", ")}. Check them; district, zone and area follow the address. Fill in anything still empty.`
          : Object.keys(fields).length
            ? "Those fields already have values; nothing was changed."
            : "No name, phone or address found in that message. Please fill in the form.",
        filled.length > 0,
      );
    } catch (error) {
      note(DF.describe(error), false);
    } finally {
      read.disabled = false;
      read.textContent = "Fill the form";
    }
  });
  // Esc / close don't clear it on purpose; a new order starts with an empty box.
  const baseOpen = window.openOrderModal;
  if (typeof baseOpen === "function")
    window.openOrderModal = function (...args) {
      const r = baseOpen.apply(this, args);
      const root = $("dfPasteMessage");
      if (root) {
        root.querySelector("[data-paste-text]").value = "";
        note("", true);
      }
      return r;
    };
})();
