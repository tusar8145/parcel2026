import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import type { updateProfileSchema } from "@paira-express/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type AddressRole } from "../../generated/prisma/client";
import { toUserView } from "../auth/auth.service";
import type { createAddressSchema, updateAddressSchema } from "./accounts.schemas";

export const MAX_ADDRESSES = 50;

/** Same fields GET /auth/me reads, so PATCH /me returns an identical shape. */
const meSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  roles: { select: { role: true, merchantId: true, hubId: true, merchant: { select: { name: true, type: true } }, hub: { select: { name: true } } } },
  rider: { select: { id: true, code: true, hubId: true } },
} satisfies Prisma.UserSelect;

const addressSelect = {
  id: true,
  role: true,
  category: true,
  contactName: true,
  phone: true,
  street: true,
  area: true,
  zone: true,
  district: true,
  lat: true,
  lng: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AddressSelect;

export const isUniqueViolation = (error: unknown, field: string) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  JSON.stringify(error.meta ?? {}).includes(field);

export const emailInUse = () => conflict("EMAIL_IN_USE", "This email is already used by another account");

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── profile ──
  async me(userId: string) {
    return toUserView(await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: meSelect }));
  }

  async updateProfile(actor: UserActor, input: z.infer<typeof updateProfileSchema>, meta: RequestMeta) {
    if (input.email) {
      const owner = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
      if (owner && owner.id !== actor.userId) throw emailInUse();
    }
    try {
      await this.prisma.$transaction(async tx => {
        await tx.user.update({ where: { id: actor.userId }, data: { name: input.name, email: input.email } });
        await this.audit.record(actor, { action: "profile.update", entityType: "user", entityId: actor.userId, data: input }, meta, tx);
      });
    } catch (error) {
      // Lost a race with another account claiming the same email.
      if (isUniqueViolation(error, "email")) throw emailInUse();
      throw error;
    }
    return this.me(actor.userId);
  }

  // ── address book ──
  listAddresses(actor: UserActor, role?: AddressRole) {
    return this.prisma.address.findMany({
      where: { userId: actor.userId, role },
      select: addressSelect,
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    });
  }

  async createAddress(actor: UserActor, input: z.infer<typeof createAddressSchema>, meta: RequestMeta) {
    return this.prisma.$transaction(async tx => {
      await this.lockAddressBook(tx, actor.userId);
      if ((await tx.address.count({ where: { userId: actor.userId } })) >= MAX_ADDRESSES)
        throw new AppError("ADDRESS_LIMIT", `You can save up to ${MAX_ADDRESSES} addresses. Delete one to add another.`, HttpStatus.UNPROCESSABLE_ENTITY);
      if (input.isDefault) await this.clearDefault(tx, actor.userId, input.role);
      const address = await tx.address.create({ data: { ...input, userId: actor.userId }, select: addressSelect });
      await this.audit.record(actor, { action: "address.create", entityType: "address", entityId: address.id, data: { role: input.role, isDefault: input.isDefault } }, meta, tx);
      return address;
    });
  }

  async updateAddress(actor: UserActor, id: string, input: z.infer<typeof updateAddressSchema>, meta: RequestMeta) {
    return this.prisma.$transaction(async tx => {
      await this.lockAddressBook(tx, actor.userId);
      const current = await this.ownAddress(tx, actor.userId, id);
      const role = input.role ?? current.role;
      const isDefault = input.isDefault ?? current.isDefault;
      if (isDefault && (input.isDefault || role !== current.role)) await this.clearDefault(tx, actor.userId, role, id);
      const address = await tx.address.update({ where: { id }, data: input, select: addressSelect });
      await this.audit.record(actor, { action: "address.update", entityType: "address", entityId: id, data: { fields: Object.keys(input), role, isDefault } }, meta, tx);
      return address;
    });
  }

  async deleteAddress(actor: UserActor, id: string, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const current = await this.ownAddress(tx, actor.userId, id);
      await tx.address.delete({ where: { id } });
      await this.audit.record(actor, { action: "address.delete", entityType: "address", entityId: id, data: { role: current.role } }, meta, tx);
    });
  }

  /** Other users' addresses are reported as missing, not forbidden, so ids can't be probed. */
  private async ownAddress(db: Db, userId: string, id: string) {
    const address = await db.address.findFirst({ where: { id, userId }, select: { id: true, role: true, isDefault: true } });
    if (!address) throw notFound("Address");
    return address;
  }

  private clearDefault(db: Db, userId: string, role: AddressRole, exceptId?: string) {
    return db.address.updateMany({ where: { userId, role, isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) }, data: { isDefault: false } });
  }

  /** Serialises concurrent writes to one user's book so the limit and single-default rule hold. */
  private async lockAddressBook(db: Db, userId: string) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`address-book:${userId}`}))`;
  }
}
