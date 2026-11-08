/**
 * Products (Operational settings, bridge-packages.js renderProducts): the products offered in bookings, one list per
 * merchant type (Customer & E-commerce · Banking & Financial). Search, status filter, sort by name, Export Excel
 * (GET /parcel-products/export), add / edit (name and type), activate / deactivate, delete one without parcels.
 * Which products send messages is set in Service plans › Messages.
 */
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, describe, download } from "@panel/lib/api";
import { confirm, openForm } from "@panel/ui/dialogs";
import { Button, Loading, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { Pager, usePaged } from "@panel/ui/Pager";
import { Select } from "@panel/ui/Select";
import { toast, toastError } from "@panel/ui/toast";
import { useProducts, useServiceCatalog, type Product } from "@/lib/packages";

const LISTS: ["ECOMMERCE" | "BANKING_FINANCIAL", string, string][] = [
  ["ECOMMERCE", "Customer & E-commerce", "e-commerce"],
  ["BANKING_FINANCIAL", "Banking & Financial", "banking"],
];

export default function Products() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const list = params.get("tab") === "banking" ? "BANKING_FINANCIAL" : "ECOMMERCE";
  const products = useProducts();
  const catalog = useServiceCatalog();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<"" | "asc" | "desc">("");
  const [busy, setBusy] = useState("");
  const reload = () => qc.invalidateQueries({ queryKey: ["admin", "parcel-products"] });
  const all = (products.data ?? []).filter(p => p.segment === list);
  if (sort) all.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) * (sort === "asc" ? 1 : -1));
  const query = q.trim().toLowerCase();
  const shown = all.filter(p => (!query || p.name.toLowerCase().includes(query)) && (!status || p.active === (status === "active")));
  const { rows, pager } = usePaged(shown, 25);
  const typeLabel = (code: string) => catalog.data?.productTypes.find(t => t.code === code)?.label || code;
  const listLabel = LISTS.find(l => l[0] === list)![1];

  async function edit(product: Product | null) {
    const types = catalog.data?.productTypes ?? [];
    await openForm({
      title: product ? `Edit ${product.name}` : "Add product",
      submit: product ? "Save" : "Add product",
      fields: [
        { id: "name", label: "Product name", required: true, maxLength: 120, value: product?.name ?? "", placeholder: list === "BANKING_FINANCIAL" ? "e.g. Credit Cards" : "e.g. Fashion & Apparel", full: true },
        { id: "type", label: "Type", type: "select", required: true, value: product?.type ?? types[0]?.code ?? "", options: types.map(t => ({ value: t.code, label: t.label })), hint: "The type prices the parcel.", full: true },
      ],
      onSubmit: async v => {
        const name = v.name.trim();
        if (product) await api(`/parcel-products/${product.id}`, { method: "PATCH", body: { name, type: v.type } });
        else await api("/parcel-products", { method: "POST", body: { segment: list, name, type: v.type } });
        await reload();
        return product ? `${name} saved.` : `${name} added.`;
      },
    });
  }
  async function run(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    try {
      await work();
      await reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  async function exportExcel() {
    const p = new URLSearchParams({ segment: list });
    if (q.trim()) p.set("q", q.trim());
    if (status) p.set("status", status);
    if (sort) p.set("sort", sort);
    setBusy("export");
    try {
      await download(`/parcel-products/export?${p}`, "products.xlsx");
      toast("Products exported to Excel.", "good");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <PageHeading eyebrow="Operational settings" title="Products" subtitle="The products offered in bookings, by merchant type. A product's type (Regular, Document, Books) prices the parcel." />
      <div className="seg-tabs" role="tablist" style={{ marginBottom: 12 }}>
        {LISTS.map(([code, label, slug]) => (
          <button
            key={code}
            type="button"
            role="tab"
            aria-selected={list === code}
            className={list === code ? "on" : ""}
            onClick={() => {
              setParams({ tab: slug }, { replace: true });
              setQ("");
              setStatus("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <Panel title={`${listLabel} products`} subtitle="Optional in bookings. A product with parcels can be deactivated; one without can be deleted. Messages are switched on in Service plans.">
        <div className="row" style={{ gap: 8, flexWrap: "wrap", padding: "12px 16px" }}>
          <input className="input sm" type="search" placeholder="Search products" aria-label="Search products" value={q} onChange={e => setQ(e.target.value)} style={{ width: 240 }} />
          <Select className="select sm" aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
          <span className="faint" role="status">
            {all.length ? `${shown.length.toLocaleString("en-US")} of ${all.length.toLocaleString("en-US")} products` : ""}
          </span>
          <span className="row" style={{ gap: 8, marginLeft: "auto" }}>
            <Button disabled={busy === "export"} onClick={() => void exportExcel()}>
              {busy === "export" ? "Exporting…" : "Export Excel"}
            </Button>
            <Button variant="primary" onClick={() => void edit(null)}>
              Add product
            </Button>
          </span>
        </div>
        {products.isLoading ? (
          <Loading rows={6} />
        ) : products.error ? (
          <div className="callout bad" style={{ margin: 16 }}>
            {describe(products.error)}
          </div>
        ) : !all.length ? (
          <p className="panel-body faint">No products yet. Add the first one.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th aria-sort={sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none"}>
                      <button type="button" className="link-button" title="Sort by name" onClick={() => setSort(sort === "asc" ? "desc" : "asc")} style={{ font: "inherit", letterSpacing: "inherit", textTransform: "inherit", color: "inherit" }}>
                        PRODUCT <span aria-hidden="true">{sort === "asc" ? "▲" : sort === "desc" ? "▼" : "↕"}</span>
                      </button>
                    </th>
                    <th>Type</th>
                    <th>Status</th>
                    <th className="num">Parcels</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(p => (
                    <tr key={p.id}>
                      <td className="strong">{p.name}</td>
                      <td>{typeLabel(p.type)}</td>
                      <td>
                        <Pill tone={p.active ? "good" : "warn"}>{p.active ? "Active" : "Inactive"}</Pill>
                      </td>
                      <td className="num">{Number(p.parcels).toLocaleString("en-US")}</td>
                      <td>
                        <div className="row" style={{ gap: 5, justifyContent: "flex-end" }}>
                          <Button size="sm" onClick={() => void edit(p)}>
                            Edit
                          </Button>
                          <Button size="sm" disabled={busy === p.id} onClick={() => void run(p.id, () => api(`/parcel-products/${p.id}`, { method: "PATCH", body: { active: !p.active } }))}>
                            {p.active ? "Deactivate" : "Activate"}
                          </Button>
                          {p.parcels ? null : (
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={busy === p.id}
                              onClick={async () => {
                                if (await confirm({ title: `Delete ${p.name}?`, message: "The product is removed from the catalogue.", ok: "Delete", danger: true })) await run(p.id, () => api(`/parcel-products/${p.id}`, { method: "DELETE" }));
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
                        No products match.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <Pager {...pager} noun="product" />
          </>
        )}
      </Panel>
    </>
  );
}
