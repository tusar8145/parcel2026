"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** The browser client (public/legacy/shared/api.js). */
interface SessionUser {
  id: string;
  name: string;
  phone: string;
  panel?: string;
}
interface DFClient {
  api<T = any>(path: string, options?: { method?: string; body?: unknown }): Promise<T>;
  describe(error: unknown): string;
  auth: { user: SessionUser | null; logout(): Promise<void>; refresh(): Promise<SessionUser | null> };
  live?: (types: string[], handler: () => unknown, opts?: { debounceMs?: number; fallbackMs?: number }) => void;
  confirm?: (o: { title: string; message?: string; confirm?: string; danger?: boolean }) => Promise<boolean>;
}
const df = () => (window as unknown as { DF: DFClient }).DF;

type Status = "SUBMITTED" | "UNDER_REVIEW" | "INFO_REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN";
interface Application {
  number: string;
  kind: "RIDER" | "FRANCHISE";
  status: Status;
  statusLabel: string;
  ticketStatus: string;
  applicant: { name: string; phone: string; email: string | null } | null;
  details: { name: string; phone: string; email?: string; area?: string; vehicle?: string; location?: string; territory?: string; experience?: string };
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}
interface Message {
  id: string;
  author: { label: string; kind: "system" | "requester" | "staff" };
  body: string;
  internal: boolean;
  createdAt: string;
}

const OPEN: Status[] = ["SUBMITTED", "UNDER_REVIEW", "INFO_REQUESTED"];
const VEHICLE: Record<string, string> = { MOTORCYCLE: "Motorcycle", BICYCLE: "Bicycle", ON_FOOT: "On foot" };
const TERRITORY: Record<string, string> = { CITY_ZONE: "City zone", DISTRICT: "District", MULTI_DISTRICT_REGION: "Multi-district region" };
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
const localPhone = (p: string | null | undefined) => (p ? p.replace(/^\+880/, "0") : "");

const ICON = {
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z",
};
const Svg = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** The headline for the application's state. */
function hero(app: Application, phone: string) {
  const role = app.kind === "RIDER" ? "rider" : "franchise";
  switch (app.status) {
    case "INFO_REQUESTED":
      return { tone: "amber", icon: ICON.alert, badge: "Not approved yet", title: "Action needed: Delivery Fast needs more information", text: "Read the message below and send your reply. Your application goes back to review as soon as you answer." };
    case "APPROVED":
      return app.kind === "FRANCHISE"
        ? { tone: "green", icon: ICON.check, badge: "Approved", title: "Approved: we're setting up your franchise hub", text: `Your franchise application is approved. We'll text ${phone} when your franchise panel is ready, then sign in again to open it.` }
        : { tone: "green", icon: ICON.check, badge: "Approved", title: "Approved: welcome to Delivery Fast", text: "Opening the rider app…" };
    case "REJECTED":
      return { tone: "red", icon: ICON.x, badge: "Not approved", title: "Your application wasn't approved", text: app.decisionNote || "Delivery Fast couldn't approve this application. You can apply again with updated details." };
    case "WITHDRAWN":
      return { tone: "red", icon: ICON.x, badge: "Withdrawn", title: "You withdrew this application", text: "You can apply again at any time." };
    default:
      return {
        tone: "blue",
        icon: ICON.clock,
        badge: "Not approved yet",
        title: `Your ${role} application is being reviewed`,
        text: `Your account isn't active yet. The Delivery Fast team is reviewing your application and will text ${phone} as soon as there's news. Nothing else is needed from you right now.`,
      };
  }
}

/**
 * The application page: the only page a rider or franchise applicant sees until they are approved (APPLICANT
 * role, /application). Status, steps, messages with Delivery Fast (the application's support ticket),
 * the details as submitted (read-only), withdraw and sign out. Approval opens their real panel.
 */
