/**
 * E-commerce merchants / Banking & Financial merchants (02.js merchantSegmentPage + bridge.js + bridge-merchants.js +
 * bridge-status-tabs.js): the segment's accounts (not open or rejected applications) with tabs Active · Suspended ·
 * All, search, the serving hub column and hub filter, Export, Invite merchant, KYC reviews and Invitations.
 * Manage opens the account (status, package, addresses, KYC, notes).
 */
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { saveCsv } from "@panel/lib/csv";
import { Button, Metric, PageHeading, Panel, Pill, Tabs } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { contactOf, dateOf, num, packageLabel, SERVICES, STATUS_LABEL, TYPE_LABEL, useMerchants, useOverview, type Merchant, type MerchantType } from "@/lib/admin";
import { inviteMerchant, manageMerchant, openInvites, openKycQueue } from "@/features/merchants";

type Tab = "active" | "suspended" | "all";
const TAB_KEY = "df-status-tabs";
const OPEN = ["PENDING_REVIEW", "INFO_REQUESTED", "REJECTED"];

export const EcommerceMerchants = () => <Merchants type="ECOMMERCE" />;
export const BankingMerchants = () => <Merchants type="BANKING_FINANCIAL" />;
export default EcommerceMerchants;

function Merchants({ type }: { type: MerchantType }) {
  const docs = type === "BANKING_FINANCIAL";
  const title = docs ? "Banking & Financial merchants" : "E-commerce merchants";
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const merchants = useMerchants();
  const overview = useOverview();
  const [tab, setTabState] = useState<Tab>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(TAB_KEY) || "{}")[title] || "active";
    } catch {
      return "active";
    }
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      sessionStorage.setItem(TAB_KEY, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(TAB_KEY) || "{}"), [title]: t }));
    } catch {
      /* storage blocked */
    }
  };
  const search = params.get("q") ?? "";
  const setSearch = (v: string) =>
    setParams(
      p => {
        if (v) p.set("q", v);
        else p.delete("q");
        return p;
      },
      { replace: true },
    );
  const [hub, setHub] = useState("");
  const rows = (merchants.data ?? []).filter(m => m.type === type && !OPEN.includes(m.status));
  const hubs = new Map<string, string>();
  for (const m of rows) if (m.pickupHub) hubs.set(m.pickupHub.id, m.pickupHub.name);
  const q = search.trim().toLowerCase();
  const inTab = (m: Merchant, t: Tab) => (t === "active" ? m.status === "ACTIVE" : t === "suspended" ? m.status !== "ACTIVE" : true);
  const filtered = rows.filter(m => (!q || [m.name, m.code, m.contactName, m.contactEmail, m.contactPhone].some(v => String(v ?? "").toLowerCase().includes(q))) && (!hub || (hub === "none" ? !m.pickupHub : m.pickupHub?.id === hub)));
  const shown = filtered.filter(m => inTab(m, tab));
  const activity = (id: string) => overview.data?.merchantActivity.find(a => a.merchantId === id);
  const noun = docs ? "Banking & Financial" : "e-commerce";
  const openPackage = (m: Merchant) => navigate(`/service-plans?tab=${m.type === "BANKING_FINANCIAL" ? "banking" : "e-commerce"}&merchant=${encodeURIComponent(m.code)}`);

  return (
    <>
      <PageHeading
        eyebrow={`Merchant accounts · ${docs ? "Secure documents" : "Online stores"}`}
        title={title}
        subtitle={`Manage ${docs ? "banks, fintechs, and other Banking & Financial merchants" : "online sellers, parcel volumes, and COD-enabled delivery accounts"} in a dedicated directory.`}
        actions={
          <>
            <Button onClick={() => void openKycQueue()}>KYC reviews</Button>
            <Button onClick={() => void openInvites()}>Invitations</Button>
            <Button
              icon="download"
              onClick={() =>
                saveCsv(`${docs ? "document" : "ecommerce"}-merchants.csv`, [
                  ["ID", "Name", "Owner", "Email", "Plan", "Services", "Joined", "Shipments", "Status"],
                  ...rows.map(m => [m.code, m.name, m.contactName, contactOf(m), packageLabel(m), SERVICES[m.type], dateOf(m.createdAt), num(activity(m.id)?.parcelsThisMonth), STATUS_LABEL[m.status]]),
                ])
              }
            >
              Export {docs ? "documents" : "e-commerce"}
            </Button>
            <Button variant="primary" icon="plus" onClick={() => void inviteMerchant(type)}>
              Invite merchant
            </Button>
          </>
        }
      />
      <div className="metrics">
        <Metric label="Total accounts" icon="box" value={merchants.data ? num(rows.length) : "—"} foot={docs ? "Banking & Financial merchant clients" : "online sellers"} note={`${docs ? "document" : "e-commerce"} merchants`} />
        <Metric label="Active" icon="check" value={merchants.data ? num(rows.filter(m => m.status === "ACTIVE").length) : "—"} foot="enabled to ship" note="active accounts" />
        <Metric label="Under review" icon="alert" value={merchants.data ? num(rows.filter(m => m.status === "PENDING_REVIEW").length) : "—"} foot="follow-up required" note="review queue" />
        <Metric label="Suspended" icon="lock" value={merchants.data ? num(rows.filter(m => m.status === "SUSPENDED").length) : "—"} foot="access disabled" note="account control" />
      </div>
      <Panel
        title={docs ? "Banking & Financial merchant accounts" : "E-commerce merchant directory"}
        subtitle={docs ? "Branch-based clients, secure-document services, and billing plans." : "Store accounts, COD and returns services, and delivery plans."}
        tools={
          <>
            <input className="input sm" type="search" placeholder={`Search ${docs ? "merchant or owner" : "store or owner"}...`} aria-label={`Search ${title}`} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220 }} />
            <Select className="select sm" aria-label="Filter by hub" value={hub} onChange={e => setHub(e.target.value)} style={{ width: 150 }}>
              <option value="">All hubs</option>
              {[...hubs].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              <option value="none">No hub</option>
            </Select>
          </>
        }
        footer={<span>Showing {shown.length} {noun} accounts</span>}
      >
        <div style={{ padding: "12px 16px 10px" }}>
          <Tabs
            label="Accounts"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "active", label: "Active", count: filtered.filter(m => inTab(m, "active")).length },
              { id: "suspended", label: "Suspended", count: filtered.filter(m => inTab(m, "suspended")).length },
              { id: "all", label: "All", count: filtered.length },
            ]}
          />
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{docs ? "Merchant" : "Store / merchant"}</th>
                <th>Primary contact</th>
                <th>Hub</th>
                <th>Package</th>
                <th className="num">Shipments MTD</th>
                <th>Joined</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(m => (
                <tr key={m.id}>
                  <td>
                    <span className="strong">{m.name}</span>
                    <span className="sub">
                      {m.code} · {TYPE_LABEL[m.type]} · {SERVICES[m.type]}
                    </span>
                  </td>
                  <td>
                    {m.contactName}
                    <span className="sub">{contactOf(m)}</span>
                  </td>
                  <td>
                    {m.pickupHub ? m.pickupHub.name : <span className="faint">No hub</span>}
                    {m.pickupZone ? <span className="sub">{`${m.pickupZone}, ${m.pickupDistrict}`}</span> : null}
                  </td>
                  <td>{packageLabel(m)}</td>
                  <td className="num">{num(activity(m.id)?.parcelsThisMonth)}</td>
                  <td className="nowrap">{dateOf(m.createdAt)}</td>
                  <td>
                    <Pill>{STATUS_LABEL[m.status]}</Pill>
                  </td>
                  <td>
                    <Button size="sm" onClick={() => void manageMerchant(m, openPackage)}>
                      Manage
                    </Button>
                  </td>
                </tr>
              ))}
              {!shown.length ? (
                <tr>
                  <td colSpan={8} className="faint" style={{ textAlign: "center" }}>
                    {merchants.isLoading ? "Loading…" : rows.length ? "No accounts match." : `No ${docs ? "document" : "e-commerce"} merchant accounts yet.`}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
