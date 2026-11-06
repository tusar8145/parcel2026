import { HttpStatus, Injectable } from "@nestjs/common";
import { z } from "zod";
import { DEFAULT_WEBSITE, type SignupKey, type WebsiteSettings } from "@delivery-fast/shared";
import { AuditService } from "../../common/audit.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError } from "../../common/errors";
import { PrismaService } from "../../common/prisma.service";
import type { Prisma } from "../../generated/prisma/client";
import { BrandingService } from "../branding/branding.service";

const KEY = "website-settings";
/** Sign-in and booking read the switches on every request; one instance may be this far behind another. */
const CACHE_MS = 5_000;

const page = z.object({
  title: z.string().trim().min(2, "Enter the page title").max(120),
  intro: z.string().trim().max(400),
  body: z.string().trim().min(10, "Enter the page text").max(40_000),
});

/** PUT /website: only what is sent changes. */
export const websiteSettingsSchema = z.object({
  signups: z.object({ merchant: z.boolean(), rider: z.boolean(), franchise: z.boolean(), customer: z.boolean() }).partial().optional(),
  sendParcel: z.boolean().optional(),
  privacy: page.optional(),
  terms: page.optional(),
  faqs: z
    .array(z.object({ id: z.string().trim().min(1).max(40), question: z.string().trim().min(3, "Enter the question").max(200), answer: z.string().trim().min(3, "Enter the answer").max(2_000) }))
    .max(100, "At most 100 FAQs")
    .optional(),
});

const CLOSED: Record<SignupKey, string> = {
  merchant: "Merchant applications are closed right now.",
  rider: "Rider applications are closed right now.",
  franchise: "Franchise applications are closed right now.",
  customer: "Customer sign-up is closed right now.",
};

@Injectable()
export class WebsiteService {
  private cached: { at: number; value: WebsiteSettings & { edited: { privacy: boolean; terms: boolean } } } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly branding: BrandingService,
  ) {}

  private async read() {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
    const saved = (row?.value ?? {}) as Partial<WebsiteSettings>;
    const value = {
      ...DEFAULT_WEBSITE,
      ...saved,
      signups: { ...DEFAULT_WEBSITE.signups, ...saved.signups },
      edited: { privacy: !!saved.privacy, terms: !!saved.terms },
    };
    this.cached = { at: Date.now(), value };
    return value;
  }

  /** The switches only (small: the website reads them on every page). */
  async status() {
    const { signups, sendParcel } = await this.read();
    return { signups, sendParcel };
  }

  /** Everything the public pages show. */
  async view() {
    const [site, branding] = await Promise.all([this.read(), this.branding.view()]);
    return { ...site, about: branding.about };
  }

  /** For the editor: the same, with the original texts to go back to. */
  async admin() {
    return { ...(await this.view()), defaults: { privacy: DEFAULT_WEBSITE.privacy, terms: DEFAULT_WEBSITE.terms, faqs: DEFAULT_WEBSITE.faqs } };
  }

  async save(actor: Actor, input: z.infer<typeof websiteSettingsSchema>, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const row = await tx.setting.findUnique({ where: { key: KEY } });
      const prev = (row?.value ?? {}) as Partial<WebsiteSettings>;
      const value = { ...prev, ...input, signups: { ...prev.signups, ...input.signups } } as unknown as Prisma.InputJsonObject;
      await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
      await this.audit.record(actor, { action: "website.settings_update", entityType: "setting", entityId: KEY, data: { changed: Object.keys(input), signups: input.signups, sendParcel: input.sendParcel } }, meta, tx);
    });
    this.cached = null;
    return this.admin();
  }

  async isOpen(key: SignupKey) {
    return (await this.read()).signups[key];
  }

  async assertOpen(key: SignupKey) {
    if (!(await this.isOpen(key))) throw new AppError("SIGNUP_CLOSED", CLOSED[key], HttpStatus.FORBIDDEN);
  }

  async assertSendParcelOpen() {
    if (!(await this.read()).sendParcel) throw new AppError("SEND_PARCEL_CLOSED", "Sending a parcel from the website is turned off right now.", HttpStatus.FORBIDDEN);
  }
}
