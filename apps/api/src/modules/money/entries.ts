import type { Db } from "../../common/prisma.service";
import { Prisma, type AccountKind, type Parcel } from "../../generated/prisma/client";

/**
 * Statement lines a parcel adds by itself (ParcelWorkflowService.transition):
 * - DELIVERED: + COD the recipient paid (E-commerce, Customer; partial delivery = what was collected), − its delivery charge.
 * - RETURNED: − its return charge (none when waived).
 * Financial merchants never carry COD: only charges. Customer parcels count only with COD (it pays the charges). One line per parcel and type (the unique index), so a replay adds nothing.
 */
export async function postParcelEntries(db: Db, parcel: Parcel) {
  if (parcel.status !== "DELIVERED" && parcel.status !== "RETURNED") return;
  // Customer parcels only through COD: without COD the sender paid the charge when booking.
  if (!parcel.merchantId && !parcel.codAmount.gt(0)) return;
  const account = await accountForParcel(db, parcel);
  if (!account) return;
  const lines: Prisma.AccountEntryCreateManyInput[] = [];
  const base = { accountId: account.id, parcelId: parcel.id, trackingId: parcel.trackingId };
  if (parcel.status === "DELIVERED") {
    const cod = parcel.partialDelivery ? (parcel.codCollectedAmount ?? new Prisma.Decimal(0)) : parcel.codAmount;
    if (account.kind !== "FINANCIAL" && cod.gt(0))
      lines.push({ ...base, type: "COD", amount: cod, description: parcel.partialDelivery ? "COD collected (partial delivery)" : "COD collected" });
    if (parcel.totalCharge.gt(0)) lines.push({ ...base, type: "DELIVERY_CHARGE", amount: parcel.totalCharge.negated(), description: "Delivery charge" });
  } else {
    const charge = parcel.returnChargeWaived ? null : parcel.returnCharge;
    if (charge?.gt(0)) lines.push({ ...base, type: "RETURN_CHARGE", amount: charge.negated(), description: "Return charge" });
  }
  if (lines.length) await db.accountEntry.createMany({ data: lines, skipDuplicates: true });
}

/** The account a parcel's money belongs to: its merchant's, or the sender's (customer parcels with COD or charges). */
export async function accountForParcel(db: Db, parcel: Pick<Parcel, "merchantId" | "customerId" | "senderName" | "senderPhone">) {
  if (parcel.merchantId) return merchantAccount(db, parcel.merchantId);
  return customerAccount(db, { phone: parcel.senderPhone, name: parcel.senderName, customerId: parcel.customerId });
}

/** The merchant's account, created on first use (E-commerce or Financial from the merchant's type). */
export async function merchantAccount(db: Db, merchantId: string) {
  const found = await db.account.findUnique({ where: { merchantId } });
  if (found) return found;
  const m = await db.merchant.findUnique({ where: { id: merchantId }, select: { name: true, type: true } });
  if (!m) return null;
  const kind: AccountKind = m.type === "BANKING_FINANCIAL" ? "FINANCIAL" : "ECOMMERCE";
  return db.account.upsert({ where: { merchantId }, create: { kind, merchantId, name: m.name }, update: {} });
}

/** A customer's account by the sender's phone; a signed-in customer's id is attached when known. */
export async function customerAccount(db: Db, c: { phone: string; name: string; customerId?: string | null }) {
  const account = await db.account.upsert({
    where: { kind_phone: { kind: "CUSTOMER", phone: c.phone } },
    create: { kind: "CUSTOMER", phone: c.phone, name: c.name, customerId: c.customerId ?? null },
    update: {},
  });
  if (c.customerId && !account.customerId) return db.account.update({ where: { id: account.id }, data: { customerId: c.customerId } });
  return account;
}
