/**
 * Merchants (bridge-pages.js register, bridge-merchant-hubs.js, bridge-merchant-tabs.js, bridge-login-as.js):
 *   - the register of ACTIVE merchants (GET /ops/merchants) in tabs by type (Banking & Financial first · E-commerce ·
 *     All, with counts), searchable, filtered by hub (the hub serving the pickup address; "No hub"); CSV export
 *   - "Address changes to approve" (GET /merchant-address-requests → POST …/:id/approve | reject with a reason)
 *   - "Change address" per merchant (PATCH /merchants/:id/address: district → zone → area → street; the hub follows)
 *   - "Log in as" per merchant (support access)
 * Approving and changing addresses need `merchantAddress` (operations managers, super admins).
 */
import { Select } from "@panel/ui/Select";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { saveCsv } from "@panel/lib/csv";
import { useLive } from "@panel/lib/events";
import { num, when } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Loading, PageHeading, Panel, Pill, Tabs, useDebounced } from "@panel/ui/kit";
import { openCustom, prompt } from "@panel/ui/dialogs";
import { toast, toastError } from "@panel/ui/toast";
import { useCatalog, type Catalog } from "@/features/parcels/search";
import { loginAs } from "@/features/support/loginAs";

interface Merchant {
  id: string;
  code: string;
  name: string;
  type: "ECOMMERCE" | "BANKING_FINANCIAL";
  status: string;
  package: { name: string; isDefault?: boolean } | null;
  contactName: string;
  pickupDistrict: string;
  pickupArea: string | null;
  pickupZone: string | null;
  pickupAddress: string | null;
  handover: string | null;
  pickupHub: { id: string; name: string } | null;
  parcelsThisMonth: number;
}
interface AddressRequest {
  id: string;
  merchant: { name: string; code: string } | null;
  previous: { pickup?: string } | null;
  proposed: { pickup?: string } | null;
  hubChanges: boolean;
  previousHub: { name: string } | null;
  proposedHub: { name: string } | null;
  createdAt: string;
  requestedBy: string;
}

const STATUS: Record<string, string> = { ACTIVE: "Active", PENDING_REVIEW: "Review", INFO_REQUESTED: "Info requested", SUSPENDED: "Suspended", REJECTED: "Rejected" };
const TYPE_TABS = ["Banking & Financial", "E-commerce", "All"] as const;
type TypeTab = (typeof TYPE_TABS)[number];
const typeLabel = (m: Merchant) => (m.type === "BANKING_FINANCIAL" ? "Banking & Financial" : "E-commerce");
const pickupText = (m: Merchant) => `${m.pickupZone || m.pickupArea}, ${m.pickupDistrict}${m.pickupZone ? "" : " (address not completed)"}${m.handover === "HUB_DROP" ? " · drops at hub" : ""}`;
const packageText = (m: Merchant) => (m.package ? `${m.package.name}${m.package.isDefault ? " (default)" : ""}` : "Default package");

