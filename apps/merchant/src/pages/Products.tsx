/**
 * Product catalogue (merchant-features.js products): the merchant's document classes (GET/POST/PATCH/DELETE
 * /merchants/me/products), used to prefill new requests. Cards, search, Export (CSV), Add / Edit / Remove.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@panel/lib/api";
import { saveCsv } from "@panel/lib/csv";
import { money, num } from "@panel/lib/format";
import { confirm, openForm } from "@panel/ui/dialogs";
import { Button, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import { useMerchant } from "@/lib/merchant";
import { Pager } from "@/features/parcels/Pager";

interface Product {
  id: string;
  name: string;
  sku: string;
  category?: string | null;
  price: number;
  weightKg?: number | null;
  packaging?: string | null;
  active: boolean;
}

export default function Products() {
  const m = useMerchant();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["m", "products"],
    queryFn: async () => {
      const all: Product[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Product[]; nextCursor?: string | null } = await api(`/merchants/me/products?limit=200${m.q("&")}${cursor ? `&cursor=${cursor}` : ""}`);
        all.push(...page.items);
        cursor = page.nextCursor ?? null;
      } while (cursor);
      return all.sort((a, b) => a.name.localeCompare(b.name));
    },
  });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const items = list.data ?? [];
  const t = search.trim().toLowerCase();
  const shown = t ? items.filter(p => `${p.name} ${p.sku} ${p.category ?? ""} ${p.packaging ?? ""}`.toLowerCase().includes(t)) : items;
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const rows = shown.slice((page - 1) * size, page * size);
  const columns = ["Document class", "Code", "Category", "Price", "Default weight / packaging", "Status"];
  const values = (p: Product) => [p.name, p.sku, p.category || "—", !p.price ? "Per service package" : money(p.price), [p.weightKg ? `${p.weightKg} kg` : "", p.packaging || ""].filter(Boolean).join(" · ") || "—", p.active ? "Active" : "Inactive"];
  const reload = () => qc.invalidateQueries({ queryKey: ["m", "products"] });

  function edit(p: Product | null) {
    const optional = (v: string) => (v.trim() ? v.trim() : p ? null : undefined);
    return openForm({
      title: p ? `Edit ${p.name}` : "Add document class",
      description: "Prefills the order form: item, weight, packaging and value.",
      submit: "Save",
      fields: [
        { id: "name", label: "Document class", value: p?.name ?? "", required: true, maxLength: 160 },
        { id: "sku", label: "Code", value: p?.sku ?? "", required: true, maxLength: 60 },
        { id: "category", label: "Category", value: p?.category ?? "", maxLength: 80 },
        { id: "price", label: "Declared value (BDT)", type: "number", value: String(p?.price ?? 0), min: 0, step: 0.01, required: true },
        { id: "weight", label: "Default weight (kg)", type: "number", value: p?.weightKg != null ? String(p.weightKg) : "", min: 0.01, max: 50, step: 0.01 },
        { id: "packaging", label: "Default packaging", value: p?.packaging ?? "", maxLength: 80 },
        { id: "active", label: "Active (offered in the order form)", type: "checkbox", value: p?.active !== false, full: true },
      ],
      validate: {
        sku: v => (/^[\w.\-/ ]+$/.test(v.trim()) ? "" : "Use letters, digits, spaces and - _ . /"),
        price: v => (Number(v) >= 0 ? "" : "Enter 0 or more"),
        weight: v => (!v || (Number(v) > 0 && Number(v) <= 50) ? "" : "Use a weight between 0.01 and 50 kg"),
      },
      onSubmit: async v => {
        const body = {
          name: v.name.trim(),
          sku: v.sku.trim(),
          category: optional(v.category),
          price: Number(v.price) || 0,
          weightKg: v.weight ? Number(v.weight) : p ? null : undefined,
          packaging: optional(v.packaging),
          active: v.active === "true",
        };
        await api(`/merchants/me/products${p ? `/${p.id}` : ""}${m.q()}`, { method: p ? "PATCH" : "POST", body });
        void reload();
        return `${body.name} saved.`;
      },
    });
  }
  async function remove(p: Product) {
    if (!(await confirm({ title: `Remove ${p.name}?`, message: `${p.sku} is removed from the catalogue. Shipments already booked keep it.`, ok: "Remove product", danger: true }))) return;
    try {
      await api(`/merchants/me/products/${p.id}${m.q()}`, { method: "DELETE" });
      toast(`${p.name} removed.`);
    } catch (e) {
      toast(String((e as Error).message), "bad");
    }
    void reload();
  }

  return (
    <>
      <PageHeading
        eyebrow="Banking & Financial workspace"
        title="Product catalogue"
        subtitle="Document classes you send often. They prefill new delivery requests."
        actions={
          <>
            <Button variant="primary" icon="plus" onClick={() => void edit(null)}>
              Add document class
            </Button>
            <Button
              icon="download"
              onClick={() => {
                if (!shown.length) return toast("There are no document classes to export.");
                saveCsv("product-catalogue.csv", [columns, ...shown.map(values)]);
                toast(`${num(shown.length)} document class${shown.length === 1 ? "" : "es"} exported.`, "good");
              }}
            >
              Export
            </Button>
          </>
        }
      />
      <div className="metrics">
        <Metric label="Document classes" value={list.data ? num(items.length) : "—"} icon="box" />
        <Metric label="Active" value={list.data ? num(items.filter(p => p.active).length) : "—"} icon="check" />
        <Metric label="Categories" value={list.data ? num(new Set(items.map(p => p.category).filter(Boolean)).size) : "—"} icon="sheet" />
      </div>
      <Panel
        title="Products list"
        subtitle={list.data ? `Catalogue · ${items.length} item(s) · used to prefill new orders` : "Loading the catalogue…"}
        tools={<input className="input sm" type="search" placeholder="Search products..." aria-label="Search products" value={search} onChange={e => (setSearch(e.target.value), setPage(1))} style={{ width: 240 }} />}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {columns.map(c => (
                  <th key={c}>{c}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const v = values(p);
                return (
                  <tr key={p.id}>
                    <td className="strong">{v[0]}</td>
                    <td className="mono">{v[1]}</td>
                    <td>{v[2]}</td>
                    <td>{v[3]}</td>
                    <td>{v[4]}</td>
                    <td>
                      <Pill tone={p.active ? "good" : undefined}>{v[5]}</Pill>
                    </td>
                    <td className="nowrap">
                      <Button size="sm" onClick={() => void edit(p)}>
                        Edit
                      </Button>{" "}
                      <Button size="sm" onClick={() => void remove(p)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    {list.isLoading ? "Loading…" : t ? "No document classes match." : "No document classes yet. Add the ones you send most often."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Pager page={page} pages={pages} size={size} total={shown.length} shown={rows.length} noun="item" setPage={setPage} setSize={s => (setSize(s), setPage(1))} />
      </Panel>
    </>
  );
}
