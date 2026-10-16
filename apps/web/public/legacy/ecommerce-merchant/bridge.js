/*
 * Connects the e-commerce merchant panel to the API (shared/merchant-bridge.js does the
 * work for both merchant panels). Products and Reports' report list still show the
 * original sample rows: there is no product catalogue or report history in the API.
 */
window.DFMerchantPanel.start({
  type: "ECOMMERCE",
  document: false,
  typeLabel: "E-commerce merchant",
  ownerLabel: "Store owner",
  staffLabel: "Store staff",
});
