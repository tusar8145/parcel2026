export default function CtaBand() {
  return (
    <section style={{ padding: "0 0 74px" }}>
      <div
        className="shell"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "22px",
          padding: "30px 34px",
          borderRadius: "18px",
          background: "#e8f3e8",
        }}
      >
        <div>
          <p className="eyebrow" style={{ marginBottom: "9px" }}>
            Ready when you are
          </p>
          <h2 style={{ margin: "0", fontSize: "clamp(25px,4vw,34px)", letterSpacing: "-1.2px" }}>
            {"Let's get your first parcel moving."}
          </h2>
          <p style={{ margin: "8px 0 0", color: "#71817a", fontSize: "14px" }}>
            Book a pickup or create an account to follow your deliveries.
          </p>
        </div>
        <div style={{ display: "flex", gap: "9px", flexWrap: "wrap" }}>
          <button className="button button-primary" data-open="request">
            Request a parcel pickup
          </button>
          <button className="button" data-open="signup">
            Create an account
          </button>
        </div>
      </div>
    </section>
  );
}
