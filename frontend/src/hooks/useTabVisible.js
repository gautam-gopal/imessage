import { useEffect, useState } from "react";
import { isTabVisible } from "../lib/notifications";

// True while the browser tab is visible; re-renders when that changes.
export function useTabVisible() {
  const [visible, setVisible] = useState(isTabVisible);

  useEffect(() => {
    const onChange = () => setVisible(isTabVisible());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return visible;
}
