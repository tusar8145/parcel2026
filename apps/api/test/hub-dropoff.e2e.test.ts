import { DEFAULT_PACKAGE_PRICES as P } from "@delivery-fast/shared";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/** Merchants and walk-in senders bringing parcels to a hub: drop-off booking, receipt and labels. */
describe("hub drop-off", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    const shop = await ctx.prisma.merchant.create({
      data: {
        code: "MR-3001",
        type: "ECOMMERCE",
        name: "Northstar Test",
        status: "ACTIVE",
        contactName: "Owner",
        contactPhone: "+8801911000000",
        pickupAddress: "House 5 Road 2",
        pickupArea: "Gulshan 1",
        pickupDistrict: "Dhaka North",
      },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const hubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const otherHubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: dhanmondi.id }], "Dhanmondi Operator");
    const rider = await riderUser(ctx, "R-3048", gulshan.id);
    return { gulshan, dhanmondi, shop, ops, hubOp, otherHubOp, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;
  const row = (s: Setup, overrides: Record<string, unknown> = {}) => ({ merchantId: s.shop.id, ...parcelBody(overrides), sender: undefined, pickup: undefined });

  /** A spreadsheet import (the import engine, JSON rows): validate, then book. */
  const importRow = (ref: string, extra: Record<string, string> = {}) => ({ order_ref: ref, "Customer name": "Nabila Ahmed", phone: "01812000000", address: "Road 7 Flat 3B", district: "Dhaka Central", zone: "Dhanmondi", ...extra });
  const importRows = async (token: string, options: Record<string, unknown>, rows: Record<string, string>[]) => {
    const checked = await ctx.api("POST", "/imports/validate", { token, body: { kind: "ecommerce", fileName: "dropoff.xlsx", ...options, rows } });
    expect(checked.status, JSON.stringify(checked.body)).toBe(201);
    const booked = await ctx.api("POST", `/imports/${checked.body.id}/commit`, { token });
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);
    return { job: checked.body, commit: booked.body };
  };
  const importedIds = async (jobId: string) => (await ctx.prisma.parcel.findMany({ where: { importJobId: jobId }, orderBy: { merchantOrderRef: "asc" } })).map(p => p.trackingId);

  const receive = (token: string, body: Record<string, unknown>) => ctx.api("POST", "/ops/hub-receive", { token, body: { source: "KEYBOARD", ...body } });

  describe("booking", () => {
    it("books a single drop-off at the hub operator's own hub", async () => {
      const s = await setup();
      const pickup = await ctx.api("POST", "/ops/parcels", { token: s.hubOp.token, body: row(s) });
      const res = await ctx.api("POST", "/ops/parcels", { token: s.hubOp.token, body: { ...row(s), intake: "DROP_OFF" } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        status: "PENDING_CONFIRMATION",
        statusLabel: `Awaiting drop-off at ${s.gulshan.name}`,
        intake: "DROP_OFF",
        dropOffHub: { id: s.gulshan.id, name: s.gulshan.name },
        droppedOffAt: null,
        pickupRider: null,
      });
      // Priced from the hub; this test hub names no zone, so it is cross-zone like the pickup.
      expect(res.body.charges.total).toBe(pickup.body.charges.total);
      expect(pickup.body).toMatchObject({ intake: "PICKUP", dropOffHub: null, statusLabel: "Pending operations confirmation" });
      expect(res.body.events[0]).toMatchObject({ title: `Booked for drop-off at ${s.gulshan.name}`, location: s.gulshan.name });

      // No pickup leg: no pickup SLA, and the delivery SLA waits for the hand-over.
      const stored = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: res.body.trackingId } });
      expect(stored).toMatchObject({ pickupDueAt: null, deliveryDueAt: null, dropOffHubId: s.gulshan.id });

      // The sender is told where to bring it.
      const notice = await ctx.prisma.outboxMessage.findFirst({ where: { template: "parcel.drop_off_booked", channel: "SMS" } });
      expect(notice?.body).toContain(`Bring the parcel to ${s.gulshan.name}`);

      // Public tracking reads naturally too.
      const track = await ctx.api("GET", `/track/${res.body.trackingId}`);
      expect(track.body).toMatchObject({ statusLabel: `Awaiting drop-off at ${s.gulshan.name}`, intake: "DROP_OFF", dropOffHub: { name: s.gulshan.name } });
    });

    it("needs a hub from operations managers and keeps hub operators to their own hubs", async () => {
      const s = await setup();
      const noHub = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { ...row(s), intake: "DROP_OFF" } });
      expect(noHub.status).toBe(422);
      expect(noHub.body.error.code).toBe("HUB_REQUIRED");
      const other = await ctx.api("POST", "/ops/parcels", { token: s.hubOp.token, body: { ...row(s), intake: "DROP_OFF", dropOffHubId: s.dhanmondi.id } });
      expect(other.status).toBe(403);
      const ok = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { ...row(s), intake: "DROP_OFF", dropOffHubId: s.dhanmondi.id } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body.dropOffHub.id).toBe(s.dhanmondi.id);
    });

    it("imports a spreadsheet as one drop-off batch, with failed rows reported and the batch kept to its hub", async () => {
      const s = await setup();
      const { job, commit } = await importRows(s.ops.token, { merchantId: s.shop.id, intake: "DROP_OFF", dropOffHubId: s.gulshan.id }, [
        importRow("D-1"),
        importRow("D-3", { phone: "123" }),
        importRow("D-2"),
      ]);
      expect(job).toMatchObject({ intake: "DROP_OFF", dropOffHub: { id: s.gulshan.id }, counts: { valid: 2, errors: 1 } });
      expect(commit).toMatchObject({ status: "COMPLETED", result: { created: 2, notCreated: 1 }, batch: { number: job.number } });
      const batch = await ctx.prisma.bookingBatch.findUniqueOrThrow({ where: { number: job.number } });
      expect(batch).toMatchObject({ intake: "DROP_OFF", hubId: s.gulshan.id, merchantId: s.shop.id, bookedCount: 2 });

      const ids = await importedIds(job.id);
      expect(ids).toHaveLength(2);
      const parcels = await ctx.prisma.parcel.findMany({ where: { trackingId: { in: ids } } });
      expect(parcels.every(p => p.intake === "DROP_OFF" && p.dropOffHubId === s.gulshan.id && p.bookingBatchId === batch.id)).toBe(true);

      const list = await ctx.api("GET", `/parcels?batchId=${batch.id}`, { token: s.ops.token });
      expect(list.body.items.map((p: { trackingId: string }) => p.trackingId).sort()).toEqual([...ids].sort());
      const batches = await ctx.api("GET", "/ops/booking-batches", { token: s.hubOp.token });
      expect(batches.body.items).toEqual([expect.objectContaining({ id: batch.id, expected: 2, received: 0, missing: 2 })]);
      expect((await ctx.api("GET", "/ops/booking-batches", { token: s.otherHubOp.token })).body.items).toEqual([]);
      expect((await ctx.api("GET", `/ops/booking-batches/${batch.id}`, { token: s.otherHubOp.token })).status).toBe(404);
      // A hub operator can't import drop-offs for another hub.
      const elsewhere = await ctx.api("POST", "/imports/validate", { token: s.hubOp.token, body: { kind: "ecommerce", merchantId: s.shop.id, intake: "DROP_OFF", dropOffHubId: s.dhanmondi.id, rows: [importRow("X-1")] } });
      expect(elsewhere.status).toBe(403);

      // Pickup imports keep today's behaviour (and are batches too, for labels).
      const pickups = await importRows(s.ops.token, { merchantId: s.shop.id }, [importRow("P-1")]);
      const pickupBatch = await ctx.prisma.bookingBatch.findUniqueOrThrow({ where: { number: pickups.job.number } });
      expect(pickupBatch).toMatchObject({ intake: "PICKUP", hubId: null });
      const [pickupId] = await importedIds(pickups.job.id);
      const pickup = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: pickupId } });
      expect(pickup).toMatchObject({ intake: "PICKUP", dropOffHubId: null, status: "PENDING_CONFIRMATION", bookingBatchId: pickupBatch.id });
      expect(pickup.pickupDueAt).not.toBeNull();
    });

    it("never shows a drop-off as waiting for a pickup rider", async () => {
      const s = await setup();
      const drop = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { ...row(s), intake: "DROP_OFF", dropOffHubId: s.gulshan.id } });
      await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: row(s) });
      const overview = await ctx.api("GET", "/ops/overview", { token: s.ops.token });
      expect(overview.body.shipments).toMatchObject({ unassigned: 1, pendingConfirmation: 2 });
      const dispatch = await ctx.api("GET", "/ops/dispatch", { token: s.ops.token });
      expect(dispatch.body.unassigned.pendingPickup).toBe(1);
      const suggestions = await ctx.api("GET", "/routing/suggestions?kind=pickup", { token: s.ops.token });
      expect(JSON.stringify(suggestions.body)).not.toContain(drop.body.trackingId);
      const assign = await ctx.api("POST", `/parcels/${drop.body.trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      expect(assign.status).toBe(409);
      expect(assign.body.error.code).toBe("DROP_OFF_PARCEL");
    });
  });

  describe("receiving at the hub", () => {
    const dropOff = async (s: Setup, hubId: string) => {
      const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { ...row(s), intake: "DROP_OFF", dropOffHubId: hubId } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body as { trackingId: string };
    };

    it("receives a drop-off by typed ID: tracking event, scan, delivery SLA from now, webhooks", async () => {
      const s = await setup();
      await ctx.prisma.webhookEndpoint.create({
        data: { merchantId: s.shop.id, url: "https://example.com/hooks", secretEncrypted: "x", events: ["shipment.status_updated"], active: true },
      });
      const { trackingId } = await dropOff(s, s.gulshan.id);
      const before = Date.now();
      // Typed by hand, in lower case.
      const res = await receive(s.hubOp.token, { code: ` ${trackingId.toLowerCase()} `, hubId: s.gulshan.id, source: "MANUAL" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ outcome: "RECEIVED", ok: true, parcel: { trackingId, status: "AT_HUB", statusLabel: "At hub", currentHub: { id: s.gulshan.id } } });

      const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId }, include: { events: { orderBy: { createdAt: "asc" } } } });
      expect(parcel).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id, pickupRiderId: null, slaState: "ON_TRACK" });
      expect(parcel.droppedOffAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      // Same-day inside Dhaka: 600 minutes from the hand-over (built-in target).
      expect(Math.round((parcel.deliveryDueAt!.getTime() - parcel.droppedOffAt!.getTime()) / 60_000)).toBe(600);
      expect(parcel.events.at(-1)).toMatchObject({ status: "AT_HUB", title: `Received at ${s.gulshan.name} (drop-off)`, location: s.gulshan.name, visibility: "PUBLIC" });
      const scans = await ctx.prisma.scanEvent.findMany({ where: { parcelId: parcel.id } });
      expect(scans).toEqual([expect.objectContaining({ kind: "HUB_RECEIVE", hubId: s.gulshan.id, source: "MANUAL", ok: true })]);
      expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.status_change", entityId: parcel.id } })).toBe(1);
      expect(await ctx.prisma.webhookDelivery.count({ where: { event: "shipment.status_updated" } })).toBe(1);

      // The merchant sees it at the hub; the dispatch queue now offers it for delivery.
      const dispatch = await ctx.api("GET", "/ops/dispatch", { token: s.ops.token });
      expect(dispatch.body.unassigned.readyAtHub).toBe(1);
      const assign = await ctx.api("POST", `/parcels/${trackingId}/assign-delivery`, { token: s.hubOp.token, body: { riderId: s.rider.rider.id } });
      expect(assign.body.status, JSON.stringify(assign.body)).toBe("ASSIGNED");
    });

    it("is harmless to scan twice, and refuses wrong hubs, pickups and unknown codes", async () => {
      const s = await setup();
      const { trackingId } = await dropOff(s, s.gulshan.id);
      const first = await receive(s.hubOp.token, { code: trackingId, hubId: s.gulshan.id });
      expect(first.body.outcome).toBe("RECEIVED");
      const again = await receive(s.hubOp.token, { code: trackingId, hubId: s.gulshan.id });
      expect(again.body).toMatchObject({ outcome: "ALREADY_RECEIVED", ok: true });
      const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId }, include: { events: true } });
      expect(parcel.events.filter(e => e.status === "AT_HUB")).toHaveLength(1);
      expect(parcel.version).toBe(1);

      // Declared at Dhanmondi, scanned at Gulshan.
      const elsewhere = await dropOff(s, s.dhanmondi.id);
      const wrong = await receive(s.hubOp.token, { code: elsewhere.trackingId, hubId: s.gulshan.id });
      expect(wrong.body).toMatchObject({ outcome: "WRONG_HUB", ok: false, parcel: { dropOffHub: { id: s.dhanmondi.id } } });
      // The generic status endpoint enforces the same rule.
      const forced = await ctx.api("POST", `/parcels/${elsewhere.trackingId}/status`, { token: s.ops.token, body: { status: "AT_HUB", hubId: s.gulshan.id } });
      expect(forced.status).toBe(409);
      expect(forced.body.error.code).toBe("DROP_OFF_WRONG_HUB");
      // A hub operator can't receive at another hub at all.
      expect((await receive(s.hubOp.token, { code: elsewhere.trackingId, hubId: s.dhanmondi.id })).status).toBe(403);
      const right = await receive(s.otherHubOp.token, { code: elsewhere.trackingId, hubId: s.dhanmondi.id });
      expect(right.body.outcome).toBe("RECEIVED");

      // A rider-pickup request can't skip its pickup.
      const pickup = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: row(s) });
      const notDropOff = await receive(s.hubOp.token, { code: pickup.body.trackingId, hubId: s.gulshan.id });
      expect(notDropOff.body).toMatchObject({ outcome: "NOT_DROP_OFF", ok: false });
      const direct = await ctx.api("POST", `/parcels/${pickup.body.trackingId}/status`, { token: s.ops.token, body: { status: "AT_HUB", hubId: s.gulshan.id } });
      expect(direct.status).toBe(409);
      expect(direct.body.error.code).toBe("NOT_DROP_OFF");

      const unknown = await receive(s.hubOp.token, { code: "PP-000000-ZZZZZ", hubId: s.gulshan.id });
      expect(unknown.body).toMatchObject({ outcome: "NOT_FOUND", ok: false, parcel: null });
      // Refused scans are kept for scan compliance (recorded without delaying the answer, so wait for the last one).
      await expect.poll(() => ctx.prisma.scanEvent.count({ where: { ok: false } })).toBe(3);
    });

    it("keeps today's hub scan-in for picked-up parcels", async () => {
      const s = await setup();
      const booked = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: row(s) });
      const id = booked.body.trackingId;
      await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      const picked = await ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body: { status: "PICKED_UP" } });
      expect(picked.body.status, JSON.stringify(picked.body)).toBe("PICKED_UP");
      const res = await receive(s.hubOp.token, { code: id, hubId: s.gulshan.id });
      expect(res.body).toMatchObject({ outcome: "RECEIVED", parcel: { status: "AT_HUB", intake: "PICKUP" } });
      const events = await ctx.prisma.trackingEvent.findMany({ where: { parcel: { trackingId: id }, status: "AT_HUB" } });
      expect(events[0].title).toBe("At hub");
    });

    it("tracks expected vs received for an import batch", async () => {
      const s = await setup();
      // A hub operator's drop-off import goes to their own hub.
      const { job } = await importRows(s.hubOp.token, { merchantId: s.shop.id, intake: "DROP_OFF" }, [importRow("B-1"), importRow("B-2"), importRow("B-3")]);
      expect(job.dropOffHub.id).toBe(s.gulshan.id);
      const batch = await ctx.prisma.bookingBatch.findUniqueOrThrow({ where: { number: job.number } });
      const [a, b, c] = await importedIds(job.id);
      const res = await receive(s.hubOp.token, { code: a, hubId: s.gulshan.id, batchId: batch.id });
      expect(res.body.batch).toMatchObject({ expected: 3, received: 1, missing: 2 });
      expect(res.body.parcel.inBatch).toBe(true);
      await ctx.api("POST", `/parcels/${c}/cancel`, { token: s.ops.token, body: { reason: "Merchant kept it" } });
      const detail = await ctx.api("GET", `/ops/booking-batches/${batch.id}`, { token: s.hubOp.token });
      expect(detail.body).toMatchObject({ expected: 2, received: 1, missing: 1, cancelled: 1 });
      expect(detail.body.parcels.find((p: { trackingId: string }) => p.trackingId === b)).toMatchObject({ received: false, statusLabel: `Awaiting drop-off at ${s.gulshan.name}` });
    });
  });

  describe("labels", () => {
    it("returns label data with hubs, COD and order reference, and audits the print", async () => {
      const s = await setup();
      await ctx.prisma.deliveryZone.create({ data: { code: "DHC-DHN", name: "Dhanmondi", district: "Dhaka Central", hubId: s.dhanmondi.id } });
      const drop = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { ...row(s, { merchantOrderRef: "ORD-77", codAmount: 1500 }), intake: "DROP_OFF", dropOffHubId: s.gulshan.id } });
      const res = await ctx.api("POST", "/ops/labels", { token: s.hubOp.token, body: { trackingIds: [drop.body.trackingId, "PP-000000-ZZZZZ"] } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.missing).toEqual(["PP-000000-ZZZZZ"]);
      expect(res.body.labels).toEqual([
        expect.objectContaining({
          trackingId: drop.body.trackingId,
          merchant: "Northstar Test",
          merchantOrderRef: "ORD-77",
          recipient: { name: "Nabila Ahmed", phone: "+8801812000000" },
          codAmount: 1500,
          weightKg: 2,
          serviceLevelLabel: "Same day",
          intake: "DROP_OFF",
          originHub: expect.objectContaining({ id: s.gulshan.id }),
          destination: expect.objectContaining({ zone: "Dhanmondi", hub: expect.objectContaining({ id: s.dhanmondi.id }) }),
        }),
      ]);
      expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.labels_print" } })).toBe(1);
    });
  });

  describe("pricing origin", () => {
    /** The "Dhanmondi" test hub moved to Chattogram (its address names Agrabad): parcels to Chattogram. */
    const locate = (s: Setup) => ctx.prisma.hub.update({ where: { id: s.dhanmondi.id }, data: { district: "Chattogram", address: "Agrabad, Chattogram" } });
    const toCtg = { delivery: { category: "HOME", street: "Agrabad Road 1", zone: "Agrabad", district: "Chattogram" } };
    /** Route + 2 kg (2 started kg over 0.5) + Express ("Same day") + COD fee 15, from the default prices. */
    const priced = (route: number) => route + 2 * P.extraKg + P.expressFee + 15;

    it("prices a drop-off from the drop-off hub's district, pickups from the pickup address", async () => {
      const s = await setup();
      await locate(s);
      const pickup = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: row(s, { ...toCtg, serviceLevel: "Regular" }) });
      const drop = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { ...row(s, toCtg), intake: "DROP_OFF", dropOffHubId: s.dhanmondi.id } });
      expect(drop.status, JSON.stringify(drop.body)).toBe(201);
      // The merchant (Dhaka) → Chattogram is a different district; from the Chattogram hub it is the same district.
      expect(pickup.body.charges.total).toBe(P.differentDistrict + 2 * P.extraKg + 15);
      expect(drop.body.charges.total).toBe(priced(P.sameDistrict));
      // The sender's address is kept; the origin is recorded with the price.
      const stored = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: drop.body.trackingId } });
      expect(stored.pickupDistrict).toBe("Dhaka North");
      expect(stored.pricingSnapshot).toMatchObject({ tier: "SAME_DISTRICT", pickupDistrict: "Chattogram", origin: { kind: "DROP_OFF_HUB", hubId: s.dhanmondi.id, district: "Chattogram", zone: "Agrabad" } });
      expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: pickup.body.trackingId } })).pricingSnapshot).not.toHaveProperty("origin");
    });

    it("quotes from the drop-off hub (public and merchant quotes) and falls back to the zone a hub serves", async () => {
      const s = await setup();
      await locate(s);
      const body = { pickupDistrict: "Dhaka North", pickupZone: "Gulshan", deliveryDistrict: "Chattogram", deliveryZone: "Agrabad", weightKg: 2, serviceLevel: "Regular", codAmount: 0 };
      const plain = await ctx.api("POST", "/pricing/quote", { body });
      const fromHub = await ctx.api("POST", "/pricing/quote", { body: { ...body, dropOffHubId: s.dhanmondi.id } });
      expect(plain.body).toMatchObject({ tier: "DIFFERENT_DISTRICT", totalCharge: P.differentDistrict + 2 * P.extraKg });
      expect(fromHub.body).toMatchObject({ tier: "SAME_DISTRICT", pickupDistrict: "Chattogram", origin: { hubId: s.dhanmondi.id, district: "Chattogram", zone: "Agrabad" } });
      expect(fromHub.body.totalCharge).toBe(P.sameDistrict + 2 * P.extraKg);
      expect((await ctx.api("POST", "/pricing/quote", { body: { ...body, dropOffHubId: "00000000-0000-7000-8000-000000000000" } })).status).toBe(404);

      const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: s.shop.id }], "Shop Owner");
      const merchantQuote = await ctx.api("POST", "/merchants/me/quote", { token: owner.token, body: { ...body, dropOffHubId: s.dhanmondi.id } });
      expect(merchantQuote.status, JSON.stringify(merchantQuote.body)).toBe(200);
      expect(merchantQuote.body).toMatchObject({ tier: "SAME_DISTRICT", origin: { zone: "Agrabad" } });

      // A hub whose name and address name no zone: the zone it serves in its district.
      await ctx.prisma.deliveryZone.create({ data: { code: "DHN-BAN", name: "Banani", district: "Dhaka North", hubId: s.gulshan.id } });
      const served = await ctx.api("POST", "/pricing/quote", { body: { ...body, deliveryDistrict: "Dhaka North", deliveryZone: "Banani", dropOffHubId: s.gulshan.id } });
      expect(served.body).toMatchObject({ tier: "SAME_DISTRICT", origin: { zone: "Banani" } });
    });

    it("prices from the hub's own zone first, and only accepts a catalog zone of the hub's district", async () => {
      const s = await setup();
      await ctx.prisma.hub.update({ where: { id: s.dhanmondi.id }, data: { district: "Dhaka Central", address: "Road 7, Dhanmondi, Dhaka" } }); // the address names Dhanmondi …
      // … but the hub's explicit zone wins over the address heuristics.
      const set = await ctx.api("PATCH", `/hubs/${s.dhanmondi.id}`, { token: s.ops.token, body: { zone: "mirpur" } });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect(set.body.zone).toBe("Mirpur"); // stored with the catalog spelling
      const body = { pickupDistrict: "Chattogram", pickupZone: "Agrabad", deliveryDistrict: "Dhaka Central", deliveryZone: "Mirpur", weightKg: 1, serviceLevel: "Regular", codAmount: 0 };
      const quote = await ctx.api("POST", "/pricing/quote", { body: { ...body, dropOffHubId: s.dhanmondi.id } });
      expect(quote.body).toMatchObject({ tier: "SAME_DISTRICT", origin: { hubId: s.dhanmondi.id, district: "Dhaka Central", zone: "Mirpur" } });

      // A zone of another district, or no catalog zone at all, is refused.
      for (const zone of ["Gulshan", "Nowhere"]) {
        const bad = await ctx.api("PATCH", `/hubs/${s.dhanmondi.id}`, { token: s.ops.token, body: { zone } });
        expect(bad.status).toBe(422);
        expect(bad.body.error).toMatchObject({ code: "HUB_ZONE_INVALID", details: { field: "zone" } });
      }
      const created = await ctx.api("POST", "/hubs", { token: s.ops.token, body: { code: "CTG-ZZ", name: "Zone Test Hub", district: "Chattogram", zone: "Banani", address: "Agrabad" } });
      expect(created.status).toBe(422);
      // Moving the hub to another district needs a zone of that district.
      expect((await ctx.api("PATCH", `/hubs/${s.dhanmondi.id}`, { token: s.ops.token, body: { district: "Chattogram" } })).status).toBe(422);
      const moved = await ctx.api("PATCH", `/hubs/${s.dhanmondi.id}`, { token: s.ops.token, body: { district: "Chattogram", zone: "Agrabad" } });
      expect(moved.body).toMatchObject({ district: "Chattogram", zone: "Agrabad" });
    });
  });

  describe("switching between pickup and drop-off", () => {
    const change = (token: string, id: string, body: Record<string, unknown>) => ctx.api("POST", `/parcels/${id}/intake`, { token, body });

    it("turns an assigned pickup into a drop-off: rider released, re-priced, tracked, audited, sender told", async () => {
      const s = await setup();
      // The hub is in Chattogram and so is the recipient: dropping it there makes it a same-district parcel.
      await ctx.prisma.hub.update({ where: { id: s.dhanmondi.id }, data: { district: "Chattogram", address: "Agrabad, Chattogram" } });
      await ctx.prisma.webhookEndpoint.create({
        data: { merchantId: s.shop.id, url: "https://example.com/hooks", secretEncrypted: "x", events: ["shipment.intake_changed", "shipment.status_updated"], active: true },
      });
      const booked = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: row(s, { serviceLevel: "Regular", delivery: { category: "HOME", street: "Agrabad Road 1", zone: "Agrabad", district: "Chattogram" } }) });
      const id = booked.body.trackingId;
      const assigned = await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      expect(assigned.body.status).toBe("PICKUP_ASSIGNED");
      expect(JSON.stringify((await ctx.api("GET", "/rider/tasks", { token: s.rider.token })).body)).toContain(id);

      const res = await change(s.ops.token, id, { intake: "DROP_OFF", dropOffHubId: s.dhanmondi.id, note: "Merchant will bring it", expectedVersion: assigned.body.version });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        status: "PENDING_CONFIRMATION",
        intake: "DROP_OFF",
        statusLabel: `Awaiting drop-off at ${s.dhanmondi.name}`,
        dropOffHub: { id: s.dhanmondi.id },
        pickupRider: null,
      });
      expect(res.body.charges.total).toBeLessThan(booked.body.charges.total);
      const stored = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id }, include: { events: { orderBy: { createdAt: "asc" } } } });
      expect(stored).toMatchObject({ pickupRiderId: null, pickupDueAt: null, deliveryDueAt: null, dropOffHubId: s.dhanmondi.id });
      expect(stored.pricingSnapshot).toMatchObject({ origin: { hubId: s.dhanmondi.id } });
      const event = stored.events.find(e => e.title === `Changed to drop-off at ${s.dhanmondi.name}`);
      expect(event).toMatchObject({ status: "PENDING_CONFIRMATION", visibility: "PUBLIC", location: s.dhanmondi.name });
      expect(event!.description).toContain("The pickup rider assignment was released.");
      expect(event!.description).toContain("Delivery charge updated");
      expect(stored.events.some(e => e.visibility === "INTERNAL" && e.description === "Merchant will bring it")).toBe(true);
      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: "parcel.intake_change", entityId: stored.id } });
      expect(audit?.data).toMatchObject({ from: "PICKUP", to: "DROP_OFF", releasedPickupRiderId: s.rider.rider.id, status: { from: "PICKUP_ASSIGNED", to: "PENDING_CONFIRMATION" } });
      const sms = await ctx.prisma.outboxMessage.findFirst({ where: { template: "parcel.changed_to_drop_off", channel: "SMS" } });
      expect(sms?.body).toContain(`bring the parcel to ${s.dhanmondi.name}`);
      expect(await ctx.prisma.webhookDelivery.count({ where: { event: "shipment.intake_changed" } })).toBe(1);

      // The rider's list no longer has it; the drop-off hub can receive it.
      expect(JSON.stringify((await ctx.api("GET", "/rider/tasks", { token: s.rider.token })).body)).not.toContain(id);
      const received = await receive(s.otherHubOp.token, { code: id, hubId: s.dhanmondi.id });
      expect(received.body.outcome).toBe("RECEIVED");
      // Once at a hub, it can't be switched any more.
      const late = await change(s.ops.token, id, { intake: "PICKUP" });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe("INTAKE_LOCKED");
    });

    it("turns a drop-off back into a rider pickup and moves a drop-off to another hub", async () => {
      const s = await setup();
      const drop = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { ...row(s), intake: "DROP_OFF", dropOffHubId: s.gulshan.id } });
      const id = drop.body.trackingId;

      const moved = await change(s.ops.token, id, { intake: "DROP_OFF", dropOffHubId: s.dhanmondi.id });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body).toMatchObject({ intake: "DROP_OFF", dropOffHub: { id: s.dhanmondi.id }, status: "PENDING_CONFIRMATION" });
      expect(moved.body.events.at(-1).title).toBe(`Drop-off hub changed to ${s.dhanmondi.name}`);
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "parcel.changed_to_drop_off" } })).toBeGreaterThan(0);

      const back = await change(s.otherHubOp.token, id, { intake: "PICKUP" });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect(back.body).toMatchObject({ intake: "PICKUP", dropOffHub: null, status: "PENDING_CONFIRMATION", statusLabel: "Pending operations confirmation" });
      expect(back.body.events.at(-1).title).toBe("Changed to rider pickup");
      const stored = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } });
      expect(stored.pickupDueAt).not.toBeNull();
      expect(stored.pricingSnapshot).not.toHaveProperty("origin");
      const sms = await ctx.prisma.outboxMessage.findFirst({ where: { template: "parcel.changed_to_pickup", channel: "SMS" } });
      expect(sms?.body).toContain("rider will collect");
      expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.intake_change", entityId: stored.id } })).toBe(2);

      // Now a regular pickup: a rider can be assigned.
      const assign = await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      expect(assign.body.status, JSON.stringify(assign.body)).toBe("PICKUP_ASSIGNED");
    });

    it("keeps hub operators to their own hubs and refuses changes after pickup or without a change", async () => {
      const s = await setup();
      const pickup = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: row(s) });
      const id = pickup.body.trackingId;
      // A hub operator can't choose another hub; their own hub is the default.
      expect((await change(s.hubOp.token, id, { intake: "DROP_OFF", dropOffHubId: s.dhanmondi.id })).status).toBe(403);
      const own = await change(s.hubOp.token, id, { intake: "DROP_OFF" });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(own.body.dropOffHub.id).toBe(s.gulshan.id);
      // Gulshan's drop-off can't be changed by Dhanmondi.
      expect((await change(s.otherHubOp.token, id, { intake: "PICKUP" })).status).toBe(403);
      const same = await change(s.ops.token, id, { intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      expect(same.status).toBe(409);
      expect(same.body.error.code).toBe("INTAKE_UNCHANGED");
      const pickupAgain = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: row(s) });
      expect((await change(s.ops.token, pickupAgain.body.trackingId, { intake: "DROP_OFF" })).body.error.code).toBe("HUB_REQUIRED");
      expect((await change(s.ops.token, id, { intake: "PICKUP", dropOffHubId: s.gulshan.id })).status).toBe(422);
      expect((await change(s.ops.token, id, { intake: "PICKUP", expectedVersion: 0 })).body.error.code).toBe("PARCEL_CHANGED");

      // A pickup assigned to a Gulshan rider is Gulshan's to change.
      const other = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: row(s) });
      await ctx.api("POST", `/parcels/${other.body.trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      expect((await change(s.otherHubOp.token, other.body.trackingId, { intake: "DROP_OFF" })).status).toBe(403);
      // After pickup it is too late.
      await ctx.api("POST", `/parcels/${other.body.trackingId}/status`, { token: s.ops.token, body: { status: "PICKED_UP" } });
      const late = await change(s.ops.token, other.body.trackingId, { intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe("INTAKE_LOCKED");

      // Merchants can't switch it themselves.
      const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: s.shop.id }], "Shop Owner");
      expect((await change(owner.token, id, { intake: "PICKUP" })).status).toBe(403);
    });
  });

  describe("merchant dashboards", () => {
    it("counts drop-offs as awaiting drop-off, never as awaiting pickup", async () => {
      const s = await setup();
      const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: s.shop.id }], "Shop Owner");
      await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: row(s) });
      const assigned = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: row(s) });
      await ctx.api("POST", `/parcels/${assigned.body.trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { ...row(s), intake: "DROP_OFF", dropOffHubId: s.gulshan.id } });
      const received = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { ...row(s), intake: "DROP_OFF", dropOffHubId: s.gulshan.id } });
      await receive(s.hubOp.token, { code: received.body.trackingId, hubId: s.gulshan.id });

      const stats = await ctx.api("GET", "/merchants/me/stats", { token: owner.token });
      expect(stats.status, JSON.stringify(stats.body)).toBe(200);
      expect(stats.body.parcels).toMatchObject({ total: 4, awaitingPickup: 2, awaitingDropOff: 1, inTransit: 1 });
      expect(stats.body.today.shipments).toBe(4);
      // The merchant's own list filters by intake.
      const drops = await ctx.api("GET", "/parcels?intake=DROP_OFF&status=PENDING_CONFIRMATION", { token: owner.token });
      expect(drops.body.items).toHaveLength(1);
      const pickups = await ctx.api("GET", "/parcels?intake=PICKUP&status=PENDING_CONFIRMATION,PICKUP_ASSIGNED,PICKUP_CONFIRMED", { token: owner.token });
      expect(pickups.body.items).toHaveLength(2);
    });
  });
  it("walk-in drop-off without a sender address starts at the hub; Hub Pickup needs no recipient street", async () => {
    const s = await setup();
    await ctx.prisma.hub.update({ where: { id: s.gulshan.id }, data: { zone: "Gulshan", address: "Road 90, Gulshan 2" } });
    await ctx.prisma.deliveryZone.create({ data: { code: "DC-DHN", name: "Dhanmondi", district: "Dhaka Central", hubId: s.dhanmondi.id } });
    const body = parcelBody({ serviceLevel: "Regular" });
    const res = await ctx.api("POST", "/ops/parcels", {
      token: s.hubOp.token,
      body: { ...body, pickup: undefined, sender: { name: "Karim Walk-in", phone: "01711222333" }, intake: "DROP_OFF", lastMile: "Hub Pickup", delivery: { ...body.delivery, street: "" } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const p = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: res.body.trackingId } });
    expect(p).toMatchObject({
      intake: "DROP_OFF",
      dropOffHubId: s.gulshan.id,
      pickupStreet: `Drop-off at ${s.gulshan.name}, Road 90, Gulshan 2`,
      pickupZone: "Gulshan",
      pickupDistrict: "Dhaka North",
      lastMile: "HUB_COLLECT",
      collectHubId: s.dhanmondi.id,
      deliveryStreet: "Collects at the hub",
    });
    // Home delivery still needs the street.
    const home = await ctx.api("POST", "/ops/parcels", { token: s.hubOp.token, body: { ...body, pickup: undefined, sender: { name: "Karim Walk-in", phone: "01711222333" }, intake: "DROP_OFF", delivery: { ...body.delivery, street: "" } } });
    expect(home.status).toBe(422);
  });
});
