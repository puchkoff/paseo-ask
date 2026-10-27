import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useRef, useState } from "react";
import { Dimensions, type GestureResponderEvent, Modal, Pressable, Text, View, type ViewStyle } from "react-native";
import { load, save } from "./web.ts";

type Rect = { x: number; y: number; w: number; h: number };
const KEY = "paseo-floating-window:rect";
const MIN_W = 360;
const MIN_H = 300;

function initialRect(): Rect {
  const { width, height } = Dimensions.get("window");
  const w = Math.min(760, width - 40);
  const h = Math.min(Math.round(height * 0.8), height - 40);
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

// Keeps the window on screen after the app window shrank since the rect was saved.
function clamp(r: Rect): Rect {
  const { width, height } = Dimensions.get("window");
  const w = Math.max(MIN_W, Math.min(r.w, width));
  const h = Math.max(MIN_H, Math.min(r.h, height));
  return { w, h, x: Math.max(0, Math.min(r.x, width - w)), y: Math.max(0, Math.min(r.y, height - h)) };
}

// Desktop window: drag by the title bar, resize from the bottom-right corner; size and position persist.
export function FloatingWindow({ theme, title, onClose, children }: { theme: PluginTheme; title: string; onClose(): void; children: ReactNode }) {
  const [rect, setRect] = useState<Rect>(() => clamp(load(KEY, initialRect())));
  const drag = useRef<{ px: number; py: number; start: Rect } | null>(null);
  const c = theme.colors;

  const responder = (apply: (start: Rect, dx: number, dy: number) => Rect) => ({
    onStartShouldSetResponder: () => true,
    onResponderGrant: (e: GestureResponderEvent) => {
      drag.current = { px: e.nativeEvent.pageX, py: e.nativeEvent.pageY, start: rect };
    },
    onResponderMove: (e: GestureResponderEvent) => {
      const d = drag.current;
      if (d) setRect(clamp(apply(d.start, e.nativeEvent.pageX - d.px, e.nativeEvent.pageY - d.py)));
    },
    onResponderRelease: () => {
      drag.current = null;
      setRect((r) => (save(KEY, r), r));
    },
  });

  return (
    <Modal transparent visible onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.25)" }}>
        <View
          style={{
            position: "absolute",
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            backgroundColor: c.surface0,
            borderColor: c.border,
            borderWidth: 1,
            borderRadius: 12,
            overflow: "hidden",
            shadowColor: "#000",
            shadowOpacity: 0.3,
            shadowRadius: 24,
          }}
        >
          <View
            {...responder((s, dx, dy) => ({ ...s, x: s.x + dx, y: s.y + dy }))}
            style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.border, cursor: "move" } as unknown as ViewStyle}
          >
            <Text style={{ flex: 1, color: c.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8}>
              <Text style={{ color: c.foregroundMuted, fontSize: 18 }}>✕</Text>
            </Pressable>
          </View>
          <View style={{ flex: 1, padding: 16 }}>{children}</View>
          <View
            {...responder((s, dx, dy) => ({ ...s, w: s.w + dx, h: s.h + dy }))}
            accessibilityLabel="Resize window"
            style={{ position: "absolute", right: 0, bottom: 0, width: 18, height: 18, cursor: "nwse-resize" } as unknown as ViewStyle}
          >
            <Text style={{ color: c.foregroundMuted, fontSize: 12, textAlign: "right" }}>◢</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}
