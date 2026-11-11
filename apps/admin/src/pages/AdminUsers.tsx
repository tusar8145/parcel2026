/**
 * Admin users & roles (01.js + bridge.js + bridge-security.js + bridge-admin-tabs.js), in tabs:
 *   Administrators       the staff directory (search, Manage: suspend / reactivate, Reset 2FA), role cards, your own
 *                        two-step verification; Invite administrator (POST /users).
 *   Approvals            changes waiting for a second super admin (approve / reject / withdraw) and the switch for
 *                        second super admin approval (PUT /admin/changes/settings).
 *   Roles & permissions  the permission matrix (built-in roles with overrides, custom roles) and custom roles.
 *   Support access       open a merchant's / rider's / customer's view in a new tab; recent sessions.
 */
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { queryClient } from "@panel/lib/queryClient";
import { useAuth } from "@panel/lib/auth";
import { useLive } from "@panel/lib/events";
import { localPhone } from "@panel/lib/format";
import { confirm, openCustom, openForm, prompt, type FormValues } from "@panel/ui/dialogs";
import { generatePassword, InvitePreview, passwordProblem } from "@panel/ui/AccountFields";
import { Icon } from "@panel/ui/Icon";
import { Button, Loading, PageHeading, Panel, Pill, useDebounced } from "@panel/ui/kit";
import { manageMfa } from "@panel/ui/Mfa";
import { Select } from "@panel/ui/Select";
import { toast, toastError } from "@panel/ui/toast";
import { DialogFrame, Facts, groupHubs, phoneText, ROLE_LABEL, ROLE_SCOPE, STAFF_ROLES, when, useStaff, type Staff } from "@/lib/admin";
import { startSupportAccess } from "@/lib/support";

type Tab = "admins" | "approvals" | "roles" | "support";
const TAB_KEY = "df-admin-tab";
const ROLE_NAME: Record<string, string> = {
  CUSTOMER: "Customer",
  MERCHANT_OWNER: "Merchant owner",
  MERCHANT_STAFF: "Merchant staff",
  RIDER: "Rider",
  HUB_OPERATOR: "Hub manager",
  OPS_MANAGER: "Operations admin",
  FINANCE: "Finance admin",
  SUPPORT_AGENT: "Merchant support",
  SUPER_ADMIN: "Super admin",
  FRANCHISE: "Franchise",
  APPLICANT: "Applicant (waiting for approval)",
};
const INVITE_ROLE: Record<string, string> = {
  "Operations Administrator": "OPS_MANAGER",
  "Finance Administrator": "FINANCE",
  "Merchant Support": "SUPPORT_AGENT",
  "Hub Manager": "HUB_OPERATOR",
};
const pendingNote = (result?: { status?: string } | null) =>
  result?.status === "PENDING" ? "Sent for approval: another super admin has to approve it before it takes effect." : "Saved: no other super admin can approve, so it took effect at once.";

interface Change {
  id: string;
  summary: string;
  kind: string;
  status: string;
  createdAt: string;
  requestedBy: { id: string; name: string };
  reviewedBy?: { name: string } | null;
  reviewNote?: string | null;
  error?: string | null;
  canApprove?: boolean;
  canCancel?: boolean;
}
interface Roles {
  permissions: { key: string; label: string; group: string; superAdminOnly?: boolean }[];
  builtInRoles: { role: string; permissions: string[]; locked: string[]; users: number; granted: string[]; revoked: string[] }[];
  customRoles: { id: string; name: string; description?: string | null; baseRole: string; permissions: string[]; users: number; active: boolean }[];
  customRoleBases: string[];
}
interface SupportSession {
  id: string;
  target: { name: string };
  reason: string;
  admin: { name: string; role?: string | null };
  readOnly: boolean;
  createdAt: string;
  active: boolean;
  expiresAt: string;
  endedAt?: string | null;
}
const dhaka = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Dhaka", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

function useChanges() {
  return useQuery({
    queryKey: ["admin", "changes"],
    queryFn: async () => {
      const [approval, pending, recent] = await Promise.all([
        api<{ enabled: boolean; superAdmins?: number }>("/admin/changes/settings").catch(() => null),
        api<{ items: Change[] }>("/admin/changes?status=PENDING&limit=50"),
        api<{ items: Change[] }>("/admin/changes?limit=10"),
      ]);
      return { approval, pending: pending.items, recent: recent.items.filter(c => c.status !== "PENDING") };
    },
  });
}

