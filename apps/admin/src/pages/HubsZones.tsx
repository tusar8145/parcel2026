/**
 * Hubs & zones (Hub settings; bridge-hubs-admin.js), in tabs:
 *   Hubs            the hub register: add, edit (place, address, in-charge, capacity, map point), deactivate /
 *                   activate, delete when unused (else deactivate instead); the central hub first and highlighted,
 *                   "Make central hub" (GET / PUT /accounts/config)
 *   Delivery zones  which hub serves each zone and its route; zones on / off (GET /zones, PATCH /zones/:id). New
 *                   zones are added in Address. ?zone=<name> opens this tab searched for it.
 *   Routes          a hub's delivery routes with a default rider (GET / POST / PATCH /routes)
 */
import { Fragment, useState } from "react";
import { useSearchParams } from "react-router";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { alertDialog, confirm, openForm , type FormField } from "@panel/ui/dialogs";
import { Button, Loading, MoreMenu, PageHeading, Panel, Pill, useDebounced } from "@panel/ui/kit";
import { Pager, usePaged } from "@panel/ui/Pager";
import { Select } from "@panel/ui/Select";
import { toast, toastError } from "@panel/ui/toast";
import { groupHubs, HUB_GROUPS, hubGroup, phoneText, useCatalog, useStaff, type Catalog, type Staff } from "@/lib/admin";
import { useAuth } from "@panel/lib/auth";
import { franchiseUserItems, inviteForm, staffItems } from "@/pages/AdminUsers";
import { FranchiseApplications, openEdit as openRates, openRiders, openSettlement, type Franchise } from "@/pages/Franchises";

