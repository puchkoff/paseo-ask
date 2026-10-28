import { type PluginHostProps, useAgent, useRpc } from "@getpaseo/plugin/client";
import { Icon, Markdown, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Image, Modal, Platform, Pressable, type TextStyle, type ScrollView as NativeScrollView, Text, View } from "react-native";
import { type AskFile, askPoll, askStart, askSteer, askStop, askUpload, type Step, claudeEffortOf, claudeModelOf, MAX_FILE_BASE64, type Turn } from "../shared/ask.ts";
import { mixHex } from "../shared/color.ts";
import { enterAction, sendAction } from "../shared/send.ts";
import { autoGrow, load, onPasteFiles, sendSettings, type PickedFile, pickFiles, save, setZoom } from "./web.ts";
import { Steps } from "./steps.tsx";
import { FloatingWindow } from "./window.tsx";

// One store for the whole app, on globalThis: each daemon with the plugin runs its own copy of this
// module, and the sidebar row hosting the window switches copies when the main window moves to
// another daemon's workspace. A module-level store would close the window and drop the draft then.
// Font size is also saved per app (web/desktop only); the thread lasts until reload.
// agentId: the agent whose composer pill opened the window; Ask uses its model.
// live: steps of the answer in progress; jobId: its daemon job, for steering.
// unread: an answer arrived while the window was closed (dot on the Ask buttons).
// queued: questions sent with the "queue" behavior, asked one by one after the current answer.
type Queued = { text: string; files: AskFile[] };
type State = {
  queued: Queued[];
  open: boolean;
  agentId: string | null;
  draft: string;
  turns: Turn[];
  live: Step[];
  jobId: string | null;
  pending: boolean;
  unread: boolean;
  error: string | null;
  fontSize: number;
};
// Host Markdown draws at the app's content size (15) and takes no font size, so the thread is
// zoomed by fontSize / BASE (desktop only). fontSize = BASE matches the main chat exactly.
const BASE = 15;
// v2: v1 saved the old default of 20.
const PREFS_KEY = "paseo-ask:prefs-v2";
const prefs = load(PREFS_KEY, { fontSize: BASE });
// v4: bump when State changes shape, so a newer copy never reads an older copy's store.
// stop: set by the mounted window, so Escape can stop from outside it.
type Store = { state: State; listeners: Set<() => void>; previews: Map<string, string>; stop?: () => void };
const g = globalThis as { __paseoAskStoreV4?: Store };
const store: Store = (g.__paseoAskStoreV4 ??= {
  state: { queued: [], open: false, agentId: null, draft: "", turns: [], live: [], jobId: null, pending: false, unread: false, error: null, ...prefs },
  listeners: new Set(),
  // Image data: URIs by daemon path: attachment previews, and images answers embed.
  previews: new Map(),
});
const previews = store.previews;
const current = () => store.state;
function set(patch: Partial<State>) {
  store.state = { ...store.state, ...patch };
  if ("fontSize" in patch) save(PREFS_KEY, { fontSize: store.state.fontSize });
  for (const l of store.listeners) l();
}
const subscribe = (l: () => void) => (store.listeners.add(l), () => void store.listeners.delete(l));
const useAskState = () => useSyncExternalStore(subscribe, current);

export const setAskOpen = (open: boolean) => set(open ? { open, unread: false } : { open });
// Escape: stops an answer in progress, like Paseo's Escape interrupts an agent; otherwise closes.
export const escapeAsk = () => (current().pending && store.stop ? store.stop() : setAskOpen(false));
// seed: text put before the draft (a quoted selection).
export const openAsk = (agentId: string | null, seed = "") => set({ open: true, unread: false, agentId, draft: seed + current().draft });
// For the Ask buttons' icon: a spinner while answering, a dot when an unseen answer is ready.
export const useAskBadge = () => {
  const { pending, unread } = useAskState();
  return pending ? "pending" : unread ? "unread" : null;
};

