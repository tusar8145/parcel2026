/**
 * Services & pricing (shared/merchant-plan.js): the merchant's service package in plain words (GET /merchants/me/plan).
 *   Services     what the package includes (with its price) · what it doesn't ("Request" → a prefilled ticket)
 *   SMS & email  each parcel message by stage (to whom, when, SMS / email on or off), samples; support and account
 *                messages; products whose messages are switched off
 *   Pricing      route prices, extras, COD, failed deliveries & returns, worked examples and a calculator
 *                (POST /merchants/me/quote, the same price the booking uses)
 * Reloads on merchant.updated.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { Icon } from "@panel/ui/Icon";
import { Button, PageHeading } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { useMerchant } from "@/lib/merchant";

const tk = (n: unknown) => `৳${Math.round(Number(n || 0)).toLocaleString("en-US")}`;
const signed = (n: number) => (n < 0 ? `−${tk(-n)}` : tk(n));
const dateOnly = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

interface Ch {
  available: boolean;
  on: boolean;
}
interface Msg {
  code: string;
  label: string;
  when?: string;
  stage?: string;
  to?: string;
  included: boolean;
  always?: boolean;
  channels: { sms: Ch; email: Ch };
  samples?: { label: string; sms?: { text: string; parts: number } | null; email?: { subject: string; text: string } | null }[];
}
interface Plan {
  merchant: { name: string; code: string; status: string; pickupDistrict: string; pickupZone?: string };
  segmentLabel: string;
  package: { name: string; version: number; effectiveFrom?: string | null };
  scheduled: { name: string; effectiveFrom: string }[];
  summary: { included: number; notIncluded: number };
  services: { title: string; hint: string; items: { code: string; label: string; detail: string; price?: string; included: boolean; always?: boolean }[] }[];
  messages: { stages: string[]; parcel: Msg[]; support: Msg[]; account: Msg[]; productsWithoutMessages: string[] };
  prices: {
    includedWeightKg?: number;
    routes: { tier: string; label?: string; amount?: number; example: string; types?: { type: string; label: string; amount: number }[] }[];
    extras: { label: string; note?: string; value: string }[];
    cod: { label: string; note?: string; value: string }[];
    failed: { label: string; note?: string; value: string }[];
  };
  examples: { title: string; lines: { label: string; amount: number }[]; total: number }[];
  calculator: { districts: string[]; weight: boolean; cod: boolean; openBox: boolean; speeds: { code: string; label: string }[]; firstMiles: { code: string; label: string }[]; lastMiles: { code: string; label: string }[] };
}

export default function Services() {
  const m = useMerchant();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const plan = useQuery({ queryKey: ["m", "plan"], queryFn: () => api<Plan>(`/merchants/me/plan${m.q()}`) });
  useLive(["merchant.updated"], () => void qc.invalidateQueries({ queryKey: ["m", "plan"] }), { fallbackMs: 300_000 });
  const [tab, setTab] = useState<"services" | "messages" | "pricing">("services");
  const d = plan.data;
  const ask = (subject: string, message?: string) => navigate(`/support?compose=1&subject=${encodeURIComponent(subject)}&category=${encodeURIComponent("Account / API")}${message ? `&message=${encodeURIComponent(message)}` : ""}`);
  const request = (name: string) => ask(`Add "${name}" to my plan`, `Please add "${name}" to our plan (${d?.package?.name || "current plan"}) and let us know the price.`);
  const heading = (
    <PageHeading
      eyebrow="Merchant workspace"
      title="Services & pricing"
      subtitle="What your plan includes, the messages we send and what you pay."
      actions={<Button onClick={() => ask(`Question about my plan${d ? ` (${d.package.name})` : ""}`)}>Ask about my plan</Button>}
    />
  );
  if (!d)
    return (
      <>
        {heading}
        <section className="panel">
          <div className="panel-body faint">
            {plan.isError ? describe(plan.error) : "Loading your plan…"}
            {plan.isError ? (
              <div>
                <Button onClick={() => plan.refetch()} style={{ marginTop: 10 }}>
                  Try again
                </Button>
              </div>
            ) : null}
          </div>
        </section>
      </>
    );

  const parcelOn = d.messages.parcel.filter(x => x.included && (x.channels.sms.on || x.channels.email.on)).length;
  const from = Math.min(...d.prices.routes.flatMap(r => (r.types ? r.types.map(t => t.amount) : [r.amount ?? 0])));
  const scheduled = d.scheduled[0];
  return (
    <>
      {heading}
      <div className="dfp">
        <div className="dfp-hero">
          <section className="dfp-card dfp-plan" aria-label="Your plan">
            <div className="row" style={{ gap: 6 }}>
              <span className="dfp-tag green">
                <Icon name="check" size={13} /> Active plan
              </span>
              <span className="dfp-tag">{d.segmentLabel}</span>
            </div>
            <h2>{d.package.name}</h2>
            <p>
              {d.merchant.name} · {d.merchant.code}
              {d.package.effectiveFrom ? ` · in force since ${dateOnly(d.package.effectiveFrom)}` : ""} · version {d.package.version}
            </p>
            {scheduled ? (
              <div className="callout">
                <span>
                  Your plan changes to <b>{scheduled.name}</b> on {dateOnly(scheduled.effectiveFrom)}. Parcels booked before then keep today's prices.
                </span>
              </div>
            ) : null}
            {d.merchant.status !== "ACTIVE" ? <div className="callout">Your account is still being reviewed. This is the plan you'll book with once it's approved.</div> : null}
            <p>Every parcel keeps the price it was booked with, even if your plan changes later.</p>
            <button type="button" className="link-button" onClick={() => ask(`Question about my plan (${d.package.name})`)}>
              Questions about your plan? Ask us →
            </button>
          </section>
          <section className="dfp-stats" aria-label="At a glance">
            <Stat label="Services in your plan" value={String(d.summary.included)} foot={d.summary.notIncluded ? `${d.summary.notIncluded} more available on request` : "Everything available"} />
            <Stat label="Parcel messages on" value={String(parcelOn)} foot="SMS or email, to you or your customer" />
            <Stat label="Delivery from" value={tk(from)} foot={d.prices.includedWeightKg ? `per parcel, up to ${d.prices.includedWeightKg} kg` : "per parcel"} />
            <Stat
              label={d.prices.cod.length ? "COD fee" : "Returns"}
              value={d.prices.cod.length ? d.prices.cod[0].value.replace(" of the cash collected", "") : (d.prices.failed[1]?.value ?? "").replace(" of the delivery charge", "")}
              foot={d.prices.cod.length ? "of the cash collected" : "of the delivery charge"}
            />
          </section>
        </div>
        <div className="seg-tabs" role="tablist" aria-label="Plan details" style={{ justifySelf: "start" }}>
          {(
            [
              ["services", "Services"],
              ["messages", "SMS & email"],
              ["pricing", "Pricing"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        {tab === "services" ? <ServicesTab d={d} request={request} /> : tab === "messages" ? <MessagesTab d={d} request={request} /> : <PricingTab d={d} />}
      </div>
    </>
  );
}

function Stat({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="dfp-stat">
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{foot}</span>
    </div>
  );
}
const Ok = () => (
  <span className="dfp-ok">
    <Icon name="check" size={14} />
  </span>
);
const No = () => <span className="dfp-no">–</span>;
const channel = (c: Ch, inPlan: boolean) => (!c.available ? <span className="dfp-ch off">—</span> : !inPlan || !c.on ? <span className="dfp-ch off">Off</span> : <span className="dfp-ch on">✓ On</span>);

function Title({ title, text, tools }: { title: string; text: string; tools?: React.ReactNode }) {
  return (
    <div className="dfp-section-title">
      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
      {tools}
    </div>
  );
}

function ServicesTab({ d, request }: { d: Plan; request: (name: string) => void }) {
  const [filter, setFilter] = useState<"all" | "included" | "not">("all");
  const show = (i: { included: boolean }) => filter === "all" || (filter === "included" ? i.included : !i.included);
  const sections = d.services.filter(s => s.items.some(show));
  return (
    <>
      <Title
        title="Your plan's services"
        text="What you can choose when you book. Services that aren't in your plan don't appear in your order form, Excel template or API."
        tools={
          <div className="row" role="group" aria-label="Show" style={{ gap: 6 }}>
            {(["all", "included", "not"] as const).map(f => (
              <button key={f} type="button" className={`button sm${filter === f ? " primary" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {{ all: "All services", included: "In your plan", not: "Not in your plan" }[f]}
              </button>
            ))}
          </div>
        }
      />
      <div className="dfp-grid">
        {sections.map(s => (
          <div key={s.title} className="dfp-card">
            <div className="dfp-svc-head">
              <h4>{s.title}</h4>
              <small>
                {s.items.filter(i => i.included).length} of {s.items.length} in your plan
              </small>
            </div>
            <p className="faint" style={{ margin: "-2px 0 6px" }}>
              {s.hint}
            </p>
            {s.items.filter(show).map(i => (
              <div key={i.code} className={`dfp-svc${i.included ? "" : " off"}`}>
                {i.included ? <Ok /> : <No />}
                <div className="dfp-svc-body">
                  <div className="dfp-svc-name">
                    {i.label} {i.always ? <span className="dfp-tag green">Always included</span> : i.included ? null : <span className="dfp-tag grey">Not in your plan</span>}
                  </div>
                  <div className="dfp-svc-detail">{i.detail}</div>
                  {i.included && i.price ? <div className="dfp-svc-price">{i.price}</div> : null}
                  {i.included ? null : (
                    <div className="dfp-svc-price">
                      <button type="button" className="link-button" onClick={() => request(i.label)}>
                        Request this service
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
        {!sections.length ? (
          <div className="dfp-card">
            <p className="faint">Nothing to show for this filter.</p>
          </div>
        ) : null}
      </div>
    </>
  );
}

function MessagesTab({ d, request }: { d: Plan; request: (name: string) => void }) {
  const m = d.messages;
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (code: string) => setOpen(s => (s.has(code) ? (s.delete(code), new Set(s)) : new Set(s.add(code))));
  return (
    <>
      <Title
        title="Messages about your parcels"
        text="A message goes out when it's in your plan and switched on, and still ticked on the order (all are ticked by default; untick any when you book). Open a sample to read the exact text; the tracking number, names and amounts are examples."
        tools={
          <Button size="sm" aria-pressed={all} onClick={() => setAll(a => !a)}>
            {all ? "Hide all samples" : "Show all samples"}
          </Button>
        }
      />
      {m.productsWithoutMessages.length ? (
        <div className="callout">
          <span>
            Parcels of these products get <b>no SMS or email</b>: {m.productsWithoutMessages.join(", ")}.
          </span>
        </div>
      ) : null}
      <div className="dfp-grid" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        {m.stages.map(stage => {
          const rows = m.parcel.filter(x => x.stage === stage);
          if (!rows.length) return null;
          return (
            <div key={stage} className="dfp-card">
              <div className="dfp-svc-head">
                <h4>{stage}</h4>
                <small>
                  {rows.filter(r => r.included).length} of {rows.length} in your plan
                </small>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Message</th>
                      <th>Sent to</th>
                      <th>SMS</th>
                      <th>Email</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const has = (r.samples || []).some(x => x.sms || x.email);
                      const shown = all || open.has(r.code);
                      return [
                        <tr key={r.code} className={r.included ? "" : "off"}>
                          <td>
                            <strong>{r.label}</strong>
                            <div className="sub">{r.when}</div>
                            {r.included ? null : (
                              <div className="sub">
                                Not in your plan ·{" "}
                                <button type="button" className="link-button" onClick={() => request(`${r.label} message`)}>
                                  Request
                                </button>
                              </div>
                            )}
                            {has ? (
                              <button type="button" className="link-button" aria-expanded={shown} onClick={() => toggle(r.code)}>
                                {shown ? "Hide sample" : "See sample message"}
                              </button>
                            ) : null}
                          </td>
                          <td>{r.to}</td>
                          <td>{channel(r.channels.sms, r.included)}</td>
                          <td>{channel(r.channels.email, r.included)}</td>
                        </tr>,
                        has && shown ? (
                          <tr key={`${r.code}-sample`}>
                            <td colSpan={4}>
                              <Samples r={r} />
                            </td>
                          </tr>
                        ) : null,
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
      <Title title="Other messages" text="Email goes to the address on your account; in-app notifications appear in your bell." />
      <div className="dfp-grid">
        {m.support.length ? (
          <div className="dfp-card">
            <div className="dfp-svc-head">
              <h4>Support tickets</h4>
              <small>To you</small>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Message</th>
                  <th>SMS</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {m.support.map(r => (
                  <tr key={r.code ?? r.label} className={r.included ? "" : "off"}>
                    <td>
                      <strong>{r.label}</strong>
                      {r.included ? null : <div className="sub">Not in your plan</div>}
                    </td>
                    <td>{channel(r.channels.sms, r.included)}</td>
                    <td>{channel(r.channels.email, r.included)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="dfp-card">
          <div className="dfp-svc-head">
            <h4>Account & payments</h4>
            <small>To you · not part of the plan</small>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Message</th>
                <th>SMS</th>
                <th>Email</th>
              </tr>
            </thead>
            <tbody>
              {m.account.map(r => (
                <tr key={r.code ?? r.label}>
                  <td>
                    <strong>{r.label}</strong>
                    {r.always ? (
                      <div className="sub">
                        <Icon name="lock" size={12} /> Always sent, for your security
                      </div>
                    ) : null}
                  </td>
                  <td>{channel(r.channels.sms, true)}</td>
                  <td>{channel(r.channels.email, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** The sample SMS (a phone bubble) and email of a message, as the current templates render them. */