export default function AdminUsers() {
  const qc = useQueryClient();
  const changes = useChanges();
  useLive(["change.updated"], () => void qc.invalidateQueries({ queryKey: ["admin", "changes"] }));
  const [tab, setTabState] = useState<Tab>(() => {
    try {
      return (sessionStorage.getItem(TAB_KEY) as Tab) || "admins";
    } catch {
      return "admins";
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
  const pending = changes.data?.pending.length ?? 0;
  const TABS: [Tab, string][] = [
    ["admins", "Administrators"],
    ["approvals", "Approvals"],
    ["roles", "Roles & permissions"],
    ["support", "Support access"],
  ];
  return (
    <>
      <PageHeading
        eyebrow="Access governance"
        title="Admin users & roles"
        subtitle="Control privileged access using role-based permissions and scoped administration."
        actions={
          <Button variant="primary" icon="plus" onClick={() => void inviteAdmin()}>
            Invite administrator
          </Button>
        }
      />
      <div className="seg-tabs" role="tablist" aria-label="Admin users & roles" style={{ marginBottom: 14 }}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
            {id === "approvals" && pending ? <span style={{ display: "inline-block", minWidth: 18, height: 18, marginLeft: 6, padding: "0 5px", borderRadius: 999, background: "#f04438", color: "#fff", fontSize: 11, lineHeight: "18px", textAlign: "center" }}>{pending}</span> : null}
          </button>
        ))}
      </div>
      {tab === "admins" ? <Administrators /> : tab === "approvals" ? <Approvals /> : tab === "roles" ? <RolesTab /> : <Support />}
    </>
  );
}

