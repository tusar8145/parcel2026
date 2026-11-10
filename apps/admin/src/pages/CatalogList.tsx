/**
 * Return reasons, Receiver relations and Fail delivery reasons: a list to add to, rename, remove and put in order
 * (move up / down); everywhere shows them in this order. Saved in the platform settings (`returnReasons`,
 * `receiverRelations`, `failReasons`); returns forms, riders' apps, the Operations app, the scan desk and Collect from
 * hub use them. Self always stays first among receiver relations, Other last among fail delivery reasons.
 */
import { useState, type FormEvent } from "react";
import { describe } from "@panel/lib/api";
import { confirm } from "@panel/ui/dialogs";
import { Button, Loading, PageHeading, Panel } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { savePlatformConfig, usePlatformConfig } from "@/lib/admin";

const DEFAULTS = {
  returnReasons: ["Recipient refused", "Recipient unreachable", "Wrong or incomplete address", "Recipient asked to cancel", "Damaged in transit", "Merchant cancelled the order", "Delivery attempts exhausted"],
  receiverRelations: ["Self", "Father", "Mother", "Spouse", "Son", "Daughter", "Brother", "Sister", "Relative", "Neighbour", "Colleague", "Security guard", "Reception", "Other"],
  failReasons: ["Recipient unavailable", "Incorrect address", "Recipient refused", "Unable to contact recipient", "Access / safety issue", "Other"],
};
const PARTS = {
  returnReasons: { title: "Return reasons", one: "Return reason", label: "return reason", subtitle: "The reasons offered on return forms and the scan desk." },
  receiverRelations: { title: "Receiver relations", one: "Receiver relation", label: "receiver relation", subtitle: "Who received a delivery, as chosen by riders, the hub desk and Collect from hub. Self is always first." },
  failReasons: { title: "Fail delivery reasons", one: "Fail delivery reason", label: "fail delivery reason", subtitle: "Why a delivery attempt failed, as chosen in the rider and Operations apps and on the scan desk. Other is always last." },
};
type Key = keyof typeof PARTS;

export const ReturnReasons = () => <CatalogList id="returnReasons" />;
export const ReceiverRelations = () => <CatalogList id="receiverRelations" />;
export const FailReasons = () => <CatalogList id="failReasons" />;
export default ReturnReasons;

/** An item that keeps its place: Self (first receiver relation), Other (last fail delivery reason). */
const fixedOf = (id: Key, item: string | undefined) => (id === "receiverRelations" && item === "Self") || (id === "failReasons" && item === "Other");

function CatalogList({ id }: { id: Key }) {
  const part = PARTS[id];
  const config = usePlatformConfig();
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState<{ item: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = config.data?.[id];
  const items: string[] = Array.isArray(saved) && saved.length ? (saved as string[]) : DEFAULTS[id];
  const max = id === "returnReasons" ? 300 : 80;

  async function change(next: (list: string[]) => string[], message: string) {
    setBusy(true);
    try {
      await savePlatformConfig(c => ({ ...c, [id]: next(Array.isArray(c[id]) && (c[id] as string[]).length ? (c[id] as string[]) : DEFAULTS[id]) }));
      toast(message, "good");
      return true;
    } catch (e) {
      toast(`Not saved: ${describe(e)}`, "bad");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const taken = (v: string, except?: string) => items.some(x => x !== except && x.toLowerCase() === v.toLowerCase());
  async function add(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    if (taken(v)) return toast(`${v} is already in the list.`, "bad");
    // Before "Other" (it stays last).
    const insert = (list: string[]) => (id === "failReasons" && list.includes("Other") ? [...list.filter(x => x !== "Other"), v, "Other"] : [...list, v]);
    if (await change(insert, `${v} added.`)) setValue("");
  }
  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const v = editing.text.trim();
    if (!v || v === editing.item) return setEditing(null);
    if (taken(v, editing.item)) return toast(`${v} is already in the list.`, "bad");
    const from = editing.item;
    if (await change(list => list.map(x => (x === from ? v : x)), `${from} renamed to ${v}.`)) setEditing(null);
  }
  async function remove(item: string) {
    if (items.length <= 1) return;
    if (!(await confirm({ title: `Remove ${item}?`, message: "It is no longer offered. Parcels that already have it keep it.", ok: "Remove", danger: true }))) return;
    await change(list => list.filter(x => x !== item), `${item} removed.`).catch(toastError);
  }
  async function move(item: string, by: -1 | 1) {
    await change(list => {
      const next = [...list];
      const i = next.indexOf(item);
      const j = i + by;
      if (i < 0 || j < 0 || j >= next.length || fixedOf(id, next[j])) return list;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    }, `${item} moved ${by < 0 ? "up" : "down"}.`).catch(toastError);
  }

  return (
    <>
      <PageHeading eyebrow="Operational settings" title={part.title} subtitle={part.subtitle} />
      <Panel title={part.title} subtitle="Shown everywhere in this order: use ↑ ↓ to change it.">
        <div className="panel-body">
          {config.isLoading ? (
            <Loading rows={4} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>#</th>
                    <th>{part.one}</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((x, i) => {
                    const fixed = fixedOf(id, x);
                    const upBlocked = i === 0 || fixed || fixedOf(id, items[i - 1]);
                    const downBlocked = i === items.length - 1 || fixed || fixedOf(id, items[i + 1]);
                    return (
                      <tr key={x}>
                        <td className="faint">{i + 1}</td>
                        <td>
                          {editing?.item === x ? (
                            <form className="row" style={{ gap: 6 }} onSubmit={e => void rename(e)}>
                              <input className="input" aria-label={`New name for ${x}`} autoFocus required maxLength={max} value={editing.text} onChange={e => setEditing({ item: x, text: e.target.value })} />
                              <Button type="submit" size="sm" variant="primary" disabled={busy}>
                                Save
                              </Button>
                              <Button size="sm" onClick={() => setEditing(null)}>
                                Cancel
                              </Button>
                            </form>
                          ) : (
                            <>
                              {x}
                              {fixed ? <span className="faint">{id === "receiverRelations" ? " · always first" : " · always last"}</span> : null}
                            </>
                          )}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                            <Button size="sm" aria-label={`Move ${x} up`} disabled={busy || upBlocked} onClick={() => void move(x, -1)}>
                              ↑
                            </Button>
                            <Button size="sm" aria-label={`Move ${x} down`} disabled={busy || downBlocked} onClick={() => void move(x, 1)}>
                              ↓
                            </Button>
                            {!fixed ? (
                              <>
                                <Button size="sm" disabled={busy} onClick={() => setEditing({ item: x, text: x })}>
                                  Edit
                                </Button>
                                <Button size="sm" variant="danger" disabled={busy || items.length <= 1} onClick={() => void remove(x)}>
                                  Remove
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <form className="row" style={{ gap: 8, marginTop: 14, alignItems: "flex-end" }} onSubmit={e => void add(e)}>
            <label className="field" style={{ minWidth: 260 }}>
              <span>Add {part.label}</span>
              <input className="input" required maxLength={max} value={value} onChange={e => setValue(e.target.value)} placeholder={`New ${part.label}`} />
            </label>
            <Button type="submit" size="sm" disabled={busy}>
              Add
            </Button>
          </form>
        </div>
      </Panel>
    </>
  );
}
