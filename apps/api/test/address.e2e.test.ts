import { addressText } from "../src/common/address";
import { parcelBody, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/**
 * Addresses everywhere: the typed address is the full address and is shown as typed (district, zone
 * and area are kept for operations, never appended); GET /catalog/place picks the district, zone and
 * area named in a typed address for the forms.
 */
describe("addresses", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  it("a parcel's address label is the address as typed, without its area / zone / district appended", async () => {
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const street = "Flat 4B, House 22, Road 7, Dhanmondi, Dhaka";
    const res = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ delivery: { category: "Home", street, area: "Dhanmondi Road 7", zone: "Dhanmondi", district: "Dhaka Central" } }) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const parcel = (await ctx.api("GET", `/parcels/${res.body.trackingId}`, { token: customer.token })).body;
    expect(parcel.delivery).toMatchObject({ street, label: street, area: "Dhanmondi Road 7", zone: "Dhanmondi", district: "Dhaka Central" });
    expect(parcel.pickup.label).toBe("House 5 Road 2");
  });

  it("no address typed: the place names stand in, once each", () => {
    expect(addressText("  House 9, Uttara  ", "Uttara", "Dhaka North")).toBe("House 9, Uttara");
    expect(addressText("", "Banani", "Banani", "Dhaka North")).toBe("Banani, Dhaka North");
    expect(addressText(null, null, undefined)).toBe("");
  });

  it("GET /catalog/place: the district, zone and area named in a typed address (public)", async () => {
    const place = (address: string) => ctx.api("GET", `/catalog/place?address=${encodeURIComponent(address)}`);
    const found = await place("Flat 4B, House 22, Road 7, Dhanmondi, Dhaka");
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ district: "Dhaka Central", zone: "Dhanmondi" });
    expect((await place("Somewhere unknown")).body).toEqual({});
    expect((await place("x".repeat(600))).status).toBe(422);
  });
});
