import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import fs from "node:fs/promises";
import path from "node:path";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { env } from "../../config/env";
import type { Catalog } from "../pricing/pricing.service";
import type { ImportKindKey } from "../imports/columns";
import { layoutText, prepare, rowsText, skewOf, upright, type OcrLine } from "./scan-image";
import { parseLabel, type ScanCells } from "./scan-parser";

type Places = Pick<Catalog, "districts" | "zonesByDistrict" | "areasByZone">;

/** Languages tesseract knows (their data ships with @tesseract.js-data/*). */
const KNOWN = ["eng", "ben"];
/** Long side of the image for the full read (the size that reads amounts most reliably), and for the quick orientation reads. */
const FULL = 2000;
const QUICK = 1000;
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

  /** SCAN_OCR_LANGS: "eng" (default, English labels; fastest) or "eng+ben" (Bangla too, about 40% slower). */
  langs = env().SCAN_OCR_LANGS.split("+").map(l => l.trim()).filter(l => KNOWN.includes(l));

  private dir = () => path.resolve(env().FILE_STORAGE_DIR, "..", "tesseract");

  private async start(): Promise<Worker> {
    const langPath = path.join(this.dir(), "lang");
    await fs.mkdir(langPath, { recursive: true });
    for (const lang of this.langs) {
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
    return createWorker(this.langs.length ? this.langs : ["eng"], 1, { langPath, cachePath: path.join(this.dir(), "cache"), gzip: true });
  }

  private mode: PSM = PSM.AUTO;

  /** `mode`: tesseract page segmentation, AUTO (blocks of text) or SPARSE_TEXT (scattered words, table cells). */
  private async ocr(image: Buffer, mode: PSM = PSM.AUTO) {
    this.worker ??= this.start().catch(error => {
      this.worker = undefined;
      throw error;
    });
    const worker = await this.worker;
    if (mode !== this.mode) {
      await worker.setParameters({ tessedit_pageseg_mode: mode });
      this.mode = mode;
    }
    const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
    const lines = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines)) as unknown as OcrLine[];
    return { text: data.text ?? "", confidence: data.confidence ?? 0, lines };
  }

  private async readNow(image: Buffer): Promise<ReadResult> {
    const started = Date.now();
    let passes = 0;
    const ocr = async (angle: number, size: number) => {
      passes++;
      return { ...(await this.ocr(await prepare(base, { angle, size }))), angle };
    };
    const base = await upright(image);
    // One full read: an upright, straight photo that reads well is done (the usual case).
    let chosen = await ocr(0, FULL);
    let skew = skewOf(chosen.lines);
    if (chosen.confidence < SURE && skew) {
      // Tilted: straightened first (cheaper than trying the other sides).
      const again = await ocr(-skew, FULL);
      if (again.confidence > chosen.confidence) chosen = again;
      skew = 0;
    }
    if (chosen.confidence < SURE) {
      // Reads poorly: the orientation from quick small reads of all four sides.
      let best = await ocr(0, QUICK);
      for (const angle of [90, 270, 180]) {
        const r = await ocr(angle, QUICK);
        if (r.confidence > best.confidence + 3) best = r;
        if (best.confidence >= SURE) break;
      }
      skew = skewOf(best.lines);
      if (best.angle !== 0 || skew) {
        const again = await ocr(best.angle - skew, FULL);
        if (again.confidence > chosen.confidence) chosen = again;
      }
    } else if (skew) {
      // Tilted: read again straightened.
      const again = await ocr(-skew, FULL);
      if (again.confidence + 2 >= chosen.confidence) chosen = again;
    }
    const text = chosen.lines.length ? layoutText(chosen.lines) : chosen.text;
    this.logger.log(`Photo read in ${Date.now() - started} ms (${passes} OCR pass${passes === 1 ? "" : "es"}, turned ${Math.round(chosen.angle)}°, confidence ${Math.round(chosen.confidence)})`);
    return { text, confidence: Math.round(chosen.confidence), angle: Math.round(chosen.angle) };
  }

  /** Reads a photo. One photo at a time per instance (the worker is single-threaded). */
  read(image: Buffer): Promise<ReadResult> {
    return this.serial(() => this.readNow(image));
  }

  /**
   * A second reading for photos the first one missed fields on (tables, scattered labels): every
   * word on its own (sparse text), rows rebuilt from where the words sit. `angle`: the first reading's.
   */
  readSparse(image: Buffer, angle: number): Promise<string> {
    return this.serial(async () => {
      const started = Date.now();
      const base = await upright(image);
      // Two looks: a cell the OCR misses in one it often reads in the other. When the photo was
      // straightened by a few degrees, the plain quarter turn (straightening can blur table rows);
      // else a smaller size.
      const quarter = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
      const looks = quarter !== angle ? [{ angle, size: FULL }, { angle: quarter, size: FULL }] : [{ angle, size: FULL }, { angle, size: 1600 }];
      const rows: string[] = [];
      for (const look of looks) {
        const r = await this.ocr(await prepare(base, look), PSM.SPARSE_TEXT);
        for (const row of rowsText(r.lines.flatMap(l => l.words)).split("\n")) if (row.trim() && !rows.includes(row)) rows.push(row);
      }
      this.logger.log(`Photo read again word by word in ${Date.now() - started} ms`);
      return rows.join("\n");
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
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

/**
 * Photo → order fields with OCR and the rules: the normal reading, then (when the phone, name or
 * amount is missing: tables, scattered labels) a word-by-word reading that fills only what's missing.
 */
export async function readFields(reader: ScanReaderService, photo: Buffer, kind: ImportKindKey, catalog: Places) {
  const read = await reader.read(photo);
  let text = read.text.trim();
  let cells = parseLabel(text, kind, catalog);
  const key: (keyof ScanCells)[] = ["recipient_phone", "recipient_name", ...(kind === "document" ? [] : ["cod_amount" as const])];
  if (key.some(k => !cells[k])) {
    const sparse = (await reader.readSparse(photo, read.angle)).trim();
    const more = parseLabel(sparse, kind, catalog);
    const hadPlace = !!cells.zone;
    cells = { ...more, ...cells };
    if (!hadPlace && more.zone) Object.assign(cells, { district: more.district, zone: more.zone, area: more.area });
    if (sparse) text = `${text}\n\n— read word by word —\n${sparse}`;
  }
  return { cells, text, confidence: read.confidence, angle: read.angle };
}
