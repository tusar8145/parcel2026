/**
 * Sign-in state. On start the session is restored from the refresh cookie; who may open the panel is the
 * same list as the legacy panel (PANEL_ROLES["courier-operation"]). The API still decides every action.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { authApi, onSessionChange, refresh, type SessionUser } from "./api";
import { events } from "./events";

export const OPS_ROLES = ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"];

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

  useEffect(() => {
    const off = onSessionChange(user => setState(user ? { status: "signed-in", user } : { status: "signed-out" }));
    refresh()
      .then(user => setState(user ? { status: "signed-in", user } : { status: "signed-out" }))
      .catch(() => setState({ status: "offline" }));
    return off;
  }, [attempt]);

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
      events.stop();
      await authApi.logout();
      // Like the classic console: signing out goes to the website's sign-in page.
      location.assign("/login");
    },
    retry: () => setAttempt(n => n + 1),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth outside AuthProvider");
  return value;
}
