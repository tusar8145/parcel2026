/** The parcel actions with this person's context, and the "next action" runner (bridge-parcel.js Ops.runNext). */
import { useNavigate, useSearchParams } from "react-router";
import { pathFor } from "@/app/nav";
import { when } from "@/lib/format";
import { useOps } from "@/lib/ops";
import { toast } from "@/ui/toast";
import * as A from "./actions";
import { nextAction, servingHub, type NextKind, type Parcel } from "./model";
import { useCatalog } from "./search";

/** What a page opened by a next action should prefill (location.state). */
export interface Handoff {
  code?: string;
  hubId?: string;
  action?: "receive" | "transfer" | "handover" | "returnRun";
}

export function useParcelActions() {
  const ops = useOps();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const catalog = useCatalog();
  const ctx: A.ActionContext = { hubs: ops.hubs, riders: ops.riders, myHubIds: ops.me?.hubIds ?? null, can: p => ops.can(p), roleName: ops.roleName };

  const go = (view: string, tab: string | undefined, state: Handoff) => {
    setParams(p => (p.delete("parcel"), p.delete("matches"), p));
    navigate(pathFor(view, tab), { state });
  };

  function run(kind: NextKind, p: Parcel) {
    switch (kind) {
      case "accept":
      case "assign":
        return A.assignRider(p, ctx);
      case "resolve":
        return A.resolveException(p, ctx);
      case "edit":
        return A.editDetails(p, ctx, catalog);
      case "receive":
        toast(`${p.trackingId}: press Enter to receive it at the hub.`);
        return go("Scan desk", "Receive entry", { code: p.trackingId, hubId: p.dropOffHub?.id, action: "receive" });
      case "transfer": {
        const hub = servingHub(p, ops.hubs);
        toast(`Open a bag to ${hub?.name || "the delivery hub"}, then scan ${p.trackingId} into it.`);
        return go("Transfers", "Send", { code: p.trackingId, hubId: hub?.id, action: "transfer" });
      }
      case "handover":
        return go("Scan desk", "Collect from hub", { code: p.trackingId, hubId: p.currentHub?.id, action: "handover" });
      case "returnRun":
        return go("Returns", undefined, { code: p.trackingId, action: "returnRun" });
    }
  }

  return {
    ctx,
    catalog,
    next: (p: Parcel | null | undefined) => (ops.can("dispatch") ? nextAction(p, ops.hubs, when) : null),
    run,
    assign: (p: Parcel) => A.assignRider(p, ctx),
    resolve: (p: Parcel) => A.resolveException(p, ctx),
    edit: (p: Parcel) => A.editDetails(p, ctx, catalog),
    cancel: (p: Parcel) => A.cancelRequest(p, ctx),
    changeIntake: (p: Parcel) => A.changeIntake(p, ctx),
    canChangeIntake: (p: Parcel) => A.canChangeIntake(p, ctx),
    returnToSender: (p: Parcel) => A.returnToSender(p.trackingId, ctx, () => go("Returns", undefined, {})),
    corrections: (p: Parcel) => A.correctionsFor(p, ctx),
    bulkAccept: (parcels: Parcel[]) => A.bulkAccept(parcels, ctx),
    openParcel: (id: string, matches?: string[]) =>
      setParams(p => {
        p.set("parcel", id);
        if (matches && matches.length > 1) p.set("matches", matches.join(","));
        else if (!matches) p.delete("matches");
        return p;
      }),
  };
}
