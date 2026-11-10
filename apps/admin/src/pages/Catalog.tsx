/**
 * Operational settings: Product categories, Priorities and Delivery types (GET/POST/PATCH/DELETE /product-categories,
 * /parcel-priorities, /delivery-types). Categories and priorities have one list per merchant type (Customer &
 * E-commerce · Banking & Financial); delivery types are one list, each offered to the categories ticked. A category's
 * SMS / email / push switches decide where its parcels' messages go; a priority is a tag (no charge); a delivery type's
 * + charge is set per package in Service plans & pricing.
 */
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { confirm, openForm } from "@panel/ui/dialogs";
import { Button, Loading, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { toastError } from "@panel/ui/toast";
import { SEGMENTS, useCategories, useDeliveryTypes, usePriorities, type Category, type DeliveryType, type Priority, type Segment } from "@/lib/packages";

type List = "ECOMMERCE" | "BANKING_FINANCIAL";
// Banking & Financial first (most of the work).
const LISTS: [List, string, string][] = [
  ["BANKING_FINANCIAL", "Banking & Financial", "banking"],
  ["ECOMMERCE", "Customer & E-commerce", "e-commerce"],
];
const SLA: [DeliveryType["slaLevel"], string][] = [
  ["REGULAR", "Regular SLA"],
  ["SAME_DAY", "Same-day SLA"],
  ["EXPRESS", "Express SLA"],
];

/** The list tab (?tab=banking | e-commerce), Banking & Financial by default. */
function useList(): [List, (l: List) => void] {
  const [params, setParams] = useSearchParams();
  const list: List = params.get("tab") === "e-commerce" ? "ECOMMERCE" : "BANKING_FINANCIAL";
  return [list, l => setParams({ tab: LISTS.find(x => x[0] === l)![2] }, { replace: true })];
}
function ListTabs({ list, set }: { list: List; set: (l: List) => void }) {
  return (
    <div className="seg-tabs" role="tablist" style={{ marginBottom: 12 }}>
      {LISTS.map(([code, label]) => (
        <button key={code} type="button" role="tab" aria-selected={list === code} className={list === code ? "on" : ""} onClick={() => set(code)}>
          {label}
        </button>
      ))}
    </div>
  );
}
function useRunner(keys: string[][]) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState("");
  const reload = () => Promise.all(keys.map(queryKey => qc.invalidateQueries({ queryKey })));
  const run = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await work();
      await reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  };
  return { busy, run, reload };
}
const onOff = (on: boolean, label: string) => <Pill tone={on ? "good" : "neutral"}>{`${label} ${on ? "on" : "off"}`}</Pill>;

// ───────────── product categories ─────────────

