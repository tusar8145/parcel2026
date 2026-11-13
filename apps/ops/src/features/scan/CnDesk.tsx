/**
 * Scan desk › CN_Merchant: the Ops / Rider apps' CN_Merchant on the web (POST /cn/parcels/merchant). Choose the hub and
 * the merchant, then scan CN labels one after another (handheld scanner, typed or camera): a label's first scan creates
 * its parcel, gives it to the merchant and receives it at the hub. CN_Scan stays in the apps.
 */
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { useOps } from "@/lib/ops";
import { Panel, Pill } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { SearchSelect } from "@panel/ui/SearchSelect";
import { useParcelActions } from "@/features/parcels/useParcelActions";
import { normalizeScan, ScanInput, type ScanInputHandle } from "./scanner";

interface Merchant {
  id: string;
  code: string;
  name: string;
  type: string;
}
interface Outcome {
  outcome: string;
  ok: boolean;
  message: string;
  reading?: boolean;
  parcel: { trackingId: string; merchant: { name: string } | null; recipientName?: string | null; incomplete: boolean; photos: number };
}
interface Entry {
  code: string;
  ok: boolean | null;
  message: string;
  at: string;
  trackingId?: string;
}
const HUB_KEY = "deliveryfast-cn-desk-hub";
const time = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Kept while the panel is open (switching tabs keeps the work). */
const cnDesk = { hubId: "", merchantId: "", merchantLog: [] as Entry[] };

function useHub() {
  const ops = useOps();
  const hubs = ops.myHubs || ops.hubs;
  const [, force] = useState(0);
  if (!cnDesk.hubId || !hubs.some(h => h.id === cnDesk.hubId)) {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(HUB_KEY);
    } catch {
      /* blocked */
    }
    cnDesk.hubId = (hubs.some(h => h.id === saved) && saved) || hubs[0]?.id || "";
  }
  const set = (id: string) => {
    cnDesk.hubId = id;
    try {
      localStorage.setItem(HUB_KEY, id);
    } catch {
      /* blocked */
    }
    force(n => n + 1);
  };
  return { hubs, hubId: cnDesk.hubId, set };
}

function useMerchants() {
  return useQuery({ queryKey: ["cn", "merchants"], queryFn: async () => (await api<{ items: Merchant[] }>("/cn/merchants")).items, staleTime: 5 * 60_000 });
}
const merchantOptions = (list: Merchant[]) => list.map(m => ({ value: m.id, label: `${m.name} · ${m.code}`, group: m.type === "BANKING_FINANCIAL" ? "Banking & Financial" : "E-commerce" }));

function Log({ entries }: { entries: Entry[] }) {
  const actions = useParcelActions();
  if (!entries.length) return <p className="muted" style={{ marginTop: 14 }}>Scanned labels appear here.</p>;
  return (
    <ul className="cn-log" aria-live="polite">
      {entries.map((e, i) => (
        <li key={i} className={e.ok === null ? "info" : e.ok ? "good" : "bad"}>
          <time className="faint">{e.at}</time>
          <strong className="mono">{e.code}</strong>
          <span>{e.message}</span>
          {e.trackingId ? (
            <button type="button" className="link-button" onClick={() => actions.openParcel(e.trackingId!)}>
              Open
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function HubPicker({ hubs, hubId, set }: ReturnType<typeof useHub>) {
  return (
    <label className="field" style={{ minWidth: 220 }}>
      <span>Hub</span>
      <Select className="select" value={hubId} onChange={e => set(e.target.value)} aria-label="Hub">
        {hubs.map(h => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

// ───────────── CN_Merchant ─────────────

export function CnMerchantDesk() {
  const ops = useOps();
  const hub = useHub();
  const merchants = useMerchants();
  const box = useRef<ScanInputHandle>(null);
  const [merchantId, setMerchantId] = useState(cnDesk.merchantId);
  const [, force] = useState(0);
  const merchant = merchants.data?.find(m => m.id === merchantId);

  async function scan(raw: string) {
    if (!ops.require("dispatch", "scan CN labels")) return;
    const code = normalizeScan(raw);
    if (!merchant) {
      box.current?.feedback(false, "Choose the merchant first.");
      return;
    }
    const entry: Entry = { code, ok: null, message: `Giving it to ${merchant.name}…`, at: time() };
    cnDesk.merchantLog.unshift(entry);
    force(n => n + 1);
    try {
      const r = await api<Outcome>("/cn/parcels/merchant", { method: "POST", body: { cn: code, merchantId: merchant.id, hubId: hub.hubId || undefined } });
      entry.ok = r.ok;
      entry.message = r.message;
      entry.trackingId = r.parcel.trackingId;
      box.current?.feedback(r.ok, r.message);
    } catch (error) {
      entry.ok = false;
      entry.message = describe(error);
      box.current?.feedback(false, entry.message);
    }
    force(n => n + 1);
  }

  const done = cnDesk.merchantLog.filter(e => e.ok).length;
  return (
    <Panel title="CN_Merchant" subtitle="Choose the merchant, then scan the CN labels one after another: each becomes that merchant's parcel and is received at the hub.">
      <div className="panel-body">
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
          <HubPicker {...hub} />
          <div className="field" style={{ minWidth: 300, flex: 1 }}>
            <span>Merchant</span>
            <SearchSelect
              label="Merchant"
              placeholder={merchants.isLoading ? "Loading merchants…" : "Choose the merchant"}
              options={merchantOptions(merchants.data ?? [])}
              value={merchantId}
              onChange={v => {
                cnDesk.merchantId = v;
                setMerchantId(v);
                box.current?.focus();
              }}
            />
          </div>
          <div style={{ alignSelf: "center" }}>
            <Pill tone="good">{`${done} done`}</Pill>
          </div>
        </div>
        <ScanInput ref={box} onScan={code => void scan(code)} label={merchant ? `Scan a CN label for ${merchant.name}` : "Choose the merchant, then scan"} placeholder="PP-… CN label" cameraTitle="Scan CN labels" disabled={!merchant} />
        <Log entries={cnDesk.merchantLog} />
      </div>
    </Panel>
  );
}
