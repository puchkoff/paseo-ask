import { type PluginHostProps, useAgent, useRpc } from "@getpaseo/plugin/client";
import { Icon, Markdown, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Image, Modal, Platform, Pressable, type TextStyle, type ScrollView as NativeScrollView, Text, View } from "react-native";
import { type AskFile, askPoll, askStart, askSteer, askStop, askUpload, type Step, claudeEffortOf, claudeModelOf, MAX_FILE_BASE64, pollUntilDone, type Turn } from "../shared/ask.ts";
import { mixHex } from "../shared/color.ts";
import { enterAction, sendAction } from "../shared/send.ts";
import { type Session, sessionTitle, upsertSession } from "../shared/sessions.ts";
import { autoGrow, confirmed, load, onPasteFiles, sendSettings, type PickedFile, pickFiles, save, setZoom } from "./web.ts";
import { Steps } from "./steps.tsx";
import { FloatingWindow } from "./window.tsx";

// One store for the whole app, on globalThis: each daemon with the plugin runs its own copy of this
// module, and the sidebar row hosting the window switches copies when the main window moves to
// another daemon's workspace. A module-level store would close the window and drop the draft then.
// Font size and the thread are also saved per app (web/desktop only).
// threadId: the daemon keeps one claude per thread id (server/ask.ts createAsk).
// agentId: the agent whose composer pill opened the window; Ask uses its model.
// live: steps of the answer in progress; jobId: its daemon job, for steering.
// unread: an answer arrived while the window was closed (dot on the Ask buttons).
// queued: questions sent with the "queue" behavior, asked one by one after the current answer.
// send: a question to ask as soon as a window or panel is mounted (/btw).
// sessions: the last 100 threads, newest first, the current one included once it has turns.
// mode: where Ask opens, the side panel or the floating window (Settings → Ask).
type Queued = { text: string; files: AskFile[] };
export type AskMode = "side" | "popup";
type State = {
  send: Queued | null;
  sessions: Session[];
  mode: AskMode;
  threadId: string;
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
// Own key, written only when picked in Settings: prefs-v2 also holds "side" saved as the old default.
const MODE_KEY = "paseo-ask:mode";
const prefs = { fontSize: load(PREFS_KEY, { fontSize: BASE }).fontSize, mode: load(MODE_KEY, { mode: "popup" as AskMode }).mode };
// stop: set by the mounted window, so Escape can stop from outside it.
// panels: mounted side panels; an answer arriving while one shows isn't unread.
type Store = { state: State; listeners: Set<() => void>; previews: Map<string, string>; stop?: () => void; panels?: number };
const newId = () => Math.random().toString(36).slice(2);
// Threads are also kept in the app's storage (web/desktop), so an app reload keeps them too.
// shortcut: answer images (data: URIs) aren't saved, so after an app reload they show as links; save them if missed.
// THREAD_KEY: the single thread kept before sessions; read once to seed them.
const THREAD_KEY = "paseo-ask:thread";
const SESSIONS_KEY = "paseo-ask:sessions";
const MAX_SAVED_TURNS = 60;
const saved = load(SESSIONS_KEY, { sessions: [] as Session[] }).sessions;
const DEFAULTS: State = { threadId: newId(), send: null, sessions: saved, queued: [], open: false, agentId: null, draft: "", turns: [], live: [], jobId: null, pending: false, unread: false, error: null, ...prefs };
// One key for every plugin version: a deploy reloads the plugin and must keep the open window
// and the thread (an answer still running dies with the daemon side). New fields get their defaults;
// never rename this key.
const g = globalThis as unknown as Record<string, Store | undefined>;
const store: Store = (g.__paseoAskStore ??= {
  // Reopens the newest session.
  state: saved.length ? { ...DEFAULTS, threadId: saved[0].id, turns: saved[0].turns } : { ...DEFAULTS, turns: load(THREAD_KEY, { turns: [] as Turn[] }).turns },
  listeners: new Set(),
  // Image data: URIs by daemon path: attachment previews, and images answers embed.
  previews: new Map(),
});
// mode from storage: a store kept across the deploy still holds the old "side" default.
store.state = { ...DEFAULTS, ...store.state, mode: prefs.mode };
const previews = store.previews;
const current = () => store.state;
// A store from before sessions (kept across a deploy) or the old saved thread becomes the first session.
if (!store.state.sessions.length && store.state.turns.length) store.state.sessions = upsertSession([], store.state.threadId, store.state.turns, Date.now());

// Full when it fits; otherwise without tool steps of other sessions, then without other sessions.
function saveSessions({ sessions, threadId }: State) {
  const trimmed = sessions.map((x) => ({ ...x, turns: x.turns.slice(-MAX_SAVED_TURNS) }));
  const bare = trimmed.map((x) => (x.id === threadId ? x : { ...x, turns: x.turns.map(({ steps: _steps, ...t }) => t) }));
  save(SESSIONS_KEY, { sessions: trimmed }) || save(SESSIONS_KEY, { sessions: bare }) || save(SESSIONS_KEY, { sessions: bare.filter((x) => x.id === threadId) });
}
function set(patch: Partial<State>) {
  store.state = { ...store.state, ...patch };
  if ("fontSize" in patch) save(PREFS_KEY, { fontSize: store.state.fontSize });
  if ("mode" in patch) save(MODE_KEY, { mode: store.state.mode });
  if ("turns" in patch) {
    store.state.sessions = upsertSession(store.state.sessions, store.state.threadId, store.state.turns, Date.now());
    saveSessions(store.state);
  }
  for (const l of store.listeners) l();
}
const subscribe = (l: () => void) => (store.listeners.add(l), () => void store.listeners.delete(l));
const useAskState = () => useSyncExternalStore(subscribe, current);

export const setAskOpen = (open: boolean) => set(open ? { open, unread: false } : { open });
export const askMode = () => current().mode;
export const setAskMode = (mode: AskMode) => set({ mode });
export const useAskMode = () => useAskState().mode;
// Escape: stops an answer in progress, like Paseo's Escape interrupts an agent; otherwise closes.
export const escapeAsk = () => (current().pending && store.stop ? store.stop() : setAskOpen(false));
// seed: text put before the draft (a quoted selection). send: asked right away (/btw).
// popup: false when the side panel shows it instead of the floating window.
export const openAsk = (agentId: string | null, seed = "", send = "", popup = true) =>
  set({ ...(popup ? { open: true } : {}), unread: false, agentId, draft: seed + current().draft, ...(send ? { send: { text: send, files: [] } } : {}) });
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

// The side panel (explorer tab): the same thread as the window, in every workspace.
export function AskPanel(props: PluginHostProps) {
  useEffect(() => {
    store.panels = (store.panels ?? 0) + 1;
    set({ unread: false });
    return () => void (store.panels = (store.panels ?? 1) - 1);
  }, []);
  return (
    <View style={{ flex: 1, padding: 12, backgroundColor: props.theme.colors.surface0 }}>
      <AskBody {...props} />
    </View>
  );
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
  const { turns, live, queued, pending, error, fontSize, agentId, send, sessions, threadId } = useAskState();
  const [history, setHistory] = useState(false);
  // /btw: the first mounted window or panel asks it; others see send already taken.
  useEffect(() => {
    const q = current().send;
    if (!q) return;
    set({ send: null });
    if (current().pending) set({ queued: [...current().queued, q] });
    else void ask(q);
  }, [send]);
  const busy = pending || queued.length > 0;
  const openSession = (x: Session) => {
    set({ threadId: x.id, turns: x.turns, error: null });
    setHistory(false);
  };
  // The current thread goes too, or the next set({turns}) would re-add it.
  const clearHistory = () => {
    if (!confirmed("Delete all past conversations?")) return;
    set({ sessions: [], threadId: newId(), turns: [], error: null });
    setHistory(false);
  };
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
      const { accepted } = await steerRpc({ jobId, text, files: sent });
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
      const { jobId } = await start({ threadId: current().threadId, turns: forClaude(next), model, effort });
      set({ jobId });
      const job = await pollUntilDone(() => poll({ jobId }), (j) => set({ live: j.steps ?? [] }));
      if (job.status === "error") throw new Error(job.error ?? "failed");
      for (const [p, uri] of Object.entries(job.images ?? {})) previews.set(p, uri);
      set({ turns: [...next, { role: "assistant", text: job.answer ?? "", steps: job.steps, ...(job.stopped ? { stopped: true } : {}) }], unread: !current().open && !store.panels });
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
        {sessions.length ? chip("History", history, () => setHistory(!history), "Past conversations", busy) : null}
        {history ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear history" onPress={clearHistory} hitSlop={6} style={[s.chip, { justifyContent: "center" }]}>
            <Icon name="Trash2" size={14} color={c.foregroundMuted} />
          </Pressable>
        ) : null}
        {turns.length > 0 && !busy ? chip("New", false, () => (set({ threadId: newId(), turns: [], error: null }), setHistory(false)), "New conversation") : null}
      </View>
      {history ? (
        <ScrollView style={s.list}>
          {sessions.map((x) => (
            <Pressable
              key={x.id}
              accessibilityRole="button"
              accessibilityState={{ selected: x.id === threadId }}
              onPress={() => openSession(x)}
              style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: x.id === threadId ? c.surface2 : undefined }}
            >
              <Text style={{ color: c.foreground, fontSize: small }} numberOfLines={1}>{sessionTitle(x)}</Text>
              <Text style={s.hint}>{new Date(x.at).toLocaleString()} · {x.turns.length} messages</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {/* Opens already scrolled to the end: the first scroll jumps, hidden until it lands; later ones animate. */}
      <ScrollView
        ref={scroll}
        style={[s.list, scrolled ? null : { opacity: 0 }, history ? { display: "none" } : null]}
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
