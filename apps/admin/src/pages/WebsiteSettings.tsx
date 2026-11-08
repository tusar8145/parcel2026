/**
 * Website & branding (bridge-website.js + bridge-branding.js), in tabs:
 *   Company & branding       name, legal name, tagline, website, logo, tab icon, contact, social links (GET / PUT /branding)
 *   Signups & booking        merchant, rider, franchise and customer sign-up, and "Send a parcel" (PUT /website)
 *   About · Privacy · Terms  the pages' text (About: PUT /branding { about }; the others PUT /website)
 *   FAQs                     add, edit, reorder and remove questions
 * Every save clears the public pages' cache (POST /site-cache), so the website shows it at once.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, currentToken, describe } from "@panel/lib/api";
import { Button, Loading, PageHeading, Panel } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";

const TABS: [string, string][] = [
  ["company", "Company & branding"],
  ["signups", "Signups & booking"],
  ["about", "About Us"],
  ["privacy", "Privacy Policy"],
  ["terms", "Terms of Service"],
  ["faqs", "FAQs"],
];
const SWITCHES: [string, string, string][] = [
  ["merchant", "Become a merchant", "The merchant application on the website."],
  ["rider", "Apply as a rider", "The rider application on the website."],
  ["franchise", "Become a franchise partner", "The franchise application on the website."],
  ["customer", "Website customer signup & login", "New customer accounts and customer sign-in. Staff, merchants, riders and franchises always sign in."],
];
const FORMAT = "A blank line starts a new block. “## ” makes a heading, “- ” a list item, “1. ” a numbered item.";

interface PageText {
  title: string;
  intro: string;
  body: string;
}
interface Faq {
  id: string;
  question: string;
  answer: string;
}
interface Site {
  signups: Record<string, boolean>;
  sendParcel: boolean;
  about: PageText;
  privacy: PageText;
  terms: PageText;
  faqs: Faq[];
  defaults: Record<string, PageText>;
}

/** The website keeps cached pages: clear them so a change shows at once (shared/api.js DF.clearSiteCache). */
async function clearSiteCache() {
  const token = currentToken();
  const response = await fetch("/site-cache", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error("Saved, but the website's cache could not be cleared. The change shows within 5 minutes.");
}

export default function WebsiteSettings() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get("section")) ? params.get("section")! : "company";
  const setTab = (k: string) =>
    setParams(
      p => {
        if (k === "company") p.delete("section");
        else p.set("section", k);
        return p;
      },
      { replace: true },
    );
  const site = useQuery({ queryKey: ["admin", "website"], queryFn: () => api<Site>("/website/admin") });
  return (
    <>
      <PageHeading eyebrow="Platform control · public website" title="Website & branding" subtitle="Your company, what the website offers, and its pages. Changes show on the website as soon as you save." />
      <div className="seg-tabs" role="tablist" aria-label="Website & branding" style={{ marginBottom: 14 }}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "company" ? (
        <Branding />
      ) : !site.data ? (
        site.error ? <div className="callout bad">{describe(site.error)}</div> : <Loading rows={6} />
      ) : tab === "signups" ? (
        <Signups site={site.data} />
      ) : tab === "faqs" ? (
        <Faqs site={site.data} />
      ) : (
        <PageForm key={tab} id={tab as "about" | "privacy" | "terms"} site={site.data} />
      )}
    </>
  );
}

function usePublish() {
  const qc = useQueryClient();
  return async (body: Record<string, unknown>, message: string) => {
    const saved = await api<Site>("/website", { method: "PUT", body });
    qc.setQueryData<Site>(["admin", "website"], old => ({ ...saved, defaults: old?.defaults ?? saved.defaults }));
    await clearSiteCache();
    toast(message, "good");
  };
}

