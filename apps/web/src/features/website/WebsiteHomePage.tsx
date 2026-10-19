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

/** React-first homepage; the other website routes still use the legacy router for now. */
export default function WebsiteHomePage() {
  return (
    <>
      {" "}
      <TopNote /> <SiteHeader /> <LegacyHashRedirect />
      <main>
        {" "}
        <Hero /> <StatStrip /> <TrackingSection /> <ServicesSection /> <PricingSection /> <PartnersSection />{" "}
        <StepsBand /> <FaqSection /> <CtaBand />{" "}
      </main>{" "}
      <SiteFooter /> <CookieConsent />
    </>
  );
}
