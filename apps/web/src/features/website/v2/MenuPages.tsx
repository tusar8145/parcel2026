/**
 * The menu's own pages (new design): /services, /partners and /help. Rendered by the server (like /about); the
 * forms they link to (booking, applications, support) are the website's usual pages.
 */
import type { ReactNode } from "react";
import type { WebsiteFaq } from "@delivery-fast/shared";
import TrackingSection from "../components/TrackingSection";
import FaqSection from "../components/FaqSection";
import StepsBand from "../components/StepsBand";
import CtaBand from "../components/CtaBand";

const Arrow = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M4 10h12m-5-5 5 5-5 5" />
  </svg>
);

function PageHero({ eyebrow, title, text, children }: { eyebrow: string; title: ReactNode; text: string; children?: ReactNode }) {
  return (
    <section className="v2-page-hero">
      <div className="shell">
        <a className="route-back" href="/">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M16 10H4m5-5-5 5 5 5" />
          </svg>
          Back to home
        </a>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{text}</p>
        {children ? <div className="hero-actions">{children}</div> : null}
      </div>
    </section>
  );
}

function Ticks({ items }: { items: string[] }) {
  return (
    <ul className="v2-ticks">
      {items.map(t => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

export function ServicesPage() {
  return (
    <>
      <PageHero eyebrow="Our services" title={"Whatever needs to get there, we'll get it moving."} text="Thoughtful delivery for growing shops, busy people, and everything important in between.">
        <a className="button button-primary" href="/request">
          Request a pickup <Arrow />
        </a>
        <a className="button v2-outline" href="/pricing">
          See delivery prices
        </a>
      </PageHero>
      <section className="section v2-page-section">
        <div className="shell v2-detail-cards">
          <article className="v2-detail-card">
            <img src="/website/service-ecommerce.webp" alt="" width="640" height="220" loading="lazy" />
            <h2>E-commerce delivery</h2>
            <p>Reliable order delivery, cash on delivery, and easy returns for online businesses of every size.</p>
            <Ticks items={["Cash on delivery collected and paid out to you", "Rider pickup, or drop your parcels at a hub", "Easy returns, followed until they reach you", "Every order in your merchant panel and app"]} />
            <a className="text-link" href="/merchant">
              Become a merchant <Arrow />
            </a>
          </article>
          <article className="v2-detail-card">
            <img src="/website/service-documents.webp" alt="" width="640" height="196" loading="lazy" />
            <h2>Documents, handled with care</h2>
            <p>Secure, trackable delivery for contracts, certificates, and other important paperwork.</p>
            <Ticks items={["Banking & Financial accounts for banks, fintechs and institutions", "Proof of delivery with the receiver's name and time", "Delivery reports (MIS) by email", "Remote areas reached through our hubs"]} />
            <a className="text-link" href="/pricing">
              See document rates <Arrow />
            </a>
          </article>
          <article className="v2-detail-card">
            <img src="/website/service-parcels.webp" alt="" width="640" height="192" loading="lazy" />
            <h2>Customer parcels</h2>
            <p>Send gifts, essentials, and everyday parcels between cities. Senders pay delivery costs, with optional COD collection for a fee.</p>
            <Ticks items={["Book online, no account needed", "A rider picks it up from your door", "Optional cash on delivery for a small fee", "Follow it all the way with your tracking number"]} />
            <a className="text-link" href="/request">
              Get a delivery estimate <Arrow />
            </a>
          </article>
        </div>
      </section>
      <section className="section v2-page-section v2-soft">
        <div className="shell">
          <div className="section-heading">
            <p className="eyebrow">Delivery speeds</p>
            <h2>As fast as you need it.</h2>
          </div>
          <div className="v2-tiles">
            <div className="v2-tile">
              <strong>Same day</strong>
              <span>Picked up and delivered on the same day, where available.</span>
            </div>
            <div className="v2-tile">
              <strong>Next day morning</strong>
              <span>Delivered by the next morning (24-hour service).</span>
            </div>
            <div className="v2-tile">
              <strong>Regular</strong>
              <span>1–2 working days in city areas, 3–4 in other areas.</span>
            </div>
          </div>
          <div className="v2-tiles v2-facts">
            <div className="v2-tile">
              <strong>64 districts</strong>
              <span>With thana areas, through our own hubs, franchisees and agents.</span>
            </div>
            <div className="v2-tile">
              <strong>Tracked 24/7</strong>
              <span>Every parcel has a tracking number, updated at each step.</span>
            </div>
            <div className="v2-tile">
              <strong>Riders in the app</strong>
              <span>Delivery status and proof of delivery come straight from the rider app.</span>
            </div>
          </div>
        </div>
      </section>
      <StepsBand />
      <section className="section">
        <CtaBand />
      </section>
    </>
  );
}

export function PartnersPage() {
  return (
    <>
      <PageHero eyebrow="Partner with us" title={"There's a place for you on the delivery journey."} text="Run a business, ride a route, or build a local delivery operation with Delivery Fast." />
      <section className="section v2-page-section">
        <div className="shell v2-detail-cards">
          <article className="v2-detail-card">
            <span className="v2-detail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M3 10h18M5 10l1-6h12l1 6M5 10v10h14V10M9 20v-6h6v6" />
              </svg>
            </span>
            <h2>Become a merchant</h2>
            <p>Choose an e-commerce merchant account for shop parcels, or a Banking &amp; Financial merchant account for secure deliveries from banks, fintechs, and other organizations.</p>
            <Ticks items={["E-commerce or Banking & Financial account", "Rider pickup or drop at a hub", "Cash on delivery collected and paid to you", "Merchant panel and app for every order"]} />
            <a className="button button-primary" href="/merchant">
              Start a merchant application <Arrow />
            </a>
          </article>
          <article className="v2-detail-card">
            <span className="v2-detail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="12" cy="5" r="2" />
                <path d="m9 22 2-7-3-3 2-4h4l3 5-4 2 2 7M8 12l-4 3m11-5 4 1" />
              </svg>
            </span>
            <h2>Ride with us</h2>
            <p>Choose shifts that work for you, deliver in your area, and get support on every route.</p>
            <Ticks items={["Shifts that suit you", "Deliver in your own area", "Rider app with your tasks and earnings", "Support on every route"]} />
            <a className="button button-primary" href="/become-a-rider">
              Apply to become a rider <Arrow />
            </a>
          </article>
          <article className="v2-detail-card">
            <span className="v2-detail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M3 21h18M5 21V7l7-4 7 4v14M9 11h2m2 0h2m-6 4h2m2 0h2m-4 6v-4h2v4" />
              </svg>
            </span>
            <h2>Open a franchise hub</h2>
            <p>Operate locally with your team: manage a hub, riders, merchant service, and delivery in your territory.</p>
            <Ticks items={["A hub in your territory", "Your own riders and local merchants", "Commission on every delivery", "Franchise panel and app"]} />
            <a className="button button-primary" href="/become-a-franchise">
              Explore franchise partnership <Arrow />
            </a>
          </article>
        </div>
      </section>
      <section className="section v2-page-section v2-soft">
        <div className="shell">
          <div className="section-heading">
            <p className="eyebrow">How it works</p>
            <h2>Three steps to get started.</h2>
          </div>
          <div className="v2-tiles v2-numbered">
            <div className="v2-tile">
              <strong>Apply online</strong>
              <span>Fill in the short form for merchants, riders or franchises. It takes a few minutes.</span>
            </div>
            <div className="v2-tile">
              <strong>We review it</strong>
              <span>Our team checks your details and contacts you.</span>
            </div>
            <div className="v2-tile">
              <strong>Start working</strong>
              <span>Sign in to your panel or app and start sending, riding or running your hub.</span>
            </div>
          </div>
        </div>
      </section>
      <section className="section">
        <CtaBand />
      </section>
    </>
  );
}

export function HelpPage({ faqs }: { faqs: WebsiteFaq[] }) {
  return (
    <>
      <PageHero eyebrow="Help & support" title="How can we help?" text="Track a parcel, find quick answers, or talk to our team." />
      <TrackingSection />
      <FaqSection faqs={faqs} />
      <section className="section v2-page-section v2-soft">
        <div className="shell">
          <div className="section-heading">
            <p className="eyebrow">Talk to us</p>
            <h2>Still need help?</h2>
          </div>
          <div className="v2-tiles v2-contact-tiles">
            <a className="v2-tile" href="/support">
              <strong>Customer support</strong>
              <span>Open a ticket about a parcel or your account (log in first).</span>
            </a>
            <a className="v2-tile" href="tel:+8801969921122">
              <strong>01969 921122</strong>
              <span>Call us about a delivery.</span>
            </a>
            <a className="v2-tile" href="mailto:info@deliveryfast.com.bd">
              <strong>info@deliveryfast.com.bd</strong>
              <span>Write to us; we answer within a day.</span>
            </a>
            <a className="v2-tile" href="https://www.google.com/maps/search/?api=1&query=House-6%20Road-2A%20Banani%2C%20Dhaka-1213" target="_blank" rel="noopener">
              <strong>House-6 Road -2A Banani, Dhaka-1213</strong>
              <span>Our office. Branches in Tejgaon I/A and Banani.</span>
            </a>
          </div>
          <p className="v2-policies">
            <a href="/privacy">Privacy Policy</a>
            <span aria-hidden="true">·</span>
            <a href="/terms">Terms of Service</a>
            <span aria-hidden="true">·</span>
            <a href="/privacy#cookies" data-cookie-settings="1">
              Cookie settings
            </a>
          </p>
        </div>
      </section>
    </>
  );
}
