import { Platform } from "react-native";

// The only DOM access in the plugin; on native every export is a no-op or returns the fallback.
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
type DomFile = { name: string; type: string };
type DomInput = { type: string; multiple: boolean; files: DomFile[] | null; onchange: (() => void) | null; click(): void };
type PasteEvent = { clipboardData: { files: DomFile[] } | null; preventDefault(): void };
type DomRect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type DomEl = {
  id: string;
  isContentEditable?: boolean;
  tagName: string;
  parentElement: DomEl | null;
  closest(selector: string): DomEl | null;
  querySelector(selector: string): DomEl | null;
};
type DomButton = {
  textContent: string;
  offsetWidth: number;
  offsetHeight: number;
  style: Record<string, string>;
  setAttribute(name: string, value: string): void;
  addEventListener(type: "mousedown" | "click", fn: (e: { preventDefault(): void; stopPropagation(): void }) => void): void;
  remove(): void;
};
type DomSelection = {
  rangeCount: number;
  isCollapsed: boolean;
  toString(): string;
  getRangeAt(i: number): { getBoundingClientRect(): DomRect; getClientRects(): ArrayLike<DomRect>; commonAncestorContainer: { parentElement: DomEl | null } & Partial<DomEl> };
  removeAllRanges(): void;
};
type DocEvent = "paste" | "mouseup" | "keyup" | "keydown" | "scroll" | "selectionchange";
declare const document: {
  getElementById(id: string): { style: Record<string, string>; scrollHeight: number } | null;
  createElement(tag: "input"): DomInput;
  createElement(tag: "button"): DomButton;
  body: { appendChild(el: DomButton): void; style: Record<string, string> };
  addEventListener(type: DocEvent, fn: (e: any) => void, capture?: boolean): void;
  removeEventListener(type: DocEvent, fn: (e: any) => void, capture?: boolean): void;
};
declare function getSelection(): DomSelection | null;
declare class FileReader {
  result: string | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readAsDataURL(file: DomFile): void;
}
type PointerLike = { clientX: number; clientY: number };
declare const innerWidth: number;
declare const innerHeight: number;
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

// false: storage full or blocked, so the value isn't remembered.
export function save(key: string, value: object): boolean {
  if (!isWeb) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Scales an element's text; host Markdown takes no font size.
export function setZoom(nativeID: string, factor: number): void {
  const el = isWeb ? document.getElementById(nativeID) : null;
  if (el) el.style.zoom = String(factor);
}

// Follows the mouse on window, not on the element: RN responder moves get lost inside a Modal on desktop.
// Text selection is off meanwhile, or dragging past the window's edge selects the page under it.
export function followPointer(start: PointerLike, onMove: (dx: number, dy: number) => void, onEnd: () => void): void {
  if (!isWeb) return;
  const { style } = document.body;
  const prev = style.userSelect;
  style.userSelect = "none";
  getSelection()?.removeAllRanges();
  const move = (e: PointerLike) => onMove(e.clientX - start.clientX, e.clientY - start.clientY);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    style.userSelect = prev;
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

export type SelectionColors = { background: string; foreground: string; border: string };

// A small "Ask" button under text selected anywhere in the app (not in inputs or the Ask window).
// agentId comes from the paseo-ask-pill-<id> marker the composer pill renders in the same agent panel.
export function watchSelection(colors: SelectionColors, onAsk: (text: string, agentId: string | null) => void): () => void {
  if (!isWeb) return () => {};
  let button: DomButton | null = null;
  const hide = () => {
    button?.remove();
    button = null;
  };
  const agentOf = (el: DomEl | null): string | null => {
    for (let n = el; n; n = n.parentElement) {
      const marker = n.querySelector('[id^="paseo-ask-pill-"]');
      if (marker) return marker.id.slice("paseo-ask-pill-".length);
    }
    return null;
  };
  const show = () => {
    hide();
    const sel = getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
    if (!sel || !text || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = (node.tagName ? node : node.parentElement) as DomEl | null;
    if (!el || el.closest("input, textarea, [contenteditable=true], #paseo-ask-window")) return;
    // Last line box = where the selection ends; the button sits just below its right end.
    const rects = Array.from(range.getClientRects()).filter((x) => x.width || x.height);
    const r = rects[rects.length - 1] ?? range.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const agentId = agentOf(el);
    const b = document.createElement("button");
    b.textContent = "Ask";
    b.setAttribute("aria-label", "Ask about the selection");
    Object.assign(b.style, {
      position: "fixed",
      left: `${r.right + 2}px`,
      top: `${r.bottom + 4}px`,
      zIndex: "2147483647",
      padding: "7px 16px",
      borderRadius: "999px",
      border: `1px solid ${colors.border}`,
      background: colors.background,
      color: colors.foreground,
      font: "500 15px system-ui, sans-serif",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      cursor: "pointer",
    });
    // mousedown would clear the selection before click reads it.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      hide();
      getSelection()?.removeAllRanges();
      onAsk(text, agentId);
    });
    document.body.appendChild(b);
    // Keep it on screen: pull it in from the right edge, and put it above the end when there's no room below.
    b.style.left = `${Math.max(8, Math.min(r.right + 2, innerWidth - b.offsetWidth - 8))}px`;
    if (r.bottom + 4 + b.offsetHeight > innerHeight - 8) b.style.top = `${Math.max(8, r.top - b.offsetHeight - 4)}px`;
    button = b;
  };
  // After mouseup the selection is final; defer one tick so a click that clears it is seen.
  const onUp = () => setTimeout(show, 0);
  const onKey = (e: { key: string }) => (e.key === "Escape" ? hide() : e.key.startsWith("Shift") || e.key.startsWith("Arrow") ? setTimeout(show, 0) : undefined);
  const onChange = () => {
    if (getSelection()?.isCollapsed) hide();
  };
  document.addEventListener("mouseup", onUp);
  document.addEventListener("keyup", onKey);
  document.addEventListener("selectionchange", onChange);
  document.addEventListener("scroll", hide, true);
  return () => {
    hide();
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("keyup", onKey);
    document.removeEventListener("selectionchange", onChange);
    document.removeEventListener("scroll", hide, true);
  };
}

// Web textareas don't grow with their text: size to content, capped at max, scrolling beyond it.
// Native multiline inputs grow on their own and only need the maxHeight style.
export function autoGrow(nativeID: string, max: number): void {
  const el = isWeb ? document.getElementById(nativeID) : null;
  if (!el) return;
  el.style.height = "auto";
  const h = Math.min(el.scrollHeight, max);
  el.style.height = `${h}px`;
  el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

// Paseo's own composer settings (Settings → General), so Ask sends like the main window.
// Web keeps them in localStorage; native gets the app defaults.
export type SendSettings = { sendBehavior: "steer" | "interrupt" | "queue"; sendShortcut: "enter" | "mod-enter" };
export function sendSettings(): SendSettings {
  const fallback: SendSettings = { sendBehavior: "steer", sendShortcut: "enter" };
  const s = load<Partial<SendSettings>>("@paseo:app-settings", {});
  return {
    sendBehavior: s.sendBehavior === "queue" || s.sendBehavior === "interrupt" ? s.sendBehavior : fallback.sendBehavior,
    sendShortcut: s.sendShortcut === "mod-enter" ? "mod-enter" : fallback.sendShortcut,
  };
}
