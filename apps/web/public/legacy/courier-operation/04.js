    const generatedCNStorageKey="deliveryfast-generated-cns";
    const generatedCNStatuses=["CN generated","Order created","Pickup confirmed","At hub","In transit","Out for delivery","Delivered","Exception","Cancelled"];
    function readGeneratedCNs(){
      const raw=localStorage.getItem(generatedCNStorageKey);
      if(!raw)return [];
      const records=JSON.parse(raw);
      if(!Array.isArray(records))throw new Error("Generated CN storage has an invalid format.");
      return records.filter(record=>record&&record.generatedCN===true&&typeof record.id==="string");
    }
    function saveGeneratedCNs(){
      try{localStorage.setItem(generatedCNStorageKey,JSON.stringify(shipments.filter(shipment=>shipment.generatedCN)))}
      catch(error){console.error("Generated CN records could not be saved.",error);showToast("CN records were not saved. Check browser storage permissions and retry.");return false}
      return true;
    }
    function generatedCNPageCategory(page){return page==="Customer parcels"?"Customer parcels":page==="Document operations"?"Documents":page==="E-commerce operations"?"E-commerce":""}
    function generatedCNDialog(){
      if(document.getElementById("generatedCNDialog"))return;
      document.body.insertAdjacentHTML("beforeend",`<style id="generatedCNStyles">.cn-dialog{width:min(480px,calc(100% - 32px));padding:0;border:1px solid var(--line);border-radius:12px;color:var(--ink);box-shadow:0 24px 70px #10182840}.cn-dialog::backdrop{background:#17203377}.cn-dialog form{padding:20px}.cn-dialog h2{margin:0 0 5px;font-size:18px}.cn-dialog p{margin:0 0 16px;color:var(--muted);font-size:13px;line-height:1.5}.cn-dialog label{display:grid;gap:6px;margin:12px 0;color:#637083;font-size:13px;font-weight:600}.cn-dialog input,.cn-dialog select{width:100%;padding:9px;border:1px solid var(--line);border-radius:7px;background:white;color:var(--ink)}.cn-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.cn-dialog-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.cn-dialog-grid label{margin:0}.cn-generated-toolbar{display:flex;gap:8px;flex-wrap:wrap}.cn-dialog .cn-span-full{grid-column:1/-1}</style><dialog class="cn-dialog" id="generatedCNDialog"><form id="generatedCNForm"><h2 id="generatedCNTitle"></h2><p id="generatedCNDescription"></p><div id="generatedCNFields"></div><div class="cn-dialog-actions"><button class="button" type="button" data-generated-close>Cancel</button><button class="button button-primary" type="submit" id="generatedCNSubmit">Generate CNs</button></div></form></dialog>`);
    }
    function openGeneratedCNDialog(mode,shipment){
      generatedCNDialog();
      const dialog=document.getElementById("generatedCNDialog"),form=document.getElementById("generatedCNForm"),title=document.getElementById("generatedCNTitle"),description=document.getElementById("generatedCNDescription"),fields=document.getElementById("generatedCNFields"),submit=document.getElementById("generatedCNSubmit");
      form.dataset.mode=mode;form.dataset.shipmentId=shipment?.id||"";
      if(mode==="generate"){
        const selectedCategory=generatedCNPageCategory(document.getElementById("breadcrumbPage").textContent);
        title.textContent="Generate consignment numbers";
        description.textContent="Create blank parcel records with unique barcoded CNs, then edit the merchant, recipient, address, and other details.";
        fields.innerHTML=`<div class="cn-dialog-grid"><label>Number of CNs<input name="count" type="number" min="1" max="500" step="1" value="1" required></label><label>Service line<select name="category"><option value="E-commerce" ${selectedCategory==="E-commerce"?"selected":""}>E-commerce</option><option value="Documents" ${selectedCategory==="Documents"?"selected":""}>Documents</option><option value="Customer parcels" ${selectedCategory==="Customer parcels"?"selected":""}>Customer parcels</option></select></label></div>`;
        submit.textContent="Generate CNs";
      }else{
        title.textContent=`Edit parcel · ${courierEscape(shipment.id)}`;
        description.textContent="Update merchant, recipient, destination, service, COD, rider, or status. Changes save in this browser.";
        const input=(name,label,value,type="text")=>`<label>${label}<input name="${name}" type="${type}" value="${courierEscape(value??"")}" ${type==="number"?'min="0" step="0.01"':""}></label>`;
        const categories=[["E-commerce","E-commerce"],["Documents","Documents"],["Customer parcels","Customer parcels"]];
        fields.innerHTML=`<div class="cn-dialog-grid">${input("merchant","Merchant / sender",shipment.merchant)}${input("recipient","Recipient name",shipment.recipient)}${input("recipientPhone","Recipient phone",shipment.recipientPhone)}${input("destination","Delivery address",shipment.destination)}<label>Service line<select name="category">${categories.map(([value,label])=>`<option value="${value}" ${serviceCategory(shipment)===value?"selected":""}>${label}</option>`).join("")}</select></label>${input("service","Service type",shipment.service)}${input("item","Parcel contents",shipment.item)}${input("weight","Weight",shipment.weight,"number")}${input("codAmount","COD amount",shipment.codAmount||0,"number")}${input("rider","Rider",shipment.rider)}<label>Status<select name="status">${[...new Set([...generatedCNStatuses,shipment.status])].map(status=>`<option ${shipment.status===status?"selected":""}>${courierEscape(status)}</option>`).join("")}</select></label>${input("sla","SLA",shipment.sla)}</div>`;
        submit.textContent="Save parcel details";
      }
      dialog.showModal();
      fields.querySelector("input")?.focus();
    }
    function closeGeneratedCNDialog(){const dialog=document.getElementById("generatedCNDialog");if(dialog?.open)dialog.close()}
    function createGeneratedCNs(count,category){
      const created=[],dateCode=new Date().toISOString().slice(2,10).replaceAll("-",""),prefix=`CN-${dateCode}-`;
      let nextNumber=shipments.reduce((highest,shipment)=>{const match=shipment.id.match(new RegExp(`^CN-${dateCode}-(\\d+)$`));return match?Math.max(highest,Number(match[1])):highest},0)+1;
      for(let i=0;i<count;i++){
        let id;do{id=`${prefix}${String(nextNumber++).padStart(5,"0")}`}while(shipments.some(shipment=>shipment.id===id));
        const service=category==="Documents"?"Document shipment":category==="Customer parcels"?"Customer parcel":"E-commerce parcel",createdAt=new Date().toLocaleString();
        const shipment={id,generatedCN:true,merchant:"",recipient:"",recipientPhone:"",destination:"",service,serviceCategory:category,created:createdAt,rider:"Unassigned",status:"CN generated",sla:"Awaiting details",codAmount:0,item:"",weight:"",history:[`${createdAt} · CN generated`]};
        shipments.unshift(shipment);created.push(shipment);
      }
      return created;
    }
    function printGeneratedCNs(page){
      const category=generatedCNPageCategory(page),rows=shipments.filter(shipment=>shipment.generatedCN&&(!category||serviceCategory(shipment)===category));
      if(!rows.length){showToast("There are no generated CNs to print in this view.");return}
      courierPrint("label",page,rows);
    }
    generatedCNDialog();
    document.getElementById("generatedCNDialog").addEventListener("click",event=>{if(event.target.closest("[data-generated-close]"))closeGeneratedCNDialog()});
    try{for(const record of readGeneratedCNs())if(!shipments.some(shipment=>shipment.id===record.id))shipments.unshift(record)}
    catch(error){console.error("Generated CN records could not be loaded.",error);showToast("Saved CN records could not be loaded from this browser.")}
    document.getElementById("mainContent").addEventListener("click",event=>{
      const generate=event.target.closest("#generateCNs"),print=event.target.closest("#printGeneratedCNs"),edit=event.target.closest("[data-generated-edit]"),close=event.target.closest("[data-generated-close]");
      if(generate){openGeneratedCNDialog("generate");return}
      if(print){printGeneratedCNs(document.getElementById("breadcrumbPage").textContent);return}
      if(edit){const shipment=shipments.find(record=>record.id===edit.dataset.generatedEdit);if(shipment)openGeneratedCNDialog("edit",shipment);return}
      if(close)closeGeneratedCNDialog();
    });
    document.getElementById("generatedCNForm").addEventListener("submit",event=>{
      event.preventDefault();
      const form=event.currentTarget,data=new FormData(form);
      if(form.dataset.mode==="generate"){
        const count=Number(data.get("count")),category=String(data.get("category"));
        if(!Number.isInteger(count)||count<1||count>500){showToast("Enter a whole number of CNs between 1 and 500.");return}
        const created=createGeneratedCNs(count,category);
        if(!saveGeneratedCNs()){shipments.splice(0,shipments.length,...shipments.filter(shipment=>!created.includes(shipment)));return}
        closeGeneratedCNDialog();
        const page=document.getElementById("breadcrumbPage").textContent;
        render(page==="Live overview"?"Overview":page);
        showToast(`${created.length} CN(s) generated. Add parcel details and print the barcoded labels when ready.`);
        return;
      }
      const shipment=shipments.find(record=>record.id===form.dataset.shipmentId);
      if(!shipment||!shipment.generatedCN){showToast("This generated CN could not be found.");closeGeneratedCNDialog();return}
      for(const key of ["merchant","recipient","recipientPhone","destination","service","item","weight","rider","sla"])shipment[key]=String(data.get(key)||"").trim();
      shipment.serviceCategory=String(data.get("category"));
      shipment.codAmount=Number(data.get("codAmount"))||0;
      const status=String(data.get("status"));
      if(status!==shipment.status){shipment.status=status;shipment.statusUpdatedAt=new Date().toISOString();shipment.history.push(`${new Date().toLocaleString()} · ${status}`)}
      if(status==="Delivered"&&shipment.sla==="Awaiting details")shipment.sla="Met";
      if(!saveGeneratedCNs())return;
      closeGeneratedCNDialog();
      const page=document.getElementById("breadcrumbPage").textContent;
      render(page==="Live overview"?"Overview":page);
      showToast(`${shipment.id} details saved.`);
    });
    document.getElementById("mainContent").addEventListener("change",event=>{
      const select=event.target.closest("[data-generated-status]");
      if(!select)return;
      const shipment=shipments.find(record=>record.id===select.dataset.generatedStatus&&record.generatedCN);
      if(!shipment)return;
      shipment.status=select.value;
      shipment.sla=select.value==="Delivered"?"Met":select.value==="Exception"?"At risk":select.value==="Cancelled"?"Cancelled":shipment.sla;
      shipment.history.push(`${new Date().toLocaleString()} · ${shipment.status}`);
      if(!saveGeneratedCNs())return;
      const page=document.getElementById("breadcrumbPage").textContent;
      render(page==="Live overview"?"Overview":page);
      showToast(`${shipment.id} status updated to ${shipment.status}.`);
    });
    window.addEventListener("storage",event=>{
      if(event.key!==generatedCNStorageKey)return;
      try{
        const saved=readGeneratedCNs(),savedIds=new Set(saved.map(record=>record.id));
        for(let i=shipments.length-1;i>=0;i--)if(shipments[i].generatedCN&&!savedIds.has(shipments[i].id))shipments.splice(i,1);
        for(const record of saved){const existing=shipments.find(shipment=>shipment.id===record.id);if(existing)Object.assign(existing,record);else shipments.unshift(record)}
        const page=document.getElementById("breadcrumbPage").textContent;
        render(page==="Live overview"?"Overview":page);
      }catch(error){console.error("Generated CN updates could not be synchronized.",error);showToast("CN updates from another tab could not be loaded.")}
    });
    document.getElementById("mainContent").addEventListener("change",event=>{
      if(event.target.matches("[data-shipment-select-all]"))document.querySelectorAll("#shipmentBody [data-shipment-select]").forEach(input=>{if(!input.closest("tr").hidden)input.checked=event.target.checked});
      if(event.target.matches("[data-shipment-select]")){const visible=[...document.querySelectorAll("#shipmentBody tr:not([hidden]) [data-shipment-select]")],selected=visible.filter(input=>input.checked),selectAll=document.querySelector("[data-shipment-select-all]");if(selectAll){selectAll.checked=visible.length>0&&selected.length===visible.length;selectAll.indeterminate=selected.length>0&&selected.length<visible.length}}
    });
    document.getElementById("mainContent").addEventListener("change",event=>{
      const input=event.target.closest("[data-customer-status],[data-generated-status],[data-hub-status]");if(!input)return;
      const id=input.dataset.customerStatus||input.dataset.generatedStatus||input.dataset.hubStatus,shipment=shipments.find(row=>row.id===id);if(shipment)shipment.statusUpdatedAt=new Date().toISOString();
    },true);
    const activeCourierPage=document.querySelector(".nav-item.active")?.dataset.page||"Overview";
    render(activeCourierPage);
