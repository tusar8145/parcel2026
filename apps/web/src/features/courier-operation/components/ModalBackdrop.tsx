export default function ModalBackdrop() {
  return (
    <div id="modalBackdrop" className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <div className="modal">
        <div className="modal-head">
          <div>
            <h2 id="modalTitle">Assign a rider</h2>
            <p id="modalDescription">Choose an available rider and a shipment.</p>
          </div>
          <button id="modalClose" className="modal-close" aria-label="Close">
            ×
          </button>
        </div>
        <form id="modalForm">
          <div id="modalFields" className="form-grid" />
          <div className="modal-actions">
            <button type="button" className="button" id="modalCancel">
              Cancel
            </button>
            <button type="submit" className="button button-primary" id="modalSubmit">
              Confirm assignment
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
