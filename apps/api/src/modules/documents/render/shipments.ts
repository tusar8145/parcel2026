import { compactHeader, footers, header, keyValues, MARGIN, pill, signatures, table, totals, type Brand, type DocMeta } from "../pdf/layout";
import { addressText } from "../../../common/address";
import { A4, COLOR, fmtAmount, fmtDate, fmtDateTime, MM, PdfWriter, taka } from "../pdf/writer";
import type { LabelData } from "./labels";

/** A parcel as printed on delivery invoices and shipment lists. */
export interface ShipmentDoc extends LabelData {
  status: string;
  statusLabel: string;
  line: "ecommerce" | "document" | "customer";
  rider: string | null;
  deliveredAt: Date | null;
  packaging: string | null;
  contents: string | null;
  declaredValue: number | null;
  /** Price lines frozen at booking (or base / weight / service / COD fee / discount). */
  chargeLines: { label: string; amount: number }[];
  total: number;
  vat: number;
  taxable: number;
  /** "COD to collect on delivery", "Billed on INV-… (Paid)"… */
  payment: string;
  deliveryCharge: string;
}

export type InvoiceLayout = "a4" | "a4-4" | "a4-8" | "pos";

const KIND: Record<ShipmentDoc["line"], string> = {
  ecommerce: "E-commerce parcel invoice",
  document: "Secure document consignment",
  customer: "Customer parcel invoice",
};

