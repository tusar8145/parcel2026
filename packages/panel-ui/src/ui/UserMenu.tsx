/** The signed-in person at the right end of a panel's top bar: their role and hubs (`lines`) and Sign out (skin.css). */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../lib/auth";
import { confirm } from "./dialogs";
import { Icon } from "./Icon";

export function UserMenu({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { user, logout } = useAuth();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest?.(".user-menu, .user-menu-button") && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const shut = () => setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", shut);
    };
  }, [open]);
  const initials = (user?.name || "?")
    .split(/\s+/)
    .map(p => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const signOut = async () => {
    setOpen(false);
    if (await confirm({ title: "Sign out?", message: `Sign out ${user?.name ?? "this account"} on this device?`, ok: "Sign out" })) await logout();
  };
  const rect = button.current?.getBoundingClientRect();
  return (
    <>
      <button ref={button} type="button" className="user-menu-button" aria-haspopup="dialog" aria-expanded={open} aria-label={`Your account: ${user?.name ?? ""}`} title={user?.name} onClick={() => setOpen(o => !o)}>
        <span className="avatar" aria-hidden="true">{initials}</span>
        <span className="user-menu-name">{user?.name}</span>
      </button>
      {open && rect
        ? createPortal(
            <div className="menu user-menu" role="dialog" aria-label="Your account" style={{ top: rect.bottom + 8, right: Math.max(12, document.documentElement.clientWidth - rect.right), width: "min(270px, calc(100vw - 24px))" }}>
              <div className="user-menu-head">
                <span className="avatar" aria-hidden="true">{initials}</span>
                <span>
                  <strong>{user?.name}</strong>
                  {lines.filter(Boolean).map(l => (
                    <small key={l}>{l}</small>
                  ))}
                </span>
              </div>
              <div className="menu-sep" />
              <button type="button" className="menu-item" onClick={() => void signOut()}>
                <Icon name="logout" />
                <span>Sign out</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
