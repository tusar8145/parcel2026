/**
 * Parcel details › Messages (Courier Operations and merchant drawers): the product's channels (SMS / email / push),
 * each message ticked at booking with its SMS / email state, how many are done, and the SMS and emails sent
 * (GET /parcels/:id › messagePlan).
 */
import type { ReactNode } from "react";
import { Pill } from "./kit";
import { when } from "../lib/format";

type State = "SENT" | "PENDING" | "FAILED" | null;
export interface MessagePlan {
  channels: { sms: boolean; email: boolean; push: boolean };
  /** The ticked messages this parcel's journey gets; `when`: only if that happens (a failed attempt, a return…). */
  items: { code: string; label: string; audience: string; events?: string[]; sms: State; email: State; done: boolean; when?: string }[];
  /** Ticked messages that don't apply to this parcel (e.g. collected from the hub: no out-for-delivery), and why. */
  skipped?: { code: string; label: string; reason: string }[];
  done: number;
  total: number;
  sent: { channel: string; event: string; eventLabel: string; state: "SENT" | "PENDING" | "FAILED"; at: string }[];
}

const STATE: Record<string, [string, "good" | "warn" | "bad" | "info"]> = { SENT: ["Sent", "good"], PENDING: ["Queued", "warn"], FAILED: ["Failed", "bad"] };

function Channel({ name, on }: { name: string; on: boolean }) {
  return (
    <span className={`pill ${on ? "good" : ""}`} style={on ? undefined : { opacity: 0.6, textDecoration: "line-through" }} title={on ? `${name} on for this parcel's product` : `${name} off for this parcel's product`}>
      {name}
    </span>
  );
}

function StateTag({ channel, state }: { channel: string; state: State }) {
  if (!state) return <span className="faint" style={{ fontSize: 11 }}>{`${channel}: not yet`}</span>;
  const [label, tone] = STATE[state] ?? [state, "info"];
  return <Pill tone={tone}>{`${channel} ${label.toLowerCase()}`}</Pill>;
}

/** `hideSkipped`: leave out "Not for this parcel". `under`: shown inside each message's box, under it (the search window: what was sent). */
export function MessagePlanView({ plan, booked, hideSkipped = false, under }: { plan?: MessagePlan | null; booked?: boolean; hideSkipped?: boolean; under?: (item: MessagePlan["items"][number]) => ReactNode }) {
  if (!plan) return <p className="faint" style={{ margin: 0 }}>Loading…</p>;
  if (booked === false) return <p className="faint" style={{ margin: 0 }}>Booked before service packages: the account's standard delivery messages.</p>;
  const { channels } = plan;
  const none = !channels.sms && !channels.email && !channels.push;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <Channel name="SMS" on={channels.sms} />
        <Channel name="Email" on={channels.email} />
        <Channel name="Push" on={channels.push} />
        {plan.total ? (
          <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
            <strong style={{ color: "var(--ink)" }}>{`${plan.done} of ${plan.total}`}</strong>
            {` done · ${plan.total - plan.done} not yet`}
          </span>
        ) : null}
      </div>
      {none ? <p className="faint" style={{ margin: 0 }}>This parcel's product sends no SMS, email or push.</p> : null}
      {plan.items.length ? (
        <div className="stack" style={{ gap: 6 }}>
          {plan.items.map(i => (
            <div key={i.code} style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8, background: i.done ? "var(--good-soft)" : undefined }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13 }}>
                <span aria-hidden="true" style={{ marginRight: 6, color: i.done ? "var(--good)" : "var(--muted)" }}>
                  {i.done ? "✓" : "○"}
                </span>
                {i.label}
                <span className="faint" style={{ fontSize: 11 }}>{` · ${i.audience}${i.when ? ` · ${i.when}` : ""}`}</span>
              </span>
              <span className="row" style={{ gap: 4 }}>
                {channels.sms ? <StateTag channel="SMS" state={i.sms} /> : null}
                {channels.email ? <StateTag channel="Email" state={i.email} /> : null}
              </span>
            </div>
            {under ? under(i) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="faint" style={{ margin: 0 }}>No messages were ticked for this parcel.</p>
      )}
      {plan.skipped?.length && !hideSkipped ? (
        <div>
          <div className="faint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, margin: "2px 0 4px" }}>{`Not for this parcel (${plan.skipped.length})`}</div>
          <div className="stack" style={{ gap: 2 }}>
            {plan.skipped.map(k => (
              <div key={k.code} className="faint" style={{ fontSize: 12 }}>
                <span style={{ textDecoration: "line-through" }}>{k.label}</span>
                {` · ${k.reason}`}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {plan.sent.length ? (
        <div>
          <div className="faint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, margin: "2px 0 4px" }}>
            {`SMS and emails (${plan.sent.length})`}
          </div>
          <div className="stack" style={{ gap: 3 }}>
            {plan.sent.map((m, n) => {
              const [label, tone] = STATE[m.state] ?? [m.state, "info"];
              return (
                <div key={n} className="row" style={{ justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                  <span>{`${m.channel === "EMAIL" ? "Email" : "SMS"} · ${m.eventLabel}`}</span>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="faint">{when(m.at)}</span>
                    <Pill tone={tone}>{label}</Pill>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
