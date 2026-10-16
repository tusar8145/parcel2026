import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import { notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import { ParcelsService } from "../parcels/parcels.service";

/** Proof of delivery for anyone who can see the parcel (sender, merchant, recipient account, rider, staff). */
@Injectable()
export class ProofService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
  ) {}

  async forParcel(actor: Actor, trackingId: string) {
    const parcel = await this.prisma.parcel.findFirst({
      where: { AND: [{ trackingId: trackingId.trim().toUpperCase() }, this.parcels.scope(actor)] },
      select: {
        trackingId: true,
        status: true,
        deliveredAt: true,
        deliveryRider: { select: { code: true, user: { select: { name: true } } } },
        proof: { include: { file: { select: { id: true, mimeType: true, sizeBytes: true } } } },
      },
    });
    if (!parcel) throw notFound("Parcel");
    const p = parcel.proof;
    if (!p) throw notFound("Proof of delivery");
    return {
      trackingId: parcel.trackingId,
      status: parcel.status,
      deliveredAt: parcel.deliveredAt,
      method: p.method,
      receivedBy: p.receivedBy,
      otpVerified: p.otpVerified,
      note: p.note,
      /** When the rider captured the proof on their device; may be earlier than recordedAt if it was synced after being offline. */
      capturedAt: p.capturedAt,
      recordedAt: p.createdAt,
      location: p.lat !== null && p.lng !== null ? { lat: p.lat, lng: p.lng, accuracy: p.accuracy } : null,
      rider: parcel.deliveryRider ? { code: parcel.deliveryRider.code, name: parcel.deliveryRider.user.name } : null,
      /** Signature or photo. Fetch with the same credentials (`Accept: application/json` returns a data URL). */
      image: p.file ? { fileId: p.file.id, url: `/api/v1/files/${p.file.id}`, mimeType: p.file.mimeType, sizeBytes: p.file.sizeBytes } : null,
    };
  }
}
