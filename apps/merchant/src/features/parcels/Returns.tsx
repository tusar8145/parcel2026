/** "Returns (RTO)" (merchant-features.js openReturns): parcels coming back, by stage (GET /returns), Confirm received. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { date, money } from "@panel/lib/format";
import { openCustom } from "@panel/ui/dialogs";
import { Icon } from "@panel/ui/Icon";
import { Pill } from "@panel/ui/kit";
import { useMerchant } from "@/lib/merchant";
import { confirmReturnReceived } from "./actions";

const STAGE: Record<string, string> = { requested: "Return requested", scheduled: "Return scheduled", returned: "Returned · confirm receipt", received: "Return received" };
const STAGES = ["all", "requested", "scheduled", "returned", "received"];

interface ReturnRow {
  trackingId: string;
  merchantOrderRef?: string | null;
  recipientName: string;
  deliveryZone: string;
  deliveryDistrict: string;
  reason?: string | null;
  requestedAt?: string | null;
  returnCharge?: number | null;
  stage: string;
}

export function openReturns(openParcel: (id: string) => void) {
  return openCustom(close => <ReturnsDialog close={() => close()} openParcel={id => (close(), openParcel(id))} />, "wide");
}

function ReturnsDialog({ close, openParcel }: { close: () => void; openParcel: (id: string) => void }) {
  const m = useMerchant();
  const [stage, setStage] = useState("all");
  const q = useQuery({ queryKey: ["m", "returns", stage], queryFn: () => api<{ items: ReturnRow[] }>(`/returns?stage=${stage}&limit=100${m.q("&")}`) });
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>Returns (RTO)</h2>
          <p>Parcels coming back to you. Request a return from a parcel's details when it can't be delivered.</p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {STAGES.map(s => (
            <button key={s} type="button" className={`button sm${s === stage ? " primary" : ""}`} onClick={() => setStage(s)}>
              {s === "all" ? "All" : STAGE[s].split(" · ")[0]}
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tracking</th>
                <th>Recipient</th>
                <th>Reason</th>
                <th>Requested</th>
                <th>Return charge</th>
                <th>Stage</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(q.data?.items ?? []).map(r => (
                <tr key={r.trackingId}>
                  <td>
                    <button type="button" className="link-button tracking" onClick={() => openParcel(r.trackingId)}>
                      {r.trackingId}
                    </button>
                    {r.merchantOrderRef ? <div className="sub">{r.merchantOrderRef}</div> : null}
                  </td>
                  <td>
                    {r.recipientName}
                    <div className="sub">
                      {r.deliveryZone}, {r.deliveryDistrict}
                    </div>
                  </td>
                  <td>{r.reason || "—"}</td>
                  <td className="nowrap">{r.requestedAt ? date(r.requestedAt) : "—"}</td>
                  <td>{r.returnCharge != null ? money(r.returnCharge) : "—"}</td>
                  <td>
                    <Pill>{STAGE[r.stage] || r.stage}</Pill>
                  </td>
                  <td>
                    {r.stage === "returned" ? (
                      <button type="button" className="button sm" onClick={() => void confirmReturnReceived(r.trackingId).then(() => q.refetch())}>
                        Confirm received
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!q.data?.items.length ? (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    {q.isLoading ? "Loading…" : q.isError ? describe(q.error) : `No returns${stage === "all" ? "" : " at this stage"}.`}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
