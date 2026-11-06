/**
 * The company the platform runs for (white label): its name, logo, browser tab icon, contact details and About
 * text. Super admin › Branding & company edits them (GET/PUT /branding); the website, every panel, PDFs and
 * messages use them. These defaults are Delivery Fast's own details: a new installation changes them there.
 */
export interface Branding {
  /** "Delivery Fast": shown in headers, page titles, messages, PDFs. */
  companyName: string;
  /** The registered name on invoices and statements (default: the company name). */
  legalName: string;
  /** One line under the name (website, emails). */
  tagline: string;
  /** The public website, e.g. https://deliveryfast.com.bd */
  website: string;
  contact: { phone: string; email: string; address: string; hours: string };
  social: { facebook: string; instagram: string; linkedin: string; youtube: string; whatsapp: string };
  /** The website's /about page: its title, the line under it and the text (ABOUT_FORMAT). */
  about: { title: string; intro: string; body: string };
}

/** How the About text is written (shown under the editor in Super admin › Branding & company). */
export const ABOUT_FORMAT =
  "A blank line starts a new block. “## ” makes a heading; “### Title” with lines under it makes a card (cards next to each other sit side by side); “[2024] Incorporated” makes a number tile; “- ” a bullet and “1. ” a numbered item; other lines are paragraphs.";

/** Delivery Fast's own About page, the text the website shipped with (about-default.ts). */
export { DEFAULT_ABOUT_BODY } from "./about-default";
import { DEFAULT_ABOUT_BODY } from "./about-default";

export const DEFAULT_BRANDING: Branding = {
  companyName: "Delivery Fast",
  legalName: "Delivery Fast",
  tagline: "Fast, tracked parcel delivery across Bangladesh",
  website: "https://deliveryfast.com.bd",
  contact: { phone: "01969 921122", email: "info@deliveryfast.com.bd", address: "House-6 Road -2A Banani, Dhaka-1213", hours: "" },
  social: { facebook: "", instagram: "", linkedin: "", youtube: "", whatsapp: "" },
  about: {
    title: "About Delivery Fast",
    intro: "A nationwide courier and logistics service with its own hubs, franchisees, agents and retailers across Bangladesh.",
    body: DEFAULT_ABOUT_BODY,
  },
};

export type AboutBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "cards"; items: { title: string; text: string[] }[] }
  | { kind: "tiles"; items: { value: string; label: string }[] };

/** Reads the About text (ABOUT_FORMAT) into the blocks the page draws. */
export function parseAbout(body: string): AboutBlock[] {
  const out: AboutBlock[] = [];
  const last = () => out[out.length - 1];
  for (const block of body.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    if (lines[0].startsWith("### ")) {
      const card = { title: lines[0].slice(4).trim(), text: lines.slice(1) };
      const prev = last();
      if (prev?.kind === "cards") prev.items.push(card);
      else out.push({ kind: "cards", items: [card] });
      continue;
    }
    for (const line of lines) {
      const prev = last();
      const tile = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
      const item = /^(?:([-*])|\d+[.)])\s+(.*)$/.exec(line);
      if (line.startsWith("## ")) out.push({ kind: "heading", text: line.slice(3).trim() });
      else if (tile) {
        const t = { value: tile[1].trim(), label: tile[2].trim() };
        if (prev?.kind === "tiles") prev.items.push(t);
        else out.push({ kind: "tiles", items: [t] });
      } else if (item) {
        const ordered = !item[1];
        if (prev?.kind === "list" && prev.ordered === ordered) prev.items.push(item[2]);
        else out.push({ kind: "list", ordered, items: [item[2]] });
      } else out.push({ kind: "paragraph", text: line });
    }
  }
  return out;
}

/** Replaces the default company name in a text (messages, PDFs) when the installation has its own. */
export function withCompanyName(text: string, companyName: string): string {
  if (!companyName || companyName === DEFAULT_BRANDING.companyName) return text;
  return text.replace(/Delivery Fast/g, companyName);
}
