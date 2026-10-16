import { Logger } from "@nestjs/common";

export interface SmsMessage {
  id: string;
  /** E.164, e.g. +8801712345678 */
  to: string;
  body: string;
}
export interface EmailMessage {
  id: string;
  to: string;
  toName?: string | null;
  subject: string;
  text: string;
  html: string;
}
export interface SendResult {
  id: string;
  ok: boolean;
  providerMessageId?: string;
  /** Raw (truncated) provider answer, kept for support. */
  providerResponse?: string;
  error?: string;
  /** The gateway rejected this message for good (invalid number, content rejected…): don't retry. */
  permanent?: boolean;
}

export interface SmsGateway {
  readonly name: string;
  sendSms(messages: SmsMessage[]): Promise<SendResult[]>;
}
export interface EmailGateway {
  readonly name: string;
  sendEmail(messages: EmailMessage[]): Promise<SendResult[]>;
}

/** The whole request failed (network, HTTP error, bad credentials). Every message is retried. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The gateway rejected a multi-message request for a reason tied to one message. */
class BatchRejected extends Error {}

const TIMEOUT_MS = 15_000;
const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s);
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
type Fetch = typeof fetch;

// ───────────────────────────── development: log only ─────────────────────────────

export class LogSmsGateway implements SmsGateway {
  readonly name = "log";
  private readonly logger = new Logger("SMS");
  async sendSms(messages: SmsMessage[]) {
    for (const m of messages) this.logger.log(`to ${m.to}: ${m.body}`);
    return messages.map(m => ({ id: m.id, ok: true }));
  }
}

export class LogEmailGateway implements EmailGateway {
  readonly name = "log";
  private readonly logger = new Logger("Email");
  async sendEmail(messages: EmailMessage[]) {
    for (const m of messages) this.logger.log(`to ${m.to}: ${m.subject}\n${m.text}`);
    return messages.map(m => ({ id: m.id, ok: true }));
  }
}

// ───────────────────────────── SMS: mram (msg.mram.com.bd) ─────────────────────────────

export interface MramConfig {
  apiKey: string;
  senderId: string;
  /** e.g. https://msg.mram.com.bd (the endpoint is <baseUrl>/smsapimany) */
  baseUrl: string;
}

/**
 * Status codes the mram API answers with (shared by most Bangladeshi SMS resellers on this
 * platform). Permanent ones are not retried.
 */
export const MRAM_ERRORS: Record<string, { message: string; permanent: boolean }> = {
  "1002": { message: "Sender ID / masking not found", permanent: false },
  "1003": { message: "API key not found", permanent: false },
  "1004": { message: "Message flagged as spam", permanent: true },
  "1005": { message: "Gateway internal error", permanent: false },
  "1006": { message: "Gateway internal error", permanent: false },
  "1007": { message: "Insufficient SMS balance", permanent: false },
  "1008": { message: "Message is empty", permanent: true },
  "1009": { message: "Message type not set", permanent: false },
  "1010": { message: "Invalid user or password", permanent: false },
  "1011": { message: "Invalid user id", permanent: false },
  "1012": { message: "Invalid number", permanent: true },
  "1013": { message: "API rate limit reached", permanent: false },
  "1014": { message: "No matching template", permanent: true },
  "1015": { message: "Message content rejected", permanent: true },
  "1016": { message: "IP address not allowed", permanent: false },
  "1019": { message: "SMS purpose missing", permanent: false },
};

/** "+8801712345678" → "8801712345678" (the gateway wants digits only). */
export const mramNumber = (e164: string) => e164.replace(/\D/g, "");

export class MramSmsGateway implements SmsGateway {
  readonly name = "mram";
  static readonly BATCH = 50;

