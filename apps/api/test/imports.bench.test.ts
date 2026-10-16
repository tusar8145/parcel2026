import { appendFileSync } from "node:fs";
import { ImportJobsService } from "../src/modules/imports/import-jobs.service";
import { writeXlsx } from "../src/modules/imports/xlsx/xlsx-writer";
import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/**
 * Import benchmark (IMPORT_BENCH=1 to run): validates and books spreadsheet files of 5,000 and
 * 10,000 rows on this machine's PostgreSQL, the numbers behind the limits in ImportConfigService.
 *   IMPORT_BENCH=1 TEST_DATABASE_URL=… npx vitest run test/imports.bench.test.ts
 */
describe.skipIf(!process.env.IMPORT_BENCH)("import benchmark", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
    await resetDatabase(ctx);
  });
  afterAll(() => ctx.app.close());

  const header = ["Order ID", "Customer name", "Customer phone", "Delivery address", "District", "Zone", "Service", "Weight (kg)", "COD amount (৳)", "Product type", "Delivery instructions"];
  const zones = [
    ["Dhaka Central", "Dhanmondi"],
    ["Dhaka Central", "Mirpur"],
    ["Dhaka North", "Banani"],
    ["Dhaka South", "Motijheel"],
  ];
  const file = (n: number, prefix: string) =>
    writeXlsx({
      sheets: [
        {
          name: "Orders",
          rows: [
            header,
            ...Array.from({ length: n }, (_, i) => {
              const [district, zone] = zones[i % zones.length];
              return [`${prefix}-${i}`, `Customer ${i}`, `01${7 + (i % 3)}${String(10_000_000 + i).slice(-8)}`, `House ${i}, Road ${i % 40}`, district, zone, i % 5 ? "Regular" : "Express", String(1 + (i % 4)), String((i % 10) * 250), "Clothing", i % 7 ? "" : "Call first"];
            }),
          ],
        },
      ],
    });

  for (const rows of [5_000, 10_000])
    it(`validates and books ${rows.toLocaleString("en-US")} rows`, async () => {
      const m = await ctx.prisma.merchant.create({
        data: { code: `MR-B${rows}`, type: "ECOMMERCE", name: `Bench ${rows}`, status: "ACTIVE", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "House 5", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
      });
      const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Owner");
      const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
      await ctx.api("PUT", "/imports/config", { token: admin.token, body: { limits: { merchantMaxRows: rows } } });
      const xlsx = file(rows, `B${rows}`);
      const boundary = "----bench";
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\necommerce\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bench.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        xlsx,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const rssBefore = process.memoryUsage().rss;
      let peak = rssBefore;
      const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
      const t0 = performance.now();
      const res = await ctx.app.inject({ method: "POST", url: "/api/v1/imports/validate", payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${owner.token}` } });
      const validateMs = performance.now() - t0;
      const job = JSON.parse(res.body);
      expect(res.statusCode, res.body.slice(0, 500)).toBe(201);
      expect(job.counts.valid).toBe(rows);
      const commit = await ctx.api("POST", `/imports/${job.id}/commit`, { token: owner.token });
      expect(commit.body.status).toBe("QUEUED");
      const t1 = performance.now();
      await ctx.app.get(ImportJobsService).process(job.id);
      const bookMs = performance.now() - t1;
      clearInterval(sampler);
      const done = await ctx.api("GET", `/imports/${job.id}`, { token: owner.token });
      expect(done.body.result.created).toBe(rows);
      const line = (
        `[import bench] ${rows} rows · file ${(xlsx.length / 1024).toFixed(0)} KB · validate ${(validateMs / 1000).toFixed(1)} s · book ${(bookMs / 1000).toFixed(1)} s (${Math.round(rows / (bookMs / 1000))} rows/s) · RSS +${((peak - rssBefore) / 1048576).toFixed(0)} MB (peak ${(peak / 1048576).toFixed(0)} MB)`
      );
      // Vitest may swallow console output: also append to IMPORT_BENCH_OUT when set.
      console.log(line);
      if (process.env.IMPORT_BENCH_OUT) appendFileSync(process.env.IMPORT_BENCH_OUT, `${line}
`);
    }, 1_800_000);
});
