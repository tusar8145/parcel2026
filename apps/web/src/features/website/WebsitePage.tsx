import type { ReactNode } from "react";
import LegacyScripts from "@/shared/LegacyScripts";
import TopNote from "./components/TopNote";
import SiteHeader from "./components/SiteHeader";
import Hero from "./components/Hero";
import StatStrip from "./components/StatStrip";
import TrackingSection from "./components/TrackingSection";
import ServicesSection from "./components/ServicesSection";
import PricingSection from "./components/PricingSection";
import PartnersSection from "./components/PartnersSection";
import StepsBand from "./components/StepsBand";
import FaqSection from "./components/FaqSection";
import CtaBand from "./components/CtaBand";
import SiteFooter from "./components/SiteFooter";
import Toast from "./components/Toast";
import WebsiteApp from "./react/WebsiteApp";
import PanelAssetPrefetch from "./PanelAssetPrefetch";
import { WEBSITE_ROUTES } from "./routes";
import { scripts } from "./scripts";
import SiteSwitches from "./SiteSwitches";
import { siteContent } from "./siteContent";

/** The path table the browser router (DF.route in public/legacy/shared/api.js) reads. */
const ROUTE_TABLE = JSON.stringify({ routes: WEBSITE_ROUTES.map(({ legacy, path, title }) => ({ legacy, path, title })) });

/**
 * The website. Every route serves the same markup (the home sections); the page scripts
 * then show the route's view. Server-only pages (privacy, terms) pass their content as
 * `staticPage`, which replaces the home sections.
 */
export default async function WebsitePage({ staticPage }: { staticPage?: { name: string; content: ReactNode } } = {}) {
  const site = await siteContent();
  return (
    <>
      {" "}
      <SiteSwitches site={site} />
      <TopNote /> <SiteHeader legacy />{" "}
      {staticPage ? (
        <main data-static-page={staticPage.name}>{staticPage.content}</main>
      ) : (
        <main>
          {" "}
          <Hero /> <StatStrip /> <TrackingSection legacy /> <ServicesSection /> <PricingSection legacy /> <PartnersSection />{" "}
          <StepsBand /> <FaqSection faqs={site.faqs} /> <CtaBand />{" "}
        </main>
      )}{" "}
      <SiteFooter /> <Toast />{" "}
      <script id="dfRoutes" type="application/json" dangerouslySetInnerHTML={{ __html: ROUTE_TABLE }} />
      <WebsiteApp />
      {!staticPage ? <PanelAssetPrefetch /> : null}
      <LegacyScripts scripts={scripts} />
    </>
  );
}
