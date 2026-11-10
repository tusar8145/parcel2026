/**
 * Service plans & pricing (bridge-packages.js): service packages per segment (Customer · E-commerce · Banking &
 * Financial), in sections:
 *   Packages         the segment's packages (in force, merchants, next change): Edit, Make default, Archive, Delete;
 *                    New package. The editor: details, services (a checkbox each), prices (the catalog's fields), and
 *                    a price preview. Saving creates a version from its date (maker-checker: a second super admin
 *                    approves; the API answers PENDING).
 *   Merchants        assign a package from a date (PUT /merchants/:id/package); search. ?merchant=<code> opens a row.
 *   Price simulator  what a booking costs on the default package (POST /packages/simulate)
 *   (Messages follow the product category: Operational settings › Product categories.)
 *   Hub Pickup       the hold period and the reminder (GET / PUT /packages/settings)
 * The segment (?tab=customer|e-commerce|banking) and the section (?section=) stay in the address.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { confirm } from "@panel/ui/dialogs";
import { Button, Loading, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { toast, toastError } from "@panel/ui/toast";
import { useCatalog } from "@/lib/admin";
import { fmtDate, money, PENDING, SEGMENTS, segLabel, useAssignments, useDeliveryTypes, usePackages, useProducts, useServiceCatalog, type Package, type Product, type Segment, type ServiceCatalog } from "@/lib/packages";

const TAB_OF: Record<string, Segment> = { customer: "CUSTOMER", "e-commerce": "ECOMMERCE", ecommerce: "ECOMMERCE", banking: "BANKING_FINANCIAL", document: "BANKING_FINANCIAL" };
const SLUG_OF: Record<Segment, string> = { CUSTOMER: "customer", ECOMMERCE: "e-commerce", BANKING_FINANCIAL: "banking" };
const outcome = (result: { status?: string } | null | undefined, applied: string) => toast(result?.status === "PENDING" ? PENDING : applied, "good");
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/** Package prices as edited: flat fields, and `deliveryFees` (delivery type code → + charge). */
type Prices = Record<string, number | Record<string, number>> & { deliveryFees?: Record<string, number> };
interface Draft {
  name: string;
  description: string;
  services: Set<string>;
  /** Flat price fields, and `deliveryFees` (delivery type code → + charge). */
  prices: Prices;
  effectiveFrom: string;
  note: string;
  makeDefault: boolean;
}

