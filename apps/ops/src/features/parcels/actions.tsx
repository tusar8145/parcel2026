/**
 * Parcel actions, one function each, same API calls and wording as the legacy panel:
 * assign (bridge.js), resolve exception, edit details / complete "Needs info" (shared/importer.js complete),
 * cancel a request, switch pickup ↔ drop-off (bridge-intake.js), return to sender (bridge-failed.js),
 * product type / return charge (bridge-partial.js), labels and other PDFs (shared/print.js).
 */
import { Select } from "@panel/ui/Select";
import { useState } from "react";
import { bdPhoneProblem, normalizeBdPhone } from "@delivery-fast/shared/dist/phone.js";
import { api, describe } from "@panel/lib/api";
import { localPhone, money, when } from "@panel/lib/format";
import { queryClient } from "@panel/lib/queryClient";
import type { Hub, Rider } from "@/lib/types";
import { confirm, openCustom, openForm, prompt, type FieldOption } from "@panel/ui/dialogs";
import { toast } from "@panel/ui/toast";
import { CLOSED, failureText, INTAKE_CHANGEABLE, isPickupAssignment, type Parcel } from "./model";
import type { Catalog } from "./search";

export interface ActionContext {
  hubs: Hub[];
  riders: Rider[];
  myHubIds: string[] | null;
  can: (p: "dispatch") => boolean;
  roleName: string;
}

/** After any change: counts, lists and the open drawer reload. */
export function refreshParcels(trackingId?: string) {
  void queryClient.invalidateQueries({ queryKey: ["parcels"] });
  void queryClient.invalidateQueries({ queryKey: ["ops"] });
  if (trackingId) void queryClient.invalidateQueries({ queryKey: ["parcel", trackingId] });
  else void queryClient.invalidateQueries({ queryKey: ["parcel"] });
}
const put = (p: Parcel) => queryClient.setQueryData(["parcel", p.trackingId], p);

function denied(ctx: ActionContext, action: string) {
  if (ctx.can("dispatch")) return false;
  toast(`${ctx.roleName} accounts can't ${action}.`, "bad");
  return true;
}

/**
 * Active riders, the operator's own hub first, online before offline, with their open tasks. A franchise's riders work
 * only on its hub's parcels: they are listed only for a parcel at that hub (`forHubId`).
 */
export function riderOptions(riders: Rider[], myHubIds: string[] | null, forHubId?: string | null): FieldOption[] {
  const mine = new Set((myHubIds || []).filter(Boolean));
  const rank = (r: Rider) => (mine.size && !mine.has(r.hub?.id ?? "") ? 2 : 0) + (r.status === "ONLINE" ? 0 : 1);
  return [...riders]
    .filter(r => r.hub?.type !== "FRANCHISE" || (!!forHubId && r.hub.id === forHubId))
    .sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code))
    .map(r => {
      const state = r.status === "ONLINE" ? "" : ` (${r.status.toLowerCase().replace("_", " ")})`;
      const load = r.openTasks ? ` · ${r.openTasks} open` : "";
      const franchise = r.hub?.type === "FRANCHISE" ? ` · Franchise (${r.hub.name})` : "";
      return { value: r.id, label: `${r.code} · ${r.name} · ${r.hub?.name || r.zone || "No hub"}${load}${state}${franchise}` };
    });
}

async function freshRiders(ctx: ActionContext) {
  try {
    const riders = await api<Rider[]>("/riders?active=true");
    queryClient.setQueryData(["riders", "active"], riders);
    return riders;
  } catch {
    return ctx.riders;
  }
}

