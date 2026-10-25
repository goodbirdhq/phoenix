import { Flame } from "lucide-react";
import { Link } from "@tanstack/react-router";

export function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Phoenix Cloud home">
      <span className="brand-mark">
        <Flame size={21} />
      </span>
      <span>
        Phoenix <span className="brand-cloud">Cloud</span>
      </span>
    </Link>
  );
}