/** One delivery invoice on a full A4 page. */
function fullInvoice(pdf: PdfWriter, brand: Brand, s: ShipmentDoc, meta: DocMeta) {
  pdf.addPage();
  const m: DocMeta = { ...meta, title: KIND[s.line], number: `Shipment ${s.trackingId}`, date: s.bookedAt, subtitle: `Status: ${s.statusLabel}` };
  let y = header(pdf, brand, m);
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;

  // Barcode strip
  pdf.barcode(s.trackingId, x, y, 230, 40);
  pdf.text(s.trackingId, x, y + 42, { size: 11, bold: true, width: 230, align: "center" });
  pdf.qr(s.trackingUrl, x + w - 64, y - 4, 64);
  pdf.text("Scan to track", x + w - 64, y + 58, { size: 6.5, color: COLOR.muted, width: 64, align: "center" });
  const cod = s.codAmount > 0;
  const bx = x + 250;
  const bw = w - 250 - 76;
  pdf.box(bx, y, bw, 52, cod ? { fill: COLOR.dark, radius: 4 } : { stroke: COLOR.ink, radius: 4, width: 1 });
  pdf.text(cod ? "CASH TO COLLECT FROM RECIPIENT" : "NO CASH TO COLLECT", bx, y + 8, { size: 7.5, bold: true, color: cod ? "#fff" : COLOR.muted, width: bw, align: "center" });
  pdf.text(cod ? taka(s.codAmount) : "PREPAID", bx, y + 21, { size: 18, bold: true, color: cod ? "#fff" : COLOR.ink, width: bw, align: "center" });
  y += 72;

  if (s.incomplete) {
    pdf.box(x, y, w, 20, { fill: COLOR.danger, radius: 3 });
    pdf.text(`DETAILS PENDING · ${s.missingLabels.join(", ") || "details to be completed"} · delivery waits until completed`, x, y + 5, { size: 8.5, bold: true, color: "#fff", width: w, align: "center", maxLines: 1 });
    y += 28;
  }
  if (s.line === "document") {
    pdf.box(x, y, w, 18, { fill: "#fff7dd", stroke: "#f0d47b", radius: 3 });
    pdf.text("CONFIDENTIAL DOCUMENT · AUTHORISED RECIPIENT ONLY · SIGNATURE REQUIRED", x, y + 4, { size: 8, bold: true, width: w, align: "center" });
    y += 26;
  }

  // Parties
  const half = (w - 16) / 2;
  const party = (title: string, lines: string[], px: number) => {
    let py = y;
    pdf.text(title, px, py, { size: 7, bold: true, color: COLOR.faint });
    py += 11;
    lines.filter(Boolean).forEach((t, i) => (py += pdf.text(t, px, py, { size: i === 0 ? 10 : 8.5, bold: i === 0, width: half, maxLines: 3 })));
    return py;
  };
  const fromEnd = party("FROM (SENDER / MERCHANT)", [`${s.merchant}${s.merchantCode ? ` (${s.merchantCode})` : ""}`, s.sender.phone, s.intake === "DROP_OFF" ? `Dropped off at ${s.originHub?.name ?? "hub"}` : s.originHub ? `Origin hub: ${s.originHub.name}` : ""], x);
  const toEnd = party(
    "DELIVER TO",
    [
      s.recipient.name ?? "Recipient pending",
      s.recipient.phone ?? "Phone pending",
      addressText(s.address.street, s.address.area, s.address.zone, s.address.district) || "Address pending",
      s.destHub ? `Destination hub: ${s.destHub.name}` : "",
    ],
    x + half + 16,
  );
  y = Math.max(fromEnd, toEnd) + 10;
  pdf.line(x, y, x + w, y);
  y += 8;

  // Shipment details
  y = keyValues(
    pdf,
    [
      ["Service", s.service],
      ["Delivery", s.deliveryMode],
      ["Weight", `${s.weightKg} kg`],
      [s.line === "document" ? "Document type" : "Product", s.product ?? s.contents ?? "—"],
      ["Order ref", s.orderRef ?? "—"],
      ["Packaging", s.packaging ?? "—"],
      ["Booked", fmtDateTime(s.bookedAt)],
      ["Delivered", s.deliveredAt ? fmtDateTime(s.deliveredAt) : "—"],
      ["Rider", s.rider ?? "—"],
      ["CN", s.cn ?? "—"],
      ["Declared value", s.declaredValue != null ? taka(s.declaredValue) : "—"],
      ["Batch", s.batch ?? "—"],
    ],
    x,
    y,
    w,
    4,
  );
  y += 4;

  // Charges with VAT (left out when Invoice settings › "Show delivery charge on invoice" is off)
  const charge = brand.showDeliveryCharge !== false;
  const newPage = () => compactHeader(pdf, brand, m);
  if (charge) y = table(pdf, {
    y,
    newPage,
    columns: [
      { header: "#", width: 0.5 },
      { header: "Description", width: 6 },
      { header: "Amount (৳)", width: 2, align: "right" },
    ],
    rows: s.chargeLines.map((l, i) => [String(i + 1), l.label, fmtAmount(l.amount)]),
    empty: "No charges",
  });
  if (charge) y += 6;
  // VAT lines only while VAT is on (finance settings); otherwise the charge is simply the charge.
  const vat = charge && brand.vatRate > 0;
  y = totals(
    pdf,
    [
      ...(!charge ? [] : vat
        ? [
            { label: "Taxable value", value: fmtAmount(s.taxable) },
            { label: `VAT ${brand.vatRate}% (included)`, value: fmtAmount(s.vat) },
            { label: "Delivery charge incl. VAT", value: `৳ ${fmtAmount(s.total)}`, strong: true },
          ]
        : [{ label: "Delivery charge", value: `৳ ${fmtAmount(s.total)}`, strong: true }]),
      { label: "COD to collect", value: `৳ ${fmtAmount(s.codAmount)}` },
    ],
    y,
  );
  y += 10;
  pill(pdf, s.payment, x, y, cod ? COLOR.ink : COLOR.ok);
  if (charge) pdf.text(s.deliveryCharge, x, y + 20, { size: 8, color: COLOR.muted, width: w * 0.6 });
  if (vat) pdf.text(brand.bin ? `Seller BIN ${brand.bin}. Prices include VAT at ${brand.vatRate}%.` : `Prices include VAT at ${brand.vatRate}%.`, x, y + 32, { size: 7.5, color: COLOR.faint, width: w * 0.6 });
  if (s.instructions) pdf.text(`Instructions: ${s.instructions}`, x, y + 44, { size: 8, width: w * 0.6, maxLines: 3 });
  signatures(pdf, ["Received by (recipient name & signature)", "Delivered by (rider)"], Math.min(Math.max(y + 70, 0), pdf.height - 120));
}

