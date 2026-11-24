import type { ReactNode } from "react";
import LegacyScripts from "@/shared/LegacyScripts";
import { versioned } from "@/shared/legacyAssets";
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
import NewHeader from "./v2/Header";
import NewHero from "./v2/Hero";
import NewFooter from "./v2/Footer";
import { Partners as NewPartners, Services as NewServices } from "./v2/Sections";

/** The path table the browser router (DF.route in public/legacy/shared/api.js) reads. */
const ROUTE_TABLE = JSON.stringify({ routes: WEBSITE_ROUTES.map(({ legacy, path, title }) => ({ legacy, path, title })) });

/** What a page waits for before it shows, fetched from the moment the browser reads the HTML. */
const START_UP = ["/api/v1/settings/platform-config", "/api/v1/catalog"];

/**
 * The website. Every route serves the same markup (the home sections); the page scripts
 * then show the route's view. Server-only pages (privacy, terms) pass their content as
 * `staticPage`, which replaces the home sections. `panelAssets` (the sign-in page) gets the panels' scripts ready.
 */
export default async function WebsitePage({
  staticPage,
  panelAssets,
  classic = false,
}: { staticPage?: { name: string; content: ReactNode }; panelAssets?: boolean; classic?: boolean } = {}) {
  const site = await siteContent();
  return (
    <>
      {scripts.map(src => (
        <link key={src} rel="preload" as="script" href={versioned(src)} />
      ))}
      {!staticPage ? START_UP.map(url => <link key={url} rel="preload" as="fetch" href={url} crossOrigin="anonymous" />) : null}{" "}
      <SiteSwitches site={site} />
      {classic ? (
        <>
          <TopNote /> <SiteHeader legacy />
        </>
      ) : (
        <NewHeader legacy />
      )}{" "}
      {staticPage ? (
        <main data-static-page={staticPage.name}>{staticPage.content}</main>
      ) : (
        <main>
          {" "}
          {classic ? (
            <>
              <Hero /> <StatStrip /> <TrackingSection legacy /> <ServicesSection /> <PricingSection legacy /> <PartnersSection />{" "}
            </>
          ) : (
            <>
              <NewHero /> <TrackingSection legacy /> <NewServices /> <PricingSection legacy /> <NewPartners />{" "}
            </>
          )}
          <StepsBand /> <FaqSection faqs={site.faqs} /> <CtaBand />{" "}
        </main>
      )}{" "}
      {classic ? <SiteFooter /> : <NewFooter />} <Toast />{" "}
      <script id="dfRoutes" type="application/json" dangerouslySetInnerHTML={{ __html: ROUTE_TABLE }} />
      <WebsiteApp />
      {panelAssets ? <PanelAssetPrefetch /> : null}
      <LegacyScripts scripts={scripts} />
    </>
  );
}
