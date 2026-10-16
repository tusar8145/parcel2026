import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { StorageService } from "../../common/storage.service";
import { RealtimeService } from "../../common/realtime.service";
import { AppError, conflict, notFound } from "../../common/errors";
import { actorLabel, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import type { Merchant, MerchantKycDocument, StoredFile } from "../../generated/prisma/client";
import { MerchantsService } from "./merchants.service";
import { KYC_DOCUMENT_TYPES, kycPolicySchema, type KycDocumentType, type KycPolicy, type kycReviewSchema, type uploadKycDocumentSchema } from "./merchants.schemas";

const POLICY_KEY = "merchants.kyc_policy";

/**
 * Defaults. API keys need approved KYC (server-to-server access to bookings and COD data);
 * COD payouts and activation are opt-in so existing settlement and onboarding flows keep
 * working until a super admin turns them on (Settings → KYC policy).
 */
export const DEFAULT_KYC_POLICY: KycPolicy = {
  requireForApiKeys: true,
  requireForCodPayouts: false,
  requireForActivation: false,
  requiredDocuments: ["TRADE_LICENSE", "NID_FRONT", "NID_BACK", "PAYOUT_PROOF"],
};

export const KYC_DOCUMENT_LABEL: Record<KycDocumentType, string> = {
  TRADE_LICENSE: "Trade license",
  NID_FRONT: "Owner NID (front)",
  NID_BACK: "Owner NID (back)",
  TIN_BIN: "TIN / BIN certificate",
  PAYOUT_PROOF: "Bank / bKash account proof",
};

export type KycCapability = "apiKeys" | "codPayouts" | "activation";
const CAPABILITY: Record<KycCapability, { key: keyof KycPolicy; label: string }> = {
  apiKeys: { key: "requireForApiKeys", label: "create API keys" },
  codPayouts: { key: "requireForCodPayouts", label: "receive COD payouts" },
  activation: { key: "requireForActivation", label: "be approved" },
};

/** The KYC policy (super admin setting, defaults filled in). */
export async function readKycPolicy(db: Db): Promise<KycPolicy> {
  const row = await db.setting.findUnique({ where: { key: POLICY_KEY } });
  const parsed = kycPolicySchema.safeParse({ ...DEFAULT_KYC_POLICY, ...((row?.value as object | null) ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_KYC_POLICY;
}

/**
 * Throws KYC_REQUIRED when the policy needs approved KYC for this capability and the merchant
 * hasn't got it. Standalone so other modules (e.g. finance payouts) can call it without a
 * module dependency.
 */
export async function assertKycAllowed(db: Db, merchant: Pick<Merchant, "id" | "kycStatus"> | string, capability: KycCapability) {
  const policy = await readKycPolicy(db);
  const rule = CAPABILITY[capability];
  if (!policy[rule.key]) return;
  const m = typeof merchant === "string" ? await db.merchant.findUnique({ where: { id: merchant }, select: { id: true, kycStatus: true } }) : merchant;
  if (!m) throw notFound("Merchant");
  if (m.kycStatus !== "APPROVED")
    throw new AppError("KYC_REQUIRED", `Verified business documents (KYC) are needed to ${rule.label}. Upload them under Settings → Business verification.`, HttpStatus.FORBIDDEN, {
      kycStatus: m.kycStatus,
      capability,
    });
}

type DocWithFile = MerchantKycDocument & { file: StoredFile };
const docView = (d: DocWithFile) => ({
  id: d.id,
  type: d.type,
  label: KYC_DOCUMENT_LABEL[d.type],
  filename: d.file.filename,
  mimeType: d.file.mimeType,
  sizeBytes: d.file.sizeBytes,
  uploadedAt: d.createdAt,
});

/**
 * Merchant KYC: owners upload documents and submit them; super admins (merchant:manage)
 * approve or reject with a reason. The policy says what approved KYC is needed for.
 */
@Injectable()
export class MerchantKycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
    private readonly merchants: MerchantsService,
  ) {
    merchants.kyc = this; // activation checks the KYC policy
  }

  // ───────────── policy ─────────────

  policy(db: Db = this.prisma): Promise<KycPolicy> {
    return readKycPolicy(db);
  }

  async setPolicy(actor: Actor, input: z.infer<typeof kycPolicySchema>, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: POLICY_KEY }, create: { key: POLICY_KEY, value: input }, update: { value: input } });
      await this.audit.record(actor, { action: "merchant.kyc_policy_update", entityType: "setting", entityId: POLICY_KEY, data: input }, meta, tx);
    });
    return this.policyView(input);
  }

  policyView(policy: KycPolicy) {
    return { ...policy, documentTypes: KYC_DOCUMENT_TYPES.map(type => ({ type, label: KYC_DOCUMENT_LABEL[type], required: policy.requiredDocuments.includes(type) })) };
  }

  /** Throws KYC_REQUIRED when the policy needs approved KYC for this and the merchant hasn't got it. */
  assertAllowed(db: Db, merchant: Pick<Merchant, "id" | "kycStatus"> | string, capability: KycCapability) {
    return assertKycAllowed(db, merchant, capability);
  }

  // ───────────── documents ─────────────

  private async currentDocs(merchantId: string) {
    return this.prisma.merchantKycDocument.findMany({ where: { merchantId, supersededAt: null }, include: { file: true }, orderBy: { createdAt: "asc" } });
  }

  private async summary(m: Merchant, opts: { staff: boolean }) {
    const [policy, docs, history] = await Promise.all([
      this.policy(),
      this.currentDocs(m.id),
      this.prisma.merchantNote.findMany({ where: { merchantId: m.id, kind: "KYC" }, orderBy: { createdAt: "desc" }, take: 20 }),
    ]);
    const missing = policy.requiredDocuments.filter(t => !docs.some(d => d.type === t));
    return {
      merchantId: m.id,
      status: m.kycStatus,
      submittedAt: m.kycSubmittedAt,
      reviewedAt: m.kycReviewedAt,
      rejectionReason: m.kycRejectionReason,
      documents: docs.map(docView),
      missing,
      canSubmit: !missing.length && (m.kycStatus === "NOT_SUBMITTED" || m.kycStatus === "REJECTED"),
      canUpload: m.kycStatus !== "APPROVED",
      policy: this.policyView(policy),
      history: history.map(n => ({ id: n.id, body: n.body, at: n.createdAt, by: opts.staff ? n.authorName : undefined })),
    };
  }

  async mine(actor: Actor, merchantId: string | undefined) {
    const m = await this.merchants.resolveOwn(actor, merchantId);
    return this.summary(m, { staff: false });
  }

  async forStaff(id: string) {
    const m = await this.prisma.merchant.findUnique({ where: { id } });
    if (!m) throw notFound("Merchant");
    return this.summary(m, { staff: true });
  }

  async upload(actor: Actor, merchantId: string | undefined, input: z.infer<typeof uploadKycDocumentSchema>, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId, { ownerOnly: true });
    if (m.kycStatus === "APPROVED") throw conflict("KYC_LOCKED", "Your documents are verified. Contact support to update a verified document.");
    const userId = actor.kind === "user" ? actor.userId : undefined;
    await this.prisma.$transaction(async tx => {
      const file = await this.storage.saveDataUrl(input.file, input.filename, userId, tx);
      await tx.merchantKycDocument.updateMany({ where: { merchantId: m.id, type: input.type, supersededAt: null }, data: { supersededAt: new Date() } });
      const doc = await tx.merchantKycDocument.create({ data: { merchantId: m.id, type: input.type, fileId: file.id, uploadedById: userId } });
      await this.audit.record(actor, { action: "merchant.kyc_upload", entityType: "merchant", entityId: m.id, data: { documentId: doc.id, type: input.type, fileId: file.id } }, meta, tx);
    });
    return this.mine(actor, m.id);
  }

  async submit(actor: Actor, merchantId: string | undefined, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId, { ownerOnly: true });
    const outbox: string[] = [];
    await this.prisma.$transaction(async tx => {
      const current = await tx.merchant.findUniqueOrThrow({ where: { id: m.id } });
      if (current.kycStatus === "PENDING") throw conflict("KYC_PENDING", "Your documents are already being reviewed");
      if (current.kycStatus === "APPROVED") throw conflict("KYC_LOCKED", "Your documents are already verified");
      const policy = await this.policy(tx);
      const docs = await tx.merchantKycDocument.findMany({ where: { merchantId: m.id, supersededAt: null }, select: { type: true } });
      const missing = policy.requiredDocuments.filter(t => !docs.some(d => d.type === t));
      if (missing.length)
        throw new AppError("KYC_INCOMPLETE", `Upload these documents first: ${missing.map(t => KYC_DOCUMENT_LABEL[t]).join(", ")}`, HttpStatus.UNPROCESSABLE_ENTITY, { missing });
      await tx.merchant.update({ where: { id: m.id }, data: { kycStatus: "PENDING", kycSubmittedAt: new Date(), kycRejectionReason: null } });
      outbox.push(...(await this.notifyStatus(tx, current, "PENDING")));
      await this.audit.record(actor, { action: "merchant.kyc_submit", entityType: "merchant", entityId: m.id, data: { documents: docs.map(d => d.type) } }, meta, tx);
    });
    await this.outbox.flush(outbox);
    this.publish(m.id);
    return this.mine(actor, m.id);
  }

  async review(actor: Actor, id: string, input: z.infer<typeof kycReviewSchema>, meta: RequestMeta) {
    const outbox: string[] = [];
    await this.prisma.$transaction(async tx => {
      const m = await tx.merchant.findUnique({ where: { id } });
      if (!m) throw notFound("Merchant");
      if (m.kycStatus !== "PENDING" && !(input.decision === "REJECT" && m.kycStatus === "APPROVED"))
        throw conflict("KYC_NOT_PENDING", m.kycStatus === "NOT_SUBMITTED" ? "The merchant hasn't submitted documents yet" : `KYC is already ${m.kycStatus.toLowerCase()}`);
      const approved = input.decision === "APPROVE";
      const now = new Date();
      await tx.merchant.update({
        where: { id },
        data: {
          kycStatus: approved ? "APPROVED" : "REJECTED",
          kycReviewedAt: now,
          kycReviewedById: actor.kind === "user" ? actor.userId : null,
          kycRejectionReason: approved ? null : input.reason,
        },
      });
      const body = approved ? `KYC approved${input.note ? `: ${input.note}` : ""}` : `KYC rejected: ${input.reason}`;
      await tx.merchantNote.create({ data: { merchantId: id, kind: "KYC", body, internal: false, authorId: actor.kind === "user" ? actor.userId : null, authorName: actorLabel(actor) } });
      outbox.push(...(await this.notifyStatus(tx, m, approved ? "APPROVED" : "REJECTED", approved ? undefined : input.reason)));
      await this.audit.record(actor, { action: approved ? "merchant.kyc_approve" : "merchant.kyc_reject", entityType: "merchant", entityId: id, data: approved ? { note: input.note } : { reason: input.reason } }, meta, tx);
    });
    await this.outbox.flush(outbox);
    this.publish(id);
    return this.forStaff(id);
  }

  /** The document's content as JSON with a data URL (clients keep the access token in memory). */
  async documentFile(merchantId: string, documentId: string) {
    const doc = await this.prisma.merchantKycDocument.findFirst({ where: { id: documentId, merchantId }, include: { file: true } });
    if (!doc) throw notFound("Document");
    let data: Buffer;
    try {
      data = await this.storage.read(doc.file.storageKey);
    } catch {
      throw notFound("Document file");
    }
    return { ...docView(doc), superseded: !!doc.supersededAt, dataUrl: `data:${doc.file.mimeType};base64,${data.toString("base64")}` };
  }

  async myDocumentFile(actor: Actor, merchantId: string | undefined, documentId: string) {
    const m = await this.merchants.resolveOwn(actor, merchantId, { ownerOnly: true });
    return this.documentFile(m.id, documentId);
  }

  private async notifyStatus(db: Db, m: Merchant, status: "PENDING" | "APPROVED" | "REJECTED", reason?: string) {
    const text = { PENDING: "Documents received, under review", APPROVED: "Verified", REJECTED: "Not approved" }[status];
    return this.notify.notify(db, {
      event: "merchant.kyc_status",
      to: { phone: m.contactPhone, email: m.contactEmail, name: m.contactName },
      vars: { businessName: m.name, status: text, details: reason },
    });
  }

  private publish(merchantId: string) {
    this.realtime.publish({ type: "merchant.updated", id: merchantId, merchantId, staffPermission: "merchant:read:any", data: { kyc: true } });
  }
}
