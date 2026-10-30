import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { type AskMode, AskModal, AskPanel, askMode, openAsk, openAskNew, quote, setAskMode, useAskBadge, useAskMode } from "./client/ask.tsx";
import { forkHistory } from "./shared/context.ts";
import { watchSelection } from "./client/web.ts";

// Icon of the composer pill and the header button: a spinner while an answer is in progress, a dot
// when one arrived with the window closed. The pill's also carries an invisible
// paseo-ask-pill-<agentId> marker, so a text selection in an agent panel can find its agent and composer (client/web.ts).
function AskIcon(props: PluginButtonIconProps) {
  const badge = useAskBadge();
  const size = props.size ?? 16;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {badge === "pending" ? <ActivityIndicator size={size} color={props.color} /> : <Icon name="MessageCircle" size={size} color={props.color} />}
      {badge === "unread" ? (
        <View
          accessibilityLabel="Answer ready"
          style={{ position: "absolute", top: -2, right: -3, width: 8, height: 8, borderRadius: 4, backgroundColor: props.theme.colors.accent, borderWidth: 1.5, borderColor: props.theme.colors.surface0 }}
        />
      ) : null}
      {props.context === "agent" ? <View nativeID={`paseo-ask-pill-${props.agentId}`} style={{ position: "absolute", width: 0, height: 0 }} /> : null}
    </View>
  );
}

function AskSettings() {
  const mode = useAskMode();
  return (
    <SettingsSection title="Ask">
      <SettingsSelect<AskMode>
        label="Open Ask in"
        hint="The window floats over the app; the side panel sits next to the agent. Saved on this device."
        value={mode}
        options={[
          { label: "Floating window", value: "popup" },
          { label: "Side panel", value: "side" },
        ]}
        onValueChange={setAskMode}
      />
    </SettingsSection>
  );
}

// An invisible sidebar item, only to host the window and the selection watcher: it is always mounted,
// while pills and header buttons come and go with workspaces. Hiding "Ask" in Settings → Sidebar turns both off.
function AskItem(props: PluginSidebarItemProps) {
  const c = props.theme.colors;
  useEffect(
    () =>
      watchSelection(
        { background: c.surface0, foreground: c.foreground, border: c.border },
        quote,
        (text, agentId) => openAskNew(agentId, quote(text)),
        (text, agentId) => openAskNew(agentId, quote(text), (question) => fork(agentId, question)),
      ),
    [c.surface0, c.foreground, c.border],
  );
  return <AskModal {...props} />;
}

// Set by contribute: opens Ask where Settings → Ask says. The side panel needs a workspace;
// without one (a selection outside an agent) it falls back to the window.
let show: (agentId: string | null, seed?: string, send?: string, workspaceId?: string | null) => void = (agentId, seed) => openAsk(agentId, seed);
// Set by contribute: a new agent in agentId's workspace, with its chat history (like Paseo's Fork), asked question.
let fork: (agentId: string, question: string) => Promise<void> = async () => {};

// Opened by fork only to reach navigation, which sidebar items don't get; goes straight on to the agent.
function OpenAgent({ params, navigation }: PluginScreenProps) {
  useEffect(() => {
    if (params.agentId) navigation?.openAgent({ agentId: params.agentId });
  }, [params.agentId]);
  return <ActivityIndicator style={{ flex: 1 }} />;
}

export default function contribute(client: PluginClientContext) {
  // Workspace of each agent, for a selection in an agent panel.
  const workspaceOf = new Map<string, string>();
  show = (agentId, seed = "", send = "", workspaceId = agentId ? workspaceOf.get(agentId) : null) => {
    const side = askMode() === "side" && !!workspaceId;
    openAsk(agentId, seed, send, !side);
    if (side && workspaceId) client.openPanel("ask", { workspaceId, location: "explorer" });
  };
  fork = async (agentId, question) => {
    const t = await client.paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 1000, projection: "canonical" });
    const a = t.agent;
    const model = a?.model ?? a?.runtimeInfo?.model;
    if (!a?.workspaceId || !model) throw new Error("Can't fork: the agent's workspace or model is unknown");
    const created = await client.paseo.workspaces.ref(a.workspaceId).agents.create({
      config: {
        provider: `${a.provider}/${model}`,
        modeId: a.currentModeId ?? undefined,
        thinkingOptionId: a.thinkingOptionId ?? undefined,
        featureValues: Object.fromEntries((a.features ?? []).map((f) => [f.id, f.value])),
      },
      prompt: question,
      attachments: [{ type: "text", mimeType: "text/plain", contextKind: "chat_history", title: "Chat history", text: forkHistory(t.entries, a.title, a.cwd) }],
    });
    client.openScreen({ screenId: "open-agent", params: { agentId: created.id } });
  };
  client.addScreen({ id: "open-agent", title: "Opening chat", Component: OpenAgent });
  client.addSidebarFooterItem({ id: "ask", title: "Ask", Component: AskItem });
  client.addWorkspacePanel({ id: "ask", title: "Ask", icon: "MessageCircle", locations: ["explorer", "workspace"], Component: AskPanel });
  client.addSettingsScreen({ id: "ask", title: "Ask", icon: "MessageCircle", Component: AskSettings });
  // Like Claude Code's /btw: a side question that never reaches the agent.
  client.addSlashCommand({
    name: "btw",
    description: "Ask a side question in Ask; the agent never sees it",
    argumentHint: "<question>",
    context: "agent",
    onSubmit: ({ args, agent, workspace }) => show(agent.id, "", args.trim(), workspace.id),
  });

  // One "Ask" pill per agent composer, next to tell-agent's pill.
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    // Agents upsert on every status change; an existing pill stays (its workspace never changes).
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    workspaceOf.set(agentId, workspaceId);
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "ask",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: { title: "Ask a quick question", label: "Ask", icon: AskIcon, behavior: { kind: "action", onPress: () => show(agentId, "", "", workspaceId) } },
      }),
    );
  };
  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent);
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
          workspaceOf.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[paseo-ask] agent observation failed", error);
    });
  // Workspace header button too: Paseo draws plugin pills only for existing agents, never in a new-agent draft.
  const headers = new Map<string, PluginButtonRegistration>();
  const addHeader = (workspaceId: string) => {
    if (lifetime.signal.aborted || headers.has(workspaceId)) return;
    headers.set(
      workspaceId,
      client.addHeaderButton({
        id: "ask",
        workspaceId,
        button: { title: "Ask a quick question", label: "Ask", icon: AskIcon, behavior: { kind: "action", onPress: () => show(null, "", "", workspaceId) } },
      }),
    );
  };
  const removeHeaders = () => {
    for (const h of headers.values()) h.remove();
    headers.clear();
  };
  // workspaces.list takes no signal: release the subscription ourselves, also if cleanup ran first.
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) return void subscription.release();
      lifetime.signal.addEventListener("abort", () => void subscription.release());
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeHeaders();
          for (const w of entries) addHeader(w.id);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return addHeader(update.workspace.id);
          headers.get(update.id)?.remove();
          headers.delete(update.id);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[paseo-ask] workspace observation failed", error);
    });

  return () => {
    lifetime.abort();
    removeAll();
    removeHeaders();
  };
}
