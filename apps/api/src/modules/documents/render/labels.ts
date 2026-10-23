import { A4, COLOR, fmtDate, fmtDateTime, MM, PdfWriter, taka } from "../pdf/writer";
import type { Brand } from "../pdf/layout";
import { addressText } from "../../../common/address";

/** Everything printed on a shipping label. */
export interface LabelData {
  trackingId: string;
  cn: string | null;
  merchant: string;
  merchantCode: string | null;
  orderRef: string | null;
  sender: { name: string; phone: string };
  recipient: { name: string | null; phone: string | null };
  address: { street: string | null; area: string | null; zone: string | null; district: string | null };
  codAmount: number;
  weightKg: number;
  isDocument: boolean;
  service: string;
  deliveryMode: string;
  product: string | null;
  intake: "PICKUP" | "DROP_OFF";
  originHub: { code: string; name: string } | null;
  destHub: { code: string; name: string } | null;
  zoneCode: string | null;
  batch: string | null;
  instructions: string | null;
  bookedAt: Date;
  incomplete: boolean;
  missingLabels: string[];
  openBox: boolean;
  trackingUrl: string;
}

export type LabelFormat = "a4" | "thermal";

export const LABEL_PAGE = {
  a4: { size: A4, perPage: 4 },
  /** 100 × 150 mm (4 × 6 in) thermal label printers. */
  thermal: { size: [100 * MM, 150 * MM] as [number, number], perPage: 1 },
} as const;

export const labelPages = (format: LabelFormat, count: number) => Math.ceil(count / LABEL_PAGE[format].perPage);

/** One label in a w × h box (≈100 × 145 mm in both formats). */
export function drawLabel(pdf: PdfWriter, brand: Brand, l: LabelData, x: number, y: number, w: number, h: number, n: number, total: number, printedAt: Date) {
  const pad = 8;
  const iw = w - pad * 2;
  const ix = x + pad;
  pdf.box(x, y, w, h, { stroke: COLOR.ink, width: 1.1, radius: 3 });
  let cy = y + pad;

  // Brand and service
  pdf.logo(ix, cy - 1, 18);
  pdf.text(brand.appName, ix + 22, cy + 1, { size: 10.5, bold: true, width: iw * 0.55, maxLines: 1 });
  const service = l.service.toUpperCase();
  const sw = Math.min(pdf.measureWidth(service, 8.5, true) + 12, iw * 0.45);
  pdf.box(ix + iw - sw, cy, sw, 16, { fill: COLOR.dark, radius: 2 });
  pdf.text(service, ix + iw - sw, cy + 2.6, { size: 8.5, bold: true, color: "#fff", width: sw, align: "center", maxLines: 1 });
  cy += 22;

  // Barcode + tracking ID
  pdf.barcode(l.trackingId, ix, cy, iw, 44);
  cy += 47;
  pdf.text(l.trackingId, ix, cy, { size: 13, bold: true, width: iw, align: "center" });
  cy += 17;
  if (l.cn && l.cn !== l.trackingId) {
    pdf.text(`CN ${l.cn}`, ix, cy, { size: 7.5, color: COLOR.muted, width: iw, align: "center" });
    cy += 10;
  }
  pdf.line(ix, cy + 2, ix + iw, cy + 2, { color: COLOR.ink, width: 0.8 });
  cy += 6;

  // Destination (sort) and COD
  const codW = iw * 0.4;
  const destW = iw - codW - 6;
  const destH = 52;
  const district = l.address.district ?? (l.incomplete ? "District pending" : "—");
  pdf.text(district.toUpperCase(), ix, cy, { size: 12.5, bold: true, width: destW, maxLines: 1 });
  const zoneLine = l.address.zone ? [l.address.zone, l.zoneCode ? `(${l.zoneCode})` : null].filter(Boolean).join(" ") : l.incomplete ? "Zone pending" : "—";
  pdf.text(zoneLine, ix, cy + 17, { size: 9.5, bold: true, width: destW, maxLines: 1 });
  pdf.text(l.destHub ? `Dest. hub: ${l.destHub.code} · ${l.destHub.name}` : "Dest. hub: to be routed", ix, cy + 31, { size: 7.5, color: COLOR.muted, width: destW, maxLines: 2 });
  const cod = l.codAmount > 0;
  pdf.box(ix + iw - codW, cy, codW, destH, cod ? { fill: COLOR.dark, radius: 3 } : { stroke: COLOR.ink, width: 1.2, radius: 3 });
  pdf.text(cod ? "COLLECT COD" : "NO CASH TO COLLECT", ix + iw - codW, cy + 6, { size: 7, bold: true, color: cod ? "#fff" : COLOR.muted, width: codW, align: "center" });
  pdf.text(cod ? taka(l.codAmount) : "PREPAID", ix + iw - codW, cy + 18, { size: cod ? 17 : 14, bold: true, color: cod ? "#fff" : COLOR.ink, width: codW, align: "center", maxLines: 1 });
  cy += destH + 6;

  // Needs info
  if (l.incomplete) {
    const missing = l.missingLabels.length ? `needs ${l.missingLabels.join(", ").toLowerCase()}` : "details to be completed";
    pdf.box(ix, cy, iw, 26, { fill: COLOR.danger, radius: 2 });
    pdf.text("DETAILS PENDING", ix, cy + 2.5, { size: 10, bold: true, color: "#fff", width: iw, align: "center" });
    pdf.text(`${missing} · hold delivery until completed`, ix, cy + 14, { size: 7, color: "#fff", width: iw, align: "center", maxLines: 1 });
    cy += 30;
  }

  // Recipient
  pdf.text("TO", ix, cy, { size: 6.5, bold: true, color: COLOR.faint });
  cy += 9;
  pdf.text(l.recipient.name ?? "Recipient pending", ix, cy, { size: 11, bold: true, width: iw, maxLines: 1, color: l.recipient.name ? COLOR.ink : COLOR.danger });
  cy += 14;
  pdf.text(l.recipient.phone ?? "Phone pending", ix, cy, { size: 10, bold: true, width: iw, color: l.recipient.phone ? COLOR.ink : COLOR.danger });
  cy += 13;
  const address = addressText(l.address.street, l.address.area, l.address.zone, l.address.district) || "Address pending";
  cy += pdf.text(address, ix, cy, { size: 8.5, width: iw, maxLines: 3, color: l.address.street ? COLOR.ink : COLOR.danger });
  cy += 3;
  pdf.line(ix, cy, ix + iw, cy);
  cy += 4;

  // Sender / merchant
  pdf.text("FROM", ix, cy, { size: 6.5, bold: true, color: COLOR.faint });
  cy += 9;
  cy += pdf.text(`${l.merchant}${l.merchantCode ? ` (${l.merchantCode})` : ""} · ${l.sender.phone}`, ix, cy, { size: 8, bold: true, width: iw, maxLines: 1 });
  const origin = l.intake === "DROP_OFF" ? `Dropped off at ${l.originHub?.name ?? "hub"}` : l.originHub ? `Origin hub: ${l.originHub.code} · ${l.originHub.name}` : "Rider pickup";
  cy += pdf.text(origin, ix, cy, { size: 7.5, color: COLOR.muted, width: iw, maxLines: 1 });
  cy += 3;
  pdf.line(ix, cy, ix + iw, cy);
  cy += 5;

  // Details grid
  // [label, value, columns spanned]: the order ref gets two columns (merchant refs can be long).
  const cells: [string, string, number][] = [
    ["Weight", `${l.weightKg} kg`, 1],
    ["Delivery", l.deliveryMode, 1],
    ["Booked", fmtDate(l.bookedAt), 1],
    ["Order ref", l.orderRef ?? "—", 2],
    [l.isDocument ? "Type" : "Product", l.product ?? (l.isDocument ? "Document" : "Parcel"), 1],
  ];
  const colW = iw / 3;
  let col = 0;
  let row = 0;
  for (const [k, v, span] of cells) {
    if (col + span > 3) (col = 0), row++;
    const cx = ix + col * colW;
    const ry = cy + row * 23;
    const w = colW * span - 4;
    pdf.text(k.toUpperCase(), cx, ry, { size: 6, bold: true, color: COLOR.faint, width: w });
    pdf.text(v, cx, ry + 8, { size: v.length > 22 && span > 1 ? 7 : 8, bold: true, width: w, maxLines: 1 });
    col += span;
  }
  cy += 48;

  // Note + QR at the bottom
  const qr = 60;
  const bottom = y + h - pad;
  const qrY = bottom - qr - 8;
  pdf.qr(l.trackingUrl, ix + iw - qr, qrY, qr);
  pdf.text("Scan to track", ix + iw - qr, qrY + qr, { size: 6, color: COLOR.muted, width: qr, align: "center" });
  const noteW = iw - qr - 8;
  const notes = [l.openBox ? "Open box allowed: recipient may check contents before paying." : null, l.instructions ? `Note: ${l.instructions}` : null].filter(Boolean).join(" ");
  const room = Math.max(0, Math.floor((qrY + qr - 18 - cy) / (7.5 * 1.3)));
  if (notes && room > 0) pdf.text(notes, ix, cy, { size: 7.5, width: noteW, maxLines: Math.min(room, 4) });
  pdf.text(`Label ${n} of ${total}${l.batch ? ` · batch ${l.batch}` : ""} · printed ${fmtDateTime(printedAt)}`, ix, bottom - 8, { size: 6, color: COLOR.faint, width: noteW, maxLines: 1 });
  pdf.text(brand.support ? `Support: ${brand.support}` : brand.website, ix, bottom - 17, { size: 6, color: COLOR.faint, width: noteW, maxLines: 1 });
}

