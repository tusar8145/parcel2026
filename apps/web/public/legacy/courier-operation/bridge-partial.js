/*
 * Partial delivery in Courier Operations (API: modules/parcels/partial-delivery.ts, parcel-corrections).
 *
 *   Parcel drawer › "Partial delivery": the cash actually collected of the COD amount, the note and
 *   the return order(s); on a return order, the parcel it carries back.
 *   Parcel drawer › More ▾:
 *     Change product type   Regular / Document / Books as priced (POST /parcels/:id/product-type):
 *                           the delivery charge is re-priced; until it is settled or invoiced.
 *     Return charge         charge or don't charge a return, e.g. a partial delivery's return order
 *                           (POST /parcels/:id/return-charge); until it is returned.
 * Partial delivery itself is entered in the rider app and on Scan desk › Delivery entry.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const esc = Ops.esc;
  const taka = n => `৳${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
  const TYPES = [
    ["REGULAR", "Regular"],
    ["DOCUMENT", "Document"],
    ["BOOKS", "Books"],
  ];
  const CLOSED = ["CANCELLED", "PICKUP_CANCELLED", "RETURNED"];
  const banking = p => p.merchant?.type === "BANKING_FINANCIAL";

  /** The drawer section (partial delivery, or the parcel a return order carries back); "" for other parcels. */
  Ops.partialSection = p => {
    if (p.partialDelivery) {
      const d = p.partialDelivery;
      const orders = d.returnOrders.length
        ? d.returnOrders.map(r => `<button type="button" class="button button-sm" data-drawer="${esc(r.trackingId)}">${esc(r.trackingId)} · return order</button>`).join(" ")
        : "";
      return `<section id="drawerPartial"><h3>Partial delivery</h3><p style="margin:0 0 8px;font-size:13px;color:#344054">The recipient kept part of the order and paid <strong>${esc(taka(d.codCollected))}</strong>${d.codAmount ? ` of the ${esc(taka(d.codAmount))} COD` : ""}. The delivery charge is unchanged.${d.note ? ` <em>${esc(d.note)}</em>` : ""}</p>${orders}</section>`;
    }
    if (p.returnOf)
      return `<section id="drawerPartial"><h3>Return order</h3><p style="margin:0 0 8px;font-size:13px;color:#344054">Carries back what the recipient didn't keep on the partial delivery of <button type="button" class="button button-sm" data-drawer="${esc(p.returnOf)}">${esc(p.returnOf)}</button>. Return charge: <strong>${p.returnInfo?.chargeWaived ? "not charged" : esc(taka(p.returnInfo?.charge))}</strong>.</p></section>`;
    return "";
  };

  /** More ▾ items of the parcel drawer for these corrections (staff who dispatch). */
  Ops.correctionItems = p => {
    if (!Ops.can("dispatch") || !p || CLOSED.includes(p.status)) return "";
    const items = [];
    if (!banking(p)) items.push(`<button type="button" class="button button-sm" role="menuitem" data-product-type="${esc(p.trackingId)}">Change product type</button>`);
    if (p.returnOf || p.returnInfo) items.push(`<button type="button" class="button button-sm" role="menuitem" data-return-charge="${esc(p.trackingId)}">Return charge</button>`);
    return items.join("");
  };

  const reload = async id => {
    try {
      const fresh = await DF.api(`/parcels/${encodeURIComponent(id)}`);
      Ops.upsertParcels?.([fresh]);
    } catch {}
    void Ops.refresh?.().catch(() => undefined);
    if (Ops.drawer?.open && document.getElementById("parcelDrawer") && !document.getElementById("parcelDrawer").hidden) Ops.drawer.open(id);
  };

  function productType(p) {
    const now = p.productType || "REGULAR";
    Ops.form({
      title: `Change product type · ${p.trackingId}`,
      description: "What is sent, as priced. The delivery charge is worked out again with the parcel's service package. Rarely needed.",
      submit: "Change and re-price",
      fields: [
        { id: "current", type: "static", label: "Now", value: `${TYPES.find(t => t[0] === now)?.[1] || now}${p.productName ? ` · ${p.productName}` : ""} · delivery charge ${taka(p.charges?.total)}`, full: true },
        { id: "productType", type: "select", label: "Price as", required: true, value: now === "REGULAR" ? "DOCUMENT" : "REGULAR", options: TYPES.map(([value, label]) => ({ value, label })) },
      ],
      validate: { productType: v => (v === now ? "Choose another type" : "") },
      onSubmit: async values => {
        const r = await DF.api(`/parcels/${encodeURIComponent(p.trackingId)}/product-type`, { method: "POST", body: { productType: values.productType, expectedVersion: p.version } });
        void reload(p.trackingId);
        return `${p.trackingId} priced as ${TYPES.find(t => t[0] === r.productType)?.[1]}: delivery charge ${taka(r.totalCharge.from)} → ${taka(r.totalCharge.to)}.`;
      },
    });
  }

  function returnCharge(p) {
    const waived = !!p.returnInfo?.chargeWaived;
    Ops.form({
      title: `Return charge · ${p.trackingId}`,
      description: p.returnOf ? `The return order of ${p.returnOf}'s partial delivery. The charge is billed to the merchant when it is returned.` : "Billed to the merchant when the parcel is returned.",
      submit: "Save",
      fields: [
        { id: "now", type: "static", label: "Now", value: waived ? "Not charged" : `Charged ${taka(p.returnInfo?.charge)}`, full: true },
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
        },
        { id: "reason", type: "text", label: "Reason", maxLength: 300, placeholder: "e.g. Wrong size sent by the merchant", full: true },
      ],
      onSubmit: async values => {
        const r = await DF.api(`/parcels/${encodeURIComponent(p.trackingId)}/return-charge`, { method: "POST", body: { charge: values.charge === "yes", reason: values.reason || undefined } });
        void reload(p.trackingId);
        return r.waived ? `${p.trackingId}: no return charge.` : `${p.trackingId}: return charge ${taka(r.returnCharge)}.`;
      },
    });
  }

  window.addEventListener(
    "click",
    event => {
      const el = event.target instanceof Element ? event.target.closest("[data-product-type],[data-return-charge]") : null;
      if (!el) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      el.closest("details")?.removeAttribute("open");
      const id = el.dataset.productType || el.dataset.returnCharge;
      const p = Ops.apiParcel(id);
      if (!p) return void DF.toast?.(`${id} is no longer loaded. Open it again.`);
      if (el.dataset.productType) productType(p);
      else returnCharge(p);
    },
    true,
  );
})();
