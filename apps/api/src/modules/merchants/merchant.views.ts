import type { ApiKey, Merchant, Prisma, ServicePlan, WebhookDelivery, WebhookEndpoint } from "../../generated/prisma/client";

export const planView = (p: ServicePlan) => ({
  id: p.id,
  segment: p.segment,
  name: p.name,
  monthlyFee: Number(p.monthlyFee),
  discountPct: Number(p.discountPct),
  features: p.features,
  active: p.active,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export const merchantView = (m: Merchant & { plan?: ServicePlan | null }) => ({
  id: m.id,
  code: m.code,
  type: m.type,
  name: m.name,
  status: m.status,
  contactName: m.contactName,
  contactPhone: m.contactPhone,
  contactEmail: m.contactEmail,
  pickupAddress: m.pickupAddress,
  pickupArea: m.pickupArea,
  pickupDistrict: m.pickupDistrict,
  plan: m.plan ? { id: m.plan.id, name: m.plan.name, segment: m.plan.segment, monthlyFee: Number(m.plan.monthlyFee), discountPct: Number(m.plan.discountPct) } : null,
  payoutAccount: m.payoutAccount,
  rejectionReason: m.rejectionReason,
  kyc: { status: m.kycStatus, submittedAt: m.kycSubmittedAt, reviewedAt: m.kycReviewedAt, rejectionReason: m.kycRejectionReason },
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

export const memberInclude = {
  user: { select: { id: true, name: true, phone: true, email: true, status: true, lastLoginAt: true } },
} satisfies Prisma.UserRoleInclude;

export const memberView = (r: Prisma.UserRoleGetPayload<{ include: typeof memberInclude }>) => ({
  id: r.id,
  role: r.role,
  userId: r.user.id,
  name: r.user.name,
  phone: r.user.phone,
  email: r.user.email,
  status: r.user.status,
  lastLoginAt: r.user.lastLoginAt,
  addedAt: r.createdAt,
});

export const apiKeyView = (k: ApiKey) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  /** Empty: full access (keys created before scopes). */
  scopes: k.scopes,
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt,
  expiresAt: k.expiresAt,
  revokedAt: k.revokedAt,
});

export const webhookView = (w: WebhookEndpoint) => ({
  id: w.id,
  url: w.url,
  events: w.events,
  active: w.active,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt,
});

export const deliveryView = (d: WebhookDelivery) => ({
  id: d.id,
  event: d.event,
  state: d.state,
  attempts: d.attempts,
  responseCode: d.responseCode,
  lastError: d.lastError,
  createdAt: d.createdAt,
  deliveredAt: d.deliveredAt,
});
