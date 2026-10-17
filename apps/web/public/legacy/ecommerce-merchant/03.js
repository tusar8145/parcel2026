    let merchantExtraFieldsReady=false;
    const merchantRegions={district:["Dhaka North","Dhaka Central","Dhaka South","Chattogram"],zone:["Gulshan","Banani","Dhanmondi","Mirpur","Uttara"],area:["Niketon Central Mosque","Road 4 Gulshan","Banani Block C","Dhanmondi Road 7"]};
    const merchantCatalogs={ecommercePackaging:["Small carton","Large carton","Box","Poly mailer"],documentPackaging:["Document envelope","Security pouch","Rigid document mailer"]};
    // Products are the parcel products of the merchant's service package (merchant-bridge.js prepareServices), never this config.
    function readMerchantConfig(){try{return JSON.parse(localStorage.getItem("deliveryfast-demo-config")||"{}")}catch(error){console.error("Shared delivery configuration could not be loaded in the merchant workspace.",error);return{}}}
    function applyMerchantConfig(){const config=readMerchantConfig();if(config.geoCatalog)for(const key of Object.keys(merchantRegions))if(Array.isArray(config.geoCatalog[key]))merchantRegions[key]=config.geoCatalog[key];for(const key of Object.keys(merchantCatalogs))if(Array.isArray(config[key]))merchantCatalogs[key]=config[key];const assignment=config.merchantPlanAssignments?.["MER-10048"],plan=assignment&&(config.merchantPlanOverrides?.["MER-10048"]||config.servicePlans?.ecommerce?.[assignment.plan]);if(plan){config.activeMerchantPlan=plan;config.merchantPricing=plan.pricing;config.enabledMerchantServices=plan.services}const account=config.entitlements?.find(item=>item.id==="MER-10048"),type=document.getElementById("orderType");if(account&&type){for(const option of type.options){option.disabled=option.value==="E-commerce parcel"?!account.ecommerce:!account.domestic;option.hidden=option.disabled}if(type.selectedOptions[0]?.disabled){const next=[...type.options].find(option=>!option.disabled);if(next)type.value=next.value}}return config}
    function updateMerchantShipmentFields(){
      const type=document.getElementById("orderType"),doc=document.getElementById("merchantDocumentType"),weight=document.getElementById("merchantWeight");
      if(!type||!doc||!weight)return;
      const isDocument=type.value==="Document delivery";
      doc.closest(".form-field").hidden=!isDocument;weight.closest(".form-field").hidden=isDocument;
      const packaging=document.getElementById("merchantPackaging"),product=document.getElementById("merchantProduct");
      const config=applyMerchantConfig(),packItems=isDocument?merchantCatalogs.documentPackaging:merchantCatalogs.ecommercePackaging;
      if(packaging&&packaging.dataset.catalog!==String(isDocument)){packaging.innerHTML=packItems.map(x=>`<option>${x}</option>`).join("");packaging.dataset.catalog=String(isDocument)}
      const relation=document.getElementById("merchantRelation"),relations=Array.isArray(config.receiverRelations)&&config.receiverRelations.length?config.receiverRelations:null;if(relation&&relations&&relation.dataset.catalog!==relations.join("|")){const keep=relation.value;relation.innerHTML=relations.map(x=>`<option>${x}</option>`).join("");if(relations.includes(keep))relation.value=keep;relation.dataset.catalog=relations.join("|")}
      const levels=document.getElementById("merchantServiceLevel");if(levels&&Array.isArray(config.deliveryServices)&&levels.dataset.catalog!==config.deliveryServices.join("|")){levels.innerHTML=config.deliveryServices.map(x=>`<option>${x}</option>`).join("");levels.dataset.catalog=config.deliveryServices.join("|")}
      const hint=document.getElementById("merchantPriceHint");if(hint)hint.textContent="Delivery charges use your assigned service plan. COD and return charges are itemized separately on the shipment bill.";
    }
    const priorOpenOrderModal=openOrderModal;
    openOrderModal=function(){
      const config=applyMerchantConfig();
      priorOpenOrderModal();
      if(!merchantExtraFieldsReady){
        const grid=document.querySelector("#orderForm .form-grid");
        const extra=document.createElement("div");extra.className="order-extra-grid";extra.id="orderExtraFields";
        extra.innerHTML=`<div class="form-field"><label for="merchantPickupZone">Pickup zone</label><select id="merchantPickupZone">${merchantRegions.zone.map(x=>`<option>${x}</option>`).join("")}</select></div>
          <div class="form-field"><label for="merchantAddressType">Delivery address category</label><select id="merchantAddressType"><option>Home</option><option>Office</option><option>Other</option></select></div>
          <div class="form-field"><label for="merchantDistrict">District</label><select id="merchantDistrict">${merchantRegions.district.map(x=>`<option>${x}</option>`).join("")}</select></div>
          <div class="form-field"><label for="merchantZone">Zone</label><select id="merchantZone">${merchantRegions.zone.map(x=>`<option>${x}</option>`).join("")}</select></div>
          <div class="form-field"><label for="merchantArea">Area</label><select id="merchantArea">${merchantRegions.area.map(x=>`<option>${x}</option>`).join("")}</select></div>
          <div class="form-field"><label for="merchantRelation">Receiver relationship</label><select id="merchantRelation">${(Array.isArray(config.receiverRelations)&&config.receiverRelations.length?config.receiverRelations:["Self","Family member","Colleague","Reception","Authorized representative"]).map(x=>`<option>${x}</option>`).join("")}</select></div>
          <div class="form-field"><label for="merchantServiceLevel">Delivery service</label><select id="merchantServiceLevel">${(config.deliveryServices||["Regular","Same day","Express"]).map(x=>`<option>${x}</option>`).join("")}</select></div>
          <div class="form-field"><label for="merchantWeight">Parcel weight</label><select id="merchantWeight"><option value="0.5">Up to 0.5 kg</option><option value="1">Up to 1 kg</option><option value="2">Up to 2 kg</option><option value="5">Up to 5 kg</option></select></div>
          <div class="form-field" hidden><label for="merchantDocumentType">Document type</label><select id="merchantDocumentType"><option>B2B Document</option><option>Trade Service Document</option><option>Corporate Urgent Document</option></select></div>
          <div class="form-field"><label for="merchantPackaging">Packaging type</label><select id="merchantPackaging"><option>Small carton</option><option>Large carton</option><option>Box</option><option>Poly mailer</option></select></div>
          <div class="form-field"><label for="merchantProduct">Product / document item</label><select id="merchantProduct"><option value="">No product (Regular)</option></select></div>
          <div class="order-hint" id="merchantPriceHint">Estimated merchant rate: ৳70 · 5% negotiated discount applied in this demo.</div>`;
        grid.append(extra);merchantExtraFieldsReady=true;
        document.getElementById("orderType").addEventListener("change",updateMerchantShipmentFields);
      }
      updateMerchantShipmentFields();
    };
    document.addEventListener("click",event=>{const button=event.target.closest("#createOrder");if(button){event.preventDefault();event.stopImmediatePropagation();openOrderModal()}},true);
    document.getElementById("orderForm").addEventListener("submit",event=>{
      event.preventDefault();event.stopImmediatePropagation();
      const form=event.currentTarget,name=document.getElementById("customerName").value.trim(),phone=document.getElementById("customerPhone").value.trim(),type=document.getElementById("orderType").value;
      const district=document.getElementById("merchantDistrict").value,zone=document.getElementById("merchantZone").value,area=document.getElementById("merchantArea").value,street=document.getElementById("deliveryAddress").value.trim();
      const address=`${document.getElementById("merchantAddressType").value}: ${street}, ${area}, ${zone}, ${district}`;
      const weight=Number(document.getElementById("merchantWeight").value),service=document.getElementById("merchantServiceLevel").value;
      const config=applyMerchantConfig(),rates=config.merchantPricing||{sameZone:70,crossZone:120,extraWeight:20,codFeePercent:1,regularFee:0,sameDayFee:30,expressFee:50,returnPercent:50},sameZone=document.getElementById("merchantPickupZone").value===zone,base=sameZone?Number(rates.sameZone??70):Number(rates.crossZone??120),weightFee=Math.max(0,Math.ceil(weight-1))*Number(rates.extraWeight??20),serviceFee=Number(rates[`${service.replace(/\s/g,"").replace(/^./,letter=>letter.toLowerCase())}Fee`]??rates.serviceFees?.[service]??0),codAmount=Number(document.getElementById("orderAmount").value)||0,codFee=type==="E-commerce parcel"?Math.ceil(codAmount*Number(rates.codFeePercent??1)/100):0,fee=base+weightFee+serviceFee+codFee,returnFee=Math.ceil(fee*Number(rates.returnPercent??50)/100);
      const id=`PP-${28500+sampleOrders.length}`,initials=name.split(/\s+/).map(part=>part[0]).slice(0,2).join("").toUpperCase();
      sampleOrders.unshift({id,name,initials,phone,item:document.getElementById("merchantProduct").value||type,type:"Domestic delivery",date:"Just now",amount:`৳ ${Number(document.getElementById("orderAmount").value).toLocaleString("en-BD")}`,status:"Processing",address,recipientRelation:document.getElementById("merchantRelation").value,service,weight:type==="Document delivery"?null:weight,documentType:type==="Document delivery"?document.getElementById("merchantDocumentType").value:"",packaging:document.getElementById("merchantPackaging").value,product:document.getElementById("merchantProduct").value,deliveryFee:fee,chargeBreakdown:{base,weight:weightFee,service:serviceFee,cod:codFee,return: returnFee,total:fee}});
      pageData.Orders.rows=sampleOrders;form.reset();merchantExtraFieldsReady=true;closeOrderModal();renderPage(document.getElementById("breadcrumbPage").textContent);showToast(`Order ${id} created · estimated delivery fee ৳${fee}.`);
    },true);
