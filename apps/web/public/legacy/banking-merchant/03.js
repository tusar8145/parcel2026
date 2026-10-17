    // Delivery request fields below the recipient (shared/merchant-bridge.js fills the places, the Banking &
    // Financial products and the service package's choices from the API and books the request). Banking &
    // Financial deliveries have no weight and no cash on delivery: they are priced by route and service.
    // Order: recipient → delivery address → product, value, reference → service → price.
    let merchantExtraFieldsReady=false;
    // Filled by the bridge from GET /catalog (active places only).
    const merchantRegions={district:[],zone:[],area:[]};
    const priorOpenOrderModal=openOrderModal;
    openOrderModal=function(){
      priorOpenOrderModal();
      if(merchantExtraFieldsReady)return;
      const grid=document.querySelector("#orderForm .form-grid");
      const extra=document.createElement("div");extra.className="order-extra-grid";extra.id="orderExtraFields";
      extra.innerHTML=`<div class="form-field"><label for="merchantAddressType">Address category</label><select id="merchantAddressType"><option>Office</option><option>Home</option><option>Other</option></select></div>
        <div class="form-field"><label for="merchantDistrict">District</label><select id="merchantDistrict"><option value="">Choose district</option></select></div>
        <div class="form-field"><label for="merchantZone">Zone</label><select id="merchantZone"><option value="">Choose the district first</option></select></div>
        <div class="form-field"><label for="merchantArea">Area (optional)</label><select id="merchantArea"><option value="">Choose the zone first</option></select></div>
        <div class="form-field full"><label for="deliveryAddress">Street, building / floor / office</label><input id="deliveryAddress" name="deliveryAddress" required maxlength="200" placeholder="Street, building / floor / office"></div>
        <div class="form-field"><label for="merchantProduct">Product (optional)</label><select id="merchantProduct"><option value="">No product (Regular)</option></select></div>
        <div class="form-field"><label for="orderAmount">Declared value (optional)</label><input id="orderAmount" type="number" min="0" step="1" inputmode="numeric" placeholder="0"></div>
        <div class="form-field full"><label for="merchantReferenceNo">Internal reference / cost center (optional)</label><input id="merchantReferenceNo" maxlength="80" placeholder="e.g. CARD-2026-0012"></div>
        <div id="dfOrderServices" style="display:contents"></div>
        <div class="order-hint" id="merchantPriceHint">Choose the delivery district to see the price from your service package.</div>`;
      grid.append(extra);merchantExtraFieldsReady=true;
    };
    document.addEventListener("click",event=>{const button=event.target.closest("#createOrder");if(button){event.preventDefault();event.stopImmediatePropagation();openOrderModal()}},true);
