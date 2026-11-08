/**
 * The views made of parcel lists: New orders, All parcels (4 tabs), Problems (4 tabs), and the stage tables of
 * Pickup, Delivery, Hub desk › At my hub, Transfers › On the road and Returns (bridge-nav.js decorate()).
 */
import { num } from "@/lib/format";
import { useOps } from "@/lib/ops";
import { PageHeading } from "@/ui/kit";
import { viewById } from "@/app/nav";
import ParcelTable from "@/features/parcels/ParcelTable";
import { useParcelList } from "@/features/parcels/useParcelList";
import { ExportButton, PrintMenu } from "@/features/parcels/HeadingTools";
import { Button } from "@/ui/kit";
import { openBooking, type BookingLine } from "@/features/booking/Booking";
import { openScanWithPhone } from "@/features/imports/ScanWithPhone";
import { useImportConfig } from "@/features/imports/ImportButtons";
import ViewTabs from "@/app/ViewTabs";
import { SlaAlerts } from "./Reports";
import { BulkUpdateButton, ImportButtons } from "@/features/imports/ImportButtons";
import type { ListFilters } from "@/features/parcels/useParcelList";
import { parseParcelStatus } from "@delivery-fast/shared/dist/parcel-status.js";

export function NewOrders() {
  const view = viewById("New orders")!;
  const list = useParcelList({ id: "new-orders", params: { stage: "new" }, noun: "order", empty: "No orders are waiting for operations." });
  const ops = useOps();
  const importConfig = useImportConfig("ecommerce", ["customer", "ecommerce", "document"]);
  return (
    <>
      <PageHeading
        title="New orders"
        subtitle={view.subtitle}
        actions={
          <>
            {ops.can("dispatch") ? (
              <Button variant="primary" icon="plus" onClick={() => void openBooking()}>
                New order
              </Button>
            ) : null}
            <ImportButtons kind="ecommerce" kinds={["customer", "ecommerce", "document"]} />
            {ops.can("dispatch") ? (
              <Button icon="camera" title="Photograph parcel labels with a phone: each photo becomes an order row" onClick={() => void openScanWithPhone(importConfig)}>
                Scan with phone
              </Button>
            ) : null}
            <BulkUpdateButton kind="new_orders" label="Bulk update Excel" />
            <BulkUpdateButton kind="new_orders" history />
            <PrintMenu list={list} title="New orders" />
            <ExportButton list={list} />
          </>
        }
      />
      <ParcelTable
        list={list}
        options={{
          title: "Orders waiting for operations",
          subtitle: "Newest first · 100 a page · tick orders to accept and assign them together",
          lines: true,
          merchants: true,
          dates: true,
          bulkAccept: true,
        }}
      />
    </>
  );
}

const ALL_TABS: Record<string, { page: string; line?: string; merchants?: boolean; activeKey?: string; kind: "customer" | "ecommerce" | "document"; bulkLine?: string; booking?: BookingLine }> = {
  All: { page: "Shipments", kind: "ecommerce" },
  "E-commerce": { page: "E-commerce operations", line: "ECOMMERCE", activeKey: "ecommerce", kind: "ecommerce", bulkLine: "ecommerce", booking: "ecommerce" },
  "Banking & Financial": { page: "Banking & Financial operations", line: "BANKING_FINANCIAL", activeKey: "documents", kind: "document", bulkLine: "document", booking: "banking" },
  Customer: { page: "Customer parcels", line: "CUSTOMER", merchants: false, activeKey: "customer", kind: "customer", bulkLine: "customer", booking: "walkin" },
};


/** The list's filters as the bulk update dialog's starting point (bridge-bulk.js config("all")). */
function bulkFilters(f: ListFilters) {
  const out: Record<string, string | boolean> = {};
  if (f.status === "Needs info") out.incomplete = true;
  else if (f.status) {
    const status = parseParcelStatus(f.status);
    if (status) out.status = status;
  }
  if (f.merchantId) out.merchantId = f.merchantId;
  if (f.dateField === "status") out.dateField = "status";
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  return out;
}

