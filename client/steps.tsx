import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Step } from "../shared/ask.ts";
import { mixHex } from "../shared/color.ts";

const ICONS: Record<string, string> = {
  Bash: "Terminal",
  Read: "FileText",
  Write: "FilePlus",
  Edit: "Pencil",
  Grep: "Search",
  Glob: "Search",
  WebSearch: "Search",
  WebFetch: "Globe",
  Task: "Bot",
  Agent: "Bot",
  Skill: "Sparkles",
};

// The one line the main chat shows next to a tool name.
export function summarize(name: string, input: string): string {
  try {
    const v = JSON.parse(input) as Record<string, unknown>;
    for (const k of ["command", "file_path", "path", "pattern", "query", "url", "skill", "description", "prompt"]) {
      if (typeof v[k] === "string" && v[k]) return (v[k] as string).split("\n")[0];
    }
  } catch {
    // Clipped or non-JSON input: fall through to its first line.
  }
  return name.startsWith("mcp__") ? "" : input.split("\n")[0];
}

const toolLabel = (name: string) => (name.startsWith("mcp__") ? name.split("__").slice(1).join(" · ") : name);

function Row({ theme, icon, label, detail, error, children }: { theme: PluginTheme; icon: string; label: string; detail?: string; error?: boolean; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  const expandable = !!children;
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}${detail ? ` ${detail}` : ""}`}
        accessibilityState={{ expanded: open }}
        disabled={!expandable}
        onPress={() => setOpen((o) => !o)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Icon name={icon} size={15} color={error ? c.statusDanger : c.foregroundMuted} />
        <Text style={{ color: c.foregroundMuted, fontSize: 14, fontWeight: "500" }}>{label}</Text>
        {detail ? (
          <Text numberOfLines={1} style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 14, fontFamily: "monospace" }}>
            {detail}
          </Text>
        ) : null}
      </Pressable>
      {open ? children : null}
    </View>
  );
}

function Code({ theme, text }: { theme: PluginTheme; text: string }) {
  return (
    <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, fontFamily: "monospace", backgroundColor: theme.colors.surface1, borderRadius: 6, padding: 8 }}>
      {text}
    </Text>
  );
}

// Thinking and tool calls as compact rows (tap a tool to see its input and output); text renders via renderText.
export function Steps({ theme, steps, renderText }: { theme: PluginTheme; steps: Step[]; renderText: (text: string, key: number) => React.ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      {steps.map((st, i) => {
        if (st.kind === "text") return renderText(st.text, i);
        if (st.kind === "steer")
          return (
            <View key={i} style={{ alignSelf: "flex-end", maxWidth: "85%", backgroundColor: mixHex(theme.colors.surface2, theme.colors.foreground, 0.09), borderRadius: 12, borderTopRightRadius: 2, paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text selectable style={{ color: theme.colors.foreground, fontSize: 14 }}>{st.text}</Text>
            </View>
          );
        if (st.kind === "thinking")
          return (
            <Row key={i} theme={theme} icon="Brain" label="Thinking">
              {st.text ? <Code theme={theme} text={st.text} /> : null}
            </Row>
          );
        return (
          <Row key={i} theme={theme} icon={ICONS[st.name] ?? "Wrench"} label={toolLabel(st.name)} detail={summarize(st.name, st.input)} error={st.error}>
            <View style={{ gap: 6 }}>
              <Code theme={theme} text={st.input} />
              {st.output !== undefined ? <Code theme={theme} text={st.output || "(no output)"} /> : null}
            </View>
          </Row>
        );
      })}
    </View>
  );
}
