/**
 * Return reasons and Receiver relations (02.js catalogForm, shown one at a time by bridge-menu.js): chips with ×,
 * and Add. Saved in the platform settings (`returnReasons`, `receiverRelations`); returns forms, riders, the hub
 * desk and Collect from hub use them. Self always stays first among receiver relations.
 */
import { useState, type FormEvent } from "react";
import { describe } from "@panel/lib/api";
import { Button, Loading, PageHeading, Panel } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { savePlatformConfig, usePlatformConfig } from "@/lib/admin";

const DEFAULTS = {
  returnReasons: ["Recipient refused", "Recipient unreachable", "Wrong or incomplete address", "Recipient asked to cancel", "Damaged in transit", "Merchant cancelled the order", "Delivery attempts exhausted"],
  receiverRelations: ["Self", "Father", "Mother", "Spouse", "Son", "Daughter", "Brother", "Sister", "Relative", "Neighbour", "Colleague", "Security guard", "Reception", "Other"],
};
const PARTS = {
  returnReasons: { title: "Return reasons", label: "return reason", subtitle: "The reasons offered on return forms." },
  receiverRelations: { title: "Receiver relations", label: "receiver relation", subtitle: "Who received a delivery, as chosen by riders, the hub desk and Collect from hub." },
};
type Key = keyof typeof PARTS;

export const ReturnReasons = () => <CatalogList id="returnReasons" />;
export const ReceiverRelations = () => <CatalogList id="receiverRelations" />;
export default ReturnReasons;

function CatalogList({ id }: { id: Key }) {
  const part = PARTS[id];
  const config = usePlatformConfig();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const saved = config.data?.[id];
  const items: string[] = Array.isArray(saved) ? (saved as string[]) : DEFAULTS[id];

  async function change(next: (list: string[]) => string[], message: string) {
    setBusy(true);
    try {
      await savePlatformConfig(c => ({ ...c, [id]: next(Array.isArray(c[id]) ? (c[id] as string[]) : DEFAULTS[id]) }));
      toast(message, "good");
      return true;
    } catch (e) {
      toast(`Settings were not saved: ${describe(e)}`, "bad");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    if (items.some(x => x.toLowerCase() === v.toLowerCase())) return toast(`${v} already exists in this catalog.`, "bad");
    if (await change(list => [...list, v], `${v} added to the ${id} catalog.`)) setValue("");
  }
  async function remove(item: string) {
    if (id === "receiverRelations" && items.length <= 1) return;
    await change(list => list.filter(x => x !== item), `${item} removed.`).catch(toastError);
  }

  return (
    <>
      <PageHeading eyebrow="Operational settings" title={part.title} subtitle={part.subtitle} />
      <Panel title={part.title} subtitle={part.subtitle}>
        <div className="panel-body">
          {config.isLoading ? (
            <Loading rows={2} />
          ) : (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {items.map(x => (
                <span key={x} className="chip" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", border: "1px solid var(--line)", borderRadius: 999, background: "var(--surface-2)", fontSize: 13 }}>
                  {x}
                  {x !== "Self" ? (
                    <button type="button" className="button ghost sm" aria-label={`Remove ${x}`} disabled={busy} onClick={() => void remove(x)} style={{ padding: "0 6px", minHeight: 0, lineHeight: 1.4 }}>
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          )}
          <form className="row" style={{ gap: 8, marginTop: 14, alignItems: "flex-end" }} onSubmit={e => void add(e)}>
            <label className="field" style={{ minWidth: 260 }}>
              <span>Add {part.label}</span>
              <input className="input" required value={value} onChange={e => setValue(e.target.value)} placeholder={`New ${part.label}`} />
            </label>
            <Button type="submit" size="sm" disabled={busy}>
              Add {part.label}
            </Button>
          </form>
        </div>
      </Panel>
    </>
  );
}
