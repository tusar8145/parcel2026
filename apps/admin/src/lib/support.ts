/**
 * Support access ("view as", POST /admin/impersonations): a NEW TAB opens the user's panel with `?support-access=1`;
 * that page (legacy/shared/api.js) collects the short-lived token once through window.opener.DF.takeSupportAccess() —
 * never through storage or the URL. This tab's own session is untouched (shared/api.js DF.startSupportAccess).
 */
import { api } from "@panel/lib/api";

interface StartResult {
  impersonation: { id: string };
  user: { id: string; name: string; panel?: string };
  accessToken: string;
  expiresIn: number;
}

let handoff: { id: string; userId: string; accessToken: string; expiresAt: number } | null = null;
const w = window as unknown as { DF?: Record<string, unknown> };
w.DF = { ...(w.DF ?? {}), takeSupportAccess: () => ((value => ((handoff = null), value))(handoff)) };

export async function startSupportAccess(body: Record<string, unknown>, tab: Window | null) {
  try {
    const result = await api<StartResult>("/admin/impersonations", { method: "POST", body });
    handoff = { id: result.impersonation.id, userId: result.user.id, accessToken: result.accessToken, expiresAt: Date.now() + result.expiresIn * 1000 - 5000 };
    setTimeout(() => (handoff = null), 60_000);
    const [path, hash = ""] = (result.user.panel || "/").split("#");
    const url = `${path}${path.includes("?") ? "&" : "?"}support-access=1${hash ? `#${hash}` : ""}`;
    if (tab && !tab.closed) tab.location.href = url;
    return { ...result, opened: !!(tab && !tab.closed) };
  } catch (error) {
    tab?.close();
    throw error;
  }
}
