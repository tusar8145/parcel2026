import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NUMBER_PREFIXES } from "@paira-express/shared";
import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/** Every .ts file under src (not generated code). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === "generated" || name === "seed") return [];
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

describe("system guide", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  it("lists every number prefix the code generates", () => {
    const code = sources(join(__dirname, "..", "src")).map(f => readFileSync(f, "utf8")).join("\n");
    const made = new Set<string>();
    for (const m of code.matchAll(/nextNumber\(\s*\w+\s*,\s*"([A-Z-]+)"/g)) made.add(m[1]);
    for (const m of code.matchAll(/`([A-Z]+)-\$\{await nextCounter\(/g)) made.add(m[1]);
    for (const m of code.matchAll(/`([A-Z]+)-\$\{day\}-/g)) made.add(m[1]);
    const listed = new Set(NUMBER_PREFIXES.map(p => p.prefix));
    listed.add("PP"); // nextTrackingId: older parcels and hub CN stock, deliberately left out of the guide
    expect([...made].filter(p => !listed.has(p))).toEqual([]);
    expect(made.size).toBeGreaterThanOrEqual(15);
  });

  it("is for staff: numbers, statuses with their next steps, money steps, roles and where to change things", async () => {
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
    const res = await ctx.api("GET", "/guide", { token: ops.token });
    expect(res.status).toBe(200);
    expect(res.body.numbers.find((n: { prefix: string }) => n.prefix === "HS")).toMatchObject({ name: "Cash handover slip", area: "Money" });
    expect(res.body.statuses.find((s: { status: string }) => s.status === "DELIVERED")).toMatchObject({ final: true, next: { operations: [], rider: [] } });
    expect(res.body.statuses.find((s: { status: string }) => s.status === "OUT_FOR_DELIVERY").next.rider).toContain("Delivered");
    expect(res.body.roles.find((r: { role: string }) => r.role === "RIDER")).toMatchObject({ panel: "/rider" });
    expect(res.body.money.length).toBeGreaterThan(3);
    expect(res.body.settings.length).toBeGreaterThan(5);
    const owner = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
    expect((await ctx.api("GET", "/guide", { token: owner.token })).status).toBe(403);
  });
});
