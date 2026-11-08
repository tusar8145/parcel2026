/**
 * Address (Location settings; bridge-geo.js): the delivery address hierarchy offered on every booking form, template
 * and import — districts → zones → areas, with search.
 *   Drill-down, search                         GET /geography, GET /geography/counts
 *   Add district / zone (optional serving hub)  POST /geography/districts, /geography/zones
 *   Add areas (one per line, pasted)            POST /geography/areas
 *   Rename / map point / (de)activate           PATCH /geography/{districts,zones,areas}
 *   Delete (only when unused; shows what uses it)  GET /geography/usage, DELETE /geography/…
 * Renames update every record that names the place. Live: catalog.updated refreshes the lists.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { confirm, openCustom, openForm, type FormField } from "@panel/ui/dialogs";
import { Button, Loading, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { DialogFrame } from "@/lib/admin";

type Level = "district" | "zone" | "area";
interface Place {
  name: string;
  active: boolean;
  lat?: number | null;
  lng?: number | null;
}
interface Area extends Place {}
interface Zone extends Place {
  areas: Area[];
  servedBy: { name: string }[];
}
interface District extends Place {
  zones: Zone[];
}
interface Tree {
  districts: District[];
  totals: { districts: number; zones: number; areas: number; inactive: { districts: number; zones: number; areas: number } };
}
type Usage = { total: number; items: { label: string; count: number }[] };
const num = (n: unknown) => Number(n || 0).toLocaleString("en-US");
const same = (a?: string | null, b?: string | null) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const path = (level: Level) => `/geography/${level === "district" ? "districts" : level === "zone" ? "zones" : "areas"}`;
const SEARCH_LIMIT = 120;

function nameProblem(value: string, what: string) {
  const v = value.trim();
  if (!v) return `Enter the ${what} name`;
  if (v.length > 80) return "Use at most 80 characters";
  if (v.includes("|")) return 'A name can\'t contain "|"';
  return "";
}
const coordFields = (p: Partial<Place> = {}): FormField[] => [
  { id: "lat", label: "Latitude", type: "number", step: 0.000001, min: 20, max: 27, value: p.lat ?? "" },
  { id: "lng", label: "Longitude", type: "number", step: 0.000001, min: 88, max: 93, value: p.lng ?? "" },
];
const coordRules = {
  lat: (v: string, all: Record<string, string>) => (!v && !all.lng ? "" : !v ? "Give both latitude and longitude, or neither" : Number(v) < 20 || Number(v) > 27 ? "Latitude must be between 20 and 27" : ""),
  lng: (v: string, all: Record<string, string>) => (!v && !all.lat ? "" : !v ? "Give both latitude and longitude, or neither" : Number(v) < 88 || Number(v) > 93 ? "Longitude must be between 88 and 93" : ""),
};
const coordsOf = (v: Record<string, string>) => (v.lat && v.lng ? { lat: Number(v.lat), lng: Number(v.lng) } : { lat: null, lng: null });

export default function Address() {
  const qc = useQueryClient();
  const tree = useQuery({ queryKey: ["admin", "geography"], queryFn: () => api<Tree>("/geography") });
  const [sel, setSel] = useState<{ district: string | null; zone: string | null }>({ district: null, zone: null });
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  useLive(["catalog.updated"], () => void qc.invalidateQueries({ queryKey: ["admin", "geography"] }));

  const t = tree.data;
  const d = t?.districts.find(x => same(x.name, sel.district)) || t?.districts[0] || null;
  const z = d?.zones.find(x => same(x.name, sel.zone)) || d?.zones[0] || null;
  useEffect(() => {
    if (t && (!sel.district || !t.districts.some(x => same(x.name, sel.district)))) setSel({ district: t.districts[0]?.name ?? null, zone: t.districts[0]?.zones[0]?.name ?? null });
  }, [t, sel.district]);

  const counts = useQuery({ queryKey: ["admin", "geo-counts", "districts"], queryFn: async () => (await api<{ counts: Record<string, Usage> }>("/geography/counts")).counts, enabled: !!t });
  const zoneCounts = useQuery({ queryKey: ["admin", "geo-counts", d?.name], queryFn: async () => (await api<{ counts: Record<string, Usage> }>(`/geography/counts?${new URLSearchParams({ district: d!.name })}`)).counts, enabled: !!d });
  const areaCounts = useQuery({ queryKey: ["admin", "geo-counts", d?.name, z?.name], queryFn: async () => (await api<{ counts: Record<string, Usage> }>(`/geography/counts?${new URLSearchParams({ district: d!.name, zone: z!.name })}`)).counts, enabled: !!d && !!z });
  const usageOf = (level: Level, name: string) => {
    const list = level === "district" ? counts.data : level === "zone" ? zoneCounts.data : areaCounts.data;
    return list ? list[name] || { total: 0, items: [] } : null;
  };
  const usageText = (level: Level, name: string) => {
    const u = usageOf(level, name);
    return !u ? "counting…" : u.total ? `used by ${num(u.total)} record${u.total === 1 ? "" : "s"}` : "unused";
  };
  const placeOf = (level: Level, name: string) => (level === "district" ? { district: name } : level === "zone" ? { district: d!.name, zone: name } : { district: d!.name, zone: z!.name, area: name });

  async function changed(message: string, next?: { district?: string | null; zone?: string | null }, note = "") {
    setNotice(note);
    if (next) setSel(s => ({ ...s, ...next }));
    await Promise.all([qc.invalidateQueries({ queryKey: ["admin", "geography"] }), qc.invalidateQueries({ queryKey: ["admin", "geo-counts"] }), qc.invalidateQueries({ queryKey: ["admin", "catalog"] })]);
    toast(message, "good");
  }

  async function openAdd(level: Level) {
    if (level === "district")
      return openForm({
        title: "Add district",
        description: "A new district for booking forms, templates and imports. Add its zones next.",
        submit: "Add district",
        fields: [{ id: "name", label: "District name", required: true, maxLength: 80, placeholder: "e.g. Bandarban", full: true }, ...coordFields()],
        validate: { name: v => nameProblem(v, "district"), ...coordRules },
        onSubmit: async v => {
          const p = coordsOf(v);
          const r = await api<{ district: string }>(path("district"), { method: "POST", body: { name: v.name.trim(), ...(p.lat != null ? p : {}) } });
          await changed(`District ${r.district} added.`, { district: r.district, zone: null });
        },
      });
    if (level === "zone") {
      if (!d) return;
      const hubs = await api<{ id: string; name: string; code: string; type?: string }[]>("/hubs").catch(() => []);
      return openForm({
        title: `Add zone · ${d.name}`,
        description: "Zone names are unique across the country; add the district in brackets when a name repeats, e.g. “Kaliganj (Gazipur)”.",
        submit: "Add zone",
        fields: [
          { id: "name", label: "Zone name", required: true, maxLength: 80, placeholder: "e.g. Thanchi", full: true },
          { id: "hubId", label: "Serving hub", type: "select", full: true, value: "", options: [{ value: "", label: "No serving hub yet" }, ...hubs.map(h => ({ value: h.id, label: `${h.name} · ${h.code}${h.type === "FRANCHISE" ? " · Franchise" : ""}` }))] },
          ...coordFields(),
        ],
        validate: { name: v => nameProblem(v, "zone"), ...coordRules },
        onSubmit: async v => {
          const p = coordsOf(v);
          const r = await api<{ zone: string; district: string; deliveryZone?: { code: string } | null }>(path("zone"), { method: "POST", body: { district: d.name, name: v.name.trim(), ...(p.lat != null ? p : {}), ...(v.hubId ? { hubId: v.hubId } : {}) } });
          await changed(`Zone ${r.zone} added to ${r.district}${r.deliveryZone ? ` (delivery zone ${r.deliveryZone.code})` : ""}.`, { zone: r.zone });
        },
      });
    }
    if (!z || !d) return;
    return openForm({
      title: `Add areas · ${z.name}`,
      description: "One area per line (paste a list). Names already in the zone and invalid lines are skipped and listed.",
      submit: "Add areas",
      fields: [{ id: "names", label: "Areas", type: "textarea", rows: 8, required: true, placeholder: "Kaptai Bazar\nChandraghona\nBanarupa", full: true }],
      validate: { names: v => (!v.split(/\r?\n/).some(n => n.trim()) ? "Enter at least one area" : v.split(/\r?\n/).length > 2000 ? "Add at most 2,000 areas at once" : "") },
      onSubmit: async v => {
        const r = await api<{ zone: string; added: string[]; skipped: { line: number; name: string; reason: string }[] }>(path("area"), { method: "POST", body: { district: d.name, zone: z.name, names: v.names.split(/\r?\n/) } });
        const skipped = r.skipped.map(s => `Line ${s.line} · ${s.name}: ${s.reason}`).join("\n");
        await changed(`${r.added.length} area${r.added.length === 1 ? "" : "s"} added to ${r.zone}${r.skipped.length ? `; ${r.skipped.length} skipped` : ""}.`, undefined, r.skipped.length ? `Skipped when adding areas to ${r.zone}:\n${skipped}` : "");
      },
    });
  }

  function openEdit(level: Level, item: Place) {
    return openForm({
      title: `Edit ${level} · ${item.name}`,
      description: "Renaming updates every parcel, address, hub, rider, delivery zone, SLA policy and import setting that names it, in one step, and is recorded in the audit log.",
      submit: "Save",
      fields: [{ id: "name", label: `${level[0].toUpperCase()}${level.slice(1)} name`, required: true, maxLength: 80, value: item.name, full: true }, ...coordFields(item)],
      validate: { name: v => nameProblem(v, level), ...coordRules },
      onSubmit: async v => {
        const next = v.name.trim();
        const p = coordsOf(v);
        const body: Record<string, unknown> = { ...placeOf(level, item.name) };
        if (next !== item.name) body.name = next;
        if ((p.lat ?? null) !== (item.lat ?? null) || (p.lng ?? null) !== (item.lng ?? null)) Object.assign(body, p);
        if (!body.name && !("lat" in body)) return "Nothing changed.";
        const r = await api<{ district?: string; zone?: string; references?: Record<string, number> }>(path(level), { method: "PATCH", body });
        const refs = Object.values(r.references || {}).reduce((s, n) => s + n, 0);
        await changed(body.name ? `${item.name} renamed to ${String(body.name)}${refs ? `; ${num(refs)} record${refs === 1 ? "" : "s"} updated` : ""}.` : `${item.name} saved.`, level === "district" ? { district: r.district ?? next } : level === "zone" ? { zone: r.zone ?? next } : undefined);
      },
    });
  }

  async function toggle(level: Level, item: Place) {
    const next = !item.active;
    const ok = next
      ? await confirm({ title: `Activate ${item.name}?`, message: "It appears again on booking forms, templates and imports.", ok: "Activate" })
      : await confirm({ title: `Deactivate ${item.name}?`, message: `It disappears from new bookings, dropdowns, templates and imports${level === "district" ? " (with its zones and areas)" : level === "zone" ? " (with its areas)" : ""}. Existing parcels, addresses and hubs keep it.`, ok: "Deactivate", danger: true });
    if (!ok) return;
    setBusy(`${level}|${item.name}`);
    try {
      await api(path(level), { method: "PATCH", body: { ...placeOf(level, item.name), active: next } });
      await changed(`${item.name} ${next ? "activated" : "deactivated"}.`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }

  function showInUse(level: Level, item: Place, usage: Usage) {
    return openCustom(close => (
      <DialogFrame
        title={`${item.name} is in use`}
        subtitle={`It can't be deleted while ${num(usage.total)} record${usage.total === 1 ? "" : "s"} use${usage.total === 1 ? "s" : ""} it. Deactivate it instead: it disappears from new bookings and lists, and existing records keep it.`}
        close={() => close()}
        foot={
          item.active ? (
            <>
              <Button onClick={() => close()}>Cancel</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await api(path(level), { method: "PATCH", body: { ...placeOf(level, item.name), active: false } });
                    close();
                    await changed(`${item.name} deactivated.`);
                  } catch (e) {
                    toastError(e);
                  }
                }}
              >
                Deactivate instead
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => close()}>
              Close
            </Button>
          )
        }
      >
        <strong>What uses it</strong>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {usage.items.map(i => (
            <li key={i.label}>
              {i.label}: <strong>{num(i.count)}</strong>
            </li>
          ))}
        </ul>
      </DialogFrame>
    ));
  }

  async function remove(level: Level, item: Place & { zones?: Zone[]; areas?: Area[] }) {
    setBusy(`${level}|${item.name}`);
    try {
      const usage = await api<Usage>(`/geography/usage?${new URLSearchParams(placeOf(level, item.name) as Record<string, string>)}`);
      if (usage.total) return void showInUse(level, item, usage);
      const children = level === "district" ? ` and its ${num(item.zones?.length)} zones` : level === "zone" ? ` and its ${num(item.areas?.length)} areas` : "";
      if (!(await confirm({ title: `Delete ${item.name}${children}?`, message: "Nothing uses it. This can't be undone (you can add it again later).", ok: "Delete", danger: true }))) return;
      await api(`${path(level)}?${new URLSearchParams(placeOf(level, item.name) as Record<string, string>)}`, { method: "DELETE" });
      await changed(`${item.name} deleted.`, level === "district" ? { district: null, zone: null } : level === "zone" ? { zone: null } : undefined);
    } catch (e) {
      const err = e as { code?: string; details?: { usage?: Usage } };
      if (err?.code === "IN_USE" && err.details?.usage) return void showInUse(level, item, err.details.usage);
      toastError(e);
    } finally {
      setBusy("");
    }
  }

  const visible = <T extends Place>(items: T[]) => (showInactive ? items : items.filter(i => i.active));
  const row = (level: Level, item: Place & { zones?: Zone[]; areas?: Area[] }, selected: boolean, meta: string, pick?: () => void) => (
    <li key={item.name} style={{ listStyle: "none", padding: "9px 10px", border: `1px solid ${selected ? "#9fb6f0" : "var(--line)"}`, borderRadius: 8, background: selected ? "#f3f6ff" : "#fff", opacity: item.active ? 1 : 0.78 }}>
      <div role={pick ? "button" : undefined} tabIndex={pick ? 0 : undefined} onClick={pick} onKeyDown={e => pick && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick())} className="row" style={{ justifyContent: "space-between", gap: 8, cursor: pick ? "pointer" : undefined }}>
        <strong style={{ fontSize: 13 }}>{item.name}</strong>
        <Pill tone={item.active ? "good" : "warn"}>{item.active ? "Active" : "Inactive"}</Pill>
      </div>
      <small className="faint" style={{ display: "block", marginTop: 3 }}>
        {meta}
      </small>
      <div className="row" style={{ gap: 5, flexWrap: "wrap", marginTop: 6 }}>
        <Button size="sm" onClick={() => void openEdit(level, item)}>
          Edit
        </Button>
        <Button size="sm" disabled={busy === `${level}|${item.name}`} onClick={() => void toggle(level, item)}>
          {item.active ? "Deactivate" : "Activate"}
        </Button>
        <Button size="sm" variant="danger" disabled={busy === `${level}|${item.name}`} onClick={() => void remove(level, item)}>
          Delete
        </Button>
      </div>
    </li>
  );
  const column = (title: string, sub: string, add: React.ReactNode, body: React.ReactNode) => (
    <div style={{ display: "grid", gap: 8, alignContent: "start", minWidth: 0 }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <div>
          <strong>{title}</strong>
          <small className="faint" style={{ display: "block" }}>
            {sub}
          </small>
        </div>
        {add}
      </div>
      <ul style={{ display: "grid", gap: 7, margin: 0, padding: 0, maxHeight: 460, overflow: "auto" }}>{body}</ul>
    </div>
  );

  function searchResults() {
    const query = q.toLowerCase();
    const hits: { d: District; z?: Zone; label: string; path: string; active: boolean }[] = [];
    for (const dd of t!.districts) {
      if (dd.name.toLowerCase().includes(query)) hits.push({ d: dd, label: dd.name, path: "District", active: dd.active });
      for (const zz of dd.zones) {
        if (zz.name.toLowerCase().includes(query)) hits.push({ d: dd, z: zz, label: zz.name, path: `Zone · ${dd.name}`, active: zz.active && dd.active });
        for (const a of zz.areas) if (a.name.toLowerCase().includes(query)) hits.push({ d: dd, z: zz, label: a.name, path: `Area · ${zz.name}, ${dd.name}`, active: a.active && zz.active && dd.active });
      }
      if (hits.length > SEARCH_LIMIT * 4) break;
    }
    const shown = (showInactive ? hits : hits.filter(h => h.active)).slice(0, SEARCH_LIMIT);
    return (
      <>
        <div className="table-wrap" style={{ marginBottom: 12, maxHeight: 280 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Where</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((h, i) => (
                <tr key={i}>
                  <td className="strong">{h.label}</td>
                  <td>{h.path}</td>
                  <td>
                    <Pill tone={h.active ? "good" : "warn"}>{h.active ? "Active" : "Inactive"}</Pill>
                  </td>
                  <td>
                    <Button
                      size="sm"
                      onClick={() => {
                        setSel({ district: h.d.name, zone: h.z?.name || h.d.zones[0]?.name || null });
                        setQ("");
                      }}
                    >
                      Show
                    </Button>
                  </td>
                </tr>
              ))}
              {!shown.length ? (
                <tr>
                  <td colSpan={4} className="faint" style={{ textAlign: "center" }}>{`Nothing matches “${q}”.`}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <small className="faint" style={{ display: "block", margin: "-6px 0 10px" }}>
          {hits.length > SEARCH_LIMIT ? `Showing the first ${SEARCH_LIMIT} matches; type more to narrow it.` : `${shown.length} match${shown.length === 1 ? "" : "es"}.`}
        </small>
      </>
    );
  }

  const inactive = t ? t.totals.inactive.districts + t.totals.inactive.zones + t.totals.inactive.areas : 0;
  return (
    <>
      <PageHeading eyebrow="Location settings" title="Address" subtitle="Districts, zones and areas. Every address form follows this list." />
      <Panel title="Delivery address hierarchy" subtitle="Districts, zones and areas offered on every booking form, template and import. Renames update every record; places in use can only be deactivated.">
        <div className="panel-body">
          {!t ? (
            tree.error ? <div className="callout bad">{describe(tree.error)}</div> : <Loading rows={6} />
          ) : (
            <>
              <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <input className="input sm" type="search" value={q} onChange={e => setQ(e.target.value.trimStart())} placeholder="Search districts, zones and areas" aria-label="Search districts, zones and areas" style={{ flex: 1, minWidth: 200, maxWidth: 360 }} />
                <label className="check">
                  <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> Show deactivated
                </label>
                <span className="faint">{`${num(t.totals.districts)} districts · ${num(t.totals.zones)} zones · ${num(t.totals.areas)} areas${inactive ? ` · ${num(inactive)} deactivated` : ""}`}</span>
              </div>
              {notice ? (
                <div className="faint" role="status" style={{ margin: "0 0 10px", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 8, background: "#fafbfd", whiteSpace: "pre-line" }}>
                  {notice}
                </div>
              ) : null}
              {q ? searchResults() : null}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 14 }}>
                {column(
                  "Districts",
                  "Choose one to see its zones",
                  <Button size="sm" variant="primary" onClick={() => void openAdd("district")}>
                    Add district
                  </Button>,
                  visible(t.districts).map(x => row("district", x, x === d, `${num(x.zones.length)} zones · ${usageText("district", x.name)}`, () => setSel({ district: x.name, zone: x.zones[0]?.name ?? null }))),
                )}
                {column(
                  d ? `Zones of ${d.name}` : "Zones",
                  d ? (d.active ? "Choose one to see its areas" : "District deactivated: its zones are hidden from bookings") : "",
                  d ? (
                    <Button size="sm" variant="primary" onClick={() => void openAdd("zone").catch(toastError)}>
                      Add zone
                    </Button>
                  ) : null,
                  d ? (
                    visible(d.zones).length ? (
                      visible(d.zones).map(x => row("zone", x, x === z, `${num(x.areas.length)} areas · ${x.servedBy.length ? `served by ${x.servedBy.map(h => h.name).join(", ")}` : "no serving hub"} · ${usageText("zone", x.name)}`, () => setSel(s => ({ ...s, zone: x.name }))))
                    ) : (
                      <li className="faint" style={{ listStyle: "none" }}>
                        No zones yet.
                      </li>
                    )
                  ) : (
                    <li className="faint" style={{ listStyle: "none" }}>
                      Choose a district.
                    </li>
                  ),
                )}
                {column(
                  z ? `Areas of ${z.name}` : "Areas",
                  z ? "No areas = any address in the zone" : "",
                  z ? (
                    <Button size="sm" variant="primary" onClick={() => void openAdd("area")}>
                      Add areas
                    </Button>
                  ) : null,
                  z && visible(z.areas).length ? (
                    visible(z.areas).map(x => row("area", x, false, usageText("area", x.name)))
                  ) : (
                    <li className="faint" style={{ listStyle: "none" }}>
                      {z ? "No areas listed: any address in the zone." : "Choose a zone."}
                    </li>
                  ),
                )}
              </div>
            </>
          )}
        </div>
      </Panel>
    </>
  );
}
