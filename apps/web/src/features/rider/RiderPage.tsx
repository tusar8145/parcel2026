import LegacyScripts from "@/shared/LegacyScripts";
import IconSprite from "./components/IconSprite";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import Toast from "./components/Toast";
import ActionModal from "./components/ActionModal";
import { scripts } from "./scripts";

export default function RiderPage() {
  return (
    <>
      {" "}
      <IconSprite /> <Sidebar />{" "}
      <main className="main">
        {" "}
        <Topbar /> <section className="content" id="mainContent" />{" "}
      </main>{" "}
      <Toast /> <ActionModal /> <LegacyScripts scripts={scripts} />
    </>
  );
}