/**
 * Draws labels page by page, yielding to the event loop every few pages so the PDF streams out
 * while it is generated (large batches stay responsive).
 */
export async function drawLabels(pdf: PdfWriter, brand: Brand, labels: LabelData[], format: LabelFormat, printedAt: Date) {
  const total = labels.length;
  const pages = labelPages(format, total);
  for (let p = 0; p < pages; p++) {
    pdf.addPage();
    if (format === "thermal") {
      const inset = 6;
      drawLabel(pdf, brand, labels[p], inset, inset, pdf.width - inset * 2, pdf.height - inset * 2, p + 1, total, printedAt);
    } else {
      const cw = pdf.width / 2;
      const ch = pdf.height / 2;
      const inset = 9;
      for (let k = 0; k < 4; k++) {
        const i = p * 4 + k;
        if (i >= total) break;
        const cx = (k % 2) * cw;
        const cyy = Math.floor(k / 2) * ch;
        drawLabel(pdf, brand, labels[i], cx + inset, cyy + inset, cw - inset * 2, ch - inset * 2, i + 1, total, printedAt);
      }
      // Cut guides
      pdf.line(cw, 0, cw, pdf.height, { color: COLOR.faint, width: 0.4, dash: 3 });
      pdf.line(0, ch, pdf.width, ch, { color: COLOR.faint, width: 0.4, dash: 3 });
      pdf.text(`Page ${p + 1} of ${pages}`, 0, pdf.height - 8.5, { size: 5.5, color: COLOR.faint, width: pdf.width, align: "center" });
    }
    if (p % 10 === 9) await new Promise(resolve => setImmediate(resolve));
  }
}
