import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ThemeProvider } from "./hooks/use-theme";
import { CompanyProvider } from "./hooks/use-company";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <CompanyProvider>
          <App />
        </CompanyProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
