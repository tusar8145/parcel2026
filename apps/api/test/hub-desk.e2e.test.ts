import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// 1x1 PNG: the photo of a signed delivery slip.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("hub desk: delivered entry and out for delivery by scanning", () => {
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
      data: { code: "MR-6001", type: "ECOMMERCE", name: "Desk Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000002", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const desk = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Desk Operator");
    const other = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: dhanmondi.id }], "Other Operator");
    const rider = await riderUser(ctx, "R-6001", gulshan.id);
    await ctx.prisma.rider.updateMany({ data: { status: "ONLINE" } });
    return { gulshan, shop, ops, desk, other, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;
  /** A parcel received at the Gulshan hub (COD ৳1,500). */
  const atHub = async (s: Setup) => {
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId: s.shop.id, ...parcelBody(), sender: undefined, pickup: undefined } });
    const id = res.body.trackingId as string;
    await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    await ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body: { status: "PICKED_UP" } });
    expect((await ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body: { status: "AT_HUB", hubId: s.gulshan.id } })).status).toBe(200);
    return id;
  };
  const scan = async (token: string, path: string, body: Record<string, unknown>) => {
    const res = await ctx.api("POST", `/hub-desk/${path}`, { token, body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { ok: boolean; outcome: string; message: string };
  };

  it("sends parcels out for delivery and enters signed slips as delivered, with the slip photo and COD", async () => {
    const s = await setup();
    const id = await atHub(s);

    // Out for delivery: still at the hub, the rider is chosen first.
    expect(await scan(s.desk.token, "dispatch", { code: id })).toMatchObject({ ok: false, outcome: "RIDER_REQUIRED" });
    expect(await scan(s.desk.token, "dispatch", { code: id.toLowerCase(), riderId: s.rider.rider.id })).toMatchObject({ ok: true, outcome: "OUT_FOR_DELIVERY", message: `${id} is out for delivery with Rider R-6001.` });
    expect(await scan(s.desk.token, "dispatch", { code: id })).toMatchObject({ ok: true, outcome: "ALREADY_OUT" });
    expect(await scan(s.other.token, "deliver", { code: id })).toMatchObject({ ok: false, outcome: "OTHER_HUB" });

    // Delivered entry: the cash must match; then delivered for the rider, with the slip photo.
    expect(await scan(s.desk.token, "deliver", { code: id, codCollected: 1000 })).toMatchObject({ ok: false, outcome: "COD_MISMATCH" });
    const done = await scan(s.desk.token, "deliver", { code: id, photo: PNG });
    expect(done).toMatchObject({ ok: true, outcome: "DELIVERED", message: `${id} delivered by Rider R-6001 · ৳1,500 cash with the rider · slip photo saved.` });
    const p = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id }, include: { proof: true, codCollection: true } });
    expect(p).toMatchObject({ status: "DELIVERED", receiverRelation: "Self", proof: { method: "SIGNATURE", receivedBy: "Nabila Ahmed" }, codCollection: { riderId: s.rider.rider.id } });
    expect(p.proof!.fileId).toBeTruthy();
    expect(Number(p.codCollection!.amount)).toBe(1500);
    expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.desk_delivery", entityId: p.id } })).toBe(1);
    expect(await ctx.prisma.riderEarning.count({ where: { riderId: s.rider.rider.id, type: "DELIVERY" } })).toBe(1);

    // Scanned again: nothing to change, or the details are updated (no second delivery, no second COD).
    expect(await scan(s.desk.token, "deliver", { code: id })).toMatchObject({ ok: true, outcome: "ALREADY_DELIVERED" });
    expect(await scan(s.desk.token, "deliver", { code: id, receivedBy: "Guard at the gate", note: "Signed by the building guard" })).toMatchObject({ ok: true, outcome: "UPDATED" });
    expect(await ctx.prisma.deliveryProof.findUniqueOrThrow({ where: { parcelId: p.id } })).toMatchObject({ receivedBy: "Guard at the gate", note: "Signed by the building guard" });
    expect(await ctx.prisma.codCollection.count({ where: { parcelId: p.id } })).toBe(1);

    // A parcel with no delivery rider can't be entered as delivered.
    const waiting = await atHub(s);
    expect(await scan(s.desk.token, "deliver", { code: waiting })).toMatchObject({ ok: false, outcome: "NOT_WITH_RIDER" });
    expect(await scan(s.desk.token, "deliver", { code: "PP-000000-0000" })).toMatchObject({ ok: false, outcome: "NOT_FOUND" });
  });
  it("partial delivery: the cash actually collected, a return order back to the merchant, its return charge and the product type set by operations", async () => {
    const s = await setup();
    const id = await atHub(s);
    expect(await scan(s.desk.token, "dispatch", { code: id, riderId: s.rider.rider.id })).toMatchObject({ ok: true });

    // The cash: required, from 0 to the COD amount (৳1,500).
    expect(await scan(s.desk.token, "deliver", { code: id, partial: true })).toMatchObject({ ok: false, message: expect.stringContaining("Enter the cash collected") });
    expect(await scan(s.desk.token, "deliver", { code: id, partial: true, codCollected: 2000 })).toMatchObject({ ok: false, message: expect.stringContaining("from ৳0 to the COD amount") });
    // Without Partial delivery the full COD is still required.
    expect(await scan(s.desk.token, "deliver", { code: id, codCollected: 600 })).toMatchObject({ ok: false, outcome: "COD_MISMATCH" });

    // Receiver relations: the standard list (no super admin list saved), Self first.
    const relations = (await ctx.api("GET", "/delivery/receiver-relations", { token: s.desk.token })).body.relations;
    expect(relations[0]).toBe("Self");
    expect(relations).toContain("Father");
    const done = await scan(s.desk.token, "deliver", { code: id, partial: true, codCollected: 600, note: "Kept the shirt, returned the jeans", receiverRelation: "Father" });
    expect(done).toMatchObject({ ok: true, outcome: "PARTIALLY_DELIVERED" });
    const returnId = (done as unknown as { returnOrder: string }).returnOrder;
    expect(returnId.slice(0, 3)).toBe(id.slice(0, 3)); // the same parcel type prefix (EP / FD / CP)

    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id }, include: { codCollection: true } });
    expect(parcel).toMatchObject({ status: "DELIVERED", partialDelivery: true, partialNote: "Kept the shirt, returned the jeans", receiverRelation: "Father" });
    expect(Number(parcel.codCollectedAmount)).toBe(600);
    expect(Number(parcel.codCollection!.amount)).toBe(600);
    // The merchant's account: the COD actually collected (Accounts), not the full COD.
    const cod = await ctx.prisma.accountEntry.findFirstOrThrow({ where: { parcelId: parcel.id, type: "COD" } });
    expect(Number(cod.amount)).toBe(600);

    // The return order: same merchant, back to its pickup address, nothing to collect, no delivery charge, waiting at the hub.
    const ret = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: returnId } });
    expect(ret).toMatchObject({ merchantId: s.shop.id, returnOfId: parcel.id, status: "RETURN_SCHEDULED", currentHubId: s.gulshan.id, pickupStreet: parcel.pickupStreet, merchantOrderRef: null });
    expect([Number(ret.codAmount), Number(ret.totalCharge)]).toEqual([0, 0]);
    const charge = Number(ret.returnCharge);
    expect(charge).toBeGreaterThan(0);
    // Both directions show the link.
    const view = await ctx.api("GET", `/parcels/${id}`, { token: s.ops.token });
    expect(view.body.partialDelivery).toMatchObject({ codCollected: 600, codAmount: 1500, note: "Kept the shirt, returned the jeans", returnOrders: [{ trackingId: returnId, status: "RETURN_SCHEDULED" }] });
    expect((await ctx.api("GET", `/parcels/${returnId}`, { token: s.ops.token })).body).toMatchObject({ returnOf: id, returnInfo: { charge } });

    // Operations: no return charge for it (until it is returned), then charged again.
    const waived = await ctx.api("POST", `/parcels/${returnId}/return-charge`, { token: s.ops.token, body: { charge: false, reason: "Customer's size issue" } });
    expect(waived.body).toEqual({ trackingId: returnId, returnCharge: 0, waived: true });
    expect((await ctx.api("POST", `/parcels/${returnId}/return-charge`, { token: s.ops.token, body: { charge: true } })).body).toMatchObject({ returnCharge: charge, waived: false });
    expect((await ctx.api("POST", `/parcels/${id}/return-charge`, { token: s.ops.token, body: { charge: false } })).body.error.code).toBe("NOT_A_RETURN");
    expect((await ctx.api("POST", `/parcels/${returnId}/return-charge`, { token: s.desk.token, body: { charge: false } })).status).toBe(200);

    // Operations: priced as Books instead of Regular (re-priced with its package); the same type again is refused.
    const before = Number(parcel.totalCharge);
    const typed = await ctx.api("POST", `/parcels/${id}/product-type`, { token: s.ops.token, body: { productType: "BOOKS" } });
    expect(typed.status, JSON.stringify(typed.body)).toBe(200);
    expect(typed.body).toMatchObject({ productType: "BOOKS", from: "REGULAR", totalCharge: { from: before } });
    expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).productType).toBe("BOOKS");
    expect((await ctx.api("POST", `/parcels/${id}/product-type`, { token: s.ops.token, body: { productType: "BOOKS" } })).body.error.code).toBe("NO_CHANGE");
    expect(await ctx.prisma.auditLog.count({ where: { action: { in: ["parcel.product_type_change", "parcel.return_charge"] } } })).toBe(4);
  });

  it("records entries at the operation time chosen on the Scan desk (X-Operation-Time)", async () => {
    const s = await setup();
    const id = await atHub(s);
    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } });
    // Its history so far happened three hours ago.
    await ctx.prisma.trackingEvent.updateMany({ where: { parcelId: parcel.id }, data: { createdAt: new Date(Date.now() - 3 * 3_600_000) } });
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
    const dated = (when: Date, path: string, body: Record<string, unknown>) =>
      ctx.api("POST", `/hub-desk/${path}`, { token: s.desk.token, body, headers: { "x-operation-time": when.toISOString() } });

    // Never ahead, at most 30 days back, not before the parcel's last update.
    expect((await dated(at(-2), "dispatch", { code: id, riderId: s.rider.rider.id })).body.error.code).toBe("OPERATION_TIME_IN_FUTURE");
    expect((await dated(at(24 * 31), "dispatch", { code: id, riderId: s.rider.rider.id })).body.error.code).toBe("OPERATION_TIME_TOO_OLD");
    const early = await dated(at(4), "dispatch", { code: id, riderId: s.rider.rider.id });
    expect(JSON.stringify(early.body)).toContain("before its last update");
    expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { id: parcel.id } })).status).toBe("AT_HUB");

    const out = at(2);
    expect((await dated(out, "dispatch", { code: id, riderId: s.rider.rider.id })).body).toMatchObject({ ok: true, outcome: "OUT_FOR_DELIVERY" });
    const delivered = at(1);
    expect((await dated(delivered, "deliver", { code: id })).body).toMatchObject({ ok: true, outcome: "DELIVERED" });

    const p = await ctx.prisma.parcel.findUniqueOrThrow({ where: { id: parcel.id }, include: { codCollection: true } });
    expect(p.deliveredAt).toEqual(delivered);
    expect(p.codCollection!.collectedAt).toEqual(delivered);
    const events = await ctx.prisma.trackingEvent.findMany({ where: { parcelId: parcel.id, status: { in: ["OUT_FOR_DELIVERY", "DELIVERED"] } }, orderBy: { createdAt: "asc" } });
    expect(events.map(e => [e.status, e.createdAt.toISOString()])).toEqual([
      ["OUT_FOR_DELIVERY", out.toISOString()],
      ["DELIVERED", delivered.toISOString()],
    ]);
    // The audit keeps when it was entered (createdAt) and when it happened.
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "parcel.desk_delivery", entityId: parcel.id } });
    expect(audit.data).toMatchObject({ operationAt: delivered.toISOString() });
    expect(audit.createdAt.getTime()).toBeGreaterThan(delivered.getTime());

    // Merchants can't date their changes.
    const merchant = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: s.shop.id }], "Shop Owner");
    const refused = await ctx.api("POST", "/parcels", { token: merchant.token, body: parcelBody(), headers: { "x-operation-time": at(1).toISOString() } });
    expect(refused.body.error.code).toBe("OPERATION_TIME_NOT_ALLOWED");
  });
  it("enters pickups, failed deliveries and parcels coming back from riders at the desk", async () => {
    const s = await setup();
    // Pickup entry: booked and given to the pickup rider, the rider brings it to the hub.
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId: s.shop.id, ...parcelBody(), sender: undefined, pickup: undefined } });
    const id = res.body.trackingId as string;
    expect(await scan(s.desk.token, "pickup", { code: id })).toMatchObject({ ok: false, outcome: "NOT_WITH_PICKUP_RIDER" });
    await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    expect(await scan(s.desk.token, "pickup", { code: id })).toMatchObject({ ok: true, outcome: "RECEIVED", message: `${id} picked up by Rider R-6001 and received at Test Hub HUB-GUL.` });
    expect(await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id });
    expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.desk_pickup" } })).toBe(1);
    expect(await scan(s.desk.token, "pickup", { code: id })).toMatchObject({ ok: true, outcome: "ALREADY_RECEIVED" });

    // Failed delivery, try again: stays with the rider; the rider brings it back: received.
    await scan(s.desk.token, "dispatch", { code: id, riderId: s.rider.rider.id });
    const early = await ctx.api("POST", "/ops/hub-receive", { token: s.desk.token, body: { code: id, hubId: s.gulshan.id } });
    expect(early.body).toMatchObject({ ok: false, outcome: "REFUSED", message: expect.stringContaining("Failed delivery entry") });
    expect(await scan(s.desk.token, "failed", { code: id, reason: "Recipient unavailable", nextAction: "RETRY" })).toMatchObject({ ok: true, outcome: "RETRY_SCHEDULED" });
    expect(await ctx.prisma.deliveryAttempt.count({ where: { parcel: { trackingId: id }, outcome: "FAILED" } })).toBe(1);
    // Scanned again (double scan / retried request): already recorded; no second attempt, fee or attempt count.
    const before = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id }, select: { attemptCount: true, totalCharge: true } });
    expect(await scan(s.desk.token, "failed", { code: id, reason: "Recipient unavailable", nextAction: "RETRY" })).toMatchObject({ ok: true, outcome: "ALREADY_RECORDED" });
    expect(await ctx.prisma.deliveryAttempt.count({ where: { parcel: { trackingId: id }, outcome: "FAILED" } })).toBe(1);
    const after = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id }, select: { attemptCount: true, totalCharge: true } });
    expect(after.attemptCount).toBe(before.attemptCount);
    expect(Number(after.totalCharge)).toBe(Number(before.totalCharge));
    // The receive desk takes it like any arrival (the rider released).
    const back = await ctx.api("POST", "/ops/hub-receive", { token: s.desk.token, body: { code: id, hubId: s.gulshan.id } });
    expect(back.body).toMatchObject({ ok: true, outcome: "RECEIVED", message: `${id} received back at Test Hub HUB-GUL.` });
    expect(await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).toMatchObject({ status: "AT_HUB", deliveryRiderId: null });

    // Failed delivery, back at the hub in one step.
    await scan(s.desk.token, "dispatch", { code: id, riderId: s.rider.rider.id });
    expect(await scan(s.desk.token, "failed", { code: id, reason: "Incorrect address", nextAction: "RETURN_TO_HUB" })).toMatchObject({ ok: true, outcome: "BACK_AT_HUB" });
    expect(await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id, deliveryRiderId: null });

    // A return run the merchant couldn't take: the rider brings it back, off the run.
    const run = await ctx.api("POST", "/returns/runs", { token: s.ops.token, body: { merchantId: s.shop.id, trackingIds: [id], hubId: s.gulshan.id, riderId: s.rider.rider.id, reason: "Customer refused" } });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect((await ctx.api("POST", `/returns/runs/${run.body.id}/dispatch`, { token: s.ops.token, body: {} })).status).toBeLessThan(300);
    const unreturned = await ctx.api("POST", "/ops/hub-receive", { token: s.desk.token, body: { code: id, hubId: s.gulshan.id } });
    expect(unreturned.body).toMatchObject({ ok: true, outcome: "RECEIVED", message: expect.stringContaining("not completed") });
    expect(await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).toMatchObject({ status: "AT_HUB", returnRunId: null });
  });
  it("sends a received parcel to another hub by scanning (in transit), to the hub serving its zone or the one chosen", async () => {
    const s = await setup();
    const dhanmondi = await ctx.prisma.hub.findUniqueOrThrow({ where: { code: "HUB-DHN" } });
    const id = await atHub(s);
    // No hub serves Dhanmondi yet: the destination must be chosen.
    expect(await scan(s.desk.token, "transfer", { code: id })).toMatchObject({ ok: false, outcome: "NO_DESTINATION" });
    // Served by this hub: delivered from here, not transferred.
    const zone = await ctx.prisma.deliveryZone.create({ data: { code: "DC-DHN", name: "Dhanmondi", district: "Dhaka Central", hubId: s.gulshan.id } });
    expect(await scan(s.desk.token, "transfer", { code: id })).toMatchObject({ ok: false, outcome: "DELIVERED_FROM_HERE" });
    // Served by Dhanmondi: sent there, in transit.
    await ctx.prisma.deliveryZone.update({ where: { id: zone.id }, data: { hubId: dhanmondi.id } });
    expect(await scan(s.desk.token, "transfer", { code: id })).toMatchObject({ ok: true, outcome: "IN_TRANSIT", message: `${id} sent to Test Hub HUB-DHN (in transit).` });
    expect(await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).toMatchObject({ status: "IN_TRANSIT", currentHubId: dhanmondi.id });
    expect(await scan(s.desk.token, "transfer", { code: id })).toMatchObject({ ok: true, outcome: "ALREADY_IN_TRANSIT" });
    // The chosen hub wins over the zone's.
    const other = await atHub(s);
    const chosen = await scan(s.ops.token, "transfer", { code: other, toHubId: dhanmondi.id });
    expect(chosen, JSON.stringify(chosen)).toMatchObject({ ok: true, outcome: "IN_TRANSIT" });
  });
  it("enters returns the sender took back; the run completes with its last parcel", async () => {
    const s = await setup();
    const a = await atHub(s);
    const b = await atHub(s);
    expect(await scan(s.desk.token, "return", { code: a })).toMatchObject({ ok: false, outcome: "NOT_ON_RETURN" });
    const run = await ctx.api("POST", "/returns/runs", { token: s.ops.token, body: { merchantId: s.shop.id, trackingIds: [a, b], hubId: s.gulshan.id, riderId: s.rider.rider.id, reason: "Customer refused" } });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    await ctx.api("POST", `/returns/runs/${run.body.id}/dispatch`, { token: s.ops.token, body: {} });

    expect(await scan(s.desk.token, "return", { code: a, receivedBy: "Shop manager" })).toMatchObject({ ok: true, outcome: "RETURNED", message: `${a} returned to Desk Shop.` });
    expect(await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: a } })).toMatchObject({ status: "RETURNED" });
    expect((await ctx.prisma.returnRun.findUniqueOrThrow({ where: { id: run.body.id } })).status).toBe("OUT_FOR_RETURN");
    expect(await scan(s.desk.token, "return", { code: a })).toMatchObject({ ok: true, outcome: "ALREADY_RETURNED" });

    expect(await scan(s.desk.token, "return", { code: b })).toMatchObject({ ok: true, outcome: "RETURNED", message: expect.stringContaining("completed") });
    expect((await ctx.prisma.returnRun.findUniqueOrThrow({ where: { id: run.body.id } })).status).toBe("COMPLETED");
    expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.desk_return" } })).toBe(2);
  });
  it("assigns returns to a rider by scanning: one planned run per merchant and rider, then out and back", async () => {
    const s = await setup();
    const a = await atHub(s);
    const b = await atHub(s);
    const assign = (code: string, extra: Record<string, unknown> = {}) => scan(s.desk.token, "return-assign", { code, riderId: s.rider.rider.id, ...extra });
    // A reason is needed for a parcel nobody asked to return yet.
    expect(await assign(a)).toMatchObject({ ok: false, outcome: "REFUSED", message: expect.stringContaining("return reason") });
    const first = await assign(a, { reason: "Recipient refused" });
    expect(first).toMatchObject({ ok: true, outcome: "ASSIGNED" });
    const second = await assign(b, { reason: "Recipient refused" });
    expect(second).toMatchObject({ ok: true, outcome: "ASSIGNED", run: (first as unknown as { run: string }).run, message: expect.stringContaining("(2 parcels)") });
    expect(await assign(a)).toMatchObject({ ok: true, outcome: "ALREADY_ON_RUN" });

    const runs = await ctx.api("GET", "/hub-desk/return-runs", { token: s.desk.token });
    expect(runs.body.items).toEqual([expect.objectContaining({ merchant: expect.objectContaining({ name: "Desk Shop" }), rider: "Rider R-6001 (R-6001)", parcels: 2 })]);
    expect((await ctx.api("POST", `/returns/runs/${runs.body.items[0].id}/dispatch`, { token: s.desk.token, body: {} })).status).toBeLessThan(300);
    expect((await ctx.api("GET", "/hub-desk/return-runs", { token: s.desk.token })).body.items).toEqual([]);
    expect(await scan(s.desk.token, "return", { code: a })).toMatchObject({ ok: true, outcome: "RETURNED" });
    expect(await scan(s.desk.token, "return", { code: b })).toMatchObject({ ok: true, outcome: "RETURNED", message: expect.stringContaining("completed") });
  });
  it("receives a re-attempt that has no rider the regular way at the receive desk", async () => {
    const s = await setup();
    const id = await atHub(s);
    // A re-attempt nobody has been given yet (e.g. moved there by operations): no rider to release.
    await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { status: "RETRY_SCHEDULED", deliveryRiderId: null } });
    const res = await ctx.api("POST", "/ops/hub-receive", { token: s.desk.token, body: { code: id, hubId: s.gulshan.id } });
    expect(res.body).toMatchObject({ ok: true, outcome: "RECEIVED" });
    expect(await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id });
  });
});
