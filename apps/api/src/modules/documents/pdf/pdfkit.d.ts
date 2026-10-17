// Minimal typings for the parts of pdfkit (0.20, MIT) the documents module uses.
declare module "pdfkit" {
  import { Readable } from "node:stream";

  namespace PDFKit {
    interface DocumentOptions {
      size?: string | [number, number];
      layout?: "portrait" | "landscape";
      margin?: number;
      margins?: { top: number; bottom: number; left: number; right: number };
      bufferPages?: boolean;
      autoFirstPage?: boolean;
      compress?: boolean;
      info?: { Title?: string; Author?: string; Subject?: string; Keywords?: string; Creator?: string; Producer?: string; CreationDate?: Date };
      lang?: string;
      displayTitle?: boolean;
    }
    interface TextOptions {
      lineBreak?: boolean;
      width?: number;
      height?: number;
      align?: "left" | "center" | "right" | "justify";
      baseline?: "alphabetic" | "top" | "middle" | "bottom" | "hanging" | number;
      characterSpacing?: number;
      underline?: boolean;
      link?: string;
    }
    interface Page {
      width: number;
      height: number;
    }
  }

  class PDFDocument extends Readable {
    constructor(options?: PDFKit.DocumentOptions);
    page: PDFKit.Page;
    addPage(options?: PDFKit.DocumentOptions): this;
    switchToPage(n: number): this;
    bufferedPageRange(): { start: number; count: number };
    flushPages(): void;
    end(): void;
    registerFont(name: string, src: Buffer | string): this;
    font(name: string): this;
    fontSize(size: number): this;
    widthOfString(text: string, options?: PDFKit.TextOptions): number;
    currentLineHeight(includeGap?: boolean): number;
    text(text: string, x?: number, y?: number, options?: PDFKit.TextOptions): this;
    fillColor(color: string, opacity?: number): this;
    strokeColor(color: string, opacity?: number): this;
    fillOpacity(opacity: number): this;
    lineWidth(w: number): this;
    dash(length: number, options?: { space?: number }): this;
    undash(): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    rect(x: number, y: number, w: number, h: number): this;
    roundedRect(x: number, y: number, w: number, h: number, r: number): this;
    circle(x: number, y: number, r: number): this;
    path(svgPath: string): this;
    fill(color?: string): this;
    stroke(color?: string): this;
    fillAndStroke(fill?: string, stroke?: string): this;
    save(): this;
    restore(): this;
    translate(x: number, y: number): this;
    scale(x: number, y?: number): this;
    rotate(angle: number, options?: { origin?: [number, number] }): this;
    clip(): this;
    link(x: number, y: number, w: number, h: number, url: string): this;
  }

  export = PDFDocument;
}
