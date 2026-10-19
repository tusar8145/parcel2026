"use client";

import { useState } from "react";

export default function TrackingSection({ legacy = false }: { legacy?: boolean }) {
  const [trackingId, setTrackingId] = useState("");
  const goToTracking = (value: string) => {
    const code = value.trim().toUpperCase().replace(/\s+/g, "");
    if (code) window.location.assign(`/track/${encodeURIComponent(code)}`);
  };

  return (
    <section className="tracking-section" id="tracking">
      {" "}
      <div className="shell">
        <div className="tracking-card">
          <div>
            <p className="eyebrow">Your parcel, right here</p>
            <h2>Where is it now?</h2>
            <p>Enter your tracking number for the latest update. No account needed.</p>
          </div>
          <div>
            <form
              className="track-form"
              id="trackingForm"
              onSubmit={
                legacy
                  ? undefined
                  : event => {
                      event.preventDefault();
                      goToTracking(trackingId);
                    }
              }
            >
              <div className="input-wrap">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <circle cx="10.8" cy="10.8" r="7.3" />
                  <path d="m16 16 5 5" />
                </svg>
                <input
                  id="trackingInput"
                  aria-label="Tracking number"
                  placeholder="e.g. PP-260914-1042"
                  required
                  value={legacy ? undefined : trackingId}
                  onChange={legacy ? undefined : event => setTrackingId(event.target.value)}
                />
              </div>
              <button className="button button-primary" type="submit">
                Track parcel
              </button>
            </form>
            <div className="track-hint">
              {"Try a sample: "}
              <button
                type="button"
                data-track-sample="PP-260914-1042"
                onClick={legacy ? undefined : () => goToTracking("PP-260914-1042")}
              >
                PP-260914-1042
              </button>
              {" · "}
              <button
                type="button"
                data-track-sample="PP-260913-0821"
                onClick={legacy ? undefined : () => goToTracking("PP-260913-0821")}
              >
                PP-260913-0821
              </button>
            </div>
          </div>
          {!legacy && <div className="tracking-result" id="trackingResult" aria-live="polite" />}
        </div>
        {legacy && <section className="account-panel" id="accountPanel" aria-live="polite">
          <div className="account-head">
            <div>
              <p className="eyebrow" style={{ marginBottom: "7px" }}>
                Your Delivery Fast account
              </p>
              <h3 id="accountGreeting">Your deliveries</h3>
              <p>Recent demo shipments and their latest delivery updates.</p>
            </div>
            <button className="button" id="accountLogout">
              Log out
            </button>
          </div>
          <div className="account-summary">
            <div className="account-stat">
              <small>Active shipments</small>
              <strong>2 parcels</strong>
            </div>
            <div className="account-stat">
              <small>Completed deliveries</small>
              <strong>8 this month</strong>
            </div>
            <div className="account-stat">
              <small>Saved delivery rate</small>
              <strong>৳ 70+</strong>
            </div>
          </div>
          <div className="account-orders">
            <table>
              <thead>
                <tr>
                  <th>Tracking ID</th>
                  <th>Service</th>
                  <th>Status</th>
                  <th>Delivery fee</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>PP-260914-1042</td>
                  <td>E-commerce</td>
                  <td>Out for delivery</td>
                  <td>৳ 70</td>
                  <td>
                    <button type="button" data-account-track="PP-260914-1042">
                      View status
                    </button>
                  </td>
                </tr>
                <tr>
                  <td>PP-260913-0821</td>
                  <td>Domestic parcel</td>
                  <td>In transit</td>
                  <td>৳ 130</td>
                  <td>
                    <button type="button" data-account-track="PP-260913-0821">
                      View status
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>}
      </div>{" "}
    </section>
  );
}
