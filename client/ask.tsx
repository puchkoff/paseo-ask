import { type PluginHostProps, useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, type ScrollView as NativeScrollView, Text, View } from "react-native";
import { askPoll, askStart, MODELS, type Model, type Turn } from "../shared/ask.ts";

// Module-level so the thread, settings and a running request survive closing the window,
// and the composer pill can open it.
// shortcut: lost on app reload, persist via plugin settings if that matters.
type State = { open: boolean; turns: Turn[]; pending: boolean; error: string | null; fontSize: number; model: Model };
let state: State = { open: false, turns: [], pending: false, error: null, fontSize: 17, model: "default" };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const useAskState = () => useSyncExternalStore(subscribe, () => state);

export const setAskOpen = (open: boolean) => set({ open });

const FONT_MIN = 12;
const FONT_MAX = 32;
const POLL_MS = 1500;

// Mount once, outside any Pressable: the desktop modal is a React portal, so its events bubble up the React tree.
export function AskModal(props: PluginHostProps) {
  const { open } = useAskState();
  return (
    <Modal title="Ask" open={open} onOpenChange={setAskOpen}>
      <Modal.Content scrollable={false} contentContainerStyle={{ flex: 1, padding: 16, gap: 10 }}>
        {open ? <AskBody {...props} /> : null}
      </Modal.Content>
    </Modal>
  );
}

function AskBody({ theme }: PluginHostProps) {
  const start = useRpc(askStart);
  const poll = useRpc(askPoll);
  const { turns, pending, error, fontSize, model } = useAskState();
  const [draft, setDraft] = useState("");
  const scroll = useRef<NativeScrollView>(null);

  async function send() {
    const text = draft.trim();
    if (!text || state.pending) return;
    const next: Turn[] = [...state.turns, { role: "user", text }];
    set({ turns: next, pending: true, error: null });
    setDraft("");
    try {
      const { jobId } = await start({ turns: next, model: state.model });
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const job = await poll({ jobId });
        if (job.status === "running") continue;
        if (job.status === "error") throw new Error(job.error ?? "failed");
        set({ turns: [...next, { role: "assistant", text: job.answer ?? "" }] });
        break;
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ pending: false });
    }
  }

  const c = theme.colors;
  const small = Math.max(12, fontSize - 3);
  const s = useMemo(
    () => ({
      root: { flex: 1, gap: 10 },
      bar: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6 },
      chip: { borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
      chipOn: { backgroundColor: c.accent, borderColor: c.accent },
      chipText: { color: c.foreground, fontSize: small },
      chipTextOn: { color: c.accentForeground, fontSize: small },
      spacer: { flex: 1 },
      link: { color: c.foregroundMuted, fontSize: small },
      list: { flex: 1 },
      listContent: { gap: 10, paddingBottom: 4 },
      bubble: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, maxWidth: "92%" as const },
      user: { alignSelf: "flex-end" as const, backgroundColor: c.accent },
      userText: { color: c.accentForeground, fontSize, lineHeight: Math.round(fontSize * 1.4) },
      bot: { alignSelf: "flex-start" as const, backgroundColor: c.surface2 },
      botText: { color: c.foreground, fontSize, lineHeight: Math.round(fontSize * 1.4) },
      hint: { color: c.foregroundMuted, fontSize: small },
      error: { color: c.statusDanger, fontSize: small },
      row: { flexDirection: "row" as const, gap: 8, alignItems: "flex-end" as const },
      input: {
        flex: 1,
        minHeight: 44,
        maxHeight: 160,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: c.foreground,
        fontSize,
      },
      send: { backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12, opacity: pending ? 0.5 : 1 },
      sendText: { color: c.accentForeground, fontSize, fontWeight: "600" as const },
    }),
    [c, pending, fontSize, small],
  );

  const chip = (label: string, on: boolean, onPress: () => void, a11y: string, disabled = false) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ selected: on, disabled }} disabled={disabled} onPress={onPress} style={[s.chip, on ? s.chipOn : null, disabled ? { opacity: 0.4 } : null]}>
      <Text style={on ? s.chipTextOn : s.chipText}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={s.root}>
      <View style={s.bar}>
        {MODELS.map((m) => chip(m, m === model, () => set({ model: m }), `Model ${m}`))}
        <View style={s.spacer} />
        {chip("A−", false, () => set({ fontSize: fontSize - 1 }), "Smaller text", fontSize <= FONT_MIN)}
        {chip("A+", false, () => set({ fontSize: fontSize + 1 }), "Bigger text", fontSize >= FONT_MAX)}
        {turns.length > 0 && !pending ? chip("Clear", false, () => set({ turns: [], error: null }), "Clear conversation") : null}
      </View>
      <ScrollView ref={scroll} style={s.list} contentContainerStyle={s.listContent} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {turns.length === 0 ? <Text style={s.hint}>Ask anything; Claude can search the web and use tools. Enter sends, Shift+Enter adds a line.</Text> : null}
        {turns.map((t, i) => (
          <View key={i} style={[s.bubble, t.role === "user" ? s.user : s.bot]}>
            <Text selectable style={t.role === "user" ? s.userText : s.botText}>{t.text}</Text>
          </View>
        ))}
        {pending ? <ActivityIndicator color={c.foregroundMuted} style={{ alignSelf: "flex-start" }} /> : null}
        {error ? <Text style={s.error}>{error}</Text> : null}
      </ScrollView>
      <View style={s.row}>
        <TextInput
          style={s.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Your question"
          placeholderTextColor={c.foregroundMuted}
          multiline
          autoFocus
          accessibilityLabel="Question"
          onKeyPress={(e) => {
            // Web only: Enter sends, Shift+Enter keeps the newline.
            const ev = e.nativeEvent as { key: string; shiftKey?: boolean };
            if (ev.key === "Enter" && !ev.shiftKey) {
              (e as unknown as { preventDefault?: () => void }).preventDefault?.();
              void send();
            }
          }}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Send question" disabled={pending} onPress={() => void send()} style={s.send}>
          <Text style={s.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}
