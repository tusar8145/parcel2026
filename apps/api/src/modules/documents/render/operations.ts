import { compactHeader, footers, header, keyValues, MARGIN, signatures, table, totals, ensureSpace, type Brand, type Cell, type Column, type DocMeta } from "../pdf/layout";
import { COLOR, fmtAmount, fmtDate, fmtDateTime, MM, PdfWriter, taka } from "../pdf/writer";

const start = (pdf: PdfWriter, brand: Brand, meta: DocMeta) => {
  pdf.addPage();
  return { y: header(pdf, brand, meta), newPage: () => compactHeader(pdf, brand, meta) };
};

const sectionTitle = (pdf: PdfWriter, text: string, y: number) => {
  pdf.text(text, MARGIN, y, { size: 10, bold: true });
  return y + 16;
};

/** A barcode with its value under it, top-right under the header. */
const codeBlock = (pdf: PdfWriter, value: string, y: number, width = 190) => {
  const x = pdf.width - MARGIN - width;
  pdf.barcode(value, x, y, width, 30);
  pdf.text(value, x, y + 31, { size: 8, bold: true, width, align: "center" });
};

// ───────────── linehaul ─────────────

export interface ManifestDoc {
  number: string;
  status: string;
  originHub: { code: string; name: string };
  destHub: { code: string; name: string };
  vehicle: string;
  driverName: string | null;
  driverPhone: string | null;
  plannedDepartureAt: Date | null;
  departedAt: Date | null;
  arrivedAt: Date | null;
  note: string | null;
  bags: { number: string; sealNo: string | null; status: string; parcels: number; weightKg: number; codAmount: number; received: number; missing: number }[];
  parcels: { bag: string; trackingId: string; recipient: string | null; zone: string | null; district: string | null; weightKg: number; codAmount: number; state: string }[];
  totals: { bags: number; parcels: number; weightKg: number; codAmount: number; received: number; missing: number; openDiscrepancies: number };
}

export function drawManifest(pdf: PdfWriter, brand: Brand, t: ManifestDoc, meta: DocMeta) {
  let { y, newPage } = start(pdf, brand, meta);
  codeBlock(pdf, t.number, y);
  y = keyValues(
    pdf,
    [
      ["From", `${t.originHub.code} · ${t.originHub.name}`],
      ["To", `${t.destHub.code} · ${t.destHub.name}`],
      ["Vehicle", t.vehicle],
      ["Driver", [t.driverName, t.driverPhone].filter(Boolean).join(" · ") || "—"],
      ["Planned departure", fmtDateTime(t.plannedDepartureAt)],
      ["Departed", fmtDateTime(t.departedAt)],
      ["Arrived", fmtDateTime(t.arrivedAt)],
      ["Status", t.status],
    ],
    MARGIN,
    y,
    pdf.width - MARGIN * 2 - 210,
    2,
  );
  if (t.note) y += pdf.text(`Note: ${t.note}`, MARGIN, y, { size: 8.5, width: pdf.width - MARGIN * 2, maxLines: 3 }) + 4;
  y = sectionTitle(pdf, `Bags (${t.totals.bags})`, y + 4);
  y = table(pdf, {
    y,
    newPage,
    columns: [
      { header: "Bag", width: 2, bold: true },
      { header: "Seal no.", width: 1.6 },
      { header: "Status", width: 1.3 },
      { header: "Parcels", width: 0.9, align: "right" },
      { header: "Weight (kg)", width: 1, align: "right" },
      { header: "COD (৳)", width: 1.2, align: "right" },
      { header: "Received", width: 0.9, align: "right" },
      { header: "Missing", width: 0.9, align: "right" },
    ],
    rows: t.bags.map(b => [b.number, b.sealNo ?? "Not sealed", b.status, String(b.parcels), String(b.weightKg), fmtAmount(b.codAmount), String(b.received), String(b.missing)]),
    empty: "No bags loaded on this trip.",
  });
  y = ensureSpace(pdf, y + 12, 60, newPage);
  y = sectionTitle(pdf, `Parcels (${t.totals.parcels})`, y);
  y = table(pdf, {
    y,
    newPage,
    size: 7.5,
    columns: [
      { header: "#", width: 0.45 },
      { header: "Bag", width: 1.6 },
      { header: "Tracking ID", width: 2, bold: true },
      { header: "Recipient", width: 2.2 },
      { header: "Destination", width: 2.3 },
      { header: "Weight", width: 0.8, align: "right" },
      { header: "COD (৳)", width: 1, align: "right" },
      { header: "State", width: 1 },
      { header: "Check", width: 0.8 },
    ],
    rows: t.parcels.map((p, i) => [String(i + 1), p.bag, p.trackingId, p.recipient ?? "Pending", [p.zone, p.district].filter(Boolean).join(", ") || "—", `${p.weightKg}`, p.codAmount ? fmtAmount(p.codAmount) : "—", p.state, "[   ]"]),
    foot: [["", "", `${t.totals.parcels} parcel(s)`, "", "", `${t.totals.weightKg}`, fmtAmount(t.totals.codAmount), "", ""]],
    empty: "No parcels.",
  });
  y = ensureSpace(pdf, y + 10, 130, newPage);
  y = totals(
    pdf,
    [
      { label: "Bags", value: String(t.totals.bags) },
      { label: "Parcels", value: String(t.totals.parcels) },
      { label: "Weight", value: `${t.totals.weightKg} kg` },
      { label: "COD carried", value: `৳ ${fmtAmount(t.totals.codAmount)}`, strong: true },
    ],
    y,
    220,
  );
  if (t.totals.received || t.totals.missing || t.totals.openDiscrepancies)
    pdf.text(`Received ${t.totals.received} · missing ${t.totals.missing} · open discrepancies ${t.totals.openDiscrepancies}`, MARGIN, y - 20, { size: 8, color: COLOR.muted });
  y = ensureSpace(pdf, y + 8, 80, newPage);
  signatures(pdf, [`Dispatched by (${t.originHub.code})`, "Driver", `Received by (${t.destHub.code})`], y);
  footers(pdf, brand, meta);
}

