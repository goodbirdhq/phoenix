import { SearchIcon } from "lucide-react";

export function EnvironmentTableSearch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border px-2 py-1 focus-within:ring-2 focus-within:ring-ring">
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-36 min-w-0 bg-transparent text-xs outline-none"
      />
    </label>
  );
}
