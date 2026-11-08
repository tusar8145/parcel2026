/**
 * Notifications (shared/notifications.js page): All / Unread, Mark all as read, Load more (cursor paging, 25 a page).
 * Clicking one marks it read (POST /me/notifications/:id/read) and opens its link: inside this panel by route,
 * elsewhere by URL. Live on notification.created / notification.read.
 */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { Button, Loading, PageHeading, Panel, Tabs, useStored } from "@panel/ui/kit";
import { toastError } from "@panel/ui/toast";
import { internalLink } from "@/app/Shell";

interface Notification {
  id: string;
  title: string;
  body?: string | null;
  link?: string | null;
  readAt?: string | null;
  createdAt: string;
}
interface Page {
  items: Notification[];
  nextCursor: string | null;
  unread: number;
}
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

export default function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useStored<"all" | "unread">("deliveryfast-admin-notifications", "all");
  const q = useInfiniteQuery({
    queryKey: ["notifications", "page", filter],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "25" });
      if (filter === "unread") p.set("unread", "true");
      if (pageParam) p.set("cursor", pageParam);
      return api<Page>(`/me/notifications?${p}`);
    },
    getNextPageParam: last => last.nextCursor || undefined,
  });
  useLive(["notification.created", "notification.read"], () => void qc.invalidateQueries({ queryKey: ["notifications"] }), { fallbackMs: 180_000 });
  const items = q.data?.pages.flatMap(p => p.items) ?? [];
  const unread = q.data?.pages[q.data.pages.length - 1]?.unread ?? 0;

  async function open(n: Notification) {
    if (!n.readAt) await api(`/me/notifications/${n.id}/read`, { method: "POST" }).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: ["notifications"] });
    if (!n.link) return;
    const inside = internalLink(n.link);
    if (inside) navigate(inside);
    else location.assign(n.link);
  }
  return (
    <>
      <PageHeading
        eyebrow="Your inbox"
        title="Notifications"
        subtitle="Updates for you: parcels, tickets, approvals and alerts. Click one to open it."
        actions={
          <Button
            disabled={!unread}
            onClick={async () => {
              await api("/me/notifications/read-all", { method: "POST" }).catch(toastError);
              void qc.invalidateQueries({ queryKey: ["notifications"] });
            }}
          >
            Mark all as read
          </Button>
        }
      />
      <Panel title={filter === "unread" ? "Unread" : "All notifications"} subtitle={`${unread} unread · newest first`}>
        <div style={{ padding: "12px 16px 10px" }}>
          <Tabs
            label="Show"
            value={filter}
            onChange={setFilter}
            tabs={[
              { id: "all", label: "All" },
              { id: "unread", label: `Unread${unread ? ` (${unread > 99 ? "99+" : unread})` : ""}` },
            ]}
          />
        </div>
        {q.isLoading ? (
          <Loading rows={5} />
        ) : items.length ? (
          <div className="notification-list">
            {items.map(n => (
              <button key={n.id} type="button" className={`notification-item${n.readAt ? "" : " unread"}`} onClick={() => void open(n)}>
                <span style={{ display: "grid", gap: 2, minWidth: 0, flex: 1 }}>
                  <strong>{n.title}</strong>
                  {n.body ? <small className="faint">{n.body}</small> : null}
                </span>
                <time dateTime={n.createdAt} title={new Date(n.createdAt).toLocaleString()} className="faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                  {ago(n.createdAt)}
                </time>
              </button>
            ))}
          </div>
        ) : (
          <p className="faint" style={{ padding: "12px 16px 18px", margin: 0 }}>
            {q.error ? describe(q.error) : filter === "unread" ? "No unread notifications." : "No notifications yet. Updates about your work appear here."}
          </p>
        )}
        {q.hasNextPage ? (
          <div style={{ padding: "10px 16px 16px", textAlign: "center" }}>
            <Button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              Load more
            </Button>
          </div>
        ) : null}
      </Panel>
    </>
  );
}
