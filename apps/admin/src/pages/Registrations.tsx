/**
 * Merchant registrations (01.js registrationPage + bridge.js + bridge-merchants.js + bridge-registration-tabs.js):
 * open applications (pending review and more information requested), rejected ones, and the ones approved in this
 * session; tabs To review · Rejected · Approved · All with counts, search, Export queue, KYC reviews and Invitations.
 * Review opens the application (approve with a package, reject with a reason, request more information).
 * The Approval center opens this page too.
 */
import { useMemo, useState } from "react";
import { saveCsv } from "@panel/lib/csv";
import { Button, Metric, PageHeading, Panel, Pill, Tabs } from "@panel/ui/kit";
import { Icon } from "@panel/ui/Icon";
import { num, phoneText, packageLabel, when, useMerchants, useOverview, type Merchant } from "@/lib/admin";
import { openInvites, openKycQueue, reviewRegistration } from "@/features/merchants";

type Tab = "review" | "rejected" | "approved" | "all";
const TAB_KEY = "df-registration-tab";

/** Applications approved while this tab is open stay listed as "Approved" (as in the classic panel). */
const decided = new Map<string, string>();

function statusOf(m: Merchant) {
  if (m.status === "PENDING_REVIEW") return "Pending review";
  if (m.status === "INFO_REQUESTED") return "More information requested";
  if (m.status === "REJECTED") return "Rejected";
  return decided.get(m.id) ?? null;
}

export default function Registrations() {
  const merchants = useMerchants();
  const overview = useOverview();
  const [tab, setTabState] = useState<Tab>(() => {
    try {
      return (sessionStorage.getItem(TAB_KEY) as Tab) || "review";
    } catch {
      return "review";
    }
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage blocked */
    }
  };
  const [search, setSearch] = useState("");
  // Remember what was open when the page loaded: an approved one then shows as "Approved".
  const rows = useMemo(() => {
    const list = merchants.data ?? [];
    for (const m of list) if ((m.status === "PENDING_REVIEW" || m.status === "INFO_REQUESTED") && !decided.has(m.id)) decided.set(m.id, "");
    for (const [id, s] of decided) {
      const m = list.find(x => x.id === id);
      if (m && s === "" && m.status === "ACTIVE") decided.set(id, "Approved");
    }
    return list.flatMap(m => {
      const status = statusOf(m);
      return status ? [{ m: m as Merchant, status }] : [];
    });
  }, [merchants.data]);
  const MATCH: Record<Tab, (s: string) => boolean> = {
    review: s => s === "Pending review" || s === "More information requested",
    rejected: s => s === "Rejected",
    approved: s => s === "Approved",
    all: () => true,
  };
  const q = search.trim().toLowerCase();
  const shown = rows.filter(r => MATCH[tab](r.status) && (!q || [r.m.name, r.m.code, r.m.contactName, r.m.contactEmail, r.m.contactPhone, r.m.pickupDistrict].some(v => String(v ?? "").toLowerCase().includes(q))));
  const waiting = rows.filter(r => r.status === "Pending review").length;
  const info = rows.filter(r => r.status === "More information requested").length;
  const label = { review: "To review", rejected: "Rejected", approved: "Approved", all: "All" }[tab];
  const typeOf = (m: Merchant) => (m.type === "BANKING_FINANCIAL" ? "Banking & Financial merchant" : "E-commerce");
  const cityOf = (m: Merchant) => (m.pickup?.zone ? `${m.pickup.zone}, ${m.pickupDistrict}` : m.pickupDistrict || "—");

  return (
    <>
      <PageHeading
        eyebrow="Merchant onboarding"
        title="Merchant registrations"
        subtitle="Review business details and grant approved merchants access to the platform."
        actions={
          <>
            <Button onClick={() => void openKycQueue()}>KYC reviews</Button>
            <Button onClick={() => void openInvites()}>Invitations</Button>
            <Button
              icon="download"
              onClick={() =>
                saveCsv("registrations.csv", [
                  ["Application", "Business", "Owner", "Email", "Phone", "Type", "City", "Submitted", "Status"],
                  ...rows.map(({ m, status }) => [m.code, m.name, m.contactName, m.contactEmail || "—", phoneText(m.contactPhone), typeOf(m), cityOf(m), when(m.createdAt), status]),
                ])
              }
            >
              Export queue
            </Button>
          </>
        }
      />
      <div className="metrics">
        <Metric label="Awaiting review" icon="sheet" value={merchants.data ? num(waiting) : "—"} foot="needs decision" note="merchant applications" />
        <Metric label="Approved this month" icon="check" value={overview.data ? num(overview.data.merchants.approvedThisMonth) : "—"} foot="approved" note="this month" />
        <Metric label="Additional checks" icon="alert" value={merchants.data ? num(info) : "—"} foot="more information requested" note="waiting for the applicant" />
        <Metric label="Rejected" icon="x" value={merchants.data ? num(rows.filter(r => r.status === "Rejected").length) : "—"} foot="not approved" note="can apply again" />
      </div>
      <div className="callout warn">
        <Icon name="alert" />
        <span>Merchant approval grants workspace access. Review business registration, authorized owner details, service scope, and settlement requirements before approving.</span>
      </div>
      <Panel
        title="Registration review queue"
        subtitle={tab === "all" ? "Every merchant application" : tab === "review" ? "Applications waiting for a decision" : `${label} applications`}
        tools={<input className="input sm" type="search" placeholder="Search applications..." aria-label="Search applications" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220 }} />}
        footer={<span>Showing {shown.length} application records</span>}
      >
        <div style={{ padding: "12px 16px 10px" }}>
          <Tabs
            label="Applications"
            value={tab}
            onChange={setTab}
            tabs={(["review", "rejected", "approved", "all"] as Tab[]).map(id => ({ id, label: { review: "To review", rejected: "Rejected", approved: "Approved", all: "All" }[id], count: rows.filter(r => MATCH[id](r.status)).length }))}
          />
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Business owner</th>
                <th>Service</th>
                <th>Location</th>
                <th>Submitted</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ m, status }) => (
                <tr key={m.id}>
                  <td>
                    <span className="strong">{m.name}</span>
                    <span className="sub">
                      {m.code} · {m.contactEmail || "—"}
                    </span>
                  </td>
                  <td>
                    {m.contactName}
                    <span className="sub">{phoneText(m.contactPhone)}</span>
                  </td>
                  <td>
                    {typeOf(m)}
                    <span className="sub">{packageLabel(m)}</span>
                  </td>
                  <td>{cityOf(m)}</td>
                  <td className="nowrap">{when(m.createdAt)}</td>
                  <td>
                    <Pill tone={status === "Approved" ? "good" : status === "Rejected" ? "bad" : "warn"}>{status}</Pill>
                  </td>
                  <td>
                    {status === "Pending review" || status === "More information requested" ? (
                      <Button size="sm" variant="primary" onClick={() => void reviewRegistration(m)}>
                        Review
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => void reviewRegistration(m)}>
                        Details
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {!shown.length ? (
                <tr>
                  <td colSpan={7} className="faint" style={{ textAlign: "center" }}>
                    {merchants.isLoading ? "Loading…" : `No ${tab === "all" ? "" : `${label.toLowerCase()} `}applications.`}
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
