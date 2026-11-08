/** Parcel actions of the merchant panel, same API calls and wording as the classic panel (merchant-bridge.js, merchant-features.js). */
import { api, describe } from "@panel/lib/api";
import { queryClient } from "@panel/lib/queryClient";
import { confirm, openForm } from "@panel/ui/dialogs";
import { toast } from "@panel/ui/toast";
import { printLabels } from "@panel/lib/print";
import type { Parcel } from "./model";

/** Every list, count and open parcel of this panel reloads. */
export const refreshMerchant = () => void queryClient.invalidateQueries({ queryKey: ["m"] });

export async function cancelParcel(p: Pick<Parcel, "trackingId" | "recipient">) {
  const id = p.trackingId;
  const v = await openForm({
    title: `Cancel ${id}?`,
    description: p.recipient?.name ? `The pickup for ${p.recipient.name} won't be collected. This can't be undone.` : "The pickup won't be collected. This can't be undone.",
    submit: "Cancel shipment",
    danger: true,
    fields: [{ id: "reason", label: "Reason", type: "textarea", maxLength: 300, required: false }],
  });
  if (!v) return;
  try {
    await api(`/parcels/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason: v.reason || undefined } });
    toast(`${id} cancelled. The pickup won't be collected.`);
  } catch (error) {
    toast(describe(error), "bad");
  } finally {
    refreshMerchant();
  }
}

export async function confirmReturnReceived(id: string) {
  if (!(await confirm({ title: `Received ${id} back?`, message: "Confirm the returned parcel reached you.", ok: "Yes, received" }))) return;
  try {
    await api(`/parcels/${encodeURIComponent(id)}/return-received`, { method: "POST" });
    toast(`${id} marked as received.`);
  } catch (error) {
    toast(describe(error), "bad");
  } finally {
    refreshMerchant();
  }
}

export const printLabel = (id: string) => printLabels([id]);

let returnReasons: string[] | null = null;
/** "Request return" (merchant-features.js requestReturn): operations stop delivery attempts and bring it back. */
export async function requestReturn(trackingId: string) {
  if (!returnReasons) returnReasons = (await api<{ reasons: string[] }>("/returns/reasons").catch(() => ({ reasons: [] as string[] }))).reasons;
  const v = await openForm({
    title: `Return ${trackingId} to you`,
    description: "Operations stop delivery attempts and bring the parcel back. A return charge applies.",
    submit: "Request return",
    fields: [
      { id: "reason", label: "Reason", type: "select", full: true, value: returnReasons[0] ?? "__other", options: [...returnReasons.map(r => ({ value: r, label: r })), { value: "__other", label: "Other…" }] },
      { id: "other", label: "Describe the reason", full: true, maxLength: 300, required: true, show: v => v.reason === "__other" },
    ],
    validate: { other: (v, all) => (all.reason !== "__other" || v.trim().length >= 3 ? "" : "Describe the reason (at least 3 characters)") },
    onSubmit: async v => {
      const reason = v.reason === "__other" ? v.other.trim() : v.reason;
      await api(`/parcels/${encodeURIComponent(trackingId)}/return-request`, { method: "POST", body: { reason } });
      refreshMerchant();
      return `Return requested for ${trackingId}. Operations will schedule it.`;
    },
  });
  return v;
}
