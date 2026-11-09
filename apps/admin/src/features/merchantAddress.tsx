/**
 * Super admin: a merchant's addresses, pickup and serving hub (PATCH /merchants/:id). Business address, pickup address
 * (or "same as business"), pickup contact, pickup time, handover, and the hub: Automatic (the hub serving the pickup
 * zone, as before) or a hub chosen here, which then stays when the address or the network changes. Imports and
 * bookings use the merchant's hub (Excel import preselects it as the drop-off hub).
 */
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { localPhone } from "@panel/lib/format";
import { Button, Loading } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { openCustom } from "@panel/ui/dialogs";
import { toast } from "@panel/ui/toast";
import { queryClient } from "@panel/lib/queryClient";
import { bdPhoneProblem, normalizeBdPhone } from "@delivery-fast/shared/dist/phone.js";
import { DialogFrame, useCatalog, useHubs, type Catalog, type Merchant, type Place } from "@/lib/admin";

const OTHER = "__other__";
const TIMES: [string, string][] = [
  ["MORNING", "Morning (9am–12pm)"],
  ["MIDDAY", "Midday (12pm–3pm)"],
  ["AFTERNOON", "Afternoon (3pm–6pm)"],
];
const HANDOVER: [string, string][] = [
  ["RIDER_PICKUP", "Rider pickup"],
  ["HUB_DROP", "Drop at hub"],
];

interface PlaceDraft {
  district: string;
  zone: string;
  area: string;
  otherArea: string;
  street: string;
}
const draftOf = (p?: Place | null): PlaceDraft => ({
  district: p?.district ?? "",
  zone: p?.zone ?? "",
  area: p?.areaOther ? OTHER : (p?.area ?? ""),
  otherArea: p?.areaOther ? (p?.area ?? "") : "",
  street: p?.street ?? "",
});
/** The API's place, or the problem with it. */
function placeBody(d: PlaceDraft, catalog: Catalog, label: string): { body?: Record<string, string>; problem?: string } {
  if (!d.district) return { problem: `Choose the ${label} district.` };
  if (!d.zone) return { problem: `Choose the ${label} zone (thana / upazila).` };
  const areas = catalog.areasByZone?.[d.zone] ?? [];
  if (d.area === OTHER && d.otherArea.trim().length < 2) return { problem: `Type the ${label} area name.` };
  if (areas.length && !d.area) return { problem: `Choose the ${label} area.` };
  if (d.street.trim().length < 5) return { problem: `Enter the ${label} street address (at least 5 characters).` };
  return { body: { district: d.district, zone: d.zone, ...(d.area === OTHER ? { otherArea: d.otherArea.trim() } : d.area ? { area: d.area } : {}), street: d.street.trim() } };
}

export const editMerchantAddress = (m: Merchant) => openCustom(close => <AddressEditor m={m} close={() => close()} />, "wide");

