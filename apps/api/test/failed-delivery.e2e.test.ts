import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// Failed deliveries (read-only views): failedAttempts / lastFailedAttempt / returnedAfterFailure / attempts
// on GET /parcels and GET /parcels/:id, the failedAttempts and failedBefore filters, stage=failed (retry
// scheduled + back at a hub after a failure) and its count, plus "Return to sender" through the existing
// return steps (status RETURN_SCHEDULED, a new run, or POST /returns/runs/:id/parcels).
describe("failed deliveries: views, filters, counts and return to sender", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 7000;
  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const shop = await ctx.prisma.merchant.create({
      data: { code: `MR-${++seq}`, type: "ECOMMERCE", name: "Failure Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000000", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    const other = await ctx.prisma.merchant.create({
      data: { code: `MR-${++seq}`, type: "ECOMMERCE", name: "Other Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000001", pickupAddress: "House 6 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: shop.id }], "Shop Owner");
    const otherOwner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: other.id }], "Other Owner");
    const rider = await riderUser(ctx, "R-7001", gulshan.id);
    return { gulshan, shop, other, ops, owner, otherOwner, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Booked, picked up to the hub and assigned to the delivery rider (ASSIGNED). */
  const withRider = async (s: Setup, merchantId = s.shop.id) => {
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId, ...parcelBody(), sender: undefined, pickup: undefined } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.trackingId as string;
    await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const atHub = await ctx.api("POST", `/rider/parcels/${id}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId: s.gulshan.id } });
    expect(atHub.body.status, JSON.stringify(atHub.body)).toBe("AT_HUB");
    const assigned = await ctx.api("POST", `/parcels/${id}/assign-delivery`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    expect(assigned.body.status, JSON.stringify(assigned.body)).toBe("ASSIGNED");
    return id;
  };
  const fail = async (s: Setup, id: string, nextAction: "RETRY" | "RETURN_TO_HUB", reason: string) => {
    const res = await ctx.api("POST", `/rider/parcels/${id}/delivery`, { token: s.rider.token, body: { outcome: "FAILED", reason, nextAction, ...(nextAction === "RETURN_TO_HUB" ? { hubId: s.gulshan.id } : {}) } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const ids = async (token: string, query: string) => {
    const res = await ctx.api("GET", `/parcels?limit=200&${query}`, { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.items as { trackingId: string }[]).map(p => p.trackingId).sort();
  };

  it("shows the failure on the parcel and lists failed deliveries with a matching count", async () => {
    const s = await setup();
    const back = await withRider(s);
    const retry = await withRider(s);
    const fine = await withRider(s);

    expect(await fail(s, back, "RETURN_TO_HUB", "Unable to contact recipient")).toMatchObject({ status: "AT_HUB", attemptCount: 1 });
    expect(await fail(s, retry, "RETRY", "Recipient unavailable")).toMatchObject({ status: "RETRY_SCHEDULED", attemptCount: 1 });

    // Staff detail: the count, the last failure with the rider and the attempt history.
    const detail = (await ctx.api("GET", `/parcels/${back}`, { token: s.ops.token })).body;
    expect(detail).toMatchObject({
      status: "AT_HUB",
      attemptCount: 1,
      failedAttempts: 1,
      returnedAfterFailure: true,
      lastFailedAttempt: { reason: "Unable to contact recipient", nextAction: "RETURN_TO_HUB", riderName: "Rider R-7001" },
    });
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ outcome: "FAILED", reason: "Unable to contact recipient", rider: { code: "R-7001", name: "Rider R-7001" } });
    // In the list too (one batched load for the page).
    const list = (await ctx.api("GET", "/parcels?stage=hub", { token: s.ops.token })).body.items;
    expect(list.find((p: { trackingId: string }) => p.trackingId === back)).toMatchObject({ failedAttempts: 1, returnedAfterFailure: true, lastFailedAttempt: { reason: "Unable to contact recipient" } });
    const retryView = (await ctx.api("GET", `/parcels/${retry}`, { token: s.ops.token })).body;
    expect(retryView).toMatchObject({ failedAttempts: 1, returnedAfterFailure: false, lastFailedAttempt: { reason: "Recipient unavailable" } });
    const fineView = (await ctx.api("GET", `/parcels/${fine}`, { token: s.ops.token })).body;
    expect(fineView).toMatchObject({ failedAttempts: 0, returnedAfterFailure: false, lastFailedAttempt: null, attempts: [] });

    // Failed delivery: retry scheduled + back at the hub after a failure (stage and filter agree).
    expect(await ids(s.ops.token, "stage=failed")).toEqual([back, retry].sort());
    expect(await ids(s.ops.token, "failedAttempts=true")).toEqual([back, retry].sort());
    expect(await ids(s.ops.token, "stage=problems")).toEqual([back, retry].sort());
    // Waiting for a delivery rider › Failed before.
    expect(await ids(s.ops.token, "stage=delivery_waiting&failedBefore=true")).toEqual([back]);
    expect(await ids(s.ops.token, "stage=delivery_waiting&failedBefore=false")).toEqual([]);
    expect(await ids(s.ops.token, "failedBefore=false")).toEqual([fine]);
    expect((await ctx.api("GET", "/parcels?failedBefore=maybe", { token: s.ops.token })).status).toBe(422);

    const counts = (await ctx.api("GET", "/ops/stage-counts", { token: s.ops.token })).body;
    expect(counts.detail).toMatchObject({ failed: 2, backAfterFailure: 1, deliveryWaiting: 1 });
    expect(counts.stages.problems).toBe(2);

    // Re-attempt: assigned again, it's no longer "back after failure" (but still failed before).
    const again = await ctx.api("POST", `/parcels/${back}/assign-delivery`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    expect(again.body).toMatchObject({ status: "ASSIGNED", returnedAfterFailure: false, failedAttempts: 1 });
    expect(await ids(s.ops.token, "stage=failed")).toEqual([retry]);
    expect(await ids(s.ops.token, "failedBefore=true")).toEqual([back, retry].sort());
    // A second failure counts twice.
    expect(await fail(s, back, "RETURN_TO_HUB", "Incorrect address")).toMatchObject({ failedAttempts: 2, returnedAfterFailure: true, lastFailedAttempt: { reason: "Incorrect address" } });
  });

  it("shows merchants their own parcels' failures without staff details", async () => {
    const s = await setup();
    const own = await withRider(s);
    const others = await withRider(s, s.other.id);
    await fail(s, own, "RETURN_TO_HUB", "Unable to contact recipient");
    await fail(s, others, "RETURN_TO_HUB", "Unable to contact recipient");

    const view = (await ctx.api("GET", `/parcels/${own}`, { token: s.owner.token })).body;
    expect(view).toMatchObject({ failedAttempts: 1, returnedAfterFailure: true, lastFailedAttempt: { reason: "Unable to contact recipient" } });
    expect(view.lastFailedAttempt.riderName).toBeUndefined();
    expect(view.attempts).toBeUndefined();
    expect((await ctx.api("GET", `/parcels/${others}`, { token: s.owner.token })).status).toBe(404);
    expect(await ids(s.owner.token, "failedAttempts=true")).toEqual([own]);
    expect(await ids(s.otherOwner.token, "failedAttempts=true")).toEqual([others]);
  });

  it("returns a failed parcel to the sender: scheduled, on a new run or added to an open run", async () => {
    const s = await setup();
    const scheduled = await withRider(s);
    const onNewRun = await withRider(s);
    const added = await withRider(s);
    for (const id of [scheduled, onNewRun, added]) await fail(s, id, "RETURN_TO_HUB", "Recipient refused");

    // "Return to sender" without a run: the existing status step, the reason recorded.
    const sched = await ctx.api("POST", `/parcels/${scheduled}/status`, { token: s.ops.token, body: { status: "RETURN_SCHEDULED", note: "Recipient refused" } });
    expect(sched.body, JSON.stringify(sched.body)).toMatchObject({ status: "RETURN_SCHEDULED", returnInfo: { reason: "Recipient refused", runId: null } });
    expect(await ids(s.ops.token, "stage=failed")).toEqual([onNewRun, added].sort());
    // It waits on the Returns page with the requests (not on a run yet).
    const requested = (await ctx.api("GET", "/returns?stage=requested", { token: s.ops.token })).body.items;
    expect(requested.map((r: { trackingId: string }) => r.trackingId)).toEqual([scheduled]);

    // A new run: the parcel goes RETURN_SCHEDULED on it; the scheduled one (no run yet) joins it too.
    const run = await ctx.api("POST", "/returns/runs", { token: s.ops.token, body: { merchantId: s.shop.id, trackingIds: [onNewRun, scheduled], reason: "Recipient refused" } });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.parcels.map((p: { trackingId: string }) => p.trackingId).sort()).toEqual([onNewRun, scheduled].sort());
    const joined = (await ctx.api("GET", `/parcels/${scheduled}`, { token: s.ops.token })).body;
    expect(joined).toMatchObject({ status: "RETURN_SCHEDULED", returnInfo: { runId: run.body.id } });
    expect(joined.events.at(-1)).toMatchObject({ title: `Added to return run ${run.body.number}`, internal: true });

    // Added to the open run.
    const add = await ctx.api("POST", `/returns/runs/${run.body.id}/parcels`, { token: s.ops.token, body: { trackingIds: [added], reason: "Recipient refused" } });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.parcelCount).toBe(3);
    expect((await ctx.api("GET", `/parcels/${added}`, { token: s.ops.token })).body).toMatchObject({ status: "RETURN_SCHEDULED", returnInfo: { runId: run.body.id, reason: "Recipient refused" } });
    expect(await ids(s.ops.token, "stage=failed")).toEqual([]);
    expect(await ctx.prisma.auditLog.count({ where: { action: "return_run.add_parcels", entityId: run.body.id } })).toBe(1);

    // Already on a run; another merchant's run; a run that left already.
    const twice = await ctx.api("POST", `/returns/runs/${run.body.id}/parcels`, { token: s.ops.token, body: { trackingIds: [added] } });
    expect(twice.status).toBe(422);
    expect(twice.body.error.details.problems[0].message).toMatch(/already on a return run/);
    const foreign = await withRider(s, s.other.id);
    await fail(s, foreign, "RETURN_TO_HUB", "Recipient refused");
    const wrong = await ctx.api("POST", `/returns/runs/${run.body.id}/parcels`, { token: s.ops.token, body: { trackingIds: [foreign], reason: "Recipient refused" } });
    expect(wrong.body.error.details.problems[0].message).toMatch(/another merchant/);
    await ctx.api("POST", `/returns/runs/${run.body.id}/dispatch`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const late = await withRider(s);
    await fail(s, late, "RETURN_TO_HUB", "Recipient refused");
    const closed = await ctx.api("POST", `/returns/runs/${run.body.id}/parcels`, { token: s.ops.token, body: { trackingIds: [late], reason: "Recipient refused" } });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("RUN_NOT_PLANNED");
    // Merchants can't add to runs.
    expect((await ctx.api("POST", `/returns/runs/${run.body.id}/parcels`, { token: s.owner.token, body: { trackingIds: [late] } })).status).toBe(403);
  });
});
