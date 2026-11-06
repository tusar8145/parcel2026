const TEXT: Record<string, { title: string; text: string }> = {
  merchant: { title: "Merchant applications are closed", text: "We aren't taking new merchant applications right now. Please check back soon." },
  rider: { title: "Rider applications are closed", text: "We aren't taking new rider applications right now. Please check back soon." },
  franchise: { title: "Franchise applications are closed", text: "We aren't taking new franchise applications right now. Please check back soon." },
  signup: { title: "Sign-up is closed", text: "New customer accounts aren't available right now. Please check back soon." },
  request: { title: "Sending a parcel is unavailable", text: "Booking from the website is turned off right now. Please contact us if you need to send a parcel." },
};

/** A website feature turned off in Super admin › Website settings. */
export function ClosedPage({ route }: { route: string }) {
  const { title, text } = TEXT[route];
  return (
    <section className="route-view">
      <div className="route-shell">
        <a className="route-back" href="/">
          {"Back to home"}
        </a>
        <div className="route-intro">
          <h1>{title}</h1>
          <p>{text}</p>
        </div>
      </div>
    </section>
  );
}