// ───────────── Administrators ─────────────
function Administrators() {
  const { user } = useAuth();
  const staff = useStaff();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const list = staff.data ?? [];
  const active = list.filter(u => u.status === "ACTIVE");
  const supers = active.filter(u => u.roles.some(r => r.role === "SUPER_ADMIN"));
  const on = (l: Staff[]) => l.filter(u => u.mfa?.enabled).length;
  const q = search.trim().toLowerCase();
  const staffRoles = (u: Staff) => u.roles.filter(r => (STAFF_ROLES as readonly string[]).includes(r.role)).sort((a, b) => STAFF_ROLES.indexOf(a.role as never) - STAFF_ROLES.indexOf(b.role as never));
  const rows = list.filter(
    u =>
      (!roleFilter || u.roles.some(r => r.role === roleFilter)) &&
      (!q || [u.name, u.email, u.phone, ...u.roles.map(r => ROLE_LABEL[r.role]), ...u.roles.map(r => r.hub?.name)].some(v => String(v ?? "").toLowerCase().includes(q))),
  );
  // Grouped by role (STAFF_ROLES order). Someone with several roles shows under the first, or under the filtered one.
  const groupOf = (u: Staff) => roleFilter || staffRoles(u)[0]?.role || "";
  const groups = [...STAFF_ROLES, ""].map(role => ({ role, users: rows.filter(u => groupOf(u) === role).sort((a, b) => a.name.localeCompare(b.name)) })).filter(g => g.users.length);
  const count = (role: string) => active.filter(u => u.roles.some(r => r.role === role)).length;
  const mine = list.find(u => u.id === user?.id)?.mfa?.enabled;
  const CARDS: [string, string, string][] = [
    ["SUPER_ADMIN", "Super Administrator", "Full platform control, approvals, security, access policies, and billing governance."],
    ["OPS_MANAGER", "Operations Administrator", "Courier network, riders, dispatch, hubs, and shipment exceptions."],
    ["FINANCE", "Finance Administrator", "COD reconciliation, merchant settlements, invoices, and plan billing."],
    ["SUPPORT_AGENT", "Merchant Support", "Merchant account support with restricted financial and security access."],
  ];
  return (
    <>
      <div className="callout">
        <Icon name="lock" size={18} />
        <span>{`Super admin actions are audited. Two-step verification is required for super admins (${on(supers)} of ${supers.length} set up) and optional for other staff (${on(active) - on(supers)} of ${active.length - supers.length}). Sensitive changes need a second super admin's approval.`}</span>
      </div>
      <Panel
        title="Platform administrator directory"
        subtitle={`${list.length} administrators · ${on(list)} with two-step verification`}
        tools={
          <>
            <Select className="select sm" aria-label="Role" value={roleFilter} onChange={e => setRoleFilter(e.target.value)}>
              <option value="">All roles</option>
              {STAFF_ROLES.map(r => (
                <option key={r} value={r}>{`${ROLE_LABEL[r]} (${list.filter(u => u.roles.some(x => x.role === r)).length})`}</option>
              ))}
            </Select>
            <input className="input sm" type="search" placeholder="Search administrator..." aria-label="Search administrators" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220 }} />
          </>
        }
      >
        {staff.isLoading ? (
          <Loading rows={5} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Administrator</th>
                  <th>Role</th>
                  <th>Access scope</th>
                  <th>Status</th>
                  <th>Last sign-in / activity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {!groups.length ? (
                  <tr>
                    <td colSpan={6} className="faint" style={{ textAlign: "center" }}>
                      No administrators match.
                    </td>
                  </tr>
                ) : null}
                {groups.flatMap(g => [
                  <tr key={`group-${g.role}`}>
                    <td colSpan={6} style={{ background: "var(--surface-2)", fontWeight: 700 }}>
                      {`${g.role ? ROLE_LABEL[g.role] : "Other"} · ${g.users.length} ${g.users.length === 1 ? "person" : "people"}`}
                    </td>
                  </tr>,
                  ...g.users.map(u => {
                  const roles = staffRoles(u);
                  const status = u.status === "ACTIVE" ? (u.lastLoginAt ? "Active" : "Invited") : u.status === "SUSPENDED" ? "Suspended" : "Disabled";
                  return (
                    <tr key={u.id}>
                      <td>
                        <span className="strong">{u.name}</span>
                        <span className="sub">{u.email || phoneText(u.phone)}</span>
                      </td>
                      <td>{roles.map(r => ROLE_LABEL[r.role]).join(" · ")}</td>
                      <td>{[...new Set(roles.map(r => (r.role === "HUB_OPERATOR" ? r.hub?.name || "Hub" : ROLE_SCOPE[r.role])))].join(" · ")}</td>
                      <td>
                        <Pill tone={status === "Active" ? "good" : status === "Invited" ? "warn" : "bad"}>{status}</Pill>
                        <span className="sub">{u.mfa?.enabled ? "Two-step on" : u.mfa?.required ? "Two-step: set up at next sign-in" : "Two-step off"}</span>
                      </td>
                      <td>{u.lastLoginAt ? when(u.lastLoginAt) : "Not signed in yet"}</td>
                      <td className="nowrap">
                        <Button size="sm" onClick={() => void manageStaff(u, user?.id)}>
                          Manage
                        </Button>{" "}
                        {u.mfa?.enabled && u.id !== user?.id ? (
                          <Button size="sm" title="Lost device: turn off two-step verification" onClick={() => void resetMfa(u)}>
                            Reset 2FA
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                  }),
                ])}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <div className="grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", margin: "16px 0" }}>
        {CARDS.map(([role, title, text]) => (
          <article key={role} className="panel" style={{ padding: 16, display: "grid", gap: 8 }}>
            <strong>{title}</strong>
            <p className="faint" style={{ margin: 0, fontSize: 13 }}>
              {text}
            </p>
            <span>
              <Pill tone={role === "SUPER_ADMIN" ? "bad" : undefined}>{`${role === "SUPER_ADMIN" ? "Privileged" : "Scoped"} role · ${count(role)} user${count(role) === 1 ? "" : "s"}`}</Pill>
            </span>
          </article>
        ))}
      </div>
      <Panel
        title="Your sign-in security"
        subtitle={`Two-step verification is ${mine ? "on" : "not set up yet"} for ${user?.name || "your account"}. Super admins must use it.`}
        tools={
          <Button variant="primary" onClick={() => void manageMfa()}>
            {mine ? "Manage two-step verification" : "Set up two-step verification"}
          </Button>
        }
      />
    </>
  );
}

async function resetMfa(u: Staff) {
  if (!(await confirm({ title: `Reset two-step verification for ${u.name}?`, message: `They are signed out everywhere${u.mfa?.required ? " and must set it up again at their next sign-in" : ""}.`, ok: "Reset", danger: true }))) return;
  try {
    await api(`/users/${u.id}/mfa/reset`, { method: "POST" });
    toast(`${u.name}: two-step verification reset and signed out.`, "good");
      void queryClient.invalidateQueries({ queryKey: ["admin", "staff"] });
  } catch (e) {
    toastError(e);
  }
}

const manageStaff = (u: Staff, myId?: string) => openCustom(close => <StaffDialog u={u} self={u.id === myId} close={() => close()} />);

function StaffDialog({ u, self, close }: { u: Staff; self: boolean; close: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const roles = u.roles.filter(r => (STAFF_ROLES as readonly string[]).includes(r.role));
  const status = u.status === "ACTIVE" ? (u.lastLoginAt ? "Active" : "Invited") : u.status === "SUSPENDED" ? "Suspended" : "Disabled";
  async function set(next: "ACTIVE" | "SUSPENDED") {
    if (next === "SUSPENDED" && !(await confirm({ title: `Suspend ${u.name}?`, message: "They are signed out everywhere and can't sign in until you reactivate the account.", ok: "Suspend", danger: true }))) return;
    setBusy(true);
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: { status: next } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["admin", "staff"] }), qc.invalidateQueries({ queryKey: ["admin", "audit"] })]);
      close();
      toast(next === "SUSPENDED" ? `${u.name} is suspended and signed out.` : `${u.name} can sign in again.`, "good");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogFrame
      title={
        <>
          {u.name} <Pill tone={status === "Active" ? "good" : status === "Invited" ? "warn" : "bad"}>{status}</Pill>
        </>
      }
      subtitle={roles.map(r => ROLE_LABEL[r.role]).join(" · ")}
      close={close}
      foot={
        self ? (
          <p className="faint" style={{ margin: 0 }}>
            You can't suspend your own account.
          </p>
        ) : (
          <>
            <Button onClick={close}>Close</Button>
            {u.status === "ACTIVE" ? (
              <Button variant="danger" disabled={busy} onClick={() => void set("SUSPENDED")}>
                Suspend account
              </Button>
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => void set("ACTIVE")}>
                Reactivate account
              </Button>
            )}
          </>
        )
      }
    >
      <Facts
        rows={[
          ["Mobile", phoneText(u.phone)],
          ["Email", u.email || "—"],
          ["Scope", [...new Set(roles.map(r => (r.role === "HUB_OPERATOR" ? r.hub?.name || "Hub" : ROLE_SCOPE[r.role])))].join(" · ")],
          ["Last sign-in", u.lastLoginAt ? when(u.lastLoginAt) : "Not signed in yet"],
        ]}
      />
      <p className="faint" style={{ margin: "12px 0 0" }}>
        {u.status === "ACTIVE" ? `Suspending signs ${u.name} out everywhere at once; they can't sign in until the account is reactivated.` : `This account is ${status.toLowerCase()}. Reactivating lets ${u.name} sign in again.`}
      </p>
    </DialogFrame>
  );
}

