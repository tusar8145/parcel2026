import { compactHeader, ensureSpace, footers, header, keyValues, MARGIN, signatures, table, totals, type Brand, type DocMeta } from "../pdf/layout";
import { fmtAmount, fmtDate, fmtDateTime, PdfWriter } from "../pdf/writer";

export interface FranchiseInvoiceDoc {
  number: string;
  status: string;
  settlement: string;
  createdAt: Date;
  periodFrom: Date;
  periodTo: Date;
  amount: number;
  paidAt: Date | null;
  paymentMethod: string | null;
  reference: string | null;
  franchise: { name: string; code: string; hub: string; contactName: string; contactPhone: string; address: string };
  lines: { trackingId: string; type: string; base: number; percent: number; minimum: number; amount: number; earnedAt: Date }[];
}

const TYPE_LABEL: Record<string, string> = { PICKUP: "Pickup", DELIVERY: "Delivery", RETURN: "Return" };

/** A franchise's commission invoice: every parcel event, its delivery charge, rate and commission. */
export function drawFranchiseInvoice(pdf: PdfWriter, brand: Brand, i: FranchiseInvoiceDoc, meta: DocMeta) {
  pdf.addPage();
  let y = header(pdf, brand, meta);
  const newPage = () => compactHeader(pdf, brand, meta);
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  y = keyValues(
    pdf,
    [
      ["Franchise", `${i.franchise.name} (${i.franchise.code})`],
      ["Hub", i.franchise.hub],
      ["Contact", `${i.franchise.contactName} · ${i.franchise.contactPhone}`],
      ["Address", i.franchise.address],
      ["Invoice", i.number],
      ["Period", `${fmtDate(i.periodFrom)} – ${fmtDate(i.periodTo)}`],
      ["Settlement", i.settlement === "DEDUCTED" ? "Deducted from cash deposits" : "Paid by Delivery Fast"],
      ["Status", i.paidAt ? `Paid ${fmtDateTime(i.paidAt)}${i.reference ? ` · ${i.reference}` : ""}` : i.status],
    ],
    x,
    y,
    w,
    2,
  );
  y = table(pdf, {
    y: y + 4,
    newPage,
    columns: [
      { header: "#", width: 0.45 },
      { header: "Parcel", width: 2.1, bold: true },
      { header: "Event", width: 1 },
      { header: "Date", width: 1.3 },
      { header: "Delivery charge (৳)", width: 1.5, align: "right" },
      { header: "Rate", width: 1.4, align: "right" },
      { header: "Commission (৳)", width: 1.5, align: "right" },
    ],
    rows: i.lines.map((l, k) => [String(k + 1), l.trackingId, TYPE_LABEL[l.type] ?? l.type, fmtDate(l.earnedAt), fmtAmount(l.base), `${l.percent}%${l.minimum ? ` (min ${fmtAmount(l.minimum)})` : ""}`, fmtAmount(l.amount)]),
    foot: [["", `${i.lines.length} event(s)`, "", "", "", "", fmtAmount(i.amount)]],
    empty: "No commission on this invoice.",
  });
  y = ensureSpace(pdf, y + 12, 60, newPage);
  y = totals(pdf, [{ label: "Total commission", value: `৳ ${fmtAmount(i.amount)}`, strong: true }], y);
  signatures(pdf, ["Franchise", "Delivery Fast finance"], ensureSpace(pdf, y + 30, 50, newPage));
  footers(pdf, brand, meta);
}
