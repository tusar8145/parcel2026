import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import fs from "node:fs/promises";
import path from "node:path";
import { createWorker, type Worker } from "tesseract.js";
import { env } from "../../config/env";

const LANGS = ["eng", "ben"] as const;

/**
 * Text from parcel photos: tesseract (English + Bangla) on this server, no external service. The
 * language data ships with the npm packages (@tesseract.js-data/eng, /ben) and is copied into one
 * folder next to the file storage at first use; one worker is kept and reads one photo at a time
 * (about 0.5 s and 160 MB).
 */
@Injectable()
export class ScanReaderService implements OnModuleDestroy {
  private readonly logger = new Logger(ScanReaderService.name);
  private worker?: Promise<Worker>;
  private queue: Promise<unknown> = Promise.resolve();

  private dir = () => path.resolve(env().FILE_STORAGE_DIR, "..", "tesseract");

  private async start(): Promise<Worker> {
    const langPath = path.join(this.dir(), "lang");
    await fs.mkdir(langPath, { recursive: true });
    for (const lang of LANGS) {
      const target = path.join(langPath, `${lang}.traineddata.gz`);
      const exists = await fs.stat(target).then(
        () => true,
        () => false,
      );
      if (exists) continue;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const data = require(`@tesseract.js-data/${lang}`) as { langPath: string };
      await fs.copyFile(path.join(data.langPath, `${lang}.traineddata.gz`), target);
    }
    return createWorker([...LANGS], 1, { langPath, cachePath: path.join(this.dir(), "cache"), gzip: true });
  }

  /** The photo's text ("" when nothing could be read). One photo at a time per instance. */
  read(image: Buffer): Promise<string> {
    const run = async () => {
      this.worker ??= this.start().catch(error => {
        this.worker = undefined;
        throw error;
      });
      const worker = await this.worker;
      const result = await worker.recognize(image);
      return result.data.text ?? "";
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async onModuleDestroy() {
    const worker = await this.worker?.catch(() => undefined);
    await worker?.terminate().catch(() => undefined);
    this.logger.debug("OCR worker stopped");
  }
}
