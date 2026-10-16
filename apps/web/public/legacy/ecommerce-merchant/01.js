    const icon = (name) => `<svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"><use href="#i-${name}"/></svg>`;
    const sampleOrders = [
      {id:"PP-28491",name:"Sophie Williams",initials:"SW",phone:"+880 1712-•••-481",item:"Everyday Tote Bag",type:"E-commerce parcel",date:"Today, 10:42 AM",amount:"৳ 2,450",status:"In transit",requiredServices:["Scan POD (signed invoice photo)","OTP verification"]},
      {id:"PP-28490",name:"Daniel Kim",initials:"DK",phone:"+880 1819-•••-205",item:"Signed contract",type:"Document delivery",date:"Today, 10:18 AM",amount:"৳ 180",status:"Picked up"},
      {id:"PP-28489",name:"Amina Rahman",initials:"AR",phone:"+880 1610-•••-932",item:"Ceramic mug set",type:"E-commerce parcel",date:"Today, 9:56 AM",amount:"৳ 1,850",status:"Delivered",requiredServices:["Recipient digital signature"]},
      {id:"PP-28488",name:"Oliver Chen",initials:"OC",phone:"+880 1911-•••-744",item:"Return — linen shirt",type:"Return pickup",date:"Today, 9:31 AM",amount:"৳ 0",status:"Pickup scheduled"},
      {id:"PP-28487",name:"Fatima Noor",initials:"FN",phone:"+880 1555-•••-610",item:"Wireless earbuds",type:"E-commerce parcel",date:"Today, 9:12 AM",amount:"৳ 3,200",status:"Processing"}
    ];
    const pageData = {
      "Orders": {description:"Manage ecommerce orders and domestic deliveries from one place.",columns:["Order ID","Customer","Item / service","Created","Amount","Status"],rows:sampleOrders},
      "Shipments": {description:"Track every parcel and document moving through your delivery network.",columns:["Tracking ID","Recipient","Shipment","Destination","Last update","Status"],rows:[
        ["PP-28491","Sophie Williams","E-commerce parcel","Chattogram","Out for delivery · 10:42 AM","In transit"],["PP-28490","Daniel Kim","Document delivery","Dhaka","Picked up · 10:18 AM","Picked up"],["PP-28489","Amina Rahman","E-commerce parcel","Sylhet","Delivered · 9:56 AM","Delivered"],["PP-28486","Noah Patel","Domestic parcel","Rajshahi","At sorting hub · 9:24 AM","In transit"],["PP-28484","Maya Islam","Document delivery","Khulna","Delivery attempt · 8:45 AM","Pickup scheduled"]],
        stats:[["In transit","18"],["Delivered today","42"],["Needs attention","3"]]},
      "Pickup requests": {description:"Schedule, review, and manage parcel and document collections.",columns:["Request ID","Merchant contact","Pickup location","Packages","Requested","Status"],rows:[
        ["PU-1042","Sophie Williams","Gulshan 2, Dhaka","4 parcels","Today, 11:30 AM","Pickup scheduled"],["PU-1041","Daniel Kim","Banani, Dhaka","2 documents","Today, 10:30 AM","Picked up"],["PU-1040","Amina Rahman","Dhanmondi, Dhaka","8 parcels","Today, 9:45 AM","Picked up"],["PU-1039","Oliver Chen","Uttara, Dhaka","1 return","Today, 1:00 PM","Processing"],["PU-1038","Fatima Noor","Mirpur 10, Dhaka","3 parcels","Yesterday","Delivered"]],
        stats:[["Awaiting pickup","6"],["Scheduled today","12"],["Collected today","28"]]},
      "Customers": {description:"Your customer directory, delivery history, and contact details.",columns:["Customer","Phone","Orders","Lifetime value","Last order","Status"],rows:[
        ["Sophie Williams","+880 1712-•••-481","12","৳ 18,450","Today, 10:42 AM","Active"],["Amina Rahman","+880 1610-•••-932","8","৳ 12,300","Today, 9:56 AM","Active"],["Daniel Kim","+880 1819-•••-205","6","৳ 9,180","Today, 10:18 AM","Active"],["Oliver Chen","+880 1911-•••-744","4","৳ 5,600","Yesterday","Active"],["Fatima Noor","+880 1555-•••-610","3","৳ 4,250","Yesterday","Active"]],
        stats:[["Total customers","1,284"],["New this month","86"],["Repeat customers","64%"]]},
      "Products": {description:"Keep your catalogue and shipping-ready inventory up to date.",columns:["Product","SKU","Category","Price","Stock","Status"],rows:[
        ["Everyday Tote Bag","NS-TOT-01","Accessories","৳ 2,450","38","Active"],["Ceramic Mug Set","NS-HOM-12","Home & living","৳ 1,850","12","Active"],["Wireless Earbuds","NS-TEC-08","Electronics","৳ 3,200","4","Active"],["Linen Shirt — Sand","NS-APP-04","Apparel","৳ 2,900","0","Inactive"],["Gift Box — Small","NS-GFT-02","Packaging","৳ 350","120","Active"]],
        stats:[["Active products","48"],["Low stock","4"],["Out of stock","2"]]},
      "Payments": {description:"Review cash on delivery collections, fees, and merchant payouts.",columns:["Transaction","Order","Method","Date","Amount","Status"],rows:[
        ["TX-99284","PP-28489","Cash on delivery","Today, 9:56 AM","৳ 1,850","Paid"],["TX-99283","PP-28491","Cash on delivery","Today, 9:30 AM","৳ 2,450","Processing"],["TX-99282","PP-28487","Cash on delivery","Today, 9:12 AM","৳ 3,200","Pending"],["TX-99276","PP-28480","Merchant payout","Yesterday","৳ 24,680","Paid"],["TX-99265","PP-28464","Cash on delivery","Yesterday","৳ 980","Paid"]],
        stats:[["Available balance","৳ 42,850"],["Pending COD","৳ 18,420"],["Next payout","Oct 16"]]},
      "Reports": {description:"A snapshot of store sales, delivery performance, and customer trends.",columns:["Report","Period","Generated","Format","Owner","Status"],rows:[
        ["Weekly sales summary","Oct 7 – Oct 13","Today, 9:00 AM","CSV · PDF","Alex Morgan","Delivered"],["Delivery performance","Oct 1 – Oct 13","Yesterday, 4:30 PM","CSV","Alex Morgan","Delivered"],["COD reconciliation","Oct 1 – Oct 13","Yesterday, 2:15 PM","CSV · PDF","Alex Morgan","Processing"],["Top products","September 2026","Oct 1, 10:00 AM","CSV","Alex Morgan","Delivered"]],
        stats:[["Gross sales","৳ 3,84,250"],["Orders this month","842"],["Delivery success","96.8%"]]},
      "Settings": {description:"Configure your store, delivery preferences, team, and notifications.",columns:["Setting","Details","Updated",""],rows:[
        ["Store profile","Northstar Store · Dhaka, Bangladesh","Oct 10, 2026","Manage"],["Delivery preferences","Same-day & next-day delivery enabled","Oct 9, 2026","Manage"],["Notification settings","Email and SMS alerts enabled","Oct 8, 2026","Manage"],["Team & permissions","3 team members · 2 roles","Oct 2, 2026","Manage"],["API & integrations","Shopify connected","Sep 28, 2026","Manage"]],
        stats:[["Store status","Active"],["Team members","3"],["Connected apps","2"]]}
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
        <div><p class="eyebrow">Wednesday, October 14, 2026</p><h1>Good morning, Alex <span style="font-size:20px">☀️</span></h1><p class="subtitle">Here's what's happening with your store and deliveries today.</p></div>
        <div class="heading-actions"><button class="button date-button" data-toast="Date range: October 14, 2026">${icon("calendar")} Today, Oct 14 <span style="color:#a0a9b5">⌄</span></button><button class="button button-primary" id="createOrder">${icon("plus")} Create order</button></div>
      </div>
      <div class="metrics">
        ${metricCard("Total orders","284","orders","vs. last month","↑ 12.8%")}
        ${metricCard("In transit","18","truck","on the way to customers","")}
        ${metricCard("Gross sales","৳ 84,250","wallet","vs. last month","↑ 8.2%")}
        ${metricCard("Delivery success","96.8%","chart","vs. last month","↑ 2.4%")}
      </div>
      <div class="dashboard-grid">
        <section class="panel">
          <div class="panel-heading"><div><h2 class="panel-title">Orders & sales</h2><p class="panel-subtitle">Track your store performance over time</p></div><select class="select-small" id="chartPeriod" aria-label="Chart period"><option>Last 7 days</option><option>Last 30 days</option><option>This year</option></select></div>
          <div class="chart-legend"><span class="legend-item"><i class="legend-dot"></i> Orders</span><span class="legend-item"><i class="legend-dot gray"></i> Previous period</span></div>
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
          <div class="panel-heading"><div><h2 class="panel-title">Delivery overview</h2><p class="panel-subtitle">Today's shipment status</p></div><button class="button button-sm" data-page-link="Shipments">View all</button></div>
          <div class="dispatch-summary"><div><strong>68</strong><span>Total shipments</span></div><i class="divider"></i><div><strong>52</strong><span>Completed today</span></div><i class="divider"></i><div><strong>4</strong><span>Need attention</span></div></div>
          <div class="progress-label"><span>Delivery completion</span><strong>76%</strong></div><div class="progress-track"><div class="progress-fill"></div></div>
          <div class="dispatch-list"><div class="dispatch-row"><span class="dispatch-label"><i style="background:#3766e8"></i>In transit</span><strong>18</strong></div><div class="dispatch-row"><span class="dispatch-label"><i style="background:#16845b"></i>Delivered</span><strong>42</strong></div><div class="dispatch-row"><span class="dispatch-label"><i style="background:#d4a13b"></i>Pickup scheduled</span><strong>6</strong></div><div class="dispatch-row"><span class="dispatch-label"><i style="background:#c34d4d"></i>Delivery issue</span><strong>2</strong></div></div>
        </section>
      </div>
      <div class="content-grid">
        <section class="panel table-panel">
          <div class="panel-heading"><div><h2 class="panel-title">Recent orders</h2><p class="panel-subtitle">Your latest orders and delivery updates</p></div><button class="button button-sm" data-page-link="Orders">View all orders</button></div>
          <div class="table-scroll"><table><thead><tr><th>ORDER</th><th>CUSTOMER</th><th>ITEM / SERVICE</th><th>AMOUNT</th><th>STATUS</th><th></th></tr></thead><tbody>${sampleOrders.slice(0,4).map(order=>`<tr><td class="order-id">${order.id}</td><td><div class="customer-cell"><span class="customer-mini">${order.initials}</span><span class="customer-name">${order.name}</span></div></td><td>${order.item}</td><td>${order.amount}</td><td>${statusPill(order.status)}</td><td><button class="row-menu" aria-label="More actions">···</button></td></tr>`).join("")}</tbody></table></div>
        </section>
        <section class="panel">
          <div class="panel-heading"><div><h2 class="panel-title">Recent activity</h2><p class="panel-subtitle">Latest updates from your workspace</p></div><button class="button button-sm" data-toast="You're all caught up.">See all</button></div>
          <div class="activity-list">
            <div class="activity-item"><span class="activity-icon">${icon("truck")}</span><div class="activity-copy"><strong>PP-28489</strong> was delivered to Amina Rahman<small>12 minutes ago · Sylhet</small></div></div>
            <div class="activity-item"><span class="activity-icon">${icon("box")}</span><div class="activity-copy"><strong>New order</strong> from Sophie Williams<small>34 minutes ago · ৳ 2,450</small></div></div>
            <div class="activity-item"><span class="activity-icon">${icon("wallet")}</span><div class="activity-copy"><strong>Payout completed</strong> — ৳ 24,680<small>Yesterday at 4:30 PM</small></div></div>
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
      return `<div class="page-heading"><div><p class="eyebrow">Merchant workspace</p><h1>${page}</h1><p class="subtitle">${data.description}</p></div><div class="heading-actions">${page==="Orders" ? `<button class="button button-primary" id="createOrder">${icon("plus")} Create order</button>` : `<button class="button" id="exportButton">${icon("download")} Export</button>`}</div></div>
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
    document.querySelector(".workspace-switch").addEventListener("click",()=>showToast("You're viewing the Northstar Store workspace."));
    document.querySelector(".user-profile").addEventListener("click",()=>showToast("Profile and account settings opened."));
    renderPage("Overview");