  constructor(
    private readonly config: MramConfig,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  get endpoint() {
    return `${this.config.baseUrl.replace(/\/+$/, "")}/smsapimany`;
  }

  async sendSms(messages: SmsMessage[]): Promise<SendResult[]> {
    const results: SendResult[] = [];
    for (const batch of chunks(messages, MramSmsGateway.BATCH)) results.push(...(await this.sendBatch(batch)));
    return results;
  }

  private async sendBatch(batch: SmsMessage[]): Promise<SendResult[]> {
    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/plain, */*" },
        body: JSON.stringify({
          api_key: this.config.apiKey,
          senderid: this.config.senderId,
          messages: batch.map(m => ({ to: mramNumber(m.to), message: m.body })),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new GatewayError(`SMS gateway unreachable: ${(error as Error).message}`);
    }
    const text = (await response.text().catch(() => "")).trim();
    if (!response.ok) throw new GatewayError(`SMS gateway responded ${response.status}${text ? `: ${clip(text, 200)}` : ""}`, response.status);
    try {
      return parseMramResponse(text, batch);
    } catch (error) {
      // A permanent rejection for a multi-message request: find the bad message(s) one by one.
      if (error instanceof BatchRejected) {
        const results: SendResult[] = [];
        for (const m of batch) results.push(...(await this.sendBatch([m])));
        return results;
      }
      throw error;
    }
  }
}

/**
 * Accepts the shapes the gateway uses: plain text ("SMS SUBMITTED: ID - C2000…" or an error
 * code like "1007"), a JSON object for the whole request, or a JSON array with one entry per
 * message.
 */
export function parseMramResponse(text: string, batch: SmsMessage[]): SendResult[] {
  const raw = clip(text);
  /** A request-level answer. Permanent rejections of a multi-message batch are re-sent one by one by the caller. */
  const failAll = (code: string | undefined, fallback: string): SendResult[] => {
    const known = code ? MRAM_ERRORS[code] : undefined;
    const error = known ? `${code}: ${known.message}` : fallback;
    if (!known?.permanent) throw new GatewayError(error);
    if (batch.length > 1) throw new BatchRejected(error);
    return batch.map(m => ({ id: m.id, ok: false, error, permanent: true, providerResponse: raw }));
  };
  const idFrom = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
  const entryResult = (entry: unknown, m: SmsMessage): SendResult => {
    if (typeof entry !== "object" || entry === null) {
      const s = String(entry ?? "");
      const code = s.match(/\b(10\d\d)\b/)?.[1];
      if (code && MRAM_ERRORS[code]) return { id: m.id, ok: false, error: `${code}: ${MRAM_ERRORS[code].message}`, permanent: MRAM_ERRORS[code].permanent, providerResponse: clip(s) };
      return { id: m.id, ok: true, providerMessageId: s.match(/ID\s*-\s*(\S+)/i)?.[1], providerResponse: clip(s) };
    }
    const e = entry as Record<string, unknown>;
    const code = idFrom(e.response_code ?? e.code ?? e.error_code ?? e.status_code);
    const status = String(e.status ?? e.Status ?? "").toLowerCase();
    const errorText = idFrom(e.error_message ?? e.error ?? e.errorMessage);
    const known = code ? MRAM_ERRORS[code] : undefined;
    const failed = !!known || status === "error" || status === "failed" || status === "failure" || (!!errorText && errorText !== "0");
    const providerMessageId = idFrom(e.message_id ?? e.messageId ?? e.msg_id ?? e.id ?? e.sms_id);
    if (failed)
      return {
        id: m.id,
        ok: false,
        error: known ? `${code}: ${known.message}` : clip(errorText || `Gateway status ${status || code}`, 200),
        permanent: known?.permanent ?? false,
        providerResponse: clip(JSON.stringify(e)),
      };
    return { id: m.id, ok: true, providerMessageId, providerResponse: clip(JSON.stringify(e)) };
  };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    if (/^\s*(10\d\d)\s*$/.test(text) || /^\s*error/i.test(text)) return failAll(text.match(/\b(10\d\d)\b/)?.[1], clip(text, 200) || "SMS gateway error");
    const id = text.match(/ID\s*-\s*(\S+)/i)?.[1];
    return batch.map(m => ({ id: m.id, ok: true, providerMessageId: id, providerResponse: raw || undefined }));
  }
  if (typeof json === "number" || typeof json === "string") {
    const s = String(json);
    if (/^10\d\d$/.test(s)) return failAll(s, `Gateway status ${s}`);
    return batch.map(m => ({ id: m.id, ok: true, providerResponse: raw }));
  }
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as Record<string, unknown>).messages)
      ? ((json as Record<string, unknown>).messages as unknown[])
      : Array.isArray((json as Record<string, unknown>).data)
        ? ((json as Record<string, unknown>).data as unknown[])
        : undefined;
  if (list && list.length === batch.length) return batch.map((m, i) => entryResult(list[i], m));
  // One answer for the whole request.
  const whole = entryResult(json, batch[0]);
  if (!whole.ok) {
    if (!whole.permanent) throw new GatewayError(whole.error ?? "SMS gateway error");
    if (batch.length > 1) throw new BatchRejected(whole.error ?? "SMS gateway error");
  }
  return batch.map(m => ({ ...whole, id: m.id }));
}

