import { useState } from "react";
import { ListFilterIcon, PlusIcon, SearchIcon, WrenchIcon } from "lucide-react";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuCheckboxItem,
  MenuSeparator,
  MenuItem,
} from "../ui/menu";
import { cn } from "../../lib/utils";
import {
  activeSidebarFilterCount,
  EMPTY_SIDEBAR_FILTERS,
  type SidebarFilters,
} from "./SidebarFilters.logic";

export interface SidebarFilterOption {
  key: string;
  label: string;
  description?: string;
  onEdit?: () => void;
}
export interface SidebarFilterCategory {
  key: keyof SidebarFilters;
  label: string;
  allLabel: string;
  options: readonly SidebarFilterOption[];
}
const popupClass = "w-[300px] max-w-[calc(100vw-24px)]";

function FilterCategory({
  category,
  selected,
  onChange,
  onNewProject,
  onClose,
}: {
  category: SidebarFilterCategory;
  selected: readonly string[];
  onChange: (keys: readonly string[]) => void;
  onNewProject: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const options = category.options.filter((option) =>
    `${option.label} ${option.description ?? ""}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const summary =
    selected.length === 0
      ? "All"
      : selected.length === 1
        ? (category.options.find((option) => option.key === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;
  return (
    <MenuSub
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <MenuSubTrigger className="h-8 [&>svg]:ms-0 [&>svg]:size-3.5">
        <span className="min-w-0 flex-1">{category.label}</span>
        <span
          className={cn(
            "max-w-[112px] truncate text-xs text-muted-foreground",
            selected.length > 0 && "text-foreground",
          )}
        >
          {summary}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup variant="solid" className={popupClass} sideOffset={4}>
        <MenuCheckboxItem
          className="h-8"
          checked={selected.length === 0}
          onCheckedChange={() => onChange([])}
          closeOnClick={false}
        >
          {category.allLabel}
        </MenuCheckboxItem>
        <MenuSeparator className="mx-0" />
        {category.key !== "statuses" ? (
          <div className="flex h-8 items-center gap-2 px-2">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              aria-label={`Search ${category.label.toLowerCase()}`}
              placeholder={`Search ${category.label.toLowerCase()}…`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== "Escape" &&
                  event.key !== "Tab" &&
                  event.key !== "ArrowDown" &&
                  event.key !== "ArrowUp"
                )
                  event.stopPropagation();
              }}
            />
          </div>
        ) : null}
        {options.map((option, index) => (
          <div key={option.key}>
            {category.key === "statuses" && index === 7 ? <MenuSeparator className="mx-0" /> : null}
            <div className="flex items-center">
              <MenuCheckboxItem
                className={cn("min-w-0 flex-1", option.description ? "h-12" : "h-8")}
                checked={selected.includes(option.key)}
                closeOnClick={false}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...selected, option.key]
                      : selected.filter((key) => key !== option.key),
                  )
                }
              >
                <span className="block truncate">{option.label}</span>
                {option.description ? (
                  <span className="block truncate text-xs leading-4 text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </MenuCheckboxItem>
              {option.onEdit ? (
                <MenuItem
                  aria-label={`Project settings for ${option.label}${option.description ? ` (${option.description})` : ""}`}
                  className="size-8 shrink-0 justify-center"
                  onClick={() => {
                    onClose();
                    option.onEdit?.();
                  }}
                >
                  <WrenchIcon className="size-3.5" />
                </MenuItem>
              ) : null}
            </div>
          </div>
        ))}
        {options.length === 0 ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">No matches</div>
        ) : null}
        {category.key === "projects" ? (
          <>
            <MenuSeparator className="mx-0" />
            <MenuItem
              className="h-8"
              onClick={() => {
                onClose();
                onNewProject();
              }}
            >
              <PlusIcon className="size-4" />
              New project
            </MenuItem>
          </>
        ) : null}
      </MenuSubPopup>
    </MenuSub>
  );
}

export function SidebarFiltersMenu({
  filters,
  open,
  onOpenChange,
  onChange,
  categories,
  onNewProject,
}: {
  filters: SidebarFilters;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (filters: SidebarFilters) => void;
  categories: readonly SidebarFilterCategory[];
  onNewProject: () => void;
}) {
  const count = activeSidebarFilterCount(filters);
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={
          // A plain button: the filter trigger's coarse-pointer hit area and
          // active tint are its own look, not a SidebarMenuButton variant.
          <button
            type="button"
            aria-label={count ? `Filter threads, ${count} active categories` : "Filter threads"}
            className={cn(
              "relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center overflow-visible rounded-md text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 data-popup-open:bg-sidebar-row-hover pointer-coarse:size-11 pointer-coarse:bg-transparent pointer-coarse:hover:bg-transparent pointer-coarse:data-popup-open:bg-transparent pointer-coarse:before:absolute pointer-coarse:before:size-8 pointer-coarse:before:rounded-md pointer-coarse:hover:before:bg-sidebar-row-hover pointer-coarse:data-popup-open:before:bg-sidebar-row-hover pointer-coarse:[&>svg]:relative",
              count > 0 && "bg-info/10 text-info-foreground pointer-coarse:before:bg-info/10",
            )}
          />
        }
      >
        <ListFilterIcon className="size-4" strokeWidth={1.7} />
        {count > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 pointer-coarse:right-1 pointer-coarse:top-1 flex size-3.5 items-center justify-center rounded-full bg-info text-4xs font-semibold text-white">
            {count}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup
        align="end"
        collisionPadding={16}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        variant="solid"
        className={popupClass}
      >
        {categories.map((category) => (
          <FilterCategory
            key={category.key}
            category={category}
            selected={filters[category.key]}
            onChange={(keys) => onChange({ ...filters, [category.key]: keys })}
            onNewProject={onNewProject}
            onClose={() => onOpenChange(false)}
          />
        ))}
        <MenuSeparator className="mx-0" />
        <MenuItem
          className="h-8"
          disabled={count === 0}
          closeOnClick={false}
          onClick={() => onChange(EMPTY_SIDEBAR_FILTERS)}
        >
          Clear filters
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
