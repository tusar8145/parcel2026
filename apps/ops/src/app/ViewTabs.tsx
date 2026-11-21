import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useOps } from "@/lib/ops";
import { Tabs } from "@panel/ui/kit";
import { pathFor, viewById } from "./nav";
import "./view-tabs.css";

/**
 * The tabs of a view (hidden tabs: Accounts by role), each its own address: a row on top of the page; Scan desk
 * (tabsAt "side") a vertical list in the page's left column (Shell: #view-tabs; on a narrow screen a row on top);
 * Reports and Accounts (tabsAt "menu") none here, they are sub-items of the main menu.
 */
export default function ViewTabs({ view, tab, counts, badges }: { view: string; tab: string; counts?: Record<string, number | null | undefined>; badges?: Record<string, { badge?: ReactNode; title?: string } | undefined> }) {
  const v = viewById(view);
  const ops = useOps();
  const navigate = useNavigate();
  const [slot, setSlot] = useState<HTMLElement | null>(() => document.getElementById("view-tabs"));
  useEffect(() => {
    if (!slot) setSlot(document.getElementById("view-tabs"));
  }, [slot]);
  // On a narrow screen the tabs are a row that scrolls sideways: the open tab is brought into sight.
  const listRef = useRef<HTMLElement>(null);
  // The open tab's box slides from tab to tab, as in the main menu (view-tabs.css .vtabs-indicator).
  const [box, setBox] = useState({ top: 0, left: 0, width: 0, height: 0, shown: false, ready: false });
  useLayoutEffect(() => {
    const nav = listRef.current;
    if (!nav) return;
    const place = () => {
      const open = nav.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!open) return setBox(b => ({ ...b, shown: false }));
      setBox(b => ({ top: open.offsetTop, left: open.offsetLeft, width: open.offsetWidth, height: open.offsetHeight, shown: true, ready: b.shown || b.ready }));
    };
    place();
    const open = nav.querySelector<HTMLElement>('[aria-selected="true"]');
    if (open && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, open.offsetLeft - 24);
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [tab, slot]);
  if (!v || v.tabs.length < 2 || v.tabsAt === "menu") return null;
  if (v.tabsAt !== "side")
    return (
      <Tabs
        label={v.label}
        value={tab}
        onChange={t => navigate(pathFor(view, t))}
        tabs={v.tabs.map(t => ({ id: t.id, hidden: t.show ? !t.show(ops.menu) : false, count: counts?.[t.id] ?? null, badge: badges?.[t.id]?.badge, title: badges?.[t.id]?.title }))}
      />
    );
  const tabs = v.tabs.filter(t => !(t.show && !t.show(ops.menu)));
  const list = (
    <nav ref={listRef} className="vtabs" role="tablist" aria-orientation="vertical" aria-label={`${v.label} tabs`}>
      <div className={`vtabs-indicator${box.shown ? " shown" : ""}${box.ready ? " ready" : ""}`} aria-hidden="true" style={{ transform: `translate(${box.left}px, ${box.top}px)`, width: box.width, height: box.height }} />
      {/* The view's name on top, unless its tabs have group headings of their own. */}
      {tabs.some(t => t.group) ? null : <div className="vtabs-title">{v.label}</div>}
      {tabs.map(t => {
        const count = counts?.[t.id];
        return (
          <Fragment key={t.id}>
          {/* A group heading above its first tab (Scan desk: At the hub, Hub collection, CN labels, Rider operation). */}
          {t.group ? (
            <div className="vtabs-group" role="presentation">
              {t.group}
            </div>
          ) : null}
          <button type="button" role="tab" className="vtab" aria-selected={t.id === tab} title={badges?.[t.id]?.title} onClick={() => navigate(pathFor(view, t.id))}>
            <span className="vtab-label">{t.id}</span>
            {count != null ? <span className="count">{count.toLocaleString("en-US")}</span> : null}
            {badges?.[t.id]?.badge}
          </button>
          </Fragment>
        );
      })}
    </nav>
  );
  return slot ? createPortal(list, slot) : list;
}