/** A compact invoice in a grid cell (4 or 8 per A4 page). */
function cellInvoice(pdf: PdfWriter, brand: Brand, s: ShipmentDoc, x: number, y: number, w: number, h: number, dense: boolean) {
  const charge = brand.showDeliveryCharge !== false;
  const pad = dense ? 6 : 9;
  const ix = x + pad;
  const iw = w - pad * 2;
  pdf.box(x, y, w, h, { stroke: "#aeb7c2", width: 0.8, radius: 3 });
  let cy = y + pad;
  pdf.logo(ix, cy - 1, dense ? 13 : 17);
  pdf.text(brand.appName, ix + (dense ? 16 : 21), cy, { size: dense ? 8 : 10, bold: true, width: iw * 0.5, maxLines: 1 });
  pdf.text(KIND[s.line].toUpperCase(), ix + iw * 0.45, cy + 1, { size: dense ? 5.5 : 6.5, bold: true, width: iw * 0.55, align: "right", maxLines: 2 });
  cy += dense ? 16 : 22;
  pdf.barcode(s.trackingId, ix, cy, iw, dense ? 24 : 34);
  cy += dense ? 25 : 36;
  pdf.text(s.trackingId, ix, cy, { size: dense ? 8.5 : 10.5, bold: true, width: iw, align: "center" });
  cy += dense ? 12 : 15;
  const fs = dense ? 6.8 : 8;
  const half = iw / 2 - 3;
  pdf.text("FROM", ix, cy, { size: 5.5, bold: true, color: COLOR.faint });
  pdf.text("TO", ix + half + 6, cy, { size: 5.5, bold: true, color: COLOR.faint });
  cy += 7;
  const a = pdf.text(`${s.merchant}${s.merchantCode ? ` (${s.merchantCode})` : ""}`, ix, cy, { size: fs, bold: true, width: half, maxLines: 2 });
  const b = pdf.text(`${s.recipient.name ?? "Recipient pending"} · ${s.recipient.phone ?? "phone pending"}`, ix + half + 6, cy, { size: fs, bold: true, width: half, maxLines: 2 });
  cy += Math.max(a, b);
  cy += pdf.text(addressText(s.address.street, s.address.area, s.address.zone, s.address.district) || "Address pending", ix + half + 6, cy, { size: fs - 0.5, width: half, maxLines: dense ? 2 : 3, color: COLOR.muted });
  cy += 4;
  const grid: [string, string][] = [
    ["Service", s.service],
    ["Weight", `${s.weightKg} kg`],
    ["COD", s.codAmount > 0 ? taka(s.codAmount) : "Prepaid"],
    ...((charge ? [["Charge", taka(s.total)]] : []) as [string, string][]),
    ...(dense ? [] : ((charge && brand.vatRate > 0 ? [["VAT incl.", taka(s.vat)], ["Status", s.statusLabel]] : [["Status", s.statusLabel]]) as [string, string][])),
  ];
  const cols = dense ? 4 : 3;
  const cw = iw / cols;
  grid.forEach(([k, v], i) => {
    const gx = ix + (i % cols) * cw;
    const gy = cy + Math.floor(i / cols) * (dense ? 17 : 21);
    pdf.text(k.toUpperCase(), gx, gy, { size: 5.3, bold: true, color: COLOR.faint, width: cw - 3 });
    pdf.text(v, gx, gy + 6.5, { size: dense ? 7 : 8, bold: true, width: cw - 3, maxLines: 1 });
  });
  cy += Math.ceil(grid.length / cols) * (dense ? 17 : 21);
  if (s.incomplete && cy + 12 < y + h) {
    pdf.box(ix, cy, iw, 11, { fill: COLOR.danger, radius: 2 });
    pdf.text("DETAILS PENDING", ix, cy + 1.5, { size: 6.5, bold: true, color: "#fff", width: iw, align: "center" });
    cy += 14;
  }
  if (!dense) {
    // Price lines while there is room above the QR code.
    const room = y + h - pad - 58;
    for (const l of charge ? s.chargeLines : []) {
      if (cy + 10 > room) break;
      pdf.text(l.label, ix, cy, { size: 6.8, color: COLOR.muted, width: iw * 0.7, maxLines: 1 });
      pdf.text(fmtAmount(l.amount), ix + iw * 0.7, cy, { size: 6.8, width: iw * 0.3, align: "right" });
      cy += 9.5;
    }
    const qr = 46;
    if (cy + qr < y + h - pad) {
      pdf.qr(s.trackingUrl, ix + iw - qr, y + h - pad - qr, qr);
      pdf.text(s.payment, ix, y + h - pad - 20, { size: 6.8, bold: true, width: iw - qr - 6, maxLines: 1 });
      pdf.text(`Booked ${fmtDate(s.bookedAt)}${s.orderRef ? ` · ref ${s.orderRef}` : ""}`, ix, y + h - pad - 10, { size: 6.3, color: COLOR.muted, width: iw - qr - 6, maxLines: 1 });
    }
  } else {
    pdf.text(`${s.payment} · booked ${fmtDate(s.bookedAt)}`, ix, y + h - pad - 8, { size: 5.8, color: COLOR.muted, width: iw, maxLines: 1 });
  }
}

