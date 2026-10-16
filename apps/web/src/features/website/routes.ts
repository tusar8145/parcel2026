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

export const SITE_NAME = "Delivery Fast";
export const HOME_TITLE = "Delivery Fast — Delivery that moves with you";
export const HOME_DESCRIPTION =
  "Delivery Fast delivers e-commerce orders, customer parcels, and important documents across Bangladesh. Track a parcel, get a price, or book a pickup.";

export const WEBSITE_ROUTES: WebsiteRoute[] = [
  { legacy: "home", path: "", title: HOME_TITLE, description: HOME_DESCRIPTION, index: true, changeFrequency: "weekly", priority: 1 },
  {
    legacy: "request",
    path: "request",
    title: "Delivery Fast — Request a pickup",
    description: "Book a parcel pickup anywhere we deliver in Bangladesh. Choose a pickup time, see the delivery charge before you book, and track it end to end.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.9,
  },
  {
    legacy: "tracking",
    path: "track",
    title: "Delivery Fast — Follow your delivery",
    description: "Track a Delivery Fast parcel with its tracking ID: current status, estimated arrival, route and shipment history. No account needed.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.9,
  },
  {
    legacy: "pricing",
    path: "pricing",
    title: "Delivery Fast — A clear estimate, before you book",
    description: "Delivery prices for parcels and documents across Bangladesh: same-zone and inter-city rates, weight charges, cash-on-delivery fees and same-day options.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.8,
  },
  {
    legacy: "services",
    path: "services",
    title: "Delivery Fast — Courier services in Bangladesh",
    description: "E-commerce deliveries with cash on delivery, customer parcels and secure document delivery for banks and institutions, across Bangladesh.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.8,
  },
  {
    legacy: "login",
    path: "login",
    title: "Delivery Fast — Log in to Delivery Fast",
    description: "Sign in to your Delivery Fast account with your password or an SMS code.",
    index: true,
    priority: 0.4,
  },
  {
    legacy: "signup",
    path: "signup",
    title: "Delivery Fast — Create your account",
    description: "Create a free Delivery Fast customer account to book pickups, save addresses and follow your parcels.",
    index: true,
    priority: 0.6,
  },
  {
    legacy: "merchant",
    path: "merchant",
    title: "Delivery Fast — Choose the right merchant account",
    description: "Ship your online shop's orders or your institution's documents with Delivery Fast. Apply for an e-commerce or document merchant account.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.7,
  },
  {
    legacy: "rider",
    // /rider is the riders' app.
    path: "become-a-rider",
    title: "Delivery Fast — Ride with Delivery Fast",
    description: "Apply to ride with Delivery Fast: choose your area and vehicle and earn per delivery.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.6,
  },
  {
    legacy: "franchise",
    path: "franchise",
    title: "Delivery Fast — Operate a local delivery hub",
    description: "Run a Delivery Fast franchise: manage a territory, hub, riders, merchants and local parcel operations.",
    index: true,
    changeFrequency: "monthly",
    priority: 0.6,
  },
  {
    legacy: "support",
    path: "support",
    title: "Delivery Fast — Customer support",
    description: "Ask about a delivery or pickup request and continue the conversation with Delivery Fast support.",
    index: false,
  },
  { legacy: "account", path: "account", title: "Delivery Fast — Your deliveries", description: "Your Delivery Fast account.", index: false },
  { legacy: "orders", path: "account/orders", title: "Delivery Fast — Orders & pickups", description: "Your Delivery Fast orders.", index: false },
  { legacy: "addresses", path: "account/addresses", title: "Delivery Fast — Address book", description: "Your saved addresses.", index: false },
  { legacy: "profile", path: "account/profile", title: "Delivery Fast — Your profile", description: "Your Delivery Fast profile.", index: false },
  { legacy: "verify-email", path: "account/verify-email", title: "Delivery Fast — Verify your email", description: "Confirm your email address.", index: false },
  { legacy: "submitted", path: "application-received", title: "Delivery Fast — Thanks for getting in touch", description: "Application received.", index: false },
];

/** Pages rendered by the server on their own (not through the page scripts' router). */
export const STATIC_PAGES = [
  { path: "privacy", title: "Delivery Fast — Privacy Policy", description: "How Delivery Fast collects, uses and protects personal information of senders, recipients, merchants and riders in Bangladesh." },
  { path: "terms", title: "Delivery Fast — Terms of Service", description: "The terms for booking, sending, tracking and receiving parcels and documents with Delivery Fast." },
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
