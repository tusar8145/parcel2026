import { randomBytes, randomUUID } from "node:crypto";
import { test as base, expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { hash as argonHash } from "@node-rs/argon2";
import pg from "pg";

/**
 * Shared set-up for the browser tests (playwright.e2e.config.ts).
 *
 * E2E_API_ORIGIN: run against an API on another port than the web app's proxy target (e.g. a
 * copy of the API on :4111 while the web dev server proxies to :4000). Every browser context
 * created through `test` from this file forwards the page's /api/v1 calls there (the live event
 * stream /api/v1/events is continued to it, so live updates work too). The `api`
 * fixture and `apiUrl()` talk to it directly (`request` stays on the web app).
 *
 * Temporary accounts: `Fixtures` creates merchants, owners, staff and riders directly in the
 * database (E2E_DATABASE_URL) and `cleanup()` deletes them with everything they produced, so
 * the tests never depend on (or change) seeded demo accounts: staff (`staff(role)`), super admins
 * (`user(name, [{ role: "SUPER_ADMIN" }])`), merchants and riders are all temporary.
 */
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
export const API_ORIGIN = (process.env.E2E_API_ORIGIN ?? "").replace(/\/$/, "");
export const API_BASE = API_ORIGIN || BASE_URL;
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://deliveryfast:deliveryfast@localhost:5432/deliveryfast";

/** An absolute URL on the API (`apiUrl("/api/v1/auth/login")`). */
export const apiUrl = (path: string) => `${API_BASE}${path}`;

const routed = new WeakSet<BrowserContext>();
/** Forwards a context's API calls to E2E_API_ORIGIN (no-op without it). */
export async function routeApi(context: BrowserContext) {
  if (!API_ORIGIN || routed.has(context)) return;
  routed.add(context);
  await context.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(API_ORIGIN).origin) return route.fallback();
    // The live event stream never ends, so it can't be fetched and fulfilled: it is continued to the API instead.
    if (url.pathname === "/api/v1/events") return route.continue({ url: `${API_ORIGIN}${url.pathname}${url.search}` });
    await route.fulfill({ response: await route.fetch({ url: `${API_ORIGIN}${url.pathname}${url.search}` }) });
  });
}

/** `test` with E2E_API_ORIGIN applied to every context (fixtures and browser.newContext()) and to `request`. */
export const test = base.extend<{ api: APIRequestContext }, { browser: Browser }>({
  browser: [
    async ({ browser }, use) => {
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async options => {
        const context = await newContext(options);
        await routeApi(context);
        return context;
      };
      await use(browser);
    },
    { scope: "worker" },
  ],
  context: async ({ context }, use) => {
    await routeApi(context);
    await use(context);
  },
  /** Requests to the API (E2E_API_ORIGIN, else through the web app's proxy); `request` stays on the web app. */
  api: async ({ playwright }, use) => {
    const api = await playwright.request.newContext({ baseURL: API_BASE });
    await use(api);
    await api.dispose();
  },
});
export { expect };

// ───────────── Courier Operations navigation ─────────────

/**
 * Where each Courier Operations area lives in the menu: [view, tab?] (public/legacy/courier-operation/
 * bridge-nav.js). Specs navigate by these keys, so a rename in the menu is a one-line change here.
 */
