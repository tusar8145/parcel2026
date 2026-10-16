import LegacyScripts from "@/shared/LegacyScripts";
import IconSprite from "./components/IconSprite";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import Toast from "./components/Toast";
import ModalBackdrop from "./components/ModalBackdrop";
import { scripts } from "./scripts";

export default function CourierOperationPage() {
  return (
    <>
      {" "}
      <IconSprite /> <Sidebar />{" "}
      <main className="main">
        <Topbar /> <section className="content" id="mainContent" />{" "}
      </main>{" "}
      <Toast /> <ModalBackdrop /> <LegacyScripts scripts={scripts} />
    </>
  );
}