export default function ServicePlans() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const seg: Segment = TAB_OF[params.get("tab") ?? ""] ?? "CUSTOMER";
  const catalog = useServiceCatalog();
  const packages = usePackages();
  const assignments = useAssignments();
  const products = useProducts();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  useLive(["change.updated"], () => void Promise.all([qc.invalidateQueries({ queryKey: ["admin", "packages"] }), qc.invalidateQueries({ queryKey: ["admin", "package-assignments"] })]));
  // ?merchant=<code> (from a merchant's account dialog): the Merchants section with that merchant.
  const merchantParam = params.get("merchant");
  const section = merchantParam ? "merchants" : params.get("section") || "packages";
  const set = (patch: Record<string, string | null>) =>
    setParams(
      p => {
        for (const [k, v] of Object.entries(patch)) {
          if (v == null || (k === "section" && v === "packages")) p.delete(k);
          else p.set(k, v);
        }
        return p;
      },
      { replace: true },
    );

  const c = catalog.data;
  if (!c || !packages.data) return <>{heading(null)}{catalog.error || packages.error ? <div className="callout bad">{describe(catalog.error || packages.error)}</div> : <Loading rows={8} />}</>;
  const pkgs = packages.data.filter(p => p.segment === seg);
  const servicesFor = (s: Segment) => c.services.filter(x => x.segments.includes(s));
  const productsOf = (s: Segment) => (products.data ?? []).filter(p => p.segment === (s === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE"));
  const rows = assignments.data?.[seg] ?? [];

  function startEdit(pkg: Package | null) {
    const base = pkg?.current || pkg?.versions?.[0];
    const defaults = packages.data!.find(p => p.segment === seg && p.isDefault)?.current;
    setEditing(pkg ? pkg.id : "new");
    setDraft({
      name: pkg?.name ?? "",
      description: pkg?.description ?? "",
      services: new Set(base?.services ?? defaults?.services ?? servicesFor(seg).map(s => s.code)),
      prices: { ...(c!.defaults || {}), ...(defaults?.prices || {}), ...(base?.prices || {}) },
      effectiveFrom: "",
      note: "",
      makeDefault: false,
    });
    window.scrollTo(0, 0);
  }
  const reload = () => Promise.all([qc.invalidateQueries({ queryKey: ["admin", "packages"] }), qc.invalidateQueries({ queryKey: ["admin", "package-assignments"] })]);

  if (editing && draft)
    return (
      <Editor
        seg={seg}
        catalog={c}
        pkg={packages.data.find(p => p.id === editing) ?? null}
        draft={draft}
        setDraft={setDraft}
        products={products.data ?? []}
        close={() => {
          setEditing(null);
          setDraft(null);
        }}
        saved={reload}
      />
    );

  const def = pkgs.find(p => p.isDefault);
  const custom = rows.filter(r => r.package && !r.package.isDefault).length;
  const prods = productsOf(seg);
  const sections: [string, string, number | null][] = [
    ["packages", "Packages", pkgs.filter(p => p.status === "ACTIVE").length],
    ...(seg !== "CUSTOMER" ? [["merchants", "Merchants", rows.length] as [string, string, number]] : []),
    ["simulator", "Price simulator", null],
    ["hub-pickup", "Hub Pickup", null],
  ];
  const current = sections.some(([k]) => k === section) ? section : "packages";
  const tile = (label: string, value: string, hint?: string) => (
    <article className="metric">
      <div className="metric-head">
        <span>{label}</span>
      </div>
      <div className="metric-value" style={{ fontSize: 18 }}>
        {value}
      </div>
      {hint ? (
        <div className="metric-foot">
          <span className="faint">{hint}</span>
        </div>
      ) : null}
    </article>
  );

  return (
    <>
      {heading(
        <Button variant="primary" onClick={() => startEdit(null)}>
          New package
        </Button>,
      )}
      <div className="seg-tabs" role="group" aria-label="Who the plans are for" style={{ marginBottom: 14 }}>
        {SEGMENTS.map(([code, label]) => (
          <button key={code} type="button" aria-pressed={seg === code} className={seg === code ? "on" : ""} onClick={() => set({ tab: SLUG_OF[code], merchant: null })}>
            {label}
          </button>
        ))}
      </div>
      <section className="metrics" aria-label={`${segLabel(seg)} at a glance`}>
        {tile("Default package", def?.name || "None yet", def?.current ? `Version ${def.current.version}` : "Applies when no package is assigned")}
        {tile("Active packages", pkgs.filter(p => p.status === "ACTIVE").length.toLocaleString("en-US"))}
        {seg === "CUSTOMER" ? tile("Applies to", "Website & walk-in", "Customers and walk-in senders") : tile("On their own package", custom.toLocaleString("en-US"), `of ${rows.length.toLocaleString("en-US")} merchants`)}
        {tile("Products", prods.filter(p => p.active).length.toLocaleString("en-US"), "Messages follow their category")}
      </section>
      <div role="tablist" aria-label="Service plan sections" style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line)", marginBottom: 14, overflowX: "auto" }}>
        {sections.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={current === key}
            onClick={() => set({ section: key, merchant: null })}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 14px", marginBottom: -1, border: 0, borderBottom: `2px solid ${current === key ? "var(--primary)" : "transparent"}`, background: "none", color: current === key ? "var(--primary)" : "var(--muted)", font: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
          >
            {label}
            {count == null ? null : <span className="nav-count" style={{ marginLeft: 0 }}>{count}</span>}
          </button>
        ))}
      </div>
      {current === "merchants" ? (
        <Merchants seg={seg} pkgs={pkgs} initialQuery={merchantParam ?? ""} reload={reload} />
      ) : current === "simulator" ? (
        <div style={{ maxWidth: 720 }}>
          <Panel title="Price simulator" subtitle="See what a booking would cost on the default package.">
            <Simulator seg={seg} catalog={c} products={products.data ?? []} services={new Set(def?.current?.services ?? [])} packageId={def?.id} />
          </Panel>
        </div>
      ) : current === "hub-pickup" ? (
        <div style={{ maxWidth: 720 }}>
          <Panel title="Hub Pickup" subtitle="How long a parcel waits at the collection hub, and when the reminder SMS goes out. This applies to every plan.">
            <HubPickup />
          </Panel>
        </div>
      ) : (
        <Panel title="Packages" subtitle={`The default package applies to every ${seg === "CUSTOMER" ? "website customer and walk-in sender" : "merchant without its own package"}. Price and package changes start from their date and need a second super admin's approval; parcels keep the price they were booked with.`}>
          <PackagesTable pkgs={pkgs} onEdit={startEdit} reload={reload} />
        </Panel>
      )}
    </>
  );
}

