import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_EVENTS } from "./events";
import { COMMON_VARS, EVENT_CATALOG, EVENT_GROUPS, channelsOf, definitionOf, type Channel } from "./catalog";
import { htmlFromText, placeholders, syntaxProblem } from "./render";

/**
 * Every message the code can send must be listed (and editable) in super admin → Global
 * notifications: this scans the source for NotifyService calls and checks each event they send
 * against the catalog (entry, group, audience, variables with samples, a default template for
 * every channel the code sends on).
 */

const SRC = join(__dirname, "..", "..");
const EVENT_KEY = /^[a-z]+(?:\.[a-z_]+)+$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Index of the bracket closing the one at `open` (string contents are skipped). */
function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return text.length;
}

/** The text of a top-level property value inside an object/argument list (until , or the end). */
function valueAt(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return text.slice(from, i);
      depth--;
    } else if (c === "," && depth === 0) return text.slice(from, i);
    else if (c === '"' || c === "'" || c === "`") i = closingQuote(text, i);
  }
  return text.slice(from);
}
function closingQuote(text: string, at: number) {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === text[at]) return i;
  }
  return text.length;
}

/** A template without its {{#var}}…{{/var}} sections (what always renders). */
function withoutSections(template: string) {
  let out = template;
  for (let i = 0; i < 5; i++) out = out.replace(/\{\{#\s*(\w+)\s*\}\}[\s\S]*?\{\{\/\s*\1\s*\}\}/g, "");
  return out;
}
const withoutStrings =(text: string) => text.replace(/"[^"\\]*"|'[^'\\]*'/g, '""');
const literals = (text: string) => [...text.matchAll(/"([^"\\]*)"/g)].map(m => m[1]).filter(s => EVENT_KEY.test(s));

/** Event keys a variable may hold, from its declaration in the same file. */
function resolveIdentifier(file: string, name: string, declarationOnly = false): string[] {
  const found = new Set<string>();
  // `event: "a" | "b"` (parameter or property with a literal union), `event: NotificationEvent = "x"`.
  if (!declarationOnly) {
    for (const m of file.matchAll(new RegExp(`\\b${name}\\??\\s*:\\s*((?:"[^"]+"\\s*\\|?\\s*)+)`, "g"))) literals(m[1]).forEach(e => found.add(e));
    for (const m of file.matchAll(new RegExp(`\\b${name}\\s*:\\s*NotificationEvent\\s*=\\s*"([^"]+)"`, "g"))) found.add(m[1]);
  }
  // `const NAME[: type] = { … }` / `= cond ? MAP[x] : …`: every event key in the initializer (and in maps it reads).
  const decl = new RegExp(`(?:const|let)\\s+${name}\\b[^=]*=\\s*`, "g").exec(file);
  if (decl) {
    const start = decl.index + decl[0].length;
    const init = file[start] === "{" ? file.slice(start, closing(file, start) + 1) : valueAt(file, start).split(";")[0];
    literals(init).forEach(e => found.add(e));
    // Other maps it reads (not object keys such as `DELIVERED: …`).
    for (const ref of withoutStrings(init).match(/\b[A-Z][A-Z_]+\b(?!\s*:)/g) ?? []) if (ref !== name) resolveIdentifier(file, ref, true).forEach(e => found.add(e));
  }
  return [...found];
}

interface Send {
  where: string;
  events: string[];
  channels: Channel[] | null;
  vars: string[];
  /** The vars object is a literal without spreads, so `vars` is everything the call passes. */
  complete: boolean;
}

/** Every NotifyService.notify / notifyNow call in the API source and what it sends. */
function scanSends(): Send[] {
  const sends: Send[] = [];
  for (const path of sourceFiles(SRC)) {
    const rel = relative(SRC, path).replace(/\\/g, "/");
    if (rel === "modules/notifications/events.ts" || rel === "modules/notifications/catalog.ts") continue;
    const file = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    for (const call of file.matchAll(/\.(?:notify|notifyNow)\(/g)) {
      const open = call.index! + call[0].length - 1;
      const args = file.slice(open + 1, closing(file, open));
      const eventProp = /(?:^|[{,\s])event\s*(:|,|\n|\})/.exec(args);
      const spreads = [...args.matchAll(/\.\.\.\s*([a-zA-Z_]\w*)/g)].map(m => m[1]);
      if (!eventProp && !spreads.length) continue; // another class's notify(), e.g. OtpService.notify(phone, purpose)
      const events = new Set<string>();
      if (eventProp) {
        const expr = eventProp[1] === ":" ? valueAt(args, eventProp.index! + eventProp[0].length) : "event";
        literals(expr).forEach(e => events.add(e));
        for (const id of withoutStrings(expr).match(/\b[a-zA-Z_]\w*\b/g) ?? []) if (!["to", "from", "true", "false", "null", "undefined"].includes(id)) resolveIdentifier(file, id).forEach(e => events.add(e));
      }
      for (const spread of spreads) resolveIdentifier(file, spread).forEach(e => events.add(e));
      if (!eventProp && !events.size) continue;
      const channelsText = /channels\s*:\s*\[([^\]]*)\]/.exec(args)?.[1];
      const varsAt = /vars\s*:\s*\{/.exec(args);
      let vars: string[] = [];
      const hasVars = /(?:^|[{,\s])vars\s*(?::|,|\n|\})/.test(args);
      let complete = !hasVars;
      if (varsAt) {
        const start = varsAt.index + varsAt[0].length - 1;
        const body = args.slice(start + 1, closing(args, start));
        // Top-level keys: `key: value` or shorthand `key` (spreads are conditional extras and are skipped).
        for (let at = 0; at < body.length; ) {
          const entry = valueAt(body, at);
          at += entry.length + 1;
          const key = /^\s*([a-zA-Z_]\w*)\s*(?::|$)/.exec(entry)?.[1];
          if (key) vars.push(key);
        }
        vars = [...new Set(vars)];
        complete = !body.includes("...");
      }
      sends.push({
        where: `${rel}:${file.slice(0, call.index).split("\n").length}`,
        events: [...events],
        channels: channelsText ? ([...channelsText.matchAll(/"(sms|email)"/g)].map(m => m[1]) as Channel[]) : null,
        vars,
        complete,
      });
    }
  }
  return sends;
}

describe("notification catalog", () => {
  const sends = scanSends();

  it("finds the NotifyService calls and the events they send", () => {
    expect(sends.length).toBeGreaterThan(30);
    const unresolved = sends.filter(s => !s.events.length).map(s => s.where);
    // Send events as literals (or from a map / literal-union parameter in the same file) so this test can see them.
    expect(unresolved, "NotifyService calls whose events can't be determined").toEqual([]);
  });

  it("has a catalog entry and a default template for every channel of every event the code sends", () => {
    const problems: string[] = [];
    for (const send of sends)
      for (const event of send.events) {
        const def = definitionOf(event);
        if (!def) {
          problems.push(`${send.where}: "${event}" is not in notifications/events.ts + catalog.ts`);
          continue;
        }
        const channels = channelsOf(def);
        for (const channel of send.channels ?? channels) if (!channels.includes(channel)) problems.push(`${send.where}: "${event}" is sent by ${channel} but has no ${channel} template`);
        const known = new Set<string>([...def.vars, ...COMMON_VARS]);
        for (const v of send.vars) if (!known.has(v)) problems.push(`${send.where}: "${event}" gets {{${v}}}, which isn't in its variable list (admins couldn't use it)`);
        // Placeholders the default texts always show (outside {{#optional}} sections) must be passed.
        if (send.complete)
          for (const channel of (send.channels ?? channels).filter(c => channels.includes(c))) {
            const texts = channel === "sms" ? [def.sms!] : [def.email!.subject, def.email!.text];
            const needed = texts.flatMap(t => placeholders(withoutSections(t))).filter(v => !(COMMON_VARS as readonly string[]).includes(v));
            for (const v of new Set(needed)) if (!send.vars.includes(v)) problems.push(`${send.where}: "${event}" ${channel} text shows {{${v}}} but the call doesn't pass it`);
          }
      }
    expect(problems).toEqual([]);
  });

  it("sends SMS and email only through NotifyService", () => {
    const bypass: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const rel = relative(SRC, path).replace(/\\/g, "/");
      if (rel.startsWith("modules/notifications/") || rel.startsWith("seed/")) continue;
      const file = readFileSync(path, "utf8");
      if (/outboxMessage\.create|outbox\.queue\(|\.queue\(\s*\w+\s*,\s*\{\s*channel\s*:|sendSms\(|sendEmail\(/.test(file)) bypass.push(rel);
    }
    expect(bypass, "files writing SMS/email around NotifyService").toEqual([]);
  });

  it("lists only events the code actually sends", () => {
    const sent = new Set(sends.flatMap(s => s.events));
    expect(NOTIFICATION_EVENTS.filter(e => !sent.has(e)), "catalog events nothing sends").toEqual([]);
  });

  it("describes every event fully: name, group, audience, variables with samples, valid default texts", () => {
    const problems: string[] = [];
    for (const event of NOTIFICATION_EVENTS) {
      const def = EVENT_CATALOG[event];
      const p = (message: string) => problems.push(`${event}: ${message}`);
      if (!def) {
        p("missing from the catalog");
        continue;
      }
      if (!def.label?.trim()) p("no name");
      if (!(EVENT_GROUPS as readonly string[]).includes(def.group)) p(`unknown group "${def.group}"`);
      if (!def.audience?.trim()) p("no audience");
      const channels = channelsOf(def);
      if (!channels.length) p("no SMS or email template");
      for (const v of def.vars) if (def.sample[v] === undefined) p(`variable {{${v}}} has no sample value`);
      for (const v of def.required ?? []) if (!def.vars.includes(v)) p(`required {{${v}}} isn't a variable`);
      const allowed = new Set<string>([...def.vars, ...COMMON_VARS]);
      const texts: [string, string | undefined][] = [
        ["SMS", def.sms],
        ["email subject", def.email?.subject],
        ["email text", def.email?.text],
        ["email HTML", def.email ? (def.email.html ?? htmlFromText(def.email.text)) : undefined],
      ];
      for (const [label, text] of texts) {
        if (text === undefined) continue;
        if (!text.trim()) p(`empty ${label}`);
        const problem = syntaxProblem(text);
        if (problem) p(`${label}: ${problem}`);
        const unknown = placeholders(text).filter(v => !allowed.has(v));
        if (unknown.length) p(`${label} uses unknown ${unknown.map(v => `{{${v}}}`).join(", ")}`);
      }
      for (const v of def.required ?? []) {
        if (def.sms !== undefined && !placeholders(def.sms).includes(v)) p(`SMS must include {{${v}}}`);
        if (def.email && !placeholders(def.email.text).includes(v)) p(`email text must include {{${v}}}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps OTP, MFA and password messages switched on (security messages)", () => {
    const security = NOTIFICATION_EVENTS.filter(e => /^auth\.(otp\.|mfa_|password)/.test(e) || e === "parcel.delivery_code" || e === "guest.booking_verification");
    expect(security.length).toBeGreaterThan(6);
    for (const e of security) expect(EVENT_CATALOG[e].mandatory, e).toBe(true);
  });
});
