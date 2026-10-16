    const originalRiderOpenModal=openModal;
    let proofCanvasDirty=false;
    function updateOutcomeFields(){
      const outcome=document.getElementById("outcome"),failed=outcome&&outcome.value!=="Delivered successfully";
      const failedFields=document.getElementById("failedDeliveryFields"),podFields=document.getElementById("proofFields");
      if(failedFields)failedFields.hidden=!failed;
      if(podFields)podFields.hidden=failed;
      const reason=document.getElementById("failureReason");if(reason)reason.required=failed;
      const next=document.getElementById("nextStep");if(next)next.required=failed;
      const method=document.getElementById("proofMethod");if(method)method.dispatchEvent(new Event("change"));
      if(failed){document.getElementById("deliveryOtp").required=false;document.getElementById("deliveryPhoto").required=false}
    }
    function updateProofMethod(){
      const method=document.getElementById("proofMethod");if(!method)return;
      const signature=document.getElementById("signatureProof"),otp=document.getElementById("otpProof"),photo=document.getElementById("photoProof");
      signature.hidden=method.value!=="Signature";otp.hidden=method.value!=="OTP";photo.hidden=method.value!=="Photo";
      document.getElementById("deliveryOtp").required=method.value==="OTP";
      document.getElementById("deliveryPhoto").required=method.value==="Photo";
    }
    openModal=function(type,id){
      if(type==="support"){
        const callback=id==="call";
        activeAction={type,id};
        document.getElementById("modalTitle").textContent=callback?"Request a dispatch callback":"Message rider support";
        document.getElementById("modalDescription").textContent=callback?"Share what happened and dispatch will follow up in this demo. No phone call will be placed.":"Send a delivery, safety, COD, or app issue to the demo dispatch inbox.";
        document.getElementById("submitAction").textContent=callback?"Submit callback request":"Send support message";
        document.getElementById("modalFields").innerHTML=`<div class="field"><label for="supportTopic">What do you need help with?</label><select id="supportTopic" required><option value="">Choose a topic</option><option>Delivery issue</option><option>Rider safety</option><option>COD or payment</option><option>App or device</option><option>Other</option></select></div><div class="field"><label for="supportTracking">Tracking ID (optional)</label><input id="supportTracking" placeholder="e.g. PP-28491"></div><div class="field full"><label for="supportMessage">Details for dispatch</label><textarea id="supportMessage" rows="4" required placeholder="Describe the issue and what help you need"></textarea></div><div class="field full"><label for="supportContact">How should dispatch follow up?</label><select id="supportContact"><option>${callback?"Phone call":"In-app reply"}</option><option>${callback?"In-app reply":"Phone call"}</option></select></div><p class="panel-subtitle field full">Demo only: this creates a sample support ticket in this browser session. It does not send a real message or place a call.</p>`;
        document.getElementById("actionModal").classList.add("open");
        return;
      }
      if(type!=="delivery"){originalRiderOpenModal(type,id);return}
      activeAction={type,id};proofCanvasDirty=false;
      document.getElementById("modalTitle").textContent=`Update ${id}`;
      document.getElementById("modalDescription").textContent="Record the outcome and capture delivery proof or a documented exception.";
      document.getElementById("submitAction").textContent="Save delivery update";
      document.getElementById("modalFields").innerHTML=`<div class="field full"><label for="outcome">Delivery outcome</label><select id="outcome"><option>Delivered successfully</option><option>Failed delivery</option><option>Return to hub</option></select></div>
        <div id="proofFields" class="field full"><label for="proofMethod">Proof of delivery method</label><select id="proofMethod"><option>Signature</option><option>OTP</option><option>Photo</option></select>
          <div id="signatureProof" class="proof-box"><label for="signatureCanvas">Recipient signature on screen</label><canvas id="signatureCanvas" aria-label="Draw recipient signature"></canvas><div class="proof-actions"><small>Sign with finger or mouse.</small><button type="button" class="button button-sm" id="clearSignature">Clear signature</button></div></div>
          <div id="otpProof" class="proof-box" hidden><label for="deliveryOtp">Recipient delivery OTP</label><input id="deliveryOtp" inputmode="numeric" pattern="[0-9]{4,6}" placeholder="Enter 6-digit OTP"><small>Demo OTP: 4810</small></div>
          <div id="photoProof" class="proof-box" hidden><label for="deliveryPhoto">Upload photo of physical signature</label><input id="deliveryPhoto" type="file" accept="image/*"><img id="photoPreview" class="proof-preview" alt="Uploaded proof preview" hidden></div>
        </div>
        <div id="failedDeliveryFields" class="field full" hidden><label for="failureReason">Failure reason</label><select id="failureReason"><option value="">Select a reason</option><option>Recipient unavailable</option><option>Incorrect address</option><option>Recipient refused</option><option>Unable to contact recipient</option><option>Access / safety issue</option><option>Other</option></select><label for="failureNote" style="margin-top:9px">Reason details</label><textarea id="failureNote" placeholder="Add context for dispatch and the next attempt"></textarea><label for="nextStep" style="margin-top:9px">Next action</label><select id="nextStep"><option value="">Choose next action</option><option>Schedule another attempt</option><option>Return to hub</option></select></div>
        <div class="field full"><label for="recipientNote">Delivery note</label><textarea id="recipientNote" placeholder="Optional note for dispatch"></textarea></div><div id="proofFeedback" class="form-feedback" role="alert"></div>`;
      document.getElementById("outcome").addEventListener("change",updateOutcomeFields);
      document.getElementById("proofMethod").addEventListener("change",updateProofMethod);
      updateOutcomeFields();
      document.getElementById("actionModal").classList.add("open");
      const canvas=document.getElementById("signatureCanvas"),ctx=canvas.getContext("2d");
      const resizeCanvas=()=>{const rect=canvas.getBoundingClientRect(),scale=window.devicePixelRatio||1;canvas.width=rect.width*scale;canvas.height=rect.height*scale;ctx.scale(scale,scale);ctx.lineWidth=2;ctx.lineCap="round";ctx.strokeStyle="#263448"};
      resizeCanvas();
      let drawing=false;
      const point=event=>{const rect=canvas.getBoundingClientRect();return{x:event.clientX-rect.left,y:event.clientY-rect.top}};
      canvas.addEventListener("pointerdown",event=>{drawing=true;canvas.setPointerCapture(event.pointerId);const p=point(event);ctx.beginPath();ctx.moveTo(p.x,p.y);proofCanvasDirty=true});
      canvas.addEventListener("pointermove",event=>{if(!drawing)return;const p=point(event);ctx.lineTo(p.x,p.y);ctx.stroke()});
      canvas.addEventListener("pointerup",()=>drawing=false);canvas.addEventListener("pointercancel",()=>drawing=false);
      document.getElementById("clearSignature").addEventListener("click",()=>{ctx.clearRect(0,0,canvas.width,canvas.height);proofCanvasDirty=false});
      document.getElementById("deliveryPhoto").addEventListener("change",event=>{const file=event.target.files[0],preview=document.getElementById("photoPreview");if(file){preview.src=URL.createObjectURL(file);preview.hidden=false}});
    };
    document.getElementById("actionForm").addEventListener("submit",event=>{
      if(!activeAction||activeAction.type!=="support")return;
      event.preventDefault();event.stopImmediatePropagation();
      const callback=document.getElementById("supportContact").value==="Phone call";
      const now=new Date();
      const request={id:`DF-RS-${now.toISOString().slice(2,10).replace(/-/g,"")}-${String(++riderSupportSequence).padStart(3,"0")}`,category:document.getElementById("supportTopic").value,trackingId:document.getElementById("supportTracking").value.trim().toUpperCase(),message:document.getElementById("supportMessage").value.trim(),channel:callback?"Phone callback":"In-app message",status:callback?"Callback requested":"Sent to dispatch",createdAt:now.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})};
      riderSupportRequests.unshift(request);
      closeModal();
      showToast(`${request.id} created · ${request.status}. Demo only.`);
      if(document.getElementById("breadcrumbPage").textContent==="Help & safety")render("Help & safety");
    },true);
    document.getElementById("actionForm").addEventListener("submit",event=>{
      if(!activeAction||activeAction.type!=="pickup")return;
      const record=readCustomerParcelRecord(activeAction.id);if(!record)return;
      event.preventDefault();event.stopImmediatePropagation();
      const action=activeAction,outcome=document.getElementById("pickupOutcome").value,note=document.getElementById("pickupNote").value.trim();
      if(record.status!=="Pickup assigned"||!assignedToThisRider(record)){showToast("This customer pickup is no longer assigned to your rider account.");closeModal();render(document.getElementById("breadcrumbPage").textContent);return}
      const atHub=outcome.includes("submit to hub"),exception=outcome==="Pickup exception",hub=atHub?document.getElementById("pickupHub").value:"",status=exception?"Exception":atHub?"At hub":"Out for delivery",detail=exception?`Pickup could not be completed. ${note||"Dispatch review required."}`:atHub?`Rider collected the parcel and handed it to ${hub}.${note?` ${note}`:""}`:`Rider collected the parcel and will deliver it directly.${note?` ${note}`:""}`;
      try{const updated=updateCustomerParcelRecord(action.id,status,detail,atHub?"Unassigned":record.rider,"",hub);updated.pickedUpAt=new Date().toISOString();localStorage.setItem("deliveryfast-customer-parcels",JSON.stringify(readCustomerParcelRecords().map(item=>item.trackingId===action.id?updated:item)))}catch(error){console.error("Customer parcel pickup update could not be saved.",error);showToast("Pickup update could not be saved. Check browser storage and retry.");return}
      closeModal();showToast(exception?`${action.id}: pickup exception sent to dispatch.`:atHub?`${action.id}: pickup completed and handed to hub.`:`${action.id}: picked up and ready for direct delivery.`);render(document.getElementById("breadcrumbPage").textContent);
    },true);
    document.getElementById("actionForm").addEventListener("submit",event=>{
      if(!activeAction||activeAction.type!=="delivery")return;
      event.preventDefault();event.stopImmediatePropagation();
      const id=activeAction.id,customerRecord=readCustomerParcelRecord(activeAction.id),row=deliveries.find(item=>item.id===id)||(customerRecord&&assignedToThisRider(customerRecord)?{id,recipient:customerRecord.recipient||"Recipient",phone:customerRecord.recipientPhone||"",address:customerRecord.destination||"Delivery address not set",type:"Customer parcel",time:"As assigned",status:customerRecord.status,cod:Number(customerRecord.codAmount)>0?`৳ ${customerRecord.codAmount}`:"Prepaid"}:null),outcome=document.getElementById("outcome").value,feedback=document.getElementById("proofFeedback");
      if(!row){feedback.textContent=`Delivery ${id} was not found in this sample route.`;return}
      let proof={};
      if(outcome==="Delivered successfully"){
        const method=document.getElementById("proofMethod").value;
        if(method==="Signature"&&!proofCanvasDirty){feedback.textContent="Capture the recipient's signature before completing delivery.";return}
        if(method==="OTP"&&document.getElementById("deliveryOtp").value!=="4810"){feedback.textContent="The demo OTP does not match. Enter 4810 to verify.";return}
        if(method==="Photo"&&!document.getElementById("deliveryPhoto").files.length){feedback.textContent="Upload the physical-signature photo to complete delivery.";return}
        proof={method,signature:method==="Signature"?document.getElementById("signatureCanvas").toDataURL():"",otpVerified:method==="OTP",photoName:method==="Photo"?document.getElementById("deliveryPhoto").files[0].name:""};
        row.status="Delivered";row.proof=proof;row.deliveredAt="Just now";row.failureReason="";
      }else{
        const reason=document.getElementById("failureReason").value,next=document.getElementById("nextStep").value;
        if(!reason||!next){feedback.textContent="Choose a failure reason and the next action.";return}
        row.attempts=(row.attempts||0)+1;row.failureReason=reason;row.failureNote=document.getElementById("failureNote").value.trim();row.nextStep=next;
        row.status=next==="Return to hub"?"At hub":"Retry scheduled";row.proof=null;
      }
      if(customerRecord){const status=row.status,detail=status==="Delivered"?`Delivery completed with ${proof.method} proof.`:`Delivery attempt: ${row.failureReason||"issue"} · ${row.nextStep||status}.`;try{updateCustomerParcelRecord(id,status,detail,status==="At hub"?"Unassigned":customerRecord.rider,status==="Delivered"?`${proof.method} proof recorded`:"")}catch(error){console.error("Customer parcel delivery update could not be saved.",error);feedback.textContent="Delivery update could not be saved. Check browser storage and retry.";return}}
      closeModal();showToast(outcome==="Delivered successfully"?`${id} delivered. ${proof.method} proof saved.`:`${id}: ${row.failureReason} · ${row.nextStep}.`);render(document.getElementById("breadcrumbPage").textContent);
    },true);
    window.addEventListener("storage",event=>{if(event.key!=="deliveryfast-customer-parcels")return;const page=document.getElementById("breadcrumbPage").textContent;if(page==="Pickup queue"||page==="Deliveries")render(page)});
