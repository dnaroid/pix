import type { Component } from "svelte";

import Bot from "@lucide/svelte/icons/bot";
import Search from "@lucide/svelte/icons/search";
import Code from "@lucide/svelte/icons/code";
import FlaskConical from "@lucide/svelte/icons/flask-conical";
import Globe from "@lucide/svelte/icons/globe";
import Sparkles from "@lucide/svelte/icons/sparkles";
import Brain from "@lucide/svelte/icons/brain";
import Wrench from "@lucide/svelte/icons/wrench";
import Terminal from "@lucide/svelte/icons/terminal";
import Bug from "@lucide/svelte/icons/bug";
import BookOpen from "@lucide/svelte/icons/book-open";
import Eye from "@lucide/svelte/icons/eye";
import Zap from "@lucide/svelte/icons/zap";
import Rocket from "@lucide/svelte/icons/rocket";

/**
 * Agent icon vocabulary shared with the pix TUI theme
 * (src/app/subagents/subagents-model.ts SUBAGENT_ICON_NAMES). Values are the
 * sub-agent `icon:` frontmatter names from bundled agents and `.pi/agents/*.md`.
 */
const AGENT_ICONS: Record<string, Component> = {
  agent: Bot,
  search: Search,
  code: Code,
  flask: FlaskConical,
  globe: Globe,
  sparkles: Sparkles,
  brain: Brain,
  wrench: Wrench,
  terminal: Terminal,
  bug: Bug,
  book: BookOpen,
  eye: Eye,
  zap: Zap,
  rocket: Rocket,
};

/** Resolve an agent icon name to its Lucide component; unknown names get the neutral bot. */
export function agentIcon(name: string | undefined): Component {
  const trimmed = name?.trim();
  return (trimmed && AGENT_ICONS[trimmed]) || Bot;
}
