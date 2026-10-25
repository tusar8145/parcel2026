import { compactHeader, ensureSpace, footers, header, keyValues, MARGIN, pill, signatures, table, totals, type Brand, type DocMeta } from "../pdf/layout";
import { COLOR, fmtAmount, fmtDate, fmtDateTime, PdfWriter } from "../pdf/writer";

// Accounts PDFs: settlement (ST-), bill (INV-), account statement, rider handover slip (HS-), hub transfer (HT-).

const tk = (n: number) => `৳ ${fmtAmount(n)}`;
const payToLines = (p: Record<string, unknown> | null | undefined): [string, string][] =>
  p
    ? ([
        ["Method", String(p.method ?? "—")],
        ["Account name", String(p.accountName ?? "—")],
        ["Account / wallet", String(p.accountNumber ?? "—")],
        ...(p.bankName ? ([["Bank", `${p.bankName}${p.branch ? `, ${p.branch}` : ""}`]] as [string, string][]) : []),
        ...(p.routingNumber ? ([["Routing number", String(p.routingNumber)]] as [string, string][]) : []),
      ] as [string, string][])
    : [["Pay to", "No payout account on file"]];

export interface PayoutDoc {
  number: string;
  status: string;
  account: { name: string; kind: string };
  createdAt: Date;
  paidAt: Date | null;
  method: string | null;
  reference: string | null;
  receipt: boolean;
  payTo: Record<string, unknown> | null;
  createdBy: string | null;
  paidBy: string | null;
  parcels: { trackingId: string; date: Date; cod: number; charge: number; returnCharge: number; net: number }[];
  other: { description: string; amount: number; date: Date }[];
  codTotal: number;
  chargesTotal: number;
  adjustmentsTotal: number;
  amount: number;
}

/** ST-: what was settled (COD − charges ± adjustments), where it was paid and how. */
export function drawPayout(pdf: PdfWriter, brand: Brand, s: PayoutDoc, meta: DocMeta) {
  pdf.addPage();
  let y = header(pdf, brand, meta);
  const newPage = () => compactHeader(pdf, brand, meta);
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  y = keyValues(
    pdf,
    [
      ["Settlement no.", s.number],
      ["Paid to", s.account.name],
      ["Created", fmtDateTime(s.createdAt)],
      ["Status", s.status === "PAID" ? `Paid ${s.paidAt ? fmtDateTime(s.paidAt) : ""}` : s.status === "CANCELLED" ? "Cancelled" : "To be paid"],
      ["Paid by", s.method ? `${s.method}${s.reference ? ` · ${s.reference}` : ""}` : "—"],
      ["Receipt", s.receipt ? "Photo attached" : "—"],
    ],
    x,
    y,
    w,
    3,
  );
  pdf.text("Pay to", x, y, { size: 10, bold: true });
  y = keyValues(pdf, payToLines(s.payTo), x, y + 14, w, 3);
  pdf.text("Parcels", x, y, { size: 10, bold: true });
  y = table(pdf, {
    y: y + 14,
    newPage,
    size: 7.8,
    columns: [
      { header: "#", width: 0.4 },
      { header: "Tracking ID", width: 2.2 },
      { header: "Date", width: 1.6 },
      { header: "COD (৳)", width: 1.2, align: "right" },
      { header: "Delivery charge (৳)", width: 1.4, align: "right" },
      { header: "Return charge (৳)", width: 1.3, align: "right" },
      { header: "Net (৳)", width: 1.2, align: "right" },
    ],
    rows: s.parcels.map((p, i) => [String(i + 1), p.trackingId, fmtDate(p.date), fmtAmount(p.cod), fmtAmount(p.charge), p.returnCharge ? fmtAmount(p.returnCharge) : "—", fmtAmount(p.net)]),
    foot: [["", `${s.parcels.length} parcel(s)`, "", fmtAmount(s.codTotal), "", "", ""]],
    empty: "No parcels.",
  });
  if (s.other.length) {
    y = ensureSpace(pdf, y + 10, 60, newPage);
    pdf.text("Adjustments", x, y, { size: 10, bold: true });
    y = table(pdf, {
      y: y + 14,
      newPage,
      size: 7.8,
      columns: [
        { header: "Date", width: 1.4 },
        { header: "Reason", width: 6 },
        { header: "Amount (৳)", width: 1.4, align: "right" },
      ],
      rows: s.other.map(o => [fmtDate(o.date), o.description, fmtAmount(o.amount)]),
    });
  }
  y = ensureSpace(pdf, y + 12, 120, newPage);
  const end = totals(
    pdf,
    [
      { label: "COD collected", value: fmtAmount(s.codTotal) },
      { label: "Delivery & return charges", value: `−${fmtAmount(s.chargesTotal)}` },
      ...(s.adjustmentsTotal ? [{ label: "Adjustments", value: fmtAmount(s.adjustmentsTotal) }] : []),
      { label: "Net paid", value: tk(s.amount), strong: true },
    ],
    y,
  );
  pill(pdf, s.status === "PAID" ? "PAID" : s.status === "CANCELLED" ? "CANCELLED" : "TO BE PAID", x, y, s.status === "PAID" ? COLOR.ok : s.status === "CANCELLED" ? COLOR.danger : COLOR.ink);
  pdf.text(`Prepared by ${s.createdBy ?? brand.appName}${s.paidBy ? ` · paid by ${s.paidBy}` : ""}.`, x, y + 22, { size: 7.5, color: COLOR.muted, width: w - 270 });
  signatures(pdf, ["Authorised signatory", "Received by"], ensureSpace(pdf, end + 10, 70, newPage));
  footers(pdf, brand, meta);
}

