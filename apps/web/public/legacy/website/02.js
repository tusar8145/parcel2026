    const publicRegions={district:["Dhaka North","Dhaka Central","Dhaka South","Chattogram"],zone:["Gulshan","Banani","Dhanmondi","Mirpur","Uttara"],area:["Niketon Central Mosque","Road 4 Gulshan","Banani Block C","Dhanmondi Road 7"]};
    const publicGeoHierarchy={zonesByDistrict:{"Dhaka North":["Gulshan","Banani","Mirpur","Uttara"],"Dhaka Central":["Dhanmondi"],"Dhaka South":[],"Chattogram":[]},areasByZone:{Gulshan:["Niketon Central Mosque","Road 4 Gulshan"],Banani:["Banani Block C"],Dhanmondi:["Dhanmondi Road 7"]}};
    function publicSelect(id,label,options,full=false){return `<div class="field${full?" full":""}"><label for="${id}">${label} *</label><select id="${id}" required>${options.map(item=>`<option>${item}</option>`).join("")}</select></div>`}
    function enhancePublicForm(){
      const shared=readPublicConfig();if(shared.geoCatalog)for(const key of Object.keys(publicRegions))if(Array.isArray(shared.geoCatalog[key]))publicRegions[key]=shared.geoCatalog[key];
      const request=document.getElementById("routeForm");
      if(request?.dataset.form==="request"&&!document.getElementById("requestAddressFields")){
        const delivery=document.getElementById("requestDelivery");
        if(delivery){delivery.placeholder="Street, house / apartment / unit";delivery.previousElementSibling.textContent="Delivery street, house / apartment / unit *"}
        const service=document.getElementById("requestService");
        const fields=document.createElement("div");fields.className="route-form";fields.id="requestAddressFields";fields.style.gridColumn="1/-1";
        fields.innerHTML=`${publicSelect("requestPickupDistrict","Pickup district",publicRegions.district)}${publicSelect("requestPickupZone","Pickup zone",publicRegions.zone)}${publicSelect("requestAddressType","Address category",["Home","Office","Other"])}${publicSelect("requestDistrict","Delivery district",publicRegions.district)}${publicSelect("requestZone","Delivery zone",publicRegions.zone)}${publicSelect("requestArea","Delivery area",publicRegions.area)}${publicSelect("requestRelation","Receiver relationship",shared.receiverRelations||["Self","Family member","Colleague","Reception","Authorized representative"])}${publicSelect("requestServiceLevel","Delivery service",shared.deliveryServices||["Regular","Same day","Express"])}${publicSelect("requestWeight","Parcel weight",["Up to 0.5 kg","Up to 1 kg","Up to 2 kg","Up to 5 kg"])}${publicSelect("requestPackaging","Packaging type",shared.ecommercePackaging||["Small carton","Large carton","Box","Poly mailer"])}${publicSelect("requestProduct","Parcel contents",shared.ecommerceProducts||["General merchandise","Fragile item","Clothing","Electronics"])}<div class="field full" id="requestDocumentTypeField" hidden>${publicSelect("requestDocumentType","Document type",shared.documentTypes||["B2B Document","Trade Service Document","Corporate Urgent Document","Curtout"],true)}</div><p class="field full route-note" id="requestPricePreview">Estimated delivery charge from ৳70 · paid by sender · no COD.</p>`;
        request.querySelector(".route-actions").before(fields);
        const updateRequestType=()=>{const config=readPublicConfig(),rates=config.deliveryRates||{sameZone:70,crossZone:120,extraWeight:20,documentBase:60},isDoc=service.value==="Documents",plan=isDoc?config.servicePlans?.document?.Starter:null,publicRates=isDoc?(plan?.pricing||config.merchantPricing?.document||rates):(config.customerParcelPricing||rates),weight=document.getElementById("requestWeight"),doc=document.getElementById("requestDocumentType"),packaging=document.getElementById("requestPackaging"),product=document.getElementById("requestProduct"),preview=document.getElementById("requestPricePreview");weight.closest(".field").hidden=isDoc;weight.required=!isDoc;document.getElementById("requestDocumentTypeField").hidden=!isDoc;doc.required=isDoc;const packageItems=isDoc?(config.documentPackaging||["Document envelope","Security pouch","Rigid document mailer"]):(config.ecommercePackaging||["Small carton","Large carton","Box","Poly mailer"]),productItems=isDoc?(plan?.documentProducts?.map(item=>item.name)||config.documentProducts||["ATM card","Cheque book","Contract","Trade document"]):(plan?.products||config.parcelProducts||config.ecommerceProducts||["General merchandise","Fragile item","Clothing","Electronics"]);packaging.innerHTML=packageItems.map(x=>`<option>${x}</option>`).join("");product.innerHTML=productItems.map(x=>`<option>${x}</option>`).join("");if(isDoc&&plan?.documentTypes?.length){doc.innerHTML=plan.documentTypes.map(x=>`<option>${x}</option>`).join("")}if(preview){const same=document.getElementById("requestPickupDistrict").value===document.getElementById("requestDistrict").value&&document.getElementById("requestPickupZone").value===document.getElementById("requestZone").value,weightAmount=[.5,1,2,5][weight.selectedIndex],serviceName=document.getElementById("requestServiceLevel").value,serviceKey=`${serviceName.replace(/\s/g,"").replace(/^./,letter=>letter.toLowerCase())}Fee`,serviceFee=Number(publicRates[serviceKey]??publicRates.serviceFees?.[serviceName]??0),routeBase=Number(same?publicRates.sameZone??70:publicRates.crossZone??120),docRate=Number(publicRates.documentRates?.[doc.value]??config.documentTypeRates?.[doc.value]??routeBase),base=isDoc?Math.max(routeBase,docRate):routeBase,weightFee=isDoc?0:Math.max(0,Math.ceil(weightAmount-1))*Number(publicRates.extraWeight??20);preview.textContent=`Estimated delivery charge ৳${base+weightFee+serviceFee} · paid by sender · no COD.`}};
        service.addEventListener("change",updateRequestType);updateRequestType();
        fields.addEventListener("change",event=>{if(event.target.id==="requestProduct"){const config=readPublicConfig(),plan=config.servicePlans?.document?.Starter,matched=plan?.documentProducts?.find(item=>item.name===event.target.value);if(matched)document.getElementById("requestDocumentType").value=matched.type;updateRequestSummary();return}if(event.target.id==="requestService"){updateRequestType();return}updateRequestSummary()});
      }
      if(DF.route.hash().startsWith("#/pricing")&&!document.getElementById("pricePickupDistrict")){
        const service=document.getElementById("priceService"),calculator=document.querySelector(".route-calculator .form-grid");
        if(service&&calculator){const config=readPublicConfig(),types=config.documentTypes||["B2B Document","Trade Service Document","Corporate Urgent Document","Curtout"],field=document.createElement("div");field.className="field";field.id="priceDocumentTypeField";field.hidden=true;field.innerHTML=publicSelect("priceDocumentType","Document type",types);service.closest(".field").after(field);service.addEventListener("change",()=>{field.hidden=service.value!=="document";updatePrice()});document.getElementById("priceDocumentType").addEventListener("change",updatePrice)}
        const zone=document.getElementById("priceZone");
        if(zone){
          const label=zone.closest(".field").querySelector("label");label.textContent="Destination zone";zone.closest(".field").hidden=true;
          const routeFields=document.createElement("div");routeFields.className="form-grid";routeFields.style.gridColumn="1/-1";
          routeFields.innerHTML=`${publicSelect("pricePickupDistrict","Pickup district",publicRegions.district)}${publicSelect("pricePickupZone","Pickup zone",publicRegions.zone)}${publicSelect("priceDestinationDistrict","Delivery district",publicRegions.district)}${publicSelect("priceDestinationZone","Delivery zone",publicRegions.zone)}`;
          zone.closest(".form-grid").prepend(routeFields);
          const syncRoute=()=>{zone.value=document.getElementById("pricePickupDistrict").value===document.getElementById("priceDestinationDistrict").value&&document.getElementById("pricePickupZone").value===document.getElementById("priceDestinationZone").value?"city":"intercity";updatePrice()};
          routeFields.addEventListener("change",syncRoute);syncRoute();
        }
      }
    }
    const customerAddressBookKey="deliveryfast-customer-address-book";
    function readCustomerAddressBook(){
      const value=localStorage.getItem(customerAddressBookKey);
      if(!value)return [];
      const rows=JSON.parse(value);
      if(!Array.isArray(rows))throw new Error("Saved customer addresses have an invalid format.");
      return rows.filter(row=>row&&typeof row.phone==="string"&&typeof row.role==="string");
    }
    function syncPickupTrackingRecord(code,item){
      try{
        const rows=JSON.parse(localStorage.getItem("deliveryfast-customer-parcels")||"[]");
        const record=Array.isArray(rows)?rows.find(row=>row?.trackingId===code):null;
        if(!record)return;
        const status=record.status||item.status,detailByStatus={"Pending operations confirmation":"Your pickup request is waiting for operations confirmation. You can cancel while it is pending.","Pickup requested":"Your pickup request is waiting for operations confirmation. You can cancel while it is pending.","Pickup assigned":`Your pickup request was accepted. ${record.rider||"A rider"} is assigned to collect the parcel.`,"Pickup confirmed":"Operations confirmed your pickup request. A rider will collect it.","At hub":"The rider picked up your parcel and handed it to a hub for delivery dispatch.","Assigned":"Your parcel is at a hub and assigned to a rider for delivery.","Out for delivery":"Your parcel is on its way to the recipient.","Delivered":"Your parcel was delivered successfully.","Pickup cancelled":"This pickup request was cancelled.","Exception":"Operations is reviewing a pickup or delivery issue."},locationByStatus={"Pending operations confirmation":"Awaiting operations confirmation","Pickup requested":"Awaiting operations confirmation","Pickup assigned":"Rider assigned for pickup","Pickup confirmed":"Pickup confirmed by operations","At hub":record.hub||"At delivery hub","Assigned":"Assigned from hub for delivery","Out for delivery":"Out for delivery","Delivered":"Delivery address","Pickup cancelled":"Pickup request cancelled","Exception":"Operations review"};Object.assign(item,{status,stage:status==="Delivered"?4:status==="Out for delivery"?3:status==="At hub"||status==="Assigned"?2:0,detail:detailByStatus[status]||item.detail,when:record.updatedAt||item.when,location:locationByStatus[status]||item.location,proof:record.proof||item.proof,deliveredAt:record.deliveredAt||item.deliveredAt,events:Array.isArray(record.events)?record.events:item.events});
      }catch(error){console.error("Pickup tracking status could not be refreshed.",error)}
    }
    function phoneKey(value){return String(value||"").replace(/\D/g,"")}
    function fillRequestSelect(id,items){
      const select=document.getElementById(id);if(!select)return;
      const selected=select.value,placeholder=select.options[0]?.value===""?select.options[0].text:"Select an option";
      select.replaceChildren(new Option(placeholder,""));
      items.forEach(item=>select.add(new Option(item,item)));
      if(items.includes(selected))select.value=selected;
    }
    function addressChildren(level,parent){
      const key=level==="zone"?"zonesByDistrict":"areasByZone",catalog=level==="zone"?publicRegions.zone:publicRegions.area,children=publicGeoHierarchy[key]?.[parent];
      return Array.isArray(children)?children.filter(item=>catalog.includes(item)):[];
    }
    function updateAddressChildren(role,level){
      const pickup=role==="pickup",districtId=pickup?"requestPickupDistrict":"requestDistrict",zoneId=pickup?"requestPickupZone":"requestZone",areaId="requestArea";
      if(level==="zone"||level==="all")fillRequestSelect(zoneId,addressChildren("zone",document.getElementById(districtId)?.value||""));
      if(!pickup&&(level==="zone"||level==="area"||level==="all"))fillRequestSelect(areaId,addressChildren("area",document.getElementById(zoneId)?.value||""));
    }
    function calculateRequestCosts(){
      const config=readPublicConfig(),rates=config.customerParcelPricing||config.deliveryRates||{},weightField=document.getElementById("requestWeight"),weight=Number(weightField?.value)||[.5,1,2,5][weightField?.selectedIndex||0]||.5,codEnabled=Boolean(document.getElementById("requestCodEnabled")?.checked),codAmount=codEnabled?Math.max(0,Number(document.getElementById("requestCodAmount")?.value)||0):0;
      const sameRoute=document.getElementById("requestPickupDistrict")?.value===document.getElementById("requestDistrict")?.value&&document.getElementById("requestPickupZone")?.value===document.getElementById("requestZone")?.value;
      const service=document.getElementById("requestServiceLevel")?.value||"Regular",base=Number(sameRoute?rates.sameZone??70:rates.crossZone??120),weightFee=Math.max(0,Math.ceil(weight-1))*Number(rates.extraWeight??20),serviceKey=`${service.replace(/\s/g,"").replace(/^./,letter=>letter.toLowerCase())}Fee`,serviceFee=Number(rates[serviceKey]??rates.serviceFees?.[service]??config.serviceLevelFees?.[service]??(service==="Same day"?30:service==="Express"?50:0)),codFee=codEnabled?Math.ceil(codAmount*Number(rates.codFeePercent??1)/100):0;
      return {base,weightFee,serviceFee,codAmount,codFee,total:base+weightFee+serviceFee+codFee,codFeePercent:Number(rates.codFeePercent??1)};
    }
    function updateRequestSummary(){
      const preview=document.getElementById("requestPricePreview");
      if(!preview)return;
      const enabled=document.getElementById("requestCodEnabled").checked,codField=document.getElementById("requestCodAmountField"),amount=document.getElementById("requestCodAmount");
      codField.hidden=!enabled;amount.required=enabled;
      const costs=calculateRequestCosts();
      preview.innerHTML=`<strong>Estimated cost breakdown</strong><div class="cost-row"><span>Delivery by route</span><span>৳ ${costs.base}</span></div><div class="cost-row"><span>Weight charge</span><span>৳ ${costs.weightFee}</span></div><div class="cost-row"><span>Delivery service</span><span>৳ ${costs.serviceFee}</span></div><div class="cost-row"><span>COD collection</span><span>${costs.codAmount?`৳ ${costs.codAmount} from receiver`:"Not selected"}</span></div><div class="cost-row"><span>COD fee (${costs.codFeePercent}%)</span><span>৳ ${costs.codFee}</span></div><div class="cost-row cost-total"><strong>Sender pays for delivery</strong><strong>৳ ${costs.total}</strong></div>`;
      if(document.querySelector("#routeForm .route-step.active")?.dataset.requestStep==="2")buildRequestReview();
    }
    function refreshSavedAddressOptions(role){
      const pickup=role==="pickup",phoneInput=document.getElementById(pickup?"requestPhone":"requestReceiverPhone"),field=document.getElementById(pickup?"requestPickupSavedField":"requestReceiverSavedField"),select=document.getElementById(pickup?"requestPickupSaved":"requestReceiverSaved");
      if(!phoneInput||!field||!select)return;
      let entries=[];
      try{entries=readCustomerAddressBook().filter(row=>row.role===role&&phoneKey(row.phone)===phoneKey(phoneInput.value))}
      catch(error){console.error("Saved customer addresses could not be loaded.",error);showToast("Saved addresses could not be loaded from this browser.")}
      select.replaceChildren(new Option("Enter a new address",""));
      entries.forEach((entry,index)=>select.add(new Option(`${entry.category} · ${entry.address}, ${entry.zone}, ${entry.district}`,String(index))));
      field.hidden=entries.length===0;
      select.dataset.entries=JSON.stringify(entries);
    }
    function applySavedAddress(role){
      const pickup=role==="pickup",select=document.getElementById(pickup?"requestPickupSaved":"requestReceiverSaved"),entries=JSON.parse(select?.dataset.entries||"[]"),entry=entries[Number(select.value)];
      if(!entry)return;
      document.getElementById(pickup?"requestName":"requestReceiver").value=entry.name||"";
      const category=document.getElementById(pickup?"requestPickupCategory":"requestDeliveryCategory");
      if(category?.type==="radio"){
        const selected=[...document.querySelectorAll('input[type="radio"]')].find(input=>input.name===category.name&&input.value===(entry.category||"Home"));
        if(selected)selected.checked=true;
      }else if(category)category.value=entry.category||"";
      document.getElementById(pickup?"requestPickup":"requestDelivery").value=entry.address||"";
      document.getElementById(pickup?"requestPickupDistrict":"requestDistrict").value=entry.district||"";
      updateAddressChildren(pickup?"pickup":"receiver","zone");
      document.getElementById(pickup?"requestPickupZone":"requestZone").value=entry.zone||"";
      if(!pickup){updateAddressChildren("receiver","area");document.getElementById("requestArea").value=entry.area||""}
      updateRequestSummary();
    }
    function setupRequestFlow(){
      const form=document.getElementById("routeForm");
      if(!form||form.dataset.form!=="request"||form.dataset.requestFlowReady)return;
      form.dataset.requestFlowReady="true";
      const shared=readPublicConfig();
      if(shared.geoCatalog)for(const key of Object.keys(publicRegions))if(Array.isArray(shared.geoCatalog[key]))publicRegions[key]=shared.geoCatalog[key];
      if(shared.geoHierarchy)for(const key of Object.keys(publicGeoHierarchy))if(shared.geoHierarchy[key]&&typeof shared.geoHierarchy[key]==="object"&&!Array.isArray(shared.geoHierarchy[key]))publicGeoHierarchy[key]=shared.geoHierarchy[key];
      fillRequestSelect("requestPickupDistrict",publicRegions.district);
      fillRequestSelect("requestDistrict",publicRegions.district);
      updateAddressChildren("pickup","all");
      updateAddressChildren("receiver","all");
      fillRequestSelect("requestServiceLevel",shared.deliveryServices||["Regular","Same day","Express"]);
      fillRequestSelect("requestPackaging",shared.ecommercePackaging||["Small carton","Large carton","Box","Poly mailer"]);
      fillRequestSelect("requestProduct",shared.ecommerceProducts||["General merchandise","Fragile item","Clothing","Electronics"]);
      refreshSavedAddressOptions("pickup");
      refreshSavedAddressOptions("receiver");
      form.addEventListener("input",event=>{
        if(event.target.id==="requestPhone")refreshSavedAddressOptions("pickup");
        if(event.target.id==="requestReceiverPhone")refreshSavedAddressOptions("receiver");
        if(event.target.matches("#requestPickupDistrict,#requestPickupZone,#requestDistrict,#requestZone,#requestServiceLevel,#requestWeight,#requestCodAmount"))updateRequestSummary();
      });
      form.addEventListener("change",event=>{
        if(event.target.id==="requestPickupSaved")applySavedAddress("pickup");
        if(event.target.id==="requestReceiverSaved")applySavedAddress("receiver");
        if(event.target.id==="requestCodEnabled")updateRequestSummary();
        if(event.target.id==="requestPickupDistrict")updateAddressChildren("pickup","zone");
        if(event.target.id==="requestDistrict")updateAddressChildren("receiver","zone");
        if(event.target.id==="requestZone")updateAddressChildren("receiver","area");
        if(event.target.matches("#requestPickupDistrict,#requestPickupZone,#requestDistrict,#requestZone,#requestServiceLevel,#requestWeight,#requestCodAmount"))updateRequestSummary();
      });
      updateRequestSummary();
    }
    const originalPublicRouteRender=renderRoute;
    renderRoute=function(){originalPublicRouteRender();enhancePublicForm();setupRequestFlow()};
    window.addEventListener("hashchange",()=>setTimeout(()=>{enhancePublicForm();setupRequestFlow()},0));
    const originalPublicPriceUpdate=updatePrice;
    updatePrice=function(){const config=readPublicConfig(),rates=config.customerParcelPricing||config.deliveryRates||{},service=document.getElementById("priceService"),zone=document.getElementById("priceZone"),weightField=document.getElementById("priceWeight"),priorityField=document.getElementById("pricePriority"),codField=document.getElementById("priceCod"),codAmountField=document.getElementById("priceCodAmount"),codAmountContainer=document.getElementById("priceCodAmountField");if(!service||!zone||!weightField||!priorityField||!codField)return;const codEnabled=codField.checked,codAmount=codEnabled?Math.max(0,Number(codAmountField?.value)||0):0;if(codAmountContainer)codAmountContainer.hidden=!codEnabled;if(codAmountField){codAmountField.required=codEnabled;codAmountField.min=codEnabled?"1":"0"}const weight=Number(weightField.value),base=Number(zone.value==="city"?rates.sameZone??70:rates.crossZone??120),extra=Math.max(0,Math.ceil(weight-1))*Number(rates.extraWeight??20),priorityFee=priorityField.checked?Number(rates.sameDayFee??rates.serviceFees?.["Same day"]??30):0,codFee=codEnabled&&codAmount>0?Math.ceil(codAmount*Number(rates.codFeePercent??1)/100):0,total=base+extra+priorityFee+codFee;document.getElementById("priceTotal").textContent=`৳ ${total}`;document.getElementById("priceBreakdown").innerHTML=`<span class="price-breakdown-row"><span>Base charge</span><strong>৳ ${base}</strong></span><span class="price-breakdown-row"><span>Weight charge</span><strong>৳ ${extra}</strong></span><span class="price-breakdown-row"><span>COD fee</span><strong>৳ ${codFee}</strong></span><span class="price-breakdown-row"><span>Priority handling</span><strong>৳ ${priorityFee}</strong></span><span class="price-breakdown-row price-breakdown-collection"><span>${codEnabled?"Collected from recipient":"Recipient collection"}</span><strong>${codEnabled?`৳ ${codAmount}`:"Not selected"}</strong></span>`};
    document.addEventListener("input",event=>{if(event.target.id==="priceCodAmount")updatePrice()});
    updatePrice();
    document.addEventListener("submit",event=>{
      const form=event.target;if(form.id!=="routeForm"||form.dataset.form!=="request")return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!form.checkValidity()){form.reportValidity();return}
      const value=id=>{const field=document.getElementById(id),current=field?.type==="radio"?form.querySelector(`input[name="${field.name}"]:checked`):field;return current?.value.trim()||""},costs=calculateRequestCosts(),now=new Date().toLocaleString(),createdAt=new Date().toISOString();
      const sender={name:value("requestName"),phone:value("requestPhone"),category:value("requestPickupCategory"),address:value("requestPickup"),district:value("requestPickupDistrict"),zone:value("requestPickupZone")};
      const receiver={name:value("requestReceiver"),phone:value("requestReceiverPhone"),category:value("requestDeliveryCategory"),address:value("requestDelivery"),district:value("requestDistrict"),zone:value("requestZone"),area:value("requestArea")};
      const pickupAddress=[sender.category,sender.address,sender.zone,sender.district].join(", "),deliveryAddress=[receiver.category,receiver.address,receiver.area,receiver.zone,receiver.district].join(", ");
      let code;do{code=`PP-261014-${String(Math.floor(1000+Math.random()*9000))}`}while(sampleTracking[code]);
      const record={trackingId:code,sender:sender.name,senderPhone:sender.phone,pickupAddress,pickupCategory:sender.category,pickupStreet:sender.address,pickupDistrict:sender.district,pickupZone:sender.zone,recipient:receiver.name,recipientPhone:receiver.phone,destination:deliveryAddress,deliveryCategory:receiver.category,deliveryStreet:receiver.address,deliveryDistrict:receiver.district,deliveryZone:receiver.zone,deliveryArea:receiver.area,service:"Customer parcel",serviceLevel:value("requestServiceLevel"),weight:value("requestWeight"),packaging:value("requestPackaging"),product:value("requestProduct"),baseDeliveryFee:costs.base,weightFee:costs.weightFee,serviceFee:costs.serviceFee,codAmount:costs.codAmount,codFee:costs.codFee,codFeePercent:costs.codFeePercent,deliveryFee:costs.total,status:"Pending operations confirmation",customerCanCancel:true,createdAt:now,createdAtISO:createdAt};
      const tracking={status:record.status,detail:"Your pickup request is waiting for operations confirmation. You can cancel while it is pending.",location:"Awaiting operations confirmation",when:"Just now",stage:0,steps:["Request received","Pickup confirmed","In transit","Delivered"],service:"Customer parcel",sender:sender.name,senderPhone:sender.phone,senderArea:pickupAddress,pickupAddress,recipient:receiver.name,phone:receiver.phone,recipientPhone:receiver.phone,address:deliveryAddress,destination:deliveryAddress,destinationArea:[receiver.area,receiver.zone,receiver.district].join(", "),contents:record.product,weight:record.weight,packageType:record.packaging,payment:`Sender pays ৳${costs.total}${costs.codAmount?` · COD to collect ৳${costs.codAmount} · fee ৳${costs.codFee}`:" · No COD"}`,deliveryFee:costs.total,codAmount:costs.codAmount,codFee:costs.codFee,events:[{time:"Just now",title:"Pickup request submitted",place:"Delivery Fast",detail:"Waiting for operations to confirm or cancel this pickup request."}]};
      try{
        const saved=JSON.parse(localStorage.getItem("deliveryfast-customer-parcels")||"[]");
        if(!Array.isArray(saved))throw new Error("Saved customer parcel list has an invalid format.");
        const addressBook=readCustomerAddressBook();
        for(const [role,address] of [["pickup",sender],["receiver",receiver]]){
          if(!addressBook.some(row=>row.role===role&&phoneKey(row.phone)===phoneKey(address.phone)&&row.category===address.category&&row.address===address.address&&row.district===address.district&&row.zone===address.zone&&row.area===(address.area||"")))addressBook.unshift({...address,role,area:address.area||"",savedAt:createdAt});
        }
        saved.unshift(record);
        localStorage.setItem(customerAddressBookKey,JSON.stringify(addressBook));
        localStorage.setItem("deliveryfast-customer-parcels",JSON.stringify(saved));
        sampleTracking[code]=tracking;
        sessionStorage.setItem("deliveryfast-demo-shipments",JSON.stringify(sampleTracking));
      }catch(error){console.error("The pickup request and saved address details could not be stored.",error);showToast("This pickup request could not be saved. Check browser storage and try again.");return}
      navigate(`tracking/${encodeURIComponent(code)}`);showToast(`Pickup request submitted · sender delivery charge ৳${costs.total} · Tracking ID: ${code}`);
    },true);
    enhancePublicForm();
    setupRequestFlow();
    document.addEventListener("click",event=>{
      const cancel=event.target.closest("[data-cancel-pickup]");
      if(!cancel)return;
      const code=cancel.dataset.cancelPickup;
      try{
        const rows=JSON.parse(localStorage.getItem("deliveryfast-customer-parcels")||"[]");
        if(!Array.isArray(rows))throw new Error("Saved customer parcel list has an invalid format.");
        const record=rows.find(row=>row?.trackingId===code);
        if(!record||!["Pending operations confirmation","Pickup requested"].includes(record.status)){showToast("This pickup can no longer be cancelled online. Contact operations for help.");return}
        record.status="Pickup cancelled";record.customerCanCancel=false;record.updatedAt=new Date().toLocaleString();
        record.events=[...(Array.isArray(record.events)?record.events:[]),{time:"Just now",title:"Pickup request cancelled",place:"Customer tracking",detail:"The sender cancelled before operations confirmation."}];
        localStorage.setItem("deliveryfast-customer-parcels",JSON.stringify(rows));
        if(sampleTracking[code])syncPickupTrackingRecord(code,sampleTracking[code]);
        sessionStorage.setItem("deliveryfast-demo-shipments",JSON.stringify(sampleTracking));
        track(code);showToast("Your pickup request was cancelled.");
      }catch(error){console.error("The pickup request could not be cancelled.",error);showToast("The pickup request could not be cancelled. Please try again.")}
    });
    window.addEventListener("storage",event=>{
      if(event.key!=="deliveryfast-customer-parcels"||!lastTrackingCode)return;
      const item=sampleTracking[lastTrackingCode];
      if(item){syncPickupTrackingRecord(lastTrackingCode,item);track(lastTrackingCode)}
    });
