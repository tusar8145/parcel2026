import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { DEFAULT_BRANDING, withCompanyName, type Branding } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma } from "../../generated/prisma/client";
import { BRAND_STAR_PNG } from "../../common/brand-star";

const KEY = "branding";

/** An uploaded image as a data URL: PNG / JPEG / WebP / SVG (and ICO for the tab icon). */
const image = (maxBytes: number, label: string) =>
  z
    .string()
    .regex(/^data:image\/(png|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+=*$/, `${label}: use a PNG, JPEG, WebP or SVG image`)
    .refine(v => Math.floor(((v.length - v.indexOf(",") - 1) * 3) / 4) <= maxBytes, `${label} must be ${Math.round(maxBytes / 1024)} KB or smaller`);

const text = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`);
const url = z.union([z.literal(""), z.url({ protocol: /^https?$/, error: "Enter a full address starting with https://" }).max(300)]);

/** PUT /branding: every field optional (unchanged when left out); an image null removes it. */
export const brandingSchema = z.object({
  companyName: z.string().trim().min(2, "Enter the company name").max(80).optional(),
  legalName: text(120).optional(),
  tagline: text(160).optional(),
  website: url.optional(),
  contact: z.object({ phone: text(60), email: z.union([z.literal(""), z.email("Enter a valid email").max(120)]), address: text(240), hours: text(120) }).partial().optional(),
  social: z.object({ facebook: url, instagram: url, linkedin: url, youtube: url, whatsapp: url }).partial().optional(),
  about: z.object({ title: text(120), intro: text(400), body: text(40_000) }).partial().optional(),
  logo: image(400 * 1024, "The logo").nullable().optional(),
  icon: image(100 * 1024, "The tab icon").nullable().optional(),
});

interface Stored extends Partial<Omit<Branding, "contact" | "social" | "about">> {
  contact?: Partial<Branding["contact"]>;
  social?: Partial<Branding["social"]>;
  about?: Partial<Branding["about"]>;
  logo?: string | null;
  icon?: string | null;
}


const hashOf = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/**
 * White label: the company the platform runs for (Super admin › Branding & company). One settings row; the
 * images are kept in it as data URLs (a logo up to 400 KB, a tab icon up to 100 KB) and served from
 * GET /branding/logo and /branding/icon so pages cache them.
 */
@Injectable()
export class BrandingService {
  private cache: { at: number; stored: Stored } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async stored(): Promise<Stored> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.stored;
    const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
    const stored = ((row?.value ?? {}) as Stored) || {};
    this.cache = { at: Date.now(), stored };
    return stored;
  }

  /** The branding with the defaults filled in (no images). */
  async get(): Promise<Branding> {
    const s = await this.stored();
    const companyName = s.companyName || DEFAULT_BRANDING.companyName;
    return {
      companyName,
      legalName: s.legalName || companyName,
      tagline: s.tagline ?? DEFAULT_BRANDING.tagline,
      website: s.website ?? DEFAULT_BRANDING.website,
      contact: { ...DEFAULT_BRANDING.contact, ...(s.contact ?? {}) },
      social: { ...DEFAULT_BRANDING.social, ...(s.social ?? {}) },
      // Until super admin writes their own, the About page is Delivery Fast's, with the company's name in it.
      about: {
        title: s.about?.title && s.about.title !== DEFAULT_BRANDING.about.title ? s.about.title : `About ${companyName}`,
        intro: s.about?.intro || withCompanyName(DEFAULT_BRANDING.about.intro, companyName),
        body: s.about?.body || withCompanyName(DEFAULT_BRANDING.about.body, companyName),
      },
    };
  }

  /** GET /branding: what pages show, with the image addresses (versioned, so a new image shows at once). */
  async view() {
    const s = await this.stored();
    const b = await this.get();
    return {
      ...b,
      logoUrl: s.logo ? `/api/v1/branding/logo?v=${hashOf(s.logo)}` : null,
      iconUrl: `/api/v1/branding/icon?v=${s.icon ? hashOf(s.icon) : "default"}`,
      custom: Boolean(s.companyName && s.companyName !== "Delivery Fast"),
      defaults: DEFAULT_BRANDING,
    };
  }

  /** The logo or tab icon as bytes and type; the default icon when none was uploaded; null: no logo. */
  async image(which: "logo" | "icon"): Promise<{ body: Buffer; type: string; etag: string } | null> {
    const s = await this.stored();
    const dataUrl = s[which];
    if (!dataUrl) return which === "icon" ? { body: BRAND_STAR_PNG, type: "image/png", etag: `"default-icon"` } : null;
    const type = dataUrl.slice(5, dataUrl.indexOf(";"));
    return { body: Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"), type, etag: `"${hashOf(dataUrl)}"` };
  }

  async save(actor: Actor, input: z.infer<typeof brandingSchema>, meta: RequestMeta) {
    if (input.companyName !== undefined && !input.companyName.trim()) throw new AppError("NAME_REQUIRED", "Enter the company name", 422);
    await this.prisma.$transaction(async tx => {
      const row = await tx.setting.findUnique({ where: { key: KEY } });
      const prev = ((row?.value ?? {}) as Stored) || {};
      const next: Stored = {
        ...prev,
        ...(input.companyName !== undefined ? { companyName: input.companyName } : {}),
        ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
        ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
        ...(input.website !== undefined ? { website: input.website } : {}),
        ...(input.contact ? { contact: { ...(prev.contact ?? {}), ...input.contact } } : {}),
        ...(input.social ? { social: { ...(prev.social ?? {}), ...input.social } } : {}),
        ...(input.about ? { about: { ...(prev.about ?? {}), ...input.about } } : {}),
        ...(input.logo !== undefined ? { logo: input.logo } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
      };
      await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: next as Prisma.InputJsonValue }, update: { value: next as Prisma.InputJsonValue } });
      const changed = Object.keys(input).filter(k => (input as Record<string, unknown>)[k] !== undefined);
      await this.audit.record(actor, { action: "branding.update", entityType: "setting", entityId: KEY, data: { changed, companyName: next.companyName ?? null } }, meta, tx);
    });
    this.cache = null;
    return this.view();
  }
}
