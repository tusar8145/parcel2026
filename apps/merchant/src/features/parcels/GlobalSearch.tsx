/**
 * The top search (shared/merchant-parcel.js): tracking ID, CN (pre-printed CNs are the tracking ID), merchant order
 * ref, recipient phone or name, typed or scanned, then Enter. One exact match opens the parcel drawer (?parcel=);
 * several show a short list to pick from. Only this merchant's parcels are found (the API scopes it). Nothing
 * found: a page whose name matches opens (the original search's shortcut). "/" focuses it.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router";
import { normalizeBdPhone } from "@delivery-fast/shared/dist/phone.js";
import { api, ApiError, describe } from "@panel/lib/api";
import { Icon } from "@panel/ui/Icon";
import { toast } from "@panel/ui/toast";
import { useMerchant } from "@/lib/merchant";
import { labelOf, PAGES, slugOf } from "@/app/nav";

const TRACKING_ID = /^[A-Z]{2,4}-?\d{6}-?[0-9A-Z]{4,8}$/;

export interface Found {
  trackingId: string;
  merchantOrderRef?: string | null;
  statusLabel?: string;
  recipient?: { name?: string; phone?: string };
  merchant?: { id: string } | null;
}

export function GlobalSearch() {
  const m = useMerchant();
  const [, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<Found[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  const own = (p: Found) => !p.merchant || p.merchant.id === m.merchant.id;
  const openParcel = (id: string) => {
    setMatches(null);
    setParams(p => (p.set("parcel", id), p));
  };

  async function search(text: string): Promise<Found[]> {
    const upper = text.toUpperCase();
    const code = upper.replace(/\s+/g, "");
    if (TRACKING_ID.test(code)) {
      try {
        const p = await api<Found>(`/parcels/${encodeURIComponent(code)}`);
        if (own(p)) return [p];
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
    }
    const tel = normalizeBdPhone(text);
    const term = tel ? tel.slice(-10) : text;
    const page = await api<{ items: Found[] }>(`/parcels?limit=20&q=${encodeURIComponent(term)}${m.q("&")}`);
    const items = page.items.filter(own);
    const exact = items.filter(p => p.trackingId === code || p.trackingId === upper || (p.merchantOrderRef && p.merchantOrderRef.toUpperCase() === upper));
    return exact.length === 1 ? exact : items;
  }

  async function run() {
    const text = value.trim();
    if (!text) return;
    setBusy(true);
    try {
      const found = await search(text);
      if (!found.length) {
        const page = /api|webhook/i.test(text) ? PAGES.find(p => p.id === "API & Webhooks") : PAGES.find(p => labelOf(p, m.doc).toLowerCase().includes(text.toLowerCase()));
        if (page) navigate(`/${slugOf(page, m.doc)}`);
        else toast(`No parcel found for “${text}” in your account.`);
        return;
      }
      if (found.length === 1) openParcel(found[0].trackingId);
      else setMatches(found);
      input.current?.select();
    } catch (error) {
      toast(describe(error), "bad");
    } finally {
      setBusy(false);
    }
  }

  const rect = input.current?.getBoundingClientRect();
  return (
    <div className="search">
      <Icon name="search" />
      <input
        ref={input}
        className="input"
        type="search"
        placeholder="Tracking ID, CN, reference, phone or name…"
        aria-label="Find a parcel"
        aria-busy={busy || undefined}
        value={value}
        onChange={e => (setValue(e.target.value), setMatches(null))}
        onKeyDown={e => {
          if (e.key === "Enter") (e.preventDefault(), void run());
          if (e.key === "Escape") setMatches(null);
        }}
      />
      {matches && rect
        ? createPortal(
            <div className="menu" role="listbox" aria-label="Matching parcels" style={{ top: rect.bottom + 6, left: rect.left, width: Math.max(rect.width, 320), maxHeight: 360 }} onMouseLeave={() => undefined}>
              <div className="faint" style={{ padding: "4px 8px 6px", fontSize: 12 }}>
                {matches.length} parcels match “{value.trim()}”
              </div>
              {matches.map(p => (
                <button key={p.trackingId} type="button" className="menu-item" onClick={() => openParcel(p.trackingId)}>
                  <span className="grow">
                    <strong>{p.trackingId}</strong>
                    <small className="faint" style={{ display: "block" }}>
                      {[p.recipient?.name, p.statusLabel, p.merchantOrderRef].filter(Boolean).join(" · ")}
                    </small>
                  </span>
                </button>
              ))}
              <button type="button" className="menu-item faint" onClick={() => setMatches(null)}>
                Close
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
