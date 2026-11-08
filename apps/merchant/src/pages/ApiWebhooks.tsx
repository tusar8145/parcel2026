/**
 * API & Webhooks (merchant-bridge.js realApiPage): API keys (create with permissions and expiry; the key is shown once;
 * revoke), webhooks (endpoint + events; signing secret shown once; send test, deliveries, rotate secret, pause /
 * resume, remove), the API reference with examples and the webhook payloads. Owners manage keys and webhooks.
 */
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { when } from "@panel/lib/format";
import { confirm, openCustom } from "@panel/ui/dialogs";
import { Icon } from "@panel/ui/Icon";
import { Button, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import { useMerchant } from "@/lib/merchant";

const WEBHOOK_EVENTS = [
  "pickup.requested",
  "pickup.scheduled",
  "pickup.completed",
  "pickup.cancelled",
  "pickup.missed",
  "shipment.status_updated",
  "shipment.out_for_delivery",
  "shipment.delivered",
  "shipment.delivery_failed",
  "shipment.cancelled",
  "shipment.return_requested",
  "shipment.return_scheduled",
  "shipment.returned",
  "shipment.return_received",
  "cod.settled",
  "invoice.issued",
];
const API_KEY_SCOPES: [string, string][] = [
  ["parcels:read", "Read parcels and tracking"],
  ["parcels:write", "Book parcels (single and imports)"],
  ["parcels:cancel", "Cancel parcels"],
  ["returns:write", "Request returns"],
  ["webhooks:manage", "Manage webhooks"],
];
const dateOnly = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes?: string[];
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
}
interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}
interface Revealed {
  kind: "key" | "webhook";
  label: string;
  value: string;
  message: string;
}