export interface BillDoc {
  number: string;
  status: string;
  account: { name: string };
  buyer: { code: string | null; address: string; phone: string | null };
  from: string;
  to: string;
  issuedAt: Date;
  total: number;
  paid: number;
  due: number;
  lines: { trackingId: string | null; description: string; orderRef: string | null; recipient: string | null; date: Date; amount: number }[];
  payments: { number: string; method: string; reference: string | null; paidOn: Date; amount: number }[];
}

/** INV-: a Financial merchant's bill: the chosen parcels' charges, payments so far and what's due. */
export function drawBill(pdf: PdfWriter, brand: Brand, b: BillDoc, meta: DocMeta) {
  pdf.addPage();
  let y = header(pdf, brand, meta);
  const newPage = () => compactHeader(pdf, brand, meta);
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  const half = (w - 20) / 2;
  const party = (title: string, lines: string[], px: number) => {
    let py = y;
    pdf.text(title, px, py, { size: 7, bold: true, color: COLOR.faint });
    py += 11;
    lines.forEach((t, k) => (py += pdf.text(t, px, py, { size: k === 0 ? 10 : 8.5, bold: k === 0, width: half, maxLines: 3 })));
    return py;
  };
  const a = party("FROM", [brand.legalName || brand.appName, brand.address].filter(Boolean), x);
  const c = party("BILL TO", [`${b.account.name}${b.buyer.code ? ` (${b.buyer.code})` : ""}`, b.buyer.address, b.buyer.phone ?? ""].filter(Boolean), x + half + 20);
  y = Math.max(a, c) + 8;
  y = keyValues(
    pdf,
    [
      ["Bill no.", b.number],
      ["Issued", fmtDate(b.issuedAt)],
      ["Parcels delivered", `${b.from} to ${b.to}`],
      ["Status", b.status === "PAID" ? "Paid" : b.status === "PARTLY_PAID" ? "Partly paid" : b.status === "VOID" ? "Void" : "Unpaid"],
    ],
    x,
    y,
    w,
    4,
  );
  y = table(pdf, {
    y,
    newPage,
    size: 7.8,
    columns: [
      { header: "#", width: 0.4 },
      { header: "Tracking ID", width: 2 },
      { header: "Reference", width: 1.5 },
      { header: "Recipient", width: 2 },
      { header: "Date", width: 1.3 },
      { header: "Description", width: 1.6 },
      { header: "Amount (৳)", width: 1.3, align: "right" },
    ],
    rows: b.lines.map((l, i) => [String(i + 1), l.trackingId ?? "—", l.orderRef ?? "—", l.recipient ?? "—", fmtDate(l.date), l.description, fmtAmount(l.amount)]),
    foot: [["", `${b.lines.length} line(s)`, "", "", "", "", fmtAmount(b.total)]],
    empty: "No lines on this bill.",
  });
  if (b.payments.length) {
    y = ensureSpace(pdf, y + 10, 60, newPage);
    pdf.text("Payments", x, y, { size: 10, bold: true });
    y = table(pdf, {
      y: y + 14,
      newPage,
      size: 7.8,
      columns: [
        { header: "Payment", width: 1.6 },
        { header: "Paid on", width: 1.4 },
        { header: "Method", width: 1.4 },
        { header: "Reference", width: 2.6 },
        { header: "Amount (৳)", width: 1.4, align: "right" },
      ],
      rows: b.payments.map(p => [p.number, fmtDate(p.paidOn), p.method, p.reference ?? "—", fmtAmount(p.amount)]),
    });
  }
  y = ensureSpace(pdf, y + 12, 120, newPage);
  const end = totals(
    pdf,
    [
      { label: "Total", value: tk(b.total), strong: true },
      { label: "Paid", value: fmtAmount(b.paid) },
      { label: "Due", value: tk(b.due), strong: true },
    ],
    y,
  );
  pill(pdf, b.status === "PAID" ? "PAID" : b.status === "PARTLY_PAID" ? "PARTLY PAID" : b.status === "VOID" ? "VOID" : "UNPAID", x, y, b.status === "PAID" ? COLOR.ok : b.status === "VOID" ? COLOR.danger : COLOR.ink);
  pdf.text(`Pay by bank transfer or mobile banking quoting ${b.number}. Part payments are welcome.`, x, y + 22, { size: 7.5, color: COLOR.muted, width: w - 270, maxLines: 2 });
  signatures(pdf, ["Authorised signatory", "Received by"], ensureSpace(pdf, end + 10, 70, newPage));
  footers(pdf, brand, meta);
}