// ───────────────────────────── Email: Mailjet v3.1 ─────────────────────────────

export interface MailjetConfig {
  apiKey: string;
  apiSecret: string;
  fromEmail: string;
  fromName: string;
  /** https://api.mailjet.com (the endpoint is <baseUrl>/v3.1/send) */
  baseUrl: string;
}

export class MailjetEmailGateway implements EmailGateway {
  readonly name = "mailjet";
  static readonly BATCH = 50;

  constructor(
    private readonly config: MailjetConfig,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  get endpoint() {
    return `${this.config.baseUrl.replace(/\/+$/, "")}/v3.1/send`;
  }

  async sendEmail(messages: EmailMessage[]): Promise<SendResult[]> {
    const results: SendResult[] = [];
    for (const batch of chunks(messages, MailjetEmailGateway.BATCH)) results.push(...(await this.sendBatch(batch)));
    return results;
  }

  private async sendBatch(batch: EmailMessage[]): Promise<SendResult[]> {
    const auth = Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`).toString("base64");
    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
        body: JSON.stringify({
          Messages: batch.map(m => ({
            From: { Email: this.config.fromEmail, Name: this.config.fromName },
            To: [{ Email: m.to, ...(m.toName ? { Name: m.toName } : {}) }],
            Subject: m.subject,
            TextPart: m.text,
            HTMLPart: m.html,
            CustomID: m.id,
          })),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new GatewayError(`Email gateway unreachable: ${(error as Error).message}`);
    }
    const text = await response.text().catch(() => "");
    let json: { Messages?: { Status?: string; To?: { MessageID?: number | string; MessageUUID?: string }[]; Errors?: { ErrorMessage?: string; ErrorCode?: string; StatusCode?: number }[] }[]; ErrorMessage?: string };
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    // Per-message answers come back with 200 (all sent) or 400 (some rejected).
    if (Array.isArray(json.Messages) && json.Messages.length === batch.length && (response.ok || response.status === 400)) {
      return batch.map((m, i) => {
        const r = json.Messages![i];
        if (r.Status === "success") {
          const to = r.To?.[0];
          return { id: m.id, ok: true, providerMessageId: to?.MessageID !== undefined ? String(to.MessageID) : to?.MessageUUID, providerResponse: clip(JSON.stringify(r)) };
        }
        const err = r.Errors?.[0];
        const status = err?.StatusCode ?? 400;
        return {
          id: m.id,
          ok: false,
          error: clip(`${err?.ErrorCode ? `${err.ErrorCode}: ` : ""}${err?.ErrorMessage ?? "Rejected by Mailjet"}`, 200),
          permanent: status >= 400 && status < 500 && status !== 429,
          providerResponse: clip(JSON.stringify(r)),
        };
      });
    }
    const why = json.ErrorMessage ?? clip(text, 200);
    throw new GatewayError(`Email gateway responded ${response.status}${why ? `: ${why}` : ""}`, response.status);
  }
}