export async function assignRider(p: Parcel, ctx: ActionContext) {
  if (denied(ctx, "assign riders")) return;
  const riders = await freshRiders(ctx);
  const pickup = isPickupAssignment(p);
  // A waiting pickup can be handed to a franchise hub instead; it assigns its own rider (bridge-franchise.js).
  const franchiseHubs = p.status === "PENDING_CONFIRMATION" && p.intake !== "DROP_OFF" ? ctx.hubs.filter(h => h.type === "FRANCHISE" && h.active) : [];
  await openForm({
    title: "Assign rider",
    description: `${p.trackingId} · ${p.delivery.label}. ${pickup ? "The rider collects it from the sender." : "The rider delivers it from the hub."}`,
    submit: "Assign rider",
    fields: [
      { id: "shipment", label: "Shipment", type: "static", value: `${p.trackingId} · ${p.delivery.label}` },
      { id: "riderId", label: pickup ? "Pickup rider" : "Delivery rider", type: "select", required: !franchiseHubs.length, options: riders.length ? riderOptions(riders, ctx.myHubIds, pickup ? null : p.currentHub?.id) : [], full: true, hint: riders.length ? undefined : "No active riders.", show: v => !v.franchiseHub },
      {
        id: "priority",
        label: "Dispatch priority",
        type: "select",
        required: true,
        value: "Standard",
        options: ["Standard", "Urgent · SLA at risk", "Express document"].map(v => ({ value: v, label: v })),
        full: true,
        show: v => !v.franchiseHub,
      },
      ...(franchiseHubs.length
        ? [
            {
              id: "franchiseHub",
              label: "Or hand this pickup to a franchise hub",
              type: "select" as const,
              options: franchiseHubs.map(h => ({ value: h.id, label: `${h.name} · ${h.district}` })),
              full: true,
              hint: "The franchise assigns one of its own riders.",
            },
          ]
        : []),
    ],
    onSubmit: async v => {
      if (v.franchiseHub) {
        const hub = ctx.hubs.find(h => h.id === v.franchiseHub);
        await api(`/parcels/${encodeURIComponent(p.trackingId)}/pickup-hub`, { method: "POST", body: { hubId: v.franchiseHub } });
        refreshParcels(p.trackingId);
        return `${p.trackingId} handed to ${hub?.name || "the franchise"}; it assigns its rider.`;
      }
      const rider = riders.find(r => r.id === v.riderId);
      if (!rider) throw new Error("Choose an active rider.");
      await api(`/parcels/${encodeURIComponent(p.trackingId)}/${pickup ? "assign-pickup" : "assign-delivery"}`, {
        method: "POST",
        body: { riderId: rider.id, note: v.priority && v.priority !== "Standard" ? `Dispatch priority: ${v.priority}` : undefined },
      });
      refreshParcels(p.trackingId);
      return `${p.trackingId} assigned to ${rider.code} · ${rider.name} for ${pickup ? "pickup" : "delivery"}.`;
    },
  });
}

/** Many New orders at once: one rider, one POST /parcels/:id/assign-pickup per order, with progress and the result. */
export async function bulkAccept(parcels: Parcel[], ctx: ActionContext) {
  if (denied(ctx, "assign riders")) return false;
  const ready = parcels.filter(p => p.status === "PENDING_CONFIRMATION" && p.intake !== "DROP_OFF");
  const skipped = parcels.length - ready.length;
  if (!ready.length) {
    toast("None of the ticked orders can be accepted here: drop-offs are received at their hub.", "bad");
    return false;
  }
  const riders = await freshRiders(ctx);
  const done = await openCustom<boolean>(close => <BulkAccept ready={ready} skipped={skipped} riders={riders} ctx={ctx} close={close} />);
  return !!done;
}

