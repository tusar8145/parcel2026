/**
 * Hub desk: At my hub (the hub stage table: parcels received and waiting, with their next step) and End of day
 * (the day's reconciliation). Scanning work is on Scan desk.
 */
import { useOps } from "@/lib/ops";
import { PageHeading } from "@panel/ui/kit";
import ViewTabs from "@/app/ViewTabs";
import type { ViewDef } from "@/app/nav";
import { StageTable } from "./ParcelPages";
import EndOfDay from "./EndOfDay";
import { BulkUpdateButton } from "@/features/imports/ImportButtons";

const hubBulk = (
  <>
    <BulkUpdateButton kind="hub_desk" />
    <BulkUpdateButton kind="hub_desk" history />
  </>
);

export default function StagePages({ view, tab }: { view: ViewDef; tab: string }) {
  const ops = useOps();
  const mine = ops.scope.available && ops.scope.value === "mine";
  return (
    <>
      <PageHeading eyebrow="Network operations" title="Hub desk" subtitle={view.subtitle} actions={hubBulk} />
      <ViewTabs view={view.id} tab={tab} />
      {tab === "End of day" ? (
        <EndOfDay />
      ) : (
        <StageTable
          id="hub-now"
          stage="hub"
          hubs
          title={mine ? "At my hub now" : "At hubs now"}
          subtitle="Received and waiting: assign a delivery rider, add to a transfer when another hub delivers there, or hand over at the counter"
          empty="No parcels at the hub right now. Parcels you receive appear here with their next step."
        />
      )}
    </>
  );
}
