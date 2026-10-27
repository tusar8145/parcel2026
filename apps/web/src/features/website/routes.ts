/**
 * The public website's URLs. The page scripts still think in their original route names
 * ("tracking", "orders" …); this table maps them to real paths (History API) and gives
 * each path its server-rendered title, description and indexing rule.
 *
 * Shared by the server (metadata, sitemap, robots) and the browser (public/legacy/shared/api.js
 * keeps a copy of the path mapping in DF.route — keep both in sync).
 */
export interface WebsiteRoute {
  /** Route name used by the page scripts (location of the view in 01.js). */
  legacy: string;
  /** URL path without the leading slash ("" = home). */
  path: string;
  title: string;
  description: string;
  /** Listed in sitemap.xml and indexable. Account, tracking and form-result pages are not. */
  index: boolean;
  /** Changes often (sitemap hint). */
  changeFrequency?: "daily" | "weekly" | "monthly" | "yearly";
  priority?: number;
}

export const SITE_NAME = "Paira Express";
export const HOME_TITLE = "Paira Express — Delivery that moves with you";
export const HOME_DESCRIPTION =
  "Paira Express delivers e-commerce orders, customer parcels, and important documents across Bangladesh. Track a parcel, get a price, or book a pickup.";

export const WEBSITE_ROUTES: WebsiteRoute[] = [
  { legacy: "home", path: "", title: HOME_TITLE, description: HOME_DESCRIPTION, index: true, changeFrequency: "weekly", priority: 1 },
  {
    legacy: "request",
    path: "request",
    title: "Paira Express — Request a pickup",
    description: "Book a parcel pickup anywhere we deliver in Bangladesh. Choose a pickup time, see the delivery charge before you book, and track it end to end.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.9,
  },
  {
    legacy: "tracking",
    path: "track",
    title: "Paira Express — Follow your delivery",
    description: "Track a Paira Express parcel with its tracking ID: current status, estimated arrival, route and shipment history. No account needed.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.9,
  },
  {
    legacy: "pricing",
    path: "pricing",
    title: "Paira Express — A clear estimate, before you book",
    description: "Delivery prices for parcels and documents across Bangladesh: same-zone and inter-city rates, weight charges, cash-on-delivery fees and same-day options.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.8,
  },
  {
    legacy: "services",
    path: "services",
    title: "Paira Express — Courier services in Bangladesh",
    description: "E-commerce deliveries with cash on delivery, customer parcels and secure document delivery for banks and institutions, across Bangladesh.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.8,
  },
  {
    legacy: "login",
    path: "login",
    title: "Paira Express — Log in to Paira Express",
    description: "Sign in to your Paira Express account with your password or an SMS code.",
    index: true,
    priority: 0.4,
  },
  {
    legacy: "signup",
    path: "signup",
    title: "Paira Express — Create your account",
    description: "Create a free Paira Express customer account to book pickups, save addresses and follow your parcels.",
    index: true,
    priority: 0.6,
  },
  {
    legacy: "merchant",
    path: "merchant",
    title: "Paira Express — Choose the right merchant account",
    description: "Ship your online shop's orders or your institution's documents with Paira Express. Apply for an e-commerce or Banking & Financial merchant account.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.7,
  },
  {
    legacy: "rider",
    // /rider is the riders' app.
    path: "become-a-rider",
    title: "Paira Express — Ride with Paira Express",
    description: "Apply to ride with Paira Express: choose your area and vehicle and earn per delivery.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.6,
  },
  {
    legacy: "franchise",
    // /franchise is the franchise hubs' panel.
    path: "become-a-franchise",
    title: "Paira Express — Operate a local delivery hub",
    description: "Run a Paira Express franchise: manage a territory, hub, riders, merchants and local parcel operations.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.6,
  },
  {
    legacy: "support",
    path: "support",
    title: "Paira Express — Customer support",
    description: "Ask about a delivery or pickup request and continue the conversation with Paira Express support.",
    index: false,
  },
  { legacy: "account", path: "account", title: "Paira Express — Your deliveries", description: "Your Paira Express account.", index: false },
  { legacy: "orders", path: "account/orders", title: "Paira Express — Orders & pickups", description: "Your Paira Express orders.", index: false },
  { legacy: "addresses", path: "account/addresses", title: "Paira Express — Address book", description: "Your saved addresses.", index: false },
  { legacy: "profile", path: "account/profile", title: "Paira Express — Your profile", description: "Your Paira Express profile.", index: false },
  { legacy: "verify-email", path: "account/verify-email", title: "Paira Express — Verify your email", description: "Confirm your email address.", index: false },
  { legacy: "submitted", path: "application-received", title: "Paira Express — Thanks for getting in touch", description: "Application received.", index: false },
];

/** Pages rendered by the server on their own (not through the page scripts' router). */
export const STATIC_PAGES = [
  { path: "about", title: "Paira Express — About us", description: "Paira Express: a nationwide courier and logistics service in Bangladesh since 2024 — our story, services, management, mission and how we work." },
  { path: "privacy", title: "Paira Express — Privacy Policy", description: "How Paira Express collects, uses and protects personal information of senders, recipients, merchants and riders in Bangladesh." },
  { path: "terms", title: "Paira Express — Terms of Service", description: "The terms for booking, sending, tracking and receiving parcels and documents with Paira Express." },
];

export function siteUrl(): string {
  return (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * The route for a URL path (segments after the domain). Tracking IDs follow /track/,
 * ticket numbers or tracking IDs follow /support/.
 */
export function routeForSegments(segments: string[]): { route: WebsiteRoute; param?: string } | null {
  const path = segments.map(s => decodeURIComponent(s)).join("/");
  const exact = WEBSITE_ROUTES.find(r => r.path === path);
  if (exact) return { route: exact };
  if (segments.length === 2 && (segments[0] === "track" || segments[0] === "support")) {
    const route = WEBSITE_ROUTES.find(r => r.path === segments[0])!;
    return { route, param: decodeURIComponent(segments[1]) };
  }
  return null;
}
