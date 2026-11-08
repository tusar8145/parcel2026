/**
 * "Log in as" (support access, bridge-login-as.js) for merchants and riders, for people with `can.loginAs`.
 *
 *   Candidates   GET  /admin/impersonations/targets?merchantId=… | ?riderId=…
 *   Start        POST /admin/impersonations { merchantId, userId? | riderId, reason, minutes, readOnly, notifyUser }
 *
 * A NEW TAB opens the account's panel with `?support-access=1`; that page (shared/api.js) collects the short-lived
 * token once through window.opener.DF.takeSupportAccess() — never through storage or the URL. This tab's own
 * session is untouched.
 */
import { api, describe } from "@panel/lib/api";
import { localPhone } from "@panel/lib/format";
import { openForm, type FormField } from "@panel/ui/dialogs";
import { toast } from "@panel/ui/toast";

interface Target {
  userId: string;
  name: string;
  roleLabel: string;
  phone: string;
  panel?: string;
  allowed: boolean;
  refusal?: string;
}
interface StartResult {
  impersonation: { id: string };
  user: { id: string; name: string; panel?: string };
  accessToken: string;
  expiresIn: number;
}

let handoff: { id: string; userId: string; accessToken: string; expiresAt: number } | null = null;
// The opened panel asks its opener for the token once (legacy/shared/api.js).
const w = window as unknown as { DF?: Record<string, unknown> };
w.DF = { ...(w.DF ?? {}), takeSupportAccess: () => ((value => ((handoff = null), value))(handoff)) };

async function start(body: Record<string, unknown>, tab: Window | null, panel?: string) {
  try {
    const result = await api<StartResult>("/admin/impersonations", { method: "POST", body });
    handoff = { id: result.impersonation.id, userId: result.user.id, accessToken: result.accessToken, expiresAt: Date.now() + result.expiresIn * 1000 - 5000 };
    setTimeout(() => (handoff = null), 60_000);
    const [path, hash = ""] = (panel || result.user.panel || "/").split("#");
    const url = `${path}${path.includes("?") ? "&" : "?"}support-access=1${hash ? `#${hash}` : ""}`;
    if (tab && !tab.closed) tab.location.href = url;
    return { ...result, opened: !!(tab && !tab.closed) };
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** subject: a merchant ({ merchantId }) or a rider ({ riderId }), with the name shown in the dialog. */
export async function loginAs(subject: { merchantId?: string; riderId?: string; name: string }, can: { loginAs: boolean; loginAsFull: boolean }) {
  if (!can.loginAs) return toast("Your account can't log in as merchants or riders.", "bad");
  const query = subject.merchantId ? `merchantId=${subject.merchantId}` : `riderId=${subject.riderId}`;
  let candidates: { items: Target[]; fullAccess?: boolean };
  try {
    candidates = await api(`/admin/impersonations/targets?${query}`);
  } catch (error) {
    return toast(describe(error), "bad");
  }
  const usable = candidates.items.filter(t => t.allowed);
  if (!usable.length) {
    const why = candidates.items[0]?.refusal;
    return toast(candidates.items.length ? `${subject.name}: ${why || "this account can't be opened."}` : `${subject.name} has no account to open.`, "bad");
  }
  const full = !!candidates.fullAccess && can.loginAsFull;
  const label = (t: Target) => `${t.name} · ${t.roleLabel} · ${localPhone(t.phone)}`;
  const blocked = candidates.items.filter(t => !t.allowed);
  const pick = (member?: string) => usable.find(t => t.userId === member) || usable[0];
  const fields: FormField[] = [
    usable.length > 1
      ? {
          id: "member",
          label: "Whose account",
          type: "select",
          required: true,
          value: usable[0].userId,
          options: usable.map(t => ({ value: t.userId, label: label(t) })),
          full: true,
          hint: blocked.length ? `${blocked.length} other member${blocked.length === 1 ? "" : "s"} can't be opened (staff or inactive).` : undefined,
        }
      : { id: "member", type: "static", label: "Account", value: label(usable[0]) },
    { id: "reason", label: "Reason (recorded and shown in the audit log)", type: "textarea", required: true, maxLength: 300, rows: 2, full: true, placeholder: "e.g. Ticket TK-1042: merchant can't see yesterday's pickups" },
    { id: "minutes", label: "Duration (minutes, 5–60)", type: "number", required: true, value: "15", min: 5, max: 60, step: 1 },
    full
      ? { id: "access", label: "Access", type: "select", required: true, value: "ro", options: [{ value: "ro", label: "Read-only (recommended)" }, { value: "full", label: "Full access (changes allowed)" }] }
      : { id: "access", label: "Access", type: "static", value: "Read-only: you can look, nothing can be changed." },
    ...(full
      ? ([
          {
            id: "fullWarning",
            type: "static",
            label: "Warning",
            full: true,
            show: v => v.access === "full",
            render: <span style={{ color: "var(--bad)", fontWeight: 600 }}>Full access lets you make changes as this person (bookings, payments, settings). Every action is recorded under your name.</span>,
          },
          { id: "notify", label: "Tell them", type: "select", value: "yes", options: [{ value: "yes", label: "Yes, by SMS / email / in-app (recommended)" }, { value: "no", label: "No" }] },
        ] as FormField[])
      : [{ id: "notifyInfo", type: "static", label: "Tell them", full: true, value: "They are told by SMS / email / in-app that support is viewing their account." } as FormField]),
  ];
  let tab: Window | null = null;
  await openForm({
    title: `Log in as ${subject.name}`,
    description: "Opens their account in a new tab with a time limit. Passwords, two-step verification and sessions can't be reached; every request is recorded under your name.",
    submit: "Open in a new tab",
    fields,
    validate: {
      reason: v => (v.trim().length < 10 ? "Say why you need access (at least 10 characters)" : ""),
      minutes: v => (!/^\d+$/.test(v) || Number(v) < 5 || Number(v) > 60 ? "Choose 5 to 60 minutes" : ""),
    },
    review: v => (v.access === "full" ? [["Account", label(pick(v.member))], ["Access", "Full access: changes allowed"], ["Duration", `${v.minutes} minutes`], ["Reason", v.reason]] : null),
    confirm: "Open with full access",
    onSubmit: async v => {
      const target = pick(v.member);
      const readOnly = v.access !== "full";
      // Opened during the click (pop-up blockers), then pointed at the panel once the session exists.
      tab = window.open("about:blank", "_blank");
      const body: Record<string, unknown> = { reason: v.reason.trim(), minutes: Number(v.minutes), readOnly, ...(full ? { notifyUser: v.notify !== "no" } : {}) };
      if (subject.merchantId) Object.assign(body, { merchantId: subject.merchantId, userId: target.userId });
      else body.riderId = subject.riderId;
      const result = await start(body, tab, target.panel);
      return result.opened
        ? `Opened ${result.user.name}'s account in a new tab (${readOnly ? "read-only" : "full access"}, ${v.minutes} min).`
        : `Session started for ${result.user.name}, but the browser blocked the new tab. Allow pop-ups for this site and try again.`;
    },
  });
}