const POS_W = 80 * MM;

/** Height of a POS receipt (measured with the same rules it is drawn with). */
function posReceipt(pdf: PdfWriter, brand: Brand, s: ShipmentDoc, draw: boolean): number {
  const charge = brand.showDeliveryCharge !== false;
  const pad = 10;
  const iw = POS_W - pad * 2;
  let y = pad;
  const t = (text: string, o: Parameters<PdfWriter["text"]>[3]) => (draw ? pdf.text(text, pad, y, { width: iw, ...o }) : pdf.measure(text, { width: iw, ...o }));
  y += t(brand.appName, { size: 12, bold: true, align: "center" });
  if (brand.support) y += t(`Support: ${brand.support}`, { size: 7, align: "center", color: COLOR.muted, maxLines: 2 });
  if (brand.bin && brand.vatRate > 0) y += t(`BIN ${brand.bin}`, { size: 7, align: "center", color: COLOR.muted });
  y += 4;
  y += t(KIND[s.line].toUpperCase(), { size: 8, bold: true, align: "center" });
  if (draw) pdf.barcode(s.trackingId, pad, y + 2, iw, 34);
  y += 38;
  y += t(s.trackingId, { size: 10, bold: true, align: "center" });
  if (draw) pdf.line(pad, y + 3, pad + iw, y + 3, { dash: 2, color: COLOR.muted });
  y += 7;
  const rows: [string, string][] = [
    ["Booked", fmtDateTime(s.bookedAt)],
    ["From", `${s.merchant}${s.merchantCode ? ` (${s.merchantCode})` : ""}`],
    ["To", `${s.recipient.name ?? "Recipient pending"}, ${s.recipient.phone ?? "phone pending"}`],
    ["Address", addressText(s.address.street, s.address.area, s.address.zone, s.address.district) || "Address pending"],
    ["Service", `${s.service} · ${s.deliveryMode}`],
    ["Weight", `${s.weightKg} kg`],
    ...(s.orderRef ? ([["Order ref", s.orderRef]] as [string, string][]) : []),
  ];
  for (const [k, v] of rows) {
    const h = draw ? pdf.text(v, pad + 52, y, { size: 7.5, width: iw - 52, maxLines: 3 }) : pdf.measure(v, { size: 7.5, width: iw - 52, maxLines: 3 });
    if (draw) pdf.text(k, pad, y, { size: 7.5, bold: true, color: COLOR.muted, width: 50 });
    y += h + 1;
  }
  if (draw) pdf.line(pad, y + 2, pad + iw, y + 2, { dash: 2, color: COLOR.muted });
  y += 6;
  for (const l of charge ? s.chargeLines : []) {
    if (draw) {
      pdf.text(l.label, pad, y, { size: 7.5, width: iw - 60, maxLines: 2 });
      pdf.text(fmtAmount(l.amount), pad + iw - 60, y, { size: 7.5, width: 60, align: "right" });
    }
    y += pdf.measure(l.label, { size: 7.5, width: iw - 60, maxLines: 2 });
  }
  const sum: [string, string, boolean][] = [
    ...(charge && brand.vatRate > 0 ? ([[`VAT ${brand.vatRate}% (included)`, fmtAmount(s.vat), false]] as [string, string, boolean][]) : []),
    ...(charge ? ([["Delivery charge", `৳ ${fmtAmount(s.total)}`, true]] as [string, string, boolean][]) : []),
    ["COD to collect", `৳ ${fmtAmount(s.codAmount)}`, true],
  ];
  y += 3;
  for (const [k, v, strong] of sum) {
    if (draw) {
      pdf.text(k, pad, y, { size: strong ? 9 : 7.5, bold: strong, width: iw - 70 });
      pdf.text(v, pad + iw - 70, y, { size: strong ? 9 : 7.5, bold: strong, width: 70, align: "right" });
    }
    y += (strong ? 9 : 7.5) * 1.3 + 1;
  }
  y += 4;
  y += t(s.payment, { size: 7.5, bold: true, align: "center", maxLines: 2 });
  if (s.incomplete) y += t("DETAILS PENDING", { size: 9, bold: true, align: "center", color: COLOR.danger });
  if (draw) pdf.qr(s.trackingUrl, pad + iw / 2 - 30, y + 4, 60);
  y += 66;
  y += t("Scan to track · thank you", { size: 7, align: "center", color: COLOR.muted });
  return y + pad;
}

