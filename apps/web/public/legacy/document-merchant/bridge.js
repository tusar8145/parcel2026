/*
 * Connects the corporate document merchant panel to the API (shared/merchant-bridge.js
 * does the work for both merchant panels). The document catalogue and Reports' report
 * list still show the original sample rows: the API has no such records.
 */
window.DFMerchantPanel.start({
  type: "CORPORATE_DOCUMENT",
  document: true,
  typeLabel: "Corporate document merchant",
  ownerLabel: "Corporate owner",
  staffLabel: "Operations staff",
});
