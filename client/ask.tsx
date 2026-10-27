import { type PluginPopoverProps, useRpc } from "@getpaseo/plugin/client";
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ask, type Turn } from "../shared/ask.ts";

// Module-level so the thread survives closing and reopening the popover.
let saved: Turn[] = [];

export function AskWindow({ theme, layout, close }: PluginPopoverProps) {
  const askRpc = useRpc(ask);
  const [turns, setTurnsState] = useState<Turn[]>(saved);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);

  const setTurns = (next: Turn[]) => {
    saved = next;
    setTurnsState(next);
  };

  async function send() {
    const text = draft.trim();
    if (!text || pending) return;
    const next: Turn[] = [...turns, { role: "user", text }];
    setTurns(next);
    setDraft("");
    setError(null);
    setPending(true);
    try {
      const { answer } = await askRpc({ turns: next });
      setTurns([...next, { role: "assistant", text: answer }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const c = theme.colors;
  const s = useMemo(
    () => ({
      root: {
        width: layout.compact ? undefined : 440,
        height: layout.compact ? 480 : 520,
        backgroundColor: c.surface0,
        padding: 12,
        gap: 8,
      },
      header: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
      title: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
      link: { color: c.foregroundMuted, fontSize: 13 },
      list: { flex: 1 },
      listContent: { gap: 8, paddingBottom: 4 },
      bubble: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, maxWidth: "90%" as const },
      user: { alignSelf: "flex-end" as const, backgroundColor: c.accent },
      userText: { color: c.accentForeground, fontSize: 14 },
      bot: { alignSelf: "flex-start" as const, backgroundColor: c.surface2 },
      botText: { color: c.foreground, fontSize: 14 },
      hint: { color: c.foregroundMuted, fontSize: 13 },
      error: { color: c.statusDanger, fontSize: 13 },
      row: { flexDirection: "row" as const, gap: 8, alignItems: "flex-end" as const },
      input: {
        flex: 1,
        minHeight: 38,
        maxHeight: 120,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: c.foreground,
        fontSize: 14,
      },
      send: { backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, opacity: pending ? 0.5 : 1 },
      sendText: { color: c.accentForeground, fontSize: 14, fontWeight: "600" as const },
    }),
    [c, layout.compact, pending],
  );

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>Ask</Text>
        <View style={{ flexDirection: "row", gap: 14 }}>
          {turns.length > 0 && !pending ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear conversation" onPress={() => { setTurns([]); setError(null); }}>
              <Text style={s.link}>Clear</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={close}>
            <Text style={s.link}>Close</Text>
          </Pressable>
        </View>
      </View>
      <ScrollView ref={scroll} style={s.list} contentContainerStyle={s.listContent} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {turns.length === 0 ? <Text style={s.hint}>Ask anything. Enter sends, Shift+Enter adds a line.</Text> : null}
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
