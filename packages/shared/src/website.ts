import { DEFAULT_PRIVACY, DEFAULT_TERMS } from "./legal-default";

/** Website settings (Super admin › Website settings): what the public website offers, and its editable pages. */

export interface WebsiteSignups {
  merchant: boolean;
  rider: boolean;
  franchise: boolean;
  /** Website customers: signing up and signing in (staff, merchants and riders always sign in). */
  customer: boolean;
}
export type SignupKey = keyof WebsiteSignups;

export interface WebsitePage {
  title: string;
  intro: string;
  /** The text in ABOUT_FORMAT. */
  body: string;
}

export interface WebsiteFaq {
  id: string;
  question: string;
  answer: string;
}

export interface WebsiteSettings {
  signups: WebsiteSignups;
  /** The website's "Send a parcel" booking. */
  sendParcel: boolean;
  privacy: WebsitePage;
  terms: WebsitePage;
  faqs: WebsiteFaq[];
}

export const DEFAULT_FAQS: WebsiteFaq[] = [
  {
    "id": "faq-1",
    "question": "How do I track a parcel?",
    "answer": "Enter the tracking ID from your booking or confirmation message in the tracking box above. You'll see the latest sample status and delivery milestones."
  },
  {
    "id": "faq-2",
    "question": "Can I send a parcel without signing up?",
    "answer": "Yes. Use “Request a pickup” to submit a one-time domestic parcel, document, or ecommerce shipment request. The demo will generate a tracking reference for you."
  },
  {
    "id": "faq-3",
    "question": "How does cash on delivery work?",
    "answer": "For eligible ecommerce shipments, a rider collects the order amount from the receiver. Your final merchant settlement and COD terms depend on your merchant plan."
  },
  {
    "id": "faq-4",
    "question": "Do franchise partners run local operations?",
    "answer": "Yes. Franchise partners operate an agreed territory, with their own local hub and team coordinating merchant support, parcel handling, and rider operations."
  }
];

export const DEFAULT_WEBSITE: WebsiteSettings = {
  signups: { merchant: true, rider: true, franchise: true, customer: true },
  sendParcel: true,
  privacy: DEFAULT_PRIVACY,
  terms: DEFAULT_TERMS,
  faqs: DEFAULT_FAQS,
};
