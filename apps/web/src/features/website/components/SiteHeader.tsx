"use client";

import { useEffect, useState } from "react";
import BrandMark from "./BrandMark";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default function SiteHeader({ legacy = false }: { legacy?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [customer, setCustomer] = useState(false);
  const closeMenu = () => {
    if (!legacy) setMenuOpen(false);
  };

  useEffect(() => {
    if (legacy) return;

    let active = true;
    const restoreCustomer = async () => {
      try {
        const response = await fetch("/api/v1/auth/refresh", {
          method: "POST",
          credentials: "same-origin",
          headers: { "x-df-client": "web" },
        });
        if (response.status === 401) return;
        if (!response.ok) throw new Error(`Session restore failed (${response.status})`);

        const result: unknown = await response.json();
        if (!isRecord(result) || !isRecord(result.user) || !Array.isArray(result.user.roles)) {
          throw new Error("Session restore returned an invalid user.");
        }
        const roles = result.user.roles;
        const panel = result.user.panel;
        if (!roles.every((role): role is string => typeof role === "string")) {
          throw new Error("Session restore returned invalid user roles.");
        }
        if (panel !== undefined && panel !== null && typeof panel !== "string") {
          throw new Error("Session restore returned an invalid panel.");
        }
        if (active) setCustomer(roles.includes("CUSTOMER") && (!panel || panel === "/account"));
      } catch (error) {
        if (active) console.error("Customer session could not be restored on the homepage.", error);
      }
    };
    void restoreCustomer();
    return () => {
      active = false;
    };
  }, [legacy]);

  return (
    <header className="header">
      {" "}
      <div className="shell nav">
        {" "}
        <a className="brand" href="/" aria-label="Paira Express home">
          <span className="brand-mark" style={{ width: 46, height: 46 }}>
            <BrandMark />
          </span>
          <span className="brand-word">
            {"delivery "}
            <span>fast</span>
          </span>
        </a>{" "}
        <nav className={`nav-links${!legacy && menuOpen ? " open" : ""}`} id="navLinks" aria-label="Main navigation" onClick={closeMenu}>
          <a href="#services">Services</a>
          <a href="/pricing" data-route="pricing">
            Pricing
          </a>
          <a href="#partners">Partner with us</a>
          <a href="#faq">Help</a>
          <a href="/about">About us</a>
          <a href="/signup" data-route="signup" style={{ color: "var(--green)", fontWeight: "750" }}>
            Sign up
          </a>
        </nav>{" "}
        <div className="nav-actions">
          <a className="button button-quiet" href={customer ? "/account" : "/login"} data-open={customer ? undefined : "login"}>
            {customer ? "My account" : "Log in"}
          </a>
          <a className="button button-primary" href="/request" data-open="request">
            {"Send a parcel "}
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 10h12m-5-5 5 5-5 5" />
            </svg>
          </a>
          <button
            className="menu-button"
            id="menuButton"
            aria-label="Open navigation"
            aria-expanded={!legacy && menuOpen}
            onClick={legacy ? undefined : () => setMenuOpen(open => !open)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>{" "}
      </div>{" "}
    </header>
  );
}
