import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

/** One cache for the panel. Refusals (4xx) aren't retried; network blips are, twice. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});
