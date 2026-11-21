/**
 * Scan desk › CN labels, the Ops / Rider apps' CN features on the web.
 * - CN Assign Merchant (POST /cn/parcels/merchant): choose the hub and the merchant, then scan CN labels one after another
 *   (handheld scanner, typed or camera): a label's first scan creates its parcel, gives it to the merchant and receives
 *   it at the hub.
 * - CN Scan Details (POST /cn/parcels/capture, multipart: photo, cn, hubId, merchantId?): choose a photo of the parcel
 *   with its CN label and the recipient, then scan or type the CN; the AI reads the recipient into that CN's parcel.
 */
import { useRef, useState } from "react";
import { apiRaw } from "@panel/lib/api";
import { toastError } from "@panel/ui/toast";
import { Button } from "@panel/ui/kit";
import { dataUrlBlob, shrink } from "./deskShared";
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
const cnDesk = { hubId: "", merchantId: "", merchantLog: [] as Entry[], scanMerchantId: "", scanLog: [] as Entry[] };

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

// ───────────── CN Assign Merchant ─────────────

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
    <Panel title="CN Assign Merchant" subtitle="Choose the merchant, then scan the CN labels one after another: each becomes that merchant's parcel and is received at the hub.">
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

// ───────────── CN Scan Details ─────────────

export function CnScanDetailsDesk() {
  const ops = useOps();
  const hub = useHub();
  const merchants = useMerchants();
  const box = useRef<ScanInputHandle>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [merchantId, setMerchantId] = useState(cnDesk.scanMerchantId);
  const [photo, setPhoto] = useState<string | null>(null);
  const [, force] = useState(0);
  const merchant = merchants.data?.find(m => m.id === merchantId);

  async function choose(file: File) {
    try {
      setPhoto(await shrink(file));
      box.current?.focus();
    } catch (error) {
      toastError(error);
    }
  }

  async function scan(raw: string) {
    if (!ops.require("dispatch", "scan CN labels")) return;
    const code = normalizeScan(raw);
    if (!photo) {
      box.current?.feedback(false, "Choose the photo of the parcel first, then scan its CN.");
      return;
    }
    const entry: Entry = { code, ok: null, message: "Sending the photo…", at: time() };
    cnDesk.scanLog.unshift(entry);
    force(n => n + 1);
    try {
      const form = new FormData();
      form.append("cn", code);
      if (hub.hubId) form.append("hubId", hub.hubId);
      if (merchant) form.append("merchantId", merchant.id);
      form.append("photo", dataUrlBlob(photo), `${code}.jpg`);
      const r = (await (await apiRaw("/cn/parcels/capture", { method: "POST", body: form })).json()) as Outcome;
      entry.ok = r.ok;
      entry.message = `${r.outcome === "CREATED" ? "New parcel" : "Added"} · ${r.reading ? "reading the details…" : "photo kept (type the details in the parcel)"}${r.message ? ` · ${r.message}` : ""}`;
      entry.trackingId = r.parcel.trackingId;
      box.current?.feedback(r.ok, entry.message);
      // One photo per parcel: the next CN needs its own.
      setPhoto(null);
    } catch (error) {
      entry.ok = false;
      entry.message = describe(error);
      box.current?.feedback(false, entry.message);
    }
    force(n => n + 1);
  }

  const done = cnDesk.scanLog.filter(e => e.ok).length;
  return (
    <Panel title="CN Scan Details" subtitle="Choose a photo of the parcel with its CN label and the recipient's details, then scan or type the CN: the photo goes to that CN's parcel and the AI reads the recipient, phone, address and COD into it. A merchant can be chosen first (optional).">
      <div className="panel-body">
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
          <HubPicker {...hub} />
          <div className="field" style={{ minWidth: 300, flex: 1 }}>
            <span>Merchant (optional)</span>
            <SearchSelect
              label="Merchant"
              placeholder={merchants.isLoading ? "Loading merchants…" : "No merchant (set it later)"}
              emptyLabel="No merchant (set it later)"
              options={merchantOptions(merchants.data ?? [])}
              value={merchantId}
              onChange={v => {
                cnDesk.scanMerchantId = v;
                setMerchantId(v);
              }}
            />
          </div>
          <div style={{ alignSelf: "center" }}>
            <Pill tone="good">{`${done} done`}</Pill>
          </div>
        </div>
        <div
          className="row"
          style={{ gap: 12, alignItems: "center", marginBottom: 12, padding: 12, border: "1px dashed var(--line)", borderRadius: 10 }}
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) void choose(file);
          }}
        >
          <Button icon="camera" onClick={() => photoInput.current?.click()}>
            {photo ? "Choose another photo" : "Choose the photo"}
          </Button>
          {photo ? (
            <>
              <img src={photo} alt="Parcel photo" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }} />
              <small className="faint">{`${Math.round((photo.length * 3) / 4 / 1024)} KB · goes with the next CN`}</small>
              <Button size="sm" onClick={() => setPhoto(null)}>
                Remove
              </Button>
            </>
          ) : (
            <small className="faint">or drop the photo here · JPEG, PNG or WebP</small>
          )}
          <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden onChange={e => (e.target.files?.[0] && void choose(e.target.files[0]), (e.target.value = ""))} />
        </div>
        <ScanInput ref={box} onScan={code => void scan(code)} label={photo ? "Scan or type the CN on this parcel" : "Choose the photo, then scan the CN"} placeholder="PP-… CN label" cameraTitle="Scan the CN label" />
        <Log entries={cnDesk.scanLog} />
      </div>
    </Panel>
  );
}
