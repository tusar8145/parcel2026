import { Global, Injectable, Module } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaService, type Db } from "./prisma.service";
import { AppError } from "./errors";
import { env } from "../config/env";

const ALLOWED = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["application/pdf", ".pdf"],
]);
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * File storage behind one interface. Local disk for development; swap writeObject /
 * readObject for S3 or R2 in production without touching callers.
 */
@Injectable()
export class StorageService {
  constructor(private readonly prisma: PrismaService) {}

  private root = () => path.resolve(env().FILE_STORAGE_DIR);

  async save(input: { data: Buffer; mimeType: string; filename: string; uploadedById?: string; messageId?: string }, db: Db = this.prisma) {
    const ext = ALLOWED.get(input.mimeType);
    if (!ext) throw new AppError("UNSUPPORTED_FILE", "Only PNG, JPEG, WebP and PDF files are allowed", 415);
    if (input.data.length > MAX_BYTES) throw new AppError("FILE_TOO_LARGE", "Files must be 5 MB or smaller", 413);
    if (!this.contentMatches(input.data, input.mimeType)) throw new AppError("UNSUPPORTED_FILE", "The file content doesn't match its type", 415);
    const day = new Date().toISOString().slice(0, 10);
    const storageKey = `${day}/${randomUUID()}${ext}`;
    await this.writeObject(storageKey, input.data);
    return db.storedFile.create({
      data: {
        storageKey,
        filename: input.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || `file${ext}`,
        mimeType: input.mimeType,
        sizeBytes: input.data.length,
        sha256: createHash("sha256").update(input.data).digest("hex"),
        uploadedById: input.uploadedById,
        messageId: input.messageId,
      },
    });
  }

  /** data:image/png;base64,… */
  async saveDataUrl(dataUrl: string, filename: string, uploadedById?: string, db?: Db, messageId?: string) {
    const match = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/s);
    if (!match) throw new AppError("INVALID_FILE", "Invalid file data", 422);
    return this.save({ data: Buffer.from(match[2], "base64"), mimeType: match[1], filename, uploadedById, messageId }, db);
  }

  async read(storageKey: string): Promise<Buffer> {
    return fs.readFile(this.safePath(storageKey));
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

  /** Magic-number check so a renamed executable can't pose as an image. */
  private contentMatches(data: Buffer, mime: string) {
    const hex = data.subarray(0, 12).toString("hex");
    switch (mime) {
      case "image/png":
        return hex.startsWith("89504e470d0a1a0a");
      case "image/jpeg":
        return hex.startsWith("ffd8ff");
      case "image/webp":
        return hex.startsWith("52494646") && data.subarray(8, 12).toString() === "WEBP";
      case "application/pdf":
        return data.subarray(0, 5).toString() === "%PDF-";
      default:
        return false;
    }
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
