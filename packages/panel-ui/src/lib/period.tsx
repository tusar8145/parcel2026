/**
 * Dashboard period (shared/period.js): Today · Yesterday · This week · Last 7 days · This month · Last month ·
 * Custom range. Asia/Dhaka calendar days; weeks start on Saturday. Kept in the URL (?period=, or
 * ?period=custom&from=&to=) so a shared link opens the same period, and remembered per page.
 */
import { Select } from "../ui/Select";
import { useSearchParams } from "react-router";
import { useState } from "react";

const DHAKA_MS = 6 * 3600_000;
const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const PRESETS: [string, string][] = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["this_week", "This week"],
  ["last_7_days", "Last 7 days"],
  ["this_month", "This month"],
  ["last_month", "Last month"],
  ["custom", "Custom range"],
];
const LABEL = Object.fromEntries(PRESETS);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = (now = new Date()) => new Date(now.getTime() + DHAKA_MS).toISOString().slice(0, 10);
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
const validDay = (day?: string | null) => !!day && DAY.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

export interface PeriodState {
  key: string;
  from: string;
  to: string;
}

function range(key: string): { from: string; to: string } {
  const t = today();
  const [y, m] = t.split("-").map(Number);
  const monthStart = (year: number, month: number) => new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  switch (key) {
    case "yesterday":
      return { from: shift(t, -1), to: shift(t, -1) };
    case "this_week":
      return { from: shift(t, -((new Date(`${t}T00:00:00Z`).getUTCDay() + 1) % 7)), to: t };
    case "last_7_days":
      return { from: shift(t, -6), to: t };
    case "this_month":
      return { from: monthStart(y, m), to: t };
    case "last_month":
      return { from: monthStart(y, m - 1), to: shift(monthStart(y, m), -1) };
    default:
      return { from: t, to: t };
  }
}
export function periodProblem(from?: string, to?: string) {
  if (!validDay(from) || !validDay(to)) return "Choose both dates";
  if (from! > to!) return "The start date must be on or before the end date";
  if (daysBetween(from!, to!) > MAX_DAYS) return `Choose at most ${MAX_DAYS} days`;
  return "";
}
function normalize(raw: Partial<PeriodState> | null, defaultKey: string): PeriodState {
  if (raw?.key === "custom" && !periodProblem(raw.from, raw.to)) return { key: "custom", from: raw.from!, to: raw.to! };
  const key = raw?.key && raw.key !== "custom" && LABEL[raw.key] ? raw.key : defaultKey;
  return { key, ...range(key) };
}
/** "18 Oct", "13–18 Oct", "28 Sep – 18 Oct", "28 Dec 2025 – 3 Jan 2026". */
function span(from: string, to: string) {
  const part = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return { y, m, d, text: `${d} ${MONTHS[m - 1]}` };
  };
  const a = part(from);
  const b = part(to);
  const year = a.y !== Number(today().slice(0, 4));
  if (from === to) return `${a.text}${year ? ` ${a.y}` : ""}`;
  if (a.y !== b.y) return `${a.text} ${a.y} – ${b.text} ${b.y}`;
  if (a.m !== b.m) return `${a.text} – ${b.text}${year ? ` ${b.y}` : ""}`;
  return `${a.d}–${b.text}${year ? ` ${b.y}` : ""}`;
}
export const periodText = (s: PeriodState) => `${s.key === "custom" ? "Custom range" : LABEL[s.key]} · ${span(s.from, s.to)}`;
export const periodWords = (s: PeriodState) =>
  ({ today: "today", yesterday: "yesterday", this_week: "this week", last_7_days: "last 7 days", this_month: "this month", last_month: "last month" })[s.key] || "in this period";
export const periodVersus = (s: PeriodState) =>
  s.key === "today" ? "vs. yesterday" : s.key === "yesterday" ? "vs. the day before" : s.key === "this_month" || s.key === "last_month" ? "vs. previous period" : `vs. previous ${daysBetween(s.from, s.to)} days`;
