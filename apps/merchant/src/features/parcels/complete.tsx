/**
 * "Needs info": complete the missing details (shared/importer.js complete, POST /parcels/:id/complete). The fields
 * still missing are marked; changing the destination, weight or service re-prices it. Services are the merchant's
 * package options (GET /packages/me).
 */
import { useState } from "react";
import { bdPhoneProblem, normalizeBdPhone } from "@delivery-fast/shared/dist/phone.js";
import { api, describe } from "@panel/lib/api";
import { localPhone, money } from "@panel/lib/format";
import { openCustom } from "@panel/ui/dialogs";
import { Select } from "@panel/ui/Select";
import { toast } from "@panel/ui/toast";
import { refreshMerchant } from "./actions";
import type { Parcel } from "./model";

export interface Catalog {
  districts: string[];
  zonesByDistrict: Record<string, string[]>;
  areasByZone?: Record<string, string[]>;
  [key: string]: unknown;
}
type Full = Parcel & { version?: number; missingLabels?: string[]; service?: { speed?: string; speedLabel?: string } };

export async function completeDetails(parcel: Parcel) {
  let catalog: Catalog;
  let p = parcel as Full;
  try {
    [catalog, p] = await Promise.all([api<Catalog>("/catalog"), api<Full>(`/parcels/${encodeURIComponent(parcel.trackingId)}`)]);
  } catch (e) {
    return toast(describe(e), "bad");
  }
  let pkg: { options?: { speeds?: string[] }; labels?: { speed?: Record<string, string> } } | null = null;
  try {
    pkg = await api("/packages/me");
  } catch {
    pkg = null; // the current service stays the only choice
  }
  const currentSpeed = p.service?.speed || "REGULAR";
  const speeds: [string, string][] = (pkg?.options?.speeds?.length ? pkg.options.speeds : [currentSpeed]).map(code => [code, pkg?.labels?.speed?.[code] || (code === currentSpeed && p.service?.speedLabel) || code]);
  if (!speeds.some(([c]) => c === currentSpeed)) speeds.unshift([currentSpeed, p.service?.speedLabel || currentSpeed]);
  // Banking & Financial requests have no weight to complete (the classic form left it out for them).
  const banking = true;
  await openCustom(close => <CompleteForm p={p} catalog={catalog} speeds={speeds} currentSpeed={currentSpeed} banking={banking} close={close} />, "wide");
}

const MISSING: Record<string, string> = { name: "recipientName", phone: "recipientPhone", street: "address", district: "district", zone: "zone" };

