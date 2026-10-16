export default function ActionModal() {
  return (
    <div className="modal-backdrop" id="actionModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      {" "}
      <div className="modal">
        <div className="modal-head">
          <div>
            <h2 id="modalTitle">Update delivery</h2>
            <p id="modalDescription">Confirm the delivery status.</p>
          </div>
          <button className="modal-close" id="closeModal" aria-label="Close">
            ×
          </button>
        </div>{" "}
        <form id="actionForm">
          <div id="modalFields" className="form-grid" />
          <div className="modal-actions">
            <button type="button" className="button" id="cancelModal">
              Cancel
            </button>
            <button className="button button-primary" id="submitAction" type="submit">
              Confirm update
            </button>
          </div>
        </form>{" "}
      </div>{" "}
    </div>
  );
}