export default function ApplicationApp() {
  const [ready, setReady] = useState(false);
  const [app, setApp] = useState<Application | null>(null);
  const [none, setNone] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const user = ready ? df().auth.user : null;

  const show = (text: string, bad?: boolean) => {
    setToast({ text, bad });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4500);
  };

  // Start once api.js has restored the session (html.legacy-ready).
  useEffect(() => {
    const root = document.documentElement;
    const start = () => setReady(true);
    if (root.classList.contains("legacy-ready")) return start();
    const observer = new MutationObserver(() => root.classList.contains("legacy-ready") && (observer.disconnect(), start()));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  /** Approved (rider created, franchise set up) or no longer an applicant: open the account's own panel. */
  const followPanel = useCallback(async () => {
    const fresh = await df()
      .auth.refresh()
      .catch(() => null);
    if (fresh?.panel && fresh.panel !== "/application") {
      location.replace(fresh.panel);
      return true;
    }
    return false;
  }, []);

  const load = useCallback(async () => {
    try {
      const mine = await df().api<Application[]>("/applications/mine");
      const latest = mine.find(a => OPEN.includes(a.status)) ?? mine[0] ?? null;
      setApp(latest);
      setNone(!latest);
      setError("");
      if (latest) {
        const ticket = await df()
          .api<{ messages: Message[] }>(`/support/tickets/${encodeURIComponent(latest.number)}`)
          .catch(() => null);
        setMessages(ticket ? ticket.messages.filter(m => !m.internal) : []);
      }
      if (latest?.status === "APPROVED" && latest.kind === "RIDER") await followPanel();
    } catch (e) {
      setError(df().describe(e));
    }
  }, [followPanel]);

  useEffect(() => {
    if (!ready) return;
    void followPanel().then(left => {
      if (left) return;
      void load();
      df().live?.(["application.updated", "ticket.updated"], async () => {
        if (!(await followPanel())) await load();
      });
    });
  }, [ready, load, followPanel]);

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) show(done);
      return true;
    } catch (e) {
      show(df().describe(e), true);
      return false;
    } finally {
      setBusy("");
    }
  };

  const sendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!app) return;
    const body = reply.trim();
    if (body.length < 2) return show("Write your reply first.", true);
    if (await act("reply", () => df().api(`/support/tickets/${encodeURIComponent(app.number)}/messages`, { method: "POST", body: { body } }), "Reply sent to Delivery Fast.")) {
      setReply("");
      await load();
    }
  };

  const withdraw = async () => {
    if (!app) return;
    const ok = await (df().confirm?.({ title: "Withdraw your application?", message: "Delivery Fast stops reviewing it. You can apply again later.", confirm: "Withdraw", danger: true }) ?? Promise.resolve(window.confirm("Withdraw your application?")));
    if (!ok) return;
    if (await act("withdraw", () => df().api(`/applications/${encodeURIComponent(app.number)}/withdraw`, { method: "POST" }), "Application withdrawn.")) if (!(await followPanel())) await load();
  };

  const leave = async () => {
    if (await act("leave", () => df().api("/applications/leave", { method: "POST" }))) if (!(await followPanel())) location.replace("/");
  };

  const signOut = async () => {
    const ok = await (df().confirm?.({ title: "Sign out?", message: "You can sign in again at any time to follow your application.", confirm: "Sign out" }) ?? Promise.resolve(true));
    if (ok) await df().auth.logout().then(() => location.replace("/login"));
  };

  const phone = localPhone(app?.applicant?.phone ?? user?.phone) || "your phone";
  const h = app ? hero(app, phone) : null;
  const open = !!app && OPEN.includes(app.status);
  const role = app?.kind === "RIDER" ? "Rider" : "Franchise";
  const reviewing = app && (app.status === "UNDER_REVIEW" || app.status === "INFO_REQUESTED");
  const steps = app
    ? [
        { title: "Application received", note: day(app.createdAt), state: "done" },
        {
          title: "Review by Delivery Fast",
          note: app.status === "INFO_REQUESTED" ? "Waiting for your reply" : app.status === "REJECTED" ? "Not approved" : app.status === "WITHDRAWN" ? "Withdrawn" : app.status === "APPROVED" ? day(app.decidedAt) : reviewing ? "In progress" : "Soon",
          state: app.status === "APPROVED" ? "done" : app.status === "REJECTED" || app.status === "WITHDRAWN" ? "failed" : "current",
        },
        { title: "Approved", note: app.status === "APPROVED" ? day(app.decidedAt) : "", state: app.status === "APPROVED" ? "done" : "todo" },
        app.kind === "RIDER" ? { title: "Rider app", note: "Tasks, KYC documents, earnings", state: "todo" } : { title: "Franchise panel", note: app.status === "APPROVED" ? "Being set up" : "Your hub, riders, walk-ins", state: app.status === "APPROVED" ? "current" : "todo" },
      ]
    : [];
  const d = app?.details;
  const rows: [string, string][] = d
    ? [
        ["Name", d.name],
        ["Phone", localPhone(d.phone)],
        ["Email", d.email || "—"],
        ...(app!.kind === "RIDER"
          ? ([
              ["Preferred work area", d.area || "—"],
              ["Vehicle", VEHICLE[d.vehicle ?? ""] ?? d.vehicle ?? "—"],
            ] as [string, string][])
          : ([
              ["Proposed hub location", d.location || "—"],
              ["Preferred territory", TERRITORY[d.territory ?? ""] ?? d.territory ?? "—"],
              ["Business experience", d.experience || "—"],
            ] as [string, string][])),
      ]
    : [];

  return (
    <div className="ap-shell">
      <header className="ap-top">
        <a className="ap-brand" href="/" aria-label="Delivery Fast">
          <b>
            {"delivery "}
            <span>{"fast"}</span>
          </b>
        </a>
        <div className="ap-who">
          {user ? <span id="apUser">{`${user.name} · ${localPhone(user.phone)}`}</span> : null}
          <button type="button" className="ap-btn" id="apSignOut" onClick={() => void signOut()}>
            {"Sign out"}
          </button>
        </div>
      </header>

      <main className="ap-main">
        <div className="ap-heading">
          <p className="ap-eyebrow">{app ? `${role} application · ${app.number}` : "Your application"}</p>
          <h1>{"Your application"}</h1>
        </div>

        {error ? (
          <section className="ap-card" role="alert">
            <p className="ap-muted">{error}</p>
          </section>
        ) : !ready || (!app && !none) ? (
          <section className="ap-card">
            <p className="ap-muted">{"Loading your application…"}</p>
          </section>
        ) : none ? (
          <section className="ap-card" id="apNone">
            <h2>{"No application yet"}</h2>
            <p className="ap-muted">{"You haven't sent a rider or franchise application from this account."}</p>
            <div className="ap-actions">
              <a className="ap-btn primary" href="/become-a-rider">
                {"Apply as a rider"}
              </a>
              <a className="ap-btn" href="/become-a-franchise">
                {"Apply for a franchise"}
              </a>
            </div>
          </section>
        ) : app && h ? (
          <>
            <section className={`ap-hero ${h.tone}`} id="apStatus" role="status" data-status={app.status}>
              <span className="ap-hero-icon">
                <Svg d={h.icon} />
              </span>
              <div style={{ minWidth: 0 }}>
                <span className={`ap-badge ${h.tone}`} id="apBadge">
                  {h.badge}
                </span>
                <h2>{h.title}</h2>
                <p>{h.text}</p>
                {open ? <p className="ap-meta">{`Until your application is approved you can't use the ${app.kind === "RIDER" ? "rider app" : "franchise panel"} or other Delivery Fast services from this account.`}</p> : null}
                {app.status === "REJECTED" || app.status === "WITHDRAWN" ? (
                  <div className="ap-actions">
                    <a className="ap-btn primary" id="apApplyAgain" href={app.kind === "RIDER" ? "/become-a-rider" : "/become-a-franchise"}>
                      {"Apply again"}
                    </a>
                    <button type="button" className="ap-btn" id="apLeave" disabled={busy === "leave"} onClick={() => void leave()}>
                      {"Close and continue to Delivery Fast"}
                    </button>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="ap-card" aria-label="Steps">
              <h2>{app.kind === "RIDER" ? "Steps to start riding" : "Steps to open your franchise"}</h2>
              <ol className="ap-steps">
                {steps.map((s, i) => (
                  <li key={s.title} className={`ap-step ${s.state}`}>
                    <span className="ap-dot">{s.state === "done" ? <Svg d={ICON.check} /> : s.state === "failed" ? <Svg d={ICON.x} /> : i + 1}</span>
                    <div>
                      <strong>{s.title}</strong>
                      {s.note ? <small>{s.note}</small> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className="ap-card" id="apMessages">
              <div className="ap-card-head">
                <div>
                  <h2>{"Messages with Delivery Fast"}</h2>
                  <p>{"About your application."}</p>
                </div>
                {app.status === "INFO_REQUESTED" ? <span className="ap-badge amber">{"Reply needed"}</span> : null}
              </div>
              <div className="ap-thread">
                {messages === null ? (
                  <p className="ap-muted">{"Loading…"}</p>
                ) : messages.length ? (
                  messages.map(m => (
                    <div key={m.id} className={`ap-msg ${m.author.kind}`}>
                      <div className="ap-msg-head">
                        <b>{m.author.kind === "requester" ? "You" : m.author.kind === "system" ? "Delivery Fast" : m.author.label}</b>
                        <small>{when(m.createdAt)}</small>
                      </div>
                      <p>{m.body}</p>
                    </div>
                  ))
                ) : (
                  <p className="ap-muted">{"No messages yet."}</p>
                )}
              </div>
              {open ? (
                <form className="ap-reply" onSubmit={e => void sendReply(e)}>
                  <label htmlFor="apReply">{app.status === "INFO_REQUESTED" ? "Your reply" : "Write to Delivery Fast"}</label>
                  <textarea id="apReply" rows={3} value={reply} onChange={e => setReply(e.target.value)} placeholder="Type your message" maxLength={4000} />
                  <div className="ap-actions">
                    <button type="submit" className="ap-btn primary" id="apSendReply" disabled={busy === "reply"}>
                      {busy === "reply" ? "Sending…" : "Send"}
                    </button>
                  </div>
                </form>
              ) : null}
            </section>

            <section className="ap-card" id="apDetails">
              <div className="ap-card-head">
                <div>
                  <h2>{"Your application"}</h2>
                  <p>{open ? "As you sent it. It can't be changed while it's being reviewed; to correct something, say so in a message above." : `Sent on ${day(app.createdAt)}.`}</p>
                </div>
                <span className="ap-readonly">
                  <Svg d={ICON.lock} />
                  {"Read-only"}
                </span>
              </div>
              <dl className="ap-details">
                {rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {open ? (
                <div className="ap-actions">
                  <button type="button" className="ap-btn danger" id="apWithdraw" disabled={busy === "withdraw"} onClick={() => void withdraw()}>
                    {"Withdraw application"}
                  </button>
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </main>
      {toast ? (
        <div className={`ap-toast${toast.bad ? " bad" : ""}`} role="status" id="apToast">
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
