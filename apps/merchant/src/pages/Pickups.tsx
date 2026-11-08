/**
 * Pickup requests (merchant-features.js pickups + merchant-bridge.js "Pickup requests" page):
 *   - cards: awaiting pickup, rider assigned, collected today, awaiting drop-off (GET /merchants/me/stats)
 *   - Scheduled pickups: upcoming visits (GET /merchants/me/pickup-requests?from=today), Cancel a requested one
 *   - Recurring pickups (/merchants/me/pickup-schedules: list, pause / resume, remove, add) and Request a pickup
 *   - Pickup requests list: every request with its origin branch, pickup place and pickup status (server-paged)
 */
import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { normalizeBdPhone, bdPhoneProblem } from "@delivery-fast/shared/dist/phone.js";
import { api, describe } from "@panel/lib/api";
import { addressText, num, when } from "@panel/lib/format";
import { confirm, openCustom, openForm } from "@panel/ui/dialogs";
import { Icon } from "@panel/ui/Icon";
import { Button, Metric, PageHeading, Panel, Pill, useDebounced } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import { useMerchant } from "@/lib/merchant";
import { placeText } from "@/lib/text";
import type { Parcel } from "@/features/parcels/model";
import { Pager } from "@/features/parcels/Pager";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PICKUP_STATUS: Record<string, string> = { REQUESTED: "Requested", ASSIGNED: "Rider assigned", COMPLETED: "Collected", CANCELLED: "Cancelled", MISSED: "Missed" };
const AWAITING = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
const dhakaToday = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const dateOnly = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

interface PickupRequest {
  id: string;
  number: string;
  date: string;
  windowStart: string;
  windowEnd: string;
  status: string;
  street?: string;
  zone?: string;
  expectedParcels: number;
  schedule?: { name: string } | null;
}
interface Schedule {
  id: string;
  name: string;
  days: number[];
  windowStart: string;
  windowEnd: string;
  street?: string;
  zone?: string;
  district?: string;
  expectedParcels: number;
  active: boolean;
}
type Full = Parcel & { sender?: { name?: string }; pickup?: { area?: string; zone?: string; district?: string }; pickedUpAt?: string | null };

const windowLabel = (r: PickupRequest) => `${timeOnly(r.windowStart)} – ${timeOnly(r.windowEnd)}`;
function pickupStatus(p: Full) {
  if (AWAITING.includes(p.status) || p.status === "PICKUP_CANCELLED") return p.statusLabel;
  if (p.status === "EXCEPTION" && !p.pickedUpAt) return p.statusLabel;
  return "Picked up";
}