function Signups({ site }: { site: Site }) {
  const publish = usePublish();
  const [busy, setBusy] = useState("");
  async function flip(key: string, on: boolean) {
    setBusy(key);
    const label = key === "sendParcel" ? "Send a parcel" : SWITCHES.find(s => s[0] === key)![1];
    try {
      await publish(key === "sendParcel" ? { sendParcel: on } : { signups: { [key]: on } }, `${label} is ${on ? "on" : "off"}.`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  const row = (key: string, label: string, hint: string, on: boolean) => (
    <label key={key} className="check" style={{ alignItems: "flex-start", padding: "12px 0", borderTop: "1px solid var(--line)" }}>
      <input type="checkbox" checked={on} disabled={busy === key} onChange={e => void flip(key, e.target.checked)} />
      <span>
        <strong style={{ display: "block" }}>{label}</strong>
        <span className="faint">{hint}</span>
      </span>
    </label>
  );
  return (
    <>
      <Panel title="Signups" subtitle="On by default. When one is off, its links leave the website and its page says it's closed.">
        <div className="panel-body" style={{ display: "grid", paddingTop: 0 }}>
          {SWITCHES.map(([k, l, h]) => row(k, l, h, !!site.signups[k]))}
        </div>
      </Panel>
      <div style={{ height: 14 }} />
      <Panel title="Booking" subtitle="Merchants and operations aren't affected.">
        <div className="panel-body" style={{ display: "grid", paddingTop: 0 }}>
          {row("sendParcel", "Send a parcel", "The website's booking for customers and guests.", site.sendParcel)}
        </div>
      </Panel>
    </>
  );
}

function PageForm({ id, site }: { id: "about" | "privacy" | "terms"; site: Site }) {
  const qc = useQueryClient();
  const publish = usePublish();
  const page = site[id];
  const [v, setV] = useState<PageText>({ title: page.title, intro: page.intro, body: page.body });
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    const body = { title: v.title.trim(), intro: v.intro.trim(), body: v.body.trim() };
    if (!body.title || !body.body) return toast("Enter the title and the text.", "bad");
    setBusy(true);
    try {
      if (id === "about") {
        await api("/branding", { method: "PUT", body: { about: body } });
        await clearSiteCache();
        qc.setQueryData<Site>(["admin", "website"], old => (old ? { ...old, about: body } : old));
        toast("About Us published.", "good");
      } else await publish({ [id]: body }, `${TABS.find(t => t[0] === id)![1]} published.`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel" style={{ padding: "16px 18px" }} onSubmit={e => void save(e)} noValidate>
      <div className="form-grid">
        <label className="field full">
          <span>Title</span>
          <input className="input" required maxLength={120} value={v.title} onChange={e => setV({ ...v, title: e.target.value })} />
        </label>
        <label className="field full">
          <span>Line under the title</span>
          <textarea className="textarea" rows={2} maxLength={400} value={v.intro} onChange={e => setV({ ...v, intro: e.target.value })} />
        </label>
        <label className="field full">
          <span>Text</span>
          <textarea className="textarea" rows={22} required maxLength={40000} value={v.body} onChange={e => setV({ ...v, body: e.target.value })} />
          <small>{id === "about" ? `${FORMAT} “### Title” with lines under it makes a card; “[100+] Hubs” a number tile.` : FORMAT}</small>
        </label>
      </div>
      <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        {id !== "about" ? (
          <Button
            onClick={() => {
              const o = site.defaults[id];
              setV({ title: o.title, intro: o.intro, body: o.body });
              toast("The original text is in the form. Save to publish it.");
            }}
          >
            Use the original text
          </Button>
        ) : null}
        <a className="button" href={`/${id}`} target="_blank" rel="noopener">
          View page
        </a>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Publishing…" : "Save and publish"}
        </Button>
      </div>
    </form>
  );
}

function Faqs({ site }: { site: Site }) {
  const publish = usePublish();
  const [faqs, setFaqs] = useState<Faq[]>(() => site.faqs.map(f => ({ ...f })));
  const [busy, setBusy] = useState(false);
  const last = useRef<HTMLInputElement>(null);
  const set = (i: number, patch: Partial<Faq>) => setFaqs(list => list.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: number) =>
    setFaqs(list => {
      const next = [...list];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });
  async function save(e: FormEvent) {
    e.preventDefault();
    if (faqs.some(f => !f.question.trim() || !f.answer.trim())) return toast("Fill in every question and answer, or remove the empty ones.", "bad");
    setBusy(true);
    try {
      await publish({ faqs }, "FAQs published.");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel" onSubmit={e => void save(e)} noValidate>
      <div className="panel-head">
        <div>
          <h2 className="panel-title">FAQs</h2>
          <p className="panel-subtitle">Shown on the home page, in this order.</p>
        </div>
        <div className="tools">
          <Button
            onClick={() => {
              setFaqs(list => [...list, { id: `faq-${Date.now().toString(36)}`, question: "", answer: "" }]);
              requestAnimationFrame(() => last.current?.focus());
            }}
          >
            Add a question
          </Button>
        </div>
      </div>
      <div className="panel-body">
        {faqs.map((f, i) => (
          <article key={f.id} style={{ display: "grid", gap: 8, padding: "12px 0", borderTop: i ? "1px solid var(--line)" : undefined }}>
            <label className="field">
              <span>Question</span>
              <input ref={i === faqs.length - 1 ? last : undefined} className="input" maxLength={200} required value={f.question} onChange={e => set(i, { question: e.target.value })} />
            </label>
            <label className="field">
              <span>Answer</span>
              <textarea className="textarea" rows={3} maxLength={2000} required value={f.answer} onChange={e => set(i, { answer: e.target.value })} />
            </label>
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" aria-label="Move up" disabled={!i} onClick={() => move(i, -1)}>
                ▲
              </Button>
              <Button size="sm" aria-label="Move down" disabled={i === faqs.length - 1} onClick={() => move(i, 1)}>
                ▼
              </Button>
              <Button size="sm" onClick={() => setFaqs(list => list.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          </article>
        ))}
        {!faqs.length ? <p className="faint">No questions yet.</p> : null}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Publishing…" : "Save and publish"}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ───────────── Company & branding ─────────────
interface Branding {
  companyName: string;
  legalName: string;
  tagline: string;
  website: string;
  logoUrl?: string | null;
  iconUrl: string;
  contact: { phone?: string; email?: string; address?: string; hours?: string };
  social: { facebook?: string; instagram?: string; linkedin?: string; youtube?: string; whatsapp?: string };
  about?: { intro?: string; body?: string };
  defaults?: { about?: { intro?: string; body?: string } };
}
const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico";
const LIMITS = { logo: 400 * 1024, icon: 100 * 1024 };

function Branding() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "branding"], queryFn: () => api<Branding>("/branding") });
  const [v, setV] = useState<Record<string, string> | null>(null);
  // An uploaded image waiting to be saved: a data URL, null = remove, undefined = unchanged.
  const [img, setImg] = useState<{ logo?: string | null; icon?: string | null }>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const picking = useRef<"logo" | "icon">("logo");
  useEffect(() => {
    const b = q.data;
    if (!b || v) return;
    setV({
      brName: b.companyName,
      brLegal: b.legalName === b.companyName ? "" : b.legalName,
      brTagline: b.tagline,
      brWebsite: b.website,
      brPhone: b.contact?.phone ?? "",
      brEmail: b.contact?.email ?? "",
      brAddress: b.contact?.address ?? "",
      brHours: b.contact?.hours ?? "",
      brFacebook: b.social?.facebook ?? "",
      brInstagram: b.social?.instagram ?? "",
      brLinkedin: b.social?.linkedin ?? "",
      brYoutube: b.social?.youtube ?? "",
      brWhatsapp: b.social?.whatsapp ?? "",
    });
  }, [q.data, v]);
  if (!q.data || !v) return q.error ? <div className="callout bad">{describe(q.error)}</div> : <Loading rows={6} />;
  const b = q.data;

  function pickFile(f?: File | null) {
    const which = picking.current;
    if (!f) return;
    if (f.size > LIMITS[which]) return toast(`The ${which === "logo" ? "logo" : "tab icon"} must be ${LIMITS[which] / 1024} KB or smaller.`, "bad");
    const reader = new FileReader();
    reader.onload = () => {
      // Browsers name .ico files differently; the API takes image/x-icon.
      const url = String(reader.result || "").replace(/^data:(application\/octet-stream|image\/ico|image\/vnd\.microsoft\.icon);/, "data:image/x-icon;");
      if (!/^data:image\/(png|jpeg|webp|svg\+xml|x-icon);base64,/.test(url)) return toast("Use a PNG, JPEG, WebP or SVG image.", "bad");
      setImg(x => ({ ...x, [which]: url }));
    };
    reader.readAsDataURL(f);
  }
  function preview(which: "logo" | "icon") {
    const pending = img[which];
    const url = pending === undefined ? (which === "logo" ? b.logoUrl : b.iconUrl) : pending;
    const size = which === "logo" ? 72 : 40;
    const custom = pending === undefined ? (which === "logo" ? !!b.logoUrl : !String(b.iconUrl).endsWith("=default")) : pending !== null;
    const note = which === "logo" ? (url ? "Your logo, shown in every header." : "The current logo. Upload one to replace it.") : custom ? "Your icon." : "The default icon.";
    return (
      <div className="row" style={{ gap: 14 }}>
        {url ? (
          <img src={url} alt="" style={{ width: size, height: size, border: "1px solid var(--line)", borderRadius: 8, background: "#fff", objectFit: "contain", padding: 4 }} />
        ) : which === "logo" ? (
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" style={{ width: size, height: size, border: "1px solid var(--line)", borderRadius: 8, background: "#fff", objectFit: "contain", padding: 4 }} />
        ) : (
          <div style={{ width: size, height: size, border: "1px dashed var(--line)", borderRadius: 8, display: "grid", placeItems: "center", color: "#9aa4b2", fontSize: 11 }}>None</div>
        )}
        <div style={{ display: "grid", gap: 6 }}>
          <span className="faint" style={{ fontSize: 12 }}>
            {note}
            {pending !== undefined ? " (not saved yet)" : ""}
          </span>
          <div className="row" style={{ gap: 7 }}>
            <Button
              onClick={() => {
                picking.current = which;
                if (file.current) {
                  file.current.value = "";
                  file.current.click();
                }
              }}
            >
              Upload…
            </Button>
            {custom ? <Button onClick={() => setImg(x => ({ ...x, [which]: null }))}>{which === "logo" ? "Remove" : "Use default"}</Button> : null}
          </div>
        </div>
      </div>
    );
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    const t = (k: string) => (v![k] ?? "").trim();
    const out = { brName: t("brName").length >= 2 ? "" : "Enter the company name.", brEmail: !t("brEmail") || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t("brEmail")) ? "" : "Enter a valid email." };
    setErrors(out);
    if (Object.values(out).some(Boolean)) return;
    const body = {
      companyName: t("brName"),
      legalName: t("brLegal"),
      tagline: t("brTagline"),
      website: t("brWebsite"),
      contact: { phone: t("brPhone"), email: t("brEmail"), address: t("brAddress"), hours: t("brHours") },
      social: { facebook: t("brFacebook"), instagram: t("brInstagram"), linkedin: t("brLinkedin"), youtube: t("brYoutube"), whatsapp: t("brWhatsapp") },
      ...(img.logo !== undefined ? { logo: img.logo } : {}),
      ...(img.icon !== undefined ? { icon: img.icon } : {}),
    };
    setBusy(true);
    try {
      const saved = await api<Branding>("/branding", { method: "PUT", body });
      qc.setQueryData(["admin", "branding"], saved);
      await clearSiteCache().catch(() => undefined); // the website's cached pages show the company too
      setImg({});
      try {
        localStorage.setItem("df.branding.v1", JSON.stringify(saved));
      } catch {
        /* storage blocked */
      }
      toast("Company & branding saved. Reload a page to see it there.", "good");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  const field = (k: string, label: string, opts: { type?: string; placeholder?: string; hint?: string; full?: boolean; area?: boolean; required?: boolean } = {}) => (
    <label className={`field${opts.full ? " full" : ""}`}>
      <span>{label}</span>
      {opts.area ? (
        <textarea className="textarea" rows={2} value={v[k]} placeholder={opts.placeholder} onChange={e => setV({ ...v, [k]: e.target.value })} />
      ) : (
        <input className="input" type={opts.type || "text"} value={v[k]} placeholder={opts.placeholder} required={opts.required} onChange={e => setV({ ...v, [k]: e.target.value })} aria-invalid={!!errors[k]} />
      )}
      {errors[k] ? <span className="error">{errors[k]}</span> : opts.hint ? <small>{opts.hint}</small> : null}
    </label>
  );
  return (
    <form onSubmit={e => void save(e)} noValidate>
      <div className="grid-2" style={{ alignItems: "start" }}>
        <Panel title="Company" subtitle="Shown in headers, page and tab titles, messages and PDFs">
          <div className="panel-body form-grid">
            {field("brName", "Company name", { required: true, hint: "Replaces “Delivery Fast” everywhere it shows." })}
            {field("brLegal", "Legal name", { placeholder: "Same as the company name", hint: "On invoices and statements." })}
            {field("brTagline", "Tagline", { full: true })}
            {field("brWebsite", "Website", { type: "url", placeholder: "https://", full: true })}
          </div>
        </Panel>
        <Panel title="Logo & tab icon" subtitle="PNG, JPEG, WebP or SVG (ICO for the icon). Square images look best.">
          <div className="panel-body" style={{ display: "grid", gap: 16 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                Logo <span className="faint" style={{ fontWeight: 400 }}>· up to 400 KB</span>
              </div>
              {preview("logo")}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                Browser tab icon <span className="faint" style={{ fontWeight: 400 }}>· up to 100 KB, 64×64 or larger</span>
              </div>
              {preview("icon")}
            </div>
            <input ref={file} type="file" accept={IMAGE_TYPES} hidden onChange={e => pickFile(e.target.files?.[0])} />
          </div>
        </Panel>
        <Panel title="Contact" subtitle="Website footer, contact links, help text">
          <div className="panel-body form-grid">
            {field("brPhone", "Phone")}
            {field("brEmail", "Email", { type: "email" })}
            {field("brAddress", "Address", { full: true, area: true })}
            {field("brHours", "Opening hours", { full: true, placeholder: "e.g. Sat–Thu, 9am–8pm" })}
          </div>
        </Panel>
        <Panel title="Social links" subtitle="Full addresses (https://…); empty ones are not shown">
          <div className="panel-body form-grid">
            {field("brFacebook", "Facebook", { type: "url", placeholder: "https://facebook.com/…" })}
            {field("brInstagram", "Instagram", { type: "url", placeholder: "https://instagram.com/…" })}
            {field("brLinkedin", "LinkedIn", { type: "url", placeholder: "https://linkedin.com/…" })}
            {field("brYoutube", "YouTube", { type: "url", placeholder: "https://youtube.com/…" })}
            {field("brWhatsapp", "WhatsApp", { type: "url", placeholder: "https://wa.me/8801…", full: true })}
          </div>
        </Panel>
      </div>
      <p className="faint" style={{ margin: "14px 0 0" }}>
        The About page's text is in the About Us tab.
      </p>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save branding"}
        </Button>
      </div>
      <p className="faint" style={{ margin: "6px 0 0", textAlign: "right" }}>
        Pages show the change within a minute. The mobile apps' names and icons are set when the apps are built.
      </p>
    </form>
  );
}
