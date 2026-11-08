/** New requests and All requests (shared/merchant-orders.js headings and tools). */
import { PageHeading } from "@panel/ui/kit";
import { useSearchParams } from "react-router";
import { Button } from "@panel/ui/kit";
import { RequestList } from "@/features/parcels/RequestList";
import { openNewRequest } from "@/features/booking/NewRequest";
import { openImport } from "@panel/ui/Importer";
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

/** "Import batch" (merchant-bridge.js importConfig): the merchant's template, its package's services, preview, labels. */
function ImportButton() {
  const m = useMerchant();
  const hub = (m.merchant.pickupHub as { id?: string } | null | undefined)?.id;
  return (
    <Button icon="upload" onClick={() => void openImport({ kind: "document", merchantId: m.merchant.id, hubId: hub || undefined, noun: "consignments", printLabels: ids => void printLabels(ids), onDone: refreshMerchant })}>
      Import batch
    </Button>
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
            <ImportButton />
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
            <ImportButton />
          </>
        }
      />
      <RequestList kind="all" />
    </>
  );
}
