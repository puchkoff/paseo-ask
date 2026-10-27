import { Platform } from "react-native";

// The only DOM access in the plugin; on native every export is a no-op or returns the fallback.
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
type DomFile = { name: string; type: string };
type DomInput = { type: string; multiple: boolean; files: DomFile[] | null; onchange: (() => void) | null; click(): void };
type PasteEvent = { clipboardData: { files: DomFile[] } | null; preventDefault(): void };
declare const document: {
  getElementById(id: string): { style: Record<string, string> } | null;
  createElement(tag: "input"): DomInput;
  addEventListener(type: "paste", fn: (e: PasteEvent) => void): void;
  removeEventListener(type: "paste", fn: (e: PasteEvent) => void): void;
};
declare class FileReader {
  result: string | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readAsDataURL(file: DomFile): void;
}
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

// data is base64 without the "data:...;base64," prefix; dataUrl is kept for image previews.
export type PickedFile = { name: string; type: string; data: string; dataUrl: string };

function read(file: DomFile): Promise<PickedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result ?? "";
      resolve({ name: file.name || "pasted", type: file.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1), dataUrl });
    };
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function pickFiles(onFiles: (files: Promise<PickedFile[]>) => void): void {
  if (!isWeb) return;
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = () => onFiles(Promise.all(Array.from(input.files ?? []).map(read)));
  input.click();
}

// Files on the clipboard (a pasted screenshot) are taken; plain text pastes go through untouched.
export function onPasteFiles(onFiles: (files: Promise<PickedFile[]>) => void): () => void {
  if (!isWeb) return () => {};
  const handler = (e: PasteEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    onFiles(Promise.all(files.map(read)));
  };
  document.addEventListener("paste", handler);
  return () => document.removeEventListener("paste", handler);
}
