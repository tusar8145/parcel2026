    const icon = (name) => `<svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"><use href="#i-${name}"/></svg>`;
    const sampleOrders = [
      {id:"DF-610284",name:"Ayesha Rahman",initials:"AR",phone:"+880 1712-•••-481",item:"Corporate Urgent Document",type:"Document delivery",documentType:"Corporate Urgent Document",packaging:"Security pouch",recipientRelation:"Authorized representative",service:"Express",date:"Today, 10:42 AM",amount:"৳ 120",deliveryFee:120,status:"In transit",address:"Office: 18 Motijheel C/A, Motijheel, Dhaka Central",requiredServices:["Scan POD (signed invoice photo)","OTP verification","Recipient digital signature"]},
      {id:"DF-610283",name:"Mahir Chowdhury",initials:"MC",phone:"+880 1819-•••-205",item:"ATM card",type:"Document delivery",documentType:"ATM card",packaging:"Security pouch",recipientRelation:"Self",service:"Regular",date:"Today, 10:18 AM",amount:"৳ 60",deliveryFee:60,status:"Delivered",address:"Home: House 12, Banani, Dhaka North",requiredServices:["Recipient digital signature"]},
      {id:"DF-610282",name:"Nusrat Jahan",initials:"NJ",phone:"+880 1610-•••-932",item:"Cheque book",type:"Document delivery",documentType:"Cheque book",packaging:"Security pouch",recipientRelation:"Family member",service:"Regular",date:"Today, 9:56 AM",amount:"৳ 60",deliveryFee:60,status:"Picked up",address:"Office: Gulshan Avenue, Dhaka North"},
      {id:"DF-610281",name:"Tanvir Ahmed",initials:"TA",phone:"+880 1911-•••-744",item:"Trade Service Document",type:"Document delivery",documentType:"Trade Service Document",packaging:"Rigid document mailer",recipientRelation:"Colleague",service:"Express",date:"Today, 9:31 AM",amount:"৳ 80",deliveryFee:80,status:"Processing",address:"Office: Agrabad C/A, Chattogram"},
      {id:"DF-610280",name:"Farhana Islam",initials:"FI",phone:"+880 1555-•••-610",item:"B2B Document",type:"Document delivery",documentType:"B2B Document",packaging:"Document envelope",recipientRelation:"Reception",service:"Regular",date:"Today, 9:12 AM",amount:"৳ 60",deliveryFee:60,status:"Delivered",address:"Office: Dhanmondi 27, Dhaka South"}
    ];
    const pageData = {
      "Orders": {description:"Submit controlled, trackable business documents for secure delivery.",columns:["Consignment ID","Recipient","Document type","Created","Delivery fee","Status"],rows:sampleOrders},
      "Shipments": {description:"Track confidential document consignments, proof of delivery, and exceptions.",columns:["Tracking ID","Recipient","Document","Destination","Last update","Status"],rows:[
        ["DF-610284","Ayesha Rahman","Corporate Urgent Document","Motijheel, Dhaka","Out for delivery · 10:42 AM","In transit"],["DF-610283","Mahir Chowdhury","ATM card","Banani, Dhaka","Delivered · 10:18 AM","Delivered"],["DF-610282","Nusrat Jahan","Cheque book","Gulshan, Dhaka","Picked up · 9:56 AM","Picked up"],["DF-610281","Tanvir Ahmed","Trade Service Document","Agrabad, Chattogram","At sorting hub · 9:24 AM","In transit"],["DF-610280","Farhana Islam","B2B Document","Dhanmondi, Dhaka","Delivered · 9:12 AM","Delivered"]],
        stats:[["In transit","18"],["Delivered this month","842"],["Needs attention","3"]]},
      "Pickup requests": {description:"Schedule branch document pickups and manage recurring courier collections.",columns:["Request ID","Origin branch","Pickup location","Document batches","Requested","Status"],rows:[
        ["PU-41042","MBP-DHK-01","Motijheel C/A, Dhaka","12 sealed pouches","Today, 11:30 AM","Pickup scheduled"],["PU-41041","MBP-DHK-02","Banani, Dhaka","8 card envelopes","Today, 10:30 AM","Picked up"],["PU-41040","MBP-CTG-01","Agrabad C/A, Chattogram","5 document packs","Today, 9:45 AM","Picked up"],["PU-41039","MBP-DHK-03","Gulshan, Dhaka","3 cheque-book packs","Today, 1:00 PM","Processing"],["PU-41038","MBP-DHK-04","Dhanmondi, Dhaka","6 sealed pouches","Yesterday","Delivered"]],
        stats:[["Awaiting pickup","6"],["Scheduled today","12"],["Collected today","28"]]},
      "Customers": {description:"Approved receiving parties and corporate branch locations.",columns:["Recipient / branch","Phone","Consignments","Branch code","Last delivery","Status"],rows:[
        ["Motijheel Main Branch","+880 1712-•••-481","128","MBP-DHK-01","Today, 10:42 AM","Active"],["Banani Service Centre","+880 1610-•••-932","86","MBP-DHK-02","Today, 9:56 AM","Active"],["Gulshan Corporate Branch","+880 1819-•••-205","64","MBP-DHK-03","Today, 10:18 AM","Active"],["Agrabad Branch","+880 1911-•••-744","42","MBP-CTG-01","Yesterday","Active"],["Dhanmondi Branch","+880 1555-•••-610","38","MBP-DHK-04","Yesterday","Active"]],
        stats:[["Registered branches","42"],["Active receivers","1,284"],["Business units","8"]]},
      "Products": {description:"Approved document classes and secure handling requirements for your account.",columns:["Document class","Service code","Handling","Packaging","Billing basis","Status"],rows:[
        ["ATM card","DOC-CARD","Identity check","Security pouch","Per delivery","Active"],["Cheque book","DOC-CHQ","Signature required","Security pouch","Per delivery","Active"],["B2B Document","DOC-B2B","Recipient verification","Document envelope","Per delivery","Active"],["Trade Service Document","DOC-TRADE","Authorized receiver","Rigid document mailer","Per delivery","Active"],["Corporate Urgent Document","DOC-URGENT","Priority · signature","Security pouch","Express tariff","Active"]],
        stats:[["Approved classes","5"],["Secure packaging","3 types"],["Custom tariffs","Contracted"]]},
      "Payments": {description:"Review invoice settlements and corporate account adjustments.",columns:["Transaction","Invoice","Method","Date","Amount","Status"],rows:[
        ["RCPT-99284","INV-MBP-2026-0084","Bank transfer","Sep 12, 2026","৳ 28,640","Paid"],["RCPT-99270","INV-MBP-2026-0078","Bank transfer","Aug 14, 2026","৳ 24,880","Paid"],["ADJ-00281","INV-MBP-2026-0084","Service adjustment","Sep 10, 2026","−৳ 420","Processed"]],
        stats:[["Outstanding invoices","1"],["Paid this quarter","৳ 53,520"],["Next due date","Oct 15"]]},
      "Reports": {description:"Branch delivery performance, proof-of-delivery compliance, and finance reconciliation.",columns:["Report","Period","Generated","Format","Owner","Status"],rows:[
        ["Monthly branch statement","Oct 1 – Oct 14","Today, 9:00 AM","CSV · Print","Farhana Ahmed","Delivered"],["Proof of delivery audit","Oct 1 – Oct 13","Yesterday, 4:30 PM","CSV","Farhana Ahmed","Delivered"],["Invoice aging report","Oct 1 – Oct 13","Yesterday, 2:15 PM","CSV · Print","Farhana Ahmed","Processing"],["Branch volume summary","September 2026","Oct 1, 10:00 AM","CSV","Farhana Ahmed","Delivered"]],
        stats:[["Delivery charges","৳ 3,84,250"],["Documents this month","842"],["POD compliance","99.2%"]]},
      "Settings": {description:"Configure corporate billing, branch access, notifications, and integrations.",columns:["Setting","Details","Updated",""],rows:[
        ["Corporate account","Meridian Bank PLC · Dhaka, Bangladesh","Oct 10, 2026","Manage"],["Billing profile","Monthly consolidated · Net 15 sample terms","Oct 9, 2026","Manage"],["Notification settings","Email and SMS alerts enabled","Oct 8, 2026","Manage"],["Team & permissions","8 users · 4 branch roles","Oct 2, 2026","Manage"],["API & integrations","Corporate API access requested","Sep 28, 2026","Manage"]],
        stats:[["Account status","Active"],["Branch users","8"],["Connected systems","2"]]}
    };
    const statusClass = (status) => {
      const normalized = String(status).toLowerCase();
      // Real parcel statuses (bridge.js) the sample data never had; "Out for delivery" is not yet delivered.
      if (normalized === "out for delivery" || normalized === "at hub" || normalized === "assigned") return "status-transit";
      if (normalized.includes("exception") || normalized.includes("return") || normalized === "overdue") return "status-cancelled";
      if (normalized.includes("deliver") || normalized === "paid" || normalized === "active" || normalized.includes("picked")) return "status-delivered";
      if (normalized.includes("transit") || normalized.includes("process")) return "status-transit";
      if (normalized.includes("pending") || normalized.includes("scheduled")) return "status-pending";
      if (normalized.includes("cancel") || normalized.includes("fail") || normalized.includes("inactive")) return "status-cancelled";
      return "status-pending";
    };
    const merchantEscape=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    const statusPill = (text) => `<span class="status ${statusClass(text)}">${merchantEscape(text)}</span>`;
    const metricCard = (label,value,iconName,foot,trend) => `<article class="metric"><div class="metric-head"><span>${label}</span><span class="metric-icon">${icon(iconName)}</span></div><div class="metric-value">${value}</div><div class="metric-foot"><span class="trend">${trend}</span><span>${foot}</span></div></article>`;
    const renderDashboard = () => `
      <div class="page-heading">
        <div><p class="eyebrow">Wednesday, October 14, 2026</p><h1>Good morning, Farhana <span style="font-size:20px">☀️</span></h1><p class="subtitle">Your banking & financial deliveries, proof of delivery, and billing at a glance.</p></div>
        <div class="heading-actions"><button class="button date-button" data-toast="Date range: October 14, 2026">${icon("calendar")} Today, Oct 14 <span style="color:#a0a9b5">⌄</span></button><button class="button" data-page-link="Billing">Billing</button><button class="button button-primary" id="createOrder">${icon("plus")} New document request</button></div>
      </div>
      <div class="metrics">
        ${metricCard("Documents this month","842","orders","across all branches","↑ 12.8%")}
        ${metricCard("In transit","18","truck","secure consignments","")}
        ${metricCard("Unbilled charges","৳ 8,460","wallet","ready for monthly bill","2 batches")}
        ${metricCard("Delivery success","96.8%","chart","first-attempt delivery","↑ 2.4%")}
      </div>
      <div class="dashboard-grid">
        <section class="panel">
          <div class="panel-heading"><div><h2 class="panel-title">Document volume & delivery charges</h2><p class="panel-subtitle">Corporate consignments across branches</p></div><select class="select-small" id="chartPeriod" aria-label="Chart period"><option>Last 7 days</option><option>Last 30 days</option><option>This year</option></select></div>
          <div class="chart-legend"><span class="legend-item"><i class="legend-dot"></i> Documents</span><span class="legend-item"><i class="legend-dot gray"></i> Previous period</span></div>
          <svg class="chart" viewBox="0 0 700 190" preserveAspectRatio="none" role="img" aria-label="Orders trend chart for the last seven days">
            <defs><linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#3766e8" stop-opacity=".14"/><stop offset="100%" stop-color="#3766e8" stop-opacity="0"/></linearGradient></defs>
            <g class="chart-grid"><line x1="45" y1="20" x2="690" y2="20"/><line x1="45" y1="60" x2="690" y2="60"/><line x1="45" y1="100" x2="690" y2="100"/><line x1="45" y1="140" x2="690" y2="140"/><line x1="45" y1="170" x2="690" y2="170"/></g>
            <g class="chart-labels"><text x="5" y="23">100</text><text x="12" y="63">75</text><text x="12" y="103">50</text><text x="12" y="143">25</text><text x="18" y="173">0</text><text x="45" y="187">Oct 08</text><text x="145" y="187">Oct 09</text><text x="245" y="187">Oct 10</text><text x="345" y="187">Oct 11</text><text x="445" y="187">Oct 12</text><text x="545" y="187">Oct 13</text><text x="645" y="187">Oct 14</text></g>
            <path class="chart-line-secondary" d="M45 115 C85 108 103 123 145 109 S210 102 245 116 S310 130 345 106 S410 120 445 98 S510 108 545 91 S610 105 645 83 S670 90 690 78"/>
            <path class="chart-area" d="M45 94 C85 85 100 112 145 91 S210 52 245 73 S310 110 345 69 S410 81 445 54 S510 91 545 54 S610 45 645 27 S670 42 690 18 L690 170 L45 170Z"/>
            <path class="chart-line" d="M45 94 C85 85 100 112 145 91 S210 52 245 73 S310 110 345 69 S410 81 445 54 S510 91 545 54 S610 45 645 27 S670 42 690 18"/>
            <circle class="chart-point" cx="645" cy="27" r="4"/>
          </svg>
        </section>
        <section class="panel">
          <div class="panel-heading"><div><h2 class="panel-title">Document delivery overview</h2><p class="panel-subtitle">Today's secure consignment status</p></div><button class="button button-sm" data-page-link="Shipments">View all</button></div>
          <div class="dispatch-summary"><div><strong>68</strong><span>Today's documents</span></div><i class="divider"></i><div><strong>52</strong><span>Delivered</span></div><i class="divider"></i><div><strong>4</strong><span>Exceptions</span></div></div>
          <div class="progress-label"><span>Delivery completion</span><strong>76%</strong></div><div class="progress-track"><div class="progress-fill"></div></div>
          <div class="dispatch-list"><div class="dispatch-row"><span class="dispatch-label"><i style="background:#3766e8"></i>In transit</span><strong>18</strong></div><div class="dispatch-row"><span class="dispatch-label"><i style="background:#16845b"></i>Delivered</span><strong>42</strong></div><div class="dispatch-row"><span class="dispatch-label"><i style="background:#d4a13b"></i>Pickup scheduled</span><strong>6</strong></div><div class="dispatch-row"><span class="dispatch-label"><i style="background:#c34d4d"></i>Signature / delivery issue</span><strong>2</strong></div></div>
        </section>
      </div>
      <div class="content-grid">
        <section class="panel table-panel">
          <div class="panel-heading"><div><h2 class="panel-title">Recent document requests</h2><p class="panel-subtitle">Latest branch consignments and delivery updates</p></div><button class="button button-sm" data-page-link="Orders">View all requests</button></div>
          <div class="table-scroll"><table><thead><tr><th>CONSIGNMENT</th><th>RECIPIENT</th><th>DOCUMENT TYPE</th><th>DELIVERY FEE</th><th>STATUS</th><th></th></tr></thead><tbody>${sampleOrders.slice(0,4).map(order=>`<tr><td class="order-id">${order.id}</td><td><div class="customer-cell"><span class="customer-mini">${order.initials}</span><span class="customer-name">${order.name}</span></div></td><td>${order.documentType}</td><td>${order.amount}</td><td>${statusPill(order.status)}</td><td><button class="row-menu" aria-label="More actions">···</button></td></tr>`).join("")}</tbody></table></div>
        </section>
        <section class="panel">
          <div class="panel-heading"><div><h2 class="panel-title">Recent activity</h2><p class="panel-subtitle">Latest updates from your workspace</p></div><button class="button button-sm" data-toast="You're all caught up.">See all</button></div>
          <div class="activity-list">
            <div class="activity-item"><span class="activity-icon">${icon("truck")}</span><div class="activity-copy"><strong>DF-610283</strong> was delivered to Mahir Chowdhury<small>12 minutes ago · Dhaka North</small></div></div>
            <div class="activity-item"><span class="activity-icon">${icon("box")}</span><div class="activity-copy"><strong>Document collected</strong> from Meridian Bank Motijheel<small>34 minutes ago · Corporate Urgent</small></div></div>
            <div class="activity-item"><span class="activity-icon">${icon("wallet")}</span><div class="activity-copy"><strong>Monthly invoice paid</strong> — ৳ 18,420<small>Yesterday at 4:30 PM</small></div></div>
            <div class="activity-item"><span class="activity-icon">${icon("pin")}</span><div class="activity-copy"><strong>Pickup scheduled</strong> for Oliver Chen<small>Yesterday at 3:12 PM · Uttara</small></div></div>
          </div>
        </section>
      </div>`;
    const makeRow = (row, page) => {
      if (page === "Orders") return `<tr><td class="order-id">${merchantEscape(row.id)}</td><td><div class="customer-cell"><span class="customer-mini">${merchantEscape(row.initials)}</span><span><span class="customer-name">${merchantEscape(row.name)}</span><span class="customer-phone" style="display:block">${merchantEscape(row.phone)}</span></span></div></td><td>${merchantEscape(row.item)}<div style="color:#9aa3af;font-size:12px;margin-top:3px">${merchantEscape(row.type)}</div></td><td>${merchantEscape(row.date)}</td><td>${merchantEscape(row.amount)}</td><td>${statusPill(row.status)}</td></tr>`;
      return `<tr>${row.map((cell,i)=>`<td>${page === "Settings" && i===3 ? `<button class="button button-sm" data-toast="${merchantEscape(row[0])} settings opened.">Manage</button>` : (i === row.length-1 && ["Shipments","Pickup requests","Payments","Reports"].includes(page) ? statusPill(cell) : merchantEscape(cell))}</td>`).join("")}</tr>`;
    };
    const renderListPage = (page) => {
      const data = pageData[page];
      const stats = data.stats ? `<div class="metrics">${data.stats.map((item,i)=>metricCard(item[0],item[1],["chart","box","truck"][i],"updated just now","")).join("")}</div>` : "";
      return `<div class="page-heading"><div><p class="eyebrow">Banking & Financial workspace</p><h1>${page==="Orders"?"Document requests":page==="Shipments"?"Document tracking":page==="Customers"?"Recipients & branches":page==="Products"?"Document catalogue":page}</h1><p class="subtitle">${data.description}</p></div><div class="heading-actions">${page==="Orders" ? `<button class="button button-primary" id="createOrder">${icon("plus")} New document request</button>` : `<button class="button" id="exportButton">${icon("download")} Export</button>`}</div></div>
        ${stats}<section class="panel table-panel page-table-panel"><div class="panel-heading"><div><h2 class="panel-title">${page} list</h2><p class="panel-subtitle">Sample records · refreshed just now</p></div><div class="table-tools"><input class="table-search" id="tableSearch" placeholder="Search ${page.toLowerCase()}..." aria-label="Search ${page}">${["Orders","Shipments"].includes(page)?"":`<button class="button button-sm" data-toast="Filters are ready in the full product.">Filter</button>`}</div></div>
        <div class="table-scroll"><table><thead><tr>${data.columns.map(column=>`<th>${column.toUpperCase()}</th>`).join("")}</tr></thead><tbody id="tableBody">${data.rows.map(row=>makeRow(row,page)).join("")}</tbody></table></div><div class="table-footer"><span>Showing ${data.rows.length} sample records</span><div class="pagination"><button class="page-btn">‹</button><button class="page-btn current">1</button><button class="page-btn">2</button><button class="page-btn">3</button><button class="page-btn">›</button></div></div></section>`;
    };
    function showToast(message) {
      const toast = document.getElementById("toast");
      toast.textContent = message;
      toast.classList.add("show");
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(()=>toast.classList.remove("show"),2600);
    }
    function openOrderModal() { document.getElementById("orderModal").classList.add("open"); document.getElementById("customerName").focus(); }
    function closeOrderModal() { document.getElementById("orderModal").classList.remove("open"); }
    function renderPage(page) {
      document.getElementById("breadcrumbPage").textContent = page;
      document.getElementById("mainContent").innerHTML = page === "Overview" ? renderDashboard() : renderListPage(page);
      document.querySelectorAll(".nav-item").forEach(item=>item.classList.toggle("active",item.dataset.page===page));
      document.getElementById("sidebar").classList.remove("open");
      const createButton = document.getElementById("createOrder");
      if (createButton) createButton.addEventListener("click",openOrderModal);
      const tableSearch = document.getElementById("tableSearch");
      if (tableSearch) tableSearch.addEventListener("input",()=> {
        const term = tableSearch.value.toLowerCase();
        document.querySelectorAll("#tableBody tr").forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(term));
      });
      const exportButton = document.getElementById("exportButton");
      if (exportButton) exportButton.addEventListener("click",()=>page==="Shipments"?merchantDownloadShipmentRows():exportPage(page));
    }
    function exportPage(page) {
      const rows = pageData[page].rows;
      const csv = [pageData[page].columns, ...rows.map(row=>Array.isArray(row)?row:Object.values(row))].map(row=>row.map(value=>`"${String(value).replaceAll('"','""')}"`).join(",")).join("\r\n");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
      link.download = `${page.toLowerCase().replaceAll(" ","-")}-sample.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
      showToast(`${page} sample data exported.`);
    }
    document.getElementById("navigation").addEventListener("click",event=>{
      const button = event.target.closest("[data-page]");
      if (button) renderPage(button.dataset.page);
    });
    document.getElementById("mainContent").addEventListener("click",event=>{
      const link = event.target.closest("[data-page-link]");
      if (link) renderPage(link.dataset.pageLink);
      const toastButton = event.target.closest("[data-toast]");
      if (toastButton) showToast(toastButton.dataset.toast);
    });
    document.getElementById("notificationButton").addEventListener("click",()=>showToast("You're all caught up on notifications."));
    document.getElementById("globalSearch").addEventListener("keydown",event=>{
      if (event.key === "Enter") {
        const query = event.currentTarget.value.trim();
        if (!query) return;
        if (/api|webhook/i.test(query)) { renderPage("API & Webhooks"); return; }
        if (/billing|invoice|bill/i.test(query)) { renderPage("Billing"); return; }
        const match = Object.keys(pageData).find(page=>page.toLowerCase().includes(query.toLowerCase()));
        if (match) renderPage(match);
        else showToast(`No matching records for “${query}”.`);
      }
    });
    document.getElementById("mobileMenu").addEventListener("click",()=>document.getElementById("sidebar").classList.toggle("open"));
    document.getElementById("closeModal").addEventListener("click",closeOrderModal);
    document.getElementById("cancelModal").addEventListener("click",closeOrderModal);
    document.getElementById("orderModal").addEventListener("click",event=>{if(event.target.id==="orderModal") closeOrderModal();});
    document.addEventListener("keydown",event=>{if(event.key==="Escape") closeOrderModal();});
    document.getElementById("orderForm").addEventListener("submit",event=>{
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = form.get("customerName").trim();
      const id = `PP-${28500 + sampleOrders.length}`;
      const initials = name.split(/\s+/).map(part=>part[0]).slice(0,2).join("").toUpperCase();
      sampleOrders.unshift({id,name,initials,phone:form.get("customerPhone"),item:document.getElementById("orderType").value,type:"Domestic delivery",date:"Just now",amount:`৳ ${Number(document.getElementById("orderAmount").value).toLocaleString("en-BD")}`,status:"Processing"});
      pageData.Orders.rows = sampleOrders;
      event.currentTarget.reset();
      closeOrderModal();
      renderPage(document.getElementById("breadcrumbPage").textContent);
      showToast(`Order ${id} created successfully.`);
    });
    document.querySelector(".help-card button").addEventListener("click",event=>showToast(event.currentTarget.dataset.toast));
    document.querySelector(".workspace-switch").addEventListener("click",()=>showToast("You're viewing the Meridian Bank PLC workspace."));
    document.querySelector(".user-profile").addEventListener("click",()=>showToast("Profile and account settings opened."));
    renderPage("Overview");