async function inviteAdmin() {
  const hubs = await queryClient.fetchQuery({ queryKey: ["admin", "hubs"], queryFn: () => api<{ id: string; name: string; active: boolean; type?: string; district?: string }[]>("/hubs?includeInactive=true"), staleTime: 60_000 }).catch(() => []);
  const isHub = (v: FormValues) => INVITE_ROLE[v.role] === "HUB_OPERATOR";
  await openForm({
    title: "Invite platform administrator",
    description: "Send an invitation (the SMS text is shown below), or set a password and finish the account now. Elevated access is audited.",
    submit: "Create account",
    wide: true,
    fields: [
      { id: "name", label: "Administrator name", required: true, full: true, placeholder: "Full name" },
      { id: "email", label: "Work email", type: "email", required: true, placeholder: "name@company.example" },
      { id: "phone", label: "Mobile number", type: "phone", required: true, placeholder: "01XXXXXXXXX" },
      { id: "role", label: "Role", type: "select", required: true, value: "Operations Administrator", options: Object.keys(INVITE_ROLE).map(v => ({ value: v, label: v })) },
      // Hub Manager: the hub they run, grouped (franchise hubs have their own account, so they are left out).
      { id: "hubId", label: "Hub", type: "select", value: "", show: isHub, options: [{ value: "", label: "Choose the hub" }, ...groupHubs(hubs.filter(h => h.active && h.type !== "FRANCHISE")).flatMap(g => g.hubs.map(h => ({ value: h.id, label: h.name, group: g.label })))] },
      {
        id: "setup",
        label: "How the account is finished",
        type: "select",
        required: true,
        full: true,
        value: "invite",
        options: [
          { value: "invite", label: "Send an invitation (SMS, and email): they sign in with a code sent to their mobile" },
          { value: "password", label: "Set a password now (no invitation is sent): share it yourself" },
        ],
      },
      { id: "password", label: "Password", maxLength: 128, show: v => v.setup === "password", placeholder: "At least 10 characters, a letter and a number", hint: "They sign in with this mobile number (or email) and this password." },
      {
        id: "passwordTools",
        label: "",
        type: "static",
        show: v => v.setup === "password",
        live: (_v, set) => (
          <button type="button" className="button sm" onClick={() => set("password", generatePassword())}>
            Generate a password
          </button>
        ),
      },
      {
        id: "smsPreview",
        label: "The invitation they get",
        type: "static",
        full: true,
        show: v => v.setup !== "password",
        live: v => <InvitePreview input={{ kind: "staff", name: v.name, staffRole: v.role, hubId: isHub(v) && v.hubId ? v.hubId : undefined }} />,
      },
    ],
    validate: {
      hubId: (v, all) => (isHub(all) && !v ? "Choose the hub this Hub Manager runs." : ""),
      password: (v, all) => (all.setup !== "password" ? "" : !v ? "Enter a password or generate one." : passwordProblem(v)),
    },
    onSubmit: async v => {
      const role = INVITE_ROLE[v.role];
      const withPassword = v.setup === "password";
      await api("/users", {
        method: "POST",
        body: {
          name: v.name.trim(),
          phone: v.phone,
          email: v.email.trim(),
          roles: [role === "HUB_OPERATOR" ? { role, hubId: v.hubId } : { role }],
          ...(withPassword ? { password: v.password, sendSms: false } : { sendSms: true }),
        },
      });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "staff"] }), queryClient.invalidateQueries({ queryKey: ["admin", "overview"] }), queryClient.invalidateQueries({ queryKey: ["admin", "audit"] }), queryClient.invalidateQueries({ queryKey: ["admin", "network"] })]);
      return withPassword
        ? `${v.name.trim()}'s account is ready. Share the password: they sign in with ${localPhone(v.phone)} and it. No invitation was sent.`
        : `Invitation sent to ${v.name.trim()}. They sign in with an SMS code sent to ${localPhone(v.phone)}.`;
    },
  });
}

