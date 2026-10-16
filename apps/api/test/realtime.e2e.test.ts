import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/** Collects SSE events from GET /events until `until` matches or the timeout passes. */
async function listen(baseUrl: string, token: string) {
  const controller = new AbortController();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const response = await fetch(`${baseUrl}/api/v1/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const type = block.match(/^event: (.*)$/m)?.[1] ?? "message";
          const data = block.match(/^data: (.*)$/m)?.[1];
          events.push({ type, data: data ? JSON.parse(data) : {} });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  const waitFor = async (predicate: (e: (typeof events)[number]) => boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = events.find(predicate);
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 50));
    }
    return undefined;
  };
  await waitFor(e => e.type === "ready");
  return { events, waitFor, close: () => (controller.abort(), pump) };
}

describe("realtime events", () => {
  let ctx: TestContext;
  let baseUrl: string;
  beforeAll(async () => {
    ctx = await startApp();
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = await ctx.app.getUrl();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  it("streams parcel changes only to people who may see them", async () => {
    const h = await hub(ctx);
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
    const stranger = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
    const rider = await riderUser(ctx, "R-3001", h.id);

    const [mine, theirs, staff, riderStream] = await Promise.all([customer, stranger, ops, rider].map(u => listen(baseUrl, u.token)));
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;

    expect(await mine.waitFor(e => e.type === "parcel.created" && e.data.id === trackingId)).toBeTruthy();
    expect(await staff.waitFor(e => e.type === "parcel.created" && e.data.id === trackingId)).toBeTruthy();

    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } });
    const update = await riderStream.waitFor(e => e.type === "parcel.updated" && e.data.id === trackingId);
    expect(update?.data.status).toBe("PICKUP_ASSIGNED");
    expect(await mine.waitFor(e => e.type === "parcel.updated" && e.data.id === trackingId)).toBeTruthy();

    expect(theirs.events.filter(e => e.type.startsWith("parcel."))).toEqual([]);
    await Promise.all([mine, theirs, staff, riderStream].map(s => s.close()));
  });

  it("requires a signed-in user", async () => {
    const response = await fetch(`${baseUrl}/api/v1/events`);
    expect(response.status).toBe(401);
  });
});
