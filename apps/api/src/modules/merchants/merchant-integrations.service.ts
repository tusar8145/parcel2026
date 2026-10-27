import { assertMerchantService } from "../packages/package-resolver";
import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { encrypt, randomToken, sha256 } from "../../common/crypto";
import { AppError, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { API_KEY_PREFIX } from "../../common/auth/auth.guard";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { WebhooksService } from "../notifications/webhooks.service";
import { MerchantsService, advisoryLock } from "./merchants.service";
import { apiKeyView, deliveryView, webhookView } from "./merchant.views";
import type { createApiKeySchema, createWebhookSchema, listDeliveriesQuerySchema, pageWithSelectorSchema, updateWebhookSchema } from "./merchants.schemas";

export const MAX_ACTIVE_API_KEYS = 10;
export const MAX_WEBHOOKS = 5;
const newWebhookSecret = () => `whsec_${randomToken(24)}`;

@Injectable()
export class MerchantIntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly merchants: MerchantsService,
    private readonly webhooks: WebhooksService,
  ) {}

  // ───────────── API keys ─────────────

  private async activeOwnMerchant(actor: Actor, merchantId: string | undefined) {
    const m = await this.merchants.resolveOwn(actor, merchantId, { ownerOnly: true });
    if (m.status !== "ACTIVE") throw new AppError("MERCHANT_NOT_ACTIVE", "API keys are available once your merchant account is approved and active", HttpStatus.FORBIDDEN);
    return m;
  }

  async listApiKeys(actor: Actor, query: z.infer<typeof pageWithSelectorSchema>) {
    const m = await this.activeOwnMerchant(actor, query.merchantId);
    const rows = await this.prisma.apiKey.findMany({ where: { merchantId: m.id }, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(apiKeyView), nextCursor: page.nextCursor };
  }

  async createApiKey(actor: Actor, merchantId: string | undefined, input: z.infer<typeof createApiKeySchema>, meta: RequestMeta) {
    const m = await this.activeOwnMerchant(actor, merchantId);
    await assertMerchantService(this.prisma, m.id, "integration.api");
    const now = new Date();
    const { record, key } = await this.prisma.$transaction(async tx => {
      await advisoryLock(tx, `merchant-api-keys:${m.id}`);
      // Policy (super admin → KYC policy): API keys may need verified business documents.
      await this.merchants.kyc?.assertAllowed(tx, m, "apiKeys");
      const active = await tx.apiKey.count({ where: { merchantId: m.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
      if (active >= MAX_ACTIVE_API_KEYS)
        throw new AppError("API_KEY_LIMIT", `You can have at most ${MAX_ACTIVE_API_KEYS} active API keys. Revoke one you no longer use.`, HttpStatus.UNPROCESSABLE_ENTITY);
      // The 12-character prefix is unique; regenerate on the (very unlikely) collision.
      let key = "";
      for (let i = 0; i < 5 && !key; i++) {
        const candidate = API_KEY_PREFIX + randomToken(32);
        if (!(await tx.apiKey.findUnique({ where: { prefix: candidate.slice(0, 12) }, select: { id: true } }))) key = candidate;
      }
      if (!key) throw new Error("Could not generate a unique API key");
      const record = await tx.apiKey.create({
        data: { merchantId: m.id, name: input.name, prefix: key.slice(0, 12), keyHash: sha256(key), createdById: (actor as UserActor).userId, expiresAt: input.expiresAt, scopes: input.scopes ?? [] },
      });
      await this.audit.record(actor, { action: "api_key.create", entityType: "api_key", entityId: record.id, data: { merchantId: m.id, name: input.name, prefix: record.prefix, scopes: record.scopes } }, meta, tx);
      return { record, key };
    });
    return { ...apiKeyView(record), key, message: "Copy this key now. For your security it won't be shown again." };
  }

  /** Allowed even when the merchant isn't active: revoking only ever reduces access. */
  async revokeApiKey(actor: Actor, merchantId: string | undefined, id: string, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId, { ownerOnly: true });
    const key = await this.prisma.apiKey.findFirst({ where: { id, merchantId: m.id } });
    if (!key) throw notFound("API key");
    if (key.revokedAt) return apiKeyView(key);
    const revoked = await this.prisma.$transaction(async tx => {
      const updated = await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      await this.audit.record(actor, { action: "api_key.revoke", entityType: "api_key", entityId: id, data: { merchantId: m.id, prefix: key.prefix } }, meta, tx);
      return updated;
    });
    return apiKeyView(revoked);
  }

  // ───────────── webhooks ─────────────

  private async ownEndpoint(actor: Actor, merchantId: string | undefined, id: string) {
    const m = await this.merchants.resolveOwn(actor, merchantId, { ownerOnly: true });
    const endpoint = await this.prisma.webhookEndpoint.findFirst({ where: { id, merchantId: m.id } });
    if (!endpoint) throw notFound("Webhook endpoint");
    return { merchant: m, endpoint };
  }

  async listWebhooks(actor: Actor, merchantId: string | undefined) {
    const m = await this.merchants.resolveOwn(actor, merchantId, { ownerOnly: true });
    const rows = await this.prisma.webhookEndpoint.findMany({ where: { merchantId: m.id }, orderBy: { id: "desc" } });
    return { items: rows.map(webhookView) };
  }

  async createWebhook(actor: Actor, merchantId: string | undefined, input: z.infer<typeof createWebhookSchema>, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId, { ownerOnly: true });
    await assertMerchantService(this.prisma, m.id, "integration.webhooks");
    await this.webhooks.assertDeliverableUrl(input.url);
    const secret = newWebhookSecret();
    const endpoint = await this.prisma.$transaction(async tx => {
      await advisoryLock(tx, `merchant-webhooks:${m.id}`);
      if ((await tx.webhookEndpoint.count({ where: { merchantId: m.id } })) >= MAX_WEBHOOKS)
        throw new AppError("WEBHOOK_LIMIT", `You can have at most ${MAX_WEBHOOKS} webhook endpoints. Delete one first.`, HttpStatus.UNPROCESSABLE_ENTITY);
      const created = await tx.webhookEndpoint.create({ data: { merchantId: m.id, url: input.url, events: input.events, active: input.active, secretEncrypted: encrypt(secret) } });
      await this.audit.record(actor, { action: "webhook.create", entityType: "webhook_endpoint", entityId: created.id, data: { merchantId: m.id, url: input.url, events: input.events } }, meta, tx);
      return created;
    });
    return { ...webhookView(endpoint), secret, message: "Store this signing secret now. It won't be shown again." };
  }

  async updateWebhook(actor: Actor, merchantId: string | undefined, id: string, input: z.infer<typeof updateWebhookSchema>, meta: RequestMeta) {
    const { merchant } = await this.ownEndpoint(actor, merchantId, id);
    if (input.url) await this.webhooks.assertDeliverableUrl(input.url);
    const endpoint = await this.prisma.$transaction(async tx => {
      const updated = await tx.webhookEndpoint.update({ where: { id }, data: input });
      await this.audit.record(actor, { action: "webhook.update", entityType: "webhook_endpoint", entityId: id, data: { merchantId: merchant.id, ...input } }, meta, tx);
      return updated;
    });
    return webhookView(endpoint);
  }

  async deleteWebhook(actor: Actor, merchantId: string | undefined, id: string, meta: RequestMeta) {
    const { merchant, endpoint } = await this.ownEndpoint(actor, merchantId, id);
    await this.prisma.$transaction(async tx => {
      await tx.webhookEndpoint.delete({ where: { id } });
      await this.audit.record(actor, { action: "webhook.delete", entityType: "webhook_endpoint", entityId: id, data: { merchantId: merchant.id, url: endpoint.url } }, meta, tx);
    });
  }

  async rotateWebhookSecret(actor: Actor, merchantId: string | undefined, id: string, meta: RequestMeta) {
    const { merchant } = await this.ownEndpoint(actor, merchantId, id);
    const secret = newWebhookSecret();
    const endpoint = await this.prisma.$transaction(async tx => {
      const updated = await tx.webhookEndpoint.update({ where: { id }, data: { secretEncrypted: encrypt(secret) } });
      await this.audit.record(actor, { action: "webhook.rotate_secret", entityType: "webhook_endpoint", entityId: id, data: { merchantId: merchant.id } }, meta, tx);
      return updated;
    });
    return { ...webhookView(endpoint), secret, message: "Deliveries are now signed with this secret. Store it now; it won't be shown again." };
  }

  async listDeliveries(actor: Actor, id: string, query: z.infer<typeof listDeliveriesQuerySchema>) {
    await this.ownEndpoint(actor, query.merchantId, id);
    const rows = await this.prisma.webhookDelivery.findMany({ where: { endpointId: id, state: query.state }, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(deliveryView), nextCursor: page.nextCursor };
  }

  async sendTest(actor: Actor, merchantId: string | undefined, id: string, meta: RequestMeta) {
    const { merchant, endpoint } = await this.ownEndpoint(actor, merchantId, id);
    if (!endpoint.active) throw new AppError("WEBHOOK_INACTIVE", "Turn this endpoint on before sending a test", HttpStatus.UNPROCESSABLE_ENTITY);
    const delivery = await this.prisma.$transaction(async tx => {
      const created = await tx.webhookDelivery.create({
        data: {
          endpointId: id,
          event: "webhook.test",
          payload: { event: "webhook.test", createdAt: new Date().toISOString(), data: { message: "Test delivery from Paira Express", merchantCode: merchant.code, endpointId: id } },
        },
      });
      await this.audit.record(actor, { action: "webhook.test", entityType: "webhook_endpoint", entityId: id, data: { merchantId: merchant.id, deliveryId: created.id } }, meta, tx);
      return created;
    });
    await this.webhooks.flush([delivery.id]);
    return deliveryView(delivery);
  }
}
