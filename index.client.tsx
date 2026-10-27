import type { PluginButtonRegistration, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AskModal, setAskOpen } from "./client/ask.tsx";

// The sidebar row also hosts the modal: it is always mounted, and pills have no mounted component of their own.
function AskItem(props: PluginSidebarItemProps) {
  return (
    <>
      <SidebarRow icon="MessageCircle" onPress={() => setAskOpen(true)} />
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
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    pills.get(agent.id)?.remove();
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "ask",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: { title: "Ask a quick question", label: "Ask", icon: "MessageCircle", behavior: { kind: "action", onPress: () => setAskOpen(true) } },
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
      if (!lifetime.signal.aborted) console.error("[paseo-floating-window] agent observation failed", error);
    });
  return () => {
    lifetime.abort();
    removeAll();
  };
}
