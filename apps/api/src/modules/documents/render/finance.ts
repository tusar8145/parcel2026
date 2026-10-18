import { compactHeader, ensureSpace, footers, header, keyValues, MARGIN, pill, signatures, table, totals, type Brand, type DocMeta } from "../pdf/layout";
import { COLOR, fmtAmount, fmtDate, fmtDateTime, PdfWriter } from "../pdf/writer";

export interface FinanceInvoiceDoc {
  number: string;
  status: string;
  overdue: boolean;
  issuedAt: Date;
  dueAt: Date;
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date | null;
  paymentReference: string | null;
  vatRate: number;
  taxableValue: number;
  vatAmount: number;
  total: number;
  seller: { name: string; bin: string; address: string };
  buyer: { name: string; code: string; address: string; phone: string | null };
  lines: { trackingId: string; description: string; amount: number; taxableValue?: number; vat?: number }[];
  createdBy: string | null;
}

const STATUS_COLOR: Record<string, string> = { PAID: COLOR.ok, VOID: COLOR.danger, ISSUED: COLOR.ink };

/** Tax invoice laid out like Mushak-6.3, marked as a draft for the accountant. */
export function drawFinanceInvoice(pdf: PdfWriter, brand: Brand, i: FinanceInvoiceDoc, meta: DocMeta) {
  pdf.addPage();
  let y = header(pdf, brand, meta);
  const newPage = () => compactHeader(pdf, brand, meta);
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  pdf.box(x, y, w, 20, { fill: "#fff8e6", stroke: COLOR.brand, radius: 3 });
  pdf.text("DRAFT FOR ACCOUNTANT REVIEW · Mushak-6.3-style layout. Verify against current NBR requirements before issuing.", x + 8, y + 5, { size: 7.8, bold: true, width: w - 16, maxLines: 1 });
  y += 30;

  const half = (w - 20) / 2;
  const party = (title: string, lines: string[], px: number) => {
    let py = y;
    pdf.text(title, px, py, { size: 7, bold: true, color: COLOR.faint });
    py += 11;
    lines.forEach((t, k) => (py += pdf.text(t, px, py, { size: k === 0 ? 10 : 8.5, bold: k === 0, width: half, maxLines: 3 })));
    return py;
  };
  const a = party("SELLER (SUPPLIER)", [i.seller.name, `BIN: ${i.seller.bin || "— (set in finance settings)"}`, i.seller.address].filter(Boolean), x);
  const b = party("BUYER (RECIPIENT OF SERVICE)", [`${i.buyer.name} (${i.buyer.code})`, "BIN: ______________", i.buyer.address, i.buyer.phone ?? ""].filter(Boolean), x + half + 20);
  y = Math.max(a, b) + 8;
  y = keyValues(
    pdf,
    [
      ["Invoice no.", i.number],
      ["Issued", fmtDate(i.issuedAt)],
      ["Period", `${fmtDate(i.periodStart)} – ${fmtDate(new Date(i.periodEnd.getTime() - 1))}`],
      ["Due", fmtDate(i.dueAt)],
      ["Payment status", i.status === "ISSUED" ? (i.overdue ? "Overdue" : "Unpaid") : i.status === "PAID" ? "Paid" : "Void"],
      ["Paid on", i.paidAt ? fmtDate(i.paidAt) : "—"],
      ["Payment ref.", i.paymentReference ?? "—"],
      ["Prepared by", i.createdBy ?? "Delivery Fast finance"],
    ],
    x,
    y,
    w,
    4,
  );
  pdf.text("Supply details", x, y, { size: 10, bold: true });
  y += 15;
  y = table(pdf, {
    y,
    newPage,
    size: 7.6,
    columns: [
      { header: "#", width: 0.4 },
      { header: "Description of service", width: 3.6 },
      { header: "Unit", width: 0.8 },
      { header: "Qty", width: 0.5, align: "right" },
      { header: "Taxable value (৳)", width: 1.4, align: "right" },
      { header: "VAT rate", width: 0.8, align: "right" },
      { header: "VAT (৳)", width: 1.1, align: "right" },
      { header: "Total incl. VAT (৳)", width: 1.4, align: "right" },
    ],
    rows: i.lines.map((l, k) => [
      String(k + 1),
      { text: l.description, sub: l.trackingId },
      "Service",
      "1",
      fmtAmount(l.taxableValue ?? l.amount),
      `${i.vatRate}%`,
      fmtAmount(l.vat ?? 0),
      fmtAmount(l.amount),
    ]),
    foot: [["", `${i.lines.length} line(s)`, "", "", fmtAmount(i.taxableValue), "", fmtAmount(i.vatAmount), fmtAmount(i.total)]],
    empty: "No lines on this invoice.",
  });
  y = ensureSpace(pdf, y + 10, 170, newPage);
  const balance = i.status === "PAID" || i.status === "VOID" ? 0 : i.total;
  const end = totals(
    pdf,
    [
      { label: "Total taxable value", value: fmtAmount(i.taxableValue) },
      { label: `VAT @ ${i.vatRate}%`, value: fmtAmount(i.vatAmount) },
      { label: "Total incl. VAT", value: `৳ ${fmtAmount(i.total)}`, strong: true },
      { label: "Paid", value: fmtAmount(i.status === "PAID" ? i.total : 0) },
      { label: "Balance due", value: `৳ ${fmtAmount(balance)}`, strong: true },
    ],
    y,
    250,
  );
  pill(pdf, i.status === "ISSUED" ? (i.overdue ? "OVERDUE" : "UNPAID") : i.status, x, y, i.overdue ? COLOR.danger : (STATUS_COLOR[i.status] ?? COLOR.ink));
  pdf.text(`Prices are VAT-inclusive. VAT = amount × ${i.vatRate} / (100 + ${i.vatRate}).`, x, y + 22, { size: 7.5, color: COLOR.muted, width: w - 270 });
  pdf.text(`Pay by bank transfer quoting ${i.number}. Payments are recorded by ${brand.appName} finance.`, x, y + 34, { size: 7.5, color: COLOR.muted, width: w - 270, maxLines: 2 });
  y = ensureSpace(pdf, end + 8, 80, newPage);
  signatures(pdf, ["Authorised signatory (name, designation)", "Received by (buyer)"], y);
  footers(pdf, brand, meta);
}

