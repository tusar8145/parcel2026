export default function OrderModal() {
  return (
    <div className="modal-backdrop" id="orderModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      {" "}
      <div className="modal">
        {" "}
        <div className="modal-head">
          <div>
            <h2 id="modalTitle">Create a new order</h2>
            <p>Add an order and prepare it for domestic delivery.</p>
          </div>
          <button className="modal-close" id="closeModal" aria-label="Close">
            ×
          </button>
        </div>{" "}
        <form id="orderForm">
          {" "}
          <div className="form-grid">
            {" "}
            <div className="form-field">
              <label htmlFor="customerName">Customer name</label>
              <input id="customerName" name="customerName" required placeholder="e.g. Jamie Lee" />
            </div>{" "}
            <div className="form-field">
              <label htmlFor="customerPhone">Phone number</label>
              <input id="customerPhone" name="customerPhone" required placeholder="+880 1XXX-XXXXXX" />
            </div>{" "}
            <div className="form-field full">
              <label htmlFor="deliveryAddress">Street, house / apartment / unit</label>
              <input
                id="deliveryAddress"
                name="deliveryAddress"
                required
                placeholder="Street, house / apartment / unit"
              />
            </div>{" "}
            <div className="form-field">
              <label htmlFor="orderType">Shipment type</label>
              <select id="orderType">
                <option>E-commerce parcel</option>
                <option>Document delivery</option>
                <option>Domestic parcel</option>
              </select>
            </div>{" "}
            <div className="form-field">
              <label htmlFor="orderAmount">Order value</label>
              <input id="orderAmount" type="number" min="0" required placeholder="0.00" />
            </div>{" "}
          </div>{" "}
          <div className="modal-actions">
            <button type="button" className="button" id="cancelModal">
              Cancel
            </button>
            <button className="button button-primary" type="submit">
              Create order
            </button>
          </div>{" "}
        </form>{" "}
      </div>{" "}
    </div>
  );
}
