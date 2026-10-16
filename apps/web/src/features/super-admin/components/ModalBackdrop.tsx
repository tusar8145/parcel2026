export default function ModalBackdrop() {
  return (
    <div className="modal-backdrop" id="modalBackdrop" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <div className="modal">
        <div className="modal-head">
          <div>
            <h2 id="modalTitle">Review registration</h2>
            <p id="modalDescription">Verify the merchant details before approving access.</p>
          </div>
          <button className="modal-close" id="modalClose" aria-label="Close">
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
              Approve merchant
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
