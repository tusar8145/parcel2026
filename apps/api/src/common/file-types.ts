/**
 * Upload file types. Most uploads (delivery proofs, KYC, receipts, dispute evidence) take photos and PDFs
 * only ("images"); support tickets also take office files and text ("documents"). The type comes from the
 * file name's extension (browsers report CSV / Office types inconsistently), and the content must match it
 * (StorageService checks the bytes). Nothing that a browser could run is accepted: no HTML, SVG or scripts.
 */
export type UploadKinds = "images" | "documents";

interface FileType {
  mime: string;
  ext: string;
  /** How the bytes are checked. */
  check: "png" | "jpeg" | "webp" | "gif" | "heic" | "pdf" | "ooxml" | "ole" | "text";
  kinds: UploadKinds[];
}

const TYPES: FileType[] = [
  { mime: "image/png", ext: ".png", check: "png", kinds: ["images", "documents"] },
  { mime: "image/jpeg", ext: ".jpg", check: "jpeg", kinds: ["images", "documents"] },
  { mime: "image/webp", ext: ".webp", check: "webp", kinds: ["images", "documents"] },
  { mime: "application/pdf", ext: ".pdf", check: "pdf", kinds: ["images", "documents"] },
  { mime: "image/gif", ext: ".gif", check: "gif", kinds: ["documents"] },
  { mime: "image/heic", ext: ".heic", check: "heic", kinds: ["documents"] },
  { mime: "image/heif", ext: ".heif", check: "heic", kinds: ["documents"] },
  { mime: "text/csv", ext: ".csv", check: "text", kinds: ["documents"] },
  { mime: "text/plain", ext: ".txt", check: "text", kinds: ["documents"] },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx", check: "ooxml", kinds: ["documents"] },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx", check: "ooxml", kinds: ["documents"] },
  { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx", check: "ooxml", kinds: ["documents"] },
  { mime: "application/vnd.ms-excel", ext: ".xls", check: "ole", kinds: ["documents"] },
  { mime: "application/msword", ext: ".doc", check: "ole", kinds: ["documents"] },
  { mime: "application/vnd.ms-powerpoint", ext: ".ppt", check: "ole", kinds: ["documents"] },
];
const BY_EXT = new Map(TYPES.map(t => [t.ext, t]));
BY_EXT.set(".jpeg", TYPES.find(t => t.ext === ".jpg")!);

/** What a kind accepts, for messages and file pickers. */
export const KIND_LABEL: Record<UploadKinds, string> = {
  images: "PNG, JPEG, WebP or PDF files",
  documents: "photos (JPG, PNG, WebP, GIF, HEIC), PDF, Word, Excel, PowerPoint, CSV or text files",
};

/** The type of an upload: by its file name's extension, else (photos and PDFs) by the declared type; null = not allowed. */
export function uploadType(filename: string | undefined, declaredMime: string, kind: UploadKinds): FileType | null {
  const ext = filename?.match(/\.[A-Za-z0-9]{1,5}$/)?.[0].toLowerCase();
  const byExt = ext ? BY_EXT.get(ext) : undefined;
  const byMime = TYPES.find(t => t.mime === declaredMime.toLowerCase());
  const type = byExt ?? byMime;
  return type && type.kinds.includes(kind) ? type : null;
}

/** The type of a stored MIME type (StorageService.save). */
export const typeOfMime = (mime: string) => TYPES.find(t => t.mime === mime) ?? null;

/** Do the bytes look like the type? (A renamed or disguised file is refused.) */
export function contentMatches(data: Buffer, type: FileType): boolean {
  const hex = data.subarray(0, 12).toString("hex");
  switch (type.check) {
    case "png":
      return hex.startsWith("89504e470d0a1a0a");
    case "jpeg":
      return hex.startsWith("ffd8ff");
    case "webp":
      return hex.startsWith("52494646") && data.subarray(8, 12).toString() === "WEBP";
    case "gif":
      return data.subarray(0, 4).toString() === "GIF8";
    case "heic":
      return data.subarray(4, 8).toString() === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(data.subarray(8, 12).toString());
    case "pdf":
      return data.subarray(0, 5).toString() === "%PDF-";
    case "ooxml":
      return hex.startsWith("504b0304");
    case "ole":
      return hex.startsWith("d0cf11e0a1b11ae1");
    case "text":
      // Plain text (CSV / TXT): no NUL bytes in the first 64 KB.
      return !data.subarray(0, 65536).includes(0);
  }
}

/** Photos and PDFs open in the browser; everything else downloads. */
export const opensInline = (mime: string) => mime.startsWith("image/") || mime === "application/pdf";
