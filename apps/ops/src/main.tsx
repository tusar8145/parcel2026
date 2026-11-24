import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@panel/lib/auth";
import { queryClient } from "@panel/lib/queryClient";
import App from "@/app/App";
import { arriveFromClassic } from "@/app/links";
import "@panel/styles.css";
import "@/app/motion.css";
import "@panel/skin.css";
import "@/app/theme.css";

// Smooth opening and closing across Courier Operations (app/motion.css; dialogs fade out before they go).
// "df-skin": the panels' design (packages/panel-ui/src/skin.css), in this panel's colours (app/theme.css).
document.documentElement.classList.add("df-motion", "df-skin");

arriveFromClassic();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/ops">
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
