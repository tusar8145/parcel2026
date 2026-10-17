    // Order form fields below the recipient (shared/merchant-bridge.js fills the places, products and the
    // service package's choices from the API and books the order). Order: recipient → delivery address →
    // parcel (product, weight, value, reference) → service (first / last mile, Service, COD + amount,
    // open box, messages) → price.
    let merchantExtraFieldsReady=false;
    // Filled by the bridge from GET /catalog (active places only).
    const merchantRegions={district:[],zone:[],area:[]};
    const priorOpenOrderModal=openOrderModal;
    openOrderModal=function(){
      priorOpenOrderModal();
      if(merchantExtraFieldsReady)return;
      const grid=document.querySelector("#orderForm .form-grid");
      const extra=document.createElement("div");extra.className="order-extra-grid";extra.id="orderExtraFields";
      extra.innerHTML=`<div class="form-field"><label for="merchantAddressType">Address category</label><select id="merchantAddressType"><option>Home</option><option>Office</option><option>Other</option></select></div>
        <div class="form-field"><label for="merchantDistrict">District</label><select id="merchantDistrict"><option value="">Choose district</option></select></div>
        <div class="form-field"><label for="merchantZone">Zone</label><select id="merchantZone"><option value="">Choose the district first</option></select></div>
        <div class="form-field"><label for="merchantArea">Area (optional)</label><select id="merchantArea"><option value="">Choose the zone first</option></select></div>
        <div class="form-field full"><label for="deliveryAddress">Street, house / apartment / unit</label><input id="deliveryAddress" name="deliveryAddress" required maxlength="200" placeholder="Street, house / apartment / unit"></div>
        <div class="form-field"><label for="merchantProduct">Product (optional)</label><select id="merchantProduct"><option value="">No product (Regular)</option></select></div>
        <div class="form-field"><label for="merchantWeight">Weight (kg)</label><input id="merchantWeight" type="number" min="0.01" max="50" step="0.1" value="0.5" inputmode="decimal" required></div>
        <div class="form-field"><label for="orderAmount">Product value (optional)</label><input id="orderAmount" type="number" min="0" step="1" inputmode="numeric" placeholder="Declared value of the goods"></div>
        <div class="form-field"><label for="merchantReferenceNo">Order reference (optional)</label><input id="merchantReferenceNo" maxlength="80" placeholder="e.g. ORDER-1001"></div>
        <div id="dfOrderServices" style="display:contents"></div>
        <div class="order-hint" id="merchantPriceHint">Choose the delivery district to see the price from your service package.</div>`;
      grid.append(extra);merchantExtraFieldsReady=true;
    };
    document.addEventListener("click",event=>{const button=event.target.closest("#createOrder");if(button){event.preventDefault();event.stopImmediatePropagation();openOrderModal()}},true);