function Samples({ r }: { r: Msg }) {
  const who = r.to === "You" ? "you" : "your customer";
  const status = (c: Ch) => (!c.available ? "" : !r.included ? "not in your plan" : c.on ? "sent" : "switched off");
  const off = !r.included || !(r.channels.sms.on || r.channels.email.on);
  const many = (r.samples?.length ?? 0) > 1;
  return (
    <div className="dfp-samples">
      {off ? <div className="faint">{r.included ? "This message is switched off at the moment, so it isn't sent." : "Not in your plan, so it isn't sent. This is what it would look like."}</div> : null}
      {(r.samples ?? []).map((x, i) => (
        <div key={i}>
          {many ? <p className="strong" style={{ margin: "6px 0" }}>{x.label}</p> : null}
          {x.sms ? (
            <div className="dfp-phone">
              <div className="row faint" style={{ justifyContent: "space-between", fontSize: 12 }}>
                <span>
                  <b>SMS</b> to {who}
                </span>
                <span>
                  {status(r.channels.sms)}
                  {x.sms.parts > 1 ? ` · ${x.sms.parts} SMS parts` : ""}
                </span>
              </div>
              <div className="dfp-bubble">{x.sms.text}</div>
            </div>
          ) : null}
          {x.email ? (
            <div className="dfp-mail">
              <div className="row faint" style={{ justifyContent: "space-between", fontSize: 12 }}>
                <span>
                  <b>Email</b> to {who}
                </span>
                <span>{status(r.channels.email)}</span>
              </div>
              <div className="strong" style={{ margin: "4px 0" }}>
                {x.email.subject}
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{x.email.text}</div>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PricingTab({ d }: { d: Plan }) {
  const m = useMerchant();
  const p = d.prices;
  const c = d.calculator;
  const [v, setV] = useState({ deliveryDistrict: d.merchant.pickupDistrict, weightKg: "1", codAmount: "0", speed: c.speeds[0]?.code ?? "", firstMile: c.firstMiles[0]?.code ?? "", lastMile: c.lastMiles[0]?.code ?? "", openBox: false });
  const [quote, setQuote] = useState<{ q?: { lines: { label: string; amount: number }[]; totalCharge: number; tierLabel: string; returnCharge: number }; error?: string; busy?: boolean } | null>(null);
  const rows = (list: { label: string; note?: string; value: string }[]) => (
    <div className="dfp-rows">
      {list.map(r => (
        <div key={r.label} className="dfp-row">
          <div>
            {r.label}
            {r.note ? <small>{r.note}</small> : null}
          </div>
          <b>{r.value}</b>
        </div>
      ))}
    </div>
  );
  async function calculate(e: React.FormEvent) {
    e.preventDefault();
    const weight = c.weight ? Number(v.weightKg || 0.5) : 0.5;
    const cod = c.cod ? Number(v.codAmount || 0) : 0;
    if (c.weight && !(weight > 0 && weight <= 50)) return setQuote({ error: "Enter a weight between 0.1 and 50 kg." });
    if (cod < 0) return setQuote({ error: "The cash to collect can't be negative." });
    setQuote({ busy: true });
    try {
      const q = await api<NonNullable<NonNullable<typeof quote>["q"]>>(`/merchants/me/quote${m.q()}`, {
        method: "POST",
        body: { pickupDistrict: d.merchant.pickupDistrict, pickupZone: d.merchant.pickupZone || undefined, deliveryDistrict: v.deliveryDistrict, weightKg: weight, codAmount: cod, speed: v.speed, firstMile: v.firstMile, lastMile: v.lastMile, ...(c.openBox ? { openBox: v.openBox } : {}) },
      });
      setQuote({ q });
    } catch (err) {
      setQuote({ error: describe(err) });
    }
  }
  const sel = (label: string, key: "speed" | "firstMile" | "lastMile", list: { code: string; label: string }[]) =>
    list.length < 2 ? null : (
      <label className="field">
        <span>{label}</span>
        <Select className="select" searchable={false} value={v[key]} onChange={e => setV({ ...v, [key]: e.target.value })}>
          {list.map(o => (
            <option key={o.code} value={o.code}>
              {o.label}
            </option>
          ))}
        </Select>
      </label>
    );
  return (
    <>
      <Title title="Delivery charge by route" text={`The route is set by the pickup and delivery districts${p.includedWeightKg ? `; up to ${p.includedWeightKg} kg is included` : ""}.`} />
      <div className="dfp-routes">
        {p.routes.flatMap(r =>
          r.types
            ? r.types.map(t => (
                <div key={`${r.tier}-${t.type}`} className="dfp-route">
                  <small>{t.label}</small>
                  <strong>{tk(t.amount)}</strong>
                  <p>{r.example}</p>
                </div>
              ))
            : [
                <div key={r.tier} className="dfp-route">
                  <small>{r.label}</small>
                  <strong>{tk(r.amount)}</strong>
                  <p>{r.example}</p>
                </div>,
              ],
        )}
      </div>
      <div className="dfp-grid">
        <div className="dfp-card">
          <div className="dfp-svc-head">
            <h4>Added to the route price</h4>
          </div>
          {rows(p.extras)}
        </div>
        <div className="dfp-card">
          {p.cod.length ? (
            <>
              <div className="dfp-svc-head">
                <h4>Cash on delivery</h4>
              </div>
              {rows(p.cod)}
              <div style={{ height: 12 }} />
            </>
          ) : null}
          <div className="dfp-svc-head">
            <h4>Failed deliveries & returns</h4>
          </div>
          {rows(p.failed)}
        </div>
      </div>
      <Title title="Examples" text="Worked out with your plan's prices, exactly as an order is priced." />
      <div className="dfp-grid">
        {d.examples.map(e => (
          <div key={e.title} className="dfp-card">
            <h4 style={{ margin: "0 0 8px" }}>{e.title}</h4>
            {e.lines.map(l => (
              <div key={l.label} className="dfp-line">
                <span>{l.label}</span>
                <span>{signed(l.amount)}</span>
              </div>
            ))}
            <div className="dfp-total">
              <span>You pay</span>
              <span>{tk(e.total)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="dfp-card">
        <div className="dfp-svc-head">
          <h4>Price calculator</h4>
          <small>From your pickup district: {d.merchant.pickupDistrict}</small>
        </div>
        <form className="form-grid" onSubmit={calculate} noValidate>
          <label className="field">
            <span>Delivery district</span>
            <Select className="select" value={v.deliveryDistrict} onChange={e => setV({ ...v, deliveryDistrict: e.target.value })} searchable>
              {c.districts.map(x => (
                <option key={x}>{x}</option>
              ))}
            </Select>
          </label>
          {c.weight ? (
            <label className="field">
              <span>Weight (kg)</span>
              <input className="input" type="number" min={0.1} max={50} step={0.1} value={v.weightKg} onChange={e => setV({ ...v, weightKg: e.target.value })} />
            </label>
          ) : null}
          {c.cod ? (
            <label className="field">
              <span>Cash to collect (৳)</span>
              <input className="input" type="number" min={0} step={1} value={v.codAmount} onChange={e => setV({ ...v, codAmount: e.target.value })} />
            </label>
          ) : null}
          {sel("Service", "speed", c.speeds)}
          {sel("Hand over", "firstMile", c.firstMiles)}
          {sel("Delivery", "lastMile", c.lastMiles)}
          {c.openBox ? (
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={v.openBox} onChange={e => setV({ ...v, openBox: e.target.checked })} /> Open box
            </label>
          ) : null}
          <div className="field" style={{ alignSelf: "end" }}>
            <button type="submit" className="button primary">
              Calculate
            </button>
          </div>
        </form>
        <div aria-live="polite" style={{ marginTop: 12 }}>
          {quote?.busy ? (
            <p className="faint">Working out the price…</p>
          ) : quote?.error ? (
            <p style={{ color: "var(--bad)" }}>{quote.error}</p>
          ) : quote?.q ? (
            <>
              {quote.q.lines.map(l => (
                <div key={l.label} className="dfp-line">
                  <span>{l.label}</span>
                  <span>{signed(l.amount)}</span>
                </div>
              ))}
              <div className="dfp-total">
                <span>You pay for this parcel</span>
                <span>{tk(quote.q.totalCharge)}</span>
              </div>
              <p className="faint" style={{ marginTop: 6, fontSize: 12 }}>
                {quote.q.tierLabel} · if it can't be delivered and comes back to you: +{tk(quote.q.returnCharge)}
              </p>
            </>
          ) : (
            <p className="faint">Choose the details and press Calculate.</p>
          )}
        </div>
      </div>
      <p className="faint" style={{ fontSize: 12 }}>
        All prices in Bangladeshi taka. The price shown when you book is final for that parcel.
      </p>
    </>
  );
}