export interface AccountStatementDoc {
  account: { name: string; code: string | null; kind: string };
  from: string | null;
  to: string | null;
  opening: number;
  closing: number;
  lines: { date: Date; trackingId: string | null; description: string; reference: string | null; amount: number; balance: number }[];
}

/** The statement: every money line with the running balance (+ owed to the account, − owed by it). */
export function drawAccountStatement(pdf: PdfWriter, brand: Brand, d: AccountStatementDoc, meta: DocMeta) {
  pdf.addPage();
  let y = header(pdf, brand, meta);
  const newPage = () => compactHeader(pdf, brand, meta);
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  const owes = d.account.kind === "FINANCIAL";
  y = keyValues(
    pdf,
    [
      ["Account", `${d.account.name}${d.account.code ? ` (${d.account.code})` : ""}`],
      ["Period", `${d.from ?? "Start"} to ${d.to ?? "today"}`],
      ["Opening balance", fmtAmount(d.opening)],
      ["Closing balance", fmtAmount(d.closing)],
    ],
    x,
    y,
    w,
    4,
  );
  y = table(pdf, {
    y,
    newPage,
    size: 7.6,
    columns: [
      { header: "Date", width: 1.5 },
      { header: "Tracking ID", width: 1.8 },
      { header: "Description", width: 3 },
      { header: "Reference", width: 1.4 },
      { header: "Amount (৳)", width: 1.2, align: "right" },
      { header: "Balance (৳)", width: 1.3, align: "right" },
    ],
    rows: [
      ["", "", { text: "Opening balance", bold: true }, "", "", fmtAmount(d.opening)],
      ...d.lines.map(l => [fmtDateTime(l.date), l.trackingId ?? "", l.description, l.reference ?? "", fmtAmount(l.amount), fmtAmount(l.balance)]),
    ],
    foot: [["", `${d.lines.length} line(s)`, "Closing balance", "", "", fmtAmount(d.closing)]],
  });
  y = ensureSpace(pdf, y + 10, 40, newPage);
  pdf.text(
    owes
      ? "Charges are minus, payments plus. A minus balance is what is due to " + brand.appName + "."
      : "COD is plus, charges and payouts minus. A plus balance is what " + brand.appName + " still owes you (including cash on its way).",
    x,
    y,
    { size: 7.5, color: COLOR.muted, width: w },
  );
  footers(pdf, brand, meta);
}

export interface CashSlipDoc {
  number: string;
  status: string;
  rider: { code: string; name: string; phone: string | null };
  hub: string;
  createdAt: Date;
  cod: number;
  due: number;
  expected: number;
  received: number | null;
  parcels: { trackingId: string; recipient: string | null; amount: number }[];
}

