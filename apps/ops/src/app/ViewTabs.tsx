import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useOps } from "@/lib/ops";
import { Tabs } from "@panel/ui/kit";
import { pathFor, viewById } from "./nav";

/** The tabs of a view (hidden tabs: Accounts by role), each its own address. */
export default function ViewTabs({ view, tab, counts, badges }: { view: string; tab: string; counts?: Record<string, number | null | undefined>; badges?: Record<string, { badge?: ReactNode; title?: string } | undefined> }) {
  const v = viewById(view);
  const ops = useOps();
  const navigate = useNavigate();
  if (!v || v.tabs.length < 2) return null;
  return (
    <Tabs
      label={v.label}
      value={tab}
      onChange={t => navigate(pathFor(view, t))}
      tabs={v.tabs.map(t => ({ id: t.id, hidden: t.show ? !t.show(ops.menu) : false, count: counts?.[t.id] ?? null, badge: badges?.[t.id]?.badge, title: badges?.[t.id]?.title }))}
    />
  );
}