export const OPS_NAV = {
  today: ["Today"],
  newOrders: ["New orders"],
  pickup: ["Pickup", "Assign pickup rider"],
  scheduledPickups: ["Pickup", "Scheduled pickups"],
  hubReceive: ["Hub desk", "Receive"],
  dropOffReceive: ["Hub desk", "Drop-off receive"],
  hubPickupCounter: ["Hub desk", "Hub Pickup counter"],
  transfers: ["Transfers"],
  delivery: ["Delivery"],
  exceptions: ["Problems", "Exceptions"],
  failedDelivery: ["Problems", "Failed delivery"],
  needsInfo: ["Problems", "Needs info"],
  slaRisk: ["Problems", "SLA late-risk"],
  returns: ["Returns"],
  cod: ["COD & settlement"],
  allParcels: ["All parcels", "All"],
  ecommerce: ["All parcels", "E-commerce"],
  banking: ["All parcels", "Banking & Financial"],
  customerParcels: ["All parcels", "Customer"],
  reports: ["Reports", "Reports"],
  analytics: ["Reports", "Analytics & SLA"],
  riders: ["Riders"],
  merchants: ["Merchants"],
  hubsZones: ["Hubs & zones"],
  cnStock: ["CN stock"],
  settings: ["Settings"],
} as const satisfies Record<string, readonly [string] | readonly [string, string]>;
export type OpsArea = keyof typeof OPS_NAV;

/** Opens a Courier Operations area from the menu (and its tab), e.g. `opsNav(page, "ecommerce")`. */
export async function opsNav(page: Page, area: OpsArea) {
  const [view, tab] = OPS_NAV[area] as readonly string[];
  await page.click(`#navigation [data-nav="${view}"]`);
  await expect(page.locator("#breadcrumbLabel")).toHaveText(view);
  if (tab) {
    const button = page.locator(`#mainContent [data-nav-tab="${tab}"]`);
    // Single-tab views have no tab bar.
    if (await button.count()) await button.click();
    if (await button.count()) await expect(button).toHaveAttribute("aria-selected", "true");
  }
}

/** Clicks an action in a parcel row (or any block with a "More" menu), opening "More" when the action sits in it. */
export async function rowAction(scope: Locator, selector: string) {
  const target = scope.locator(selector).first();
  if (!(await target.isVisible())) await scope.locator("details.df-more > summary").first().click();
  await target.click();
}

/** Clicks a page-heading button, opening the heading's "More actions" menu when the button sits in it. */
export async function headingAction(page: Page, selector: string) {
  await rowAction(page.locator("#mainContent .page-heading"), selector);
}

export async function sql<T = Record<string, unknown>>(text: string, values: unknown[] = []) {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    return (await db.query(text, values)).rows as T[];
  } finally {
    await db.end();
  }
}

export type TempUser = { id: string; name: string; phone: string; /** 01XXXXXXXXX, for the sign-in form */ login: string; password: string };
export type TempMerchant = { id: string; code: string; name: string; contactPhone: string; type: "ECOMMERCE" | "BANKING_FINANCIAL"; pickupAddress: string; pickupArea: string; pickupDistrict: string; plan: { name: string; discountPct: number } | null };
export type TempRider = TempUser & { riderId: string; code: string; hub: string };