function BulkAccept({ ready, skipped, riders, ctx, close }: { ready: Parcel[]; skipped: number; riders: Rider[]; ctx: ActionContext; close: (v?: boolean) => void }) {
  const [riderId, setRiderId] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ done: number; failed: { id: string; message: string }[]; rider: Rider } | null>(null);
  const [error, setError] = useState("");
  const running = progress !== null && !result;
  async function run() {
    const rider = riders.find(r => r.id === riderId);
    if (!rider) return setError("Choose an active rider.");
    setError("");
    const failed: { id: string; message: string }[] = [];
    let done = 0;
    for (const [i, p] of ready.entries()) {
      setProgress(`Assigning ${i + 1} of ${ready.length}… ${done} done${failed.length ? `, ${failed.length} not assigned` : ""}`);
      try {
        await api(`/parcels/${encodeURIComponent(p.trackingId)}/assign-pickup`, { method: "POST", body: { riderId: rider.id } });
        done++;
      } catch (e) {
        failed.push({ id: p.trackingId, message: describe(e) });
      }
    }
    setResult({ done, failed, rider });
    toast(`${done} order${done === 1 ? "" : "s"} accepted and assigned to ${rider.code} · ${rider.name}${failed.length ? `; ${failed.length} not assigned` : ""}.`, failed.length ? "default" : "good");
    refreshParcels();
  }
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>{`Accept & assign · ${ready.length} order${ready.length === 1 ? "" : "s"}`}</h2>
          <p>
            {result
              ? `${result.done} order${result.done === 1 ? "" : "s"} accepted and assigned to ${result.rider.code} · ${result.rider.name}${result.failed.length ? `; ${result.failed.length} not assigned` : ""}.`
              : `Each order is accepted and given to the rider for pickup, one at a time: the same action as the row's "Accept & assign rider".${skipped ? ` ${skipped} ticked order${skipped === 1 ? " is" : "s are"} skipped (awaiting drop-off or no longer waiting).` : ""}`}
          </p>
        </div>
      </div>
      <div className="dialog-body">
        {result ? (
          <div className="stack">
            <div className="row">
              <span className="pill good">{result.done} assigned</span>
              {result.failed.length ? <span className="pill bad">{result.failed.length} not assigned</span> : null}
            </div>
            {result.failed.length ? (
              <div className="table-wrap" style={{ maxHeight: 240 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Why not</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.failed.map(f => (
                      <tr key={f.id}>
                        <td className="tracking">{f.id}</td>
                        <td>{f.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="stack">
            <label className="field">
              <span>Pickup rider</span>
              <Select className="select" value={riderId} onChange={e => setRiderId(e.target.value)} disabled={running} aria-invalid={error ? true : undefined}>
                <option value="">{riders.length ? "— Choose —" : "No active riders"}</option>
                {riderOptions(riders, ctx.myHubIds).map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              {error ? <span className="error">{error}</span> : null}
            </label>
            <p className="muted" aria-live="polite" style={{ margin: 0 }}>
              {progress ?? `${ready.map(p => p.trackingId).slice(0, 6).join(", ")}${ready.length > 6 ? ` and ${ready.length - 6} more` : ""}`}
            </p>
          </div>
        )}
      </div>
      <div className="dialog-foot">
        {result ? (
          <button type="button" className="button primary" onClick={() => close(true)}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="button" onClick={() => close(false)} disabled={running}>
              Cancel
            </button>
            <button type="button" className="button primary" onClick={() => void run()} aria-busy={running || undefined} disabled={running}>
              {`Accept & assign ${ready.length}`}
            </button>
          </>
        )}
      </div>
    </>
  );
}

const RESOLUTIONS = ["Schedule another delivery attempt", "Return shipment to merchant", "Route to nearest service hub", "Contact recipient for address confirmation"];

export async function resolveException(p: Parcel, ctx: ActionContext) {
  if (denied(ctx, "resolve exceptions")) return;
  const last = [...p.events].reverse().find(e => !e.internal) || p.events.at(-1);
  const hubChoices = (ctx.myHubIds ? ctx.hubs.filter(h => ctx.myHubIds!.includes(h.id)) : ctx.hubs).filter(h => h.active !== false);
  const knownHub = p.currentHub && ctx.hubs.find(h => h.id === p.currentHub!.id);
  await openForm({
    title: `Resolve exception · ${p.trackingId}`,
    description: `${p.statusLabel} · ${p.recipient.name || "Recipient not set"}, ${p.delivery.zone || "destination not set"}${last ? ` · Last update: ${last.title}${last.description ? ` — ${last.description}` : ""}` : ""}`,
    submit: "Resolve",
    fields: [
      { id: "resolution", label: "Resolution action", type: "select", required: true, value: RESOLUTIONS[0], options: RESOLUTIONS.map(v => ({ value: v, label: v })), full: true },
      {
        id: "hubId",
        label: "Hub that receives it",
        type: "select",
        required: true,
        value: hubChoices.length === 1 ? hubChoices[0].id : "",
        options: hubChoices.map(h => ({ value: h.id, label: h.code ? `${h.name} (${h.code})` : h.name })),
        full: true,
        show: v => /hub/i.test(v.resolution) && !knownHub,
      },
      { id: "note", label: "Internal note", type: "textarea", placeholder: "Add context for the rider or next shift", full: true },
    ],
    onSubmit: async v => {
      const note = [v.resolution, v.note].filter(Boolean).join(" — ");
      const id = encodeURIComponent(p.trackingId);
      if (/contact recipient/i.test(v.resolution)) {
        await api(`/parcels/${id}/notes`, { method: "POST", body: { note } });
        refreshParcels(p.trackingId);
        return `${p.trackingId}: follow-up recorded on the parcel timeline.`;
      }
      if (/return/i.test(v.resolution)) {
        await api(`/parcels/${id}/status`, { method: "POST", body: { expectedVersion: p.version, status: "RETURN_SCHEDULED", note } });
        refreshParcels(p.trackingId);
        return `${p.trackingId}: return to sender scheduled.`;
      }
      if (/hub/i.test(v.resolution)) {
        const hub = knownHub || ctx.hubs.find(h => h.id === v.hubId);
        if (!hub) throw new Error("Choose the hub that receives it.");
        await api(`/parcels/${id}/status`, { method: "POST", body: { expectedVersion: p.version, status: "AT_HUB", hubId: hub.id, note } });
        refreshParcels(p.trackingId);
        return `${p.trackingId}: routed to ${hub.name}.`;
      }
      // Another attempt: a parcel waiting at a hub needs a delivery rider first.
      if (["AT_HUB", "IN_TRANSIT"].includes(p.status)) {
        setTimeout(() => void assignRider(p, ctx), 0);
        return `Assign a delivery rider for the next attempt on ${p.trackingId}.`;
      }
      await api(`/parcels/${id}/status`, { method: "POST", body: { expectedVersion: p.version, status: "RETRY_SCHEDULED", note } });
      refreshParcels(p.trackingId);
      return `${p.trackingId}: another delivery attempt scheduled.`;
    },
  });
}

export async function editDetails(p: Parcel, ctx: ActionContext, catalog?: Catalog) {
  if (denied(ctx, "edit parcel details")) return;
  if (CLOSED.includes(p.status)) return toast(`${p.trackingId} is ${p.statusLabel.toLowerCase()}; its details can no longer change.`);
  if (p.incomplete) return completeDetails(p, catalog);
  await openForm({
    title: `Edit parcel · ${p.trackingId}`,
    description: `${p.statusLabel} · ${p.merchant?.name || p.sender.name} → ${p.delivery.zone}, ${p.delivery.district}. Price-affecting details (zones, weight, COD) can't change after booking. Every change is recorded on the parcel's timeline.`,
    submit: "Save parcel details",
    wide: true,
    fields: [
      { id: "recipient", label: "Recipient name", value: p.recipient.name, required: true, maxLength: 120 },
      { id: "recipientPhone", label: "Recipient phone", type: "phone", value: localPhone(p.recipient.phone), required: true },
      { id: "street", label: "Street address", value: p.delivery.street, required: true, maxLength: 200 },
      { id: "area", label: "Area / landmark", value: p.delivery.area, maxLength: 120 },
      { id: "instructions", label: "Delivery instructions", value: p.instructions || "", maxLength: 500, full: true },
      { id: "note", label: "Reason for the change", maxLength: 500, full: true, placeholder: "e.g. Recipient confirmed a new phone number" },
    ],
    validate: { recipient: v => (v.length < 2 ? "At least 2 characters" : "") },
    onSubmit: async v => {
      const fresh = queryClient.getQueryData<Parcel>(["parcel", p.trackingId]) || p;
      const updated = await api<Parcel>(`/parcels/${encodeURIComponent(p.trackingId)}`, {
        method: "PATCH",
        body: { recipient: { name: v.recipient, phone: v.recipientPhone }, delivery: { street: v.street, area: v.area }, instructions: v.instructions, note: v.note || undefined, expectedVersion: fresh.version },
      });
      put(updated);
      refreshParcels(p.trackingId);
      return `${p.trackingId} details saved.`;
    },
  });
}

/** "Needs info": complete the missing details (POST /parcels/:id/complete); changing the destination, weight or service re-prices it. */
async function completeDetails(p: Parcel, catalog?: Catalog) {
  let cat = catalog;
  try {
    cat ??= await api<Catalog>("/catalog");
  } catch (e) {
    return toast(describe(e), "bad");
  }
  let pkg: { options?: { speeds?: string[] }; labels?: { speed?: Record<string, string> }; package?: { segment?: string }; segment?: string } | null = null;
  try {
    pkg = await api(p.merchant?.id ? `/packages/effective?merchantId=${encodeURIComponent(p.merchant.id)}` : "/packages/effective?segment=CUSTOMER");
  } catch {
    pkg = null;
  }
  const service = (p.service ?? {}) as { speed?: string; speedLabel?: string };
  const currentSpeed = service.speed || "REGULAR";
  const speeds: [string, string][] = (pkg?.options?.speeds?.length ? pkg.options.speeds : [currentSpeed]).map(code => [code, pkg?.labels?.speed?.[code] || (code === currentSpeed && service.speedLabel) || code]);
  if (!speeds.some(([c]) => c === currentSpeed)) speeds.unshift([currentSpeed, service.speedLabel || currentSpeed]);
  const banking = pkg?.package?.segment === "BANKING_FINANCIAL" || pkg?.segment === "BANKING_FINANCIAL" || p.merchant?.type === "BANKING_FINANCIAL";
  await openCustom(close => <CompleteForm p={p} catalog={cat!} speeds={speeds} currentSpeed={currentSpeed} banking={banking} close={close} />, "wide");
}

const MISSING: Record<string, string> = { name: "recipientName", phone: "recipientPhone", street: "address", district: "district", zone: "zone" };
function CompleteForm({ p, catalog, speeds, currentSpeed, banking, close }: { p: Parcel; catalog: Catalog; speeds: [string, string][]; currentSpeed: string; banking: boolean; close: () => void }) {
  const [v, setV] = useState({
    name: p.recipient.name || "",
    phone: localPhone(p.recipient.phone || "").replace(/^0/, ""),
    street: p.delivery.street || "",
    area: p.delivery.area || "",
    district: p.delivery.district || "",
    zone: p.delivery.zone || "",
    weight: p.weightKg != null ? String(p.weightKg) : "",
    speed: currentSpeed,
    note: "",
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
    if (v.weight !== "" && !(Number(v.weight) > 0 && Number(v.weight) <= 50)) found.weight = "Enter a weight from 0.01 to 50 kg";
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
    if (v.weight && Number(v.weight) !== Number(p.weightKg)) body.weightKg = Number(v.weight);
    if (v.speed && v.speed !== currentSpeed) body.speed = v.speed;
    if (!Object.keys(body).length) return toast("Nothing changed.");
    if (v.note.trim()) body.note = v.note.trim();
    body.expectedVersion = p.version;
    setBusy(true);
    setFormError("");
    try {
      const updated = await api<Parcel>(`/parcels/${encodeURIComponent(p.trackingId)}/complete`, { method: "POST", body });
      put(updated);
      refreshParcels(p.trackingId);
      toast(
        updated.incomplete ? `${updated.trackingId} updated. Still needed: ${updated.missingLabels.join(", ")}.` : `${updated.trackingId} is complete · charge ${money(updated.charges.total)}. It can now be assigned for delivery.`,
        "good",
      );
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
            <span className="pill warn">Needs info</span> {p.merchant?.name || ""} · current charge {money(p.charges?.total)}
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
          <label className="field full">
            <span>Note (staff only)</span>
            <input className="input" maxLength={500} placeholder="e.g. Merchant confirmed by phone" value={v.note} onChange={e => set("note", e.target.value)} />
          </label>
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

export async function cancelRequest(p: Parcel, ctx: ActionContext) {
  if (denied(ctx, "cancel pickup requests")) return;
  const reason = await prompt({ title: `Cancel pickup request ${p.trackingId}?`, message: "The customer is told the pickup is cancelled. This can't be undone.", label: "Reason for the customer", multiline: true, required: false, ok: "Cancel pickup" });
  if (reason === null) return;
  await api(`/parcels/${encodeURIComponent(p.trackingId)}/cancel`, { method: "POST", body: { reason: reason || undefined } });
  refreshParcels(p.trackingId);
  toast(`${p.trackingId}: pickup request cancelled.`, "good");
}

export const canChangeIntake = (p: Parcel, ctx: ActionContext) => INTAKE_CHANGEABLE.includes(p.status) && ctx.can("dispatch") && (p.intake !== "DROP_OFF" || !ctx.myHubIds || ctx.myHubIds.includes(p.dropOffHub?.id ?? ""));
export const intakeActionLabel = (p: Parcel) => (p.intake === "DROP_OFF" ? "Change to rider pickup" : "Change to drop-off");

export async function changeIntake(p: Parcel, ctx: ActionContext) {
  if (denied(ctx, "change pickup or drop-off")) return;
  if (!INTAKE_CHANGEABLE.includes(p.status)) return toast(`${p.trackingId} is ${p.statusLabel.toLowerCase()}; pickup and drop-off can only change before pickup.`);
  const toDropOff = p.intake !== "DROP_OFF";
  const hubs = ctx.myHubIds ? ctx.hubs.filter(h => ctx.myHubIds!.includes(h.id)) : ctx.hubs;
  const released = p.pickupRider ? ` ${p.pickupRider.label} is released from the pickup.` : "";
  await openForm({
    title: `${intakeActionLabel(p)} · ${p.trackingId}`,
    description: toDropOff
      ? `The sender brings the parcel to the hub instead of a rider collecting it.${released} The price is recalculated from the hub's location and the sender gets an SMS with the hub's address.`
      : `A pickup rider collects the parcel from ${[p.pickup?.zone, p.pickup?.district].filter(Boolean).join(", ") || "the pickup address"}; assign one afterwards. The price is recalculated from the pickup address and the sender gets an SMS.`,
    submit: intakeActionLabel(p),
    fields: [
      { id: "intake", label: "Intake", type: "select", required: true, value: toDropOff ? "DROP_OFF" : "PICKUP", options: [{ value: "PICKUP", label: "Rider pickup" }, { value: "DROP_OFF", label: "Drop-off at hub" }] },
      { id: "hubId", label: "Drop-off hub", type: "select", required: true, value: toDropOff ? (hubs.length === 1 ? hubs[0].id : "") : p.dropOffHub?.id || "", options: hubs.map(h => ({ value: h.id, label: h.name })), show: v => v.intake === "DROP_OFF" },
      { id: "note", label: "Reason (staff only)", maxLength: 500, full: true, placeholder: "e.g. The merchant will bring it to the hub" },
    ],
    validate: {
      intake: (value, v) => (value === p.intake && (value === "PICKUP" || v.hubId === p.dropOffHub?.id) ? (value === "PICKUP" ? "This parcel is already a rider pickup." : `It is already booked for drop-off at ${p.dropOffHub?.name}.`) : ""),
    },
    onSubmit: async v => {
      const hub = v.intake === "DROP_OFF" ? ctx.hubs.find(h => h.id === v.hubId) : null;
      if (v.intake === "DROP_OFF" && !hub) throw new Error("Choose the hub the sender will bring the parcel to.");
      const updated = await api<Parcel>(`/parcels/${encodeURIComponent(p.trackingId)}/intake`, {
        method: "POST",
        body: { intake: v.intake, ...(hub ? { dropOffHubId: hub.id } : {}), note: v.note || undefined, expectedVersion: p.version },
      });
      put(updated);
      refreshParcels(p.trackingId);
      const charge = updated.charges?.total !== p.charges?.total ? ` New delivery charge ${money(updated.charges.total)}.` : "";
      return `${p.trackingId} ${v.intake === "DROP_OFF" ? `is now a drop-off at ${hub!.name}` : "is now a rider pickup"}. The sender was notified.${charge}`;
    },
  });
}

/** Failed delivery → return to sender, optionally on a return run now (new, or an open run of the merchant). */
export async function returnToSender(id: string, ctx: ActionContext, onOpenReturns?: () => void) {
  if (denied(ctx, "return parcels to the sender")) return;
  const p = await api<Parcel>(`/parcels/${encodeURIComponent(id)}`);
  put(p);
  const merchant = p.merchant;
  let runs: { id: string; number: string; parcelCount: number }[] = [];
  if (merchant) runs = (await api<{ items: typeof runs }>(`/returns/runs?status=PLANNED&merchantId=${encodeURIComponent(merchant.id)}&limit=50`).catch(() => ({ items: [] }))).items || [];
  const count = Number(p.failedAttempts) || 0;
  let runNumber = "";
  const result = await openForm({
    title: `Return to sender · ${p.trackingId}`,
    description: `${count ? `${failureText(p, when)}. ` : ""}The parcel goes to Return scheduled and ${merchant ? `${merchant.name} is` : "the sender is"} notified.`,
    submit: "Return to sender",
    fields: [
      { id: "reason", label: "Reason", required: true, maxLength: 300, value: p.returnInfo?.reason || p.lastFailedAttempt?.reason || "Delivery attempts exhausted", hint: p.returnInfo?.reason ? "The return reason already recorded is kept." : undefined, full: true },
      { id: "note", label: "Note", type: "textarea", rows: 2, maxLength: 500, placeholder: "e.g. Recipient refused twice; merchant agreed to take it back" },
      merchant
        ? {
            id: "run",
            label: "Add to a return run now",
            type: "select",
            required: true,
            value: "none",
            full: true,
            hint: "Return runs take a merchant's parcels back together (Returns page).",
            options: [
              { value: "none", label: "No — schedule the return only (plan the run later on Returns)" },
              { value: "new", label: "Yes — start a new return run" },
              ...runs.map(r => ({ value: r.id, label: `Yes — add to ${r.number} (planned, ${r.parcelCount} parcel${r.parcelCount === 1 ? "" : "s"})` })),
            ],
          }
        : { id: "runInfo", label: "Return run", type: "static", value: "Website customer parcels aren't put on merchant return runs; the return is scheduled only." },
    ],
    validate: { reason: v => (v.length < 3 ? "Enter the reason (at least 3 characters)" : "") },
    onSubmit: async v => {
      const problems = (error: unknown) => {
        const d = (error as { details?: { problems?: { trackingId: string; message: string }[] } })?.details;
        return d?.problems ? new Error(d.problems.map(x => `${x.trackingId}: ${x.message}`).join(" · ")) : error;
      };
      const run = v.run || "none";
      if (run === "none") {
        put(await api<Parcel>(`/parcels/${encodeURIComponent(p.trackingId)}/status`, { method: "POST", body: { status: "RETURN_SCHEDULED", note: v.reason, expectedVersion: p.version } }));
      } else if (run === "new") {
        const created = await api<{ number: string }>("/returns/runs", { method: "POST", body: { merchantId: merchant!.id, trackingIds: [p.trackingId], reason: v.reason, note: v.note || undefined } }).catch(e => {
          throw problems(e);
        });
        runNumber = created.number;
      } else {
        const updated = await api<{ number: string }>(`/returns/runs/${encodeURIComponent(run)}/parcels`, { method: "POST", body: { trackingIds: [p.trackingId], reason: v.reason } }).catch(e => {
          throw problems(e);
        });
        runNumber = updated.number;
      }
      if (v.note) await api(`/parcels/${encodeURIComponent(p.trackingId)}/notes`, { method: "POST", body: { note: `Return to sender: ${v.note}` } }).catch(() => undefined);
      refreshParcels(p.trackingId);
    },
  });
  if (!result) return;
  const message = runNumber ? `${p.trackingId} is scheduled for return on ${runNumber}.` : `${p.trackingId} is scheduled for return to the sender.`;
  const go = await confirm({
    title: "Return to sender scheduled",
    message: (
      <>
        <p style={{ margin: "0 0 10px" }}>
          <span className="pill good">Return scheduled</span> {message}
        </p>
        <p style={{ margin: 0 }}>{runNumber ? "Dispatch the run with a rider on the Returns page; the merchant confirms receipt when it's back." : "Plan a return run for it on the Returns page when the rider is ready to take it back."}</p>
      </>
    ),
    ok: "Open Returns",
    cancel: "Done",
  });
  if (go) onOpenReturns?.();
}

const PRODUCT_TYPES: [string, string][] = [
  ["REGULAR", "Regular"],
  ["DOCUMENT", "Document"],
  ["BOOKS", "Books"],
];
const taka = (n: unknown) => `৳${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const CORRECTION_CLOSED = ["CANCELLED", "PICKUP_CANCELLED", "RETURNED"];
export const correctionsFor = (p: Parcel, ctx: ActionContext) =>
  !ctx.can("dispatch") || CORRECTION_CLOSED.includes(p.status) ? { productType: false, returnCharge: false } : { productType: p.merchant?.type !== "BANKING_FINANCIAL", returnCharge: !!(p.returnOf || p.returnInfo) };

export async function changeProductType(p: Parcel) {
  const now = p.productType || "REGULAR";
  await openForm({
    title: `Change product type · ${p.trackingId}`,
    description: "What is sent, as priced. The delivery charge is worked out again with the parcel's service package. Rarely needed.",
    submit: "Change and re-price",
    fields: [
      { id: "current", type: "static", label: "Now", value: `${PRODUCT_TYPES.find(t => t[0] === now)?.[1] || now}${p.productName ? ` · ${p.productName}` : ""} · delivery charge ${taka(p.charges?.total)}` },
      { id: "productType", type: "select", label: "Price as", required: true, value: now === "REGULAR" ? "DOCUMENT" : "REGULAR", options: PRODUCT_TYPES.map(([value, label]) => ({ value, label })) },
    ],
    validate: { productType: v => (v === now ? "Choose another type" : "") },
    onSubmit: async v => {
      const r = await api<{ productType: string; totalCharge: { from: number; to: number } }>(`/parcels/${encodeURIComponent(p.trackingId)}/product-type`, { method: "POST", body: { productType: v.productType, expectedVersion: p.version } });
      refreshParcels(p.trackingId);
      return `${p.trackingId} priced as ${PRODUCT_TYPES.find(t => t[0] === r.productType)?.[1]}: delivery charge ${taka(r.totalCharge.from)} → ${taka(r.totalCharge.to)}.`;
    },
  });
}

export async function changeReturnCharge(p: Parcel) {
  const waived = !!p.returnInfo?.chargeWaived;
  await openForm({
    title: `Return charge · ${p.trackingId}`,
    description: p.returnOf ? `The return order of ${p.returnOf}'s partial delivery. The charge is billed to the merchant when it is returned.` : "Billed to the merchant when the parcel is returned.",
    submit: "Save",
    fields: [
      { id: "now", type: "static", label: "Now", value: waived ? "Not charged" : `Charged ${taka(p.returnInfo?.charge)}` },
      {
        id: "charge",
        type: "select",
        label: "Return charge",
        required: true,
        value: waived ? "no" : "yes",
        options: [
          { value: "yes", label: "Charge the return (the package's return charge)" },
          { value: "no", label: "Don't charge this return" },
        ],
        full: true,
      },
      { id: "reason", label: "Reason", maxLength: 300, placeholder: "e.g. Wrong size sent by the merchant", full: true },
    ],
    onSubmit: async v => {
      const r = await api<{ waived: boolean; returnCharge: number }>(`/parcels/${encodeURIComponent(p.trackingId)}/return-charge`, { method: "POST", body: { charge: v.charge === "yes", reason: v.reason || undefined } });
      refreshParcels(p.trackingId);
      return r.waived ? `${p.trackingId}: no return charge.` : `${p.trackingId}: return charge ${taka(r.returnCharge)}.`;
    },
  });
}

// PDFs (labels, invoices, lists): packages/panel-ui/src/lib/print.tsx, shared with the merchant panel.
export { PDF_LIMITS, PRINT_FORMATS, openDocument, parcelDocuments, printFormat, printLabels } from "@panel/lib/print";