const heading = (actions: React.ReactNode) => <PageHeading eyebrow="Merchant management · Service packages" title="Service plans & pricing" subtitle="Choose who a plan is for, then manage its packages, merchants and prices." actions={actions} />;

function PackagesTable({ pkgs, onEdit, reload }: { pkgs: Package[]; onEdit: (p: Package) => void; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState("");
  async function run(id: string, work: () => Promise<void>) {
    setBusy(id);
    try {
      await work();
      await reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  if (!pkgs.length) return <p className="panel-body faint">No packages yet.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Package</th>
            <th>In force</th>
            <th className="num">Merchants</th>
            <th>Next change</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {pkgs.map(p => (
            <tr key={p.id}>
              <td>
                <span className="strong">{p.name}</span> {p.status === "ARCHIVED" ? <Pill tone="warn">Archived</Pill> : p.isDefault ? <Pill tone="good">Default</Pill> : <Pill>Active</Pill>}
                <span className="sub">{p.description || ""}</span>
              </td>
              <td>
                {p.current ? (
                  <>
                    v{p.current.version} · since {fmtDate(p.current.effectiveFrom)}
                    <span className="sub">{p.current.services.length} services</span>
                  </>
                ) : (
                  "Not yet in force"
                )}
              </td>
              <td className="num">{p.merchants ?? 0}</td>
              <td>{p.scheduled?.[0] ? `v${p.scheduled[0].version} from ${fmtDate(p.scheduled[0].effectiveFrom)}` : "—"}</td>
              <td>
                <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
                  {p.status === "ACTIVE" ? (
                    <Button size="sm" onClick={() => onEdit(p)}>
                      Edit
                    </Button>
                  ) : null}
                  {p.status === "ACTIVE" && !p.isDefault ? (
                    <Button
                      size="sm"
                      disabled={busy === p.id}
                      onClick={async () => {
                        if (await confirm({ title: `Make ${p.name} the default?`, message: `Every ${segLabel(p.segment)} merchant without their own package will use it.`, ok: "Make default" }))
                          await run(p.id, async () => outcome(await api(`/packages/${p.id}/default`, { method: "POST" }), `${p.name} is now the default package.`));
                      }}
                    >
                      Make default
                    </Button>
                  ) : null}
                  {p.status === "ACTIVE" && !p.isDefault ? (
                    <Button
                      size="sm"
                      disabled={busy === p.id}
                      onClick={async () => {
                        if (await confirm({ title: `Archive ${p.name}?`, message: "It can't be assigned any more; merchants already on it keep it until you assign another.", ok: "Archive", danger: true }))
                          await run(p.id, async () => outcome(await api(`/packages/${p.id}/archive`, { method: "POST" }), `${p.name} archived.`));
                      }}
                    >
                      Archive
                    </Button>
                  ) : null}
                  {!p.isDefault && !p.merchants ? (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy === p.id}
                      onClick={async () => {
                        if (await confirm({ title: `Delete ${p.name}?`, message: "Only packages nothing used can be deleted.", ok: "Delete", danger: true }))
                          await run(p.id, async () => {
                            await api(`/packages/${p.id}`, { method: "DELETE" });
                            toast(`${p.name} deleted.`, "good");
                          });
                      }}
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Merchants({ seg, pkgs, initialQuery, reload }: { seg: Segment; pkgs: Package[]; initialQuery: string; reload: () => Promise<unknown> }) {
  const assignments = useAssignments();
  const [q, setQ] = useState(initialQuery);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [from, setFrom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const rows = assignments.data?.[seg] ?? [];
  const choices = pkgs.filter(p => p.status === "ACTIVE" && !p.isDefault);
  const query = q.trim().toLowerCase();
  const shown = rows.filter(r => !query || `${r.merchant.name} ${r.merchant.code} ${r.merchant.status} ${r.package?.name ?? ""}`.toLowerCase().includes(query));
  useEffect(() => {
    if (!initialQuery) return;
    const t = setTimeout(() => document.querySelector<HTMLSelectElement>(`[data-merchant-row="${CSS.escape(initialQuery)}"] select`)?.focus(), 300);
    return () => clearTimeout(t);
  }, [initialQuery, assignments.data]);
  async function assign(id: string) {
    const row = rows.find(r => r.merchant.id === id);
    const packageId = choice[id] ?? (row?.package && !row.package.isDefault ? row.package.id : "");
    const date = from[id];
    setBusy(id);
    try {
      const result = await api<{ status?: string }>(`/merchants/${id}/package`, { method: "PUT", body: { packageId: packageId || null, ...(date ? { effectiveFrom: new Date(`${date}T00:00:00+06:00`).toISOString() } : {}) } });
      outcome(result, `${row?.merchant.name || "Merchant"} assigned to ${packageId ? pkgs.find(p => p.id === packageId)?.name : "the default package"}${date ? ` from ${date}` : ""}.`);
      await reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  return (
    <Panel
      title={`${segLabel(seg)} merchants`}
      subtitle="Assign a package from a date (empty = now). Merchants without one use the default package."
      tools={<input className="input sm" type="search" placeholder="Search merchants" aria-label="Search merchants" value={q} onChange={e => setQ(e.target.value)} style={{ width: 240 }} />}
    >
      {!rows.length ? (
        <p className="panel-body faint">{assignments.isLoading ? "Loading…" : `No ${segLabel(seg).toLowerCase()} merchants yet.`}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Package now</th>
                <th>Change to</th>
                <th>From</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.merchant.id} data-merchant-row={r.merchant.code} style={initialQuery && r.merchant.code === initialQuery ? { background: "#f3f6ff" } : undefined}>
                  <td>
                    <span className="strong">{r.merchant.name}</span>
                    <span className="sub">
                      {r.merchant.code} · {r.merchant.status}
                    </span>
                  </td>
                  <td>
                    {r.package?.name || "—"} {r.package?.isDefault ? <Pill tone="good">Default</Pill> : null}
                    {r.scheduled.length ? <span className="sub">{`Then ${r.scheduled[0].package?.name || "default"} from ${fmtDate(r.scheduled[0].effectiveFrom)}`}</span> : null}
                  </td>
                  <td>
                    <Select className="select sm" aria-label={`Package for ${r.merchant.name}`} value={choice[r.merchant.id] ?? (r.package && !r.package.isDefault ? r.package.id : "")} onChange={e => setChoice({ ...choice, [r.merchant.id]: e.target.value })}>
                      <option value="">Default package</option>
                      {choices.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <input className="input sm" type="date" aria-label={`From date for ${r.merchant.name}`} min={new Date().toISOString().slice(0, 10)} value={from[r.merchant.id] ?? ""} onChange={e => setFrom({ ...from, [r.merchant.id]: e.target.value })} />
                  </td>
                  <td>
                    <Button size="sm" disabled={busy === r.merchant.id} onClick={() => void assign(r.merchant.id)}>
                      Assign
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

interface SimState {
  pickupDistrict: string;
  pickupZone: string;
  deliveryDistrict: string;
  deliveryZone: string;
  weightKg: string;
  codAmount: string;
  speed: string;
  firstMile: string;
  lastMile: string;
  openBox: boolean;
  product: string;
}
interface SimResult {
  lines: { label: string; amount: number }[];
  totalCharge: number;
  tierLabel: string;
}
let lastSim: SimState = { pickupDistrict: "", pickupZone: "", deliveryDistrict: "", deliveryZone: "", weightKg: "1", codAmount: "0", speed: "REGULAR", firstMile: "", lastMile: "", openBox: false, product: "" };

function Simulator({ seg, catalog, products, services, packageId, draft }: { seg: Segment; catalog: ServiceCatalog; products: Product[]; services: Set<string>; packageId?: string; draft?: { services: Set<string>; prices: Prices } }) {
  const geo = useCatalog();
  const [sim, setSimState] = useState<SimState>(lastSim);
  const setSim = (patch: Partial<SimState>) => setSimState(s => (lastSim = { ...s, ...patch }));
  const [result, setResult] = useState<SimResult | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const districts = geo.data?.districts ?? [];
  const zones = (d: string) => geo.data?.zonesByDistrict?.[d] ?? [];
  const types = useDeliveryTypes();
  const speeds = (types.data ?? []).filter(t => t.active && t.segments.includes(seg)).map(t => [t.code, t.name] as [string, string]);
  async function run(e: FormEvent) {
    e.preventDefault();
    if (!sim.pickupDistrict || !sim.deliveryDistrict) return toast("Choose the districts the parcel goes from and to.", "bad");
    const body = {
      segment: seg,
      pickupDistrict: sim.pickupDistrict,
      ...(sim.pickupZone ? { pickupZone: sim.pickupZone } : {}),
      deliveryDistrict: sim.deliveryDistrict,
      ...(sim.deliveryZone ? { deliveryZone: sim.deliveryZone } : {}),
      weightKg: Number(sim.weightKg) || 1,
      codAmount: Number(sim.codAmount) || 0,
      ...(sim.product ? { product: sim.product } : {}),
      speed: sim.speed,
      ...(sim.firstMile ? { firstMile: sim.firstMile } : {}),
      ...(sim.lastMile ? { lastMile: sim.lastMile } : {}),
      ...(sim.openBox ? { openBox: true } : {}),
      ...(draft ? { services: [...draft.services], prices: draft.prices } : packageId ? { packageId } : {}),
    };
    setBusy(true);
    try {
      setResult(await api<SimResult>("/packages/simulate", { method: "POST", body }));
    } catch (err) {
      setResult({ error: describe(err) });
    } finally {
      setBusy(false);
    }
  }
  const sel = (label: string, value: string, onChange: (v: string) => void, options: [string, string][], empty?: string) => (
    <label className="field">
      <span>{label}</span>
      <Select className="select" value={value} onChange={e => onChange(e.target.value)}>
        {empty !== undefined ? <option value="">{empty}</option> : null}
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
    </label>
  );
  return (
    <form className="panel-body" onSubmit={e => void run(e)} noValidate>
      <div className="form-grid">
        {sel("From district", sim.pickupDistrict, v => setSim({ pickupDistrict: v, pickupZone: "" }), districts.map(d => [d, d]), "Choose")}
        {sel("From zone (optional)", sim.pickupZone, v => setSim({ pickupZone: v }), zones(sim.pickupDistrict).map(z => [z, z]), "Any zone")}
        {sel("To district", sim.deliveryDistrict, v => setSim({ deliveryDistrict: v, deliveryZone: "" }), districts.map(d => [d, d]), "Choose")}
        {sel("To zone (Hub Pickup finds its hub)", sim.deliveryZone, v => setSim({ deliveryZone: v }), zones(sim.deliveryDistrict).map(z => [z, z]), "Any zone")}
        {sel("Delivery type", sim.speed, v => setSim({ speed: v }), speeds)}
        {seg === "BANKING_FINANCIAL" ? null : (
          <>
            <label className="field">
              <span>Weight (kg)</span>
              <input className="input" type="number" min={0.01} step={0.01} value={sim.weightKg} onChange={e => setSim({ weightKg: e.target.value })} />
            </label>
            {sel(
              "What is sent",
              sim.product,
              v => setSim({ product: v }),
              products.filter(x => x.segment === "ECOMMERCE" && x.active && x.type !== "REGULAR").map(x => [x.name, `${x.name} · ${x.type === "BOOKS" ? "Books" : "Document"}`]),
              "Regular (no product)",
            )}
          </>
        )}
        {sel("First mile", sim.firstMile, v => setSim({ firstMile: v }), Object.entries(catalog.labels.firstMile), "Package default")}
        {sel("Last mile", sim.lastMile, v => setSim({ lastMile: v }), Object.entries(catalog.labels.lastMile), "Package default")}
        {seg === "BANKING_FINANCIAL" ? null : (
          <label className="field">
            <span>COD amount (৳)</span>
            <input className="input" type="number" min={0} value={sim.codAmount} onChange={e => setSim({ codAmount: e.target.value })} />
          </label>
        )}
        {seg === "ECOMMERCE" ? (
          <label className="check" style={{ alignSelf: "end" }}>
            <input type="checkbox" checked={sim.openBox} onChange={e => setSim({ openBox: e.target.checked })} /> Open box
          </label>
        ) : null}
      </div>
      <div style={{ marginTop: 12 }}>
        <Button type="submit" variant="primary" disabled={!services.size || busy}>
          Simulate price
        </Button>
      </div>
      {result ? (
        "error" in result ? (
          <p className="callout bad" style={{ marginTop: 10 }}>
            {result.error}
          </p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {result.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.label}</td>
                    <td className="num">
                      {l.amount < 0 ? "−" : ""}
                      {money(Math.abs(l.amount))}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="strong">Total ({result.tierLabel})</td>
                  <td className="num strong">{money(result.totalCharge)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </form>
  );
}

function HubPickup() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "package-settings"], queryFn: () => api<{ collectHoldDays: number; collectReminderHours: number }>("/packages/settings") });
  const [v, setV] = useState<{ hold: string; reminder: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !v) setV({ hold: String(q.data.collectHoldDays), reminder: String(q.data.collectReminderHours) });
  }, [q.data, v]);
  if (!v) return q.error ? <p className="panel-body faint">{describe(q.error)}</p> : <Loading rows={2} />;
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      qc.setQueryData(["admin", "package-settings"], await api("/packages/settings", { method: "PUT", body: { collectHoldDays: Number(v!.hold), collectReminderHours: Number(v!.reminder) } }));
      toast("Collect-from-hub settings saved.", "good");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel-body" onSubmit={e => void save(e)}>
      <div className="form-grid">
        <label className="field">
          <span>Hold period (days)</span>
          <input className="input" type="number" min={1} max={60} value={v.hold} onChange={e => setV({ ...v, hold: e.target.value })} />
        </label>
        <label className="field">
          <span>Reminder before it ends (hours, 0 = none)</span>
          <input className="input" type="number" min={0} max={720} value={v.reminder} onChange={e => setV({ ...v, reminder: e.target.value })} />
        </label>
      </div>
      <div style={{ marginTop: 12 }}>
        <Button type="submit" variant="primary" disabled={busy}>
          Save collect-from-hub settings
        </Button>
      </div>
    </form>
  );
}

function Editor({ seg, catalog, pkg, draft, setDraft, products, close, saved }: { seg: Segment; catalog: ServiceCatalog; pkg: Package | null; draft: Draft; setDraft: (d: Draft) => void; products: Product[]; close: () => void; saved: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const isNew = !pkg;
  const services = catalog.services.filter(s => s.segments.includes(seg));
  const fields = catalog.priceFields.filter(f => f.segments.includes(seg));
  const deliveryTypes = useDeliveryTypes();
  const offered = (deliveryTypes.data ?? []).filter(t => t.active && t.segments.includes(seg));
  const fees = draft.prices.deliveryFees ?? {};
  const unitOf = (u?: string) => (u === "৳" || u === "%" || u === "kg" ? u : "");
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  async function save(e: FormEvent) {
    e.preventDefault();
    if (draft.name.trim().length < 2) return toast("Enter the package name (at least 2 characters).", "bad");
    const body = { services: [...draft.services], prices: draft.prices, ...(draft.effectiveFrom ? { effectiveFrom: new Date(draft.effectiveFrom).toISOString() } : {}), ...(draft.note.trim() ? { note: draft.note.trim() } : {}) };
    setBusy(true);
    try {
      const name = draft.name.trim();
      const result = isNew
        ? await api<{ status?: string }>("/packages", { method: "POST", body: { ...body, segment: seg, name, description: draft.description.trim() || undefined, makeDefault: draft.makeDefault } })
        : await api<{ status?: string }>(`/packages/${pkg!.id}/versions`, { method: "POST", body: { ...body, ...(name !== pkg!.name ? { name } : {}), description: draft.description.trim() } });
      outcome(result, isNew ? `${name} created.` : `New version of ${name} saved${draft.effectiveFrom ? ` from ${fmtDate(draft.effectiveFrom)}` : ""}.`);
      await saved();
      close();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  const jump = (id: string) => {
    const to = document.getElementById(id);
    if (to) window.scrollTo({ top: to.getBoundingClientRect().top + window.scrollY - 116, behavior: "smooth" });
  };
  return (
    <>
      {heading(null)}
      <div style={{ margin: "2px 0 10px" }}>
        <button type="button" className="link-button" onClick={close}>
          ‹ Back to packages
        </button>
        <h2 style={{ margin: "6px 0 2px", fontSize: 19 }}>{isNew ? `New ${segLabel(seg)} package` : `Edit ${pkg!.name}`}</h2>
        <p className="faint" style={{ margin: 0 }}>
          Saving creates a new version from its effective date.
        </p>
      </div>
      <nav className="row" aria-label="Sections of this package" style={{ gap: 4, padding: "8px 0", marginBottom: 6 }}>
        {[
          ["pkgSecDetails", "Details"],
          ["pkgSecServices", "Services"],
          ["pkgSecPrices", "Prices"],
        ].map(([id, label]) => (
          <button key={id} type="button" className="button ghost sm" onClick={() => jump(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(280px,340px)", gap: 14, alignItems: "start" }}>
        <form className="panel" onSubmit={e => void save(e)} noValidate style={{ padding: 16 }}>
          <h3 id="pkgSecDetails" style={{ margin: "0 0 8px", fontSize: 14 }}>
            Details
          </h3>
          <div className="form-grid">
            <label className="field">
              <span>Package name *</span>
              <input className="input" maxLength={80} required value={draft.name} onChange={e => set({ name: e.target.value })} />
            </label>
            <label className="field">
              <span>Effective from</span>
              <input className="input" type="datetime-local" min={localInput(new Date())} value={draft.effectiveFrom} onChange={e => set({ effectiveFrom: e.target.value })} />
              <small>Empty: as soon as it is approved.</small>
            </label>
            <label className="field full">
              <span>Description</span>
              <input className="input" maxLength={300} value={draft.description} onChange={e => set({ description: e.target.value })} />
            </label>
            <label className="field full">
              <span>Change note</span>
              <input className="input" maxLength={300} placeholder="Why the change (shown to the approver)" value={draft.note} onChange={e => set({ note: e.target.value })} />
            </label>
            {isNew ? (
              <label className="check full">
                <input type="checkbox" checked={draft.makeDefault} onChange={e => set({ makeDefault: e.target.checked })} /> Make it the default {segLabel(seg)} package
              </label>
            ) : null}
          </div>
          <h3 id="pkgSecServices" style={{ margin: "18px 0 8px", fontSize: 14 }}>
            Services
          </h3>
          <div style={{ display: "grid", gap: 9 }}>
            {catalog.groups.map(g => {
              const items = services.filter(s => s.group === g.code);
              if (!items.length) return null;
              return (
                <details key={g.code} open style={{ border: "1px solid var(--line)", borderRadius: 9 }}>
                  <summary className="row" style={{ justifyContent: "space-between", padding: "10px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                    {g.label}
                    <small className="faint" style={{ fontWeight: 500 }}>{`${items.filter(s => draft.services.has(s.code) || s.core).length} of ${items.length} on`}</small>
                  </summary>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "4px 12px", padding: "2px 12px 12px" }}>
                    {items.map(s => (
                      <label key={s.code} className="check" title={s.hint || ""}>
                        <input
                          type="checkbox"
                          checked={draft.services.has(s.code) || !!s.core}
                          disabled={!!s.core}
                          onChange={e => {
                            const next = new Set(draft.services);
                            if (e.target.checked) next.add(s.code);
                            else next.delete(s.code);
                            set({ services: next });
                          }}
                        />{" "}
                        {s.label}
                        {s.core ? " (always on)" : ""}
                      </label>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
          <h3 id="pkgSecPrices" style={{ margin: "18px 0 8px", fontSize: 14 }}>
            Prices
          </h3>
          <p className="faint" style={{ margin: "0 0 8px" }}>
            Prices depend on the districts only. Every line rounded to whole taka. “−” adjustments are subtracted; the delivery charge never goes below ৳0.
          </p>
          <div style={{ display: "grid", gap: 9 }}>
            <details open style={{ border: "1px solid var(--line)", borderRadius: 9 }}>
              <summary style={{ padding: "10px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Delivery type (+ charge)</summary>
              <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", padding: "2px 12px 12px" }}>
                {offered.map(t => (
                  <label key={t.code} className="field">
                    <span>{`+ ${t.name} (৳)`}</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      step={0.01}
                      required
                      value={String(fees[t.code] ?? 0)}
                      onChange={e => set({ prices: { ...draft.prices, deliveryFees: { ...fees, [t.code]: e.target.value === "" ? 0 : Number(e.target.value) } } })}
                    />
                  </label>
                ))}
                {deliveryTypes.isLoading ? <p className="faint">Loading the delivery types…</p> : !offered.length ? <p className="faint">No delivery type is offered to this category: add one in Operational settings › Delivery types.</p> : null}
              </div>
            </details>
            {[...new Set(fields.map(f => f.group))].map(group => (
              <details key={group} open style={{ border: "1px solid var(--line)", borderRadius: 9 }}>
                <summary style={{ padding: "10px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{group}</summary>
                <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", padding: "2px 12px 12px" }}>
                  {fields
                    .filter(f => f.group === group)
                    .map(f => (
                      <label key={f.key} className="field">
                        <span>{`${f.sign === "-" ? "− " : f.sign === "+" ? "+ " : ""}${f.label}${unitOf(f.unit) ? ` (${unitOf(f.unit)})` : ""}`}</span>
                        <input className="input" type="number" min={f.signed ? undefined : 0} step={f.unit === "count" ? 1 : 0.01} required value={String(draft.prices[f.key] ?? 0)} onChange={e => set({ prices: { ...draft.prices, [f.key]: e.target.value === "" ? 0 : Number(e.target.value) } })} />
                      </label>
                    ))}
                </div>
              </details>
            ))}
          </div>
          <div className="row" style={{ gap: 8, justifyContent: "flex-end", position: "sticky", bottom: 0, background: "var(--surface, #fff)", padding: "11px 0 0", marginTop: 14, borderTop: "1px solid var(--line)" }}>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {isNew ? "Create package" : "Save new version"}
            </Button>
          </div>
        </form>
        <div style={{ position: "sticky", top: 76 }}>
          <Panel title="Price preview" subtitle="What this draft would charge, before you save it.">
            <Simulator seg={seg} catalog={catalog} products={products} services={draft.services} draft={draft} />
          </Panel>
        </div>
      </div>
    </>
  );
}
