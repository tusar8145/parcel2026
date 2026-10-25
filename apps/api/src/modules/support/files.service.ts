import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import { StorageService } from "../../common/storage.service";
import { notFound } from "../../common/errors";
import { merchantIdsOf, type Actor } from "../../common/auth/actor";
import { isFinanceStaff } from "../finance/finance.scope";
import { ParcelsService } from "../parcels/parcels.service";
import { isSupportStaff } from "./support.service";
import { isMoneyStaff, ownAccountIds } from "../money/access";

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly parcels: ParcelsService,
  ) {}

  /** Returns the file and its bytes if the actor may read it; 404 otherwise, so ids don't leak. */
  async download(actor: Actor, id: string) {
    const file = await this.prisma.storedFile.findUnique({
      where: { id },
      include: {
        message: { select: { internal: true, ticket: { select: { requesterId: true } } } },
        proofs: { select: { parcelId: true } },
        dispute: { select: { raisedById: true, merchantId: true } },
      },
    });
    if (!file || !(await this.canRead(actor, file, id))) throw notFound("File");
    let data: Buffer;
    try {
      data = await this.storage.read(file.storageKey);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound("File");
      throw err;
    }
    return { file, data };
  }

  private async canRead(
    actor: Actor,
    file: {
      uploadedById: string | null;
      message: { internal: boolean; ticket: { requesterId: string } } | null;
      proofs: { parcelId: string }[];
      dispute: { raisedById: string; merchantId: string | null } | null;
    },
    id: string,
  ) {
    const userId = actor.kind === "user" ? actor.userId : null;
    if (userId && file.uploadedById === userId) return true;
    if (file.message) {
      if (isSupportStaff(actor)) return true;
      if (userId && !file.message.internal && file.message.ticket.requesterId === userId) return true;
    }
    if (file.dispute) {
      // Dispute evidence: finance / support staff, whoever raised it, and the merchant's owners.
      if (actor.permissions.has("finance:manage") || actor.permissions.has("support:manage") || (actor.permissions.has("finance:read") && isFinanceStaff(actor))) return true;
      if (userId && file.dispute.raisedById === userId) return true;
      if (file.dispute.merchantId && merchantIdsOf(actor).includes(file.dispute.merchantId)) return true;
    }
    // Accounts: a settlement's / payment's receipt (money staff and the account's owner), a hub transfer's proof (hub staff).
    const [payout, payment, transfer] = await Promise.all([
      this.prisma.payout.findFirst({ where: { proofFileId: id }, select: { accountId: true } }),
      this.prisma.accountPayment.findFirst({ where: { proofFileId: id }, select: { accountId: true } }),
      this.prisma.hubTransfer.findFirst({ where: { proofFileId: id }, select: { id: true } }),
    ]);
    const accountId = payout?.accountId ?? payment?.accountId;
    if (accountId) {
      if (await isMoneyStaff(this.prisma, actor)) return true;
      if (actor.kind === "user" && (await ownAccountIds(this.prisma, actor)).includes(accountId)) return true;
    }
    if (transfer && actor.permissions.has("cod:receive")) return true;
    if (file.proofs.length) {
      const visible = await this.prisma.parcel.count({ where: { AND: [{ id: { in: file.proofs.map(p => p.parcelId) } }, this.parcels.scope(actor)] } });
      if (visible > 0) return true;
    }
    return false;
  }
}
