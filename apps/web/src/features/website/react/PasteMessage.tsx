"use client";

import { useState } from "react";
import { df } from "./df";

/** Fields read from a pasted message (POST /parse-message), by import column key. */
export type MessageFields = Partial<
  Record<"recipient_name" | "recipient_phone" | "address" | "district" | "zone" | "area" | "cod_amount" | "weight_kg" | "order_ref" | "instructions" | "sender_name" | "sender_phone", string>
>;

/** The "AI" badge text with a small sparkle at its corner. */
function AiIcon() {
  return (
    <span style={{ position: "relative", fontSize: 14, fontWeight: 850, letterSpacing: ".02em", lineHeight: 1 }}>
      {"AI"}
      <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" style={{ position: "absolute", top: -6, right: -8 }}>
        <path d="M12 0c.4 0 .7.3.8.7l1 4.4a7 7 0 0 0 5.1 5.1l4.4 1a.8.8 0 0 1 0 1.6l-4.4 1a7 7 0 0 0-5.1 5.1l-1 4.4a.8.8 0 0 1-1.6 0l-1-4.4a7 7 0 0 0-5.1-5.1l-4.4-1a.8.8 0 0 1 0-1.6l4.4-1a7 7 0 0 0 5.1-5.1l1-4.4c.1-.4.4-.7.8-.7Z" />
      </svg>
    </span>
  );
}

/**
 * "Got the details in a message? Paste it": an optional box above a form. The text (SMS, chat, another
 * platform's message; English or Bangla) is read by the API and `onFill` puts what was found into the form's
 * empty fields, returning the names of the fields it filled.
 */
export function PasteMessage({ kind = "customer", onFill }: { kind?: "customer" | "ecommerce" | "document"; onFill: (fields: MessageFields) => string[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const read = async () => {
    if (text.trim().length < 5) return setNote({ ok: false, text: "Paste the message first." });
    setBusy(true);
    setNote(null);
    try {
      const { fields } = await df().api<{ fields: MessageFields }>("/parse-message", { method: "POST", body: { text, kind } });
      const filled = onFill(fields);
      setNote(
        filled.length
          ? { ok: true, text: `Filled: ${filled.join(", ")}. Check them, and fill in anything still empty.` }
          : { ok: false, text: Object.keys(fields).length ? "Those fields already have values; nothing was changed." : "No name, phone or address found in that message. Please fill in the form." },
      );
    } catch (error) {
      setNote({ ok: false, text: df().describe(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field full df-paste" style={{ border: "1px dashed #b8cdc4", borderRadius: 12, padding: open ? "12px 14px" : "10px 14px", background: "#f6fbf8" }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, border: 0, background: "transparent", padding: 0, cursor: "pointer", textAlign: "left", font: "inherit", color: "inherit" }}>
        <span aria-hidden="true" style={{ display: "grid", placeItems: "center", flex: "none", width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, #0b8a6c, #34b28f)", color: "#fff", boxShadow: "0 4px 10px #087e6730" }}>
          <AiIcon />
        </span>
        <span style={{ flex: 1 }}>
          <strong style={{ display: "block", fontSize: 14 }}>{"Got the details in a message? Paste it"}</strong>
          <span style={{ fontSize: 12.5, color: "#5b716c" }}>{"Optional · we fill the name, phone, address and amount from it (English or বাংলা)"}</span>
        </span>
        <span aria-hidden="true" style={{ color: "#5b716c" }}>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? (
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <textarea
            aria-label="Paste the message"
            value={text}
            onChange={e => setText(e.target.value)}
            rows={5}
            maxLength={3000}
            placeholder={"e.g.\nName: Ayesha Rahman\nPhone: 01712345678\nAddress: House 12, Road 5, Dhanmondi, Dhaka\nCOD: 1250"}
            style={{ width: "100%", padding: "10px 12px", border: "1px solid #dfe8e2", borderRadius: 10, font: "inherit", fontSize: 14, resize: "vertical", background: "#fff" }}
          />
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="button button-primary" onClick={() => void read()} disabled={busy}>
              {busy ? "Reading…" : "Fill the form"}
            </button>
            {text ? (
              <button type="button" className="button button-quiet" onClick={() => (setText(""), setNote(null))}>
                {"Clear"}
              </button>
            ) : null}
          </div>
          {note ? (
            <p role="status" style={{ margin: 0, fontSize: 13, color: note.ok ? "#067647" : "#9a3412" }}>
              {note.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
