import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useRef, useState } from "react";
import { Dimensions, type GestureResponderEvent, Modal, Pressable, Text, View, type ViewStyle } from "react-native";
import { followPointer, load, save } from "./web.ts";

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
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const c = theme.colors;

  // The press only starts the gesture; followPointer tracks it on the window.
  const responder = (apply: (start: Rect, dx: number, dy: number) => Rect) => ({
    onStartShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e: GestureResponderEvent) => {
      const start = rectRef.current;
      followPointer(
        { clientX: e.nativeEvent.pageX, clientY: e.nativeEvent.pageY },
        (dx, dy) => setRect(clamp(apply(start, dx, dy))),
        () => save(KEY, rectRef.current),
      );
    },
  });
  const edge = (style: ViewStyle, cursor: string, apply: (start: Rect, dx: number, dy: number) => Rect) => (
    <View {...responder(apply)} style={[{ position: "absolute" }, style, { cursor } as unknown as ViewStyle]} />
  );

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
          {edge({ top: 0, right: 0, bottom: 0, width: 8 }, "ew-resize", (s, dx) => ({ ...s, w: s.w + dx }))}
          {edge({ left: 0, right: 0, bottom: 0, height: 8 }, "ns-resize", (s, _dx, dy) => ({ ...s, h: s.h + dy }))}
          <View
            {...responder((s, dx, dy) => ({ ...s, w: s.w + dx, h: s.h + dy }))}
            accessibilityLabel="Resize window"
            style={{ position: "absolute", right: 0, bottom: 0, width: 22, height: 22, alignItems: "flex-end", justifyContent: "flex-end", padding: 3, cursor: "nwse-resize" } as unknown as ViewStyle}
          >
            <Text style={{ color: c.foregroundMuted, fontSize: 14, lineHeight: 14 }}>◢</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}
