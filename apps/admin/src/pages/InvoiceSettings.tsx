/**
 * Invoice settings (bridge-invoice.js, GET / PUT /finance/config): what parcel invoices and bills print — the
 * delivery charge on delivery invoices, VAT on / off and its rate, and the company (name, BIN, address) on bills.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { Button, Loading, PageHeading, Panel } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { toast } from "@panel/ui/toast";

interface InvoiceConfig {
  showDeliveryCharge: boolean;
  vatEnabled: boolean;
  vatRate: number;
  seller: { name?: string; bin?: string; address?: string };
}

export default function InvoiceSettings() {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["admin", "finance-config"], queryFn: () => api<InvoiceConfig>("/finance/config") });
  const [draft, setDraft] = useState<InvoiceConfig | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (cfg.data && !draft) setDraft({ ...cfg.data, seller: { ...cfg.data.seller } });
  }, [cfg.data, draft]);
  const c = draft;
  const set = (patch: Partial<InvoiceConfig>) => setDraft(d => (d ? { ...d, ...patch } : d));
  const setSeller = (patch: InvoiceConfig["seller"]) => setDraft(d => (d ? { ...d, seller: { ...d.seller, ...patch } } : d));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!c) return;
    const body = { showDeliveryCharge: c.showDeliveryCharge, vatEnabled: c.vatEnabled, vatRate: Number(c.vatRate), seller: { name: (c.seller.name || "").trim(), bin: (c.seller.bin || "").trim(), address: (c.seller.address || "").trim() } };
    if (!body.seller.name) return toast("Enter the company name on bills.", "bad");
    if (!(body.vatRate >= 0 && body.vatRate <= 50)) return toast("The VAT rate must be between 0 and 50.", "bad");
    setSaving(true);
    setError("");
    try {
      const saved = await api<InvoiceConfig>("/finance/config", { method: "PUT", body });
      qc.setQueryData(["admin", "finance-config"], saved);
      setDraft({ ...saved, seller: { ...saved.seller } });
      toast(`Invoice settings saved: delivery charge ${saved.showDeliveryCharge ? "shown" : "hidden"} on invoices, VAT ${saved.vatEnabled ? `on at ${saved.vatRate}%` : "off"}.`, "good");
    } catch (err) {
      setError(describe(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeading eyebrow="Platform control · money" title="Invoice settings" subtitle="What parcel invoices and bills print: the delivery charge, VAT and the company on bills." />
      {!c ? (
        cfg.error ? <div className="callout bad">{describe(cfg.error)}</div> : <Loading rows={4} />
      ) : (
        <form onSubmit={e => void save(e)} noValidate>
          <div className="grid-3" style={{ alignItems: "start" }}>
            <Panel title="Delivery invoices" subtitle="The invoices printed for parcels (A4, 4 or 8 per page, POS receipt)">
              <div className="panel-body">
                <label className="field">
                  <span>Show delivery charge on invoice</span>
                  <Select className="select" value={c.showDeliveryCharge === false ? "off" : "on"} onChange={e => set({ showDeliveryCharge: e.target.value !== "off" })}>
                    <option value="on">Show: price lines, VAT and the delivery charge</option>
                    <option value="off">Hide: only the COD to collect</option>
                  </Select>
                  <small>Hide it when the delivery charge is taken out of the COD in practice, so the recipient sees only the cash to pay.</small>
                </label>
              </div>
            </Panel>
            <Panel title="VAT" subtitle="With VAT off, charges already include everything and no VAT or BIN is shown anywhere">
              <div className="panel-body form-grid">
                <label className="field full">
                  <span>VAT</span>
                  <Select className="select" value={c.vatEnabled ? "on" : "off"} onChange={e => set({ vatEnabled: e.target.value === "on" })}>
                    <option value="off">Off: no VAT shown</option>
                    <option value="on">On: show VAT at the rate below</option>
                  </Select>
                </label>
                <label className="field">
                  <span>VAT rate (%)</span>
                  <input className="input" type="number" min={0} max={50} step={0.01} required value={String(c.vatRate)} onChange={e => set({ vatRate: e.target.value as unknown as number })} />
                  <small>Used only while VAT is on.</small>
                </label>
                <label className="field">
                  <span>Company BIN</span>
                  <input className="input" maxLength={14} value={c.seller.bin || ""} onChange={e => setSeller({ bin: e.target.value })} />
                  <small>Printed while VAT is on. 13 digits (or 9 digits-4 digits).</small>
                </label>
              </div>
            </Panel>
            <Panel title="Company on bills" subtitle="Printed on bills, statements and invoices">
              <div className="panel-body form-grid">
                <label className="field full">
                  <span>Company name on bills</span>
                  <input className="input" maxLength={160} required value={c.seller.name || ""} onChange={e => setSeller({ name: e.target.value })} />
                </label>
                <label className="field full">
                  <span>Company address on bills</span>
                  <textarea className="textarea" rows={3} maxLength={300} value={c.seller.address || ""} onChange={e => setSeller({ address: e.target.value })} />
                </label>
              </div>
            </Panel>
          </div>
          {error ? (
            <p role="alert" style={{ color: "var(--bad)", fontWeight: 600, margin: "12px 0 0" }}>
              {error}
            </p>
          ) : null}
          <div style={{ marginTop: 16 }}>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
