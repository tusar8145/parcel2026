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
import CookieConsent from "./react/CookieConsent";
import LegacyHashRedirect from "./LegacyHashRedirect";
import SiteSwitches from "./SiteSwitches";
import { siteContent } from "./siteContent";
import NewHeader from "./v2/Header";
import NewHero from "./v2/Hero";
import NewFooter from "./v2/Footer";
import { Partners as NewPartners, Services as NewServices } from "./v2/Sections";

/** React-first homepage; the other website routes still use the legacy router for now. */
export default async function WebsiteHomePage({ classic = false }: { classic?: boolean } = {}) {
  const site = await siteContent();
  return (
    <>
      {" "}
      <SiteSwitches site={site} />
      {classic ? (
        <>
          <TopNote /> <SiteHeader />
        </>
      ) : (
        <NewHeader />
      )}{" "}
      <LegacyHashRedirect />
      <main>
        {" "}
        {classic ? (
          <>
            <Hero /> <StatStrip /> <TrackingSection /> <ServicesSection /> <PricingSection /> <PartnersSection />{" "}
          </>
        ) : (
          <>
            <NewHero /> <TrackingSection /> <NewServices /> <PricingSection /> <NewPartners />{" "}
          </>
        )}
        <StepsBand /> <FaqSection faqs={site.faqs} /> <CtaBand />{" "}
      </main>{" "}
      {classic ? <SiteFooter /> : <NewFooter />} <CookieConsent />
    </>
  );
}
