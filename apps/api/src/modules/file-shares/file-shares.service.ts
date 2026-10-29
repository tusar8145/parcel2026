import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { AuditService } from "../../common/audit.service";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, notFound } from "../../common/errors";
import { phoneLinkOrigin } from "../../common/phone-link";
import { RealtimeService } from "../../common/realtime.service";
import { RedisService } from "../../common/redis.service";
import { env } from "../../config/env";

/** The link lives while the dialog on the computer is open (it pings); 30 minutes after the last ping it expires. */
const TTL_SECONDS = 30 * 60;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 30;
const OWNER_ONLY = "file_share:owner";

export interface SharedFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  at: string;
}

interface Share {
  id: string;
  userId: string;
  tokenHash: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const closed = () => new AppError("FILE_SHARE_CLOSED", "This link no longer works: the window on the computer was closed or it expired. Ask for a new QR code.", HttpStatus.GONE);
const safeName = (name: string) => name.replace(/[\\/\0\r\n"]+/g, "_").replace(/^\.+/, "").trim().slice(0, 160) || "file";

/**
 * Courier Operations › Share files: the computer opens a link (QR code); any device that opens it drops
 * files (POST …/public/:token/files, one per request); they appear on the computer (`file_share.received`
 * on GET /events) and can be downloaded. Closing the dialog ends the link and deletes the files. Nothing
 * is kept: the files sit in a folder of their own under FILE_STORAGE_DIR, removed on close or expiry.
 */
@Injectable()
export class FileSharesService {
  private readonly logger = new Logger(FileSharesService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  private key(kind: "share" | "token" | "files", id: string) {
    return `df:${env().NODE_ENV}:file-share:${kind}:${id}`;
  }
  private root() {
    return path.resolve(env().FILE_STORAGE_DIR, "file-shares");
  }
  private dir(id: string) {
    return path.join(this.root(), id);
  }

  private async load(id: string): Promise<Share | null> {
    const raw = /^[\w-]{10,40}$/.test(id) ? await this.redis.get(this.key("share", id)) : null;
    return raw ? (JSON.parse(raw) as Share) : null;
  }
  private async save(share: Share) {
    await this.redis
      .multi()
      .set(this.key("share", share.id), JSON.stringify(share), "EX", TTL_SECONDS)
      .set(this.key("token", share.tokenHash), share.id, "EX", TTL_SECONDS)
      .expire(this.key("files", share.id), TTL_SECONDS)
      .exec();
  }
  /** The files received, in order (a Redis list: uploads at the same time each append). */
  private async files(id: string): Promise<SharedFile[]> {
    return (await this.redis.lrange(this.key("files", id), 0, -1)).map(f => JSON.parse(f) as SharedFile);
  }
  private async own(actor: UserActor, id: string) {
    const share = await this.load(id);
    if (!share || share.userId !== actor.userId) throw notFound("File share");
    return share;
  }

  async open(actor: UserActor, meta: RequestMeta) {
    void this.sweep();
    const token = randomBytes(24).toString("base64url");
    const share: Share = { id: randomBytes(12).toString("base64url"), userId: actor.userId, tokenHash: hashToken(token) };
    await this.save(share);
    await this.audit.record(actor, { action: "file_share.open", entityType: "file_share", entityId: share.id }, meta);
    const url = `${phoneLinkOrigin()}/share/${token}`;
    const qrSvg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
    return { id: share.id, url, qrSvg, expiresInSeconds: TTL_SECONDS, maxFileMb: MAX_FILE_BYTES / 1024 / 1024, maxFiles: MAX_FILES };
  }

  /** The computer: the files received so far. Also keeps the link alive while the dialog is open. */
  async status(actor: UserActor, id: string) {
    const share = await this.own(actor, id);
    await this.save(share);
    return { files: await this.files(share.id) };
  }

  async download(actor: UserActor, id: string, fileId: string) {
    const share = await this.own(actor, id);
    const file = (await this.files(share.id)).find(f => f.id === fileId);
    if (!file) throw notFound("File");
    const data = await fs.readFile(path.join(this.dir(share.id), file.id)).catch(() => null);
    if (!data) throw notFound("File");
    return { file, data };
  }

  /** The dialog closed: the link stops working and every file received is deleted. */
  async close(actor: UserActor, id: string) {
    const share = await this.own(actor, id);
    await this.redis.del(this.key("share", id), this.key("token", share.tokenHash), this.key("files", id));
    await fs.rm(this.dir(share.id), { recursive: true, force: true });
    return { ok: true };
  }

  /** Folders of links that expired without being closed (the browser was closed). */
  private async sweep() {
    try {
      const names = await fs.readdir(this.root()).catch(() => [] as string[]);
      for (const name of names) {
        if (await this.redis.get(this.key("share", name))) continue;
        const stat = await fs.stat(this.dir(name)).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > TTL_SECONDS * 1000) await fs.rm(this.dir(name), { recursive: true, force: true });
      }
    } catch (error) {
      this.logger.warn(`File share cleanup failed: ${String(error)}`);
    }
  }

  // ───────────── the other device (public, with the token) ─────────────

  private async byToken(token: string) {
    const id = typeof token === "string" && token.length <= 64 ? await this.redis.get(this.key("token", hashToken(token))) : null;
    const share = id ? await this.load(id) : null;
    if (!share) throw closed();
    return share;
  }

  async publicView(token: string) {
    const share = await this.byToken(token);
    return { files: (await this.files(share.id)).map(f => ({ name: f.name, size: f.size, at: f.at })), maxFileMb: MAX_FILE_BYTES / 1024 / 1024, maxFiles: MAX_FILES };
  }

  async receive(token: string, input: { data: Buffer; name: string; mimeType: string }) {
    const share = await this.byToken(token);
    if ((await this.redis.llen(this.key("files", share.id))) >= MAX_FILES) throw new AppError("TOO_MANY_FILES", `At most ${MAX_FILES} files per link. Ask for a new QR code on the computer.`, 422);
    if (!input.data.length) throw new AppError("VALIDATION_FAILED", "The file is empty", 422);
    const file: SharedFile = { id: randomBytes(9).toString("base64url"), name: safeName(input.name), size: input.data.length, mimeType: input.mimeType || "application/octet-stream", at: new Date().toISOString() };
    await fs.mkdir(this.dir(share.id), { recursive: true });
    await fs.writeFile(path.join(this.dir(share.id), file.id), input.data);
    // Check again: the dialog may have closed (and deleted the folder) while the file was uploading.
    if (!(await this.load(share.id))) {
      await fs.rm(this.dir(share.id), { recursive: true, force: true });
      throw closed();
    }
    await this.redis.multi().rpush(this.key("files", share.id), JSON.stringify(file)).expire(this.key("files", share.id), TTL_SECONDS).exec();
    this.realtime.publish({ type: "file_share.received", id: share.id, userIds: [share.userId], staffPermission: OWNER_ONLY, data: { shareId: share.id, file } });
    return { ok: true, file: { name: file.name, size: file.size } };
  }
}