export default function Merchants() {
  const ops = useOps();
  const qc = useQueryClient();
  const canAddress = ops.can("merchantAddress");
  const [tab, setTab] = useState<TypeTab>(() => {
    try {
      return (sessionStorage.getItem("df-ops-merchant-tab") as TypeTab) || "Banking & Financial";
    } catch {
      return "Banking & Financial";
    }
  });
  const [hub, setHub] = useState("");
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim().toLowerCase(), 200);
  const merchants = useQuery({ queryKey: ["merchants", "register"], queryFn: () => api<Merchant[]>("/ops/merchants"), staleTime: 60_000 });
  const requests = useQuery({ queryKey: ["merchants", "address-requests"], queryFn: () => api<{ items: AddressRequest[] }>("/merchant-address-requests"), enabled: canAddress, staleTime: 20_000 });
  const reload = () => void qc.invalidateQueries({ queryKey: ["merchants"] });
  useLive(["merchant.address_request", "merchant.updated"], reload);
  useEffect(() => {
    try {
      sessionStorage.setItem("df-ops-merchant-tab", tab);
    } catch {
      /* private mode */
    }
  }, [tab]);

  // Only active merchants (suspended, rejected and under-review accounts aren't worked with here), by hub and search.
  const active = useMemo(() => {
    let list = (merchants.data ?? []).filter(m => m.status === "ACTIVE");
    if (hub) list = list.filter(m => (hub === "none" ? !m.pickupHub : m.pickupHub?.id === hub));
    if (term)
      list = list.filter(m => [m.name, m.code, m.contactName, pickupText(m), m.pickupHub?.name, packageText(m)].some(v => String(v ?? "").toLowerCase().includes(term)));
    return list;
  }, [merchants.data, hub, term]);
  const inTab = (t: TypeTab) => (t === "All" ? active : active.filter(m => typeLabel(m) === t));
  const shown = inTab(tab);

  function exportCsv() {
    if (!shown.length) return toast("No filtered or selected records are available to export.", "bad");
    saveCsv("delivery-fast-merchants.csv", [
      ["MERCHANT", "ACCOUNT ID", "PACKAGE", "PICKUP", "HUB", "SHIPMENTS MTD", "ACCOUNT OWNER", "STATUS"],
      ...shown.map(m => [`${m.name} · ${typeLabel(m)}`, m.code, packageText(m), pickupText(m), m.pickupHub?.name || "No hub", m.parcelsThisMonth, m.contactName, STATUS[m.status] || m.status]),
    ]);
    toast(`${shown.length} merchants record(s) exported as CSV.`, "good");
  }
  async function approve(r: AddressRequest) {
    try {
      const res = await api<AddressRequest>(`/merchant-address-requests/${r.id}/approve`, { method: "POST" });
      toast(`${res.merchant?.name || "Merchant"}: address change approved.${res.hubChanges ? ` Hub: ${res.proposedHub?.name || "none yet"}.` : ""}`, "good");
      reload();
    } catch (e) {
      toastError(e);
    }
  }
  async function reject(r: AddressRequest) {
    const note = await prompt({ title: "Reject the address change?", message: "The merchant gets this reason by SMS and email.", label: "Reason", multiline: true, ok: "Reject" });
    if (!note) return;
    try {
      const res = await api<AddressRequest>(`/merchant-address-requests/${r.id}/reject`, { method: "POST", body: { note } });
      toast(`${res.merchant?.name || "Merchant"}: address change rejected.`, "good");
      reload();
    } catch (e) {
      toastError(e);
    }
  }
  const pending = requests.data?.items ?? [];

  return (
    <>
      <PageHeading
        eyebrow="Network operations"
        title="Merchants"
        subtitle="Merchant onboarding, account health, and contracted delivery services."
        actions={
          <Button icon="download" onClick={exportCsv}>
            Export
          </Button>
        }
      />
      {canAddress && pending.length ? (
        <Panel title={`Address changes to approve (${pending.length})`} subtitle="Merchants asked to change their address. Approved, the new address applies and the merchant moves to the hub serving it.">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Current pickup</th>
                  <th>New pickup</th>
                  <th>Hub</th>
                  <th>Asked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map(r => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.merchant?.name || "—"}</strong>
                      <span className="sub">{r.merchant?.code || ""}</span>
                    </td>
                    <td>{r.previous?.pickup || "—"}</td>
                    <td>
                      <strong>{r.proposed?.pickup || "—"}</strong>
                    </td>
                    <td>
                      {r.hubChanges ? (
                        <>
                          {r.previousHub?.name || "No hub"} → <strong>{r.proposedHub?.name || "No hub"}</strong>
                        </>
                      ) : (
                        r.previousHub?.name || "No hub"
                      )}
                    </td>
                    <td>
                      {when(r.createdAt)}
                      <span className="sub">{r.requestedBy}</span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" variant="primary" onClick={() => approve(r)}>
                          Approve
                        </Button>
                        <Button size="sm" onClick={() => void reject(r)}>
                          Reject
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      <Panel
        title="Merchants register"
        subtitle={merchants.error ? describe(merchants.error) : "Active accounts · shipments booked this month"}
        tools={
          <div className="row">
            <input className="input sm" type="search" placeholder="Search merchants..." aria-label="Search Merchants" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220 }} />
            <Select className="select sm" style={{ width: "auto" }} value={hub} onChange={e => setHub(e.target.value)} aria-label="Filter by hub">
              <option value="">All hubs</option>
              {ops.hubs.map(h => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
              <option value="none">No hub</option>
            </Select>
          </div>
        }
        footer={`Showing ${num(shown.length)} active merchant account${shown.length === 1 ? "" : "s"}`}
      >
        <div style={{ padding: "12px 16px" }}>
          <Tabs label="Merchant type" value={tab} onChange={setTab} tabs={TYPE_TABS.map(t => ({ id: t, count: merchants.data ? inTab(t).length : null }))} />
        </div>
        {merchants.isLoading ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Account ID</th>
                  <th>Package</th>
                  <th>Pickup</th>
                  <th>Hub</th>
                  <th className="num">Shipments MTD</th>
                  <th>Account owner</th>
                  <th>Status</th>
                  {canAddress || ops.can("loginAs") ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {shown.map(m => (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.name}</strong>
                      <span className="sub">{typeLabel(m)}</span>
                    </td>
                    <td>{m.code}</td>
                    <td>{packageText(m)}</td>
                    <td>{pickupText(m)}</td>
                    <td>{m.pickupHub?.name || "No hub"}</td>
                    <td className="num">{num(m.parcelsThisMonth)}</td>
                    <td>{m.contactName}</td>
                    <td>
                      <Pill>{STATUS[m.status] || m.status}</Pill>
                    </td>
                    {canAddress || ops.can("loginAs") ? (
                      <td>
                        <div className="row-actions">
                          {canAddress ? (
                            <Button size="sm" title="The merchant's hub follows its pickup address" onClick={() => void changeAddress(m, reload)}>
                              Change address
                            </Button>
                          ) : null}
                          {ops.can("loginAs") ? (
                            <Button size="sm" title="Open this account in a new tab (support access: reason, time limit, recorded)" onClick={() => void loginAs({ merchantId: m.id, name: m.name }, { loginAs: true, loginAsFull: ops.can("loginAsFull") })}>
                              Log in as
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
                {!shown.length ? (
                  <tr>
                    <td colSpan={9} className="empty">
                      {merchants.data?.length ? `No ${tab === "All" ? "" : `${tab} `}merchants.` : "No merchants yet."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

// ───────────── change address ─────────────

function changeAddress(m: Merchant, done: () => void) {
  return openCustom(close => <AddressDialog m={m} close={() => close()} done={done} />);
}

function AddressDialog({ m, close, done }: { m: Merchant; close: () => void; done: () => void }) {
  const catalog = useCatalog();
  const [district, setDistrict] = useState(m.pickupDistrict || "");
  const [zone, setZone] = useState(m.pickupZone || "");
  const [area, setArea] = useState(m.pickupArea || "");
  const [street, setStreet] = useState(m.pickupAddress || "");
  const [hubText, setHubText] = useState<React.ReactNode>("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const zones = catalog?.zonesByDistrict?.[district] ?? [];
  const areas = catalog?.areasByZone?.[zone] ?? [];
  useEffect(() => {
    if (!district || !zone) return void setHubText("");
    let live = true;
    api<{ hub: { name: string } | null }>(`/merchants/pickup-hub?district=${encodeURIComponent(district)}&zone=${encodeURIComponent(zone)}`)
      .then(r => live && setHubText(r?.hub ? <>Hub: <strong>{r.hub.name}</strong></> : "No hub serves this zone yet."))
      .catch(() => live && setHubText(""));
    return () => void (live = false);
  }, [district, zone]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const problem = !district ? "Choose the district." : !zone ? "Choose the zone." : areas.length && !area ? "Choose the area." : street.trim().length < 5 ? "Enter the street address (at least 5 characters)." : "";
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      const saved = await api<{ pickupHub: { name: string } | null }>(`/merchants/${encodeURIComponent(m.id)}/address`, {
        method: "PATCH",
        body: { pickupSameAsBusiness: false, pickup: { district, zone, area: area || undefined, street: street.trim() } },
      });
      close();
      done();
      toast(`${m.name}: address saved.${saved.pickupHub ? ` Hub: ${saved.pickupHub.name}.` : " No hub serves the new zone yet."}`, "good");
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }
  const opts = (list: string[]) => list.map(v => <option key={v}>{v}</option>);
  return (
    <form onSubmit={save} noValidate>
      <div className="dialog-head">
        <div>
          <h2>Change pickup address</h2>
          <p>
            {m.name} · {m.code}. The merchant's hub follows the new address.
          </p>
        </div>
      </div>
      <div className="dialog-body">
        {!catalog ? (
          <Loading rows={3} />
        ) : (
          <div className="form-grid">
            <label className="field full">
              <span>District</span>
              <Select className="select" value={district} onChange={e => (setDistrict(e.target.value), setZone(""), setArea(""))}>
                <option value="">Choose the district</option>
                {opts((catalog as Catalog).districts)}
              </Select>
            </label>
            <label className="field">
              <span>Zone (thana / upazila)</span>
              <Select className="select" value={zone} onChange={e => (setZone(e.target.value), setArea(""))}>
                <option value="">Choose the zone</option>
                {opts(zones)}
              </Select>
            </label>
            <label className="field">
              <span>{areas.length ? "Area" : "Area (none listed)"}</span>
              <Select className="select" value={area} onChange={e => setArea(e.target.value)} disabled={!areas.length}>
                <option value="">{areas.length ? "Choose the area" : "—"}</option>
                {opts(areas)}
              </Select>
            </label>
            <label className="field full">
              <span>Street address</span>
              <input className="input" value={street} onChange={e => setStreet(e.target.value)} placeholder="House, road, building" />
            </label>
            {hubText ? <p className="full" style={{ margin: 0, fontSize: 13 }}>{hubText}</p> : null}
          </div>
        )}
        {error ? (
          <p role="alert" style={{ margin: "10px 0 0", color: "var(--bad)", fontSize: 13 }}>
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-foot">
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !catalog} aria-busy={busy || undefined}>
          Save address
        </Button>
      </div>
    </form>
  );
}


