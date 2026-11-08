/**
 * Settings (merchant-bridge.js settingsRows / settingsAction, merchant-address.js, merchant-features.js):
 *   Corporate account      contact + structured business / pickup address (district › thana › area, map pin), pickup
 *                          contact, time and handover; an address change of an active account waits for approval
 *   Billing profile        → Balance
 *   Service package        assigned by Delivery Fast (a note)
 *   Business verification  documents (upload / replace / view), submit for review, history
 *   Notification settings  GET/PUT /me/notification-preferences
 *   Team & permissions     members (owners): invite, remove
 *   API & integrations     → API & Webhooks
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { bdPhoneProblem } from "@delivery-fast/shared/dist/phone.js";
import { api, ApiError, describe } from "@panel/lib/api";
import { useAuth } from "@panel/lib/auth";
import { when } from "@panel/lib/format";
import { confirm, openCustom } from "@panel/ui/dialogs";
import { Icon } from "@panel/ui/Icon";
import { Button, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { SearchSelect } from "@panel/ui/SearchSelect";
import { Select } from "@panel/ui/Select";
import { toast } from "@panel/ui/toast";
import { useMerchant, type Merchant } from "@/lib/merchant";
import { useCatalog, type Catalog } from "@/lib/catalog";
import { phoneText } from "@/lib/text";

const KYC_STATUS: Record<string, string> = { NOT_SUBMITTED: "Not submitted", PENDING: "Under review", APPROVED: "Verified", REJECTED: "Not approved" };
const TIMES: Record<string, string> = { MORNING: "Morning (9am–12pm)", MIDDAY: "Midday (12pm–3pm)", AFTERNOON: "Afternoon (3pm–6pm)" };
const HANDOVER: Record<string, string> = { RIDER_PICKUP: "Rider pickup", HUB_DROP: "Drop at hub" };
const OTHER = "__other__";
const PAYOUT_LABEL: Record<string, string> = { BKASH: "bKash", NAGAD: "Nagad", BANK: "Bank account" };
const dateOnly = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
type M = Merchant & Record<string, unknown>;

export default function Settings() {
  const m = useMerchant();
  const mm = m.merchant as M;
  const navigate = useNavigate();
  const members = useQuery({ queryKey: ["m", "members"], enabled: m.isOwner, queryFn: () => api<{ items: Member[] }>(`/merchants/me/members?limit=100${m.q("&")}`).then(r => r.items) });
  const keys = useQuery({ queryKey: ["m", "api-keys"], enabled: m.isOwner, queryFn: () => api<{ items: { revokedAt?: string | null }[] }>(`/merchants/me/api-keys?limit=200${m.q("&")}`).then(r => r.items) });
  const hooks = useQuery({ queryKey: ["m", "webhooks"], enabled: m.isOwner, queryFn: () => api<{ items: unknown[] }>(`/merchants/me/webhooks${m.q()}`).then(r => r.items) });
  const pkg = useQuery({ queryKey: ["m", "package"], queryFn: () => api<{ package?: { name: string; version: number; isDefault?: boolean } }>("/packages/me").catch(() => null) });
  const pk = pkg.data?.package;
  const pickup = mm.pickup as { zone?: string } | undefined;
  const hub = mm.pickupHub as { name: string } | null | undefined;
  const kyc = mm.kyc;
  const activeKeys = keys.data ? keys.data.filter(k => !k.revokedAt).length : 0;
  const owner = (what: string, run: () => unknown) => () => (m.isOwner ? run() : toast(`Only workspace owners can ${what}.`));
  const payout = mm.payoutAccount as { method: string; accountNumber: string; accountName: string } | null | undefined;
  const rows: [string, string, string, () => unknown][] = [
    [m.doc ? "Corporate account" : "Store profile", `${mm.name} · ${mm.addressComplete === false ? `${mm.pickupArea}, ${mm.pickupDistrict} · complete your address` : `${pickup?.zone || mm.pickupArea}, ${mm.pickupDistrict}${hub ? ` · hub ${hub.name}` : ""}`}`, dateOnly(mm.updatedAt as string), owner("change the profile", () => openCustom(close => <Profile close={() => close()} />, "wide"))],
    m.doc
      ? ["Billing profile", "Monthly consolidated invoices · due 15 days after issue", "—", () => navigate("/balance")]
      : ["Payout account", payout ? `${PAYOUT_LABEL[payout.method] || payout.method} · ••••${String(payout.accountNumber).slice(-4)} · ${payout.accountName}` : "Not set · add one to receive COD payouts", "—", owner("change the payout account", () => openCustom(close => <Payout close={() => close()} />))],
    ["Service package", pk ? `${pk.name} · version ${pk.version}${pk.isDefault ? " (default)" : ""}` : "Your service package", "—", () => toast("Service packages are assigned by Delivery Fast. Contact your account manager to change your package.")],
    ["Business verification", `${KYC_STATUS[kyc?.status ?? ""] || "Not submitted"}${kyc?.status === "REJECTED" && kyc.rejectionReason ? ` · ${kyc.rejectionReason}` : " · trade license, owner NID and payout proof"}`, dateOnly(kyc?.reviewedAt || kyc?.submittedAt), () => openCustom(close => <Kyc close={() => close()} />, "wide")],
    ["Notification settings", `SMS updates to ${phoneText(mm.contactPhone as string)} · choose which messages you get`, "—", () => void openNotifications(mm.contactPhone as string)],
    ["Team & permissions", members.data ? `${members.data.length} team member${members.data.length === 1 ? "" : "s"} · ${new Set(members.data.map(x => x.role)).size} role(s)` : m.isOwner ? "Loading…" : "Managed by workspace owners", "—", owner("manage the team", () => openCustom(close => <Team close={() => close()} />, "wide"))],
    ["API & integrations", keys.data || hooks.data ? `${activeKeys} active API key${activeKeys === 1 ? "" : "s"} · ${hooks.data?.length ?? 0} webhook${hooks.data?.length === 1 ? "" : "s"}` : "API keys and webhooks", "—", () => navigate("/api-and-webhooks")],
  ];
  return (
    <>
      <PageHeading eyebrow={m.doc ? "Banking & Financial workspace" : "Merchant workspace"} title="Settings" subtitle={m.doc ? "Configure corporate billing, branch access, notifications, and integrations." : "Configure your store, delivery preferences, team, and notifications."} />
      <Panel title="Settings list" subtitle="Live data">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Details</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(([name, details, updated, run]) => (
                <tr key={name}>
                  <td className="strong">{name}</td>
                  <td>{details}</td>
                  <td className="nowrap">{updated}</td>
                  <td>
                    <Button size="sm" onClick={() => void run()}>
                      Manage
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ───────────── Corporate account ─────────────

interface Place {
  district: string;
  zone: string;
  area: string;
  other: string;
  street: string;
  pin: { lat: number; lng: number } | null;
}
const placeOf = (p?: Record<string, unknown> | null): Place => ({
  district: String(p?.district ?? ""),
  zone: String(p?.zone ?? ""),
  area: p?.areaOther ? OTHER : p?.area && p.area !== p.zone ? String(p.area) : "",
  other: p?.areaOther ? String(p.area ?? "") : "",
  street: String(p?.street ?? ""),
  pin: p?.lat != null ? { lat: Number(p.lat), lng: Number(p.lng) } : null,
});

function Profile({ close }: { close: () => void }) {
  const m = useMerchant();
  const mm = m.merchant as M;
  const qc = useQueryClient();
  const catalog = useCatalog();
  const request = useQuery({ queryKey: ["m", "address-request"], queryFn: () => api<{ request: AddressRequest | null }>(`/merchants/me/address-request${m.q()}`).then(r => r.request, () => null) });
  const same0 = !!mm.pickupSameAsBusiness || (!mm.business && mm.addressComplete === false);
  const biz0 = mm.business ? (mm.business as Record<string, unknown>) : mm.addressComplete === false && mm.pickupSuggestion ? { ...(mm.pickupSuggestion as object), street: mm.pickupAddress } : mm.addressComplete === false ? { district: mm.pickupDistrict, street: mm.pickupAddress } : mm.pickupSameAsBusiness ? (mm.pickup as Record<string, unknown>) : null;
  const [c, setC] = useState({ name: String(mm.contactName ?? ""), phone: String(mm.contactPhone ?? "").replace(/^\+880/, ""), email: String(mm.contactEmail ?? "") });
  const [biz, setBiz] = useState<Place>(placeOf(biz0));
  const [pu, setPu] = useState<Place>(placeOf(mm.pickupSameAsBusiness || mm.addressComplete === false ? null : (mm.pickup as Record<string, unknown>)));
  const [same, setSame] = useState(same0);
  const [p, setP] = useState({ contact: String(mm.pickupContactName || mm.contactName || ""), phone: String(mm.pickupContactPhone || mm.contactPhone || "").replace(/^\+880/, ""), time: String(mm.pickupTime ?? ""), handover: String(mm.handover || "RIDER_PICKUP") });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const active = same ? biz : pu;
  const hubQ = useQuery({
    queryKey: ["pickup-hub", active.district, active.zone],
    enabled: !!active.district && !!active.zone,
    queryFn: () => api<{ hub: { name: string; code: string; address: string } | null }>(`/merchants/pickup-hub?district=${encodeURIComponent(active.district)}&zone=${encodeURIComponent(active.zone)}`),
  });

  function check() {
    const e: Record<string, string> = {};
    if (c.name.trim().length < 2) e.name = "Enter the contact name";
    const ph = bdPhoneProblem(c.phone);
    if (ph) e.phone = ph;
    if (c.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email.trim())) e.email = "Enter a valid email address";
    const placeRules = (key: string, pl: Place) => {
      if (!pl.district) e[`${key}District`] = "Choose the district";
      if (!pl.zone) e[`${key}Zone`] = "Choose the thana / upazila";
      if (pl.zone && !pl.area && (catalog?.areasByZone?.[pl.zone] ?? []).length) e[`${key}Area`] = 'Choose the area, or "Other" and type it';
      if (pl.area === OTHER && pl.other.trim().length < 2) e[`${key}Other`] = "Type the area name";
      if (pl.street.trim().length < 5) e[`${key}Street`] = "Enter the house, road and flat (at least 5 characters)";
    };
    placeRules("biz", biz);
    if (!same) placeRules("pu", pu);
    if (p.contact.trim().length < 2) e.pContact = "Enter the pickup contact's name";
    const pp = bdPhoneProblem(p.phone);
    if (pp) e.pPhone = pp;
    if (!p.time) e.pTime = "Choose the preferred pickup time";
    setErrors(e);
    return !Object.keys(e).length;
  }
  const placeBody = (pl: Place) => ({ district: pl.district, zone: pl.zone, ...(pl.area === OTHER ? { otherArea: pl.other.trim() } : pl.area ? { area: pl.area } : {}), street: pl.street.trim(), ...(pl.pin ? { lat: pl.pin.lat, lng: pl.pin.lng } : {}) });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!check()) return toast("Check the highlighted fields.", "bad");
    setBusy(true);
    try {
      const before = (mm.pickupHub as { id?: string } | null)?.id || null;
      const pendingBefore = request.data?.status === "PENDING" ? request.data.id : null;
      const saved = await api<M & { addressRequest?: AddressRequest | null; pickupHub?: { id: string; name: string } | null }>(`/merchants/me${m.q()}`, {
        method: "PATCH",
        body: {
          contactName: c.name.trim(),
          contactPhone: c.phone.trim(),
          contactEmail: c.email.trim() || null,
          business: placeBody(biz),
          pickupSameAsBusiness: same,
          ...(same ? {} : { pickup: placeBody(pu) }),
          pickupContactName: p.contact.trim(),
          pickupContactPhone: p.phone.trim(),
          pickupTime: p.time,
          handover: p.handover,
        },
      });
      await m.reload();
      void qc.invalidateQueries({ queryKey: ["m"] });
      close();
      if (saved.addressRequest?.status === "PENDING" && saved.addressRequest.id !== pendingBefore)
        return toast(`Profile saved. Your address change was sent to Delivery Fast for approval${saved.addressRequest.hubChanges ? ` (pickups would move to ${saved.addressRequest.proposedHub?.name || "another hub"})` : ""}; until then your current address stays.`, "good");
      const hubNote = (saved.pickupHub?.id || null) !== before ? (saved.pickupHub ? ` Your pickups are now served by ${saved.pickupHub.name}.` : " No hub serves the new pickup area yet; operations will assign one.") : "";
      toast(`Profile saved.${hubNote}`, "good");
    } catch (err) {
      // Field errors (business.zone, pickupContactPhone…) under their fields.
      const details = err instanceof ApiError && Array.isArray(err.details) ? (err.details as { path: string; message: string }[]) : [];
      const map: Record<string, string> = {};
      for (const d of details) {
        const [head, tail = ""] = d.path.split(".");
        const key = head === "contactPhone" ? "phone" : head === "contactName" ? "name" : head === "contactEmail" ? "email" : head === "business" || head === "pickup" ? `${head === "business" ? "biz" : "pu"}${tail === "lat" || tail === "lng" || !tail ? "District" : tail[0].toUpperCase() + tail.slice(1)}` : ({ pickupContactName: "pContact", pickupContactPhone: "pPhone", pickupTime: "pTime" } as Record<string, string>)[head];
        if (key) map[key] = d.message;
      }
      if (Object.keys(map).length) setErrors(map);
      else toast(describe(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  const r = request.data;
  const showRequest = r && !(r.status !== "PENDING" && r.decidedAt && Date.now() - new Date(r.decidedAt).getTime() > 14 * 864e5);
  const err = (k: string) => (errors[k] ? <span className="error">{errors[k]}</span> : null);
  return (
    <form onSubmit={submit} noValidate>
      <div className="dialog-head">
        <div>
          <h2>{m.doc ? "Corporate account" : "Store profile"}</h2>
          <p>
            {mm.name} · {mm.code}
          </p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        {showRequest ? (
          <div className={`callout ${r.status === "REJECTED" ? "bad" : r.status === "APPROVED" ? "good" : "warn"}`} role="status">
            <div>
              <strong>{r.status === "PENDING" ? "Address change waiting for approval" : r.status === "APPROVED" ? "Address change approved" : "Address change not approved"}</strong>
              <div>
                New pickup address: {r.proposed?.pickup || "—"}
                {r.hubChanges ? ` · pickups move from ${r.previousHub?.name || "no hub"} to ${r.proposedHub?.name || "no hub yet"}` : ""}
              </div>
              {r.status === "REJECTED" && r.note ? <div>Reason: {r.note}</div> : null}
              {r.status === "PENDING" ? (
                <>
                  <div className="faint">Sent {new Date(r.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}. Your current address stays until it's approved.</div>
                  <Button
                    size="sm"
                    style={{ marginTop: 6 }}
                    onClick={async () => {
                      try {
                        await api(`/merchants/me/address-request/cancel${m.q()}`, { method: "POST" });
                        toast("Address change cancelled.");
                        void request.refetch();
                      } catch (e) {
                        toast(describe(e), "bad");
                      }
                    }}
                  >
                    Cancel this change
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        ) : mm.status === "ACTIVE" ? (
          <p className="faint" style={{ margin: "0 0 10px", fontSize: 12.5 }}>
            Changes to your business or pickup address are checked by Delivery Fast before they apply.
          </p>
        ) : null}
        {mm.addressComplete === false ? (
          <div className="callout warn">
            <span>
              <strong>Complete your address.</strong> We have your pickup address as text: “{[mm.pickupAddress, mm.pickupArea, mm.pickupDistrict].filter(Boolean).join(", ")}”. Choose the district, thana and area below so pickups reach the right hub.
              {mm.pickupSuggestion ? " We've preselected the closest match; check it." : ""}
            </span>
          </div>
        ) : null}
        <div className="form-grid">
          <label className="field">
            <span>Contact name</span>
            <input className="input" maxLength={120} value={c.name} onChange={e => setC({ ...c, name: e.target.value })} aria-invalid={errors.name ? true : undefined} />
            {err("name")}
          </label>
          <label className="field">
            <span>Contact phone</span>
            <div className="phone-input">
              <span>+880</span>
              <input className="input" inputMode="tel" value={c.phone} onChange={e => setC({ ...c, phone: e.target.value })} aria-invalid={errors.phone ? true : undefined} />
            </div>
            {err("phone")}
          </label>
          <label className="field">
            <span>Contact email</span>
            <input className="input" type="email" value={c.email} onChange={e => setC({ ...c, email: e.target.value })} aria-invalid={errors.email ? true : undefined} />
            {err("email")}
          </label>
          <h3 className="field full" style={{ fontSize: 14, margin: "14px 0 0" }}>
            Business address
          </h3>
          <PlaceFields prefix="biz" label="Business" place={biz} set={setBiz} catalog={catalog} errors={errors} />
          <h3 className="field full" style={{ fontSize: 14, margin: "14px 0 0" }}>
            Pickup location
          </h3>
          <label className="full" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8, fontSize: 13, gridColumn: "1 / -1" }}>
            <input type="checkbox" checked={same} onChange={e => setSame(e.target.checked)} /> Pickup from the business address
          </label>
          {same ? null : <PlaceFields prefix="pu" label="Pickup" place={pu} set={setPu} catalog={catalog} errors={errors} />}
          <label className="field">
            <span>Pickup contact person</span>
            <input className="input" maxLength={120} value={p.contact} onChange={e => setP({ ...p, contact: e.target.value })} aria-invalid={errors.pContact ? true : undefined} />
            {err("pContact")}
          </label>
          <label className="field">
            <span>Pickup contact phone</span>
            <div className="phone-input">
              <span>+880</span>
              <input className="input" inputMode="tel" value={p.phone} onChange={e => setP({ ...p, phone: e.target.value })} aria-invalid={errors.pPhone ? true : undefined} />
            </div>
            {err("pPhone")}
          </label>
          <label className="field">
            <span>Preferred pickup time</span>
            <Select className="select" searchable={false} value={p.time} onChange={e => setP({ ...p, time: e.target.value })} aria-invalid={errors.pTime ? true : undefined}>
              <option value="" hidden>
                Choose a time
              </option>
              {Object.entries(TIMES).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            {err("pTime")}
          </label>
          <label className="field">
            <span>How you hand over parcels</span>
            <Select className="select" searchable={false} value={p.handover} onChange={e => setP({ ...p, handover: e.target.value })}>
              {Object.entries(HANDOVER).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
          <div className="field full faint" style={{ fontSize: 13 }}>
            {hubQ.data ? (
              hubQ.data.hub ? (
                <span>
                  Serving hub: <strong>{hubQ.data.hub.name}</strong> ({hubQ.data.hub.code}) · {hubQ.data.hub.address}
                  {p.handover === "HUB_DROP" ? " — bring your parcels here." : ""}
                </span>
              ) : (
                <span style={{ color: "#b45309" }}>No hub serves {active.zone} yet. Operations will assign one.</span>
              )
            ) : hubQ.isError ? (
              describe(hubQ.error)
            ) : null}
          </div>
        </div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>
          Save changes
        </button>
      </div>
    </form>
  );
}

interface AddressRequest {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  decidedAt?: string | null;
  note?: string | null;
  hubChanges?: boolean;
  proposed?: { pickup?: string };
  previousHub?: { name: string } | null;
  proposedHub?: { name: string } | null;
}

/** District › thana / upazila › area (or "Other"), street and a map pin (merchant-address.js placeHtml / wire). */
function PlaceFields({ prefix, label, place, set, catalog, errors }: { prefix: string; label: string; place: Place; set: (p: Place) => void; catalog: Catalog | undefined; errors: Record<string, string> }) {
  const zones = catalog?.zonesByDistrict?.[place.district] ?? [];
  const areas = catalog?.areasByZone?.[place.zone] ?? [];
  const [map, setMap] = useState(false);
  const err = (k: string) => (errors[`${prefix}${k}`] ? <span className="error">{errors[`${prefix}${k}`]}</span> : null);
  return (
    <>
      <label className="field">
        <span>{label} district</span>
        <SearchSelect label="districts" value={place.district} onChange={v => set({ ...place, district: v, zone: "", area: "" })} placeholder="Choose district" invalid={!!errors[`${prefix}District`]} options={(catalog?.districts ?? []).map(v => ({ value: v, label: v }))} />
        {err("District")}
      </label>
      <label className="field">
        <span>{label} thana / upazila</span>
        <SearchSelect label="thanas" value={place.zone} onChange={v => set({ ...place, zone: v, area: "" })} placeholder={place.district ? "Choose thana / upazila" : "Choose a district first"} disabled={!place.district} invalid={!!errors[`${prefix}Zone`]} options={zones.map(v => ({ value: v, label: v }))} />
        {err("Zone")}
      </label>
      <label className="field">
        <span>{label} area</span>
        <SearchSelect
          label="areas"
          value={place.area}
          onChange={v => set({ ...place, area: v })}
          placeholder={!place.zone ? "Choose the thana first" : areas.length ? "Choose area" : "No areas listed (optional)"}
          disabled={!place.zone}
          invalid={!!errors[`${prefix}Area`]}
          options={[...areas.map(v => ({ value: v, label: v })), { value: OTHER, label: "Other (type the area)" }]}
        />
        {err("Area")}
      </label>
      {place.area === OTHER ? (
        <label className="field">
          <span>Area name</span>
          <input className="input" maxLength={80} placeholder="e.g. Shahjadpur Lane 3" value={place.other} onChange={e => set({ ...place, other: e.target.value })} aria-invalid={errors[`${prefix}Other`] ? true : undefined} />
          {err("Other")}
        </label>
      ) : null}
      <label className="field full">
        <span>Street address (house, road, flat)</span>
        <input className="input" maxLength={300} placeholder="House 12, Road 7, Flat 3B" value={place.street} onChange={e => set({ ...place, street: e.target.value })} aria-invalid={errors[`${prefix}Street`] ? true : undefined} />
        {err("Street")}
      </label>
      <div className="field full">
        <span>Map pin (optional)</span>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="faint" style={{ fontSize: 13 }}>
            {place.pin ? `${place.pin.lat.toFixed(5)}, ${place.pin.lng.toFixed(5)}` : "No pin"}
          </span>
          <Button size="sm" onClick={() => setMap(true)}>
            Set on map
          </Button>
          {place.pin ? (
            <Button size="sm" onClick={() => (set({ ...place, pin: null }), setMap(false))}>
              Remove pin
            </Button>
          ) : null}
        </div>
        {map ? <PinMap pin={place.pin} onPick={pin => set({ ...place, pin })} /> : null}
      </div>
    </>
  );
}