export default function Pickups() {
  const m = useMerchant();
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const stats = useQuery({ queryKey: ["m", "stats", "nav"], queryFn: () => api<{ parcels: { awaitingPickup: number; awaitingDropOff?: number; byStatus: Record<string, number> }; today: { pickedUp: number } }>(`/merchants/me/stats?period=7d${m.q("&")}`) });
  const schedules = useQuery({ queryKey: ["m", "pickup-schedules"], queryFn: () => api<{ items: Schedule[] }>(`/merchants/me/pickup-schedules${m.q()}`).then(r => r.items, () => [] as Schedule[]) });
  const upcoming = useQuery({ queryKey: ["m", "pickup-requests"], queryFn: () => api<{ items: PickupRequest[] }>(`/merchants/me/pickup-requests?from=${dhakaToday()}&limit=50${m.q("&")}`).then(r => r.items, () => [] as PickupRequest[]) });
  const reload = () => qc.invalidateQueries({ queryKey: ["m"] });
  const st = stats.data;
  const by = st?.parcels.byStatus ?? {};
  const open = (upcoming.data ?? []).filter(r => r.status === "REQUESTED" || r.status === "ASSIGNED");
  const active = (schedules.data ?? []).filter(s => s.active).length;

  async function cancelPickup(id: string) {
    if (!(await confirm({ title: "Cancel this pickup?", message: "The rider won't come for it.", ok: "Cancel pickup", cancel: "Keep it", danger: true }))) return;
    try {
      await api(`/merchants/me/pickup-requests/${id}/cancel${m.q()}`, { method: "POST" });
      toast("Pickup cancelled.");
    } catch (e) {
      toast(describe(e), "bad");
    }
    void reload();
  }

  return (
    <>
      <PageHeading
        title="Pickup requests"
        subtitle={m.doc ? "Schedule branch document pickups and manage recurring courier collections." : "Schedule, review, and manage parcel and document collections."}
        actions={
          <>
            <Button icon="clock" onClick={() => void openCustom(close => <Recurring close={() => close()} />, "wide")}>
              Recurring pickups
            </Button>
            <Button variant="primary" icon="plus" onClick={() => void requestPickup(m.q(), placeText(m.merchant.pickup as never) || String(m.merchant.pickupAddress ?? ""), reload)}>
              Request a pickup
            </Button>
          </>
        }
      />
      <div className="metrics">
        <Metric label="Awaiting pickup" value={st ? num(st.parcels.awaitingPickup) : "—"} icon="clock" />
        <Metric label="Rider assigned" value={st ? num((by.PICKUP_ASSIGNED ?? 0) + (by.PICKUP_CONFIRMED ?? 0)) : "—"} icon="truck" />
        <Metric label="Collected today" value={st ? num(st.today.pickedUp) : "—"} icon="check" />
        <Metric label="Awaiting drop-off" value={st ? num(st.parcels.awaitingDropOff ?? 0) : "—"} icon="pin" />
      </div>
      <Panel title="Scheduled pickups" subtitle={`${schedules.data?.length ? `${active} recurring pickup(s) active · ` : ""}upcoming visits by operations`}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Pickup</th>
                <th>When</th>
                <th>Schedule</th>
                <th>Address</th>
                <th>Parcels</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {open.map(r => (
                <tr key={r.id}>
                  <td className="strong">{r.number}</td>
                  <td className="nowrap">
                    {dateOnly(`${r.date}T00:00:00+06:00`)} · {windowLabel(r)}
                  </td>
                  <td>{r.schedule?.name || "One-off request"}</td>
                  <td>{addressText(r.street, r.zone)}</td>
                  <td>{r.expectedParcels}</td>
                  <td>
                    <Pill>{PICKUP_STATUS[r.status] || r.status}</Pill>
                  </td>
                  <td>
                    {r.status === "REQUESTED" ? (
                      <Button size="sm" onClick={() => cancelPickup(r.id)}>
                        Cancel
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!open.length ? (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    {upcoming.data ? "No scheduled pickups. Set up a recurring pickup or request one." : "Loading…"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
      <div style={{ height: 14 }} />
      <PickupList openParcel={id => setParams(p => (p.set("parcel", id), p))} />
    </>
  );
}

/** Every request with its pickup side (merchant-bridge.js toPickupRow), newest first, server-paged. */
function PickupList({ openParcel }: { openParcel: (id: string) => void }) {
  const m = useMerchant();
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 350);
  const key = `limit=${size}&page=${page}${q.trim().length >= 2 ? `&q=${encodeURIComponent(q.trim())}` : ""}`;
  const list = useQuery({ queryKey: ["m", "parcels", "pickups", key], queryFn: () => api<{ items: Full[]; total: number; pages: number }>(`/parcels?${key}${m.q("&")}`), placeholderData: keepPreviousData, staleTime: 15_000 });
  const rows = list.data?.items ?? [];
  return (
    <Panel
      title="Pickup requests list"
      subtitle="Newest first · updates live"
      tools={<input className="input sm" type="search" placeholder="Search pickup requests..." aria-label="Search pickup requests" value={search} onChange={e => (setSearch(e.target.value), setPage(1))} style={{ width: 240 }} />}
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Request ID</th>
              <th>{m.doc ? "Origin branch" : "Merchant contact"}</th>
              <th>Pickup location</th>
              <th>{m.doc ? "Document batches" : "Packages"}</th>
              <th>Requested</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <tr key={p.trackingId}>
                <td>
                  <button type="button" className="link-button tracking" onClick={() => openParcel(p.trackingId)}>
                    {p.trackingId}
                  </button>
                </td>
                <td>{m.doc ? p.originBranchCode || p.sender?.name || "—" : p.sender?.name || "—"}</td>
                <td>{[p.pickup?.area, p.pickup?.zone, p.pickup?.district].filter(Boolean).join(", ") || "—"}</td>
                <td>{p.type === "DOCUMENT" ? "1 document" : "1 parcel"}</td>
                <td className="nowrap">{when(p.createdAt)}</td>
                <td>
                  <Pill>{pickupStatus(p)}</Pill>
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={6} className="empty-cell">
                  {list.isLoading ? "Loading…" : list.isError ? describe(list.error) : "No pickup requests yet. Every order you create is collected from your pickup address."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={Math.max(1, list.data?.pages ?? 1)} size={size} total={list.data?.total ?? 0} shown={rows.length} noun="request" busy={list.isFetching} setPage={setPage} setSize={s => (setSize(s), setPage(1))} />
    </Panel>
  );
}

/** "Request a pickup": date (today + 6 days), parcels, window, note. */
async function requestPickup(q: string, from: string, reload: () => unknown) {
  const today = dhakaToday();
  await openForm({
    title: "Request a pickup",
    description: `From ${from} unless you change it.`,
    submit: "Request pickup",
    fields: [
      {
        id: "date",
        label: "Date",
        type: "select",
        value: today,
        options: [0, 1, 2, 3, 4, 5, 6].map(n => addDays(today, n)).map((d, i) => ({ value: d, label: `${i === 0 ? "Today" : i === 1 ? "Tomorrow" : WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]} · ${d}` })),
      },
      { id: "parcels", label: "Number of parcels", type: "number", value: "5", min: 1, max: 5000, required: true },
      { id: "start", label: "Window starts", type: "time", value: "14:00", required: true },
      { id: "end", label: "Window ends", type: "time", value: "17:00", required: true },
      { id: "note", label: "Note for the rider", maxLength: 500, full: true },
    ],
    validate: { end: (v, all) => (v && v > all.start ? "" : "End after the start time") },
    onSubmit: async v => {
      const r = await api<PickupRequest>(`/merchants/me/pickup-requests${q}`, { method: "POST", body: { date: v.date, windowStart: v.start, windowEnd: v.end, expectedParcels: Number(v.parcels) || 1, note: v.note.trim() || undefined } });
      void reload();
      return `Pickup ${r.number} requested for ${windowLabel(r)}.`;
    },
  });
}

/** "Recurring pickups": the list (pause / resume, remove) and "Add a recurring pickup". */
function Recurring({ close }: { close: () => void }) {
  const m = useMerchant();
  const qc = useQueryClient();
  const mm = m.merchant as Record<string, unknown> & { pickup?: { zone?: string } };
  const list = useQuery({ queryKey: ["m", "pickup-schedules"], queryFn: () => api<{ items: Schedule[] }>(`/merchants/me/pickup-schedules${m.q()}`).then(r => r.items) });
  const reload = () => qc.invalidateQueries({ queryKey: ["m"] });
  const [f, setF] = useState({
    name: "Daily pickup",
    parcels: "10",
    start: "10:00",
    end: "13:00",
    days: new Set([0, 1, 2, 3, 4, 6]),
    street: String(mm.pickupAddress ?? ""),
    zone: String(mm.pickup?.zone || mm.pickupArea || ""),
    district: String(mm.pickupDistrict ?? ""),
    contact: String(mm.pickupContactName || mm.contactName || ""),
    phone: String(mm.pickupContactPhone || mm.contactPhone || "").replace(/^\+880/, ""),
    note: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }));

  async function toggle(s: Schedule) {
    try {
      await api(`/merchants/me/pickup-schedules/${s.id}${m.q()}`, { method: "PATCH", body: { active: !s.active } });
      toast(s.active ? "Recurring pickup paused." : "Recurring pickup resumed.");
    } catch (e) {
      toast(describe(e), "bad");
    }
    void reload();
  }
  async function remove(s: Schedule) {
    if (!(await confirm({ title: "Remove this recurring pickup?", message: "Its upcoming pickups are cancelled.", ok: "Remove", danger: true }))) return;
    try {
      await api(`/merchants/me/pickup-schedules/${s.id}${m.q()}`, { method: "DELETE" });
      toast("Recurring pickup removed.");
    } catch (e) {
      toast(describe(e), "bad");
    }
    void reload();
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (f.name.trim().length < 2) found.name = "At least 2 characters";
    if (!(Number(f.parcels) >= 1)) found.parcels = "At least 1";
    if (!(f.end && f.start && f.end > f.start)) found.end = "End after the start time";
    if (f.street.trim().length < 3) found.street = "Enter the pickup address";
    if (f.zone.trim().length < 2) found.zone = "Enter the zone or area";
    if (f.district.trim().length < 2) found.district = "Enter the district";
    if (f.contact.trim().length < 2) found.contact = "Enter the contact name";
    const ph = bdPhoneProblem(f.phone);
    if (ph) found.phone = ph;
    setErrors(found);
    if (Object.keys(found).length) return;
    if (!f.days.size) return toast("Choose at least one day.");
    setBusy(true);
    try {
      await api(`/merchants/me/pickup-schedules${m.q()}`, {
        method: "POST",
        body: {
          name: f.name.trim(),
          days: [...f.days].sort(),
          windowStart: f.start,
          windowEnd: f.end,
          street: f.street.trim(),
          zone: f.zone.trim(),
          district: f.district.trim(),
          contactName: f.contact.trim(),
          contactPhone: normalizeBdPhone(f.phone.trim()) ?? f.phone.trim(),
          expectedParcels: Number(f.parcels) || 1,
          note: f.note.trim() || undefined,
        },
      });
      toast("Recurring pickup saved. Upcoming pickups were scheduled.", "good");
      void reload();
    } catch (err) {
      toast(describe(err), "bad");
    } finally {
      setBusy(false);
    }
  }
  const input = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, full = false) => (
    <label className={`field${full ? " full" : ""}`}>
      <span>{label}</span>
      <input className="input" value={f[k] as string} onChange={e => set(k, e.target.value)} aria-invalid={errors[k] ? true : undefined} {...props} />
      {errors[k] ? <span className="error">{errors[k]}</span> : null}
    </label>
  );
  return (
    <form onSubmit={save} noValidate>
      <div className="dialog-head">
        <div>
          <h2>Recurring pickups</h2>
          <p>On the chosen days a pickup request is created for operations automatically.</p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Days</th>
                <th>Window</th>
                <th>Parcels</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map(s => (
                <tr key={s.id}>
                  <td>
                    <div className="strong">{s.name}</div>
                    <div className="sub">{addressText(s.street, s.zone, s.district)}</div>
                  </td>
                  <td>{s.days.map(d => WEEKDAYS[d]).join(", ")}</td>
                  <td className="nowrap">
                    {s.windowStart}–{s.windowEnd}
                  </td>
                  <td>{s.expectedParcels}</td>
                  <td>
                    <Pill tone={s.active ? "good" : undefined}>{s.active ? "Active" : "Paused"}</Pill>
                  </td>
                  <td className="nowrap">
                    <Button size="sm" onClick={() => toggle(s)}>
                      {s.active ? "Pause" : "Resume"}
                    </Button>{" "}
                    <Button size="sm" onClick={() => remove(s)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
              {list.data && !list.data.length ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    No recurring pickups yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <h3 className="section-title" style={{ marginTop: 16 }}>
          Add a recurring pickup
        </h3>
        <div className="form-grid">
          {input("name", "Name", { maxLength: 80 })}
          {input("parcels", "Usual number of parcels", { type: "number", min: 1, max: 5000 })}
          {input("start", "Window starts", { type: "time" })}
          {input("end", "Window ends", { type: "time" })}
          <fieldset className="field full" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Days</legend>
            {WEEKDAYS.map((d, i) => (
              <label key={d} style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: "4px 12px 4px 0", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={f.days.has(i)}
                  onChange={e =>
                    setF(x => {
                      const days = new Set(x.days);
                      if (e.target.checked) days.add(i);
                      else days.delete(i);
                      return { ...x, days };
                    })
                  }
                />{" "}
                {d}
              </label>
            ))}
          </fieldset>
          {input("street", "Pickup address", { maxLength: 200 }, true)}
          {input("zone", "Zone / area")}
          {input("district", "District")}
          {input("contact", "Contact name")}
          <label className="field">
            <span>Contact mobile</span>
            <div className="phone-input">
              <span>+880</span>
              <input className="input" inputMode="tel" value={f.phone} onChange={e => set("phone", e.target.value)} aria-invalid={errors.phone ? true : undefined} />
            </div>
            {errors.phone ? <span className="error">{errors.phone}</span> : null}
          </label>
          {input("note", "Note for the rider (optional)", { maxLength: 500 }, true)}
        </div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" onClick={close}>
          Close
        </button>
        <button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>
          Save recurring pickup
        </button>
      </div>
    </form>
  );
}
