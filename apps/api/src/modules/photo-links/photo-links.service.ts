import { HttpStatus, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { AuditService } from "../../common/audit.service";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, notFound } from "../../common/errors";
import { phoneLinkOrigin } from "../../common/phone-link";
import { PrismaService } from "../../common/prisma.service";
import { RealtimeService } from "../../common/realtime.service";
import { RedisService } from "../../common/redis.service";
import { StorageService } from "../../common/storage.service";
import { env } from "../../config/env";

/** The link works for 15 minutes, or until one photo is sent or the dialog on the computer closes. */
const TTL_SECONDS = 15 * 60;
const OWNER_ONLY = "photo_link:owner";

interface Link {
  id: string;
  userId: string;
  title: string;
  tokenHash: string;
  fileId: string | null;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const closed = () => new AppError("PHOTO_LINK_CLOSED", "This link has expired or was already used. Ask for a new QR code on the computer.", HttpStatus.GONE);

/**
 * "Use phone" for a photo (e.g. the payment receipt when a settlement is paid): the computer opens a
 * one-photo link (QR code); the phone takes the photo and sends it (POST …/public/:token/photo); the
 * computer gets it (`photo_link.done` on GET /events, or GET /photo-links/:id) and attaches the stored
 * file. The link works once: after the photo, after 15 minutes, or when the computer closes it.
 * Kept in Redis; the photo is a StoredFile uploaded as the link's owner.
 */
@Injectable()
export class PhotoLinksService {
  constructor(
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  private key(kind: "link" | "token", id: string) {
    return `df:${env().NODE_ENV}:photo-link:${kind}:${id}`;
  }

  private async load(id: string): Promise<Link | null> {
    const raw = /^[\w-]{10,40}$/.test(id) ? await this.redis.get(this.key("link", id)) : null;
    return raw ? (JSON.parse(raw) as Link) : null;
  }

  async open(actor: UserActor, input: { title?: string }, meta: RequestMeta) {
    const token = randomBytes(24).toString("base64url");
    const link: Link = { id: randomBytes(12).toString("base64url"), userId: actor.userId, title: (input.title || "Take a photo").slice(0, 120), tokenHash: hashToken(token), fileId: null };
    await this.redis.multi().set(this.key("link", link.id), JSON.stringify(link), "EX", TTL_SECONDS).set(this.key("token", link.tokenHash), link.id, "EX", TTL_SECONDS).exec();
    await this.audit.record(actor, { action: "photo_link.open", entityType: "photo_link", entityId: link.id, data: { title: link.title } }, meta);
    const url = `${phoneLinkOrigin()}/photo/${token}`;
    const qrSvg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
    return { id: link.id, url, qrSvg, expiresInSeconds: TTL_SECONDS };
  }

  /** The computer: waiting, or the photo (stored file id and a data URL to show it). */
  async status(actor: UserActor, id: string) {
    const link = await this.load(id);
    if (!link || link.userId !== actor.userId) throw notFound("Photo link");
    if (!link.fileId) return { status: "waiting" as const };
    const file = await this.prisma.storedFile.findUnique({ where: { id: link.fileId } });
    if (!file) return { status: "waiting" as const };
    const data = await this.storage.read(file.storageKey);
    return { status: "done" as const, fileId: file.id, dataUrl: `data:${file.mimeType};base64,${data.toString("base64")}` };
  }

  /** The dialog closed: the phone's link stops working. */
  async close(actor: UserActor, id: string) {
    const link = await this.load(id);
    if (!link || link.userId !== actor.userId) throw notFound("Photo link");
    await this.redis.del(this.key("link", id), this.key("token", link.tokenHash));
    return { ok: true };
  }

  // ───────────── the phone (public, with the token) ─────────────

  private async byToken(token: string) {
    const id = typeof token === "string" && token.length <= 64 ? await this.redis.get(this.key("token", hashToken(token))) : null;
    const link = id ? await this.load(id) : null;
    if (!link || link.fileId) throw closed();
    return link;
  }

  async publicView(token: string) {
    const link = await this.byToken(token);
    return { title: link.title };
  }

  /** The photo (data URL, JPEG/PNG/WebP, ≤ 5 MB): stored, handed to the computer; the link is used up. */
  async photo(token: string, image: string) {
    const link = await this.byToken(token);
    const file = await this.storage.saveDataUrl(image, `photo-${link.id}`, link.userId);
    link.fileId = file.id;
    // Used: the token no longer works; the computer can still read the result for a while.
    await this.redis.multi().del(this.key("token", link.tokenHash)).set(this.key("link", link.id), JSON.stringify(link), "EX", TTL_SECONDS).exec();
    this.realtime.publish({ type: "photo_link.done", id: link.id, userIds: [link.userId], staffPermission: OWNER_ONLY, data: { linkId: link.id, fileId: file.id } });
    return { ok: true };
  }
}
