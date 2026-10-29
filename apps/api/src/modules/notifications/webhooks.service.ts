import { Injectable, Logger } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PrismaService, type Db } from "../../common/prisma.service";
import { QueueService } from "../../common/queues";
import { decrypt, hmacSha256 } from "../../common/crypto";
import { AppError } from "../../common/errors";
import { isProduction } from "../../config/env";
import type { Prisma } from "../../generated/prisma/client";
import { merchantHasService } from "../packages/package-resolver";

export const WEBHOOK_EVENTS = [
  "pickup.requested",
  "pickup.scheduled",
  "pickup.completed",
  "shipment.status_updated",
  "shipment.delivered",
  "shipment.cancelled",
  // pickups
  "pickup.cancelled",
  "pickup.missed",
  // shipments
  "shipment.out_for_delivery",
  "shipment.delivery_failed",
  "shipment.return_requested",
  "shipment.return_scheduled",
  "shipment.returned",
  "shipment.return_received",
  // money
  "cod.settled",
  "invoice.issued",
  // hub drop-off (appended)
  "shipment.intake_changed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip: string) => (isIP(ip) === 6 ? /^(::1|fc|fd|fe80)/i.test(ip) || ip.startsWith("::ffff:127.") : PRIVATE_V4.some(r => r.test(ip)));

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  /** In production only public HTTPS endpoints are allowed (SSRF protection). */
  async assertDeliverableUrl(raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError("INVALID_WEBHOOK_URL", "Enter a full URL, e.g. https://example.com/webhooks/pairaexpress", 422);
    }
    if (!isProduction()) return;
    if (url.protocol !== "https:") throw new AppError("INVALID_WEBHOOK_URL", "Webhook URLs must use https", 422);
    const addresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true }).catch(() => [])).map(a => a.address);
    if (!addresses.length || addresses.some(isPrivate)) throw new AppError("INVALID_WEBHOOK_URL", "Webhook URL must resolve to a public address", 422);
  }

  /** Records deliveries for every subscribed endpoint inside the caller's transaction. */
  async emit(db: Db, merchantId: string | null | undefined, event: WebhookEvent, data: Prisma.InputJsonValue): Promise<string[]> {
    if (!merchantId) return [];
    const endpoints = await db.webhookEndpoint.findMany({ where: { merchantId, active: true, events: { has: event } }, select: { id: true } });
    // Service packages: no webhook deliveries for a merchant whose package has no webhooks.
    if (endpoints.length && !(await merchantHasService(db, merchantId, "integration.webhooks"))) return [];
    const ids: string[] = [];
    for (const endpoint of endpoints) {
      const delivery = await db.webhookDelivery.create({
        data: { endpointId: endpoint.id, event, payload: { event, createdAt: new Date().toISOString(), data } },
      });
      ids.push(delivery.id);
    }
    return ids;
  }

  async flush(ids: string[]) {
    await Promise.all(
      ids.map(id =>
        this.queues
          .send("webhooks", id)
          .catch(error => this.logger.warn({ err: error, id }, "Could not queue webhook delivery")),
      ),
    );
  }

  /** Called by the worker. Signature: X-PairaExpress-Signature: t=<unix>,v1=<hex hmac of "t.body"> */
  async deliver(id: string) {
    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id }, include: { endpoint: true } });
    if (!delivery || delivery.state === "SUCCEEDED" || !delivery.endpoint.active) return;
    if (!(await merchantHasService(this.prisma, delivery.endpoint.merchantId, "integration.webhooks"))) {
      await this.prisma.webhookDelivery.update({ where: { id }, data: { state: "FAILED", lastError: "SERVICE_NOT_IN_PACKAGE: Webhook" } });
      return;
    }
    const body = JSON.stringify({ id: delivery.id, ...(delivery.payload as object) });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = hmacSha256(decrypt(delivery.endpoint.secretEncrypted), `${timestamp}.${body}`);
    let responseCode: number | undefined;
    try {
      await this.assertDeliverableUrl(delivery.endpoint.url);
      const response = await fetch(delivery.endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "PairaExpress-Webhooks/1.0",
          "x-pairaexpress-event": delivery.event,
          "x-pairaexpress-delivery": delivery.id,
          "x-pairaexpress-signature": `t=${timestamp},v1=${signature}`,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      responseCode = response.status;
      if (!response.ok) throw new Error(`Endpoint responded ${response.status}`);
      await this.prisma.webhookDelivery.update({
        where: { id },
        data: { state: "SUCCEEDED", responseCode, deliveredAt: new Date(), attempts: { increment: 1 }, lastError: null },
      });
    } catch (error) {
      await this.prisma.webhookDelivery.update({
        where: { id },
        data: { attempts: { increment: 1 }, responseCode, lastError: String((error as Error).message).slice(0, 500) },
      });
      throw error;
    }
  }

  async markFailed(id: string) {
    await this.prisma.webhookDelivery.update({ where: { id }, data: { state: "FAILED" } }).catch(() => undefined);
  }
}
