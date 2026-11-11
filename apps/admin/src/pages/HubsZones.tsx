/**
 * Hubs & zones (Location settings; bridge-hubs-admin.js), in tabs:
 *   Hubs            the hub register: add, edit (place, address, in-charge, capacity, map point), deactivate /
 *                   activate, delete when unused (else deactivate instead); the central hub first and highlighted,
 *                   "Make central hub" (GET / PUT /accounts/config)
 *   Delivery zones  which hub serves each zone and its route; zones on / off (GET /zones, PATCH /zones/:id). New
 *                   zones are added in Address. ?zone=<name> opens this tab searched for it.
 *   Routes          a hub's delivery routes with a default rider (GET / POST / PATCH /routes)
 */
import { useState } from "react";
import { useSearchParams } from "react-router";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { alertDialog, confirm, openForm } from "@panel/ui/dialogs";
import { Button, Loading, PageHeading, Panel, Pill, useDebounced } from "@panel/ui/kit";
import { Pager, usePaged } from "@panel/ui/Pager";
import { Select } from "@panel/ui/Select";
import { toast, toastError } from "@panel/ui/toast";
import { useCatalog, type Catalog } from "@/lib/admin";

interface Hub {
  id: string;
  code: string;
  name: string;
  type?: string;
  active: boolean;
  district?: string;
  zone?: string | null;
  address?: string;
  inChargeName?: string | null;
  inChargePhone?: string | null;
  capacity?: number | null;
  lat?: number | null;
  lng?: number | null;
}
interface Route {
  id: string;
  code: string;
  name: string;
  active: boolean;
  zones: number;
  note?: string | null;
  hub?: { id: string; name: string } | null;
  hubId?: string;
  defaultRider?: { id: string; label: string } | null;
}
interface Zone {
  id: string;
  code: string;
  name: string;
  district: string;
  active: boolean;
  areas?: string[];
  hub?: { id: string; name: string } | null;
  route?: { id: string; name: string } | null;
}
interface Rider {
  id: string;
  code: string;
  name: string;
  label?: string;
  hub?: { id: string } | null;
}
const num = (n: unknown) => Number(n || 0).toLocaleString("en-US");
type Tab = "hubs" | "zones" | "routes";

function useNetwork() {
  return useQuery({
    queryKey: ["admin", "network"],
    queryFn: async () => {
      const [hubs, routes, riders, accounts] = await Promise.all([
        api<Hub[]>("/hubs?includeInactive=true"),
        api<{ items: Route[] } | Route[]>("/routes?limit=200").catch(() => ({ items: [] as Route[] })),
        api<Rider[]>("/riders?active=true").catch(() => []),
        api<{ centralHub?: { id: string } | null }>("/accounts/config").catch(() => null),
      ]);
      return { hubs, routes: Array.isArray(routes) ? routes : routes.items || [], riders, central: accounts?.centralHub?.id ?? null };
    },
  });
}

