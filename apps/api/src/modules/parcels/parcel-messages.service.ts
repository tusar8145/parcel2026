import { Injectable } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../../common/prisma.service";
import type { Actor } from "../../common/auth/actor";
import { notFound } from "../../common/errors";
import { definitionOf } from "../notifications/catalog";
import { opsHubScope } from "./ops-scope";

/** Messages per parcel in the log (newest first). */
const LIMIT = 100;
/** Older messages (sent before outbox rows carried the tracking ID) are matched by text within this window. */
const LEGACY_WINDOW_DAYS = 120;

/** "+8801712345678" → "+880 17•• •••678"; "rahim@example.com" → "ra•••@example.com". */
export function maskRecipient(channel: string, to: string): string {
  if (channel === "EMAIL") {
    const [user, domain] = to.split("@");
    if (!domain) return "•••";
    return `${user.slice(0, Math.min(2, user.length))}•••@${domain}`;
  }
  const digits = to.replace(/\D/g, "");
  if (digits.length < 6) return "•••";
  const local = digits.startsWith("880") ? digits.slice(3) : digits;
  return `+880 ${local.slice(0, 2)}•• •••${local.slice(-3)}`;
}

/**
 * Message text with security codes hidden: for events that carry a code (delivery code, OTPs,
 * collection codes) every 4–8 digit number is replaced, so a code never shows in the log, even
 * when an administrator has reworded the template.
 */
export function maskBody(template: string, body: string): string {
  const def = definitionOf(template);
  const hasCode = !def || def.vars.some(v => /code|otp|pin|token/i.test(v)) || /otp|code/i.test(template);
  let text = body;
  if (hasCode) text = text.replace(/(?<![\w-]|\d[,.])\d{4,8}(?![\w-]|[,.]\d)/g, "••••");
  // Links with tokens (verification / access links) are cut at the query string.
  text = text.replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, "$1?…");
  return text;
}

@Injectable()
export class ParcelMessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Staff with parcel:read:any (hub operators: their hubs' parcels, like printed documents).
   * The parcel's SMS / email messages from the outbox: channel, event, masked recipient, state,
   * times, provider and the last error; codes in the text are masked.
   */
  async list(actor: Actor, trackingId: string) {
    const parcel = await this.prisma.parcel.findFirst({
      where: { AND: [{ trackingId: trackingId.trim().toUpperCase() }, await this.hubScope(actor)] },
      select: { trackingId: true, createdAt: true },
    });
    if (!parcel) throw notFound("Parcel");
    const until = new Date(parcel.createdAt.getTime() + LEGACY_WINDOW_DAYS * 86_400_000);
    const rows = await this.prisma.outboxMessage.findMany({
      where: {
        OR: [
          { trackingId: parcel.trackingId },
          // Messages queued before the outbox carried the tracking ID.
          { trackingId: null, createdAt: { gte: parcel.createdAt, lte: until }, body: { contains: parcel.trackingId } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, channel: true, to: true, template: true, subject: true, body: true, state: true, attempts: true, lastError: true, sentAt: true, createdAt: true, provider: true },
    });
    return {
      trackingId: parcel.trackingId,
      items: rows.map(m => ({
        id: m.id,
        channel: m.channel,
        event: m.template,
        eventLabel: definitionOf(m.template)?.label ?? m.template,
        to: maskRecipient(m.channel, m.to),
        subject: m.subject,
        text: maskBody(m.template, m.body),
        state: m.state,
        attempts: m.attempts,
        provider: m.provider,
        lastError: m.lastError ? m.lastError.slice(0, 300) : null,
        queuedAt: m.createdAt,
        sentAt: m.sentAt,
      })),
    };
  }

  /** Hub operators: parcels their hubs handle (held at, dropped off at, collected at, their riders, their zones). */
  private async hubScope(actor: Actor): Promise<Prisma.ParcelWhereInput> {
    const scope = opsHubScope(actor);
    if (!scope) return {};
    const zones = await this.prisma.deliveryZone.findMany({ where: { hubId: { in: scope }, active: true }, select: { district: true, name: true } });
    const zoneMatch = (district: "pickupDistrict" | "deliveryDistrict", zone: "pickupZone" | "deliveryZone") =>
      zones.map(z => ({ [district]: { equals: z.district, mode: "insensitive" as const }, [zone]: { equals: z.name, mode: "insensitive" as const } }));
    return {
      OR: [
        { currentHubId: { in: scope } },
        { dropOffHubId: { in: scope } },
        { collectHubId: { in: scope } },
        { pickupRider: { hubId: { in: scope } } },
        { deliveryRider: { hubId: { in: scope } } },
        ...(zones.length ? [{ OR: zoneMatch("pickupDistrict", "pickupZone") }, { OR: zoneMatch("deliveryDistrict", "deliveryZone") }] : []),
      ],
    };
  }
}