export interface BagLabelDoc {
  number: string;
  originHub: { code: string; name: string };
  destHub: { code: string; name: string };
  sealNo: string | null;
  parcels: number;
  weightKg: number;
  codAmount: number;
  trip: string | null;
  sealedAt: Date | null;
}

/** A 100 × 150 mm bag tag. */
export function drawBagLabel(pdf: PdfWriter, brand: Brand, b: BagLabelDoc, printedAt: Date) {
  pdf.addPage();
  const pad = 14;
  const w = pdf.width - pad * 2;
  pdf.box(6, 6, pdf.width - 12, pdf.height - 12, { stroke: COLOR.ink, width: 1.2, radius: 3 });
  let y = pad + 2;
  pdf.logo(pad, y - 2, 20);
  pdf.text(`${brand.appName} · linehaul bag`, pad + 26, y + 1, { size: 11, bold: true, width: w - 26 });
  y += 28;
  pdf.text("TO HUB", pad, y, { size: 7, bold: true, color: COLOR.faint });
  pdf.text(b.destHub.code, pad, y + 9, { size: 30, bold: true, width: w });
  pdf.text(b.destHub.name, pad, y + 46, { size: 11, bold: true, width: w, maxLines: 1 });
  y += 66;
  pdf.text(`From ${b.originHub.code} · ${b.originHub.name}`, pad, y, { size: 9, width: w, maxLines: 1 });
  y += 18;
  pdf.barcode(b.number, pad, y, w, 56);
  pdf.text(b.number, pad, y + 58, { size: 13, bold: true, width: w, align: "center" });
  y += 82;
  y = keyValues(
    pdf,
    [
      ["Seal no.", b.sealNo ?? "Not sealed"],
      ["Sealed", fmtDateTime(b.sealedAt)],
      ["Parcels", String(b.parcels)],
      ["Weight", `${b.weightKg} kg`],
      ["COD inside", taka(b.codAmount)],
      ["Trip", b.trip ?? "—"],
    ],
    pad,
    y,
    w,
    2,
    10,
  );
  pdf.text(`Printed ${fmtDateTime(printedAt)} · check the seal number on arrival`, pad, pdf.height - pad - 10, { size: 6.5, color: COLOR.faint, width: w });
}

export const BAG_LABEL_SIZE: [number, number] = [100 * MM, 150 * MM];

// ───────────── rider run sheet ─────────────

export interface RunSheetDoc {
  rider: { code: string; name: string; phone: string | null; hub: string | null; vehicle: string | null };
  date: string;
  routed: boolean;
  stops: {
    seq: number;
    kind: "Delivery" | "Pickup" | "Return";
    trackingId: string;
    name: string | null;
    phone: string | null;
    address: string;
    zone: string | null;
    codAmount: number;
    status: string;
    note: string | null;
    orderRef: string | null;
  }[];
}

