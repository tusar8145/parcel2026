import type { ReactNode } from "react";

/** /about: the company profile (the owner's text). */

const H2 = ({ children }: { children: ReactNode }) => <h2 style={{ margin: "30px 0 10px", fontSize: 21, letterSpacing: "-.3px" }}>{children}</h2>;
const H3 = ({ children }: { children: ReactNode }) => <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>{children}</h3>;
const card = { border: "1px solid #dfe8e2", borderRadius: 14, padding: "16px 18px", background: "#fbfdfb" } as const;
const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 } as const;
const list = { margin: "6px 0 0", paddingLeft: 20, display: "grid", gap: 6 } as const;

const FACTS: [string, string][] = [
  ["2024", "Incorporated"],
  ["64", "Districts served, with thana areas"],
  ["2", "Branch offices in Dhaka (Tejgaon I/A, Banani)"],
  ["350", "People in the team"],
];

export function AboutPage() {
  return (
    <section className="route-view about-view">
      <div className="route-shell">
        <a className="route-back" href="/">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M16 10H4m5 5-5-5 5-5" />
          </svg>
          {"Back to home"}
        </a>
        <div className="route-intro">
          <p className="eyebrow">About us</p>
          <h1>About Delivery Fast</h1>
          <p>{"A nationwide courier and logistics service with its own hubs, franchisees, agents and retailers across Bangladesh."}</p>
        </div>
        <article className="route-card" style={{ lineHeight: 1.7 }}>
          <div style={{ ...grid, gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
            {FACTS.map(([value, label]) => (
              <div key={label} style={{ ...card, background: "#f1f8f4" }}>
                <strong style={{ display: "block", fontSize: 28, color: "var(--green, #087e67)", lineHeight: 1.1 }}>{value}</strong>
                <span style={{ fontSize: 13, color: "#49605d" }}>{label}</span>
              </div>
            ))}
          </div>

          <H2>Our Story</H2>
          <p>
            {
              "Delivery Fast was incorporated in 2024 with a broad vision of providing delivery services, known as Courier & Logistics Service. The expertise of this company has expanded its delivery network across the country, wherever the need is important, with a strong IT infrastructure."
            }
          </p>
          <p>
            {
              "To provide the best services to customers, the company has 2 branch offices in Dhaka, one at Tejgaon I/A and another at Banani, and has set up hub offices in important areas of Bangladesh. Delivery Fast currently serves around 64 districts along with thana areas through its own hubs, franchisees, agents and retailers."
            }
          </p>

          <H2>Our Services</H2>
          <p>
            {
              "Delivery Fast has introduced online tracking and rider apps for smooth service wherever the delivery location is, even in remote areas. This innovative concept enables us to ship and track documents and packages quickly and efficiently: customers get online information on their delivery status from our tracking service, updated 24/7. To provide this support, Delivery Fast has an expert IT department. Delivery Fast has now proved itself as a nationwide delivery service. Every Delivery Fast staff member is trained for their work at our in-house training centre."
            }
          </p>
          <p>{"In addition to normal courier, Delivery Fast provides prompt services such as same day, next day morning service (24:00 hrs service) and regular service."}</p>

          <H2>{"Management & Staff"}</H2>
          <div style={grid}>
            <div style={card}>
              <H3>{"Md. Tazul Islam — Founder & CEO"}</H3>
              <p style={{ margin: 0 }}>
                {
                  "Md. Tazul Islam, Founder & CEO of Delivery Fast, has been involved in this industry since his student life in the 90s. With long work experience in different units and departments of the same industry, he has been closely involved with it for 26 years. He took over a defunct company with 11 employees and transformed it into a company with 350 employees."
                }
              </p>
            </div>
            <div style={card}>
              <H3>{"S M Abdullah — DGM Outbound Operations"}</H3>
              <p style={{ margin: 0 }}>{"S M Abdullah, DGM Outbound Operations of Delivery Fast, has been involved with the courier industry since 1992 and has long experience with renowned courier companies in Bangladesh."}</p>
            </div>
          </div>

          <div style={{ ...grid, marginTop: 26 }}>
            <div style={card}>
              <H3>Our Mission</H3>
              <p style={{ margin: 0 }}>{"To deliver documents, parcels, instruments, e-commerce and f-commerce products in the fastest time."}</p>
            </div>
            <div style={card}>
              <H3>Our Vision</H3>
              <p style={{ margin: 0 }}>
                {
                  "To become a pioneer courier service / logistics company of the country by 2040. The founder of Delivery Fast has a dream and target to engage less-educated rural people in this sector, to develop their lives and change the rural economic landscape."
                }
              </p>
            </div>
          </div>

          <H2>Strategic Objectives</H2>
          <ul style={list}>
            <li>{"To increase revenues in order to make a sustainable profit and provide good remuneration to the employees."}</li>
            <li>{"To raise the cash flow as well as increase the net income."}</li>
          </ul>

          <H2>CSR Activity</H2>
          <p>{"Delivery Fast wants to spend a special portion of its income on the welfare of the helpless poor people of society, and to conduct social development and educational activities."}</p>

          <div style={{ ...grid, marginTop: 26 }}>
            <div style={card}>
              <H3>Business Strategy</H3>
              <p style={{ margin: 0 }}>{"Establish Delivery Fast as a trustworthy brand in the industry."}</p>
            </div>
            <div style={card}>
              <H3>Functional Strategy</H3>
              <p style={{ margin: 0 }}>
                {
                  "Distribute the documents and parcels of various national and multinational companies, establishing Delivery Fast Courier as a reliable brand to other companies and general clients. In addition, we target the online product delivery sector, as it is a rising sector."
                }
              </p>
            </div>
          </div>

          <H2>Major Strengths</H2>
          <ul style={list}>
            <li>{"The service quality of the company has built an expanding and loyal customer base."}</li>
            <li>{"Highly skilled experts in every unit, working for 10 years in the courier service field."}</li>
            <li>{"Well-trained field staff (riders) for delivering different types of documents and parcels all over the country, including rural areas."}</li>
            <li>{"Up-to-date software, a courier management system, to track the delivery status over a long time with scanned PODs."}</li>
            <li>{"Our staff easily accommodate any changes to the services instructed by customers."}</li>
            <li>{"A large workforce controlled by the central office covers most areas; for very small areas the company works with local franchisees."}</li>
          </ul>

          <H2>{"Qualification & Experience of Riders"}</H2>
          <ul style={list}>
            <li>{"Riders are recruited through newspaper and wall advertisements, and some through current staff references."}</li>
            <li>{"Minimum qualification is SSC pass and being able to read English addresses properly."}</li>
            <li>{"Educational qualification is overlooked if the rider has suitable experience in the field."}</li>
            <li>{"Address verification (both present and permanent) of new riders is mandatory."}</li>
            <li>{"Riders without previous experience go to the field with supervisors for a week of field training."}</li>
            <li>{"New riders get 2 days of training on behaviour with customers."}</li>
          </ul>

          <H2>Operational Tools</H2>
          <p>{"100% of employees use smartphones, and riders have their own bicycles and motorbikes for regular and special delivery. As required, we use private cars, covered vans and freezer vans for perishable items such as birthday cakes."}</p>

          <H2>{"Current Reporting & Consignment Tracking System"}</H2>
          <p>
            {
              "For tracking we have a software application, and we provide a merchant panel to our corporate clients. We also provide MIS in Excel, item-wise and batch-wise, to our corporate clients. Right now we ensure delivery of documents and parcels (90%) within 1–2 working days in city areas and 3–4 working days in other areas. The MIS file contains the receiver's name, relation, and date and time of delivery in soft copy against each account / reference number."
            }
          </p>
          <p>
            {
              "We send the one-day delivery report in MS Excel, or in the customer's required format, by email to the concerned unit of our valued clients the next morning, and send the final status after delivery in other areas, including remote areas, within the SLA. We have a team for return document verification: if the return reason is not satisfactory, the document is sent again for further verification. All branch offices send the delivery report by email right after delivery in their area. Riders update the delivery status in the rider app. In an emergency we can provide a scanned POD copy as the customer requires."
            }
          </p>

          <H2>Key Account Management</H2>
          <p>
            {
              "Every corporate client has a dedicated account manager; some clients, based on work volume, have 2–3 account managers. The account manager looks after all service-related issues of that client and builds a bridge between the organisation and the service staff of Delivery Fast."
            }
          </p>

          <H2>{"Query Handling & Response Time"}</H2>
          <p style={{ marginBottom: 4 }}>{"Queries are handled within 24 hours all over the country:"}</p>
          <ol style={list}>
            <li>{"Receiving the queries from customers by email and telephone."}</li>
            <li>{"Calling the customer to inform them of the delivery status."}</li>
            <li>{"Sending messengers, led by a supervisor, with the POD to the customer's address."}</li>
            <li>{"Coming back and reporting to the Customer Care Manager."}</li>
            <li>{"The Customer Care Manager calls the subscriber to know the facts."}</li>
            <li>{"Final report to the customer organisation."}</li>
          </ol>

          <H2>Emergency Support to Customers</H2>
          <p>
            {
              "We always have people ready for emergency support; if necessary, our management staff also go to the field. We always provide emergency support for delivery, collection and query handling. If support is needed in another district, we send staff from the nearest branch office. For urgent or same-day delivery to other divisional cities, we send the documents by air."
            }
          </p>

          <H2>Monitoring Outside Dhaka</H2>
          <p>
            {
              "We keep regular correspondence with, and strong monitoring of, all branch offices of our company across the country, and collect regular delivery status from them. If we find any problem with the quality of delivery, a delay in delivery or a delay in report submission, we immediately send management staff from the head office to the branch office concerned to solve the issue. Most of our branch offices have an IT setup and update the delivery status through the rider app every day. Our management staff meet the messengers of the branch offices online regularly for immediate action, and messengers are called to the head office if there is any discrepancy in the delivery process."
            }
          </p>
        </article>
      </div>
    </section>
  );
}
