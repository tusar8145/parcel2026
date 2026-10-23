import { HttpStatus, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import type { z } from "zod";
import { AuditService } from "../../common/audit.service";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, notFound } from "../../common/errors";
import { phoneLinkOrigin } from "../../common/phone-link";
import { RealtimeService } from "../../common/realtime.service";
import { RedisService } from "../../common/redis.service";
import { env } from "../../config/env";
import type { phoneScanResultSchema, phoneScanSchema } from "./phone-scanner.schemas";

/** The link works while the panel tab keeps it alive (keepalive every minute); closing the tab ends it soon after. */
const TTL_SECONDS = 180;
const MAX_SCANS = 5000;
const RESULTS = 20;
/** No staff permission sees these events: only the link's owner (userIds), and there only the tab that opened it (data.linkId). */
const OWNER_ONLY = "phone_scanner:owner";

interface Link {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  phoneSeenAt: string | null;
  count: number;
}
interface ScanResult {
  n: number;
  ok: boolean;
  message?: string;
  at: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const closed = () => new AppError("SCANNER_LINK_CLOSED", "This phone scanner was disconnected. Scan the QR code on the computer again.", HttpStatus.GONE);

/**
 * Phone scanner (Courier Operations): a phone becomes the barcode scanner of one panel tab. The tab
 * opens a link (QR code); each code the phone reads goes to that tab only (`phone_scanner.scan` on
 * GET /events) and into the open page's scan box; the page's result goes back to the phone. Kept in
 * Redis only: the link lives while the tab keeps it alive, and Disconnect ends it at once.
 */
@Injectable()
export class PhoneScannerService {
  constructor(
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  private key(kind: "link" | "token" | "results", id: string) {
    return `df:${env().NODE_ENV}:phone-scanner:${kind}:${id}`;
  }

  private async load(id: string): Promise<Link | null> {
    const raw = await this.redis.get(this.key("link", id));
    return raw ? (JSON.parse(raw) as Link) : null;
  }

  private async save(link: Link) {
    await this.redis
      .multi()
      .set(this.key("link", link.id), JSON.stringify(link), "EX", TTL_SECONDS)
      .set(this.key("token", link.tokenHash), link.id, "EX", TTL_SECONDS)
      .expire(this.key("results", link.id), TTL_SECONDS)
      .exec();
  }

  /** The actor's own link (404 for anyone else's or one that ended). */
  private async own(actor: UserActor, id: string) {
    const link = /^[\w-]{10,40}$/.test(id) ? await this.load(id) : null;
    if (!link || link.userId !== actor.userId) throw notFound("Phone scanner link");
    return link;
  }

  private async byToken(token: string) {
    const id = typeof token === "string" && token.length <= 64 ? await this.redis.get(this.key("token", hashToken(token))) : null;
    const link = id ? await this.load(id) : null;
    if (!link) throw closed();
    return link;
  }

  private view(link: Link) {
    return { id: link.id, phoneConnected: !!link.phoneSeenAt, phoneSeenAt: link.phoneSeenAt, scans: link.count, expiresInSeconds: TTL_SECONDS };
  }

  private publish(link: Link, type: string, data: Record<string, unknown>) {
    this.realtime.publish({ type, id: link.id, userIds: [link.userId], staffPermission: OWNER_ONLY, data: { linkId: link.id, ...data } });
  }

  /** Opens a link for this tab: { id, url, qrSvg }. */
  async open(actor: UserActor, meta: RequestMeta) {
    const token = randomBytes(24).toString("base64url");
    const link: Link = { id: randomBytes(12).toString("base64url"), userId: actor.userId, name: actor.name, tokenHash: hashToken(token), createdAt: new Date().toISOString(), phoneSeenAt: null, count: 0 };
    await this.save(link);
    await this.audit.record(actor, { action: "phone_scanner.open", entityType: "phone_scanner", entityId: link.id }, meta);
    const url = `${phoneLinkOrigin()}/scanner/${token}`;
    const qrSvg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
    return { ...this.view(link), url, qrSvg };
  }

  /** The tab is still open: the link keeps working for another 3 minutes. */
  async keepalive(actor: UserActor, id: string) {
    const link = await this.own(actor, id);
    await this.save(link);
    return this.view(link);
  }

  /** Disconnect (or the tab closing): the phone's link stops working at once. */
  async close(actor: UserActor, id: string, meta: RequestMeta) {
    const link = await this.own(actor, id);
    await this.redis.del(this.key("link", id), this.key("token", link.tokenHash), this.key("results", id));
    await this.audit.record(actor, { action: "phone_scanner.close", entityType: "phone_scanner", entityId: id, data: { scans: link.count, phoneConnected: !!link.phoneSeenAt } }, meta);
    return { ok: true };
  }

  /** The page's result for scan n (shown on the phone with a sound). */
  async result(actor: UserActor, id: string, input: z.infer<typeof phoneScanResultSchema>) {
    await this.own(actor, id);
    const result: ScanResult = { n: input.n, ok: input.ok, message: input.message, at: new Date().toISOString() };
    await this.redis.multi().lpush(this.key("results", id), JSON.stringify(result)).ltrim(this.key("results", id), 0, RESULTS - 1).expire(this.key("results", id), TTL_SECONDS).exec();
    return { ok: true };
  }

  // ───────────── the phone (public, with the link's token) ─────────────

  /** The phone's page: who it scans for, and the results of its last scans. The first visit tells the panel it is connected. */
  async publicView(token: string) {
    const link = await this.byToken(token);
    if (!link.phoneSeenAt) {
      link.phoneSeenAt = new Date().toISOString();
      await this.save(link);
      this.publish(link, "phone_scanner.status", { phoneConnected: true });
    }
    const results = (await this.redis.lrange(this.key("results", link.id), 0, RESULTS - 1)).map(r => JSON.parse(r) as ScanResult);
    return { name: link.name, panel: "Courier Operations", scans: link.count, results };
  }

  /** A code read on the phone: sent to the panel tab (its open scan box), numbered for the result. */
  async scan(token: string, input: z.infer<typeof phoneScanSchema>) {
    const link = await this.byToken(token);
    if (link.count >= MAX_SCANS) throw new AppError("TOO_MANY_SCANS", "This link has reached its scan limit. Connect again from the computer.", 429);
    link.count += 1;
    link.phoneSeenAt ??= new Date().toISOString();
    await this.save(link);
    this.publish(link, "phone_scanner.scan", { code: input.code, n: link.count });
    return { n: link.count };
  }
}