// ───────────── Approvals ─────────────
const KIND_LABEL: Record<string, string> = {
  "rate_card.create": "Rate card",
  "rate_card.deactivate": "Rate card",
  "merchant_rate.set": "Merchant tariff",
  "role.permissions": "Role permissions",
  "custom_role.create": "Custom role",
  "custom_role.update": "Custom role",
  "custom_role.delete": "Custom role",
};
const STATUS_TONE: Record<string, "good" | "warn" | "bad" | undefined> = { PENDING: "warn", APPROVED: "good", REJECTED: "bad", FAILED: "bad" };

function Approvals() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const q = useChanges();
  const [busy, setBusy] = useState("");
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["admin", "changes"] }), qc.invalidateQueries({ queryKey: ["admin", "roles"] })]);
  async function act(id: string, verb: "approve" | "reject" | "cancel") {
    let body: Record<string, unknown> = {};
    if (verb === "reject") {
      const note = await prompt({ title: "Reject this change?", message: "The requester sees your reason.", label: "Why is it rejected?", multiline: true, ok: "Reject change" });
      if (!note) return;
      if (note.trim().length < 3) return toast("At least 3 characters", "bad");
      body = { note: note.trim() };
    }
    if (verb === "approve" && !(await confirm({ title: "Approve and apply this change now?", message: "It takes effect immediately and is recorded under your name.", ok: "Approve and apply" }))) return;
    setBusy(id);
    try {
      const result = await api<{ summary?: string }>(`/admin/changes/${id}/${verb}`, { method: "POST", body });
      toast(verb === "approve" ? `Approved: ${result.summary}` : verb === "reject" ? "Change rejected." : "Change withdrawn.", "good");
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  async function setApproval(enabled: boolean) {
    const ok = enabled
      ? await confirm({ title: "Turn on second super admin approval?", message: "Rate cards, tariffs, service plans, role permissions and custom roles will wait for another super admin.", ok: "Turn on" })
      : await confirm({ title: "Turn off second super admin approval?", message: "Changes by one super admin will apply at once. While approval is on, this needs another super admin to approve it.", ok: "Turn off" });
    if (!ok) return;
    setBusy("approval");
    try {
      const result = await api<{ status?: string }>("/admin/changes/settings", { method: "PUT", body: { enabled } });
      toast(result.status === "PENDING" ? "Turning it off waits for another super admin's approval." : enabled ? "Second super admin approval is on." : "Second super admin approval is off.", "good");
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  if (!q.data) return q.error ? <div className="callout bad">{describe(q.error)}</div> : <Loading rows={4} />;
  const { approval, pending, recent } = q.data;
  const on = !!approval?.enabled;
  const note = on
    ? `On: rate cards, merchant tariffs, service plans, role permissions and custom roles wait for a second super admin${(approval?.superAdmins ?? 0) > 1 ? "" : " (with only one super admin they apply at once)"}. Turning it off also needs a second super admin.`
    : "Off: changes by a super admin apply at once and are recorded in the audit log.";
  const rows = [...pending, ...recent];
  return (
    <Panel
      title="Changes waiting for approval"
      subtitle={`${note} ${pending.length} pending.`}
      tools={
        <label className="check" style={{ fontWeight: 650 }}>
          <input type="checkbox" checked={on} disabled={busy === "approval"} onChange={e => void setApproval(e.target.checked)} /> Second super admin approval
        </label>
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Change</th>
              <th>Requested by</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(c => (
              <tr key={c.id}>
                <td>
                  <span className="strong">{c.summary}</span>
                  <span className="sub">{KIND_LABEL[c.kind] || c.kind}</span>
                </td>
                <td>
                  {c.requestedBy.name}
                  <span className="sub">{dhaka(c.createdAt)}</span>
                </td>
                <td>
                  <Pill tone={STATUS_TONE[c.status]}>{c.status.charAt(0) + c.status.slice(1).toLowerCase()}</Pill>
                  {c.reviewedBy ? <span className="sub">{`${c.reviewedBy.name}${c.reviewNote ? ` · ${c.reviewNote}` : ""}`}</span> : c.error ? <span className="sub">{c.error}</span> : null}
                </td>
                <td className="nowrap">
                  {c.status === "PENDING" ? (
                    <>
                      {c.canApprove && c.requestedBy.id === user?.id ? (
                        <Button size="sm" disabled={busy === c.id} onClick={() => void act(c.id, "approve")}>
                          Apply now
                        </Button>
                      ) : c.canApprove ? (
                        <>
                          <Button size="sm" disabled={busy === c.id} onClick={() => void act(c.id, "approve")}>
                            Approve
                          </Button>{" "}
                          <Button size="sm" disabled={busy === c.id} onClick={() => void act(c.id, "reject")}>
                            Reject
                          </Button>
                        </>
                      ) : null}{" "}
                      {c.canCancel ? (
                        <Button size="sm" disabled={busy === c.id} onClick={() => void act(c.id, "cancel")}>
                          Withdraw
                        </Button>
                      ) : null}
                      {!c.canApprove && !c.canCancel ? <span className="sub">Waiting for another super admin</span> : null}
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={4} className="faint" style={{ textAlign: "center" }}>
                  No changes waiting for approval.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ───────────── Roles & permissions ─────────────
function RolesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "roles"], queryFn: () => api<Roles>("/admin/roles") });
  const [edits, setEdits] = useState<Record<string, Set<string>>>({});
  const [busy, setBusy] = useState("");
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [desc, setDesc] = useState("");
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["admin", "roles"] }), qc.invalidateQueries({ queryKey: ["admin", "changes"] })]);
  if (!q.data) return q.error ? <div className="callout bad">{describe(q.error)}</div> : <Loading rows={8} />;
  const r = q.data;
  const columns = [
    ...r.builtInRoles.map(b => ({ key: b.role, label: ROLE_NAME[b.role] || b.role, perms: new Set(b.permissions), locked: new Set(b.locked), builtIn: true, users: b.users, changed: b.granted.length + b.revoked.length, active: true })),
    ...r.customRoles.map(c => ({ key: `custom:${c.id}`, label: c.name, perms: new Set(c.permissions), locked: new Set<string>(), builtIn: false, users: c.users, changed: 0, active: c.active })),
  ];
  const permsOf = (col: (typeof columns)[number]) => edits[col.key] ?? col.perms;
  const tick = (col: (typeof columns)[number], key: string, on: boolean) => {
    const next = new Set(permsOf(col));
    if (on) next.add(key);
    else next.delete(key);
    setEdits({ ...edits, [col.key]: next });
  };
  async function run(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    try {
      toast(pendingNote((await work()) as { status?: string }));
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  const saveColumn = (col: (typeof columns)[number]) =>
    run(col.key, async () => {
      const permissions = [...permsOf(col)];
      const result = col.key.startsWith("custom:") ? await api(`/admin/custom-roles/${col.key.slice(7)}`, { method: "PATCH", body: { permissions } }) : await api(`/admin/roles/${col.key}/permissions`, { method: "PUT", body: { permissions } });
      setEdits(e => Object.fromEntries(Object.entries(e).filter(([k]) => k !== col.key)));
      return result;
    });
  async function createRole(e: FormEvent) {
    e.preventDefault();
    const baseRole = base || r.customRoleBases[0];
    if (name.trim().length < 2) return toast("Give the role a name (at least 2 characters).", "bad");
    const b = r.builtInRoles.find(x => x.role === baseRole);
    const permissions = (b?.permissions || []).filter(p => !r.permissions.find(x => x.key === p)?.superAdminOnly);
    await run("create", () => api("/admin/custom-roles", { method: "POST", body: { name: name.trim(), baseRole, description: desc.trim(), permissions } }));
    setName("");
    setDesc("");
  }
  async function removeRole(c: Roles["customRoles"][number]) {
    if (!(await confirm({ title: `Delete the role "${c.name}"?`, message: `${c.users} user${c.users === 1 ? "" : "s"} will lose it.`, ok: "Delete role", danger: true }))) return;
    await run(c.id, () => api(`/admin/custom-roles/${c.id}`, { method: "DELETE" }));
  }
  let group = "";
  return (
    <>
      <Panel title="Roles and permissions" subtitle="Tick what each role may do, then save that column. Changes take effect on the next request for everyone holding the role, after a second super admin approves them.">
        <div className="table-wrap" style={{ maxHeight: "70vh" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Permission</th>
                {columns.map(col => (
                  <th key={col.key} style={{ textAlign: "center" }}>
                    {col.label}
                    <span className="sub" style={{ textTransform: "none", letterSpacing: 0 }}>{`${col.builtIn ? "built-in" : col.active ? "custom" : "custom · inactive"} · ${col.users} user${col.users === 1 ? "" : "s"}${col.changed ? " · edited" : ""}`}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.permissions.map(p => {
                const head =
                  p.group !== group ? (
                    <tr key={`g-${p.group}`}>
                      <th colSpan={columns.length + 1} style={{ textAlign: "left", position: "static" }}>
                        {(group = p.group)}
                      </th>
                    </tr>
                  ) : null;
                return [
                  head,
                  <tr key={p.key}>
                    <td>
                      {p.label}
                      <span className="sub">{p.key}</span>
                    </td>
                    {columns.map(col => {
                      const reserved = p.superAdminOnly && col.key !== "SUPER_ADMIN";
                      const locked = col.locked.has(p.key) || !!reserved;
                      return (
                        <td key={col.key} style={{ textAlign: "center" }}>
                          <input type="checkbox" aria-label={`${col.label}: ${p.label}`} checked={permsOf(col).has(p.key)} disabled={locked} title={locked ? (reserved ? "Only super admins can hold this" : "Super admins always keep this") : ""} onChange={e => tick(col, p.key, e.target.checked)} />
                        </td>
                      );
                    })}
                  </tr>,
                ];
              })}
              <tr>
                <td />
                {columns.map(col => (
                  <td key={col.key} style={{ textAlign: "center" }}>
                    <Button size="sm" variant={edits[col.key] ? "primary" : "default"} disabled={busy === col.key} onClick={() => void saveColumn(col)}>
                      Save
                    </Button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel title="Custom roles" subtitle="A custom role opens the panel of its base role (scoped to a merchant or hub where the base role is) with exactly the permissions ticked in the matrix. Grant it from a user's roles (POST /users/:id/roles with customRoleId).">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Based on</th>
                <th>Permissions</th>
                <th>Users</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {r.customRoles.map(c => (
                <tr key={c.id}>
                  <td>
                    <span className="strong">{c.name}</span>
                    <span className="sub">{c.description || "No description"}</span>
                  </td>
                  <td>{ROLE_NAME[c.baseRole] || c.baseRole}</td>
                  <td>{c.permissions.length}</td>
                  <td>{c.users}</td>
                  <td>
                    <Pill tone={c.active ? "good" : undefined}>{c.active ? "Active" : "Inactive"}</Pill>
                  </td>
                  <td className="nowrap">
                    <Button size="sm" disabled={busy === c.id} onClick={() => void run(c.id, () => api(`/admin/custom-roles/${c.id}`, { method: "PATCH", body: { active: !c.active } }))}>
                      {c.active ? "Deactivate" : "Activate"}
                    </Button>{" "}
                    <Button size="sm" disabled={busy === c.id} onClick={() => void removeRole(c)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
              {!r.customRoles.length ? (
                <tr>
                  <td colSpan={6} className="faint" style={{ textAlign: "center" }}>
                    No custom roles yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <form className="panel-body form-grid" onSubmit={e => void createRole(e)} noValidate>
          <label className="field">
            <span>Name</span>
            <input className="input" required maxLength={60} placeholder="e.g. Billing viewer" value={name} onChange={e => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Based on</span>
            <Select className="select" value={base || r.customRoleBases[0]} onChange={e => setBase(e.target.value)}>
              {r.customRoleBases.map(b => (
                <option key={b} value={b}>
                  {ROLE_NAME[b] || b}
                </option>
              ))}
            </Select>
          </label>
          <label className="field full">
            <span>Description</span>
            <input className="input" maxLength={300} placeholder="What this role is for" value={desc} onChange={e => setDesc(e.target.value)} />
          </label>
          <div className="full">
            <Button type="submit" variant="primary" disabled={busy === "create"}>
              Create role with the base role's permissions
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
}

// ───────────── Support access ─────────────
interface FoundUser {
  id: string;
  name: string;
  phone?: string | null;
  roles: { role: string }[];
}
function Support() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["admin", "support"], queryFn: () => api<{ items: SupportSession[] }>("/admin/impersonations?limit=10") });
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 300);
  const found = useQuery({
    queryKey: ["admin", "support-users", q],
    enabled: q.length >= 2,
    queryFn: async () => (await api<{ items: FoundUser[] }>(`/users?q=${encodeURIComponent(q)}&status=ACTIVE&limit=20`)).items.filter(u => !u.roles.some(r => (STAFF_ROLES as readonly string[]).includes(r.role))),
  });
  const [userId, setUserId] = useState("");
  const [minutes, setMinutes] = useState("15");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState("ro");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState("");
  const chosen = userId || found.data?.[0]?.id || "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return toast("Search for the user first, then choose them.", "bad");
    if (reason.trim().length < 10) return toast("Say why you need access (at least 10 characters).", "bad");
    const readOnly = mode !== "full";
    if (!readOnly && !(await confirm({ title: "Start full-access support?", message: "Full access lets you make changes as this user. Every action is recorded under your name.", ok: "Continue", danger: true }))) return;
    const tab = window.open("about:blank", "_blank");
    setBusy("start");
    try {
      const result = await startSupportAccess({ userId: chosen, reason: reason.trim(), minutes: Number(minutes), readOnly, notifyUser: notify }, tab);
      if (!result.opened) toast("Allow pop-ups for this site to open the support view.", "bad");
      toast(`Support access to ${result.user.name} started (${readOnly ? "read-only" : "full access"}).`, "good");
      void qc.invalidateQueries({ queryKey: ["admin", "support"] });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy("");
    }
  }
  async function end(id: string) {
    setBusy(id);
    try {
      await api(`/admin/impersonations/${id}/end`, { method: "POST" });
      toast("Support access ended.", "good");
      void qc.invalidateQueries({ queryKey: ["admin", "support"] });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy("");
    }
  }
  const items = sessions.data?.items ?? [];
  return (
    <Panel
      title="Support access"
      subtitle={`View the platform as a merchant, rider or customer to help them. Read-only unless you choose full access; passwords and two-step verification can never be changed; every request is recorded; super admin and staff accounts can't be opened. Sessions started with "Log in as" from Courier Operations (including by operations managers, read-only) are listed here too.`}
    >
      <form className="panel-body form-grid" onSubmit={e => void submit(e)} noValidate>
        <div className="field">
          <label className="field-label" htmlFor="dfSupportQuery">
            User
          </label>
          <input id="dfSupportQuery" className="input" placeholder="Name, phone or email" autoComplete="off" value={query} onChange={e => (setQuery(e.target.value), setUserId(""))} />
          <Select className="select" aria-label="Choose a user" value={chosen} onChange={e => setUserId(e.target.value)} style={{ marginTop: 6 }}>
            {q.length < 2 || !found.data ? (
              <option value="">Search, then choose a user</option>
            ) : found.data.length ? (
              found.data.map(u => (
                <option key={u.id} value={u.id}>
                  {`${u.name} · ${localPhone(u.phone)} · ${[...new Set(u.roles.map(r => ROLE_NAME[r.role] || r.role))].join(", ")}`}
                </option>
              ))
            ) : (
              <option value="">No matching users (super admin and staff accounts can't be opened)</option>
            )}
          </Select>
        </div>
        <label className="field">
          <span>For</span>
          <Select className="select" value={minutes} onChange={e => setMinutes(e.target.value)}>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">60 minutes</option>
          </Select>
        </label>
        <label className="field full">
          <span>Reason (recorded and shown in the audit log)</span>
          <input className="input" maxLength={300} placeholder="e.g. Ticket TK-1042: merchant can't see yesterday's pickups" value={reason} onChange={e => setReason(e.target.value)} />
        </label>
        <label className="field">
          <span>Access</span>
          <Select className="select" value={mode} onChange={e => setMode(e.target.value)}>
            <option value="ro">Read-only</option>
            <option value="full">Full access (changes allowed)</option>
          </Select>
        </label>
        <label className="check" style={{ alignSelf: "end" }}>
          <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} /> Tell the user by SMS/email
        </label>
        <div className="full">
          <Button type="submit" variant="primary" disabled={busy === "start"}>
            Open their view in a new tab
          </Button>
        </div>
      </form>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>User / reason</th>
              <th>By</th>
              <th>Access</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map(s => (
              <tr key={s.id}>
                <td>
                  <span className="strong">{s.target.name}</span>
                  <span className="sub">{s.reason}</span>
                </td>
                <td>
                  {s.admin.name}
                  {s.admin.role ? <span className="sub">{s.admin.role}</span> : null}
                </td>
                <td>{s.readOnly ? "Read-only" : "Full access"}</td>
                <td>
                  {dhaka(s.createdAt)}
                  <span className="sub">{s.active ? `until ${dhaka(s.expiresAt)}` : s.endedAt ? `ended ${dhaka(s.endedAt)}` : "expired"}</span>
                </td>
                <td>
                  {s.active ? (
                    <Button size="sm" disabled={busy === s.id} onClick={() => void end(s.id)}>
                      End
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
            {!items.length ? (
              <tr>
                <td colSpan={5} className="faint" style={{ textAlign: "center" }}>
                  {sessions.isLoading ? "Loading…" : "No support access sessions yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

