"use client";

import { useEffect } from "react";
import { startBranding } from "./runtime";

/** The company's name, logo, tab icon and contact details on every page (Super admin › Branding & company). */
export default function BrandingRuntime() {
  useEffect(() => startBranding(), []);
  return null;
}