export interface SettlementDoc {
  number: string;
  status: string;
  merchant: { name: string; code: string };
  autoDrafted: boolean;
  createdBy: string | null;
  approvedBy: string | null;
  createdAt: Date;
  paidAt: Date | null;
  reference: string | null;
  lines: { trackingId: string; deliveredAt: Date | null; codAmount: number; charge: number; net: number }[];
  adjustments: { kind: string; description: string; amount: number }[];
  codTotal: number;
  chargesTotal: number;
  adjustmentsTotal: number;
  netPayable: number;
  carriedForward: number;
  vat: { rate: number; onCharges: number };
}

/** COD settlement statement for a merchant. */
export function drawSettlement(pdf: PdfWriter, brand: Brand, s: SettlementDoc, meta: DocMeta) {
  pdf.addPage();
  let y = header(pdf, brand, meta);
  const newPage = () => compactHeader(pdf, brand, meta);
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  y = keyValues(
    pdf,
    [
      ["Merchant", `${s.merchant.name} (${s.merchant.code})`],
      ["Statement", s.number],
      ["Status", s.status],
      ["Drafted", `${fmtDateTime(s.createdAt)}${s.autoDrafted ? " (automatic)" : s.createdBy ? ` by ${s.createdBy}` : ""}`],
      ["Approved by", s.approvedBy ?? "—"],
      ["Paid", s.paidAt ? fmtDateTime(s.paidAt) : "—"],
      ["Payment ref.", s.reference ?? "—"],
      ["Parcels", String(s.lines.length)],
    ],
    x,
    y,
    w,
    4,
  );
  y = table(pdf, {
    y,
    newPage,
    columns: [
      { header: "#", width: 0.45 },
      { header: "Parcel", width: 2.2, bold: true },
      { header: "Delivered", width: 1.6 },
      { header: "COD collected (৳)", width: 1.6, align: "right" },
      { header: "Delivery charge (৳)", width: 1.6, align: "right" },
      { header: "Net (৳)", width: 1.5, align: "right" },
    ],
    rows: s.lines.map((l, k) => [String(k + 1), l.trackingId, fmtDate(l.deliveredAt), fmtAmount(l.codAmount), fmtAmount(l.charge), fmtAmount(l.net)]),
    foot: [["", `${s.lines.length} parcel(s)`, "", fmtAmount(s.codTotal), fmtAmount(s.chargesTotal), fmtAmount(s.codTotal - s.chargesTotal)]],
    empty: "No collections in this settlement.",
  });
  if (s.adjustments.length) {
    y = ensureSpace(pdf, y + 12, 60, newPage);
    pdf.text("Adjustments", x, y, { size: 10, bold: true });
    y = table(pdf, {
      y: y + 15,
      newPage,
      columns: [
        { header: "Kind", width: 1.6 },
        { header: "Description", width: 4 },
        { header: "Effect on payout (৳)", width: 1.6, align: "right" },
      ],
      rows: s.adjustments.map(a => [a.kind.replace(/_/g, " ").toLowerCase(), a.description, fmtAmount(-a.amount)]),
    });
  }
  y = ensureSpace(pdf, y + 12, 150, newPage);
  const end = totals(
    pdf,
    [
      { label: "COD collected", value: fmtAmount(s.codTotal) },
      { label: `Delivery charges (incl. VAT ${fmtAmount(s.vat.onCharges)} at ${s.vat.rate}%)`, value: `−${fmtAmount(s.chargesTotal)}` },
      { label: "Adjustments", value: fmtAmount(-s.adjustmentsTotal) },
      { label: "Net payable", value: `৳ ${fmtAmount(s.netPayable)}`, strong: true },
      ...(s.carriedForward ? [{ label: "Shortfall carried forward", value: fmtAmount(s.carriedForward) }] : []),
    ],
    y,
    300,
  );
  pill(pdf, s.status === "PAID" ? "PAID" : s.status === "APPROVED" ? "APPROVED · AWAITING PAYMENT" : s.status, x, y, s.status === "PAID" ? COLOR.ok : COLOR.ink);
  y = ensureSpace(pdf, end + 8, 80, newPage);
  signatures(pdf, ["Prepared by (finance)", "Approved by", "Received by (merchant)"], y);
  footers(pdf, brand, meta);
}