/** HS-: the rider's handover slip with its barcode; the hub scans it and counts the cash. */
export function drawCashSlip(pdf: PdfWriter, brand: Brand, s: CashSlipDoc, meta: DocMeta) {
  pdf.addPage();
  let y = header(pdf, brand, meta);
  const newPage = () => compactHeader(pdf, brand, meta);
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  pdf.barcode(s.number, x, y, 220, 46);
  pdf.text(s.number, x, y + 50, { size: 11, bold: true });
  pdf.text(tk(s.expected), x + w - 200, y + 6, { size: 22, bold: true, width: 200, align: "right" });
  pdf.text("to hand over", x + w - 200, y + 34, { size: 8, color: COLOR.muted, width: 200, align: "right" });
  y += 74;
  y = keyValues(
    pdf,
    [
      ["Rider", `${s.rider.code} · ${s.rider.name}`],
      ["Hub", s.hub],
      ["Made", fmtDateTime(s.createdAt)],
      ["Status", s.status === "RECEIVED" ? `Received ${s.received != null ? tk(s.received) : ""}` : s.status === "CANCELLED" ? "Cancelled" : "To hand over"],
      ["COD", fmtAmount(s.cod)],
      ["Earlier due", s.due ? fmtAmount(s.due) : "—"],
    ],
    x,
    y,
    w,
    3,
  );
  y = table(pdf, {
    y,
    newPage,
    size: 8,
    columns: [
      { header: "#", width: 0.4 },
      { header: "Tracking ID", width: 2.4 },
      { header: "Recipient", width: 3.6 },
      { header: "COD (৳)", width: 1.4, align: "right" },
    ],
    rows: s.parcels.map((p, i) => [String(i + 1), p.trackingId, p.recipient ?? "—", fmtAmount(p.amount)]),
    foot: [["", `${s.parcels.length} parcel(s)`, "", fmtAmount(s.cod)]],
  });
  signatures(pdf, ["Rider", "Received by (hub)"], ensureSpace(pdf, y + 20, 70, newPage));
  footers(pdf, brand, meta);
}

export interface HubTransferDoc {
  number: string;
  status: string;
  from: string;
  to: string;
  sentAt: Date;
  sentBy: string | null;
  method: string;
  reference: string | null;
  amount: number;
  received: number | null;
  receivedAt: Date | null;
  slips: { number: string; rider: string; amount: number }[];
  counter: number;
  due: number;
}

/** HT-: cash a hub sent to the central hub, slip by slip. */
export function drawHubTransfer(pdf: PdfWriter, brand: Brand, t: HubTransferDoc, meta: DocMeta) {
  pdf.addPage();
  let y = header(pdf, brand, meta);
  const newPage = () => compactHeader(pdf, brand, meta);
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  pdf.barcode(t.number, x, y, 220, 46);
  pdf.text(t.number, x, y + 50, { size: 11, bold: true });
  pdf.text(tk(t.amount), x + w - 200, y + 6, { size: 22, bold: true, width: 200, align: "right" });
  y += 74;
  y = keyValues(
    pdf,
    [
      ["From", t.from],
      ["To", t.to],
      ["Sent", `${fmtDateTime(t.sentAt)}${t.sentBy ? ` · ${t.sentBy}` : ""}`],
      ["How", `${t.method}${t.reference ? ` · ${t.reference}` : ""}`],
      ["Status", t.status === "RECEIVED" ? `Received ${t.received != null ? tk(t.received) : ""}` : t.status === "CANCELLED" ? "Cancelled" : "In transit"],
      ["Received", t.receivedAt ? fmtDateTime(t.receivedAt) : "—"],
    ],
    x,
    y,
    w,
    3,
  );
  y = table(pdf, {
    y,
    newPage,
    size: 8,
    columns: [
      { header: "Slip", width: 2 },
      { header: "Rider", width: 4 },
      { header: "Amount (৳)", width: 1.4, align: "right" },
    ],
    rows: [
      ...t.slips.map(s => [s.number, s.rider, fmtAmount(s.amount)]),
      ...(t.counter ? [["Counter", "Paid at the hub counter / franchise deposits", fmtAmount(t.counter)]] : []),
      ...(t.due ? [["Due", "Earlier shortfall of this hub", fmtAmount(t.due)]] : []),
    ],
    foot: [["Total", "", fmtAmount(t.amount)]],
  });
  signatures(pdf, ["Sent by", "Received by (central hub)"], ensureSpace(pdf, y + 20, 70, newPage));
  footers(pdf, brand, meta);
}