// Turns as resent to claude: steps are display-only, but a steer is part of the conversation.
const forClaude = (turns: Turn[]): Turn[] =>
  turns.map(({ role, text, files, steps }) => {
    const steers = (steps ?? []).filter((x) => x.kind === "steer").map((x) => `"${x.text}"`);
    return { role, files, text: steers.length ? `[While answering, the user added: ${steers.join("; ")}]\n\n${text}` : text };
  });
export const quote = (text: string) => `${text.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;

const FONT_MIN = 12;
const FONT_MAX = 40;
const THREAD_ID = "paseo-ask-thread";
const INPUT_ID = "paseo-ask-input";
const POLL_MS = 500;

// Mount once, outside any Pressable: modals are React portals, so their events bubble up the React tree.
// Own window everywhere: the host Modal's header is too tall on phones and its desktop size is fixed.
export function AskModal(props: PluginHostProps) {
  const { open } = useAskState();
  return open ? (
    <FloatingWindow theme={props.theme} compact={props.layout.compact} title="Ask" onClose={() => setAskOpen(false)} onEscape={escapeAsk}>
      <AskBody {...props} />
    </FloatingWindow>
  ) : null;
}


function AskBody({ theme }: PluginHostProps) {
  const start = useRpc(askStart);
  const poll = useRpc(askPoll);
  const steerRpc = useRpc(askSteer);
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
  const { turns, live, queued, pending, error, fontSize, agentId } = useAskState();
  const [scrolled, setScrolled] = useState(false);
  // Same model as the agent's main window; non-Claude agents and the sidebar fall back to the CLI default.
  const agent = useAgent(agentId ?? "", (a) => ({ model: claudeModelOf(a), effort: claudeEffortOf(a) }));
  const model = agent?.model;
  const effort = agent?.effort;
  const { draft } = useAskState();
  const setDraft = (d: string) => set({ draft: d });
  const [lightbox, setLightbox] = useState<string | null>(null);
  const scroll = useRef<NativeScrollView>(null);
  useEffect(() => setZoom(THREAD_ID, fontSize / BASE), [fontSize]);
  // The input grows with its text up to half the window body.
  const [bodyHeight, setBodyHeight] = useState(0);
  const maxInput = bodyHeight ? Math.round(bodyHeight / 2) : 160;
  useEffect(() => autoGrow(INPUT_ID, maxInput), [draft, maxInput, fontSize]);

  const stopRpc = useRpc(askStop);
  const stop = () => {
    const jobId = current().jobId;
    if (jobId) void stopRpc({ jobId }).catch((err) => set({ error: err instanceof Error ? err.message : String(err) }));
  };
  useEffect(() => {
    store.stop = stop;
  });

  const withPaths = (text: string, list: AskFile[]) =>
    list.length ? `${text}\n\n[Attached files, read them with your tools:\n${list.map((f) => `- ${f.path}`).join("\n")}]` : text;

  // Send and its alternate act like Paseo's composer: see shared/send.ts.
  async function submit(alternate: boolean) {
    const text = draft.trim();
    if ((!text && !files.length) || uploading) return;
    const action = sendAction(current().pending, sendSettings().sendBehavior, alternate);
    const sent = files;
    if (action === "ask") {
      setDraft("");
      setFiles([]);
      return ask({ text, files: sent });
    }
    if (action === "queue" || action === "interrupt") {
      // interrupt = stop, then ask it right away (it heads the queue).
      set({ queued: action === "queue" ? [...current().queued, { text, files: sent }] : [{ text, files: sent }, ...current().queued] });
      setDraft("");
      setFiles([]);
      if (action === "interrupt") stop();
      return;
    }
    const jobId = current().jobId;
    if (!jobId) return;
    try {
      const { accepted } = await steerRpc({ jobId, text: withPaths(text, sent) });
      if (!accepted) return set({ error: "The answer had already finished; send it again as a new question." });
      setDraft("");
      setFiles([]);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function ask(q: Queued) {
    const next: Turn[] = [...current().turns, { role: "user", text: q.text, ...(q.files.length ? { files: q.files } : {}) }];
    set({ turns: next, pending: true, error: null });
    try {
      // Steps are display-only; resend just the text and files.
      const { jobId } = await start({ turns: forClaude(next), model, effort });
      set({ jobId });
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const job = await poll({ jobId });
        set({ live: job.steps ?? [] });
        if (job.status === "running") continue;
        if (job.status === "error") throw new Error(job.error ?? "failed");
        for (const [p, uri] of Object.entries(job.images ?? {})) previews.set(p, uri);
        set({ turns: [...next, { role: "assistant", text: job.answer ?? "", steps: job.steps, ...(job.stopped ? { stopped: true } : {}) }], unread: !current().open });
        break;
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ pending: false, live: [], jobId: null });
    }
    const [head, ...rest] = current().queued;
    if (head) {
      set({ queued: rest });
      void ask(head);
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
      lightbox: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", alignItems: "center" as const, justifyContent: "center" as const, padding: 24 },
      lightboxImage: { width: "100%" as const, height: "100%" as const },
      fileName: { color: c.foreground, fontSize: 13, maxWidth: 220 },
      error: { color: c.statusDanger, fontSize: small },
      hint: { color: c.foregroundMuted, fontSize: small },
      box: { borderWidth: 1, borderColor: c.border, borderRadius: 16, backgroundColor: c.surface1, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8, gap: 6 },
      input: { minHeight: 24, maxHeight: maxInput, padding: 0, color: c.foreground, fontSize, outlineStyle: "none" } as unknown as TextStyle,
      boxBar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minHeight: 28 },
      // Paseo's composer buttons: 28 px circles, accent Send with an up arrow, red Stop with a white square.
      sendButton: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.accent, alignItems: "center" as const, justifyContent: "center" as const },
      stopButton: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.statusDanger, alignItems: "center" as const, justifyContent: "center" as const },
      stopSquare: { width: 10, height: 10, borderRadius: 2, backgroundColor: "#fff" },
    }),
    [c, pending, fontSize, maxInput],
  );

  // Local image paths in an answer become the data: URIs the daemon sent with it.
  const answerText = (text: string, key: number) =>
    text ? (
      <Markdown key={key}>{text.replace(/(!\[[^\]]*\]\()<?([^)\s>]+)>?\)/g, (m, head: string, p: string) => (previews.has(p) ? `${head}${previews.get(p)})` : m))}</Markdown>
    ) : null;

  const fileChip = (f: AskFile, onRemove?: () => void) => {
    const preview = previews.get(f.path);
    return (
      <View key={f.path} style={s.fileChip}>
        {preview ? (
          <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Open ${f.name}`} onPress={() => setLightbox(preview)}>
            <Image source={{ uri: preview }} style={s.thumb} resizeMode="contain" />
          </Pressable>
        ) : (
          <Text style={s.fileName} numberOfLines={1}>📄 {f.name}</Text>
        )}
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
    <View style={s.root} onLayout={(e) => setBodyHeight(e.nativeEvent.layout.height)}>
      {lightbox ? (
        <Modal transparent visible onRequestClose={() => setLightbox(null)}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close image" onPress={() => setLightbox(null)} style={s.lightbox}>
            <Image source={{ uri: lightbox }} style={s.lightboxImage} resizeMode="contain" />
          </Pressable>
        </Modal>
      ) : null}
      <View style={s.bar}>
        <Text style={s.link}>{[model ?? "default model", effort].filter(Boolean).join(" · ")}</Text>
        <View style={s.spacer} />
        {chip("A−", false, () => set({ fontSize: fontSize - 1 }), "Smaller text", fontSize <= FONT_MIN)}
        {chip("A+", false, () => set({ fontSize: fontSize + 1 }), "Bigger text", fontSize >= FONT_MAX)}
        {turns.length > 0 && !pending ? chip("Clear", false, () => set({ turns: [], error: null }), "Clear conversation") : null}
      </View>
      {/* Opens already scrolled to the end: the first scroll jumps, hidden until it lands; later ones animate. */}
      <ScrollView
        ref={scroll}
        style={[s.list, scrolled ? null : { opacity: 0 }]}
        onContentSizeChange={() => {
          scroll.current?.scrollToEnd({ animated: scrolled });
          if (!scrolled) setScrolled(true);
        }}
      >
        <View nativeID={THREAD_ID} style={s.listContent}>
        {turns.map((t, i) =>
          t.role === "user" ? (
            <View key={i} style={s.user}>
              {t.text ? <Markdown>{t.text}</Markdown> : null}
              {t.files?.length ? <View style={s.files}>{t.files.map((f) => fileChip(f))}</View> : null}
            </View>
          ) : (
            <View key={i} style={[s.bot, { gap: 10 }]}>
              {/* The last text step is the answer itself; draw it once, below the steps. */}
              {t.steps?.length ? <Steps theme={theme} steps={t.steps.filter((st, k, all) => !(st.kind === "text" && k === all.length - 1 && st.text.trim() === t.text))} renderText={answerText} /> : null}
              {answerText(t.text, -1)}
              {t.stopped ? <Text style={s.hint}>Stopped</Text> : null}
            </View>
          ),
        )}
        {pending && live.length ? <Steps theme={theme} steps={live} renderText={answerText} /> : null}
        {pending ? <ActivityIndicator color={c.foregroundMuted} style={{ alignSelf: "flex-start" }} /> : null}
        {queued.map((q, i) => (
          <View key={`q${i}`} style={[s.user, { opacity: 0.6 }]}>
            <Text style={s.hint}>Queued</Text>
            {q.text ? <Markdown>{q.text}</Markdown> : null}
          </View>
        ))}
        {error ? <Text style={s.error}>{error}</Text> : null}
        </View>
      </ScrollView>
      {files.length || uploading ? (
        <View style={s.files}>
          {files.map((f) => fileChip(f, () => setFiles((prev) => prev.filter((x) => x.path !== f.path))))}
          {uploading ? <ActivityIndicator color={c.foregroundMuted} /> : null}
        </View>
      ) : null}
      {/* Same shape as Paseo's composer: one box, attach bottom-left, Stop and Send bottom-right. */}
      <View style={s.box}>
        <TextInput
          nativeID={INPUT_ID}
          style={s.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={pending ? "Steer or queue a message" : "Your question"}
          placeholderTextColor={c.foregroundMuted}
          multiline
          autoFocus
          accessibilityLabel="Question"
          onKeyPress={(e) => {
            // Web only: Paseo's send keys (shared/send.ts); Escape stops an answer in progress.
            const ev = e.nativeEvent as { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };
            const prevent = () => (e as unknown as { preventDefault?: () => void }).preventDefault?.();
            if (ev.key === "Escape" && pending) {
              prevent();
              return stop();
            }
            if (ev.key !== "Enter") return;
            const kind = enterAction(sendSettings().sendShortcut, ev, pending);
            if (!kind) return;
            prevent();
            void submit(kind === "alternate");
          }}
        />
        <View style={s.boxBar}>
          {Platform.OS === "web" ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Attach files" onPress={() => pickFiles((picked) => void attach(picked))} hitSlop={6}>
              <Icon name="Paperclip" size={18} color={c.foregroundMuted} />
            </Pressable>
          ) : null}
          <View style={s.spacer} />
          {pending ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={stop} style={s.stopButton}>
              <View style={s.stopSquare} />
            </Pressable>
          ) : null}
          {!pending || draft.trim() || files.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={pending ? "Send (long-press for the alternate)" : "Send question"}
              disabled={!draft.trim() && !files.length}
              onPress={() => void submit(false)}
              onLongPress={() => void submit(true)}
              style={[s.sendButton, !draft.trim() && !files.length ? { opacity: 0.4 } : null]}
            >
              <Icon name="ArrowUp" size={16} color={c.accentForeground} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}
