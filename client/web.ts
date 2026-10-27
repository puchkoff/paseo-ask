import { Platform } from "react-native";

// The only DOM access in the plugin; other platforms keep the fallback and save nothing.
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };

export function load<T extends object>(key: string, fallback: T): T {
  if (Platform.OS !== "web") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: object): void {
  if (Platform.OS !== "web") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the setting just isn't remembered.
  }
}
