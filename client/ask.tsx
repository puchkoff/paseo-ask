import { type PluginHostProps, useAgent, useRpc } from "@getpaseo/plugin/client";
import { Markdown, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Image, Platform, Pressable, type ScrollView as NativeScrollView, Text, View } from "react-native";
import { type AskFile, askPoll, askStart, askUpload, claudeEffortOf, claudeModelOf, MAX_FILE_BASE64, type Turn } from "../shared/ask.ts";
import { mixHex } from "../shared/color.ts";
import { load, onPasteFiles, type PickedFile, pickFiles, save, setZoom } from "./web.ts";
import { FloatingWindow } from "./window.tsx";

// Module-level so the thread, settings and a running request survive closing the window,
// and the composer pill can open it.
// Font size is also saved per app (web/desktop only); the thread lasts until reload.
// agentId: the agent whose composer pill opened the window; Ask uses its model.
type State = { open: boolean; agentId: string | null; turns: Turn[]; pending: boolean; error: string | null; fontSize: number };
// Host Markdown draws at the app's content size (15) and takes no font size, so the thread is
// zoomed by fontSize / BASE (desktop only). fontSize = BASE matches the main chat exactly.
const BASE = 15;
// v2: v1 saved the old default of 20.
const PREFS_KEY = "paseo-ask:prefs-v2";
const prefs = load(PREFS_KEY, { fontSize: BASE });
let state: State = { open: false, agentId: null, turns: [], pending: false, error: null, ...prefs };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  if ("fontSize" in patch) save(PREFS_KEY, { fontSize: state.fontSize });
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const useAskState = () => useSyncExternalStore(subscribe, () => state);

export const setAskOpen = (open: boolean) => set({ open });
export const openAsk = (agentId: string | null) => set({ open: true, agentId });

const FONT_MIN = 12;
const FONT_MAX = 40;
const THREAD_ID = "paseo-ask-thread";
const POLL_MS = 500;

// Mount once, outside any Pressable: modals are React portals, so their events bubble up the React tree.
// Own window everywhere: the host Modal's header is too tall on phones and its desktop size is fixed.
export function AskModal(props: PluginHostProps) {
  const { open } = useAskState();
  return open ? (
    <FloatingWindow theme={props.theme} compact={props.layout.compact} title="Ask" onClose={() => setAskOpen(false)}>
      <AskBody {...props} />
    </FloatingWindow>
  ) : null;
}

// Image previews by daemon path; the daemon only gets bytes once, at upload.
const previews = new Map<string, string>();