export function ProductCategories() {
  const [list, setList] = useList();
  const categories = useCategories();
  const { busy, run, reload } = useRunner([["admin", "product-categories"], ["admin", "parcel-products"]]);
  const rows = (categories.data ?? []).filter(c => c.segment === list);
  const listLabel = LISTS.find(l => l[0] === list)![1];

  async function edit(c: Category | null) {
    const channels = c ? [c.notifySms && "sms", c.notifyEmail && "email", c.notifyPush && "push"].filter(Boolean).join(",") : "sms,email,push";
    await openForm({
      title: c ? `Edit ${c.name}` : `Add a ${listLabel} category`,
      submit: c ? "Save" : "Add category",
      fields: [
        { id: "name", label: "Category name", required: true, maxLength: 80, value: c?.name ?? "", placeholder: list === "BANKING_FINANCIAL" ? "e.g. Cards & PIN" : "e.g. Fashion & Clothing", full: true },
        {
          id: "channels",
          label: "Messages its parcels may get",
          type: "checks",
          value: channels,
          options: [
            { value: "sms", label: "SMS" },
            { value: "email", label: "Email" },
            { value: "push", label: "Push (app)" },
          ],
          hint: "A channel that is off sends nothing for these parcels, whatever the booking ticked.",
        },
        { id: "sortOrder", label: "Order in lists", type: "number", value: c?.sortOrder ?? rows.length, hint: "Smaller first." },
      ],
      onSubmit: async v => {
        const on = new Set((v.channels || "").split(",").filter(Boolean));
        const body = { name: v.name.trim(), notifySms: on.has("sms"), notifyEmail: on.has("email"), notifyPush: on.has("push"), sortOrder: Number(v.sortOrder) || 0 };
        if (c) await api(`/product-categories/${c.id}`, { method: "PATCH", body });
        else await api("/product-categories", { method: "POST", body: { ...body, segment: list } });
        await reload();
        return c ? `${body.name} saved.` : `${body.name} added.`;
      },
    });
  }

  return (
    <>
      <PageHeading eyebrow="Operational settings" title="Product categories" subtitle="Products are listed under categories. A category's SMS, email and push switches decide where its parcels' messages go." />
      <ListTabs list={list} set={setList} />
      <Panel
        title={`${listLabel} categories`}
        subtitle="Keep them few. A category with products can't be deleted (move its products first); one with parcels can be deactivated."
        tools={
          <Button variant="primary" onClick={() => void edit(null)}>
            Add category
          </Button>
        }
      >
        {categories.isLoading ? (
          <Loading rows={6} />
        ) : categories.error ? (
          <div className="callout bad" style={{ margin: 16 }}>
            {describe(categories.error)}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Messages</th>
                  <th className="num">Products</th>
                  <th className="num">Parcels</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(c => (
                  <tr key={c.id}>
                    <td className="strong">
                      {c.name}
                      {(c as { aiCreated?: boolean }).aiCreated ? <> <Pill>AI created</Pill></> : null}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {onOff(c.notifySms, "SMS")}
                        {onOff(c.notifyEmail, "Email")}
                        {onOff(c.notifyPush, "Push")}
                      </div>
                    </td>
                    <td className="num">{c.products.toLocaleString("en-US")}</td>
                    <td className="num">{c.parcels.toLocaleString("en-US")}</td>
                    <td>
                      <Pill tone={c.active ? "good" : "warn"}>{c.active ? "Active" : "Inactive"}</Pill>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 5, justifyContent: "flex-end" }}>
                        <Button size="sm" onClick={() => void edit(c)}>
                          Edit
                        </Button>
                        <Button size="sm" disabled={busy === c.id} onClick={() => void run(c.id, () => api(`/product-categories/${c.id}`, { method: "PATCH", body: { active: !c.active } }))}>
                          {c.active ? "Deactivate" : "Activate"}
                        </Button>
                        {c.products || c.parcels ? null : (
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy === c.id}
                            onClick={async () => {
                              if (await confirm({ title: `Delete ${c.name}?`, message: "The category is removed.", ok: "Delete", danger: true })) await run(c.id, () => api(`/product-categories/${c.id}`, { method: "DELETE" }));
                            }}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={6} className="faint" style={{ textAlign: "center" }}>
                      No categories yet. Add the first one.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

// ───────────── priorities ─────────────

export function Priorities() {
  const [list, setList] = useList();
  const priorities = usePriorities();
  const { busy, run, reload } = useRunner([["admin", "parcel-priorities"]]);
  const rows = (priorities.data ?? []).filter(p => p.segment === list);
  const listLabel = LISTS.find(l => l[0] === list)![1];

  async function edit(p: Priority | null) {
    await openForm({
      title: p ? `Edit ${p.name}` : `Add a ${listLabel} priority`,
      submit: p ? "Save" : "Add priority",
      fields: [
        { id: "name", label: "Priority name", required: true, maxLength: 80, value: p?.name ?? "", placeholder: list === "BANKING_FINANCIAL" ? "e.g. Security" : "e.g. Fragile", full: true },
        { id: "isDefault", label: "Default", type: "checkbox", value: p?.isDefault ?? false, hint: "Preselected in bookings and imports (one per list)." },
        { id: "sortOrder", label: "Order in lists", type: "number", value: p?.sortOrder ?? rows.length, hint: "Smaller first." },
      ],
      onSubmit: async v => {
        const body = { name: v.name.trim(), isDefault: v.isDefault === "true", sortOrder: Number(v.sortOrder) || 0 };
        if (p) await api(`/parcel-priorities/${p.id}`, { method: "PATCH", body });
        else await api("/parcel-priorities", { method: "POST", body: { ...body, segment: list } });
        await reload();
        return p ? `${body.name} saved.` : `${body.name} added.`;
      },
    });
  }

  return (
    <>
      <PageHeading eyebrow="Operational settings" title="Priorities" subtitle="A tag on each parcel (no charge), chosen in bookings and imports and filtered in the parcel lists. The default is preselected." />
      <ListTabs list={list} set={setList} />
      <Panel
        title={`${listLabel} priorities`}
        subtitle="One is the default. A priority with parcels can be deactivated; one without can be deleted."
        tools={
          <Button variant="primary" onClick={() => void edit(null)}>
            Add priority
          </Button>
        }
      >
        {priorities.isLoading ? (
          <Loading rows={4} />
        ) : priorities.error ? (
          <div className="callout bad" style={{ margin: 16 }}>
            {describe(priorities.error)}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Priority</th>
                  <th />
                  <th className="num">Parcels</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(p => (
                  <tr key={p.id}>
                    <td className="strong">{p.name}</td>
                    <td>{p.isDefault ? <Pill tone="info">Default</Pill> : null}</td>
                    <td className="num">{p.parcels.toLocaleString("en-US")}</td>
                    <td>
                      <Pill tone={p.active ? "good" : "warn"}>{p.active ? "Active" : "Inactive"}</Pill>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 5, justifyContent: "flex-end" }}>
                        <Button size="sm" onClick={() => void edit(p)}>
                          Edit
                        </Button>
                        {p.isDefault ? null : (
                          <Button size="sm" disabled={busy === p.id} onClick={() => void run(p.id, () => api(`/parcel-priorities/${p.id}`, { method: "PATCH", body: { isDefault: true } }))}>
                            Make default
                          </Button>
                        )}
                        {p.isDefault ? null : (
                          <Button size="sm" disabled={busy === p.id} onClick={() => void run(p.id, () => api(`/parcel-priorities/${p.id}`, { method: "PATCH", body: { active: !p.active } }))}>
                            {p.active ? "Deactivate" : "Activate"}
                          </Button>
                        )}
                        {p.parcels || p.isDefault ? null : (
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy === p.id}
                            onClick={async () => {
                              if (await confirm({ title: `Delete ${p.name}?`, message: "The priority is removed.", ok: "Delete", danger: true })) await run(p.id, () => api(`/parcel-priorities/${p.id}`, { method: "DELETE" }));
                            }}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={5} className="faint" style={{ textAlign: "center" }}>
                      No priorities yet. Add the first one.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

// ───────────── delivery types ─────────────

export function DeliveryTypes() {
  const types = useDeliveryTypes();
  const { busy, run, reload } = useRunner([["admin", "delivery-types"], ["admin", "service-catalog"]]);
  const rows = types.data ?? [];
  const segLabel = (s: Segment) => (s === "BANKING_FINANCIAL" ? "Banking & Financial" : (SEGMENTS.find(([c]) => c === s)?.[1] ?? s));

  async function edit(t: DeliveryType | null) {
    await openForm({
      title: t ? `Edit ${t.name}` : "Add a delivery type",
      submit: t ? "Save" : "Add delivery type",
      fields: [
        { id: "name", label: "Name", required: true, maxLength: 80, value: t?.name ?? "", placeholder: "e.g. Night Delivery", full: true },
        ...(t ? [{ id: "code", label: "Code", type: "static" as const, value: t.code, hint: "Stored on parcels; it doesn't change." }] : []),
        {
          id: "segments",
          label: "Offered to",
          type: "checks",
          required: true,
          value: (t?.segments ?? ["BANKING_FINANCIAL", "ECOMMERCE", "CUSTOMER"]).join(","),
          options: [
            { value: "BANKING_FINANCIAL", label: "Banking & Financial" },
            { value: "ECOMMERCE", label: "E-commerce" },
            { value: "CUSTOMER", label: "Customer parcel" },
          ],
        },
        { id: "slaLevel", label: "Timed by", type: "select", required: true, value: t?.slaLevel ?? "REGULAR", options: SLA.map(([value, label]) => ({ value, label })), hint: "The SLA policies that set its pickup and delivery targets." },
        { id: "sortOrder", label: "Order in lists", type: "number", value: t?.sortOrder ?? rows.length, hint: "Smaller first; the first one offered is the default." },
      ],
      onSubmit: async v => {
        const body = { name: v.name.trim(), segments: (v.segments || "").split(",").filter(Boolean), slaLevel: v.slaLevel, sortOrder: Number(v.sortOrder) || 0 };
        if (t) await api(`/delivery-types/${t.id}`, { method: "PATCH", body });
        else await api("/delivery-types", { method: "POST", body });
        await reload();
        return t ? `${body.name} saved.` : `${body.name} added. Set its + charge in Service plans & pricing.`;
      },
    });
  }

  return (
    <>
      <PageHeading eyebrow="Operational settings" title="Delivery types" subtitle="Regular, Express, 4 Hour, Same Day… chosen for each parcel. Each type's + charge is set per package in Service plans & pricing; any type on any route." />
      <Panel
        title="Delivery types"
        subtitle="A type with parcels can be deactivated; one without can be deleted. Every category keeps at least one active type."
        tools={
          <Button variant="primary" onClick={() => void edit(null)}>
            Add delivery type
          </Button>
        }
      >
        {types.isLoading ? (
          <Loading rows={4} />
        ) : types.error ? (
          <div className="callout bad" style={{ margin: 16 }}>
            {describe(types.error)}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Delivery type</th>
                  <th>Offered to</th>
                  <th>Timed by</th>
                  <th className="num">Parcels</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(t => (
                  <tr key={t.id}>
                    <td>
                      <span className="strong">{t.name}</span>
                      <span className="sub">{t.code}</span>
                    </td>
                    <td>{t.segments.map(segLabel).join(", ")}</td>
                    <td>{SLA.find(([v]) => v === t.slaLevel)?.[1] ?? t.slaLevel}</td>
                    <td className="num">{t.parcels.toLocaleString("en-US")}</td>
                    <td>
                      <Pill tone={t.active ? "good" : "warn"}>{t.active ? "Active" : "Inactive"}</Pill>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 5, justifyContent: "flex-end" }}>
                        <Button size="sm" onClick={() => void edit(t)}>
                          Edit
                        </Button>
                        <Button size="sm" disabled={busy === t.id} onClick={() => void run(t.id, () => api(`/delivery-types/${t.id}`, { method: "PATCH", body: { active: !t.active } }))}>
                          {t.active ? "Deactivate" : "Activate"}
                        </Button>
                        {t.parcels ? null : (
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy === t.id}
                            onClick={async () => {
                              if (await confirm({ title: `Delete ${t.name}?`, message: "The delivery type is removed (its + charges in packages are ignored).", ok: "Delete", danger: true })) await run(t.id, () => api(`/delivery-types/${t.id}`, { method: "DELETE" }));
                            }}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