export default function ApiWebhooks() {
  const m = useMerchant();
  const qc = useQueryClient();
  const mm = m.merchant as Record<string, unknown> & { name: string; code: string; status: string; kyc?: { status?: string } | null };
  const keys = useQuery({ queryKey: ["m", "api-keys"], enabled: m.isOwner, queryFn: () => api<{ items: ApiKey[] }>(`/merchants/me/api-keys?limit=200${m.q("&")}`).then(r => r.items) });
  const hooks = useQuery({ queryKey: ["m", "webhooks"], enabled: m.isOwner, queryFn: () => api<{ items: Webhook[] }>(`/merchants/me/webhooks${m.q()}`).then(r => r.items) });
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ["m"] });
  const base = `${location.origin}/api/v1`;
  const activeKeys = (keys.data ?? []).filter(k => !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt) > new Date()));

  async function act<T>(work: () => Promise<T>, success: string | ((r: T) => string), opts = { reload: true }) {
    try {
      const r = await work();
      if (opts.reload) void reload();
      toast(typeof success === "function" ? success(r) : success, "good");
      return r;
    } catch (e) {
      toast(describe(e), "bad");
      return null;
    }
  }

  const secretBox = (kind: Revealed["kind"]) =>
    revealed?.kind === kind ? (
      <div className="field full" style={{ marginTop: 14 }}>
        <span>
          {revealed.label} <span className="pill warn">Shown once</span>
        </span>
        <pre className="api-code">{revealed.value}</pre>
        <small className="faint">{revealed.message}</small>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <Button size="sm" onClick={() => navigator.clipboard?.writeText(revealed.value).then(() => toast("Copied to the clipboard."), () => toast("Copy is unavailable; select the text and copy it manually."))}>
            Copy
          </Button>
          <Button size="sm" onClick={() => setRevealed(null)}>
            I've stored it
          </Button>
        </div>
      </div>
    ) : null;

  const example = {
    create: `curl -X POST ${base}/parcels \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: CARD-2026-0012" \\\n  -d '${JSON.stringify({
      sender: { name: mm.name, phone: String(mm.contactPhone || "").replace(/^\+88/, "") },
      pickup: { category: "Office", street: mm.pickupAddress, area: mm.pickupArea, zone: (mm.pickup as { zone?: string } | undefined)?.zone || mm.pickupArea, district: mm.pickupDistrict },
      recipient: { name: "Ayesha Rahman", phone: "01712345678" },
      delivery: { category: "Office", street: "House 7, Road 2", zone: "Dhanmondi", district: "Dhaka Central" },
      type: "DOCUMENT",
      serviceLevel: "Express",
      weightKg: 0.5,
      packaging: "Security pouch",
      contents: "Cheque book",
      codAmount: 0,
      merchantOrderRef: "CARD-2026-0012",
    })}'`,
    status: `curl -H "Authorization: Bearer YOUR_API_KEY" \\\n  ${base}/parcels/PP-261015-0001`,
    list: `curl -H "Authorization: Bearer YOUR_API_KEY" \\\n  "${base}/parcels?status=OUT_FOR_DELIVERY&limit=50&cursor=NEXT_CURSOR"`,
    cancel: `curl -X POST ${base}/parcels/PP-261015-0001/cancel \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"reason":"Customer cancelled the order"}'`,
    webhook: `POST https://your-domain.com/webhooks/delivery-fast HTTP/1.1\nContent-Type: application/json\nUser-Agent: DeliveryFast-Webhooks/1.0\nX-DeliveryFast-Event: shipment.status_updated\nX-DeliveryFast-Delivery: 0199f0c2-7b1e-7d4a-9c55-3f1a2b4c5d6e\nX-DeliveryFast-Signature: t=1791977880,v1=HMAC_SHA256_HEX\n\n{"id":"0199f0c2-7b1e-7d4a-9c55-3f1a2b4c5d6e","event":"shipment.status_updated","createdAt":"2026-10-15T11:42:00.000Z","data":{"trackingId":"PP-261015-0001","merchantOrderRef":"CARD-2026-0012","from":"AT_HUB","status":"OUT_FOR_DELIVERY","statusLabel":"Out for delivery","at":"2026-10-15T11:42:00.000Z"}}`,
    verify:
      '// Node.js: verify before trusting the body (use the raw request body)\nconst [t, v1] = header.split(",").map(part => part.split("=")[1]);\nconst expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest("hex");\nconst valid = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))\n  && Math.abs(Date.now() / 1000 - Number(t)) < 300;',
    requested: `{"id":"…","event":"pickup.requested","createdAt":"2026-10-15T09:12:00.000Z","data":{"trackingId":"PP-261015-0001","merchantOrderRef":"CARD-2026-0012","totalCharge":120}}`,
  };

  return (
    <>
      <PageHeading eyebrow="Developer tools" title="API & Webhooks" subtitle="Book parcels and track them from your business systems with the Delivery Fast API." actions={<Pill tone={activeKeys.length ? "good" : undefined}>{activeKeys.length ? `${activeKeys.length} active API key${activeKeys.length === 1 ? "" : "s"}` : "No API keys yet"}</Pill>} />
      <div className="metrics">
        <Metric label="API version" value="v1" icon="settings" foot="Versioned REST API" note="stable" />
        <Metric label="Authentication" value="Bearer" icon="users" foot="API key in Authorization header" note="HTTPS" />
        <Metric label="Webhook signing" value="HMAC-SHA256" icon="bell" foot="Verify every event signature" note="signed" />
      </div>
      <Panel title="API keys" subtitle={`Server-to-server credentials for ${mm.name} · ${mm.code}`} tools={<Pill tone={mm.status === "ACTIVE" ? "good" : "warn"}>{mm.status === "ACTIVE" ? "Active" : "Pending account approval"}</Pill>}>
        <div className="panel-body">{!m.isOwner ? <p className="faint" style={{ margin: 0 }}>Only workspace owners can create and revoke API keys.</p> : keys.isError ? <p className="faint">{describe(keys.error)}</p> : <KeyForm kyc={mm.kyc?.status} onCreate={async body => {
          const r = await act(() => api<{ name: string; key: string; message: string }>(`/merchants/me/api-keys${m.q()}`, { method: "POST", body }), r => `API key “${r.name}” created. Copy it now.`);
          if (r) setRevealed({ kind: "key", label: `API key · ${r.name}`, value: r.key, message: r.message });
        }} secret={secretBox("key")} />}</div>
        {m.isOwner && !keys.isError ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(keys.data ?? []).map(k => {
                  const expired = !!k.expiresAt && new Date(k.expiresAt) <= new Date();
                  const status = k.revokedAt ? "Revoked" : expired ? "Expired" : "Active";
                  return (
                    <tr key={k.id}>
                      <td>
                        <div className="strong">{k.name}</div>
                        <div className="sub">{k.scopes?.length ? k.scopes.map(x => <code key={x} style={{ marginRight: 4 }}>{x}</code>) : "Full access"}</div>
                      </td>
                      <td>
                        <code>{k.prefix}…</code>
                      </td>
                      <td className="nowrap">{when(k.createdAt)}</td>
                      <td className="nowrap">{k.lastUsedAt ? when(k.lastUsedAt) : "Never"}</td>
                      <td className="nowrap">{k.expiresAt ? dateOnly(k.expiresAt) : "No expiry"}</td>
                      <td>
                        <Pill tone={status === "Active" ? "good" : undefined}>{status === "Revoked" ? "Revoked (inactive)" : status}</Pill>
                      </td>
                      <td>
                        {status === "Active" ? (
                          <Button
                            size="sm"
                            onClick={async () => {
                              if (await confirm({ title: `Revoke “${k.name}”?`, message: "Integrations using this API key stop working immediately.", ok: "Revoke key", danger: true })) await act(() => api(`/merchants/me/api-keys/${k.id}${m.q()}`, { method: "DELETE" }), `API key “${k.name}” revoked.`);
                            }}
                          >
                            Revoke
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {keys.data && !keys.data.length ? (
                  <tr>
                    <td colSpan={7} className="empty-cell">
                      No API keys yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>
      <div className="api-layout">
        <Panel title="API reference" subtitle="REST over HTTPS · JSON request and response bodies" tools={<span className="pill info">Base URL · {base}</span>}>
          <div className="panel-body form-grid">
            <Code label="Authentication" code={"Authorization: Bearer YOUR_API_KEY\nContent-Type: application/json\nIdempotency-Key: unique-request-id"} />
            <Code label={<>Book a document consignment <span className="pill good">POST /parcels · 201 Created</span></>} code={example.create} note="The server prices the parcel from your service package. Keep the Idempotency-Key stable when retrying: a repeat returns the original parcel. merchantOrderRef must be unique (409 if it was already booked)." />
            <Code label={<>Get status and tracking history <span className="pill info">GET /parcels/{"{trackingId}"}</span></>} code={example.status} note="Includes status, charges, COD and the full event history." />
            <Code label={<>List parcels <span className="pill info">GET /parcels</span></>} code={example.list} note="Newest first. Filter by status, q (tracking ID, order reference, name or phone), from and to; pass the returned nextCursor for the next page." />
            <Code label={<>Cancel before pickup is confirmed <span className="pill info">POST /parcels/{"{trackingId}"}/cancel</span></>} code={example.cancel} />
            <h3 className="field full" style={{ fontSize: 14, margin: "6px 0 0" }}>
              Example responses
            </h3>
            <Code half label="Booked · 201 Created" code={`{"trackingId":"PP-261015-0001","status":"PENDING_CONFIRMATION","statusLabel":"Pending operations confirmation","charges":{"base":120,"weight":0,"service":0,"codFee":25,"discount":9.6,"total":135.4},"canCancel":true,…}`} />
            <Code half label="List · 200 OK" code={`{"items":[{"trackingId":"PP-261015-0001","status":"OUT_FOR_DELIVERY",…}],"nextCursor":null}`} />
            <Code half label="Validation error · 422" code={`{"error":{"code":"VALIDATION_FAILED","message":"Check the highlighted fields","details":[{"path":"recipient.phone","message":"…"}],"requestId":"…"}}`} />
            <Code half label="Duplicate order · 409" code={`{"error":{"code":"DUPLICATE_ORDER_REF","message":"Order ORDER-1001 was already booked as PP-261015-0001","details":{"trackingId":"PP-261015-0001"},"requestId":"…"}}`} />
            <p className="faint full" style={{ margin: 0 }}>
              Every error has the same shape. Handle 401 (invalid or revoked key), 404 (unknown tracking ID), 409 (duplicate or idempotency conflict), 422 (validation and business rules), 429 (rate limit) and retry 5xx responses with the same Idempotency-Key.
            </p>
          </div>
        </Panel>
        <Panel title="Webhooks" subtitle="Receive pickup and shipment status events." tools={<Pill tone={hooks.data?.length ? "good" : undefined}>{hooks.data?.length ? "Configured" : "Not configured"}</Pill>}>
          <div className="panel-body">
            {!m.isOwner ? (
              <p className="faint" style={{ margin: 0 }}>
                Only workspace owners can configure webhooks.
              </p>
            ) : (
              <>
                {secretBox("webhook")}
                {(hooks.data ?? []).map(h => (
                  <div key={h.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, marginTop: 12 }}>
                    <div className="row" style={{ justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ fontSize: 13, wordBreak: "break-all" }}>{h.url}</strong>
                        <div className="sub" style={{ marginTop: 4 }}>
                          {h.events.map(e => (
                            <code key={e} style={{ marginRight: 6 }}>
                              {e}
                            </code>
                          ))}
                        </div>
                      </div>
                      <Pill tone={h.active ? "good" : undefined}>{h.active ? "Active" : "Inactive"}</Pill>
                    </div>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                      <Button size="sm" onClick={() => act(() => api(`/merchants/me/webhooks/${h.id}/test${m.q()}`, { method: "POST" }), "Test event queued. Check Deliveries for the result.", { reload: false })}>
                        Send test
                      </Button>
                      <Button size="sm" onClick={() => void deliveries(h, m.q("&"))}>
                        Deliveries
                      </Button>
                      <Button
                        size="sm"
                        onClick={async () => {
                          if (!(await confirm({ title: "Rotate the signing secret?", message: "Deliveries are signed with the new secret right away; update your server first.", ok: "Rotate secret", danger: true }))) return;
                          const r = await act(() => api<{ secret: string; message: string }>(`/merchants/me/webhooks/${h.id}/rotate-secret${m.q()}`, { method: "POST" }), "Signing secret rotated.");
                          if (r) setRevealed({ kind: "webhook", label: "New signing secret", value: r.secret, message: r.message });
                        }}
                      >
                        Rotate secret
                      </Button>
                      <Button size="sm" onClick={() => act(() => api(`/merchants/me/webhooks/${h.id}${m.q()}`, { method: "PATCH", body: { active: !h.active } }), h.active ? "Webhook paused." : "Webhook resumed.")}>
                        {h.active ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        size="sm"
                        onClick={async () => {
                          if (await confirm({ title: "Remove this webhook endpoint?", message: "Pending deliveries to it are dropped.", ok: "Remove webhook", danger: true })) await act(() => api(`/merchants/me/webhooks/${h.id}${m.q()}`, { method: "DELETE" }), "Webhook removed.");
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
                <HookForm
                  more={!!hooks.data?.length}
                  onSave={async body => {
                    const r = await act(() => api<{ secret: string; message: string }>(`/merchants/me/webhooks${m.q()}`, { method: "POST", body }), "Webhook saved. Store the signing secret now.");
                    if (r) setRevealed({ kind: "webhook", label: "Signing secret", value: r.secret, message: r.message });
                    return !!r;
                  }}
                />
              </>
            )}
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
              <h3 style={{ margin: "0 0 7px", fontSize: 13 }}>Webhook delivery guidance</h3>
              <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
                <li>Respond with HTTP 2xx within 10 seconds; process work asynchronously.</li>
                <li>
                  Verify <code>X-DeliveryFast-Signature</code> (HMAC-SHA256 of <code>t.body</code>) with your signing secret and the raw body.
                </li>
                <li>
                  Deduplicate using the delivery <code>id</code>; delivery is at least once.
                </li>
                <li>Failed deliveries are retried with backoff; events may arrive out of order.</li>
                <li>Return 2xx for events you safely ignore.</li>
              </ul>
            </div>
          </div>
        </Panel>
      </div>
      <Panel title="Webhook payloads" subtitle="Every event shares one signed envelope.">
        <div className="panel-body form-grid">
          <Code half label="Shipment status update event" code={example.webhook} />
          <div className="field">
            <Code bare label="Pickup requested event (body)" code={example.requested} />
            <Code bare label="Verifying the signature" code={example.verify} />
          </div>
        </div>
      </Panel>
    </>
  );
}

function Code({ label, code, note, half, bare }: { label: ReactNode; code: string; note?: string; half?: boolean; bare?: boolean }) {
  return (
    <div className={bare ? "" : `field${half ? "" : " full"}`} style={bare ? { marginBottom: 12 } : undefined}>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
      <pre className="api-code">{code}</pre>
      {note ? <small className="faint">{note}</small> : null}
    </div>
  );
}

function KeyForm({ kyc, onCreate, secret }: { kyc?: string; onCreate: (body: { name: string; scopes: string[]; expiresAt?: string }) => Promise<void>; secret: ReactNode }) {
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [scopes, setScopes] = useState(new Set(["parcels:read", "parcels:write"]));
  const [busy, setBusy] = useState(false);
  return (
    <>
      {secret}
      <form
        className="form-grid"
        style={{ marginTop: 6 }}
        onSubmit={async e => {
          e.preventDefault();
          if (name.trim().length < 2) return toast("Enter a key name (at least 2 characters).");
          if (!scopes.size) return toast("Choose at least one permission for the key.");
          setBusy(true);
          await onCreate({ name: name.trim(), scopes: [...scopes], expiresAt: expiry ? new Date(`${expiry}T23:59:59`).toISOString() : undefined });
          setBusy(false);
          setName("");
        }}
      >
        <label className="field">
          <span>Key name</span>
          <input className="input" maxLength={80} placeholder="e.g. Shopify production" value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Expires (optional)</span>
          <input className="input" type="date" value={expiry} onChange={e => setExpiry(e.target.value)} />
        </label>
        <fieldset className="field full" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Permissions</legend>
          {API_KEY_SCOPES.map(([value, label]) => (
            <label key={value} style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: "4px 14px 4px 0", fontSize: 13 }} className="muted">
              <input
                type="checkbox"
                checked={scopes.has(value)}
                onChange={e =>
                  setScopes(s => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(value);
                    else n.delete(value);
                    return n;
                  })
                }
              />{" "}
              {label} <code>{value}</code>
            </label>
          ))}
          <small className="faint" style={{ display: "block" }}>
            Give each integration only what it needs.
          </small>
        </fieldset>
        {kyc !== "APPROVED" ? (
          <p className="faint full" style={{ margin: 0 }}>
            API keys may need verified business documents (Settings › Business verification).
          </p>
        ) : null}
        <div className="full row" style={{ gap: 10, flexWrap: "wrap" }}>
          <button type="submit" className="button primary" disabled={busy}>
            Create API key
          </button>
          <span className="faint">The full key is shown once. Delivery Fast stores only a hash.</span>
        </div>
      </form>
    </>
  );
}

function HookForm({ more, onSave }: { more: boolean; onSave: (body: { url: string; events: string[] }) => Promise<boolean> }) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState(new Set(["pickup.requested", "shipment.status_updated"]));
  return (
    <form
      style={{ marginTop: 14 }}
      onSubmit={async e => {
        e.preventDefault();
        if (!/^https?:\/\/\S+$/.test(url.trim())) return toast("Enter the endpoint URL.");
        if (!events.size) return toast("Choose at least one webhook event.");
        if (await onSave({ url: url.trim(), events: [...events] })) setUrl("");
      }}
    >
      <label className="field">
        <span>{more ? "Add another endpoint" : "HTTPS endpoint URL"}</span>
        <input className="input" type="url" placeholder="https://your-domain.com/webhooks/delivery-fast" value={url} onChange={e => setUrl(e.target.value)} />
        <small className="faint">Must be a public HTTPS address in production. Up to 5 endpoints.</small>
      </label>
      <fieldset style={{ border: 0, padding: 0, margin: "14px 0" }}>
        <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Subscribe to events</legend>
        {WEBHOOK_EVENTS.map(name => (
          <label key={name} className="row muted" style={{ gap: 8, margin: "8px 0", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={events.has(name)}
              onChange={e =>
                setEvents(s => {
                  const n = new Set(s);
                  if (e.target.checked) n.add(name);
                  else n.delete(name);
                  return n;
                })
              }
            />{" "}
            <code>{name}</code>
          </label>
        ))}
      </fieldset>
      <button type="submit" className="button primary">
        Save webhook
      </button>
    </form>
  );
}

async function deliveries(h: Webhook, q: string) {
  try {
    const page = await api<{ items: { event: string; state: string; attempts: number; responseCode?: number | null; createdAt: string; lastError?: string | null }[] }>(`/merchants/me/webhooks/${h.id}/deliveries?limit=25${q}`);
    await openCustom(
      close => (
        <>
          <div className="dialog-head">
            <div>
              <h2>Webhook deliveries</h2>
              <p style={{ wordBreak: "break-all" }}>{h.url}</p>
            </div>
            <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={() => close()}>
              <Icon name="x" size={18} />
            </button>
          </div>
          <div className="dialog-body">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>State</th>
                    <th>Tries</th>
                    <th>HTTP</th>
                    <th>Created</th>
                    <th>Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((d, i) => (
                    <tr key={i}>
                      <td>
                        <code>{d.event}</code>
                      </td>
                      <td>
                        <Pill tone={d.state === "SUCCEEDED" ? "good" : d.state === "FAILED" ? "bad" : "warn"}>{d.state === "SUCCEEDED" ? "Delivered" : d.state === "FAILED" ? "Failed" : "Pending"}</Pill>
                      </td>
                      <td>{d.attempts}</td>
                      <td>{d.responseCode ?? "—"}</td>
                      <td className="nowrap">{when(d.createdAt)}</td>
                      <td style={{ maxWidth: 180, wordBreak: "break-word" }}>{d.lastError || ""}</td>
                    </tr>
                  ))}
                  {!page.items.length ? (
                    <tr>
                      <td colSpan={6} className="empty-cell">
                        No deliveries yet. Send a test to check your endpoint.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ),
      "wide",
    );
  } catch (e) {
    toast(describe(e), "bad");
  }
}
