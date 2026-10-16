import type { Db } from "../../common/prisma.service";
import type { RiderPayMode } from "../../generated/prisma/client";

/**
 * Rider pay rules shared by the rider module and the parcel workflow (rider-tasks.service
 * records an earning inside the same transaction that completes a task). Plain functions,
 * so the parcels module can use them without a module dependency on modules/rider.
 */

export type ServiceLine = "ecommerce" | "document" | "parcel";
export const SERVICE_LINES: ServiceLine[] = ["ecommerce", "document", "parcel"];
export const lineOf = (merchantType: string | null | undefined): ServiceLine =>
  merchantType === "ECOMMERCE" ? "ecommerce" : merchantType === "CORPORATE_DOCUMENT" ? "document" : "parcel";

export interface ResolvedPlan {
  /** null when the plan comes straight from the platform settings (no stored plan yet). */
  id: string | null;
  name: string;
  mode: RiderPayMode;
  rates: Record<ServiceLine, number>;
  pickupRate: number;
  monthlySalary: number;
  source: "manual" | "platform-config" | "default";
}

// Same defaults as the super admin's rider plan editor (super-admin/03.js defaultRiderPlan).
const TIER_SCALE: Record<string, number> = { Starter: 1, Growth: 1.25, Business: 1.6, Enterprise: 2 };
const BASE_RATE: Record<ServiceLine, number> = { parcel: 25, ecommerce: 35, document: 30 };
const DEFAULT_TIER = "Growth";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The rider's plan from the super admin's "Rider plans" settings (platform-config). */
export function planFromConfig(config: unknown, riderCode: string): ResolvedPlan {
  const c = isObject(config) ? config : {};
  const plans = isObject(c.riderPlans) ? c.riderPlans : {};
  const all = isObject(c.riderPlanAssignments) ? c.riderPlanAssignments : {};
  // Saved under the rider's code ("R-2048"); older saves used "RP-2048" or the bare number.
  const assignment = all[riderCode] ?? all[riderCode.replace(/^R-/, "RP-")] ?? all[riderCode.replace(/^RP?-/, "")];
  const configured = assignment !== undefined;
  const tierFor = (line: ServiceLine) =>
    typeof assignment === "string" ? assignment : isObject(assignment) && typeof assignment[line] === "string" ? (assignment[line] as string) : DEFAULT_TIER;

  const rates = {} as Record<ServiceLine, number>;
  let salary = 0;
  let perParcelLines = 0;
  let salaryLines = 0;
  const tiers = new Set<string>();
  for (const line of SERVICE_LINES) {
    const tier = tierFor(line);
    tiers.add(tier);
    const byLine = isObject(plans[line]) ? (plans[line] as Record<string, unknown>) : {};
    const raw = byLine[tier] ?? plans[tier];
    const plan = isObject(raw) ? raw : { mode: "perParcel", perParcel: BASE_RATE[line] * (TIER_SCALE[tier] ?? 1), monthlySalary: 0 };
    const mode = String(plan.mode ?? "perParcel");
    const perParcel = Math.max(0, Number(plan.perParcel) || 0);
    const monthly = Math.max(0, Number(plan.monthlySalary) || 0);
    rates[line] = mode === "monthlySalary" ? 0 : round2(perParcel);
    if (mode !== "monthlySalary") perParcelLines++;
    if (mode !== "perParcel" && monthly > 0) {
      salary += monthly;
      salaryLines++;
    }
  }
  const mode: RiderPayMode = salaryLines && perParcelLines ? "BOTH" : salaryLines ? "MONTHLY_SALARY" : "PER_PARCEL";
  return {
    id: null,
    name: [...tiers].join(" / "),
    mode,
    rates,
    pickupRate: 0,
    monthlySalary: round2(salary),
    source: configured || Object.keys(plans).length ? "platform-config" : "default",
  };
}

/** The plan in force for a rider at a moment: their stored plan, else the platform settings. */
export async function activePlan(db: Db, riderId: string, at = new Date()): Promise<ResolvedPlan> {
  const stored = await db.riderPayPlan.findFirst({
    where: { riderId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
    orderBy: { effectiveFrom: "desc" },
  });
  if (stored) {
    return {
      id: stored.id,
      name: stored.name,
      mode: stored.mode,
      rates: { ecommerce: Number(stored.ecommerceRate), document: Number(stored.documentRate), parcel: Number(stored.parcelRate) },
      pickupRate: Number(stored.pickupRate),
      monthlySalary: Number(stored.monthlySalary),
      source: stored.source === "platform-config" ? "platform-config" : "manual",
    };
  }
  const [rider, setting] = await Promise.all([
    db.rider.findUniqueOrThrow({ where: { id: riderId }, select: { code: true } }),
    db.setting.findUnique({ where: { key: "platform-config" } }),
  ]);
  return planFromConfig(setting?.value, rider.code);
}

/**
 * Records what the rider earned for a completed task. Call inside the transaction that
 * completes it. Each parcel pays once per task type (sourceKey), so replays are harmless.
 */
export async function recordTaskEarning(
  db: Db,
  input: { riderId: string; type: "DELIVERY" | "PICKUP"; parcel: { id: string; trackingId: string; merchantId: string | null }; at?: Date },
) {
  const at = input.at ?? new Date();
  const plan = await activePlan(db, input.riderId, at);
  let amount = 0;
  let line: ServiceLine | null = null;
  if (input.type === "DELIVERY") {
    const merchant = input.parcel.merchantId ? await db.merchant.findUnique({ where: { id: input.parcel.merchantId }, select: { type: true } }) : null;
    line = lineOf(merchant?.type);
    amount = plan.mode === "MONTHLY_SALARY" ? 0 : plan.rates[line];
  } else {
    amount = plan.pickupRate;
  }
  if (!(amount > 0)) return;
  const label = line === "ecommerce" ? "E-commerce delivery" : line === "document" ? "Document delivery" : line === "parcel" ? "Customer parcel delivery" : "Pickup";
  await db.riderEarning.createMany({
    data: [
      {
        riderId: input.riderId,
        type: input.type,
        amount,
        sourceKey: `${input.type}:${input.parcel.id}`,
        parcelId: input.parcel.id,
        trackingId: input.parcel.trackingId,
        serviceLine: line,
        description: `${label} · ${input.parcel.trackingId}`,
        earnedAt: at,
        planId: plan.id,
      },
    ],
    skipDuplicates: true,
  });
}
