// Renderer entry. One QueryClient for the window, with defaults chosen for a
// desktop app talking to a single server: no refetch on window focus (a sync is
// explicit here), and one retry, because a failed read is nearly always a
// misconfigured or unreachable server rather than a blip.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { App } from "./App.tsx"
import type { RpBridge } from "../preload/preload.ts"

declare global {
  interface Window {
    readonly rp: RpBridge
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      gcTime: 30 * 60_000,
    },
  },
})

const root = document.getElementById("root")
if (!root) throw new Error("The window template is missing #root.")

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
