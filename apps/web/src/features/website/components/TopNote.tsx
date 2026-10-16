export default function TopNote() {
  return (
    <div className="top-note">
      {"On-time delivery, no guesswork. "}
      <a href="/track" data-route="tracking">
        {"Track your parcel "}
        <span aria-hidden="true">→</span>
      </a>
    </div>
  );
}
