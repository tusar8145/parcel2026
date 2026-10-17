// The order form (shared/merchant-bridge.js books it on the API). The page script (03.js) adds the
// delivery address, parcel and service fields below the recipient in the order the bridge expects.
export default function OrderModal() {
  return (
    <div className="modal-backdrop" id="orderModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      {" "}
      <div className="modal">
        {" "}
        <div className="modal-head">
          <div>
            <h2 id="modalTitle">Create a new delivery request</h2>
            <p>{"Recipient, delivery address, product and service. Banking & Financial deliveries are priced by route and service only."}</p>
          </div>
          <button className="modal-close" id="closeModal" aria-label="Close">
            ×
          </button>
        </div>{" "}
        <form id="orderForm" noValidate>
          {" "}
          <div className="form-grid">
            {" "}
            <div className="form-field">
              <label htmlFor="customerName">Recipient name</label>
              <input id="customerName" name="customerName" required maxLength={120} placeholder="e.g. Jamie Lee" />
            </div>{" "}
            <div className="form-field">
              <label htmlFor="customerPhone">Recipient phone</label>
              <input id="customerPhone" name="customerPhone" required placeholder="17XXXXXXXX" />
            </div>{" "}
          </div>{" "}
          <div className="modal-actions">
            <button type="button" className="button" id="cancelModal">
              Cancel
            </button>
            <button className="button button-primary" type="submit">
              Create request
            </button>
          </div>{" "}
        </form>{" "}
      </div>{" "}
    </div>
  );
}