const used = new Set<string>();
/** A fresh +8801… number nobody has (checked against the database). */
async function freshPhone() {
  for (;;) {
    const phone = `+8801${3 + Math.floor(Math.random() * 7)}${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    if (used.has(phone)) continue;
    used.add(phone);
    if (!(await sql(`SELECT 1 FROM users WHERE phone = $1`, [phone])).length) return phone;
  }
}

/** Temporary accounts for one spec file; `cleanup()` removes them and what they produced. */
export class Fixtures {
  readonly stamp = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`.toUpperCase();
  private merchants: { id: string; contactPhone: string }[] = [];
  private users: { id: string; phone: string }[] = [];
  private riders: TempRider[] = [];
  private trackingIds: string[] = [];
  private phones: string[] = [];
  private seq = 0;

  /** An active, verified merchant; `plan` picks an active service plan with a discount for its segment. */
  async merchant(opts: { type?: "ECOMMERCE" | "BANKING_FINANCIAL"; label?: string; plan?: boolean } = {}): Promise<TempMerchant> {
    const type = opts.type ?? "ECOMMERCE";
    const n = ++this.seq;
    const [plan] = opts.plan
      ? await sql<{ id: string; name: string; discountPct: string }>(`SELECT id, name, "discountPct" FROM service_plans WHERE segment = $1 AND active AND "discountPct" > 0 ORDER BY "discountPct" ASC LIMIT 1`, [type])
      : [];
    const m: TempMerchant = {
      id: randomUUID(),
      code: `E2E-${this.stamp}-${n}`,
      name: `E2E ${opts.label ?? (type === "ECOMMERCE" ? "Panel Shop" : "Panel Bank")} ${this.stamp}-${n}`,
      type,
      contactPhone: await freshPhone(),
      pickupAddress: "House 12, Road 11, Banani Block C",
      pickupArea: "Banani",
      pickupDistrict: "Dhaka North",
      plan: plan ? { name: plan.name, discountPct: Number(plan.discountPct) } : null,
    };
    await sql(
      `INSERT INTO merchants (id, code, type, name, status, "kycStatus", "contactName", "contactPhone", "pickupAddress", "pickupArea", "pickupDistrict", "planId", "updatedAt")
       VALUES ($1, $2, $3, $4, 'ACTIVE', 'APPROVED', 'E2E Contact', $5, $6, $7, $8, $9, now())`,
      [m.id, m.code, type, m.name, m.contactPhone, m.pickupAddress, m.pickupArea, m.pickupDistrict, plan?.id ?? null],
    );
    this.merchants.push(m);
    return m;
  }

  /** A signed-up user with a password and the given roles. */
  async user(name: string, roles: { role: string; merchantId?: string; hubId?: string }[]): Promise<TempUser> {
    const phone = await freshPhone();
    const password = `E2e-${randomBytes(9).toString("base64url")}`;
    const [row] = await sql<{ id: string }>(`INSERT INTO users (id, name, phone, "passwordHash", "phoneVerifiedAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, now(), now()) RETURNING id`, [
      name,
      phone,
      await argonHash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    ]);
    for (const r of roles) await sql(`INSERT INTO user_roles (id, "userId", role, "merchantId", "hubId") VALUES (gen_random_uuid(), $1, $2, $3, $4)`, [row.id, r.role, r.merchantId ?? null, r.hubId ?? null]);
    const user = { id: row.id, name, phone, login: `0${phone.slice(4)}`, password };
    this.users.push(user);
    return user;
  }

  /** A merchant owner or staff member of `merchant`. */
  member(merchant: TempMerchant, role: "MERCHANT_OWNER" | "MERCHANT_STAFF" = "MERCHANT_OWNER") {
    return this.user(`E2E-${role === "MERCHANT_OWNER" ? "Owner" : "Staff"}-${this.stamp}-${++this.seq} Test`, [{ role, merchantId: merchant.id }]);
  }

  /** A staff account with one role (OPS_MANAGER, FINANCE…); `hubName` scopes a HUB_OPERATOR to that hub. */
  async staff(role: "OPS_MANAGER" | "HUB_OPERATOR" | "FINANCE" | "SUPPORT_AGENT", hubName?: string): Promise<TempUser> {
    let hubId: string | undefined;
    if (hubName) {
      const [hub] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = $1`, [hubName]);
      if (!hub) throw new Error(`No hub named ${hubName}`);
      hubId = hub.id;
    }
    return this.user(`E2E-${role}-${this.stamp}-${++this.seq} Test`, [{ role, hubId }]);
  }

  /** An active rider at a hub (by name), with a unique code. */
  async rider(hubName: string): Promise<TempRider> {
    const [hub] = await sql<{ id: string }>(`SELECT id FROM hubs WHERE name = $1`, [hubName]);
    if (!hub) throw new Error(`No hub named ${hubName}`);
    let code = "";
    do code = `R-9${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
    while ((await sql(`SELECT 1 FROM riders WHERE code = $1`, [code])).length);
    const user = await this.user(`E2E-Rider-${this.stamp}-${++this.seq} Test`, [{ role: "RIDER" }]);
    const riderId = randomUUID();
    await sql(`INSERT INTO riders (id, "userId", code, "hubId", active, "updatedAt") VALUES ($1, $2, $3, $4, true, now())`, [riderId, user.id, code, hub.id]);
    const rider = { ...user, riderId, code, hub: hubName };
    this.riders.push(rider);
    return rider;
  }

  /** Adds an account a test created through the UI or API (sign-up) to the cleanup; returns its id. */
  async adoptUser(phone: string) {
    const e164 = `+880${phone.replace(/\D/g, "").replace(/^(880)?0?/, "")}`;
    const [row] = await sql<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [e164]);
    if (row && !this.users.some(u => u.id === row.id)) this.users.push({ id: row.id, phone: e164 });
    return row?.id;
  }

  /** Adds a parcel a test booked without an account (guest booking) and the sender's phone to the cleanup. */
  adoptParcel(trackingId: string, senderPhone?: string) {
    this.trackingIds.push(trackingId);
    if (senderPhone) this.phones.push(`+880${senderPhone.replace(/\D/g, "").replace(/^(880)?0?/, "")}`);
  }

  /** Adds a merchant a test created through the UI or API (application) to the cleanup. */
  async adoptMerchant(name: string) {
    const rows = await sql<{ id: string; contactPhone: string }>(`SELECT id, "contactPhone" FROM merchants WHERE name = $1`, [name]);
    for (const row of rows) if (!this.merchants.some(m => m.id === row.id)) this.merchants.push(row);
    return rows.map(r => r.id);
  }

  /** Deletes the temporary accounts and everything they produced, in one transaction. The audit log is append-only and kept. */
  async cleanup() {
    const M = this.merchants.map(m => m.id);
    const U = this.users.map(u => u.id);
    const R = this.riders.map(r => r.riderId);
    if (!M.length && !U.length && !this.trackingIds.length) return;
    const db = new pg.Client({ connectionString: DATABASE_URL });
    await db.connect();
    const q = (text: string, values: unknown[] = []) => db.query(text, values);
    try {
      await q("BEGIN");
      const parcels = (await q(`SELECT id, "trackingId", "bookingBatchId" FROM parcels WHERE "merchantId" = ANY($1::uuid[]) OR "customerId" = ANY($2::uuid[]) OR "pickupRiderId" = ANY($3::uuid[]) OR "deliveryRiderId" = ANY($3::uuid[]) OR "trackingId" = ANY($4::text[])`, [M, U, R, this.trackingIds])).rows;
      const P = parcels.map(p => p.id);
      const T = parcels.map(p => p.trackingId);
      const batches = [...new Set(parcels.map(p => p.bookingBatchId).filter(Boolean))];
      const phones = [...this.users.map(u => u.phone), ...this.merchants.map(m => m.contactPhone), ...this.phones];
      // Messages to the temporary accounts and about their parcels.
      await q(`DELETE FROM outbox_messages WHERE "userId" = ANY($1::uuid[]) OR "to" = ANY($2::text[]) OR body LIKE ANY($3::text[])`, [U, phones, T.map(t => `%${t}%`)]);
      await q(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [phones]);
      // Money: COD, cash handovers, settlements, invoices. Ledger postings stay: journal rows are
      // append-only (database triggers) and only name merchants/riders by id, without foreign keys.
      await q(`DELETE FROM cod_collections WHERE "parcelId" = ANY($1::uuid[]) OR "riderId" = ANY($2::uuid[])`, [P, R]);
      await q(`DELETE FROM cash_handover_requests WHERE "riderId" = ANY($1::uuid[])`, [R]);
      await q(`DELETE FROM cash_handovers WHERE "riderId" = ANY($1::uuid[])`, [R]);
      await q(`DELETE FROM rider_earnings WHERE "riderId" = ANY($2::uuid[]) OR "parcelId" = ANY($1::uuid[])`, [P, R]);
      await q(`DELETE FROM rider_payouts WHERE "riderId" = ANY($1::uuid[])`, [R]);
      await q(`DELETE FROM merchant_adjustments WHERE "merchantId" = ANY($1::uuid[])`, [M]);
      await q(`DELETE FROM merchant_settlements WHERE "merchantId" = ANY($1::uuid[])`, [M]);
      await q(`DELETE FROM invoices WHERE "merchantId" = ANY($1::uuid[])`, [M]);
      // What points at the parcels without cascading.
      await q(`DELETE FROM disputes WHERE "parcelId" = ANY($1::uuid[]) OR "merchantId" = ANY($2::uuid[])`, [P, M]);
      await q(`DELETE FROM linehaul_bag_items WHERE "parcelId" = ANY($1::uuid[])`, [P]);
      await q(`DELETE FROM linehaul_discrepancies WHERE "parcelId" = ANY($1::uuid[])`, [P]);
      await q(`DELETE FROM scan_events WHERE "parcelId" = ANY($1::uuid[]) OR "riderId" = ANY($2::uuid[]) OR "userId" = ANY($3::uuid[])`, [P, R, U]);
      await q(`DELETE FROM guest_verifications WHERE "parcelId" = ANY($1::uuid[])`, [P]);
      const tickets = `SELECT id FROM support_tickets WHERE "parcelId" = ANY($1::uuid[]) OR "merchantId" = ANY($2::uuid[]) OR "requesterId" = ANY($3::uuid[])`;
      await q(`DELETE FROM partner_applications WHERE "ticketId" IN (${tickets}) OR "applicantId" = ANY($3::uuid[])`, [P, M, U]);
      await q(`DELETE FROM support_tickets WHERE id IN (${tickets})`, [P, M, U]);
      await q(`DELETE FROM delivery_attempts WHERE "parcelId" = ANY($1::uuid[]) OR "riderId" = ANY($2::uuid[])`, [P, R]);
      await q(`DELETE FROM merchant_kyc_documents WHERE "merchantId" = ANY($1::uuid[])`, [M]);
      await q(`DELETE FROM rider_kyc_documents WHERE "riderId" = ANY($1::uuid[])`, [R]);
      await q(`DELETE FROM delivery_proofs WHERE "parcelId" = ANY($1::uuid[])`, [P]);
      await q(`DELETE FROM stored_files WHERE "uploadedById" = ANY($1::uuid[])`, [U]);
      await q(`DELETE FROM parcels WHERE id = ANY($1::uuid[])`, [P]);
      // Imports and their booking batches.
      const jobs = `SELECT id FROM import_jobs WHERE "merchantId" = ANY($1::uuid[]) OR "createdById" = ANY($2::uuid[]) OR "bookingBatchId" = ANY($3::uuid[])`;
      const jobBatches = (await q(`SELECT "bookingBatchId" FROM import_jobs WHERE id IN (${jobs})`, [M, U, batches])).rows.map(r => r.bookingBatchId).filter(Boolean);
      await q(`DELETE FROM import_jobs WHERE id IN (${jobs})`, [M, U, batches]);
      await q(`DELETE FROM booking_batches WHERE id = ANY($1::uuid[]) OR "merchantId" = ANY($2::uuid[]) OR "createdById" = ANY($3::uuid[])`, [[...batches, ...jobBatches], M, U]);
      await q(`DELETE FROM merchant_invites WHERE "merchantId" = ANY($1::uuid[])`, [M]);
      // Bulk updates (Excel) the temporary staff uploaded; their rows cascade.
      await q(`DELETE FROM bulk_update_jobs WHERE "createdById" = ANY($1::uuid[])`, [U]);
      // The accounts (sessions, roles, keys, webhooks, schedules, products… cascade).
      await q(`DELETE FROM riders WHERE id = ANY($1::uuid[])`, [R]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [U]);
      await q(`DELETE FROM merchants WHERE id = ANY($1::uuid[])`, [M]);
      await q("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await db.end();
    }
    this.merchants = [];
    this.users = [];
    this.riders = [];
    this.trackingIds = [];
    this.phones = [];
  }
}
