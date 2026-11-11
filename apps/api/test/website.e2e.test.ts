import { gunzipSync } from "node:zlib";
import { DEFAULT_WEBSITE } from "@delivery-fast/shared";
import { WebsiteService } from "../src/modules/website/website.service";
import { readXlsx } from "../src/modules/imports/xlsx/xlsx-reader";
import { hub, parcelBody, PASSWORD, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/** Website settings: the switches are enforced by the API (not only hidden), and content can be edited. */
describe("website settings", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    // The switches are cached briefly; a test starts from what it saves.
    (ctx.app.get(WebsiteService) as unknown as { cached: null }).cached = null;
  });
  afterAll(() => ctx.app.close());

  const admin = () => userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
  const save = async (token: string, body: unknown) => {
    const res = await ctx.api("PUT", "/website", { token, body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };

  it("is all open by default, and only config managers can change it", async () => {
    const res = await ctx.api("GET", "/website");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ signups: { merchant: true, rider: true, franchise: true, customer: true }, sendParcel: true, edited: { privacy: false, terms: false } });
    expect(res.body.faqs).toEqual(DEFAULT_WEBSITE.faqs);
    expect(res.body.about.title).toBeTruthy();
    expect((await ctx.api("GET", "/website/status")).body).toEqual({ signups: res.body.signups, sendParcel: true });
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    expect((await ctx.api("PUT", "/website", { token: customer.token, body: { sendParcel: false } })).status).toBe(403);
    expect((await ctx.api("GET", "/website/admin", { token: customer.token })).status).toBe(403);
    expect((await ctx.api("GET", "/website/admin")).status).toBe(401);
  });

  it("saves pages and FAQs, changing only what is sent, and records it", async () => {
    const a = await admin();
    const edited = await save(a.token, { privacy: { title: "Privacy", intro: "How we handle data.", body: "## One\n\nOur new policy text." }, faqs: [{ id: "x", question: "New question?", answer: "New answer." }] });
    expect(edited.edited).toEqual({ privacy: true, terms: false });
    expect(edited.terms).toEqual(DEFAULT_WEBSITE.terms);
    expect(edited.defaults.privacy).toEqual(DEFAULT_WEBSITE.privacy);
    const shown = (await ctx.api("GET", "/website")).body;
    expect(shown.privacy.body).toContain("Our new policy text.");
    expect(shown.faqs).toHaveLength(1);
    expect(shown.signups.customer).toBe(true);
    expect((await ctx.api("PUT", "/website", { token: a.token, body: { faqs: [{ id: "x", question: "", answer: "y" }] } })).status).toBe(422);
    expect(await ctx.prisma.auditLog.findFirst({ where: { action: "website.settings_update" } })).toBeTruthy();
  });

  it("customer sign-up and sign-in off: new customers and customer sign-in are refused; everyone else signs in; partner sign-up stays open", async () => {
    const a = await admin();
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    await save(a.token, { signups: { customer: false } });

    const closed = await ctx.api("POST", "/auth/otp", { body: { phone: "01712000111", purpose: "SIGNUP" } });
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe("SIGNUP_CLOSED");
    expect((await ctx.api("POST", "/auth/signup", { body: { name: "New Person", phone: "01712000111", password: PASSWORD, otp: "123456" } })).status).toBe(403);
    expect((await ctx.api("POST", "/auth/otp", { body: { phone: "01712000111", purpose: "SIGNUP", intent: "merchant" } })).status).toBe(200);

    const signIn = (phone: string) => ctx.api("POST", "/auth/login", { body: { identifier: phone, password: PASSWORD } });
    const refused = await signIn(customer.phone);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("CUSTOMER_LOGIN_OFF");
    expect((await signIn(ops.phone)).status).toBe(200);

    // A partner application in progress keeps its applicant's sign-in.
    await save(a.token, { signups: { customer: true } });
    expect((await signIn(customer.phone)).status).toBe(200);
  });

  it("partner applications are refused when their switch is off, and each switch is on its own", async () => {
    const a = await admin();
    const applicant = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Applicant");
    const merchant = {
      type: "ECOMMERCE",
      name: "Closed Shop",
      contactName: "Rumana Akter",
      contactPhone: "01811000111",
      business: { district: "Dhaka North", zone: "Gulshan", area: "Road 4 Gulshan", street: "House 7, Road 4, Flat B2", lat: 23.7925, lng: 90.4078 },
      pickupSameAsBusiness: true,
      pickupTime: "MIDDAY",
    };
    const contact = { name: "Karim Mia", phone: "01811000222" };
    const rider = { kind: "RIDER", ...contact, area: "Dhaka North", vehicle: "MOTORCYCLE" };
    const franchise = { kind: "FRANCHISE", ...contact, location: "Mirpur", territory: "CITY_ZONE" };
    const submit = (path: string, body: unknown) => ctx.api("POST", path, { token: applicant.token, body });

    await save(a.token, { signups: { merchant: false, rider: false, franchise: false } });
    for (const [path, body] of [["/merchants/applications", merchant], ["/applications", rider], ["/applications", franchise]] as const) {
      const res = await submit(path, body);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe("SIGNUP_CLOSED");
    }
    expect((await ctx.api("POST", "/auth/otp", { body: { phone: "01712000222", purpose: "SIGNUP", intent: "rider" } })).status).toBe(403);

    // Each switch is on its own.
    await save(a.token, { signups: { rider: true } });
    expect((await submit("/applications", rider)).status).toBe(201);
    expect((await submit("/applications", franchise)).status).toBe(403);
    await save(a.token, { signups: { merchant: true, franchise: true } });
    expect((await submit("/applications", franchise)).status).toBe(201);
    expect((await submit("/merchants/applications", merchant)).status, "merchant").toBe(201);
  });

  it("Send a parcel off: customers and guests can't book; merchants and operations can", async () => {
    const a = await admin();
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    await save(a.token, { sendParcel: false });
    const booked = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() });
    expect(booked.status).toBe(403);
    expect(booked.body.error.code).toBe("SEND_PARCEL_CLOSED");
    expect((await ctx.api("POST", "/guest/verification", { body: { phone: "01712000333" } })).status).toBe(403);
    await save(a.token, { sendParcel: true });
    expect((await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).status).toBe(201);
  });

  it("the recipient gets one SMS with the tracking link at the first hub, not at later hubs", async () => {
    const first = await hub(ctx, "HUB-W1");
    const second = await hub(ctx, "HUB-W2");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    const rider = await riderUser(ctx, "R-6048", first.id);
    const { body: parcel } = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() });
    const id = parcel.trackingId as string;
    const status = (body: Record<string, unknown>) => ctx.api("POST", `/parcels/${id}/status`, { token: ops.token, body });
    const messages = () => ctx.prisma.outboxMessage.findMany({ where: { template: "parcel.received_at_hub" } });

    expect((await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } })).status).toBe(200);
    expect((await status({ status: "PICKED_UP" })).status).toBe(200);
    expect(await messages()).toHaveLength(0);
    expect((await status({ status: "AT_HUB", hubId: first.id })).status).toBe(200);
    const sent = await messages();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "SMS", to: parcel.recipient.phone });
    expect(sent[0].body).toContain(id);
    expect(sent[0].body).toContain("/track");

    expect((await status({ status: "IN_TRANSIT", hubId: second.id })).status).toBe(200);
    expect((await status({ status: "AT_HUB", hubId: second.id })).status).toBe(200);
    expect(await messages()).toHaveLength(1);
  });

  it("works like the other parcel messages: its switch, its template, and products with messages off", async () => {
    const h = await hub(ctx, "HUB-W3");
    const a = await admin();
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const rider = await riderUser(ctx, "R-6049", h.id);
    const events = (await ctx.api("GET", "/notifications/events", { token: a.token })).body.events as { event: string; group: string }[];
    expect(events.find(e => e.event === "parcel.received_at_hub")).toMatchObject({ group: "Parcel" });

    const atHub = async () => {
      const { body: parcel } = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() });
      expect((await ctx.api("POST", `/parcels/${parcel.trackingId}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } })).status).toBe(200);
      expect((await ctx.api("POST", `/parcels/${parcel.trackingId}/status`, { token: ops.token, body: { status: "PICKED_UP" } })).status).toBe(200);
      expect((await ctx.api("POST", `/parcels/${parcel.trackingId}/status`, { token: ops.token, body: { status: "AT_HUB", hubId: h.id } })).status).toBe(200);
      return ctx.prisma.outboxMessage.findMany({ where: { template: "parcel.received_at_hub" }, orderBy: { createdAt: "asc" } });
    };

    const template = (body: unknown) => ctx.api("PUT", "/notifications/templates/parcel.received_at_hub/sms", { token: a.token, body });
    expect((await template({ body: "Reached hub: {{trackingId}} {{trackingUrl}}" })).status).toBe(200);
    expect((await atHub()).at(-1)?.body).toContain("Reached hub:");

    expect((await template({ enabled: false })).status).toBe(200);
    expect(await atHub()).toHaveLength(1);
  });

  /** A category of the Customer & E-commerce list (products need one). */
  const category = async (token: string, name = "Test category", channels: { notifySms?: boolean; notifyEmail?: boolean; notifyPush?: boolean } = {}) => {
    const res = await ctx.api("POST", "/product-categories", { token, body: { segment: "ECOMMERCE", name, ...channels } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };

  it("exports a product list to Excel with the page's search and status, without messages", async () => {
    const a = await admin();
    const cat = await category(a.token);
    const add = async (name: string) => (await ctx.api("POST", "/parcel-products", { token: a.token, body: { segment: "ECOMMERCE", name, type: "BOOKS", categoryId: cat } })).body.id as string;
    await add("Blue Notebook");
    const off = await add("Red Notebook");
    await add("Green Pen");
    await ctx.api("PATCH", `/parcel-products/${off}`, { token: a.token, body: { active: false } });
    const rows = async (query: string) => {
      const res = await ctx.app.inject({ method: "GET", url: `/api/v1/parcel-products/export?segment=ECOMMERCE&${query}`, headers: { authorization: `Bearer ${a.token}` } });
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
      return readXlsx(res.rawPayload, { maxRows: 100 }).rows;
    };
    const header = (await rows("q=notebook"))[0];
    expect(header).toEqual(["Product", "Type", "SMS", "Email", "Push", "Status", "Parcels"]);
    const names = async (query: string) => (await rows(query)).slice(1).map(r => r[0]).sort();
    expect(await names("q=notebook")).toEqual(["Blue Notebook", "Red Notebook"]);
    expect(await names("q=notebook&status=inactive")).toEqual(["Red Notebook"]);
    const order = async (sort: string) => (await rows(`sort=${sort}`)).slice(1).map(r => r[0]);
    expect(await order("asc")).toEqual(["Blue Notebook", "Green Pen", "Red Notebook"]);
    expect(await order("desc")).toEqual(["Red Notebook", "Green Pen", "Blue Notebook"]);
    expect((await rows("q=red"))[1]).toEqual(["Red Notebook", "Books", "On", "On", "On", "Inactive", "0"]);
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    expect((await ctx.api("GET", "/parcel-products/export?segment=ECOMMERCE", { token: customer.token })).status).toBe(403);

    // Editing keeps the messages choice.
    expect((await ctx.api("PATCH", `/parcel-products/${off}`, { token: a.token, body: { name: "Red Notepad", type: "REGULAR" } })).status).toBe(200);
    expect(await ctx.prisma.parcelProduct.findUniqueOrThrow({ where: { id: off } })).toMatchObject({ name: "Red Notepad", type: "REGULAR", sendMessages: true });
  });

  it("audit log: numbered pages with the total over the whole log, and a search across it", async () => {
    const a = await admin();
    const product = await ctx.api("POST", "/parcel-products", { token: a.token, body: { segment: "ECOMMERCE", name: "Audit One", type: "REGULAR", categoryId: await category(a.token) } });
    for (let i = 0; i < 24; i++) await ctx.api("PATCH", `/parcel-products/${product.body.id}`, { token: a.token, body: { name: `Audit ${i}` } });
    const total = await ctx.prisma.auditLog.count();
    expect(total).toBeGreaterThan(20);

    const first = (await ctx.api("GET", "/audit-logs?page=1&limit=20", { token: a.token })).body;
    expect(first).toMatchObject({ total, page: 1, pages: Math.ceil(total / 20) });
    expect(first.items).toHaveLength(20);
    const second = (await ctx.api("GET", "/audit-logs?page=2&limit=20", { token: a.token })).body;
    expect(second.items.length).toBe(total - 20 > 20 ? 20 : total - 20);
    expect(second.items[0].id).not.toBe(first.items[0].id);

    const found = (await ctx.api("GET", "/audit-logs?page=1&limit=20&q=parcel_product.update", { token: a.token })).body;
    expect(found.total).toBe(24);
    expect(found.items.every((row: { action: string }) => row.action === "parcel_product.update")).toBe(true);
    // Cursor paging stays for everyone else.
    expect((await ctx.api("GET", "/audit-logs?limit=5", { token: a.token })).body.total).toBeUndefined();
  });

  it("gzips large JSON for clients that accept it", async () => {
    const plain = await ctx.app.inject({ method: "GET", url: "/api/v1/website" });
    const zipped = await ctx.app.inject({ method: "GET", url: "/api/v1/website", headers: { "accept-encoding": "gzip" } });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.rawPayload.length).toBeLessThan(plain.rawPayload.length / 2);
    expect(JSON.parse(gunzipSync(zipped.rawPayload).toString()).sendParcel).toBe(true);
  });
});
