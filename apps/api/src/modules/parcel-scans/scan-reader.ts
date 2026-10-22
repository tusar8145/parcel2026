import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import fs from "node:fs/promises";
import path from "node:path";
import { createWorker, type Worker } from "tesseract.js";
import { env } from "../../config/env";
import { layoutText, prepare, skewOf, upright, type OcrLine } from "./scan-image";

const LANGS = ["eng", "ben"] as const;
/** Below this confidence the photo is tried at the other three orientations. */
const SURE = 80;

export interface ReadResult {
  /** The text, with side-by-side blocks one after the other. */
  text: string;
  /** Tesseract's mean word confidence (0–100). */
  confidence: number;
  /** Clockwise degrees the photo was turned to read it (orientation + straightening). */
  angle: number;
}

/**
 * Text from parcel photos: tesseract (English + Bangla) on this server, no external service. The
 * photo is turned upright (EXIF), tried sideways / upside down when it reads poorly, straightened by
 * the tilt of its text lines, enlarged and cleaned up (scan-image.ts), then read. The language data
 * ships with the npm packages (@tesseract.js-data/eng, /ben) and is copied into one folder next to the
 * file storage at first use; one worker is kept and reads one photo at a time (about 2–5 s).
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

  private async ocr(image: Buffer) {
    this.worker ??= this.start().catch(error => {
      this.worker = undefined;
      throw error;
    });
    const worker = await this.worker;
    const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
    const lines = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines)) as unknown as OcrLine[];
    return { text: data.text ?? "", confidence: data.confidence ?? 0, lines };
  }

  private async readNow(image: Buffer): Promise<ReadResult> {
    const base = await upright(image);
    // Orientation: a quick read at a small size; the other three when it reads poorly.
    let best = { ...(await this.ocr(await prepare(base, { size: 1400 }))), angle: 0 };
    if (best.confidence < SURE)
      for (const angle of [90, 270, 180]) {
        const r = await this.ocr(await prepare(base, { angle, size: 1400 }));
        if (r.confidence > best.confidence + 5) best = { ...r, angle };
        if (best.confidence >= SURE) break;
      }
    // Straightened by the text's tilt, read at full size.
    const angle = best.angle - skewOf(best.lines);
    const final = await this.ocr(await prepare(base, { angle, size: 2000 }));
    const chosen = final.confidence + 2 >= best.confidence ? { ...final, angle } : best;
    const text = chosen.lines.length ? layoutText(chosen.lines) : chosen.text;
    return { text, confidence: Math.round(chosen.confidence), angle: Math.round(chosen.angle) };
  }

  /** Reads a photo. One photo at a time per instance (the worker is single-threaded). */
  read(image: Buffer): Promise<ReadResult> {
    const run = () => this.readNow(image);
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
