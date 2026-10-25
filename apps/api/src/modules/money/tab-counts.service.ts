import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import type { Actor } from "../../common/auth/actor";
import { Prisma } from "../../generated/prisma/client";
import { cashHubScope, isFinanceStaff, money, ZERO } from "../finance/finance.scope";
import { centralHubId } from "./accounts-config";
import { isMoneyStaff } from "./access";

/** One Accounts tab's badge: how many things wait there, the money involved, and a line saying what they are. */
export interface TabCount {
  count: number;
  amount: number;
  hint: string;
}

const tk = (n: number) => `৳${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Courier Operations › Accounts tab badges (GET /accounts/tab-counts): what waits in each tab this person sees,
 * so they know where to click without opening every tab. Read-only; the same rules as the tabs' own screens:
 * - E-commerce / Customer: accounts with money ready to settle, plus settlements created and not paid yet;
 * - Financial: merchants who owe (due), plus payments to confirm;
 * - Rider cash: riders holding COD cash, plus slips waiting to be received at the hub;
 * - Hub transfers: hubs with cash to send to the central hub, plus transfers on the way;
 * - Rider pay: rider payouts to approve or pay; Franchise: deposits to confirm, plus commission invoices to pay.
 */
@Injectable()
export class TabCountsService {
  constructor(private readonly prisma: PrismaService) {}

  async counts(actor: Actor): Promise<Record<string, TabCount>> {
    if (actor.kind !== "user") return {};
    const can = (p: Parameters<Actor["permissions"]["has"]>[0]) => actor.permissions.has(p);
    const moneyStaff = await isMoneyStaff(this.prisma, actor);
    const cashStaff = can("cod:receive");
    const financeStaff = can("finance:read") && isFinanceStaff(actor);
    const scope = cashHubScope(actor);
    const tabs: Record<string, TabCount> = {};
    const jobs: Promise<void>[] = [];
    if (moneyStaff) jobs.push(this.accountTabs(tabs));
    if (cashStaff || moneyStaff) jobs.push(this.riderCash(tabs, scope), this.hubTransfers(tabs, scope));
    if (can("finance:manage") || can("rider:manage")) jobs.push(this.riderPay(tabs, scope));
    if (cashStaff || financeStaff) jobs.push(this.franchise(tabs, scope, financeStaff || can("finance:manage")));
    await Promise.all(jobs);
    return tabs;
  }

  private async accountTabs(tabs: Record<string, TabCount>) {
    const [ready, unpaid, due, pending] = await Promise.all([
      // Ready to settle per account: the Accounts list's "ready" (lines not on a settlement whose cash is at the central hub).
      this.prisma.$queryRaw<{ kind: string; n: number; amount: Prisma.Decimal }[]>`
        SELECT kind, COUNT(*) FILTER (WHERE ready > 0)::int AS n, COALESCE(SUM(GREATEST(ready, 0)), 0) AS amount FROM (
          SELECT a.id, a.kind::text AS kind,
            COALESCE(SUM(e.amount) FILTER (WHERE e."payoutId" IS NULL AND e.type IN ('COD','DELIVERY_CHARGE','RETURN_CHARGE','ADJUSTMENT')
              AND (e."parcelId" IS NULL OR c.id IS NULL OR c.state = 'AT_CENTRAL')), 0) AS ready
          FROM accounts a
          LEFT JOIN account_entries e ON e."accountId" = a.id
          LEFT JOIN cod_collections c ON c."parcelId" = e."parcelId" AND e.type IN ('COD','DELIVERY_CHARGE')
          WHERE a.kind IN ('ECOMMERCE','CUSTOMER')
          GROUP BY a.id, a.kind) t
        GROUP BY kind`,
      this.prisma.$queryRaw<{ kind: string; n: number; amount: Prisma.Decimal }[]>`
        SELECT a.kind::text AS kind, COUNT(*)::int AS n, COALESCE(SUM(p.amount), 0) AS amount
        FROM account_payouts p JOIN accounts a ON a.id = p."accountId" WHERE p.status = 'UNPAID' GROUP BY a.kind`,
      this.prisma.$queryRaw<{ n: number; amount: Prisma.Decimal }[]>`
        SELECT COUNT(*) FILTER (WHERE b < 0)::int AS n, COALESCE(SUM(GREATEST(-b, 0)), 0) AS amount FROM (
          SELECT SUM(e.amount) AS b FROM account_entries e JOIN accounts a ON a.id = e."accountId" WHERE a.kind = 'FINANCIAL' GROUP BY e."accountId") t`,
      this.prisma.accountPayment.aggregate({ where: { status: "PENDING" }, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    for (const [tab, kind, who] of [
      ["E-commerce", "ECOMMERCE", "merchant"],
      ["Customer", "CUSTOMER", "customer"],
    ] as const) {
      const r = ready.find(x => x.kind === kind);
      const u = unpaid.find(x => x.kind === kind);
      const readyN = r?.n ?? 0;
      const unpaidN = u?.n ?? 0;
      const parts = [readyN ? `${plural(readyN, who)} ready to settle (${tk(money(r?.amount))})` : "", unpaidN ? `${plural(unpaidN, "settlement")} to pay (${tk(money(u?.amount))})` : ""].filter(Boolean);
      tabs[tab] = { count: readyN + unpaidN, amount: money((r?.amount ?? ZERO).plus(u?.amount ?? ZERO)), hint: parts.join(" · ") || "Nothing to settle" };
    }
    const d = due[0];
    const pendingN = pending._count._all;
    const parts = [d?.n ? `${plural(d.n, "merchant")} owe ${tk(money(d.amount))}` : "", pendingN ? `${plural(pendingN, "payment")} to confirm (${tk(money(pending._sum.amount))})` : ""].filter(Boolean);
    tabs.Financial = { count: (d?.n ?? 0) + pendingN, amount: money(d?.amount), hint: parts.join(" · ") || "Nothing due" };
  }

  private async riderCash(tabs: Record<string, TabCount>, scope: string[] | null) {
    const riderWhere = scope ? { rider: { hubId: { in: scope } } } : {};
    const [held, dues, slips] = await Promise.all([
      this.prisma.codCollection.groupBy({ by: ["riderId"], where: { state: "WITH_RIDER", riderId: { not: null }, ...riderWhere }, _sum: { amount: true } }),
      this.prisma.cashDue.groupBy({ by: ["riderId"], where: { clearedAt: null, riderId: { not: null }, ...(scope ? { riderId: { in: (await this.prisma.rider.findMany({ where: { hubId: { in: scope } }, select: { id: true } })).map(r => r.id) } } : {}) }, _sum: { amount: true } }),
      this.prisma.cashSlip.count({ where: { status: "OPEN", ...(scope ? { hubId: { in: scope } } : {}) } }),
    ]);
    const riders = new Set([...held, ...dues].map(g => g.riderId));
    const amount = money([...held, ...dues].reduce((t, g) => t.plus(g._sum.amount ?? ZERO), ZERO));
    const parts = [riders.size ? `${plural(riders.size, "rider")} hold ${tk(amount)}` : "", slips ? `${plural(slips, "slip")} ready to receive` : ""].filter(Boolean);
    // The work here is receiving: riders with cash (each brings a slip).
    tabs["Rider cash"] = { count: riders.size, amount, hint: parts.join(" · ") || "No cash with riders" };
  }

  private async hubTransfers(tabs: Record<string, TabCount>, scope: string[] | null) {
    const central = await centralHubId(this.prisma);
    const hubs = scope ? { in: scope } : undefined;
    const [atHubs, dues, transit] = await Promise.all([
      this.prisma.codCollection.groupBy({ by: ["cashHubId"], where: { state: "AT_HUB", cashHubId: { not: null, ...(hubs ?? {}) } }, _sum: { amount: true } }),
      this.prisma.cashDue.groupBy({ by: ["hubId"], where: { clearedAt: null, hubId: { not: null, ...(hubs ?? {}) } }, _sum: { amount: true } }),
      this.prisma.hubTransfer.aggregate({ where: { status: "IN_TRANSIT", ...(scope ? { OR: [{ fromHubId: { in: scope } }, { toHubId: { in: scope } }] } : {}) }, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const toSend = new Map<string, Prisma.Decimal>();
    for (const g of atHubs) if (g.cashHubId && g.cashHubId !== central) toSend.set(g.cashHubId, (toSend.get(g.cashHubId) ?? ZERO).plus(g._sum.amount ?? ZERO));
    for (const g of dues) if (g.hubId && g.hubId !== central) toSend.set(g.hubId, (toSend.get(g.hubId) ?? ZERO).plus(g._sum.amount ?? ZERO));
    const sendable = [...toSend.values()].filter(v => v.gt(0));
    const sendAmount = money(sendable.reduce((t, v) => t.plus(v), ZERO));
    const transitN = transit._count._all;
    const parts = [sendable.length ? `${plural(sendable.length, "hub")} to send ${tk(sendAmount)}` : "", transitN ? `${plural(transitN, "transfer")} on the way (${tk(money(transit._sum.amount))})` : ""].filter(Boolean);
    tabs["Hub transfers"] = { count: sendable.length + transitN, amount: money(transit._sum.amount ?? ZERO) + sendAmount, hint: parts.join(" · ") || "Nothing to send" };
  }

  private async riderPay(tabs: Record<string, TabCount>, scope: string[] | null) {
    const rows = await this.prisma.riderPayout.groupBy({ by: ["status"], where: { status: { in: ["DRAFT", "APPROVED"] }, ...(scope ? { rider: { hubId: { in: scope } } } : {}) }, _sum: { amount: true }, _count: { _all: true } });
    const of = (s: string) => rows.find(r => r.status === s);
    const draft = of("DRAFT")?._count._all ?? 0;
    const approved = of("APPROVED")?._count._all ?? 0;
    const parts = [draft ? `${plural(draft, "payout")} to approve` : "", approved ? `${plural(approved, "payout")} to pay` : ""].filter(Boolean);
    tabs["Rider pay"] = { count: draft + approved, amount: money((of("DRAFT")?._sum.amount ?? ZERO).plus(of("APPROVED")?._sum.amount ?? ZERO)), hint: parts.join(" · ") || "No payouts waiting" };
  }

  private async franchise(tabs: Record<string, TabCount>, scope: string[] | null, finance: boolean) {
    const [deposits, invoices] = await Promise.all([
      this.prisma.franchiseRemittance.aggregate({ where: { status: "PENDING", ...(scope ? { hubId: { in: scope } } : {}) }, _sum: { net: true }, _count: { _all: true } }),
      finance ? this.prisma.franchiseInvoice.aggregate({ where: { status: { in: ["ISSUED", "APPROVED"] }, settlement: "PAYABLE" }, _sum: { amount: true }, _count: { _all: true } }) : null,
    ]);
    const depN = deposits._count._all;
    const invN = invoices?._count._all ?? 0;
    const parts = [depN ? `${plural(depN, "deposit")} to confirm (${tk(money(deposits._sum.net))})` : "", invN ? `${plural(invN, "commission invoice")} to pay (${tk(money(invoices?._sum.amount))})` : ""].filter(Boolean);
    tabs.Franchise = { count: depN + invN, amount: money((deposits._sum.net ?? ZERO).plus(invoices?._sum.amount ?? ZERO)), hint: parts.join(" · ") || "Nothing waiting" };
  }
}
