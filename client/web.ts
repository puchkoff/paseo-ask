import { Platform } from "react-native";

// The only DOM access in the plugin; on native every export is a no-op or returns the fallback.
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
declare const document: { getElementById(id: string): { style: Record<string, string> } | null };
type PointerLike = { clientX: number; clientY: number };
declare const window: {
  addEventListener(type: "pointermove" | "pointerup", fn: (e: PointerLike) => void): void;
  removeEventListener(type: "pointermove" | "pointerup", fn: (e: PointerLike) => void): void;
};

const isWeb = Platform.OS === "web";

export function load<T extends object>(key: string, fallback: T): T {
  if (!isWeb) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: object): void {
  if (!isWeb) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the setting just isn't remembered.
  }
}

// Scales an element's text; host Markdown takes no font size.
export function setZoom(nativeID: string, factor: number): void {
  const el = isWeb ? document.getElementById(nativeID) : null;
  if (el) el.style.zoom = String(factor);
}

// Follows the mouse on window, not on the element: RN responder moves get lost inside a Modal on desktop.
export function followPointer(start: PointerLike, onMove: (dx: number, dy: number) => void, onEnd: () => void): void {
  if (!isWeb) return;
  const move = (e: PointerLike) => onMove(e.clientX - start.clientX, e.clientY - start.clientY);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    onEnd();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
