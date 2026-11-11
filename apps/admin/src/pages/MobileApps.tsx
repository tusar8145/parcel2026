/**
 * Mobile apps: forced updates of the Android apps. The lowest version of each app (Operations, Rider, Merchant) that
 * may still be used; an older one stops working and shows its update page with the download link. Apps installed
 * before forced updates existed (Operations before 1.4.0, Rider before 1.5.1, Merchant before 1.4.2) don't send their
 * version and keep working. API: GET / PUT /app-versions.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { Button, Loading, PageHeading, Panel } from "@panel/ui/kit";
import { confirm } from "@panel/ui/dialogs";
import { toast, toastError } from "@panel/ui/toast";

type AppKey = "operations" | "rider" | "merchant";
interface AppRow {
  app: AppKey;
  minVersion: string | null;
  downloadUrl: string;
}
const NAME: Record<AppKey, string> = { operations: "Operations app", rider: "Rider app", merchant: "Merchant app" };
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export default function MobileApps() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "app-versions"], queryFn: () => api<AppRow[]>("/app-versions") });
  const [draft, setDraft] = useState<Record<AppKey, string>>({ operations: "", rider: "", merchant: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setDraft(Object.fromEntries(q.data.map(r => [r.app, r.minVersion ?? ""])) as Record<AppKey, string>);
  }, [q.data]);

  const rows = q.data ?? [];
  const bad = rows.filter(r => draft[r.app].trim() && !VERSION.test(draft[r.app].trim()));
  const changed = rows.filter(r => (draft[r.app].trim() || null) !== r.minVersion);

  async function save() {
    if (bad.length) return toast(`Use a version like 1.4.0 for the ${NAME[bad[0].app]}.`, "bad");
    const raised = changed.filter(r => draft[r.app].trim());
    if (
      raised.length &&
      !(await confirm({
        title: "Force these updates?",
        message: `${raised.map(r => `${NAME[r.app]}: below ${draft[r.app].trim()}`).join(" · ")} stop working at once and show the download link. Put the new APK on the website first.`,
        ok: "Force update",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await api("/app-versions", { method: "PUT", body: Object.fromEntries(changed.map(r => [r.app, draft[r.app].trim() || null])) });
      await qc.invalidateQueries({ queryKey: ["admin", "app-versions"] });
      toast("Saved. Apps check it within half a minute.", "good");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading eyebrow="Platform control" title="Mobile apps" subtitle="Force an update: an app older than its minimum version stops working and shows where to download the new one." />
      <Panel
        title="Minimum versions"
        subtitle="Empty: no minimum. Apps installed before forced updates existed (Operations before 1.4.0, Rider before 1.5.1, Merchant before 1.4.2) keep working whatever is set."
        footer={
          <Button variant="primary" disabled={busy || !changed.length} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        }
      >
        {q.isLoading ? (
          <Loading rows={3} />
        ) : q.isError ? (
          <div className="callout bad">{describe(q.error)}</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Minimum version</th>
                  <th>Download link (shown on the update page)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.app}>
                    <td className="strong">{NAME[r.app]}</td>
                    <td>
                      <input
                        className="input sm"
                        aria-label={`Minimum version of the ${NAME[r.app]}`}
                        placeholder="No minimum"
                        value={draft[r.app]}
                        onChange={e => setDraft({ ...draft, [r.app]: e.target.value })}
                        style={{ width: 130, ...(bad.includes(r) ? { borderColor: "var(--bad)" } : {}) }}
                      />
                    </td>
                    <td>
                      <a href={r.downloadUrl} target="_blank" rel="noreferrer">
                        {r.downloadUrl}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