export function drawRunSheet(pdf: PdfWriter, brand: Brand, r: RunSheetDoc, meta: DocMeta) {
  let { y, newPage } = start(pdf, brand, meta);
  const deliveries = r.stops.filter(s => s.kind === "Delivery");
  const cod = deliveries.reduce((n, s) => n + s.codAmount, 0);
  y = keyValues(
    pdf,
    [
      ["Rider", `${r.rider.code} · ${r.rider.name}`],
      ["Phone", r.rider.phone ?? "—"],
      ["Hub", r.rider.hub ?? "—"],
      ["Vehicle", r.rider.vehicle ?? "—"],
      ["Date", fmtDate(`${r.date}T06:00:00Z`)],
      ["Stops", `${r.stops.length} (${deliveries.length} deliveries, ${r.stops.length - deliveries.length} pickups/returns)`],
      ["COD to collect", taka(cod)],
      ["Order", r.routed ? "Optimised route order" : "Grouped by zone and area"],
    ],
    MARGIN,
    y,
    pdf.width - MARGIN * 2,
    4,
  );
  y = table(pdf, {
    y: y + 2,
    newPage,
    size: 7.5,
    columns: [
      { header: "#", width: 0.45, bold: true },
      { header: "Task", width: 0.9 },
      { header: "Tracking ID", width: 1.9, bold: true },
      { header: "Name & phone", width: 2.2 },
      { header: "Address", width: 3.6 },
      { header: "COD (৳)", width: 1.1, align: "right", bold: true },
      { header: "Status", width: 1.4 },
      { header: "Result / received by", width: 2.2 },
      { header: "Sign", width: 1.2 },
    ] satisfies Column[],
    rows: r.stops.map(s => [
      String(s.seq),
      s.kind,
      { text: s.trackingId, sub: s.orderRef ? `ref ${s.orderRef}` : undefined },
      { text: s.name ?? "Pending", sub: s.phone ?? undefined },
      { text: s.address, sub: s.note ? `Note: ${s.note}` : undefined },
      s.kind === "Delivery" ? (s.codAmount ? fmtAmount(s.codAmount) : "Prepaid") : "—",
      s.status,
      "",
      "",
    ]),
    foot: [["", "", `${r.stops.length} stop(s)`, "", "", fmtAmount(cod), "", "", ""]],
    empty: "No parcels are assigned to this rider for this day.",
    minRow: 30,
  });
  y = ensureSpace(pdf, y + 10, 150, newPage);
  y = totals(
    pdf,
    [
      { label: "Deliveries", value: String(deliveries.length) },
      { label: "Pickups / returns", value: String(r.stops.length - deliveries.length) },
      { label: "COD to collect", value: `৳ ${fmtAmount(cod)}`, strong: true },
      { label: "COD handed over at hub", value: "৳ ____________" },
    ],
    y,
    260,
  );
  y = ensureSpace(pdf, y + 6, 80, newPage);
  signatures(pdf, ["Rider", "Dispatcher (hand-out)", "Cash received by (hub)"], y);
  footers(pdf, brand, meta);
}

// ───────────── return run ─────────────

export interface ReturnRunDoc {
  number: string;
  status: string;
  merchant: { code: string; name: string; address: string; phone: string | null };
  rider: string | null;
  hub: string | null;
  note: string | null;
  createdAt: Date;
  dispatchedAt: Date | null;
  completedAt: Date | null;
  parcels: { trackingId: string; recipient: string | null; reason: string | null; attempts: number; codAmount: number; returnCharge: number | null; status: string }[];
  returnCharges: number;
}

export function drawReturnRun(pdf: PdfWriter, brand: Brand, r: ReturnRunDoc, meta: DocMeta) {
  let { y, newPage } = start(pdf, brand, meta);
  codeBlock(pdf, r.number, y);
  y = keyValues(
    pdf,
    [
      ["Return to", `${r.merchant.name} (${r.merchant.code})`],
      ["Address", r.merchant.address || "—"],
      ["Contact", r.merchant.phone ?? "—"],
      ["Rider", r.rider ?? "Not assigned"],
      ["Hub", r.hub ?? "—"],
      ["Status", r.status],
      ["Planned", fmtDateTime(r.createdAt)],
      ["Dispatched", fmtDateTime(r.dispatchedAt)],
    ],
    MARGIN,
    y,
    pdf.width - MARGIN * 2 - 210,
    2,
  );
  if (r.note) y += pdf.text(`Note: ${r.note}`, MARGIN, y, { size: 8.5, width: pdf.width - MARGIN * 2, maxLines: 3 }) + 4;
  y = table(pdf, {
    y: y + 4,
    newPage,
    columns: [
      { header: "#", width: 0.45 },
      { header: "Tracking ID", width: 2, bold: true },
      { header: "Recipient", width: 2 },
      { header: "Return reason", width: 3 },
      { header: "Attempts", width: 0.9, align: "right" },
      { header: "Return charge (৳)", width: 1.3, align: "right" },
      { header: "Status", width: 1.4 },
      { header: "Received", width: 0.9 },
    ],
    rows: r.parcels.map((p, i) => [String(i + 1), p.trackingId, p.recipient ?? "—", p.reason ?? "—", String(p.attempts), p.returnCharge != null ? fmtAmount(p.returnCharge) : "—", p.status, "[   ]"]),
    foot: [["", `${r.parcels.length} parcel(s)`, "", "", "", fmtAmount(r.returnCharges), "", ""]],
    empty: "No parcels on this run.",
  });
  y = ensureSpace(pdf, y + 14, 80, newPage);
  signatures(pdf, ["Rider", "Received by (merchant: name & signature)", "Hub"], y);
  footers(pdf, brand, meta);
}