/** A small OpenStreetMap map: click or drag the marker to set the pin. */
function PinMap({ pin, onPick }: { pin: { lat: number; lng: number } | null; onPick: (p: { lat: number; lng: number }) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    if (!box.current) return;
    const start = pin || { lat: 23.7808, lng: 90.4093 };
    const map = L.map(box.current, { scrollWheelZoom: false }).setView([start.lat, start.lng], pin ? 16 : 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    const icon = L.icon({ iconUrl: "/vendor/leaflet/images/marker-icon.png", iconRetinaUrl: "/vendor/leaflet/images/marker-icon-2x.png", shadowUrl: "/vendor/leaflet/images/marker-shadow.png", iconSize: [25, 41], iconAnchor: [12, 41] });
    const marker = L.marker([start.lat, start.lng], { draggable: true, icon }).addTo(map);
    const set = ({ lat, lng }: { lat: number; lng: number }) => pick.current({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 });
    marker.on("dragend", () => set(marker.getLatLng()));
    map.on("click", e => (marker.setLatLng(e.latlng), set(e.latlng)));
    return () => void map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={box} style={{ height: 220, marginTop: 8, borderRadius: 10, border: "1px solid var(--line)" }} />;
}

// ───────────── Team ─────────────

interface Member {
  id: string;
  userId: string;
  name: string;
  phone: string;
  email?: string | null;
  role: string;
  lastLoginAt?: string | null;
}

function Team({ close }: { close: () => void }) {
  const m = useMerchant();
  const { user } = useAuth();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["m", "members"], queryFn: () => api<{ items: Member[] }>(`/merchants/me/members?limit=100${m.q("&")}`).then(r => r.items) });
  const [f, setF] = useState({ name: "", phone: "", role: "MERCHANT_STAFF" });
  const [busy, setBusy] = useState(false);
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (f.name.trim().length < 2) return toast("Enter the member's name.");
    const ph = bdPhoneProblem(f.phone);
    if (ph) return toast(ph, "bad");
    setBusy(true);
    try {
      const r = await api<{ invited: boolean; member: { name: string } }>(`/merchants/me/members${m.q()}`, { method: "POST", body: { name: f.name.trim(), phone: f.phone.trim(), role: f.role } });
      toast(r.invited ? `${r.member.name} was invited by SMS.` : `${r.member.name} was added to the team.`, "good");
      setF({ name: "", phone: "", role: "MERCHANT_STAFF" });
      void qc.invalidateQueries({ queryKey: ["m", "members"] });
    } catch (err) {
      toast(describe(err), "bad");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={invite} noValidate>
      <div className="dialog-head">
        <div>
          <h2>Team & permissions</h2>
          <p>Owners manage billing, API keys and the team. Staff create and track orders.</p>
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
                <th>Member</th>
                <th>Role</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(members.data ?? []).map(x => (
                <tr key={x.id}>
                  <td>
                    <div className="strong">{x.name}</div>
                    <div className="sub">
                      {phoneText(x.phone)}
                      {x.email ? ` · ${x.email}` : ""}
                    </div>
                  </td>
                  <td>{x.role === "MERCHANT_OWNER" ? "Owner" : "Staff"}</td>
                  <td className="nowrap">{x.lastLoginAt ? when(x.lastLoginAt) : "Not yet"}</td>
                  <td>
                    {x.userId === user?.id ? (
                      <small>You</small>
                    ) : (
                      <Button
                        size="sm"
                        onClick={async () => {
                          if (!(await confirm({ title: `Remove ${x.name}?`, message: `They lose access to ${m.merchant.name} and are signed out right away.`, ok: "Remove member", danger: true }))) return;
                          try {
                            await api(`/merchants/me/members/${x.id}${m.q()}`, { method: "DELETE" });
                            toast(`${x.name} was removed.`);
                          } catch (e) {
                            toast(describe(e), "bad");
                          }
                          void qc.invalidateQueries({ queryKey: ["m", "members"] });
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {members.data && !members.data.length ? (
                <tr>
                  <td colSpan={4} className="empty-cell">
                    No members.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <label className="field">
            <span>Name</span>
            <input className="input" maxLength={120} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Mobile number</span>
            <input className="input" inputMode="tel" placeholder="01XXX-XXXXXX" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} />
          </label>
          <label className="field">
            <span>Role</span>
            <Select className="select" searchable={false} value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>
              <option value="MERCHANT_STAFF">Staff</option>
              <option value="MERCHANT_OWNER">Owner</option>
            </Select>
          </label>
        </div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" onClick={close}>
          Close
        </button>
        <button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>
          Invite member
        </button>
      </div>
    </form>
  );
}

// ───────────── Business verification ─────────────

interface KycView {
  status: string;
  rejectionReason?: string | null;
  canUpload: boolean;
  canSubmit: boolean;
  policy: { documentTypes: { type: string; label: string; required: boolean }[]; requireForApiKeys?: boolean; requireForCodPayouts?: boolean; requireForActivation?: boolean };
  documents: { id: string; type: string; filename: string; uploadedAt: string }[];
  history: { at: string; body: string }[];
}

function Kyc({ close }: { close: () => void }) {
  const m = useMerchant();
  const kyc = useQuery({ queryKey: ["m", "kyc"], queryFn: () => api<KycView>(`/merchants/me/kyc${m.q()}`) });
  const [busy, setBusy] = useState("");
  const k = kyc.data;
  async function upload(type: string, file?: File | null) {
    if (!file) return;
    if (file.size > 3.5 * 1024 * 1024) return toast("That file is larger than 3.5 MB. Use a smaller scan or photo.", "bad");
    setBusy(type);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("The file couldn't be read."));
        reader.readAsDataURL(file);
      });
      await api(`/merchants/me/kyc/documents${m.q()}`, { method: "POST", body: { type, filename: file.name.slice(0, 120), file: data } });
      toast(`${file.name} uploaded.`, "good");
      void kyc.refetch();
    } catch (e) {
      toast(describe(e), "bad");
    } finally {
      setBusy("");
    }
  }
  async function view(id: string) {
    try {
      const d = await api<{ filename: string; mimeType?: string; dataUrl: string }>(`/merchants/me/kyc/documents/${id}${m.q()}`);
      const w = window.open("", "_blank");
      if (!w) return toast("Allow pop-ups to view the document.");
      w.document.title = d.filename;
      w.document.body.style.margin = "0";
      w.document.body.innerHTML = d.mimeType === "application/pdf" || /^data:application\/pdf/.test(d.dataUrl) ? `<iframe src="${d.dataUrl}" style="border:0;width:100%;height:100vh"></iframe>` : `<img src="${d.dataUrl}" style="max-width:100%">`;
    } catch (e) {
      toast(describe(e), "bad");
    }
  }
  const needs = k ? [k.policy.requireForApiKeys && "API keys", k.policy.requireForCodPayouts && "COD payouts", k.policy.requireForActivation && "account approval"].filter(Boolean) : [];
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>Business verification</h2>
          <p>
            {k ? <Pill>{KYC_STATUS[k.status] || k.status}</Pill> : null} {needs.length ? `· Needed for ${needs.join(", ")}` : ""}
          </p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        {kyc.isError ? <div className="callout bad">{describe(kyc.error)}</div> : null}
        {k?.status === "REJECTED" && k.rejectionReason ? <p style={{ color: "#b42318", margin: "0 0 10px" }}>Not approved: {k.rejectionReason}. Replace the documents and submit again.</p> : null}
        {k?.status === "PENDING" ? <p className="faint" style={{ margin: "0 0 10px" }}>Your documents are being reviewed. We'll text {String(m.merchant.contactPhone ?? "")} with the result.</p> : null}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Document</th>
                <th>File</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(k?.policy.documentTypes ?? []).map(t => {
                const d = k!.documents.find(x => x.type === t.type);
                return (
                  <tr key={t.type}>
                    <td>
                      <strong>{t.label}</strong>
                      {t.required ? null : <small> (optional)</small>}
                    </td>
                    <td>
                      {d ? (
                        <>
                          {d.filename}
                          <div className="sub">{dateOnly(d.uploadedAt)}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{d ? <Pill tone="good">Uploaded</Pill> : <Pill tone={t.required ? "warn" : undefined}>{t.required ? "Missing" : "Optional"}</Pill>}</td>
                    <td className="nowrap">
                      {m.isOwner && k!.canUpload ? (
                        <label className={`button sm${busy === t.type ? " is-busy" : ""}`} style={{ cursor: "pointer" }}>
                          {busy === t.type ? "Uploading…" : d ? "Replace" : "Upload"}
                          <input type="file" hidden accept="image/png,image/jpeg,image/webp,application/pdf" onChange={e => (void upload(t.type, e.target.files?.[0]), (e.target.value = ""))} />
                        </label>
                      ) : null}{" "}
                      {d && m.isOwner ? (
                        <Button size="sm" onClick={() => view(d.id)}>
                          View
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {kyc.isLoading ? (
                <tr>
                  <td colSpan={4} className="empty-cell">
                    Loading…
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {k?.history.length ? (
          <>
            <h3 style={{ fontSize: 13, margin: "14px 0 6px" }}>History</h3>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
              {k.history.map((h, i) => (
                <li key={i}>
                  {when(h.at)} · {h.body}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {m.isOwner ? null : <p className="faint">Only workspace owners can upload documents.</p>}
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" onClick={close}>
          Close
        </button>
        {m.isOwner && k?.canSubmit ? (
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api(`/merchants/me/kyc/submit${m.q()}`, { method: "POST" });
                await m.reload();
                void kyc.refetch();
                toast("Documents submitted for review.", "good");
              } catch (e) {
                toast(describe(e), "bad");
              }
            }}
          >
            Submit for review
          </Button>
        ) : null}
      </div>
    </>
  );
}

// ───────────── Notification settings ─────────────

interface Prefs {
  events: { event: string; label: string; group: string; channels: Record<string, { enabled: boolean; locked?: boolean; available?: boolean }> }[];
}

async function openNotifications(contactPhone: string) {
  let prefs: Prefs;
  try {
    prefs = await api<Prefs>("/me/notification-preferences");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return toast(`Delivery SMS go to ${contactPhone}. Change the contact phone in the profile.`);
    return toast(describe(e), "bad");
  }
  await openCustom(close => <PrefsForm prefs={prefs} close={() => close()} />, "wide");
}

function PrefsForm({ prefs, close }: { prefs: Prefs; close: () => void }) {
  const channels = [...new Set(prefs.events.flatMap(e => Object.keys(e.channels)))];
  const [on, setOn] = useState(() => new Map(prefs.events.flatMap(e => Object.entries(e.channels).map(([c, ch]) => [`${e.event}|${c}`, ch.enabled] as [string, boolean]))));
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const preferences = prefs.events.flatMap(ev => Object.entries(ev.channels).filter(([, ch]) => !ch.locked && ch.available !== false).map(([c]) => ({ event: ev.event, channel: c, enabled: !!on.get(`${ev.event}|${c}`) })));
    setBusy(true);
    try {
      await api("/me/notification-preferences", { method: "PUT", body: { preferences } });
      toast("Notification settings saved.", "good");
      close();
    } catch (err) {
      toast(describe(err), "bad");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save}>
      <div className="dialog-head">
        <div>
          <h2>Notification settings</h2>
          <p>Choose the messages you receive. Security messages are always sent.</p>
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
                <th>Message</th>
                {channels.map(c => (
                  <th key={c}>{c.toUpperCase()}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prefs.events.map(ev => (
                <tr key={ev.event}>
                  <td>
                    <div className="strong">{ev.label}</div>
                    <div className="sub">{ev.group}</div>
                  </td>
                  {channels.map(c => {
                    const ch = ev.channels[c];
                    if (!ch) return <td key={c}>—</td>;
                    const k = `${ev.event}|${c}`;
                    return (
                      <td key={c}>
                        <input
                          type="checkbox"
                          aria-label={`${ev.label} · ${c}`}
                          checked={!!on.get(k)}
                          disabled={ch.locked || ch.available === false}
                          title={ch.locked ? "Security messages can't be switched off" : ch.available === false ? "Not offered by Delivery Fast" : ""}
                          onChange={e => setOn(prev => new Map(prev).set(k, e.target.checked))}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!prefs.events.length ? (
                <tr>
                  <td colSpan={channels.length + 1} className="empty-cell">
                    No messages to configure.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}

// ───────────── Payout account (E-commerce) ─────────────

function Payout({ close }: { close: () => void }) {
  const m = useMerchant();
  const qc = useQueryClient();
  const p = ((m.merchant as M).payoutAccount || {}) as { method?: string; accountNumber?: string; accountName?: string; bankName?: string; branch?: string; routingNumber?: string };
  const [v, setV] = useState({ method: p.method || "BKASH", number: p.accountNumber || "", name: p.accountName || "", bank: p.bankName || "", branch: p.branch || "", routing: p.routingNumber || "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v, value: string) => setV(x => ({ ...x, [k]: value }));
  const bank = v.method === "BANK";
  async function save(payoutAccount: Record<string, unknown> | null, done: string) {
    setBusy(true);
    try {
      await api(`/merchants/me${m.q()}`, { method: "PATCH", body: { payoutAccount } });
      await m.reload();
      void qc.invalidateQueries({ queryKey: ["m"] });
      toast(done, "good");
      close();
    } catch (e) {
      toast(describe(e), "bad");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (!v.number.trim()) return toast("Enter the account or wallet number.", "bad");
        if (v.name.trim().length < 2) return toast("Enter the account name.", "bad");
        void save(
          { method: v.method, accountNumber: v.number.trim(), accountName: v.name.trim(), ...(bank ? { bankName: v.bank.trim(), branch: v.branch.trim() || undefined, routingNumber: v.routing.trim() || undefined } : {}) },
          "Payout account saved. We've texted your contact phone about the change.",
        );
      }}
      noValidate
    >
      <div className="dialog-head">
        <div>
          <h2>Payout account</h2>
          <p>Where your COD settlements are paid. We text your contact phone whenever it changes.</p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        <div className="form-grid">
          <label className="field">
            <span>Method</span>
            <Select className="select" searchable={false} value={v.method} onChange={e => set("method", e.target.value)}>
              {Object.entries(PAYOUT_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span>Account / wallet number</span>
            <input className="input" value={v.number} onChange={e => set("number", e.target.value)} />
          </label>
          <label className="field">
            <span>Account name</span>
            <input className="input" value={v.name} onChange={e => set("name", e.target.value)} />
          </label>
          {bank ? (
            <>
              <label className="field">
                <span>Bank name</span>
                <input className="input" value={v.bank} onChange={e => set("bank", e.target.value)} />
              </label>
              <label className="field">
                <span>Branch (optional)</span>
                <input className="input" value={v.branch} onChange={e => set("branch", e.target.value)} />
              </label>
              <label className="field">
                <span>Routing number (optional)</span>
                <input className="input" inputMode="numeric" maxLength={11} placeholder="9 digits, e.g. 225261725" value={v.routing} onChange={e => set("routing", e.target.value)} />
              </label>
            </>
          ) : null}
        </div>
      </div>
      <div className="dialog-foot">
        {(m.merchant as M).payoutAccount ? (
          <button type="button" className="button" style={{ marginRight: "auto" }} disabled={busy} onClick={async () => {
              if (await confirm({ title: "Remove the payout account?", message: "COD settlements can't be paid until you add one.", ok: "Remove account", danger: true })) void save(null, "Payout account removed.");
            }}>
            Remove
          </button>
        ) : null}
        <button type="button" className="button" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>
          Save payout account
        </button>
      </div>
    </form>
  );
}
