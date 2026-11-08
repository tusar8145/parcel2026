/** New requests and All requests (shared/merchant-orders.js headings and tools). */
import { PageHeading } from "@panel/ui/kit";
import { useSearchParams } from "react-router";
import { Button } from "@panel/ui/kit";
import { RequestList } from "@/features/parcels/RequestList";
import { openNewRequest } from "@/features/booking/NewRequest";
import { openImport, openImportHistory } from "@panel/ui/Importer";
import { printLabels } from "@panel/lib/print";
import { useMerchant } from "@/lib/merchant";
import { refreshMerchant } from "@/features/parcels/actions";
import { openReturns } from "@/features/parcels/Returns";

function ReturnsButton() {
  const [, setParams] = useSearchParams();
  return (
    <Button icon="box" onClick={() => void openReturns(id => setParams(p => (p.set("parcel", id), p)))}>
      Returns (RTO)
    </Button>
  );
}

/** The import settings of this merchant (merchant-bridge.js importConfig): its template, its package's services, labels. */
function useImportConfig() {
  const m = useMerchant();
  const hub = (m.merchant.pickupHub as { id?: string } | null | undefined)?.id;
  return { kind: "document", merchantId: m.merchant.id, hubId: hub || undefined, noun: "consignments", printLabels: (ids: string[]) => void printLabels(ids), onDone: refreshMerchant };
}

/** "Import Excel" (the classic panel's "Import batch") and its history. */
export function ImportButtons() {
  const cfg = useImportConfig();
  return (
    <>
      <Button icon="upload" title="Book many requests at once from an Excel or CSV file" onClick={() => void openImport(cfg)}>
        Import Excel
      </Button>
      <Button icon="history" title="Past imports with their results and downloads" onClick={() => void openImportHistory(cfg)}>
        Import history
      </Button>
    </>
  );
}

/** "New delivery request": the form, then the new request's details. */
function NewRequestButton() {
  const [, setParams] = useSearchParams();
  return (
    <Button variant="primary" icon="plus" onClick={() => void openNewRequest(id => setParams(p => (p.set("parcel", id), p)))}>
      New delivery request
    </Button>
  );
}


export function NewRequests() {
  return (
    <>
      <PageHeading
        title="New requests"
        subtitle="Booked and waiting to be collected or brought to a hub. Everything you create starts here."
        actions={
          <>
            <NewRequestButton />
            <ImportButtons />
          </>
        }
      />
      <RequestList kind="new" />
    </>
  );
}

export function AllRequests() {
  return (
    <>
      <PageHeading
        title="All requests"
        subtitle="Every request, with its full journey. Filter, export or print any of them."
        actions={
          <>
            <ReturnsButton />
            <NewRequestButton />
            <ImportButtons />
          </>
        }
      />
      <RequestList kind="all" />
    </>
  );
}
