import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AskWindow } from "./client/ask.tsx";

function AskItem({ openPopover }: PluginSidebarItemProps) {
  return <SidebarRow icon="MessageCircle" onPress={() => openPopover(AskWindow)} />;
}

export default function contribute(client: PluginClientContext) {
  client.addSidebarFooterItem({ id: "ask", title: "Ask", Component: AskItem });
  return () => {};
}