export interface StatementDoc {
  merchant: { name: string; code: string };
  period: string;
  document: boolean;
  parcels: { trackingId: string; item: string; branch?: string; reference?: string; service: string; base: number; extra: number; discount: number; total: number; deliveredAt: Date | null }[];
}

/** Pro-forma statement of delivered prepaid parcels not yet on a tax invoice (merchant panels). */
export function drawStatement(pdf: PdfWriter, brand: Brand, d: StatementDoc, meta: DocMeta) {
  pdf.addPage();
  let y = header(pdf, brand, meta);
  const newPage = () => compactHeader(pdf, brand, meta);
  const total = d.parcels.reduce((n, p) => n + p.total, 0);
  y = keyValues(pdf, [["Merchant", `${d.merchant.name} (${d.merchant.code})`], ["Period", d.period], [d.document ? "Consignments" : "Parcels", String(d.parcels.length)], ["Not yet invoiced", `৳ ${fmtAmount(total)}`]], MARGIN, y, pdf.width - MARGIN * 2, 4);
  y = table(pdf, {
    y,
    newPage,
    size: 7.5,
    columns: [
      { header: "Tracking ID", width: 2, bold: true },
      { header: d.document ? "Document type" : "Product", width: 2 },
      ...(d.document ? [{ header: "Origin branch", width: 1.2 }, { header: "Reference", width: 1.4 }] : []),
      { header: "Service", width: 1.3 },
      { header: "Base (৳)", width: 1, align: "right" as const },
      { header: "Weight / service (৳)", width: 1.2, align: "right" as const },
      { header: "Discount (৳)", width: 1, align: "right" as const },
      { header: "Total (৳)", width: 1.1, align: "right" as const },
      { header: "Delivered", width: 1.3 },
    ],
    rows: d.parcels.map(p => [
      p.trackingId,
      p.item,
      ...(d.document ? [p.branch ?? "—", p.reference ?? "—"] : []),
      p.service,
      fmtAmount(p.base),
      fmtAmount(p.extra),
      `−${fmtAmount(p.discount)}`,
      fmtAmount(p.total),
      fmtDate(p.deliveredAt),
    ]),
    foot: [[`${d.parcels.length} delivered`, "", ...(d.document ? ["", ""] : []), "", "", "", "", fmtAmount(total), ""]],
  });
  y = ensureSpace(pdf, y + 10, 70, newPage);
  pdf.text(
    `Pro-forma statement prepared from your delivery records. ${brand.appName} finance issues the tax invoice for each closed month (due 15 days after issue). Charges for cash-on-delivery parcels are deducted from your COD settlement instead.`,
    MARGIN,
    y,
    { size: 8, color: COLOR.muted, width: pdf.width - MARGIN * 2 },
  );
  footers(pdf, brand, meta);
}

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