export function drawShipmentInvoices(pdf: PdfWriter, brand: Brand, items: ShipmentDoc[], layout: InvoiceLayout, meta: DocMeta) {
  if (layout === "a4") {
    for (const s of items) fullInvoice(pdf, brand, s, meta);
    footers(pdf, brand, meta);
    return;
  }
  if (layout === "pos") {
    for (const s of items) {
      const h = Math.ceil(posReceipt(pdf, brand, s, false));
      pdf.addPage([POS_W, h]);
      posReceipt(pdf, brand, s, true);
    }
    return;
  }
  // 4 / 8 per A4: the sheets are cut after printing, so no page header or footer ("Page x of y") —
  // only the invoice cells, on an even grid with the same margin all round (each cell carries the
  // company name itself).
  const per = layout === "a4-4" ? 4 : 8;
  const cols = 2;
  const rows = per / cols;
  const gap = 10;
  const edge = MARGIN - 6;
  const cw = (A4[0] - edge * 2 - gap) / cols;
  const ch = (A4[1] - edge * 2 - gap * (rows - 1)) / rows;
  for (let i = 0; i < items.length; i += per) {
    pdf.addPage();
    items.slice(i, i + per).forEach((s, k) => {
      const cx = edge + (k % cols) * (cw + gap);
      const cy = edge + Math.floor(k / cols) * (ch + gap);
      cellInvoice(pdf, brand, s, cx, cy, cw, ch, per === 8);
    });
  }
}

/** The order / shipment list (landscape A4 table with totals). */
export function drawShipmentList(pdf: PdfWriter, brand: Brand, items: ShipmentDoc[], meta: DocMeta) {
  pdf.addPage();
  let y = header(pdf, brand, meta);
  const newPage = () => compactHeader(pdf, brand, meta);
  const cod = items.reduce((n, s) => n + s.codAmount, 0);
  const charges = items.reduce((n, s) => n + s.total, 0);
  y = table(pdf, {
    y,
    newPage,
    size: 7.5,
    columns: [
      { header: "#", width: 0.45 },
      { header: "Tracking ID", width: 2.1, bold: true },
      { header: "Merchant / sender", width: 2 },
      { header: "Recipient", width: 2.2 },
      { header: "Destination", width: 2.4 },
      { header: "Service", width: 1.3 },
      { header: "Weight", width: 0.8, align: "right" },
      { header: "COD (৳)", width: 1.1, align: "right" },
      { header: "Charge (৳)", width: 1.1, align: "right" },
      { header: "Status", width: 1.6 },
      { header: "Rider", width: 1.5 },
    ],
    rows: items.map((s, i) => [
      String(i + 1),
      { text: s.trackingId, sub: s.orderRef ? `ref ${s.orderRef}` : undefined },
      s.merchant,
      { text: s.recipient.name ?? "Pending", sub: s.recipient.phone ?? undefined, color: s.recipient.name ? undefined : COLOR.danger },
      [s.address.zone, s.address.district].filter(Boolean).join(", ") || "Pending",
      s.service,
      `${s.weightKg} kg`,
      s.codAmount ? fmtAmount(s.codAmount) : "—",
      fmtAmount(s.total),
      { text: s.statusLabel, sub: s.incomplete ? "Details pending" : undefined },
      s.rider ?? "—",
    ]),
    foot: [["", `${items.length} shipment(s)`, "", "", "", "", "", fmtAmount(cod), fmtAmount(charges), "", ""]],
  });
  footers(pdf, brand, meta);
  return y;
}