// ───────────── CN stock ─────────────

export interface CnSheetDoc {
  number: string;
  hub: string | null;
  merchant: string | null;
  labels: { cn: string; reprint: boolean }[];
}

/** A4 sheet of 3 × 8 CN stickers (70 × 37 mm). */
export function drawCnSheet(pdf: PdfWriter, brand: Brand, d: CnSheetDoc, meta: DocMeta) {
  const cols = 3;
  const rows = 8;
  const per = cols * rows;
  const cw = pdf.width / cols;
  const top = 18;
  const ch = (pdf.height - top - 18) / rows;
  const pages = Math.ceil(d.labels.length / per);
  for (let p = 0; p < pages; p++) {
    pdf.addPage();
    pdf.text(`${brand.appName} · CN batch ${d.number}${d.hub ? ` · ${d.hub}` : ""}${d.merchant ? ` · issued to ${d.merchant}` : ""}`, 14, 5, { size: 6.5, color: COLOR.faint, width: pdf.width - 120 });
    d.labels.slice(p * per, (p + 1) * per).forEach((l, k) => {
      const x = (k % cols) * cw;
      const y = top + Math.floor(k / cols) * ch;
      const pad = 9;
      pdf.box(x + 4, y + 3, cw - 8, ch - 6, { stroke: COLOR.line, width: 0.5, radius: 3 });
      pdf.logo(x + pad, y + pad - 2, 11);
      pdf.text(brand.appName, x + pad + 14, y + pad - 1, { size: 7, bold: true, width: cw - pad * 2 - 14 });
      if (l.reprint) pdf.text("REPRINT", x + pad, y + pad - 1, { size: 6, bold: true, color: COLOR.danger, width: cw - pad * 2, align: "right" });
      pdf.barcode(l.cn, x + pad, y + pad + 12, cw - pad * 2, ch - pad * 2 - 30);
      pdf.text(l.cn, x + pad, y + ch - pad - 15, { size: 9, bold: true, width: cw - pad * 2, align: "center" });
      pdf.text(d.merchant ? `Issued to ${d.merchant}` : d.number, x + pad, y + ch - pad - 5, { size: 5.5, color: COLOR.muted, width: cw - pad * 2, align: "center", maxLines: 1 });
    });
    pdf.text(`Page ${p + 1} of ${pages} · ${d.labels.length} label(s) · ${fmtDateTime(meta.generatedAt)}`, 14, pdf.height - 13, { size: 6.5, color: COLOR.faint, width: pdf.width - 28, align: "right" });
  }
}

// ───────────── reports ─────────────

export interface TableDoc {
  intro?: [string, string][];
  sections: { title?: string; header: string[]; rows: Cell[][]; foot?: Cell[][]; align?: ("left" | "right")[] }[];
}

/** Generic report: key facts then one or more tables (numbers right-aligned). */
export function drawTableDoc(pdf: PdfWriter, brand: Brand, d: TableDoc, meta: DocMeta) {
  let { y, newPage } = start(pdf, brand, meta);
  if (d.intro?.length) y = keyValues(pdf, d.intro, MARGIN, y, pdf.width - MARGIN * 2, 4);
  for (const s of d.sections) {
    if (s.title) {
      y = ensureSpace(pdf, y + 6, 60, newPage);
      y = sectionTitle(pdf, s.title, y);
    }
    const numeric = s.header.map((_, i) => s.align?.[i] ?? (s.rows.length && s.rows.every(r => /^[-−]?[৳\d.,\s%]+$/.test(String((r[i] && typeof r[i] === "object" ? (r[i] as { text: string }).text : r[i]) ?? "").trim()) || r[i] == null || r[i] === "") ? "right" : "left"));
    y = table(pdf, {
      y,
      newPage,
      size: s.header.length > 9 ? 6.8 : 7.8,
      columns: s.header.map((h, i) => ({ header: h, width: Math.max(1, Math.min(3, h.length / 6)), align: numeric[i] })),
      rows: s.rows,
      foot: s.foot,
      empty: "No rows for this period.",
    });
    y += 8;
  }
  footers(pdf, brand, meta);
}

export { totals, signatures };
