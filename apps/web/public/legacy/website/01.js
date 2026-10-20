    const sampleTracking={
      "PP-260914-1042":{status:"Out for delivery",detail:"Your parcel is with the rider and on its way to the delivery area.",location:"Mirpur Delivery Hub, Dhaka North",when:"Today, 11:42 AM",stage:3,service:"E-commerce parcel",eta:"Today, 2:00–5:00 PM",sender:"Olivia's Closet",senderArea:"Gulshan, Dhaka",recipient:"Nabila A.",recipientPhone:"+880 17•• •• 481",destination:"House 12, Road 7, Mirpur DOHS",destinationArea:"Mirpur, Dhaka North",contents:"Clothing order · 2 items",weight:"0.8 kg",packageType:"Small carton",payment:"৳ 1,450 · Cash on delivery",events:[{time:"11:42 AM · Today",title:"Out for delivery",place:"Mirpur Delivery Hub",detail:"Rider collected the parcel and is heading to the recipient."},{time:"9:55 AM · Today",title:"Arrived at destination hub",place:"Mirpur Delivery Hub",detail:"Parcel sorted and prepared for the last-mile route."},{time:"7:20 AM · Today",title:"In transit",place:"Dhaka Central Hub",detail:"Parcel departed for the local delivery hub."},{time:"6:30 PM · Yesterday",title:"Picked up",place:"Gulshan, Dhaka",detail:"Parcel collected from Olivia's Closet."}]},
      "PP-260913-0821":{status:"In transit",detail:"Your sealed document is moving to the destination hub.",location:"On route to Sylhet Hub",when:"Today, 9:18 AM",stage:2,service:"Corporate document",eta:"Expected tomorrow, 10:00 AM–2:00 PM",sender:"Meridian Bank PLC",senderArea:"Motijheel Branch, Dhaka",recipient:"Mahir C.",recipientPhone:"+880 18•• •• 205",destination:"Office 4B, Zindabazar",destinationArea:"Sylhet City",contents:"Bank document · sealed",weight:"Document pouch",packageType:"Security pouch",payment:"Corporate account · billed monthly",events:[{time:"9:18 AM · Today",title:"In transit",place:"Dhaka Central Hub",detail:"Shipment is moving to the destination hub."},{time:"7:42 AM · Today",title:"Departed origin hub",place:"Motijheel Hub, Dhaka",detail:"Secure pouch handed over for inter-city transfer."},{time:"6:10 PM · Yesterday",title:"Picked up",place:"Meridian Bank PLC · Motijheel Branch",detail:"Consignment accepted and security seal recorded."}]}
    };
    Object.assign(sampleTracking,JSON.parse(sessionStorage.getItem("deliveryfast-demo-shipments")||"{}"));
    sampleTracking["PP-260913-0821"].service="Document delivery";
    sampleTracking["PP-260913-0821"].payment="Merchant account · billed monthly";
    const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
    const customerSessionKey="deliveryfast-customer-session";
    function readCustomerSession(){try{const value=JSON.parse(localStorage.getItem(customerSessionKey)||"null");return value&&typeof value==="object"?value:null}catch(error){console.error("Customer demo profile could not be loaded.",error);return null}}
    let toastTimer,routeBeforeAuth="home",customerSession=readCustomerSession(),customerName=customerSession?.name||"",lastTrackingCode="";
    window.deliveryFastCustomerSession=customerSession;
    function requireCustomerLogin(returnTo){
      routeBeforeAuth=returnTo||"support";
      try{sessionStorage.setItem("deliveryfast-customer-return-route",routeBeforeAuth)}
      catch(error){console.error("Customer return route could not be saved.",error)}
      DF.route.go("login",{replace:true});
      showToast("Please log in to contact customer support.");
    }
    window.requireCustomerLogin=requireCustomerLogin;
    function takeCustomerReturnRoute(){
      let route=routeBeforeAuth;
      try{route=sessionStorage.getItem("deliveryfast-customer-return-route")||route;sessionStorage.removeItem("deliveryfast-customer-return-route")}
      catch(error){console.error("Customer return route could not be loaded.",error)}
      routeBeforeAuth="home";
      return route;
    }
    function showToast(message){const node=document.getElementById("toast");node.textContent=message;node.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove("show"),3600)}
    function trackingResultMarkup(clean,item){
      const stages=["Order received","Picked up","At local hub","Out for delivery","Delivered"],stage=Math.max(0,Math.min(Number(item.stage)||0,stages.length-1)),delivered=item.status==="Delivered",events=Array.isArray(item.events)?item.events:[{time:item.when||"Just now",title:item.status||"Shipment update",place:item.location||"In progress",detail:item.detail||"Your shipment is being processed."}];
      const badgeClass=delivered?"":/transit|delivery/i.test(item.status)?"in-transit":/failed|exception|return/i.test(item.status)?"warning":"";
      const eventMarkup=events.map(event=>`<li class="track-event"><time class="track-event-time">${escapeHtml(event.time||"")}</time><span class="track-event-dot" aria-hidden="true"></span><div class="track-event-copy"><strong>${escapeHtml(event.title||"Shipment update")}</strong><p>${escapeHtml(event.place||"")} · ${escapeHtml(event.detail||"")}</p></div></li>`).join("");
      const pod=delivered?`<div class="track-pod"><div class="pod-confirmed"><i aria-hidden="true">✓</i> Delivery confirmed</div><h4>Proof of delivery</h4><p>${item.proof?escapeHtml(item.proof):"The recipient's delivery confirmation is recorded. Sign-in may be required to view a signature or delivery photo."}</p>${item.deliveredAt?`<p style="margin-top:8px"><strong>Received:</strong> ${escapeHtml(item.deliveredAt)}</p>`:""}</div>`:`<div class="track-pod"><h4>Delivery confirmation</h4><p>Once delivered, the tracking page will show the delivery time and available proof of delivery. Signature and photo details may require the sender to sign in.</p></div>`;
      return `<section class="track-status-card" aria-label="Current shipment status"><div class="track-status-top"><div><h3>${delivered?"Your shipment has been delivered":`Estimated delivery: ${escapeHtml(item.eta||"Check back for an updated estimate")}`}</h3><p>${escapeHtml(delivered&&item.deliveredAt?`Successfully received ${item.deliveredAt}.`:item.detail||"Your shipment is moving through our delivery network.")}</p></div><span class="badge ${badgeClass}">${escapeHtml(item.status||"In progress")}</span></div><div class="track-status-meta"><span>Tracking ID <strong>${escapeHtml(clean)}</strong></span><span>Last update <strong>${escapeHtml(item.when||"Just now")}</strong></span><span>Current location <strong>${escapeHtml(item.location||"Shipment in progress")}</strong></span></div></section>
      <div class="track-progress" role="list" aria-label="Delivery progress">${stages.map((label,index)=>`<div class="track-progress-step ${index<stage||delivered&&index===stage?"done":""} ${index===stage&&!delivered?"current":""}" role="listitem" aria-current="${index===stage&&!delivered?"step":"false"}">${label}<small>${index<stage?"Completed":index===stage?delivered?"Complete":"Current step":"Upcoming"}</small></div>`).join("")}</div>
      <div class="track-detail-grid"><section class="track-info-card"><h4>From</h4><dl><div><dt>Sender</dt><dd>${escapeHtml(item.sender||"Delivery Fast sender")}</dd></div><div><dt>Pickup area</dt><dd>${escapeHtml(item.senderArea||"Pickup location recorded")}</dd></div></dl></section><section class="track-info-card"><h4>Delivering to</h4><dl><div><dt>Recipient</dt><dd>${escapeHtml(item.recipient||"Recipient")}</dd></div><div><dt>Contact</dt><dd>${escapeHtml(item.recipientPhone||"Hidden for privacy")}</dd></div><div><dt>Delivery address</dt><dd>${escapeHtml(item.destination||item.destinationArea||"Address shared with delivery team")}</dd></div></dl></section><section class="track-info-card"><h4>Shipment details</h4><dl><div><dt>Service</dt><dd>${escapeHtml(item.service||"Domestic delivery")}</dd></div><div><dt>Parcel</dt><dd>${escapeHtml(item.contents||"Shipment")}</dd></div><div><dt>Package / weight</dt><dd>${escapeHtml([item.packageType,item.weight].filter(Boolean).join(" · ")||"Not provided")}</dd></div><div><dt>Payment</dt><dd>${escapeHtml(item.payment||"Contact sender for payment details")}</dd></div></dl></section></div>
      <div class="track-lower-grid"><section class="track-journey"><h4>Delivery route</h4><div class="track-route"><div><small>Picked up from</small><strong>${escapeHtml(item.senderArea||"Origin area")}</strong></div><span class="track-route-arrow" aria-hidden="true">→</span><div><small>Going to</small><strong>${escapeHtml(item.destinationArea||"Delivery area")}</strong></div></div><p class="track-private-note">Recipient contact information is partially hidden to protect privacy.</p></section>${pod}</div>
      <section class="track-events" style="margin-top:12px"><h4>Shipment history</h4><ol class="track-event-list">${eventMarkup}</ol></section><div class="track-help"><p><strong>Need help with this delivery?</strong><br>Keep your tracking ID handy when contacting our support team.</p><a href="mailto:support@deliveryfast.example?subject=${encodeURIComponent(`Help with ${clean}`)}">Contact support →</a></div>${item.service==="Customer parcel"&&["Pending operations confirmation","Pickup requested"].includes(item.status)?`<button class="button" type="button" data-cancel-pickup="${escapeHtml(clean)}">Cancel pickup request</button><p class="route-note">You can cancel only before operations confirms the pickup.</p>`:""}`;
    }
    function track(id){const clean=String(id||"").trim().toUpperCase(),item=sampleTracking[clean],result=document.getElementById("trackingResult");if(!result)return;result.classList.add("show");if(!item){result.innerHTML=`<div class="result-head"><div><h3>We couldn't find that tracking number</h3><p>Check the ID and try again. Tracking IDs look like PP-261015-1001.</p></div><span class="badge">Not found</span></div>`;return}lastTrackingCode=clean;if(typeof syncPickupTrackingRecord==="function")syncPickupTrackingRecord(clean,item);result.innerHTML=trackingResultMarkup(clean,item)}
    const main=document.querySelector("main"),homeContent=[...main.children],pageView=document.createElement("section");
    pageView.className="route-view";pageView.id="pageView";pageView.hidden=true;main.prepend(pageView);
    const routeInfo={
      request:["Send a parcel","Request a pickup","Enter pickup and delivery details, choose a service, and review delivery and optional COD fees before submitting. Operations must confirm each request."],
      tracking:["Track a parcel","Follow your delivery","Get a clear view of the latest update, estimated arrival, route, and shipment history."],
      pricing:["Delivery prices","A clear estimate, before you book","Choose a service, area, and parcel weight to see a demo delivery estimate."],
      login:["Customer access","Log in to Delivery Fast","Manage deliveries as a customer, or continue to your existing merchant, rider, or operations demo."],
      signup:["Join Delivery Fast","Create your account","Create a customer account, or choose a dedicated partner application."],
      merchant:["Merchant application","Choose the right merchant account","An e-commerce seller or Banking & Financial merchant—such as a bank or fintech—can join with the workflow designed for its shipments."],
      rider:["Rider application","Ride with Delivery Fast","Share your contact details and preferred area to start your rider application."],
      franchise:["Franchise application","Operate a local delivery hub","Apply to manage a territory, hub, riders, merchants, and local parcel operations."],
      account:["Customer workspace","Your deliveries","Review your recent parcels and pickup requests."],
      orders:["Your orders","Orders & pickups","Track delivery progress, review pickup requests, and open shipment details."],
      addresses:["Saved addresses","Address book","Review pickup and delivery addresses saved for future bookings."],
      profile:["Account settings","Your profile","Manage the contact details saved for your customer demo account."],
      support:["Help & support","Customer support","Ask about a delivery or pickup request and continue the conversation with courier operations."],
      submitted:["Application received","Thanks for getting in touch","Your sample application has been recorded for this demo."]
    };
    function routeField(label,id,placeholder,type="text",required=true){return `<div class="field"><label for="${id}">${label}${required?" *":""}</label><input id="${id}" name="${id}" type="${type}" placeholder="${placeholder}" ${required?"required":""} autocomplete="${type==="email"?"email":"off"}"></div>`}
    function routeFrame(route,content){const [eyebrow,title,copy]=routeInfo[route];return `<div class="route-shell"><button class="route-back" type="button" data-route="home"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M16 10H4m5 5-5-5 5-5"/></svg>Back to home</button><div class="route-intro"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p>${copy}</p></div>${content}</div>`}
    function customerAreaShell(content,active){
      const links=[["account","Overview","M3 10.5 12 3l9 7.5M5.5 9v11h13V9M9 20v-6h6v6"],["orders","Orders","M4 4h16v16H4zM8 8h8M8 12h8M8 16h5"],["request","Request a pickup","M12 5v14M5 12h14"],["tracking","Track parcel","M10.8 3.5a7.3 7.3 0 1 0 0 14.6 7.3 7.3 0 0 0 0-14.6ZM16 16l5 5"],["addresses","Saved addresses","M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0ZM12 10h.01"],["support","Support","M4 5h16v11H9l-5 4V5ZM8 9h8M8 12h5"],["profile","Profile","M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8"]];
      const menu=links.map(([route,label,path])=>`<a href="#/${route}" ${active===route?'aria-current="page"':""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>${label}</a>`).join("");
      return `<div class="customer-area"><aside class="customer-sidebar"><div class="customer-sidebar-user"><small>Customer workspace</small><strong>${escapeHtml(customerSession?.name||customerName||"Delivery Fast customer")}</strong></div><p class="customer-sidebar-label">Menu</p><nav aria-label="Customer menu">${menu}</nav><button class="customer-sidebar-logout" id="accountLogout" type="button">Sign out</button></aside><section class="customer-area-content">${content}</section></div>`;
    }
    window.customerAreaShell=customerAreaShell;
    function updateCustomerHeader(){
      const actions=document.querySelector(".nav-actions");
      if(!actions)return;
      const login=actions.querySelector('[data-open="login"]'),account=actions.querySelector('a[href="#/account"]');
      if(customerSession){
        if(login)login.outerHTML='<a class="button button-quiet" href="#/account">My account</a>';
        const send=actions.querySelector('[data-open="request"]');
        if(send){send.outerHTML='<a class="button button-primary" href="#/request">Send a parcel <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 10h12m-5-5 5 5-5 5"/></svg></a>'}
      }else{
        if(account)account.outerHTML='<button class="button button-quiet" data-open="login">Log in</button>';
        const send=actions.querySelector('a[href="#/request"]');
        if(send)send.outerHTML='<button class="button button-primary" data-open="request">Send a parcel <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 10h12m-5-5 5 5-5 5"/></svg></button>';
      }
    }
    function saveCustomerSession(session){
      try{localStorage.setItem(customerSessionKey,JSON.stringify(session));customerSession=session;customerName=session.name;window.deliveryFastCustomerSession=session;updateCustomerHeader();return true}
      catch(error){console.error("Customer demo profile could not be saved.",error);showToast("Your customer profile could not be saved. Check browser storage and try again.");return false}
    }
    function pricingMarkup(){return `<div class="calculator route-calculator"><div class="calculator-top"><div><h3>Quick price estimate</h3><p>Adjust the options to see an estimate.</p></div><span class="price-label">৳ BDT</span></div><div class="form-grid"><div class="field"><label for="priceService">Delivery type</label><select id="priceService"><option value="customer">Customer parcel</option></select></div><div class="field"><label for="priceZone">Delivery area</label><select id="priceZone"><option value="city">Same city</option><option value="intercity">Inter-city</option></select></div><div class="field"><label for="priceWeight">Parcel weight</label><select id="priceWeight"><option value="0.5">Up to 0.5 kg</option><option value="1" selected>Up to 1 kg</option><option value="2">Up to 2 kg</option><option value="5">Up to 5 kg</option></select></div><div class="field"><span>Cash on delivery</span><label class="checkline"><input id="priceCod" type="checkbox"> Collect payment from recipient</label></div><div class="field" id="priceCodAmountField" hidden><label for="priceCodAmount">Cash to collect (৳)</label><input id="priceCodAmount" type="number" min="0" step="1" value="0" inputmode="numeric" placeholder="Enter COD amount"></div><div class="field full"><label class="checkline"><input id="pricePriority" type="checkbox"> Add priority handling where available</label></div></div><div class="price-result"><div><small>Estimated delivery charge</small><strong id="priceTotal">৳ 70</strong></div><span id="priceBreakdown">Base ৳70 · Weight ৳0 · COD fee ৳0 · Priority ৳0</span></div><p class="route-reassure">Demo estimate only. Final rates may vary by location and service. <a href="#/request" data-route="request">Request a pickup →</a></p></div>`}
    function trackingMarkup(code=""){return `<div class="tracking-card"><div><p class="eyebrow">Your parcel, right here</p><h2>Where is it now?</h2><p>See the estimated arrival, current location, shipment journey, and delivery details. No account needed.</p></div><div><form class="track-form" id="trackingForm"><div class="input-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.8" cy="10.8" r="7.3"/><path d="m16 16 5 5"/></svg><input id="trackingInput" aria-label="Tracking number" placeholder="Enter your tracking number" value="${escapeHtml(code)}" required></div><button class="button button-primary" type="submit">Track parcel</button></form></div><div class="tracking-result" id="trackingResult" aria-live="polite"></div></div>`}
    function customerSavedAddresses(){const value=localStorage.getItem("deliveryfast-customer-address-book");if(!value)return[];const rows=JSON.parse(value);if(!Array.isArray(rows))throw new Error("Saved customer addresses have an invalid format.");return rows.filter(row=>row&&typeof row.phone==="string"&&typeof row.role==="string")}
    function customerParcelList(){try{const value=JSON.parse(localStorage.getItem("deliveryfast-customer-parcels")||"[]");if(!Array.isArray(value))throw new Error("Saved customer parcel list has an invalid format.");return value.filter(row=>row&&typeof row.trackingId==="string")}catch(error){console.error("Customer orders could not be loaded.",error);showToast("Your orders could not be loaded.");return[]}}
    function customerAccountMarkup(){const parcels=customerParcelList(),active=parcels.filter(row=>!["Delivered","Returned","Cancelled","Pickup cancelled"].includes(row.status)).length,rates=readPublicConfig().customerParcelPricing||{},rows=parcels.slice(0,5).map(row=>`<tr><td>${escapeHtml(row.trackingId)}</td><td>${escapeHtml(row.service||"Customer parcel")}</td><td>${escapeHtml(row.status||"In progress")}</td><td>৳ ${escapeHtml(row.deliveryFee??"—")}</td><td><button type="button" data-account-track="${escapeHtml(row.trackingId)}">View status</button></td></tr>`).join("")||`<tr><td colspan="5">No shipments yet. <a href="#/request" style="color:var(--green);font-weight:700">Request your first pickup →</a></td></tr>`;return `<div class="route-card"><div class="account-head"><div><h3>Welcome, ${escapeHtml(customerName||"Delivery Fast customer")}</h3><p>Recent shipments and pickup requests at a glance.</p></div></div><div class="account-summary"><div class="account-stat"><small>Your shipments</small><strong>${parcels.length} parcels · ${active} active</strong></div><div class="account-stat"><small>Saved addresses</small><strong>${customerSavedAddresses().length} addresses</strong></div><div class="account-stat"><small>Starting delivery rate</small><strong>৳ ${escapeHtml(rates.sameZone??60)}+</strong></div></div><div class="account-orders"><table><thead><tr><th>Tracking ID</th><th>Service</th><th>Status</th><th>Est. fee</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><p class="route-reassure"><a href="#/orders">View all orders →</a> &nbsp;·&nbsp; <a href="#/request">Request a pickup →</a></p></div>`}
    function customerOrdersMarkup(){const entries=customerParcelList().map(row=>[row.trackingId,{service:row.service||"Customer parcel",status:row.status||"Pickup requested",deliveryFee:row.deliveryFee}]);const rows=entries.map(([id,item])=>`<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(item.service||"Parcel")}</td><td>${escapeHtml(item.status||"In progress")}</td><td>৳ ${escapeHtml(item.deliveryFee??(item.service==="Domestic parcel"?130:70))}</td><td><button type="button" data-account-track="${escapeHtml(id)}">View status</button></td></tr>`).join("");return `<div class="route-card"><h2>Your orders and pickup requests</h2><p class="route-note">Open any tracking ID to view its latest status and delivery details.</p><div class="account-orders">${rows?`<table><thead><tr><th>Tracking ID</th><th>Service</th><th>Status</th><th>Delivery fee</th><th></th></tr></thead><tbody>${rows}</tbody></table>`:`<div class="customer-orders-empty">No orders yet. <a href="#/request" style="color:var(--green);font-weight:700">Request your first pickup →</a></div>`}</div></div>`}
    function customerAddressesMarkup(){const addresses=customerSavedAddresses();return `<div class="route-card"><div class="account-head"><div><h2>Saved addresses</h2><p>Addresses are saved from your pickup requests for quicker booking.</p></div><a class="button button-primary" href="#/request">Request a pickup</a></div>${addresses.length?`<div class="customer-address-list">${addresses.map(row=>`<article class="customer-address-item"><strong>${escapeHtml(row.role==="pickup"?"Pickup address":row.role==="receiver"?"Delivery address":"Saved address")} · ${escapeHtml(row.category||"Address")}</strong><p>${escapeHtml(row.name||"")} ${row.phone?`· ${escapeHtml(row.phone)}`:""}</p><p>${escapeHtml([row.address,row.area,row.zone,row.district].filter(Boolean).join(", "))}</p></article>`).join("")}</div>`:`<div class="customer-orders-empty">No saved addresses yet. They will appear here after you submit a pickup request.</div>`}</div>`}
    function customerProfileMarkup(){const session=customerSession||{};return `<div class="route-card"><h2>Profile details</h2><p class="route-note">Update the contact information associated with your customer demo account.</p><form id="routeForm" class="route-form customer-profile-form" data-form="profile"><div class="field"><label for="profileName">Full name *</label><input id="profileName" name="profileName" required value="${escapeHtml(session.name||"")}" autocomplete="name"></div><div class="field"><label for="profilePhone">Phone number</label><input id="profilePhone" name="profilePhone" type="tel" value="${escapeHtml(session.phone||"")}" autocomplete="tel"></div><div class="field full"><label for="profileEmail">Email address</label><input id="profileEmail" name="profileEmail" type="email" value="${escapeHtml(session.email||"")}" autocomplete="email"></div><div class="route-actions"><button class="button button-primary" type="submit">Save profile</button></div></form></div>`}
    function renderRoute(){
      const path=DF.route.path()||"home",parts=path.split("/"),route=routeInfo[parts[0]]?parts[0]:"home",code=parts[1]||"";
      if(route==="support"&&!customerSession){requireCustomerLogin(path);return}
      updateCustomerHeader();
      document.title=DF.route.title(route);
      document.getElementById("navLinks").classList.remove("open");document.getElementById("menuButton").setAttribute("aria-expanded","false");
      if(route==="home"){pageView.hidden=true;pageView.innerHTML="";main.append(...homeContent);return}
      homeContent.forEach(node=>node.remove());pageView.hidden=false;
      let content="";
      if(route==="tracking")content=routeFrame(route,trackingMarkup(code));
      else if(route==="pricing")content=routeFrame(route,pricingMarkup());
      else if(route==="request")content=routeFrame(route,`<form id="routeForm" class="route-card route-form" data-form="request">
        <div class="route-stepper" aria-label="Pickup request steps"><span class="step-pill active">1</span><span class="step-line"></span><span class="step-pill">2</span><span class="step-line"></span><span class="step-pill">3</span></div>
        <div class="route-step active" data-request-step="0">
          <h2 class="field full">Pickup details</h2>
          <div class="field"><label for="requestName">Your name *</label><input id="requestName" required placeholder="Full name"></div>
          <div class="field"><label for="requestPhone">Phone number *</label><input id="requestPhone" type="tel" required placeholder="+880 1XXX-XXXXXX" autocomplete="tel"></div>
          <div class="field full" id="requestPickupSavedField" hidden><label for="requestPickupSaved">Choose a saved pickup address</label><select id="requestPickupSaved"><option value="">Enter a new address</option></select></div>
          <div class="field full"><span class="field-label">Pickup address category *</span><div class="address-category-options" role="radiogroup" aria-label="Pickup address category"><label class="address-category-option"><input id="requestPickupCategory" type="radio" name="requestPickupCategory" value="Home" required checked>Home</label><label class="address-category-option"><input type="radio" name="requestPickupCategory" value="Office">Office</label><label class="address-category-option"><input type="radio" name="requestPickupCategory" value="Other">Other</label></div></div>
          <div class="field"><label for="requestPickupDistrict">Pickup district *</label><select id="requestPickupDistrict" required><option value="">Select district</option><option>Dhaka North</option><option>Dhaka Central</option><option>Dhaka South</option><option>Chattogram</option></select></div>
          <div class="field"><label for="requestPickupZone">Pickup zone *</label><select id="requestPickupZone" required><option value="">Select zone</option><option>Gulshan</option><option>Banani</option><option>Dhanmondi</option><option>Mirpur</option><option>Uttara</option></select></div>
          <div class="field full"><label for="requestPickup">Pickup address *</label><input id="requestPickup" required placeholder="Street, house / apartment / unit" autocomplete="street-address"></div>
        </div>
        <div class="route-step" data-request-step="1">
          <h2 class="field full">Delivery details</h2>
          <div class="field"><label for="requestReceiver">Receiver's name *</label><input id="requestReceiver" required placeholder="Full name"></div>
          <div class="field"><label for="requestReceiverPhone">Receiver's phone *</label><input id="requestReceiverPhone" type="tel" required placeholder="+880 1XXX-XXXXXX" autocomplete="tel"></div>
          <div class="field full" id="requestReceiverSavedField" hidden><label for="requestReceiverSaved">Saved addresses for this phone number</label><select id="requestReceiverSaved"><option value="">Enter a new address</option></select></div>
          <div class="field full"><span class="field-label">Delivery address category *</span><div class="address-category-options" role="radiogroup" aria-label="Delivery address category"><label class="address-category-option"><input id="requestDeliveryCategory" type="radio" name="requestDeliveryCategory" value="Home" required checked>Home</label><label class="address-category-option"><input type="radio" name="requestDeliveryCategory" value="Office">Office</label><label class="address-category-option"><input type="radio" name="requestDeliveryCategory" value="Other">Other</label></div></div>
          <div class="field"><label for="requestDistrict">Delivery district *</label><select id="requestDistrict" required><option value="">Select district</option><option>Dhaka North</option><option>Dhaka Central</option><option>Dhaka South</option><option>Chattogram</option></select></div>
          <div class="field"><label for="requestZone">Delivery zone *</label><select id="requestZone" required><option value="">Select zone</option><option>Gulshan</option><option>Banani</option><option>Dhanmondi</option><option>Mirpur</option><option>Uttara</option></select></div>
          <div class="field"><label for="requestArea">Delivery area *</label><select id="requestArea" required><option value="">Select area</option><option>Niketon Central Mosque</option><option>Road 4 Gulshan</option><option>Banani Block C</option><option>Dhanmondi Road 7</option></select></div>
          <div class="field full"><label for="requestDelivery">Delivery street, house / apartment / unit *</label><input id="requestDelivery" required placeholder="Street, house / apartment / unit" autocomplete="street-address"></div>
        </div>
        <div class="route-step" data-request-step="2">
          <h2 class="field full">Parcel and service</h2>
          <div class="field"><label for="requestServiceLevel">Delivery service *</label><select id="requestServiceLevel" required><option>Regular</option><option>Same day</option><option>Express</option></select></div>
          <div class="field"><label for="requestWeight">Parcel weight *</label><select id="requestWeight" required><option value="0.5">Up to 0.5 kg</option><option value="1">Up to 1 kg</option><option value="2">Up to 2 kg</option><option value="5">Up to 5 kg</option></select></div>
          <div class="field"><label for="requestPackaging">Packaging type *</label><select id="requestPackaging" required><option>Small carton</option><option>Large carton</option><option>Box</option><option>Poly mailer</option></select></div>
          <div class="field"><label for="requestProduct">Parcel contents *</label><select id="requestProduct" required><option>General merchandise</option><option>Fragile item</option><option>Clothing</option><option>Electronics</option></select></div>
          <div class="field full"><label class="checkline"><input id="requestCodEnabled" type="checkbox"> Collect cash on delivery from the receiver</label></div>
          <div class="field" id="requestCodAmountField" hidden><label for="requestCodAmount">COD amount to collect (৳) *</label><input id="requestCodAmount" type="number" min="1" step="1" placeholder="Enter collection amount"></div>
          <div class="field full"><div class="route-price-preview" id="requestPricePreview" aria-live="polite"></div></div>
          <div class="field full"><h3>Review your request</h3><div class="route-review" id="requestReview"></div></div>
        </div>
        <div class="route-actions"><span class="route-note">Your pickup request needs operations confirmation. You can cancel it while it is still pending.</span><div class="route-action-buttons"><button class="button button-quiet" id="requestBack" type="button" hidden>Back</button><button class="button button-primary" id="requestNext" type="button">Continue</button><button class="button button-primary" id="requestSubmit" type="submit" hidden>Submit pickup request</button></div></div>
        <div class="route-result" id="routeResult" aria-live="polite"></div>
        <span id="requestAddressFields" hidden></span>
      </form>`);
      else if(route==="login")content=routeFrame(route,`<form id="routeForm" class="route-card route-form" data-form="login"><div class="field full"><label for="loginRole">Continue as</label><select id="loginRole"><option>Customer</option><option>Merchant</option><option>Rider</option><option>Franchise operator</option></select></div><div class="field"><label for="loginIdentity">Email or phone *</label><input id="loginIdentity" required placeholder="you@example.com or phone" autocomplete="username"></div><div class="field"><label for="loginPassword">Password *</label><input id="loginPassword" type="password" required placeholder="Enter your password" autocomplete="current-password"></div><div class="route-actions"><span class="route-note">Demo sign-in. No credentials are checked.</span><button class="button button-primary" type="submit">Log in</button></div><p class="field full route-reassure">New to Delivery Fast? <a href="#/signup" data-route="signup">Create an account →</a></p></form>`);
      else if(route==="signup")content=routeFrame(route,`<div class="route-card"><h2>Join as a customer</h2><form id="routeForm" class="route-form" data-form="signup">${routeField("Full name","signupName","Your name")}${routeField("Phone number","signupPhone","+880 1XXX-XXXXXX","tel")}${routeField("Email address","signupEmail","you@example.com","email")}${routeField("Create password","signupPassword","At least 8 characters","password")}<div class="route-actions"><span class="route-note">Demo account only. No password is stored.</span><button class="button button-primary" type="submit">Create customer account</button></div></form><div class="route-reassure">Joining as a partner? Choose your application:<div class="route-split" style="margin-top:11px"><a class="route-choice route-link" href="#/merchant" data-route="merchant">Become a merchant →</a><a class="route-choice route-link" href="#/rider" data-route="rider">Apply as a rider →</a><a class="route-choice route-link" href="#/franchise" data-route="franchise">Become a franchise partner →</a><a class="route-choice route-link" href="#/login" data-route="login">Already have an account? Log in →</a></div></div></div>`);
      else if(["merchant","rider","franchise"].includes(route)){
        const partnerFields=route==="merchant"?`<div class="field"><label for="merchantAccountType">Merchant account type *</label><select id="merchantAccountType" required><option value="E-commerce merchant">E-commerce merchant — online shop and product parcels</option><option value="Banking & Financial merchant">Banking & Financial merchant — bank, fintech, or institution</option></select></div><div class="field" id="merchantSectorField" hidden><label for="merchantSector">Institution type *</label><select id="merchantSector"><option value="">Select institution type</option><option>Bank</option><option>Fintech / payments</option><option>Insurance / financial services</option><option>Other institution</option></select></div>${routeField("Business / institution name","partnerName","Registered business or institution name")}${routeField("Contact person","partnerContact","Your full name")}${routeField("Business email","partnerEmail","you@business.com","email")}${routeField("Phone number","partnerPhone","+880 1XXX-XXXXXX","tel")}<div class="field"><label for="partnerArea">Business location *</label><select id="partnerArea" required><option value="">Select your area</option><option>Dhaka</option><option>Chattogram</option><option>Gazipur</option><option>Narayanganj</option><option>Sylhet</option><option>Other district</option></select></div>`:route==="rider"?`${routeField("Full name","partnerName","Your full name")}${routeField("Phone number","partnerPhone","+880 1XXX-XXXXXX","tel")}${routeField("Email address","partnerEmail","you@example.com","email")}<div class="field"><label for="partnerArea">Preferred work area *</label><select id="partnerArea" required><option value="">Select your area</option><option>Dhaka North</option><option>Dhaka Central</option><option>Dhaka South</option><option>Chattogram</option><option>Other district</option></select></div><div class="field"><label for="riderVehicle">Vehicle type *</label><select id="riderVehicle" required><option>Motorcycle</option><option>Bicycle</option><option>On foot</option></select></div>`:`${routeField("Your name","partnerName","Full name")}${routeField("Phone number","partnerPhone","+880 1XXX-XXXXXX","tel")}${routeField("Email address","partnerEmail","you@example.com","email")}${routeField("Proposed hub location","partnerArea","District, area or market")}<div class="field"><label for="partnerExperience">Business experience</label><input id="partnerExperience" placeholder="Courier, retail, logistics..."></div><div class="field"><label for="partnerInvestment">Preferred territory *</label><select id="partnerInvestment" required><option value="">Choose a territory size</option><option>City zone</option><option>District</option><option>Multi-district region</option></select></div>`;
        content=routeFrame(route,`<form id="routeForm" class="route-card route-form" data-form="${route}">${partnerFields}<div class="route-actions"><span class="route-note">Application demo only. Our team won't receive this form.</span><button class="button button-primary" type="submit">Send ${route} application</button></div></form>`)
      }else if(route==="account")content=routeFrame(route,customerAccountMarkup());
      else if(route==="orders")content=routeFrame(route,customerOrdersMarkup());
      else if(route==="addresses")content=routeFrame(route,customerAddressesMarkup());
      else if(route==="profile")content=routeFrame(route,customerProfileMarkup());
      else if(route==="support")content=routeFrame(route,`<div class="route-card">Loading support conversations…</div>`);
      else content=routeFrame(route,`<div class="route-card"><h2>Application prepared</h2><p class="route-note">This is a frontend demo; your information has not been sent to a courier.</p><button class="button button-primary" type="button" data-route="home">Back to Delivery Fast</button></div>`);
      if(window.DFReact?.owns(route))content=routeFrame(route,`<div class="react-view" data-react-view="${route}"></div>`);
      if(customerSession&&["account","orders","addresses","profile","support","request","tracking","pricing"].includes(route))content=customerAreaShell(content,route);
      pageView.innerHTML=content;window.scrollTo({top:0,behavior:"smooth"});
      if(route==="request")setRequestStep(0);
      if(route==="pricing")updatePrice();
      if(route==="tracking"&&code)track(code);
    }
    function navigate(route){DF.route.go(route)}
    function readPublicConfig(){try{return JSON.parse(localStorage.getItem("deliveryfast-demo-config")||"{}")}catch(error){console.error("Shared delivery configuration could not be loaded on the public website.",error);return{}}}
    function updatePrice(){const serviceNode=document.getElementById("priceService");if(!serviceNode)return;const zone=document.getElementById("priceZone").value,weight=Number(document.getElementById("priceWeight").value),priority=document.getElementById("pricePriority").checked,config=readPublicConfig(),rates=config.customerParcelPricing||config.deliveryRates||{},base=Number(zone==="city"?rates.sameZone??70:rates.crossZone??120),extra=Math.max(0,Math.ceil(weight-1))*Number(rates.extraWeight??20),priorityFee=priority?Number(rates.sameDayFee??rates.serviceFees?.["Same day"]??30):0,total=base+extra+priorityFee;document.getElementById("priceTotal").textContent=`৳ ${total}`;document.getElementById("priceBreakdown").innerHTML=`Base ৳${base} · Weight ৳${extra}<br>COD not available · Priority ৳${priorityFee}`}
    function onMainClick(event){
      const routeLink=event.target.closest("[data-route],[data-open]");if(routeLink){event.preventDefault();navigate(routeLink.dataset.route||routeLink.dataset.open);return}
      const anchor=event.target.closest('a[href^="#"]');if(anchor&&!anchor.hash.startsWith("#/")){const target=anchor.hash.slice(1);if(target==="tracking"||target==="pricing"){event.preventDefault();navigate(target);return}if(!homeContent.every(node=>node.parentElement===main)){event.preventDefault();navigate("home");requestAnimationFrame(()=>document.getElementById(target)?.scrollIntoView({behavior:"smooth"}))}else if(location.hash.startsWith("#/")){event.preventDefault();navigate("home");requestAnimationFrame(()=>document.getElementById(target)?.scrollIntoView({behavior:"smooth"}))}}
      const sample=event.target.closest("[data-track-sample]");if(sample){const input=document.getElementById("trackingInput");input.value=sample.dataset.trackSample;track(sample.dataset.trackSample)}
      const accountTrack=event.target.closest("[data-account-track]");if(accountTrack)navigate(`tracking/${encodeURIComponent(accountTrack.dataset.accountTrack)}`);
      const logout=event.target.closest("#accountLogout");if(logout){try{localStorage.removeItem(customerSessionKey)}catch(error){console.error("Customer demo session could not be cleared.",error);showToast("Your saved demo session could not be cleared.")}customerSession=null;customerName="";window.deliveryFastCustomerSession=null;updateCustomerHeader();navigate("home");showToast("You have been logged out of the customer demo.")}
    }
    document.addEventListener("click",onMainClick);
    document.getElementById("menuButton").addEventListener("click",()=>{const nav=document.getElementById("navLinks"),open=nav.classList.toggle("open");document.getElementById("menuButton").setAttribute("aria-expanded",String(open))});
    document.getElementById("navLinks").addEventListener("click",event=>{if(event.target.closest("a")){document.getElementById("navLinks").classList.remove("open");document.getElementById("menuButton").setAttribute("aria-expanded","false")}});
    document.addEventListener("change",event=>{if(event.target.matches("#priceService,#priceZone,#priceWeight,#priceCod,#pricePriority"))updatePrice();if(event.target.id==="merchantAccountType"){const sector=document.getElementById("merchantSectorField"),select=document.getElementById("merchantSector"),isDocument=event.target.value==="Banking & Financial merchant";sector.hidden=!isDocument;select.required=isDocument;if(!isDocument)select.value=""}});
    function buildRequestReview(){
      const form=document.getElementById("routeForm");
      if(!form||form.dataset.form!=="request")return;
      const value=id=>{const field=document.getElementById(id),current=field?.type==="radio"?form.querySelector(`input[name="${field.name}"]:checked`):field;return current?.value.trim()||"—"};
      const review=document.getElementById("requestReview");
      if(!review)return;
      const costs=calculateRequestCosts();
      review.innerHTML=`<div class="review-item"><strong>Sender & pickup</strong><div>${escapeHtml(value("requestName"))} · ${escapeHtml(value("requestPhone"))}</div><div>${escapeHtml(value("requestPickupCategory"))}: ${escapeHtml(value("requestPickup"))}</div><div>${escapeHtml(value("requestPickupZone"))}, ${escapeHtml(value("requestPickupDistrict"))}</div></div><div class="review-item"><strong>Receiver & delivery</strong><div>${escapeHtml(value("requestReceiver"))} · ${escapeHtml(value("requestReceiverPhone"))}</div><div>${escapeHtml(value("requestDeliveryCategory"))}: ${escapeHtml(value("requestDelivery"))}</div><div>${escapeHtml(value("requestArea"))}, ${escapeHtml(value("requestZone"))}, ${escapeHtml(value("requestDistrict"))}</div></div><div class="review-item"><strong>Parcel</strong><div>${escapeHtml(value("requestServiceLevel"))} · ${escapeHtml(value("requestWeight"))}</div><div>${escapeHtml(value("requestPackaging"))} · ${escapeHtml(value("requestProduct"))}</div><div>${costs.codAmount?`COD to collect: ৳${costs.codAmount}`:"No COD"}</div></div><div class="review-item"><strong>Cost breakdown</strong><div>Delivery: ৳${costs.base}</div><div>Weight: ৳${costs.weightFee} · Service: ৳${costs.serviceFee}</div><div>COD fee: ৳${costs.codFee}</div><div><strong>Sender pays: ৳${costs.total}</strong></div></div>`;
    }
    function setRequestStep(step){
      const form=document.getElementById("routeForm");
      if(!form||form.dataset.form!=="request")return;
      const steps=[...form.querySelectorAll(".route-step")];
      const pills=[...form.querySelectorAll(".step-pill")];
      steps.forEach((node,index)=>node.classList.toggle("active",index===step));
      pills.forEach((pill,index)=>pill.classList.toggle("active",index===step));
      const backButton=document.getElementById("requestBack");
      const nextButton=document.getElementById("requestNext");
      const submitButton=document.getElementById("requestSubmit");
      backButton.hidden=step===0;
      nextButton.hidden=step===2;
      submitButton.hidden=step!==2;
      if(step===2)buildRequestReview();
    }
    document.addEventListener("click",event=>{
      const requestBack=event.target.closest("#requestBack");
      if(requestBack){
        const form=document.getElementById("routeForm");
        if(!form||form.dataset.form!=="request")return;
        const current=[...form.querySelectorAll(".route-step")].findIndex(node=>node.classList.contains("active"));
        setRequestStep(Math.max(0,current-1));
        return;
      }
      const requestNext=event.target.closest("#requestNext");
      if(requestNext){
        const form=document.getElementById("routeForm");
        if(!form||form.dataset.form!=="request")return;
        const current=[...form.querySelectorAll(".route-step")].findIndex(node=>node.classList.contains("active"));
        const stepFields=[...form.querySelectorAll(".route-step.active input[required], .route-step.active select[required]")].filter(field=>!field.closest("[hidden]"));
        const firstInvalid=stepFields.find(field=>!field.checkValidity());
        if(firstInvalid){
          firstInvalid.reportValidity();
          if(firstInvalid)firstInvalid.focus();
          showToast("Please complete all required details before continuing.");
          return;
        }
        setRequestStep(Math.min(2,current+1));
      }
    });
    document.addEventListener("submit",event=>{
      const form=event.target;
      if(form.id==="trackingForm"){event.preventDefault();track(document.getElementById("trackingInput").value);return}
      if(form.id!=="routeForm")return;
      event.preventDefault();
      const type=form.dataset.form;
      if(type==="request"){
        return;
      }
      if(type==="login"){
        const role=document.getElementById("loginRole").value,identity=document.getElementById("loginIdentity").value;
        if(role==="Customer"){const email=identity.includes("@")?identity:"",phone=email?"":identity,name=email?identity.split("@")[0]:identity;if(saveCustomerSession({name,email,phone,identity,updatedAt:new Date().toISOString()})){const destination=takeCustomerReturnRoute();navigate(destination==="home"?"account":destination);showToast("Customer demo sign-in complete.");}}
        else{showToast(`${role} demo workspace is opening.`);setTimeout(()=>location.href=role==="Merchant"?"/ecommerce-merchant":role==="Rider"?"/rider":"/courier-operation",450)}
        return
      }
      if(type==="signup"){const session={name:document.getElementById("signupName").value.trim(),phone:document.getElementById("signupPhone").value.trim(),email:document.getElementById("signupEmail").value.trim(),updatedAt:new Date().toISOString()};if(saveCustomerSession(session)){const destination=takeCustomerReturnRoute();navigate(destination==="home"?"account":destination);showToast("Your customer demo account is ready.");}return}
      if(type==="profile"){const session={...(customerSession||{}),name:document.getElementById("profileName").value.trim(),phone:document.getElementById("profilePhone").value.trim(),email:document.getElementById("profileEmail").value.trim(),updatedAt:new Date().toISOString()};if(saveCustomerSession(session)){navigate("profile");showToast("Your profile has been updated.");}return}
      if(["merchant","rider","franchise"].includes(type)){const accountType=type==="merchant"?document.getElementById("merchantAccountType").value:"";navigate("submitted");showToast(`${accountType?`Your ${accountType} application`:`Your ${type} application`} is prepared for the Delivery Fast team. (Demo only)`)}
    });
    window.addEventListener("hashchange",renderRoute);
    renderRoute();
