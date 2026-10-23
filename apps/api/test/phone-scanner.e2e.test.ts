import { vi } from "vitest";
import { RealtimeService, type RealtimeEvent } from "../src/common/realtime.service";
import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/** Courier Operations › Phone scanner: a phone becomes one panel tab's barcode scanner. */
describe("phone scanner", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  it("links a phone to the tab that opened it, sends its codes to that user only, returns the results, and disconnects", async () => {
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const other = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Other Manager");
    const merchant = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER" }], "Shop Owner");
    expect((await ctx.api("POST", "/phone-scanner/links", { token: merchant.token })).status).toBe(403);

    const realtime = ctx.app.get(RealtimeService);
    const events: RealtimeEvent[] = [];
    const spy = vi.spyOn(realtime, "publish").mockImplementation((...e: RealtimeEvent[]) => void events.push(...e));
    try {
      const open = await ctx.api("POST", "/phone-scanner/links", { token: ops.token });
      expect(open.status, JSON.stringify(open.body)).toBe(201);
      expect(open.body).toMatchObject({ phoneConnected: false, scans: 0 });
      expect(open.body.qrSvg).toContain("<svg");
      const token = String(open.body.url).split("/scanner/")[1];
      expect(token).toBeTruthy();

      // The phone opens the link: the tab is told it is connected.
      const page = await ctx.api("GET", `/phone-scanner/public/${token}`);
      expect(page.body).toMatchObject({ name: "Ops Manager", panel: "Courier Operations", scans: 0, results: [] });
      expect(events.find(e => e.type === "phone_scanner.status")).toMatchObject({ userIds: [ops.user.id], data: { linkId: open.body.id, phoneConnected: true } });

      // A code: only to that user (no staff permission sees it), for that tab's link.
      const scan = await ctx.api("POST", `/phone-scanner/public/${token}/scans`, { body: { code: "pp-261023-abcde" } });
      expect(scan.body).toEqual({ n: 1 });
      const sent = events.find(e => e.type === "phone_scanner.scan")!;
      expect(sent).toMatchObject({ userIds: [ops.user.id], data: { linkId: open.body.id, code: "pp-261023-abcde", n: 1 } });
      expect(realtime.canSee({ kind: "user", userId: other.user.id, sessionId: "s", name: "Other", roles: [{ role: "OPS_MANAGER" }], permissions: new Set(["parcel:read:any", "parcel:dispatch"]) } as never, sent)).toBe(false);
      expect((await ctx.api("POST", `/phone-scanner/public/${token}/scans`, { body: { code: "" } })).status).toBe(422);

      // The page's result goes back to the phone; nobody else can report or close it.
      expect((await ctx.api("POST", `/phone-scanner/links/${open.body.id}/results`, { token: other.token, body: { n: 1, ok: true } })).status).toBe(404);
      await ctx.api("POST", `/phone-scanner/links/${open.body.id}/results`, { token: ops.token, body: { n: 1, ok: false, message: "PP-261023-ABCDE is not at your hub" } });
      expect((await ctx.api("GET", `/phone-scanner/public/${token}`)).body).toMatchObject({ scans: 1, results: [{ n: 1, ok: false, message: "PP-261023-ABCDE is not at your hub" }] });
      expect((await ctx.api("POST", `/phone-scanner/links/${open.body.id}/keepalive`, { token: ops.token })).body).toMatchObject({ phoneConnected: true, scans: 1 });

      // Disconnect: the phone's link stops working at once.
      expect((await ctx.api("DELETE", `/phone-scanner/links/${open.body.id}`, { token: other.token })).status).toBe(404);
      expect((await ctx.api("DELETE", `/phone-scanner/links/${open.body.id}`, { token: ops.token })).status).toBe(200);
      const gone = await ctx.api("POST", `/phone-scanner/public/${token}/scans`, { body: { code: "PP-1" } });
      expect(gone.status).toBe(410);
      expect(gone.body.error.code).toBe("SCANNER_LINK_CLOSED");
      expect((await ctx.api("GET", `/phone-scanner/public/${token}`)).status).toBe(410);
      expect(await ctx.prisma.auditLog.count({ where: { entityType: "phone_scanner" } })).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