export const periodQuery = (s: PeriodState) => `from=${s.from}&to=${s.to}`;
export const periodLabel = (s: PeriodState) => (s.key === "custom" ? span(s.from, s.to) : LABEL[s.key]);

const storageKey = (page: string) => `deliveryfast-period:${page}`;

/** The period a page will open with (URL, then the remembered choice, then the default), outside React: lets a
 *  panel start loading the page's figures before the page itself has loaded. Same rules as usePeriod. */
export function periodQueryOf(page: string, defaultKey = "today") {
  const params = new URLSearchParams(location.search);
  const key = params.get("period");
  const from = params.get("from") ?? undefined;
  const to = params.get("to") ?? undefined;
  let raw: Partial<PeriodState> | null = key === "custom" || (!key && from && to) ? { key: "custom", from, to } : key ? { key } : null;
  if (!raw)
    try {
      raw = JSON.parse(localStorage.getItem(storageKey(page)) || "null");
    } catch {
      raw = null;
    }
  return periodQuery(normalize(raw, defaultKey));
}

/** The page's period: URL first (deep link), then the remembered choice, then the default. */
export function usePeriod(page: string, defaultKey = "today") {
  const [params, setParams] = useSearchParams();
  const fromUrl = (): Partial<PeriodState> | null => {
    const key = params.get("period");
    const from = params.get("from") ?? undefined;
    const to = params.get("to") ?? undefined;
    if (key === "custom" || (!key && from && to)) return { key: "custom", from, to };
    return key ? { key } : null;
  };
  const saved = (): Partial<PeriodState> | null => {
    try {
      return JSON.parse(localStorage.getItem(storageKey(page)) || "null");
    } catch {
      return null;
    }
  };
  const state = normalize(fromUrl() ?? saved(), defaultKey);
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null);
  const set = (next: PeriodState) => {
    try {
      localStorage.setItem(storageKey(page), JSON.stringify(next.key === "custom" ? next : { key: next.key }));
    } catch {
      /* storage blocked */
    }
    setParams(
      p => {
        p.set("period", next.key);
        if (next.key === "custom") {
          p.set("from", next.from);
          p.set("to", next.to);
        } else {
          p.delete("from");
          p.delete("to");
        }
        return p;
      },
      { replace: true },
    );
  };
  return {
    state,
    query: periodQuery(state),
    text: periodText(state),
    words: periodWords(state),
    versus: periodVersus(state),
    label: periodLabel(state),
    choose: (key: string) => (key === "custom" ? setDraft({ from: state.from, to: state.to }) : (setDraft(null), set(normalize({ key }, defaultKey)))),
    draft,
    setDraft,
    applyCustom: (from: string, to: string) => {
      const problem = periodProblem(from, to);
      if (problem) return problem;
      setDraft(null);
      set({ key: "custom", from, to });
      return "";
    },
  };
}

export function PeriodSelect({ period }: { period: ReturnType<typeof usePeriod> }) {
  const [error, setError] = useState("");
  const custom = period.draft ?? (period.state.key === "custom" ? { from: period.state.from, to: period.state.to } : null);
  return (
    <div className="row" style={{ gap: 6 }}>
      <Select className="select sm" aria-label="Period" value={period.draft ? "custom" : period.state.key} onChange={e => period.choose(e.target.value)} style={{ width: 150 }}>
        {PRESETS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </Select>
      {custom ? (
        <>
          <input className="input sm" type="date" aria-label="From" value={custom.from} max={today()} onChange={e => period.setDraft({ ...custom, from: e.target.value })} style={{ width: 140 }} />
          <input className="input sm" type="date" aria-label="To" value={custom.to} max={today()} onChange={e => period.setDraft({ ...custom, to: e.target.value })} style={{ width: 140 }} />
          {period.draft ? (
            <button type="button" className="button sm primary" onClick={() => setError(period.applyCustom(custom.from, custom.to))}>
              Apply
            </button>
          ) : null}
          {error ? <small style={{ color: "var(--bad)" }}>{error}</small> : null}
        </>
      ) : null}
    </div>
  );
}
