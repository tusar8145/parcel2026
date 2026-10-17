import LegacyScripts from "@/shared/LegacyScripts";
import IconSprite from "./components/IconSprite";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import Toast from "./components/Toast";
import OrderModal from "./components/OrderModal";
import { scripts } from "./scripts";

export default function BankingMerchantPage() {
  return (
    <>
      {" "}
      <IconSprite />{" "}
      <div className="app">
        {" "}
        <Sidebar />{" "}
        <main className="main">
          {" "}
          <Topbar /> <section className="main-content" id="mainContent" />{" "}
        </main>{" "}
      </div>{" "}
      <Toast /> <OrderModal /> <LegacyScripts scripts={scripts} />
    </>
  );
}
