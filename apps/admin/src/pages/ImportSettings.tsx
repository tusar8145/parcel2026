/**
 * Import Template settings (01.js + bridge-imports.js, GET / PUT /imports/config): for the three bulk-create
 * templates (Customer parcel, E-commerce, Banking & Financial = API kind "document"), which columns are required and
 * the value used when a cell is empty; where orders without a destination are priced to; the file limits. The
 * template buttons download each one (GET /imports/templates/:kind) with the category's default package.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe, download } from "@panel/lib/api";
import { Icon } from "@panel/ui/Icon";
import { Button, Loading, PageHeading, Panel } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { toast, toastError } from "@panel/ui/toast";
import { useCatalog } from "@/lib/admin";

type Kind = "customer" | "ecommerce" | "document";
const KINDS: Record<Kind, string> = { customer: "Customer parcel template", ecommerce: "E-commerce template", document: "Banking & Financial template" };
const TAB_SLUG: Record<string, Kind> = { customer: "customer", "e-commerce": "ecommerce", ecommerce: "ecommerce", banking: "document", document: "document" };
const PACKAGE_ONLY: Record<string, string> = { cod: "Only when the package offers cash on delivery", openBox: "Only when the package offers open box" };
const LIMITS: [string, string, string][] = [
  ["merchantMaxRows", "Rows per file · merchants", "rows"],
  ["opsMaxRows", "Rows per file · operations", "rows"],
  ["maxFileMb", "File size", "MB"],
  ["perMerchantConcurrent", "Running imports per merchant", "at a time"],
  ["globalConcurrent", "Imports booking at once (platform)", "at a time"],
];
interface Column {
  key: string;
  header: string;
  description: string;
  required: boolean;
  configurable: boolean;
  defaultable: boolean;
  default?: string | null;
  builtInDefault?: string | null;
  packageOnly?: string | null;
}
interface ImportConfig {
  templates: Record<Kind, Column[]>;
  defaultDestination: { mode: "MERCHANT_CITY" | "FIXED"; district?: string; zone?: string };
  limits: Record<string, number>;
  ceilings: Record<string, number> & { maxRows: number };
}

export default function ImportSettings({ tab: initial }: { tab?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "imports-config"], queryFn: () => api<ImportConfig>("/imports/config") });
  const catalog = useCatalog();
  const [tab, setTab] = useState<Kind>(TAB_SLUG[initial ?? ""] ?? "ecommerce");
  const [required, setRequired] = useState<Record<string, boolean>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [dest, setDest] = useState<ImportConfig["defaultDestination"]>({ mode: "MERCHANT_CITY" });
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const c = q.data;
  const reset = (cfg: ImportConfig, kind: Kind) => {
    setRequired(Object.fromEntries(cfg.templates[kind].map(x => [x.key, x.required])));
    setDefaults(Object.fromEntries(cfg.templates[kind].map(x => [x.key, x.default ?? ""])));
    setDest(cfg.defaultDestination);
    setLimits(Object.fromEntries(Object.entries(cfg.limits).map(([k, v]) => [k, String(v)])));
  };
  useEffect(() => {
    if (c) reset(c, tab);
  }, [c, tab]);

  async function save() {
    if (!c) return;
    const columns: Record<string, { required?: boolean; default?: string | null }> = {};
    for (const col of c.templates[tab]) {
      const change: { required?: boolean; default?: string | null } = {};
      if (col.configurable && required[col.key] !== col.required) change.required = required[col.key];
      if (col.defaultable && (defaults[col.key] ?? "").trim() !== (col.default ?? "")) change.default = (defaults[col.key] ?? "").trim() || null;
      if (Object.keys(change).length) columns[col.key] = change;
    }
    const body = {
      templates: { [tab]: columns },
      defaultDestination: dest.mode === "FIXED" ? { mode: dest.mode, district: dest.district ?? "", zone: dest.zone ?? "" } : { mode: dest.mode },
      limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, Number(v)])),
    };
    setBusy(true);
    try {
      const saved = await api<ImportConfig>("/imports/config", { method: "PUT", body });
      qc.setQueryData(["admin", "imports-config"], saved);
      toast("Import settings saved. Templates and validation use them from now on.", "good");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }
  const zones = dest.mode === "FIXED" ? catalog.data?.zonesByDistrict?.[dest.district ?? ""] ?? [] : [];

  return (
    <>
      <PageHeading eyebrow="Platform control · Excel and CSV" title="Import Template settings" subtitle="Required columns, defaults, default destination and limits for the merchant and operations imports." />
      <div className="callout">
        <Icon name="box" size={18} />
        <span>
          Services and prices:{" "}
          <Button size="sm" onClick={() => navigate("/service-plans")} style={{ marginLeft: 6 }}>
            Service plans
          </Button>
        </span>
      </div>
      {!c ? (
        q.error ? <div className="callout bad">{describe(q.error)}</div> : <Loading rows={8} />
      ) : (
        <Panel
          title="Spreadsheet imports"
          subtitle="Required columns and defaults of the three bulk-create templates (merchant and operations Excel imports). Rows that have every required column and only valid values are created; missing delivery details make them “Needs info”. The template buttons download each one with the category's default package."
          tools={
            <>
              {(Object.keys(KINDS) as Kind[]).map(k => (
                <Button key={k} size="sm" icon="download" onClick={() => void download(`/imports/templates/${k}`, `${k}-template.xlsx`).catch(toastError)}>
                  {KINDS[k]}
                </Button>
              ))}
            </>
          }
        >
          <div style={{ padding: "12px 16px" }}>
            <div className="seg-tabs" role="tablist">
              {(Object.keys(KINDS) as Kind[]).map(k => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                  {KINDS[k]}
                </button>
              ))}
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Required</th>
                  <th>Default when empty</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {c.templates[tab].map(col => (
                  <tr key={col.key}>
                    <td>
                      <strong>{col.header}</strong>
                      {col.packageOnly ? <span className="sub">{PACKAGE_ONLY[col.packageOnly] || ""}</span> : null}
                    </td>
                    <td>
                      {col.configurable ? (
                        <label className="check">
                          <input type="checkbox" aria-label={`${col.header} required`} checked={!!required[col.key]} onChange={e => setRequired({ ...required, [col.key]: e.target.checked })} /> Required
                        </label>
                      ) : (
                        <span className="faint">{col.required ? "Always required" : "Always optional"}</span>
                      )}
                    </td>
                    <td style={{ minWidth: 180 }}>
                      {col.defaultable ? (
                        <input className="input sm" value={defaults[col.key] ?? ""} placeholder={col.builtInDefault ? `Built-in: ${col.builtInDefault}` : "No default"} onChange={e => setDefaults({ ...defaults, [col.key]: e.target.value })} />
                      ) : (
                        <span className="faint">{col.key === "district" || col.key === "zone" ? "Default destination below" : "—"}</span>
                      )}
                    </td>
                    <td className="faint" style={{ fontSize: 12, lineHeight: 1.45 }}>
                      {col.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-body form-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <label className="field">
              <span>Orders without a destination are priced to</span>
              <Select className="select" value={dest.mode} onChange={e => setDest({ ...dest, mode: e.target.value as "FIXED" })}>
                <option value="MERCHANT_CITY">The merchant's own city (pickup zone)</option>
                <option value="FIXED">A fixed zone</option>
              </Select>
            </label>
            <label className="field">
              <span>District</span>
              <Select className="select" disabled={dest.mode !== "FIXED"} value={dest.district ?? ""} onChange={e => setDest({ ...dest, district: e.target.value, zone: "" })}>
                <option value="">Choose</option>
                {(catalog.data?.districts ?? []).map(d => (
                  <option key={d}>{d}</option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span>Zone</span>
              <Select className="select" disabled={dest.mode !== "FIXED"} value={dest.zone ?? ""} onChange={e => setDest({ ...dest, zone: e.target.value })}>
                <option value="">Choose</option>
                {zones.map(z => (
                  <option key={z}>{z}</option>
                ))}
              </Select>
            </label>
          </div>
          <div className="panel-body form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", paddingTop: 0 }}>
            {LIMITS.map(([key, label, unit]) => {
              const max = key.endsWith("Rows") ? c.ceilings.maxRows : c.ceilings[key];
              return (
                <label key={key} className="field">
                  <span>{label}</span>
                  <input className="input" type="number" min={key === "maxFileMb" ? 0.1 : 1} step={key === "maxFileMb" ? 0.1 : 1} max={max} value={limits[key] ?? ""} onChange={e => setLimits({ ...limits, [key]: e.target.value })} />
                  <small>{`${unit} · at most ${Number(max).toLocaleString("en-US")}`}</small>
                </label>
              );
            })}
          </div>
          <div className="panel-body" style={{ paddingTop: 0, display: "flex", justifyContent: "flex-end" }}>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              Save import settings
            </Button>
          </div>
        </Panel>
      )}
    </>
  );
}