function AskBody({ theme }: PluginHostProps) {
  const start = useRpc(askStart);
  const poll = useRpc(askPoll);
  const upload = useRpc(askUpload);
  const [files, setFiles] = useState<AskFile[]>([]);
  const [uploading, setUploading] = useState(0);

  async function attach(picked: Promise<PickedFile[]>) {
    try {
      const list = await picked;
      setUploading((n) => n + list.length);
      for (const f of list) {
        try {
          if (f.data.length > MAX_FILE_BASE64) throw new Error(`${f.name} is over 20 MB`);
          const saved = await upload({ name: f.name, data: f.data });
          if (f.type.startsWith("image/")) previews.set(saved.path, f.dataUrl);
          setFiles((prev) => [...prev, saved]);
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
        } finally {
          setUploading((n) => n - 1);
        }
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  }
  useEffect(() => onPasteFiles((picked) => void attach(picked)), []);
  const { turns, pending, error, fontSize, agentId } = useAskState();
  // Same model as the agent's main window; non-Claude agents and the sidebar fall back to the CLI default.
  const agent = useAgent(agentId ?? "", (a) => ({ model: claudeModelOf(a), effort: claudeEffortOf(a) }));
  const model = agent?.model;
  const effort = agent?.effort;
  const [draft, setDraft] = useState("");
  const scroll = useRef<NativeScrollView>(null);
  useEffect(() => setZoom(THREAD_ID, fontSize / BASE), [fontSize]);

  async function send() {
    const text = draft.trim();
    if ((!text && !files.length) || state.pending || uploading) return;
    const next: Turn[] = [...state.turns, { role: "user", text, ...(files.length ? { files } : {}) }];
    set({ turns: next, pending: true, error: null });
    setDraft("");
    setFiles([]);
    try {
      const { jobId } = await start({ turns: next, model, effort });
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
  // Toolbar stays fixed size; only the conversation follows A−/A+.
  const small = 14;
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
      listContent: { gap: 16, paddingBottom: 4 },
      // Same look as Paseo's main chat: user turns in a surface3 bubble, answers unboxed, both host Markdown.
      user: {
        alignSelf: "flex-end" as const,
        maxWidth: "85%" as const,
        backgroundColor: mixHex(c.surface2, c.foreground, 0.09),
        borderRadius: 16,
        borderTopRightRadius: 2,
        padding: 16,
      },
      bot: { alignSelf: "stretch" as const },
      files: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
      fileChip: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 4, backgroundColor: c.surface1 },
      thumb: { width: 120, height: 80, borderRadius: 6 },
      fileName: { color: c.foreground, fontSize: 13, maxWidth: 220 },
      attach: { paddingHorizontal: 6, paddingVertical: 10 },
      attachText: { fontSize: 18 },
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
      send: { backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 11, opacity: pending ? 0.5 : 1 },
      sendText: { color: c.accentForeground, fontSize: 15, fontWeight: "600" as const },
    }),
    [c, pending, fontSize],
  );

  const fileChip = (f: AskFile, onRemove?: () => void) => {
    const preview = previews.get(f.path);
    return (
      <View key={f.path} style={s.fileChip}>
        {preview ? <Image source={{ uri: preview }} style={s.thumb} resizeMode="contain" accessibilityLabel={f.name} /> : <Text style={s.fileName} numberOfLines={1}>📄 {f.name}</Text>}
        {onRemove ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${f.name}`} onPress={onRemove} hitSlop={6}>
            <Text style={s.fileName}>✕</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  const chip = (label: string, on: boolean, onPress: () => void, a11y: string, disabled = false) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ selected: on, disabled }} disabled={disabled} onPress={onPress} style={[s.chip, on ? s.chipOn : null, disabled ? { opacity: 0.4 } : null]}>
      <Text style={on ? s.chipTextOn : s.chipText}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={s.root}>
      <View style={s.bar}>
        <Text style={s.link}>{[model ?? "default model", effort].filter(Boolean).join(" · ")}</Text>
        <View style={s.spacer} />
        {chip("A−", false, () => set({ fontSize: fontSize - 1 }), "Smaller text", fontSize <= FONT_MIN)}
        {chip("A+", false, () => set({ fontSize: fontSize + 1 }), "Bigger text", fontSize >= FONT_MAX)}
        {turns.length > 0 && !pending ? chip("Clear", false, () => set({ turns: [], error: null }), "Clear conversation") : null}
      </View>
      <ScrollView ref={scroll} style={s.list} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        <View nativeID={THREAD_ID} style={s.listContent}>
        {turns.map((t, i) => (
          <View key={i} style={t.role === "user" ? s.user : s.bot}>
            {t.text ? <Markdown>{t.text}</Markdown> : null}
            {t.files?.length ? <View style={s.files}>{t.files.map((f) => fileChip(f))}</View> : null}
          </View>
        ))}
        {pending ? <ActivityIndicator color={c.foregroundMuted} style={{ alignSelf: "flex-start" }} /> : null}
        {error ? <Text style={s.error}>{error}</Text> : null}
        </View>
      </ScrollView>
      {files.length || uploading ? (
        <View style={s.files}>
          {files.map((f) => fileChip(f, () => setFiles((prev) => prev.filter((x) => x.path !== f.path))))}
          {uploading ? <ActivityIndicator color={c.foregroundMuted} /> : null}
        </View>
      ) : null}
      <View style={s.row}>
        {Platform.OS === "web" ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Attach files" onPress={() => pickFiles((picked) => void attach(picked))} style={s.attach}>
            <Text style={s.attachText}>📎</Text>
          </Pressable>
        ) : null}
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
