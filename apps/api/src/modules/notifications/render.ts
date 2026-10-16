/**
 * Minimal, logic-less templates: {{var}} and sections {{#var}}…{{/var}} (rendered when var is
 * set and not "0"/0/false). Unknown placeholders render empty. No code execution, no nesting
 * of the same section name.
 */
export type Vars = Record<string, string | number | boolean | null | undefined>;

const SECTION = /\{\{#\s*([a-zA-Z][\w]*)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g;
const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g;

const present = (v: Vars[string]) => v !== undefined && v !== null && v !== "" && v !== false && v !== 0 && v !== "0";

export function render(template: string, vars: Vars, escape: (s: string) => string = s => s): string {
  let out = template;
  // Sections can contain placeholders and other sections; resolve innermost-first.
  for (let i = 0; i < 5 && /\{\{\s*#/.test(out); i++) {
    const next = out.replace(SECTION, (_, name: string, inner: string) => (present(vars[name]) ? inner : ""));
    if (next === out) break;
    out = next;
  }
  return out.replace(PLACEHOLDER, (_, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? "" : escape(String(v));
  });
}

/** Placeholder and section names a template uses. */
export function placeholders(template: string): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*[#/]?\s*([a-zA-Z][\w]*)\s*\}\}/g)) names.add(m[1]);
  return [...names];
}

/** Checks {{#x}} … {{/x}} pairs are balanced. Returns a problem or null. */
export function syntaxProblem(template: string): string | null {
  const stack: string[] = [];
  for (const m of template.matchAll(/\{\{\s*([#/])\s*([a-zA-Z][\w]*)\s*\}\}/g)) {
    if (m[1] === "#") stack.push(m[2]);
    else if (stack.pop() !== m[2]) return `Section {{/${m[2]}}} doesn't match an open {{#${m[2]}}}`;
  }
  if (stack.length) return `Section {{#${stack[stack.length - 1]}}} is never closed`;
  const stray = template.replace(/\{\{\s*[#/]?\s*[a-zA-Z][\w]*\s*\}\}/g, "");
  if (/\{\{|\}\}/.test(stray)) return "Placeholders look like {{name}}";
  return null;
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Default HTML for an email body: paragraphs from the text, links clickable. Placeholders survive. */
export function htmlFromText(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+|\{\{\s*(?:link|trackingUrl|appUrl)\s*\}\})/g, '<a href="$1">$1</a>')}</p>`)
    .join("\n");
}

/** Wraps the rendered HTML body in the email layout (not editable). */
export function emailLayout(bodyHtml: string, opts: { appName: string; appUrl: string; support: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f7f5;font-family:Arial,Helvetica,sans-serif;color:#1d2b26">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f5;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0f3d2e;padding:18px 24px;color:#ffffff;font-size:20px;font-weight:bold">${escapeHtml(opts.appName)}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.55">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e4ebe7;font-size:12px;color:#5d6f6a">${escapeHtml(opts.appName)} · <a href="${escapeHtml(opts.appUrl)}" style="color:#5d6f6a">${escapeHtml(opts.appUrl.replace(/^https?:\/\//, ""))}</a> · ${escapeHtml(opts.support)}</td></tr>
</table></td></tr></table></body></html>`;
}

/** SMS segment info: GSM-7 (160/153) unless a character needs UCS-2 (70/67). */
export function smsSegments(text: string): { encoding: "GSM-7" | "UCS-2"; length: number; segments: number } {
  const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
  if (GSM.test(text)) {
    const length = [...text].reduce((n, c) => n + ("^{}\\[~]|€".includes(c) ? 2 : 1), 0);
    return { encoding: "GSM-7", length, segments: length <= 160 ? 1 : Math.ceil(length / 153) };
  }
  const length = text.length;
  return { encoding: "UCS-2", length, segments: length <= 70 ? 1 : Math.ceil(length / 67) };
}