interface Hub {
  id: string;
  code: string;
  name: string;
  type?: string;
  /** Marked a franchise hub: a Franchise user can be made for it (it works as one once that user exists). */
  franchiseHub?: boolean;
  active: boolean;
  district?: string;
  zone?: string | null;
  address?: string;
  inChargeName?: string | null;
  inChargePhone?: string | null;
  capacity?: number | null;
  lat?: number | null;
  lng?: number | null;
  /** Sign-in people of the hub (Hub Managers); only for those who manage hubs. */
  managers?: Person[];
  franchise?: { id: string; code: string; name: string; status: string; account?: Person | null; users?: Person[] } | null;
}
interface Person {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  status?: string;
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
  const reload = () => Promise.all([qc.invalidateQueries({ queryKey: ["admin", "network"] }), qc.invalidateQueries({ queryKey: ["admin", "hubs"] }), qc.invalidateQueries({ queryKey: ["admin", "franchises"] })]);
  const central = data.hubs.find(h => h.id === data.central);
  // Franchise hubs: their franchise's options (riders, rates, the Franchise user, suspend) in their row.
  const franchises = useQuery({ queryKey: ["admin", "franchises", "list"], queryFn: () => api<Franchise[]>("/franchises") });
  const franchiseOf = (h: Hub) => franchises.data?.find(f => f.hub.id === h.id);
  // Search by hub name or code (on this page's list).
  const [find, setFind] = useState("");
  const needle = find.trim().toLowerCase();
  const listed = needle ? data.hubs.filter(h => h.name.toLowerCase().includes(needle) || h.code.toLowerCase().includes(needle)) : data.hubs;
  const staff = useStaff();
  // Inside Dhaka, Dhaka sub-urban, Outside Dhaka, Franchise hubs; the central hub first in its group.
  const sorted = groupHubs(listed).flatMap(g => [...g.hubs].sort((a, b) => Number(b.id === data.central) - Number(a.id === data.central)));
  const { rows, pager } = usePaged(sorted, 25);
  const groupCount = (h: Hub) => sorted.filter(x => hubGroup(x) === hubGroup(h)).length;

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
      description: h ? `${h.code}${h.type === "FRANCHISE" ? " · franchise hub (its franchise options are in its row)" : ""}` : "A hub of the network. Tick Franchise hub to make a Franchise user for it later (Admin users & roles).",
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
        // A franchise hub: marked here; its Franchise user is made in Admin users & roles. Fixed once that user exists.
        ...(h?.franchise
          ? [{ id: "franchiseNote", label: "", type: "static", full: true, render: <div className="callout">{`Franchise hub of ${h.franchise.name}. It stays a franchise hub while it has a Franchise user (its Franchise users are in Admin users & roles).`}</div> } as FormField]
          : h && h.id === data.central
            ? []
            : [
                {
                  id: "franchiseHub",
                  label: "Franchise hub",
                  type: "checkbox",
                  full: true,
                  value: !!(h?.franchiseHub || h?.type === "FRANCHISE"),
                  hint: "A Franchise user can be made for it in Admin users & roles (one user per hub). Until then it works as a company hub.",
                } as FormField,
              ]),
      ],
      onSubmit: async v => {
        const opt = (k: string) => (v[k] === "" ? null : Number(v[k]));
        const body = {
          name: v.name.trim(),
          district: v.district,
          zone: v.zone || null,
          address: v.address.trim(),
          inChargeName: v.inChargeName.trim() || null,
          inChargePhone: v.inChargePhone.trim() || null,
          capacity: opt("capacity"),
          lat: opt("lat"),
          lng: opt("lng"),
          ...(v.franchiseHub !== undefined ? { franchiseHub: v.franchiseHub === "true" } : {}),
        };
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
      title: off ? `Make ${h.name} inactive?` : `Make ${h.name} active?`,
      message: off ? "It takes no new parcels and leaves booking forms. Zones it serves keep it until you change their serving hub; merchants of those zones move to “No hub”." : "It takes parcels again; merchants of the zones it serves come back to it.",
      ok: off ? "Make inactive" : "Make active",
      danger: off,
    });
    if (!ok) return;
    try {
      await api(`/hubs/${h.id}`, { method: "PATCH", body: { active: !off } });
      toast(off ? `${h.name} is inactive.` : `${h.name} is active again.`, "good");
      await reload();
    } catch (e) {
      toastError(e);
    }
  }
  /** A franchise hub on or off: the hub (bookings, lists) and its franchise (panel, riders' sign-in) together. */
  async function toggleFranchiseHub(h: Hub, f: Franchise) {
    const off = h.active && f.status === "ACTIVE";
    const ok = await confirm({
      title: off ? `Make ${h.name} inactive?` : `Make ${h.name} active?`,
      message: off
        ? "The hub takes no new parcels and leaves booking forms; its franchise is suspended: the Franchise users and its riders are signed out and can't sign in."
        : "The hub takes parcels again and its franchise is active: the Franchise users and its riders can sign in again.",
      ok: off ? "Make inactive" : "Make active",
      danger: off,
    });
    if (!ok) return;
    try {
      if (h.active === off) await api(`/hubs/${h.id}`, { method: "PATCH", body: { active: !off } });
      if ((f.status === "ACTIVE") === off) await api(`/franchises/${f.id}/status`, { method: "POST", body: { status: off ? "SUSPENDED" : "ACTIVE" } });
      toast(off ? `${h.name} is inactive.` : `${h.name} is active again.`, "good");
      await reload();
    } catch (e) {
      toastError(e);
      await reload();
    }
  }
  return (
    <>
    <FranchiseApplications reload={reload} />
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
          <input className="input" type="search" placeholder="Search hub name or code" aria-label="Search hubs" value={find} onChange={e => setFind(e.target.value)} style={{ width: 230 }} />
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
              <th>Hub manager / Franchise</th>
              <th className="num">Capacity</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((h, i) => (
              <Fragment key={h.id}>
                {i === 0 || hubGroup(rows[i - 1]) !== hubGroup(h) ? (
                  <tr className="group-row">
                    <td colSpan={7}>
                      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                        <span>{`${HUB_GROUPS.find(([g]) => g === hubGroup(h))?.[1] ?? ""} · ${num(groupCount(h))} hub${groupCount(h) === 1 ? "" : "s"}`}</span>
                        {hubGroup(h) === "FRANCHISE" ? (
                          <Button size="sm" icon="settings" title="How franchises get their commission" onClick={() => void openSettlement()}>
                            Settlement settings
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ) : null}
              <tr style={h.id === data.central ? { background: "var(--primary-soft)", boxShadow: "inset 3px 0 0 var(--primary)" } : undefined}>
                <td>
                  <span className="strong">{h.name}</span> {h.type === "FRANCHISE" ? <Pill>Franchise</Pill> : h.franchiseHub ? <Pill tone="warn">Franchise · no user yet</Pill> : null}{" "}
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
                <td>
                  <HubPeople
                    hub={h}
                    franchise={franchiseOf(h)}
                    staffOf={id => staff.data?.find(x => x.id === id)}
                    reload={reload}
                  />
                </td>
                <td className="num">{h.capacity ? num(h.capacity) : "—"}</td>
                <td>
                  <Pill tone={h.active ? "good" : "bad"}>{h.active ? "Active" : "Inactive"}</Pill>
                </td>
                <td>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end", minWidth: 220 }}>
                  {(() => {
                    // Every hub: Edit, and the rest under More (a franchise hub's franchise options too).
                    const f = franchiseOf(h);
                    return (
                      <>
                      <Button size="sm" onClick={() => void edit(h)}>
                        Edit
                      </Button>
                      <MoreMenu
                        items={[
                          // A new person for this hub: the Admin users & roles invite form, role and hub chosen already.
                          h.active
                            ? {
                                label: h.franchise || h.franchiseHub || h.type === "FRANCHISE" ? "Add franchise user" : "Add hub manager",
                                icon: "plus",
                                onSelect: () => inviteForm({ role: h.franchise || h.franchiseHub || h.type === "FRANCHISE" ? "Franchise" : "Hub Manager", hubId: h.id }).then(reload),
                              }
                            : null,
                          h.id !== data.central && h.active && h.type !== "FRANCHISE" ? { label: "Make central hub", icon: "check", onSelect: () => makeCentral(h) } : null,
                          ...(f
                            ? [
                                { label: `Riders (${f.riders})`, icon: "users" as const, onSelect: () => openRiders(f) },
                                { label: "Rates", icon: "wallet" as const, title: "Commission on the delivery charge", onSelect: () => openRates(f, reload) },
                              ]
                            : []),
                          "sep",
                          // One switch: for a franchise hub it is the hub and its franchise together.
                          f
                            ? { label: h.active && f.status === "ACTIVE" ? "Inactive" : "Active", icon: "alert", danger: h.active && f.status === "ACTIVE", onSelect: () => toggleFranchiseHub(h, f) }
                            : { label: h.active ? "Inactive" : "Active", icon: "alert", danger: h.active, onSelect: () => toggle(h) },
                        ]}
                      />
                      </>
                    );
                  })()}
                  </div>
                </td>
              </tr>
              </Fragment>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={7} className="faint" style={{ textAlign: "center" }}>
                  {needle ? "No hub matches." : "No hubs yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pager {...pager} noun="hub" />
    </Panel>
    </>
  );
}

/** Who runs the hub: a card per Hub Manager, or per Franchise user of its franchise, each with Manage. */
function HubPeople({ hub, franchise, staffOf, reload }: { hub: Hub; franchise?: Franchise; staffOf: (id: string) => Staff | undefined; reload: () => Promise<unknown> }) {
  const { user } = useAuth();
  const line = (p: { phone?: string | null; email?: string | null }) => [p.phone ? phoneText(p.phone) : "", p.email || ""].filter(Boolean).join(" · ");
  const card = (key: string, p: { name: string; phone?: string | null; email?: string | null; status?: string }, manage: React.ReactNode) => (
    <div key={key} className="hub-person">
      <span>
        <strong>{p.name}</strong>
        <small>{line(p)}</small>
      </span>
      {manage}
    </div>
  );
  if (hub.franchise) {
    const users = (franchise?.users ?? []).filter(u => u.status === "ACTIVE");
    return (
      <div className="hub-people">
        <span className="faint" style={{ fontSize: 12 }}>
          {`Franchise · ${users.length} user${users.length === 1 ? "" : "s"}`} {hub.franchise.status !== "ACTIVE" ? <Pill tone="bad">Suspended</Pill> : null}
        </span>
        {franchise
          ? users.map(u => card(u.id, u, <MoreMenu label="Manage" items={franchiseUserItems(u, franchise.hub, reload)} />))
          : null}
      </div>
    );
  }
  const me = user?.id;
  return (
    <div className="hub-people">
      {(hub.managers ?? []).filter(p => !p.status || p.status === "ACTIVE").map(p =>
        card(
          p.id,
          p,
          (() => {
            const u = staffOf(p.id);
            return u ? <MoreMenu label="Manage" items={staffItems(u, me)} /> : null;
          })(),
        ),
      )}
    </div>
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