function AddressEditor({ m, close }: { m: Merchant; close: () => void }) {
  const catalog = useCatalog();
  const hubs = useHubs();
  const [business, setBusiness] = useState<PlaceDraft>(() => draftOf(m.business));
  const [same, setSame] = useState(!!m.pickupSameAsBusiness && !!m.business);
  const [pickup, setPickup] = useState<PlaceDraft>(() => draftOf(m.pickup));
  const [contactName, setContactName] = useState(m.pickupContactName || m.contactName || "");
  const [contactPhone, setContactPhone] = useState(localPhone(m.pickupContactPhone || m.contactPhone || ""));
  const [time, setTime] = useState(m.pickupTime || "MIDDAY");
  const [handover, setHandover] = useState(m.handover || "RIDER_PICKUP");
  const [hub, setHub] = useState(m.pickupHubFixed && m.pickupHub ? m.pickupHub.id : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The addresses as opened: only what was changed is sent (changing just the hub or the contact needs no address).
  const [start] = useState(() => JSON.stringify([draftOf(m.business), !!m.pickupSameAsBusiness && !!m.business, draftOf(m.pickup)]));

  // What "Automatic" gives: the hub serving the pickup zone.
  const where = same ? business : pickup;
  const auto = useQuery({
    queryKey: ["admin", "pickup-hub", where.district, where.zone],
    enabled: !!where.district && !!where.zone,
    queryFn: () => api<{ hub: { id: string; name: string } | null }>(`/merchants/pickup-hub?district=${encodeURIComponent(where.district)}&zone=${encodeURIComponent(where.zone)}`),
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    const c = catalog.data;
    if (!c) return;
    const addressChanged = JSON.stringify([business, same, pickup]) !== start;
    const b = addressChanged ? placeBody(business, c, "business") : null;
    if (b?.problem) return setError(b.problem);
    const p = addressChanged && !same ? placeBody(pickup, c, "pickup") : null;
    if (p?.problem) return setError(p.problem);
    if (contactName.trim().length < 2) return setError("Enter the pickup contact's name.");
    const phoneProblem = bdPhoneProblem(contactPhone);
    if (phoneProblem) return setError(`Pickup contact phone: ${phoneProblem}`);
    setError("");
    const wasFixed = !!m.pickupHubFixed;
    const body: Record<string, unknown> = {
      ...(addressChanged ? { business: b?.body, pickupSameAsBusiness: same, ...(p?.body ? { pickup: p.body } : {}) } : {}),
      pickupContactName: contactName.trim(),
      pickupContactPhone: normalizeBdPhone(contactPhone),
      pickupTime: time,
      handover,
      // A chosen hub is fixed; back to Automatic only when it was fixed before.
      ...(hub ? (hub !== m.pickupHub?.id || !wasFixed ? { pickupHubId: hub } : {}) : wasFixed ? { pickupHubId: null } : {}),
    };
    setBusy(true);
    try {
      const saved = await api<Merchant>(`/merchants/${m.id}`, { method: "PATCH", body });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "merchants"] }), queryClient.invalidateQueries({ queryKey: ["admin", "audit"] })]);
      close();
      toast(`${m.name}: addresses saved. Hub: ${saved.pickupHub ? `${saved.pickupHub.name}${saved.pickupHubFixed ? " (chosen)" : ""}` : "none yet"}.`, "good");
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  const c = catalog.data;
  const placeFields = (label: string, d: PlaceDraft, set: (d: PlaceDraft) => void) => {
    const zones = c?.zonesByDistrict?.[d.district] ?? [];
    const areas = c?.areasByZone?.[d.zone] ?? [];
    return (
      <>
        <label className="field">
          <span>{label} district</span>
          <Select className="select" value={d.district} onChange={e => set({ ...d, district: e.target.value, zone: "", area: "", otherArea: "" })}>
            <option value="">Choose the district</option>
            {(c?.districts ?? []).map(x => (
              <option key={x}>{x}</option>
            ))}
          </Select>
        </label>
        <label className="field">
          <span>{label} thana / upazila</span>
          <Select className="select" value={d.zone} onChange={e => set({ ...d, zone: e.target.value, area: "", otherArea: "" })}>
            <option value="">Choose the zone</option>
            {zones.map(x => (
              <option key={x}>{x}</option>
            ))}
          </Select>
        </label>
        <label className="field">
          <span>{label} area</span>
          <Select className="select" value={d.area} onChange={e => set({ ...d, area: e.target.value })}>
            <option value="">{areas.length ? "Choose the area" : "No areas listed"}</option>
            {areas.map(x => (
              <option key={x}>{x}</option>
            ))}
            <option value={OTHER}>Other (type it)</option>
          </Select>
        </label>
        {d.area === OTHER ? (
          <label className="field">
            <span>Area name</span>
            <input className="input" maxLength={80} placeholder="e.g. Shahjadpur Lane 3" value={d.otherArea} onChange={e => set({ ...d, otherArea: e.target.value })} />
          </label>
        ) : (
          <span />
        )}
        <label className="field full">
          <span>{label} street address (house, road, flat)</span>
          <input className="input" maxLength={300} placeholder="House 12, Road 7, Flat 3B" value={d.street} onChange={e => set({ ...d, street: e.target.value })} />
        </label>
      </>
    );
  };
  const activeHubs = (hubs.data ?? []).filter(h => h.active || h.id === m.pickupHub?.id);
  return (
    <form onSubmit={e => void save(e)} noValidate>
      <DialogFrame
        title={`Addresses, pickup and serving hub · ${m.name}`}
        subtitle={`${m.code}. Saved at once; the merchant sees the new details in their panel.`}
        close={close}
        foot={
          <>
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !c}>
              {busy ? "Saving…" : "Save addresses"}
            </Button>
          </>
        }
      >
        {!c ? (
          <Loading rows={4} />
        ) : (
          <div className="form-grid">
            <h3 className="full" style={{ fontSize: 14, margin: "0" }}>
              Business address
            </h3>
            {placeFields("Business", business, setBusiness)}
            <h3 className="full" style={{ fontSize: 14, margin: "10px 0 0" }}>
              Pickup
            </h3>
            <label className="check full">
              <input type="checkbox" checked={same} onChange={e => setSame(e.target.checked)} /> Pickup is the business address
            </label>
            {same ? null : placeFields("Pickup", pickup, setPickup)}
            <label className="field">
              <span>Pickup contact name</span>
              <input className="input" maxLength={120} value={contactName} onChange={e => setContactName(e.target.value)} />
            </label>
            <label className="field">
              <span>Pickup contact phone</span>
              <input className="input" inputMode="tel" placeholder="01XXXXXXXXX" value={contactPhone} onChange={e => setContactPhone(e.target.value)} />
            </label>
            <label className="field">
              <span>Pickup time</span>
              <Select className="select" value={time} onChange={e => setTime(e.target.value)}>
                {TIMES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span>Handover</span>
              <Select className="select" value={handover} onChange={e => setHandover(e.target.value)}>
                {HANDOVER.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
            <h3 className="full" style={{ fontSize: 14, margin: "10px 0 0" }}>
              Serving hub
            </h3>
            <label className="field full">
              <span>Hub</span>
              <Select className="select" value={hub} onChange={e => setHub(e.target.value)}>
                <option value="">{`Automatic: the hub serving the pickup zone${auto.data ? ` (${auto.data.hub?.name ?? "none yet"})` : ""}`}</option>
                {activeHubs.map(h => (
                  <option key={h.id} value={h.id}>
                    {`${h.name} · ${h.code}`}
                  </option>
                ))}
              </Select>
              <small>{hub ? "Chosen hub: it stays when the pickup address or the network changes. Pickups, bookings and Excel imports use it." : "Follows the pickup address (and changes to the zone's serving hub)."}</small>
            </label>
          </div>
        )}
        {error ? (
          <p role="alert" style={{ margin: "10px 0 0", color: "var(--bad)", fontSize: 13 }}>
            {error}
          </p>
        ) : null}
      </DialogFrame>
    </form>
  );
}
