import { Global, Injectable, Module } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaService, type Db } from "./prisma.service";
import { AppError } from "./errors";
import { env } from "../config/env";
import { contentMatches, KIND_LABEL, uploadType, type UploadKinds } from "./file-types";

const MAX_BYTES = 5 * 1024 * 1024;
/** What one account may upload in a calendar year (Dhaka time); staff of the admin panels are exempt. */
export const YEARLY_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const STAFF_ROLES = ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"] as const;
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

/**
 * File storage behind one interface. Local disk for development; swap writeObject /
 * readObject for S3 or R2 in production without touching callers.
 */
@Injectable()
export class StorageService {
  constructor(private readonly prisma: PrismaService) {}

  private root = () => path.resolve(env().FILE_STORAGE_DIR);

  /** kind "images" (default): photos and PDFs; "documents" (support tickets): also office files, CSV and text. */
  async save(input: { data: Buffer; mimeType: string; filename: string; uploadedById?: string; messageId?: string; kind?: UploadKinds }, db: Db = this.prisma) {
    const kind = input.kind ?? "images";
    // Photos and PDFs keep their declared type; documents are typed by the file name's extension.
    const type = kind === "images" ? uploadType(undefined, input.mimeType, kind) : uploadType(input.filename, input.mimeType, kind);
    if (!type) throw new AppError("UNSUPPORTED_FILE", `Only ${KIND_LABEL[kind]} are allowed`, 415);
    const ext = type.ext;
    if (input.data.length > MAX_BYTES) throw new AppError("FILE_TOO_LARGE", "Files must be 5 MB or smaller", 413);
    if (!contentMatches(input.data, type)) throw new AppError("UNSUPPORTED_FILE", "The file content doesn't match its type", 415);
    if (input.uploadedById) await this.assertYearlyAllowance(db, input.uploadedById, input.data.length);
    const day = new Date().toISOString().slice(0, 10);
    const storageKey = `${day}/${randomUUID()}${ext}`;
    await this.writeObject(storageKey, input.data);
    return db.storedFile.create({
      data: {
        storageKey,
        filename: input.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || `file${ext}`,
        mimeType: type.mime,
        sizeBytes: input.data.length,
        sha256: createHash("sha256").update(input.data).digest("hex"),
        uploadedById: input.uploadedById,
        messageId: input.messageId,
      },
    });
  }

  /**
   * 2 GB of uploads per account and calendar year (Dhaka time) for merchants, riders, customers and
   * franchises; staff (super admin, operations, hubs, finance, support) are exempt.
   */
  async assertYearlyAllowance(db: Db, userId: string, adding: number) {
    const staff = await db.userRole.count({ where: { userId, role: { in: [...STAFF_ROLES] } } });
    if (staff) return;
    const year = new Date(Date.now() + 6 * 3600_000).getUTCFullYear();
    const since = new Date(Date.UTC(year, 0, 1) - 6 * 3600_000);
    const used = (await db.storedFile.aggregate({ where: { uploadedById: userId, createdAt: { gte: since } }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0;
    if (used + adding > YEARLY_UPLOAD_BYTES)
      throw new AppError("UPLOAD_QUOTA_EXCEEDED", `This account has used ${gb(used)} of its ${gb(YEARLY_UPLOAD_BYTES)} yearly upload allowance; the file doesn't fit. The allowance renews on 1 January.`, 413, {
        usedBytes: used,
        limitBytes: YEARLY_UPLOAD_BYTES,
      });
  }

  /** data:image/png;base64,… (documents may carry any or no declared type: data:;base64,…) */
  async saveDataUrl(dataUrl: string, filename: string, uploadedById?: string, db?: Db, messageId?: string, kind?: UploadKinds) {
    const match = dataUrl.match(/^data:([\w/+.-]*);base64,(.+)$/s);
    if (!match) throw new AppError("INVALID_FILE", "Invalid file data", 422);
    return this.save({ data: Buffer.from(match[2], "base64"), mimeType: match[1], filename, uploadedById, messageId, kind }, db);
  }

  async read(storageKey: string): Promise<Buffer> {
    return fs.readFile(this.safePath(storageKey));
  }

  /** Deletes stored files (the objects, then their rows); objects already gone are skipped. */
  async remove(ids: string[], db: Db = this.prisma) {
    if (!ids.length) return 0;
    const files = await db.storedFile.findMany({ where: { id: { in: ids } }, select: { id: true, storageKey: true } });
    for (const f of files) await fs.rm(this.safePath(f.storageKey), { force: true });
    const { count } = await db.storedFile.deleteMany({ where: { id: { in: files.map(f => f.id) } } });
    return count;
  }

  private async writeObject(key: string, data: Buffer) {
    const file = this.safePath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data, { flag: "wx" });
  }

  private safePath(key: string) {
    const file = path.resolve(this.root(), key);
    if (!file.startsWith(this.root() + path.sep)) throw new AppError("INVALID_FILE", "Invalid file key");
    return file;
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
