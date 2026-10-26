import { resetDatabase, startApp, type TestContext } from "./helpers";

/** "Paste a message": the order fields in a copied SMS / chat message (website booking, merchant order forms). */
describe("parse a pasted message", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());
  const parse = (text: string, kind = "customer") => ctx.api("POST", "/parse-message", { body: { text, kind } });

  it("reads a labelled English message: name, phone, address with its place, amount and note", async () => {
    const res = await parse("Order confirmed!\nName: Ayesha Rahman\nPhone: 01712-345678\nAddress: House 12, Road 5, Dhanmondi, Dhaka\nCOD: 1,250 Tk\nNote: call before delivery");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fields).toMatchObject({
      recipient_name: "Ayesha Rahman",
      recipient_phone: "01712345678",
      address: "House 12, Road 5, Dhanmondi, Dhaka",
      district: "Dhaka Central",
      zone: "Dhanmondi",
      cod_amount: "1250",
      instructions: "call before delivery",
    });
  });

  it("reads a one-line message with no labels: the name before the phone, the address after it", async () => {
    const res = await parse("Karim Mia 01911223344 Mirpur 10, Block C, Road 3, Dhaka. Total 2200 tk. Thanks for shopping with ShopX", "ecommerce");
    expect(res.body.fields).toMatchObject({ recipient_name: "Karim Mia", recipient_phone: "01911223344", address: "Mirpur 10, Block C, Road 3, Dhaka", cod_amount: "2200", zone: "Mirpur" });
  });

  it("reads Bangla: Bangla digits, the address as written, its place matched to the catalog", async () => {
    const res = await parse("প্রাপক: রহিম উদ্দিন\nমোবাইল: ০১৮১২৩৪৫৬৭৮\nঠিকানা: বাসা ৭, রোড ১১, বনানী, ঢাকা\nটাকা: ৯৫০");
    expect(res.body.fields).toMatchObject({ recipient_name: "রহিম উদ্দিন", recipient_phone: "01812345678", district: "Dhaka North", zone: "Banani", cod_amount: "950" });
    expect(res.body.fields.address).toContain("বনানী");
  });

  it("reads the name, address and phone on lines of their own, in any order", async () => {
    const one = await parse(["Abdul alim", "Bashundhara residential area, F block, House 12, Road 15", "01785412369"].join("\n"));
    expect(one.body.fields).toMatchObject({
      recipient_name: "Abdul alim",
      recipient_phone: "01785412369",
      address: "Bashundhara residential area, F block, House 12, Road 15",
    }); // its place: place-in-text.test.ts (the test catalog has no Vatara)
    // All on one line, the name running into the address.
    const line = await parse("Abdul alim Bashundhara residential area, F block, House 12, Road 15 01785412369");
    expect(line.body.fields).toMatchObject({ recipient_name: "Abdul alim", recipient_phone: "01785412369", address: "Bashundhara residential area, F block, House 12, Road 15" });
    const withCod = await parse("Abdul alim Bashundhara residential area, F block, House 12, Road 15 01785412369 cod 1200");
    expect(withCod.body.fields).toMatchObject({ recipient_name: "Abdul alim", address: "Bashundhara residential area, F block, House 12, Road 15", cod_amount: "1200" });
    const two = await parse(["01785412369", "Abdul alim", "Bashundhara R/A, Block F, House 12"].join("\n"));
    expect(two.body.fields).toMatchObject({ recipient_name: "Abdul alim", address: "Bashundhara R/A, Block F, House 12" });
    // A greeting line isn't a name.
    const three = await parse(["Dear sir, your parcel details:", "Sumaiya Akter", "01855-667788", "Flat 3B, House 22, Road 7, Uttara Sector 4, Dhaka"].join("\n"));
    expect(three.body.fields).toMatchObject({ recipient_name: "Sumaiya Akter", zone: "Uttara" });
  });

  it("returns only what it finds, and refuses empty or very long text", async () => {
    expect((await parse("Please deliver tomorrow")).body.fields.recipient_phone).toBeUndefined();
    expect((await parse("hi")).status).toBe(422);
    expect((await parse("x".repeat(3001))).status).toBe(422);
  });
});
