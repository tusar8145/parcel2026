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

// Smooth opening and closing across Courier Operations (app/motion.css; dialogs fade out before they go).
document.documentElement.classList.add("df-motion");

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
