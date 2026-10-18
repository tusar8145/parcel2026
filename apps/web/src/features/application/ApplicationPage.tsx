import LegacyScripts from "@/shared/LegacyScripts";
import ApplicationApp from "./ApplicationApp";
import { scripts } from "./scripts";

export default function ApplicationPage() {
  return (
    <>
      <ApplicationApp />
      <LegacyScripts scripts={scripts} />
    </>
  );
}
