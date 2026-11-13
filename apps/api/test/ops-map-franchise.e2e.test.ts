import { hub, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// Courier Operations live map: franchise hubs' riders are left out, except for the franchise's own account.
describe("operations map without franchise riders", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  it("leaves franchise riders out unless that franchise hub is asked for", async () => {
    const company = await hub(ctx, "HUB-CO1");
    const franchiseHub = await ctx.prisma.hub.create({ data: { code: "HUB-FR1", name: "Franchise Hub", district: "Dhaka North", address: "Road 1", type: "FRANCHISE" } });
    const own = await riderUser(ctx, "R-8101", company.id);
    const fr = await riderUser(ctx, "R-8102", franchiseHub.id);
    for (const r of [own, fr]) await ctx.prisma.riderLocation.create({ data: { riderId: r.rider.id, lat: 23.79, lng: 90.41, accuracy: 10, at: new Date() } });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");

    const seen = async (token: string, query = "") => ((await ctx.api("GET", `/ops/rider-locations?includeOffShift=true${query}`, { token })).body.items as { code: string }[]).map(i => i.code).sort();
    expect(await seen(ops.token)).toEqual(["R-8101"]);
    expect(await seen(ops.token, `&hubId=${franchiseHub.id}`)).toEqual(["R-8102"]);
  });
});