function CompleteForm({ p, catalog, speeds, currentSpeed, banking, close }: { p: Full; catalog: Catalog; speeds: [string, string][]; currentSpeed: string; banking: boolean; close: () => void }) {
  const [v, setV] = useState({
    name: p.recipient.name || "",
    phone: localPhone(p.recipient.phone || "").replace(/^0/, ""),
    street: p.delivery.street || "",
    area: p.delivery.area || "",
    district: p.delivery.district || "",
    zone: p.delivery.zone || "",
    weight: p.weightKg != null ? String(p.weightKg) : "",
    speed: currentSpeed,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const set = (k: keyof typeof v, value: string) => setV(x => ({ ...x, [k]: value, ...(k === "district" ? { zone: "" } : {}) }));
  const missing = (k: string) => (p.missingFields || []).includes(MISSING[k]);
  const label = (k: string, text: string) => (
    <span>
      {text}
      {missing(k) ? <span style={{ color: "var(--warn)", fontWeight: 600 }}> · needed before delivery</span> : null}
    </span>
  );
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (v.phone.trim()) found.phone = bdPhoneProblem(v.phone) ?? "";
    if (!banking && v.weight !== "" && !(Number(v.weight) > 0 && Number(v.weight) <= 50)) found.weight = "Enter a weight from 0.01 to 50 kg";
    if (v.district && !v.zone) found.zone = "Choose the zone";
    Object.keys(found).forEach(k => !found[k] && delete found[k]);
    setErrors(found);
    if (Object.keys(found).length) return;
    const body: Record<string, unknown> = {};
    const recipient: Record<string, string> = {};
    if (v.name.trim() && v.name.trim() !== (p.recipient.name || "")) recipient.name = v.name.trim();
    const phone = v.phone.trim() ? normalizeBdPhone(v.phone) : null;
    if (phone && phone !== p.recipient.phone) recipient.phone = phone;
    if (Object.keys(recipient).length) body.recipient = recipient;
    const delivery: Record<string, string> = {};
    if (v.street.trim() && v.street.trim() !== (p.delivery.street || "")) delivery.street = v.street.trim();
    if (v.area.trim() !== (p.delivery.area || "")) delivery.area = v.area.trim();
    if (v.district && v.district !== (p.delivery.district || "")) delivery.district = v.district;
    if (v.zone && v.zone !== (p.delivery.zone || "")) delivery.zone = v.zone;
    if (Object.keys(delivery).length) body.delivery = delivery;
    if (!banking && v.weight && Number(v.weight) !== Number(p.weightKg)) body.weightKg = Number(v.weight);
    if (v.speed && v.speed !== currentSpeed) body.speed = v.speed;
    if (!Object.keys(body).length) return toast("Nothing changed.");
    body.expectedVersion = p.version;
    setBusy(true);
    setFormError("");
    try {
      const updated = await api<Full>(`/parcels/${encodeURIComponent(p.trackingId)}/complete`, { method: "POST", body });
      refreshMerchant();
      toast(updated.incomplete ? `${updated.trackingId} updated. Still needed: ${(updated.missingLabels || []).join(", ")}.` : `${updated.trackingId} is complete · charge ${money(updated.charges.total)}. It can now be assigned for delivery.`, "good");
      close();
    } catch (err) {
      setFormError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  const zones = catalog.zonesByDistrict?.[v.district] || [];
  return (
    <form onSubmit={submit} noValidate>
      <div className="dialog-head">
        <div>
          <h2>Complete order · {p.trackingId}</h2>
          <p>
            <span className="pill warn">Needs info</span> current charge {money(p.charges?.total)}
          </p>
        </div>
      </div>
      <div className="dialog-body">
        <p className="muted" style={{ marginTop: 0 }}>
          {p.missingLabels?.length ? (
            <>
              Missing: <strong>{p.missingLabels.join(", ")}</strong>.{" "}
            </>
          ) : null}
          The order can't be assigned to a delivery rider until the recipient's name, phone, address, district and zone are all known. Changing the destination, weight or service re-prices it.
        </p>
        <div className="form-grid">
          <label className="field">
            {label("name", "Recipient name")}
            <input className="input" maxLength={120} value={v.name} onChange={e => set("name", e.target.value)} />
          </label>
          <label className="field">
            {label("phone", "Recipient phone")}
            <div className="phone-input">
              <span>+880</span>
              <input className="input" inputMode="tel" value={v.phone} onChange={e => set("phone", e.target.value)} aria-invalid={errors.phone ? true : undefined} />
            </div>
            {errors.phone ? <span className="error">{errors.phone}</span> : null}
          </label>
          <label className="field">
            {label("street", "Delivery address")}
            <input className="input" maxLength={200} value={v.street} onChange={e => set("street", e.target.value)} />
          </label>
          <label className="field">
            <span>Area / landmark</span>
            <input className="input" maxLength={120} value={v.area} onChange={e => set("area", e.target.value)} />
          </label>
          <label className="field">
            {label("district", "District")}
            <Select className="select" value={v.district} onChange={e => set("district", e.target.value)}>
              <option value="">Choose</option>
              {(catalog.districts || []).map(d => (
                <option key={d}>{d}</option>
              ))}
            </Select>
          </label>
          <label className="field">
            {label("zone", "Zone")}
            <Select className="select" value={v.zone} onChange={e => set("zone", e.target.value)} aria-invalid={errors.zone ? true : undefined}>
              <option value="">Choose</option>
              {zones.map(z => (
                <option key={z}>{z}</option>
              ))}
            </Select>
            {errors.zone ? <span className="error">{errors.zone}</span> : null}
          </label>
          {banking ? null : (
            <label className="field">
              <span>Weight (kg)</span>
              <input className="input" type="number" min={0.01} max={50} step={0.01} value={v.weight} onChange={e => set("weight", e.target.value)} aria-invalid={errors.weight ? true : undefined} />
              {errors.weight ? <span className="error">{errors.weight}</span> : null}
            </label>
          )}
          {speeds.length > 1 ? (
            <label className="field">
              <span>Service</span>
              <Select className="select" value={v.speed} onChange={e => set("speed", e.target.value)}>
                {speeds.map(([code, l]) => (
                  <option key={code} value={code}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
        </div>
        {formError ? <div className="form-error">{formError}</div> : null}
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button primary" aria-busy={busy || undefined} disabled={busy}>
          Save details
        </button>
      </div>
    </form>
  );
}
