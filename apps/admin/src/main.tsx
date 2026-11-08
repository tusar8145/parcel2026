import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@panel/lib/auth";
import { queryClient } from "@panel/lib/queryClient";
import App from "@/app/App";
import "@panel/styles.css";

// Opening this panel ends the "classic panel" choice (next.config.ts sends /super-admin here otherwise).
document.cookie = "df-classic-admin=; path=/; max-age=0";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/admin">
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