export function AllParcels({ tab }: { tab: string }) {
  const t = ALL_TABS[tab] ?? ALL_TABS.All;
  const ops = useOps();
  const list = useParcelList({ id: `all-${tab}`, params: t.line ? { line: t.line } : {}, register: true, empty: "No parcels match." });
  const s = ops.overview?.shipments;
  const active = t.activeKey ? ops.overview?.serviceLines?.[t.activeKey] : null;
  const newLabel = tab === "Customer" ? "New walk-in order" : tab === "E-commerce" ? "New e-commerce order" : tab === "Banking & Financial" ? "New Banking & Financial order" : "New order";
  return (
    <>
      <PageHeading
        eyebrow="Network operations"
        title="All parcels"
        subtitle="Every parcel, newest first · the last month unless you choose other dates · search and filters run on the server"
        actions={
          <>
            {ops.can("dispatch") ? (
              <Button variant="primary" icon="plus" onClick={() => void openBooking(t.booking)}>
                {newLabel}
              </Button>
            ) : null}
            <ImportButtons kind={t.kind} kinds={tab === "All" ? ["customer", "ecommerce", "document"] : undefined} />
            <BulkUpdateButton kind="all" label="Bulk update Excel" line={t.bulkLine} filters={bulkFilters(list.filters)} />
            <BulkUpdateButton kind="all" history line={t.bulkLine} />
            <PrintMenu list={list} line={t.line} title={tab === "All" ? "Courier shipment register" : t.page} />
            <ExportButton list={list} />
          </>
        }
      />
      <ViewTabs view="All parcels" tab={tab} />
      {tab === "All" && s ? (
        <div className="mini-stats">
          <div className="mini">
            <span>In transit</span>
            <strong>{num(s.inTransit + s.outForDelivery)}</strong>
          </div>
          <div className="mini">
            <span>At hub</span>
            <strong>{num(s.atHub)}</strong>
          </div>
          <div className="mini">
            <span>Exceptions</span>
            <strong>{num(s.exceptions)}</strong>
          </div>
        </div>
      ) : null}
      <ParcelTable
        key={tab}
        list={list}
        options={{
          title: tab === "All" ? "Network shipment register" : `${t.page} shipment queue`,
          subtitle: `${active == null ? "" : `${num(active)} active · `}newest first · the last month unless you choose other dates · search and filters run on the server`,
          statuses: "register",
          dates: true,
          merchants: t.merchants !== false,
        }}
      />
    </>
  );
}

const PROBLEM_TABS: Record<string, { stage: string; title: string; empty: string; sla?: boolean; bulk: Record<string, string | boolean> }> = {
  Exceptions: { stage: "exceptions", title: "Exception work queue", empty: "No open exceptions.", bulk: { status: "EXCEPTION" } },
  "Failed delivery": { stage: "failed", title: "Failed deliveries · retry scheduled or back at the hub", empty: "No failed deliveries waiting for a decision.", bulk: { status: "RETRY_SCHEDULED" } },
  "Needs info": { stage: "needs_info", title: "Orders with details missing", empty: "No orders are missing details.", bulk: { incomplete: true } },
  "SLA late-risk": { stage: "sla_risk", title: "Late or at risk of missing the delivery promise", empty: "No parcels are past their promised delivery time.", sla: true, bulk: { sla: "AT_RISK" } },
};

export function Problems({ tab }: { tab: string }) {
  const t = PROBLEM_TABS[tab] ?? PROBLEM_TABS.Exceptions;
  const view = viewById("Problems")!;
  const ops = useOps();
  const list = useParcelList({ id: `problems-${t.stage}`, params: { stage: t.stage }, empty: t.empty });
  const d = (ops.stageCounts?.detail || {}) as Record<string, number>;
  const stages = ops.stageCounts?.stages;
  return (
    <>
      <PageHeading
        eyebrow="Network operations"
        title="Problems"
        subtitle={view.subtitle}
        actions={
          <>
            <BulkUpdateButton kind="problems" presetFilters={t.bulk} />
            <BulkUpdateButton kind="problems" history />
          </>
        }
      />
      <ViewTabs view="Problems" tab={tab} />
      <div className="mini-stats">
        <div className="mini">
          <span>Open exceptions</span>
          <strong>{d.exceptions == null ? "—" : num(d.exceptions)}</strong>
        </div>
        <div className="mini">
          <span>SLA at risk</span>
          <strong>{d.slaRisk == null ? "—" : num(d.slaRisk)}</strong>
        </div>
        <div className="mini" title="Exceptions, failed deliveries and orders with details missing">
          <span>Awaiting action</span>
          <strong>{stages ? num(stages.problems) : "—"}</strong>
        </div>
      </div>
      {t.sla ? <SlaAlerts compact /> : null}
      <ParcelTable key={tab} list={list} options={{ title: t.title, failureColumns: tab === "Failed delivery" }} />
    </>
  );
}

/** A stage table of its own (Pickup, Delivery, At my hub, On the road, Returns). */
export function StageTable({ id, stage, title, subtitle, empty, hubs, failedFilter }: { id: string; stage: string; title: string; subtitle: string; empty: string; hubs?: boolean; failedFilter?: boolean }) {
  const list = useParcelList({ id, params: { stage }, empty });
  return <ParcelTable list={list} options={{ title, subtitle, hubs, failedFilter }} />;
}

/** New orders, All parcels and Problems (one lazy chunk). */
export function ParcelRoutes({ view, tab }: { view: string; tab: string }) {
  if (view === "New orders") return <NewOrders />;
  if (view === "All parcels") return <AllParcels tab={tab} />;
  return <Problems tab={tab} />;
}
