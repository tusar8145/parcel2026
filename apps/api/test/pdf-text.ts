import { inflateSync } from "node:zlib";

/**
 * Just enough PDF reading for tests of generated documents (pdfkit output): page count and the
 * text drawn on each page, decoded through each embedded font's ToUnicode CMap. Not a general
 * PDF parser: no object streams, xref streams or encryption (pdfkit writes none of them).
 */
export interface PdfInfo {
  pages: number;
  text: string[];
  all: string;
  title: string | null;
}

interface Obj {
  dict: string;
  stream?: Buffer;
}

function readObjects(pdf: Buffer): Map<number, Obj> {
  const src = pdf.toString("latin1");
  const objects = new Map<number, Obj>();
  const re = /(\d+) 0 obj\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    // The dictionary ends where the stream (binary, may contain anything) or the object ends.
    const streamAt = src.indexOf("stream", start);
    const endAt = src.indexOf("endobj", start);
    if (streamAt >= 0 && streamAt < endAt && src.slice(start, streamAt).includes("/Length")) {
      const dict = src.slice(start, streamAt);
      let dataStart = streamAt + "stream".length;
      if (src[dataStart] === "\r") dataStart++;
      if (src[dataStart] === "\n") dataStart++;
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? "0");
      let data = pdf.subarray(dataStart, dataStart + length);
      if (/\/FlateDecode/.test(dict)) data = inflateSync(data);
      objects.set(Number(m[1]), { dict, stream: data });
      // Skip the binary data so bytes inside it are never read as objects.
      re.lastIndex = src.indexOf("endobj", dataStart + length);
    } else {
      objects.set(Number(m[1]), { dict: src.slice(start, endAt) });
      re.lastIndex = endAt;
    }
  }
  return objects;
}

const hexToString = (hex: string) => {
  const cps: number[] = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) cps.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCodePoint(...cps.filter(c => c < 0xd800 || c > 0xdfff));
};

function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const [, src, dst] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(src, 16), hexToString(dst));
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, a, b, rest] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const from = parseInt(a, 16);
      const to = parseInt(b, 16);
      if (rest.startsWith("[")) {
        // Ligatures map to several code points: <0066 0066> (ff).
        const items = [...rest.matchAll(/<([0-9a-fA-F\s]+)>/g)].map(x => x[1].replace(/\s+/g, ""));
        for (let c = from; c <= to; c++) map.set(c, hexToString(items[c - from] ?? ""));
      } else {
        const base = parseInt(rest.slice(1, -1), 16);
        for (let c = from; c <= to; c++) map.set(c, String.fromCodePoint(base + (c - from)));
      }
    }
  }
  return map;
}

export function readPdf(pdf: Buffer): PdfInfo {
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("Not a PDF");
  const objects = readObjects(pdf);
  // Font resource names (/F1 7 0 R) → ToUnicode maps
  const fontMaps = new Map<string, Map<number, string>>();
  const fontObj = new Map<number, Map<number, string>>();
  for (const [id, o] of objects) {
    const tu = /\/ToUnicode (\d+) 0 R/.exec(o.dict);
    if (/\/Type \/Font/.test(o.dict) && tu) {
      const cmap = objects.get(Number(tu[1]))?.stream?.toString("latin1") ?? "";
      fontObj.set(id, parseCMap(cmap));
    }
  }
  for (const o of objects.values()) {
    for (const [, name, ref] of o.dict.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
      const map = fontObj.get(Number(ref));
      if (map) fontMaps.set(name, map);
    }
  }
  const pageObjs = [...objects.values()].filter(o => /\/Type \/Page\b(?!s)/.test(o.dict));
  const text = pageObjs.map(page => {
    const refs = [...(/\/Contents (\[[^\]]*\]|\d+ 0 R)/.exec(page.dict)?.[1] ?? "").matchAll(/(\d+) 0 R/g)].map(x => Number(x[1]));
    let out = "";
    for (const ref of refs) {
      const content = objects.get(ref)?.stream?.toString("latin1") ?? "";
      let font: Map<number, string> | undefined;
      for (const t of content.matchAll(/\/(F\d+) [\d.]+ Tf|\[((?:[^\]])*)\] TJ|<([0-9a-fA-F]*)> Tj/g)) {
        if (t[1]) font = fontMaps.get(t[1]);
        else {
          const hexes = t[2] !== undefined ? [...t[2].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => x[1]) : [t[3]];
          for (const hex of hexes) for (let i = 0; i + 4 <= hex.length; i += 4) out += font?.get(parseInt(hex.slice(i, i + 4), 16)) ?? "";
          out += " ";
        }
      }
    }
    return out;
  });
  const titleHex = /\/Title <([0-9a-fA-F]+)>/.exec(pdf.toString("latin1"))?.[1];
  const titleLit = /\/Title \(([^)]*)\)/.exec(pdf.toString("latin1"))?.[1];
  let title: string | null = titleLit ?? null;
  if (titleHex) {
    const bytes = Buffer.from(titleHex, "hex");
    title = bytes[0] === 0xfe && bytes[1] === 0xff ? bytes.subarray(2).swap16().toString("utf16le") : bytes.toString("latin1");
  }
  // Text runs are drawn word by word in places; compare without spaces too.
  return { pages: pageObjs.length, text, all: text.join("\n"), title };
}

/** True when `needle` appears in the text, ignoring the spaces between drawn runs. */
export const pdfHas = (info: PdfInfo, needle: string) => info.all.includes(needle) || info.all.replace(/\s+/g, "").includes(needle.replace(/\s+/g, ""));
