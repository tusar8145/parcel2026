import { existsSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { RealtimeService, type RealtimeEvent } from "../src/common/realtime.service";
import { env } from "../src/config/env";
import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/** Courier Operations › Share files: a QR link other devices drop files into, gone when the dialog closes. */
describe("file shares", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const upload = (token: string, name: string, content: string) => {
    const boundary = "----dfShareTest";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return ctx.app.inject({ method: "POST", url: `/api/v1/file-shares/public/${token}/files`, payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
  };

  it("receives files for the user who opened it, downloads them, and deletes them when closed", async () => {
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const other = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Other Manager");
    const merchant = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER" }], "Shop Owner");
    expect((await ctx.api("POST", "/file-shares", { token: merchant.token })).status).toBe(403);

    const realtime = ctx.app.get(RealtimeService);
    const events: RealtimeEvent[] = [];
    const spy = vi.spyOn(realtime, "publish").mockImplementation((...e: RealtimeEvent[]) => void events.push(...e));
    try {
      const open = await ctx.api("POST", "/file-shares", { token: ops.token });
      expect(open.status, JSON.stringify(open.body)).toBe(201);
      expect(open.body.qrSvg).toContain("<svg");
      const token = String(open.body.url).split("/share/")[1];
      expect((await ctx.api("GET", `/file-shares/public/${token}`)).body).toMatchObject({ files: [], maxFileMb: 25 });

      const sent = await upload(token, "slip.txt", "signed slip");
      expect(sent.statusCode, sent.body).toBe(201);
      expect(events.find(e => e.type === "file_share.received")).toMatchObject({ userIds: [ops.user.id], data: { shareId: open.body.id, file: { name: "slip.txt", size: 11 } } });

      // Only the one who opened it sees and downloads the files.
      expect((await ctx.api("GET", `/file-shares/${open.body.id}`, { token: other.token })).status).toBe(404);
      const list = await ctx.api("GET", `/file-shares/${open.body.id}`, { token: ops.token });
      expect(list.body.files).toMatchObject([{ name: "slip.txt", size: 11 }]);
      const file = await ctx.api("GET", `/file-shares/${open.body.id}/files/${list.body.files[0].id}`, { token: ops.token });
      expect(file.status).toBe(200);
      expect(file.body).toBe("signed slip");
      expect(String(file.headers["content-disposition"])).toContain('filename="slip.txt"');

      // Closed: the link stops working and the files are deleted.
      const dir = path.resolve(env().FILE_STORAGE_DIR, "file-shares", open.body.id);
      expect(existsSync(dir)).toBe(true);
      expect((await ctx.api("DELETE", `/file-shares/${open.body.id}`, { token: ops.token })).status).toBe(200);
      expect(existsSync(dir)).toBe(false);
      expect((await ctx.api("GET", `/file-shares/public/${token}`)).status).toBe(410);
      const late = await upload(token, "late.txt", "too late");
      expect(late.statusCode).toBe(410);
      expect((await ctx.api("GET", `/file-shares/${open.body.id}`, { token: ops.token })).status).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });
});
