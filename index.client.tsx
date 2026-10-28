import type { PluginButtonRegistration, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AskModal, openAsk } from "./client/ask.tsx";

// The sidebar row also hosts the modal: it is always mounted, and pills have no mounted component of their own.
function AskItem(props: PluginSidebarItemProps) {
  return (
    <>
      <SidebarRow icon="MessageCircle" onPress={() => openAsk(null)} />
      <AskModal {...props} />
    </>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addSidebarFooterItem({ id: "ask", title: "Ask", Component: AskItem });

  // One "Ask" pill per agent composer, next to tell-agent's pill.
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    // Agents upsert on every status change; an existing pill stays (its workspace never changes).
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    const agentId = agent.id;
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "ask",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: { title: "Ask a quick question", label: "Ask", icon: "MessageCircle", behavior: { kind: "action", onPress: () => openAsk(agentId) } },
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
        button: { title: "Ask a quick question", label: "Ask", icon: "MessageCircle", behavior: { kind: "action", onPress: () => openAsk(null) } },
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
