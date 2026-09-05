import { create } from "zustand";
import { EMPTY_SIDEBAR_FILTERS, type SidebarFilters } from "./SidebarFilters.logic";

// Client-session state survives Settings replacing the thread sidebar, without
// persisting environment-local selections across a fresh client startup.
export const useSidebarFiltersStore = create<{
  filters: SidebarFilters;
  setFilters: (filters: SidebarFilters) => void;
}>((set) => ({ filters: EMPTY_SIDEBAR_FILTERS, setFilters: (filters) => set({ filters }) }));
