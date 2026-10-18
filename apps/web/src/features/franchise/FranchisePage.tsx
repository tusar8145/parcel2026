import LegacyScripts from "@/shared/LegacyScripts";
import FranchiseApp from "./app/FranchiseApp";
import { scripts } from "./scripts";

export default function FranchisePage() {
  return (
    <>
      <FranchiseApp />
      <LegacyScripts scripts={scripts} />
    </>
  );
}
