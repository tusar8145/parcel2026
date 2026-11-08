/**
 * Sign-in state. On start the session is restored from the refresh cookie. Each panel decides who may open it
 * (Operations: OPS_ROLES in apps/ops). The API still decides every action.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { authApi, onSessionChange, refresh, supportAccess, type SessionUser } from "./api";
import { SupportBanner } from "../ui/SupportBanner";
import { events } from "./events";

type AuthState =
  | { status: "loading" }
  | { status: "offline" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: SessionUser };

interface AuthApi {
  state: AuthState;
  user: SessionUser | null;
  hasRole: (...roles: string[]) => boolean;
  logout: () => Promise<void>;
  retry: () => void;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  /** Signing out: the page goes to the website's sign-in, so the panel's own sign-in form must not flash first. */
  const leaving = useRef(false);
  /** Support access (a tab opened with "Log in as" / "view as"): who is being viewed, and why it ended. */
  const support = useRef(supportAccess());
  const viewed = useRef<string>("");
  const [ended, setEnded] = useState<string | null>(null);

  useEffect(() => {
    const off = onSessionChange(user => {
      if (leaving.current) return;
      if (support.current) {
        if (user) viewed.current = user.name;
        // Ended elsewhere (an administrator, or the time ran out): cover the page, never show a sign-in form here.
        else return void setEnded(e => e ?? `Viewing as ${viewed.current || "this account"} has ended.`);
      }
      setState(user ? { status: "signed-in", user } : { status: "signed-out" });
    });
    refresh()
      .then(user => setState(user ? { status: "signed-in", user } : { status: "signed-out" }))
      .catch(() => setState({ status: "offline" }));
    return off;
  }, [attempt]);

  // Support access ends when its time runs out.
  useEffect(() => {
    const s = support.current;
    if (!s) return;
    const t = setTimeout(() => {
      setEnded(`Viewing as ${viewed.current || "this account"} ended: the time ran out.`);
      void refresh().catch(() => null);
    }, Math.max(0, s.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, []);

  const user = state.status === "signed-in" ? state.user : null;
  useEffect(() => {
    if (user) events.start();
    else events.stop();
  }, [user]);

  const value: AuthApi = {
    state,
    user,
    hasRole: (...roles) => !!user && user.roles.some(r => roles.includes(r)),
    logout: async () => {
      if (support.current) {
        // Ends support access only (the administrator's own session stays); the tab closes.
        leaving.current = true;
        events.stop();
        await authApi.logout();
        return void setEnded(`Viewing as ${viewed.current || "this account"} has ended.`);
      }
      leaving.current = true;
      setState({ status: "loading" });
      events.stop();
      await authApi.logout();
      // Like the classic console: signing out goes to the website's sign-in page.
      location.assign("/login");
    },
    retry: () => setAttempt(n => n + 1),
  };
  return (
    <AuthContext.Provider value={value}>
      {ended ? null : children}
      {support.current ? <SupportBanner user={user} ended={ended} onEnd={() => void value.logout()} /> : null}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth outside AuthProvider");
  return value;
}