export default function HubsZones() {
  const [params, setParams] = useSearchParams();
  const linkedZone = params.get("zone");
  const tab: Tab = linkedZone ? "zones" : (["hubs", "zones", "routes"].includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "hubs");
  const net = useNetwork();
  const catalog = useCatalog();
  const setTab = (t: Tab) => setParams(t === "hubs" ? {} : { tab: t }, { replace: true });
  return (
    <>
      <PageHeading eyebrow="Platform control · network setup" title="Hubs & zones" subtitle="The hub register, which hub serves each delivery zone, and delivery routes." />
      <div className="seg-tabs" role="tablist" style={{ marginBottom: 14 }}>
        {(
          [
            ["hubs", "Hubs"],
            ["zones", "Delivery zones"],
            ["routes", "Routes"],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {!net.data ? (
        net.error ? <div className="callout bad">{describe(net.error)}</div> : <Loading rows={6} />
      ) : tab === "hubs" ? (
        <Hubs data={net.data} catalog={catalog.data} />
      ) : tab === "zones" ? (
        <Zones data={net.data} catalog={catalog.data} initialQuery={linkedZone ?? ""} />
      ) : (
        <Routes data={net.data} />
      )}
    </>
  );
}

type Network = NonNullable<ReturnType<typeof useNetwork>["data"]>;

function Hubs({ data, catalog }: { data: Network; catalog?: Catalog }) {
  const qc = useQueryClient();
  const reload = () => Promise.all([qc.invalidateQueries({ queryKey: ["admin", "network"] }), qc.invalidateQueries({ queryKey: ["admin", "hubs"] })]);
  const central = data.hubs.find(h => h.id === data.central);
  const sorted = [...data.hubs].sort((a, b) => Number(b.id === data.central) - Number(a.id === data.central));
  const { rows, pager } = usePaged(sorted, 25);

  /** Hubs without a location get one (POST /hubs/locate: address → zone → zone centre); the result to check on the map. */
  async function locate(missing: number) {
    if (!missing) return toast("Every hub has a location. Edit a hub to change its latitude and longitude.");
    if (!(await confirm({ title: `Find the location of ${missing} hub${missing === 1 ? "" : "s"}?`, message: "From each hub's address (else its zone). It takes about a second per hub. Check the result and correct any hub by editing it.", ok: "Find locations" }))) return;
    try {
      const r = await api<{ checked: number; located: number; hubs: { name: string; code: string; lat: number | null; lng: number | null; source: string | null; match: string | null }[] }>("/hubs/locate", { method: "POST", body: {} });
      await reload();
      await alertDialog({
        title: `${r.located} of ${r.checked} hubs located`,
        message: (
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Hub</th>
                  <th>Found from</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {r.hubs.map(h => (
                  <tr key={h.code}>
                    <td>
                      {h.name}
                      <span className="sub">{h.code}</span>
                    </td>
                    <td>{h.source ? <Pill tone={h.source === "address" ? "good" : "warn"}>{h.source}</Pill> : <Pill tone="bad">not found</Pill>}<span className="sub">{h.match ?? ""}</span></td>
                    <td className="mono">{h.lat != null && h.lng != null ? <a href={`https://www.openstreetmap.org/?mlat=${h.lat}&mlon=${h.lng}#map=16/${h.lat}/${h.lng}`} target="_blank" rel="noreferrer">{`${h.lat.toFixed(5)}, ${h.lng.toFixed(5)}`}</a> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      });
    } catch (e) {
      toastError(e);
    }
  }

  async function edit(h: Hub | null) {
    const zonesOf = (d: string) => (catalog?.zonesByDistrict?.[d] ?? []).map(z => ({ value: z, label: z }));
    await openForm({
      title: h ? `Edit ${h.name}` : "Add hub",
      description: h ? `${h.code}${h.type === "FRANCHISE" ? " · franchise hub (its franchise is managed in Franchises)" : ""}` : "A company hub of the network. Franchise hubs are created in Franchises.",
      submit: "Save",
      wide: true,
      fields: [
        ...(h ? [] : [{ id: "code", label: "Code", required: true, maxLength: 20, placeholder: "DHK-MOT" }]),
        { id: "name", label: "Name", required: true, maxLength: 120, value: h?.name ?? "" },
        { id: "district", label: "District", type: "select", required: true, value: h?.district ?? "", options: [{ value: "", label: "Choose" }, ...(catalog?.districts ?? []).map(d => ({ value: d, label: d }))] },
        { id: "zone", label: "Zone (thana / upazila)", type: "select", required: true, value: h?.zone ?? "", options: v => [{ value: "", label: "Choose" }, ...zonesOf(v.district)] },
        { id: "address", label: "Address", required: true, maxLength: 300, full: true, value: h?.address ?? "" },
        { id: "inChargeName", label: "In-charge name", maxLength: 120, value: h?.inChargeName ?? "" },
        { id: "inChargePhone", label: "In-charge phone", maxLength: 20, value: h?.inChargePhone ?? "" },
        { id: "capacity", label: "Capacity (parcels at once)", type: "number", min: 1, step: 1, value: h?.capacity ?? "" },
        { id: "lat", label: "Latitude", type: "number", step: "any", min: 20, max: 27, value: h?.lat ?? "" },
        { id: "lng", label: "Longitude", type: "number", step: "any", min: 88, max: 93, value: h?.lng ?? "" },
      ],
      onSubmit: async v => {
        const opt = (k: string) => (v[k] === "" ? null : Number(v[k]));
        const body = { name: v.name.trim(), district: v.district, zone: v.zone || null, address: v.address.trim(), inChargeName: v.inChargeName.trim() || null, inChargePhone: v.inChargePhone.trim() || null, capacity: opt("capacity"), lat: opt("lat"), lng: opt("lng") };
        if (h) await api(`/hubs/${h.id}`, { method: "PATCH", body });
        else await api("/hubs", { method: "POST", body: { ...body, code: v.code.trim() } });
        await reload();
        return h ? `${body.name} saved.` : `${body.name} added.`;
      },
    });
  }
  async function makeCentral(h: Hub) {
    const ok = await confirm({
      title: `Make ${h.name} the central hub?`,
      message: central
        ? `Hubs will send riders' cash to ${h.name} instead of ${central.name}. Transfers already on the way still go to ${central.name}; cash already at ${central.name} stays ready to settle.`
        : `Hubs will send riders' cash to ${h.name}; only cash that reached it is settled with merchants and customers.`,
      ok: "Make central hub",
    });
    if (!ok) return;
    try {
      await api("/accounts/config", { method: "PUT", body: { centralHubId: h.id } });
      toast(`${h.name} is the central hub.`, "good");
      await reload();
    } catch (e) {
      toastError(e);
    }
  }
  async function toggle(h: Hub) {
    const off = h.active;
    const ok = await confirm({
      title: off ? `Deactivate ${h.name}?` : `Activate ${h.name}?`,
      message: off ? "It takes no new parcels and leaves booking forms. Zones it serves keep it until you change their serving hub; merchants of those zones move to “No hub”." : "It takes parcels again; merchants of the zones it serves come back to it.",
      ok: off ? "Deactivate" : "Activate",
      danger: off,
    });
    if (!ok) return;
    try {
      await api(`/hubs/${h.id}`, { method: "PATCH", body: { active: !off } });
      toast(off ? `${h.name} is deactivated.` : `${h.name} is active again.`, "good");
      await reload();
    } catch (e) {
      toastError(e);
    }
  }
  async function remove(h: Hub) {
    try {
      const usage = await api<{ total: number; items: { label: string; count: number }[] }>(`/hubs/${h.id}/usage`);
      if (usage.total) {
        const list = usage.items.filter(i => i.count).map(i => `${i.label}: ${num(i.count)}`).join(" · ");
        if (!h.active) return void alertDialog({ title: `${h.name} is in use`, message: `${list}. It is deactivated already; existing records keep it.` });
        if (!(await confirm({ title: `${h.name} is in use`, message: `${list}. Deactivate it instead: it leaves new bookings and lists, existing records keep it.`, ok: "Deactivate", danger: true }))) return;
        await api(`/hubs/${h.id}`, { method: "PATCH", body: { active: false } });
        toast(`${h.name} is deactivated.`, "good");
      } else {
        if (!(await confirm({ title: `Delete ${h.name}?`, message: "Nothing uses this hub. It is removed for good.", ok: "Delete", danger: true }))) return;
        await api(`/hubs/${h.id}`, { method: "DELETE" });
        toast(`${h.name} deleted.`, "good");
      }
      await reload();
    } catch (e) {
      toastError(e);
    }
  }
  return (
    <Panel
      title="Hubs"
      subtitle={
        <>
          {`${data.hubs.filter(h => h.active).length} active of ${data.hubs.length}. A hub's place sets where drop-offs are priced from; its capacity is used for planning.`}
          <span style={{ display: "block", marginTop: 4, ...(central ? {} : { color: "var(--bad)", fontWeight: 600 }) }}>
            {central ? (
              <>
                Central hub: <strong>{central.name}</strong>. Hubs send riders' cash here (Accounts › Hub transfers); only cash that reached it is settled with merchants and customers.
              </>
            ) : (
              "No central hub yet: choose one with “Make central hub” so hubs can send riders' cash and settlements can be paid."
            )}
          </span>
        </>
      }
      tools={
        <div className="row" style={{ gap: 8 }}>
          <Button
            title="Hubs without a map location get one from their address (else their zone). Riders and staff on several hubs work at the nearest one."
            onClick={() => void locate(data.hubs.filter(h => h.lat == null || h.lng == null).length)}
          >
            {`Find hub locations (${data.hubs.filter(h => h.lat == null || h.lng == null).length} missing)`}
          </Button>
          <Button variant="primary" onClick={() => void edit(null)}>
            Add hub
          </Button>
        </div>
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Hub</th>
              <th>Place</th>
              <th>In-charge</th>
              <th className="num">Capacity</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(h => (
              <tr key={h.id} style={h.id === data.central ? { background: "#eff4ff", boxShadow: "inset 3px 0 0 var(--primary)" } : undefined}>
                <td>
                  <span className="strong">{h.name}</span> {h.type === "FRANCHISE" ? <Pill>Franchise</Pill> : null}{" "}
                  {h.id === data.central ? (
                    <span className="pill" style={{ background: "var(--primary)", color: "#fff" }}>
                      ★ Central hub
                    </span>
                  ) : null}
                  <span className="sub">{h.code}</span>
                </td>
                <td>
                  {[h.zone, h.district].filter(Boolean).join(", ")}
                  <span className="sub">{h.address}</span>
                </td>
                <td>
                  {h.inChargeName || h.inChargePhone ? (
                    <>
                      {h.inChargeName || "—"}
                      <span className="sub">{h.inChargePhone || ""}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="num">{h.capacity ? num(h.capacity) : "—"}</td>
                <td>
                  <Pill tone={h.active ? "good" : "bad"}>{h.active ? "Active" : "Inactive"}</Pill>
                </td>
                <td className="nowrap">
                  {h.id !== data.central && h.active && h.type !== "FRANCHISE" ? (
                    <>
                      <Button size="sm" onClick={() => void makeCentral(h)}>
                        Make central hub
                      </Button>{" "}
                    </>
                  ) : null}
                  <Button size="sm" onClick={() => void edit(h)}>
                    Edit
                  </Button>{" "}
                  <Button size="sm" onClick={() => void toggle(h)}>
                    {h.active ? "Deactivate" : "Activate"}
                  </Button>{" "}
                  <Button size="sm" onClick={() => void remove(h)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={6} className="faint" style={{ textAlign: "center" }}>
                  No hubs yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pager {...pager} noun="hub" />
    </Panel>
  );
}

function Zones({ data, catalog, initialQuery }: { data: Network; catalog?: Catalog; initialQuery: string }) {
  const qc = useQueryClient();
  const [q, setQ] = useState(initialQuery);
  const [district, setDistrict] = useState("");
  const [hubId, setHubId] = useState("");
  const [busy, setBusy] = useState("");
  const query = useDebounced(q.trim(), 350);
  const zones = useInfiniteQuery({
    queryKey: ["admin", "zones", query, district, hubId],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "200" });
      if (query) p.set("q", query);
      if (district) p.set("district", district);
      if (hubId) p.set("hubId", hubId);
      if (pageParam) p.set("cursor", pageParam);
      return api<{ items: Zone[]; nextCursor?: string | null }>(`/zones?${p}`);
    },
    getNextPageParam: last => last.nextCursor || undefined,
    placeholderData: keepPreviousData,
  });
  const items = zones.data?.pages.flatMap(p => p.items) ?? [];
  const hubOptions = (selected: string) => data.hubs.filter(h => h.active || h.id === selected);
  async function patch(z: Zone, body: Record<string, unknown>, message: (u: Zone) => string) {
    setBusy(z.id);
    try {
      const updated = await api<Zone>(`/zones/${z.id}`, { method: "PATCH", body });
      toast(message(updated), "good");
      await qc.invalidateQueries({ queryKey: ["admin", "zones"] });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  return (
    <Panel
      title="Delivery zones"
      subtitle="The serving hub of a zone receives its deliveries and Hub Pickup parcels; merchants picking up there belong to it. New zones are added in Shared catalogs & locations."
      tools={
        <>
          <input className="input sm" type="search" placeholder="Search zones…" aria-label="Search zones" value={q} onChange={e => setQ(e.target.value)} style={{ width: 200 }} />
          <Select className="select sm" aria-label="District" value={district} onChange={e => setDistrict(e.target.value)}>
            <option value="">All districts</option>
            {(catalog?.districts ?? []).map(d => (
              <option key={d}>{d}</option>
            ))}
          </Select>
          <Select className="select sm" aria-label="Hub" value={hubId} onChange={e => setHubId(e.target.value)}>
            <option value="">All hubs</option>
            {hubOptions(hubId).map(h => (
              <option key={h.id} value={h.id}>{`${h.name}${h.type === "FRANCHISE" ? " · Franchise" : ""}`}</option>
            ))}
          </Select>
        </>
      }
      footer={
        zones.hasNextPage ? (
          <Button size="sm" disabled={zones.isFetchingNextPage} onClick={() => void zones.fetchNextPage()}>
            Load more
          </Button>
        ) : null
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Zone</th>
              <th>District</th>
              <th>Serving hub</th>
              <th>Route</th>
              <th>Areas</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map(z => (
              <tr key={z.id}>
                <td>
                  <span className="strong">{z.name}</span>
                  <span className="sub">{z.code}</span>
                </td>
                <td>{z.district}</td>
                <td>
                  <Select
                    className="select sm"
                    aria-label={`Serving hub of ${z.name}`}
                    disabled={busy === z.id}
                    value={z.hub?.id || ""}
                    onChange={e => {
                      const value = e.target.value;
                      const routeHub = z.route ? data.routes.find(r => r.id === z.route!.id)?.hub?.id : undefined;
                      void patch(z, { hubId: value || null, ...(z.route && routeHub !== value ? { routeId: null } : {}) }, u => `${z.name}: ${u.hub ? `served by ${u.hub.name}` : "no serving hub"}. Its merchants follow.`);
                    }}
                  >
                    <option value="">No hub</option>
                    {hubOptions(z.hub?.id || "").map(h => (
                      <option key={h.id} value={h.id}>{`${h.name}${h.type === "FRANCHISE" ? " · Franchise" : ""}`}</option>
                    ))}
                  </Select>
                </td>
                <td>
                  <Select className="select sm" aria-label={`Route of ${z.name}`} disabled={busy === z.id} value={z.route?.id || ""} onChange={e => void patch(z, { routeId: e.target.value || null }, u => `${z.name}: ${u.route ? `on route ${u.route.name}` : "no route"}.`)}>
                    <option value="">No route</option>
                    {data.routes
                      .filter(r => (r.hub?.id || r.hubId) === z.hub?.id && (r.active || r.id === z.route?.id))
                      .map(r => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                  </Select>
                </td>
                <td>{z.areas?.length ? num(z.areas.length) : "All"}</td>
                <td className="nowrap">
                  <Pill tone={z.active ? "good" : "bad"}>{z.active ? "Active" : "Off"}</Pill>{" "}
                  <Button size="sm" disabled={busy === z.id} onClick={() => void patch(z, { active: !z.active }, u => `${z.name} is ${u.active ? "on" : "off"}.`)}>
                    {z.active ? "Turn off" : "Turn on"}
                  </Button>
                </td>
              </tr>
            ))}
            {!items.length ? (
              <tr>
                <td colSpan={6} className="faint" style={{ textAlign: "center" }}>
                  {zones.isLoading ? "Loading…" : "No zones match."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Routes({ data }: { data: Network }) {
  const qc = useQueryClient();
  async function edit(r: Route | null) {
    const riderOptions = (hub: string) => [{ value: "", label: "No default rider" }, ...data.riders.filter(x => !hub || x.hub?.id === hub).map(x => ({ value: x.id, label: x.label || `${x.code} · ${x.name}` }))];
    await openForm({
      title: r ? `Edit ${r.name}` : "Add route",
      description: "Choose a zone's route in Delivery zones (routes of its serving hub); the default rider is suggested for them.",
      submit: "Save",
      fields: [
        { id: "code", label: "Code", required: true, maxLength: 20, value: r?.code ?? "", placeholder: r ? undefined : "GUL-R1" },
        { id: "name", label: "Name", required: true, maxLength: 120, value: r?.name ?? "" },
        { id: "hubId", label: "Hub", type: "select", required: true, value: r?.hub?.id ?? "", options: [{ value: "", label: "Choose" }, ...data.hubs.filter(h => h.active || h.id === r?.hub?.id).map(h => ({ value: h.id, label: `${h.name}${h.type === "FRANCHISE" ? " · Franchise" : ""}` }))] },
        { id: "defaultRiderId", label: "Default rider", type: "select", value: r?.defaultRider?.id ?? "", options: v => riderOptions(v.hubId) },
        { id: "note", label: "Note", maxLength: 500, full: true, value: r?.note ?? "" },
        { id: "active", label: "Active", type: "checkbox", value: r ? r.active : true },
      ],
      onSubmit: async v => {
        const body = { code: v.code.trim(), name: v.name.trim(), hubId: v.hubId, defaultRiderId: v.defaultRiderId || null, note: v.note.trim() || (r ? null : undefined), active: v.active === "true" };
        if (r) await api(`/routes/${r.id}`, { method: "PATCH", body });
        else await api("/routes", { method: "POST", body });
        await qc.invalidateQueries({ queryKey: ["admin", "network"] });
        return `Route ${body.name} saved.`;
      },
    });
  }
  return (
    <Panel
      title="Routes"
      subtitle="Zones a hub serves together, with the rider who usually takes them."
      tools={
        <Button variant="primary" onClick={() => void edit(null)}>
          Add route
        </Button>
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Route</th>
              <th>Hub</th>
              <th>Default rider</th>
              <th className="num">Zones</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.routes.map(r => (
              <tr key={r.id}>
                <td>
                  <span className="strong">{r.name}</span>
                  <span className="sub">{r.code}</span>
                </td>
                <td>{r.hub?.name || "—"}</td>
                <td>{r.defaultRider?.label || "—"}</td>
                <td className="num">{num(r.zones)}</td>
                <td>
                  <Pill tone={r.active ? "good" : "bad"}>{r.active ? "Active" : "Off"}</Pill>
                </td>
                <td>
                  <Button size="sm" onClick={() => void edit(r)}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
            {!data.routes.length ? (
              <tr>
                <td colSpan={6} className="faint" style={{ textAlign: "center" }}>
                  No routes yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
