import type { ReactNode } from "react";

const UPDATED = "16 October 2026";

function Shell({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro: string; children: ReactNode }) {
  return (
    <section className="route-view legal-view">
      <div className="route-shell">
        <a className="route-back" href="/">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M16 10H4m5 5-5-5 5-5" />
          </svg>
          {"Back to home"}
        </a>
        <div className="route-intro">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{intro}</p>
        </div>
        <article className="route-card legal-doc" style={{ lineHeight: 1.65 }}>
          <p
            role="note"
            style={{ margin: "0 0 18px", padding: "10px 14px", borderRadius: 10, background: "#fff7e0", border: "1px solid #f3d27a", fontSize: 14 }}
          >
            <strong>{"Draft for legal review. "}</strong>
            {`This text is a working draft prepared for Delivery Fast and has not yet been approved by counsel. It must be reviewed against the laws of Bangladesh (including the Digital Security / Cyber Security Act, the Postal and courier licensing rules of the Mail Service Licensing Authority, the Consumer Rights Protection Act 2009 and any data-protection law in force) before it is relied on. Last updated ${UPDATED}.`}
          </p>
          {children}
        </article>
      </div>
    </section>
  );
}

const H2 = ({ id, children }: { id?: string; children: ReactNode }) => (
  <h2 id={id} style={{ margin: "26px 0 8px", fontSize: 20 }}>
    {children}
  </h2>
);

export function PrivacyPolicy() {
  return (
    <Shell eyebrow="Legal" title="Privacy Policy" intro="How Delivery Fast collects, uses, shares and protects personal information when you send, receive or track a parcel.">
      <H2>1. Who we are</H2>
      <p>
        {
          "Delivery Fast (\"we\", \"us\") is a courier service operating in Bangladesh. This policy covers our website, booking and tracking pages, merchant and rider applications, SMS and email messages, and our customer support. Questions: support@deliveryfast.example."
        }
      </p>
      <H2>2. Information we collect</H2>
      <ul>
        <li>
          <strong>Account details:</strong>
          {" name, mobile number (+880), email address and a securely hashed password; two-step verification settings for staff accounts."}
        </li>
        <li>
          <strong>Booking details:</strong>
          {" sender and recipient names, mobile numbers and addresses, optional map pins, pickup time, parcel description, weight, declared value and cash-on-delivery amount."}
        </li>
        <li>
          <strong>Delivery records:</strong>
          {" status history, the rider and hub handling the parcel, proof of delivery (one-time code, signature or photo) with the time and place it was captured, and cash collected."}
        </li>
        <li>
          <strong>Partner applications:</strong>
          {" business and contact details, pickup addresses, and verification documents you upload (KYC) for merchant accounts; work area and vehicle for riders."}
        </li>
        <li>
          <strong>Support and feedback:</strong>
          {" your messages and attachments, and the ratings and comments you give after delivery."}
        </li>
        <li>
          <strong>Technical data:</strong>
          {" IP address, browser type and security logs (to protect accounts and prevent fraud). With your consent, anonymous page views (see Cookies)."}
        </li>
      </ul>
      <H2>3. How we use it</H2>
      <ul>
        <li>{"To pick up, transport and deliver parcels, collect and remit cash on delivery, and handle returns."}</li>
        <li>{"To send service messages by SMS or email: verification codes, booking confirmations, delivery codes and status updates. You can turn off optional messages under your notification preferences; security messages can't be turned off."}</li>
        <li>{"To let anyone with a tracking ID see a parcel's progress. Public tracking hides phone numbers and street addresses and shortens names; full details are shown only to the sender, to the holder of the private link we send them, and to our staff."}</li>
        <li>{"To review partner applications, prevent fraud and abuse, keep accounts secure and meet legal obligations."}</li>
        <li>{"To improve our service using ratings, support requests and, with consent, anonymous website statistics."}</li>
      </ul>
      <H2>4. Who we share it with</H2>
      <p>
        {
          "Riders and hub staff see the details needed to handle a parcel. Merchants see the parcels they booked. We use service providers for SMS (mram), email (Mailjet), maps and address search (OpenStreetMap / Nominatim) and hosting, under contracts that limit their use of the data. We disclose information when required by Bangladeshi law or a lawful order. We do not sell personal information."
        }
      </p>
      <H2>5. How long we keep it</H2>
      <p>
        {
          "Delivery and cash records are kept as long as accounting and tax law requires (generally six years). Verification codes expire within minutes and are stored only as hashes. Support conversations and feedback are kept for up to three years. Account data is deleted or anonymised after you close your account, except where we must keep it."
        }
      </p>
      <H2>6. Security</H2>
      <p>
        {
          "Data is encrypted in transit; passwords are hashed with Argon2; staff access is limited by role, protected by two-step verification for administrators, and audited. No system is perfectly secure; tell us at once if you suspect misuse of your account."
        }
      </p>
      <H2 id="cookies">7. Cookies and similar storage</H2>
      <p>
        {
          "Essential: a secure, http-only sign-in cookie and in-browser settings that keep the site working. These don't need consent. Analytics: only if you choose \"Accept analytics\", we count anonymous page views (the page address and the referring site, without query strings or personal data). You can change your choice at any time with \"Cookie settings\" in the footer."
        }
      </p>
      <H2>8. Your choices and rights</H2>
      <p>
        {
          "You can see and correct your profile and saved addresses in your account, ask for a copy of your data, ask us to delete data we are not required to keep, and withdraw consent for analytics or optional messages. Contact support@deliveryfast.example; we answer within 30 days."
        }
      </p>
      <H2>9. Children</H2>
      <p>{"Accounts are for people aged 18 or over. Riders must meet the minimum age set by law."}</p>
      <H2>10. Changes</H2>
      <p>{"We will post changes here and, for significant changes, tell signed-in customers by email or SMS."}</p>
    </Shell>
  );
}

export function TermsOfService() {
  return (
    <Shell eyebrow="Legal" title="Terms of Service" intro="The terms for booking, sending, tracking and receiving parcels and documents with Delivery Fast.">
      <H2>1. The service</H2>
      <p>
        {
          "Delivery Fast collects parcels and documents from senders and delivers them to recipients in the areas we serve in Bangladesh. These terms apply to customers booking on the website, to guests booking without an account, and, together with their merchant agreement, to merchants."
        }
      </p>
      <H2>2. Booking</H2>
      <ul>
        <li>{"You must give accurate sender, recipient, address and parcel details. Guest bookings require confirming the sender's mobile number by SMS."}</li>
        <li>{"Every pickup request is confirmed by our operations team. A pickup time you choose is a window, not a guarantee; we will contact you if it can't be met."}</li>
        <li>{"You may cancel a request online until operations confirms it. After that, contact support."}</li>
      </ul>
      <H2>3. Charges and cash on delivery</H2>
      <ul>
        <li>{"The delivery charge is calculated from the route, weight and service level and shown before you book. Extra charges may apply for returns or incorrect details."}</li>
        <li>{"For cash on delivery we collect the amount you specify from the recipient and remit it, less agreed fees, according to your account's settlement terms."}</li>
      </ul>
      <H2>4. What you may not send</H2>
      <p>
        {
          "Items prohibited by Bangladeshi law or regulations, including narcotics, weapons and explosives, counterfeit goods, hazardous or flammable materials, live animals, perishable food without prior agreement, and cash or precious metals except where a specific service allows it. We may refuse, open for inspection where the law permits, or return any consignment we reasonably believe breaks these rules."
        }
      </p>
      <H2>5. Packing</H2>
      <p>{"Pack items securely for transport. We are not responsible for damage caused by inadequate packing or by the inherent nature of the goods."}</p>
      <H2>6. Delivery and proof</H2>
      <p>
        {
          "We deliver to the address given and may ask the recipient for a one-time code, a signature or a photo as proof of delivery. If delivery fails, we will retry or return the parcel according to the service and your instructions; return charges may apply."
        }
      </p>
      <H2>7. Liability</H2>
      <p>
        {
          "If a parcel is lost or damaged while in our care, our liability is limited to the declared value or the limit stated for the service, whichever is lower, unless the law requires otherwise. We are not liable for indirect losses or for delays caused by events outside our control (for example natural disasters, strikes, hartals or government orders). Claims must be made within 7 days of the delivery date or expected delivery date."
        }
      </p>
      <H2>8. Accounts and security</H2>
      <p>
        {
          "Keep your password, verification codes and private tracking links to yourself. We may suspend accounts used for fraud or abuse. Partner (merchant, rider, franchise) applications are subject to review and separate agreements."
        }
      </p>
      <H2>9. Ratings and messages</H2>
      <p>{"Ratings and comments you leave must be honest and lawful. We may use them, without your contact details, to improve our service."}</p>
      <H2>10. Privacy</H2>
      <p>
        {"Our "}
        <a href="/privacy">Privacy Policy</a>
        {" explains how we handle personal information."}
      </p>
      <H2>11. Law and disputes</H2>
      <p>
        {
          "These terms are governed by the laws of Bangladesh. We will try to resolve complaints through support first; unresolved disputes fall under the courts of Dhaka, without limiting your rights under the Consumer Rights Protection Act 2009."
        }
      </p>
    </Shell>
  );
}
