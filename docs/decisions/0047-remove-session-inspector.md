# 0047 — Remove the Desktop Session inspector

- Status: accepted
- Recorded / decided: 2026-10-05
- Owner / approval evidence: user explicitly requested complete removal of the
  session side pane (conversation-only evidence). Duplication with status-bar
  Plan/Subagent details is an implementation observation, not a user-stated motive.
- Governing spec: [Desktop session activity HUD](../../specs/desktop-session-sidebar.md)
- Replaces / replaced by: replaces the persistent Session inspector behaviors
  in the prior version of the governing spec.

## Context

The right-side Session inspector duplicates activity surfaces already available
from the status-bar Plan and Subagents popups. Its persistent pane, visibility
preference, width persistence, automatic close policy, restoration lifecycle,
and toggle command add UI and state without adding a distinct activity view.

## Observations and sources

The former `SessionInspector.svelte` mounted Agents, Plan and council sections;
the status HUD already exposed agent/Plan details. Removal is user-approved;
the preference to retain only popups is the implementation scope, not evidence
of a usability measurement. Popup interaction is governed by
[0048](0048-status-bar-click-popups.md).

## Decision

Remove the Session inspector and all inspector-only components, helpers,
preference/width persistence, activity-driven auto-close policy, lifecycle
restore, and command that toggles the pane. Keep the session activity HUD
available whenever the active session has visible activity, independently of
any former inspector preference. Preserve the workspace sidebar and session
list, the runtime activity bridge, and the runtime-backed Plan clear action.

## Alternatives

- Keep the pane collapsed or hide it behind a setting: retains duplicate UI and
  obsolete preference state.
- Keep the command as an alternate opener: preserves an affordance for a
  surface the user asked to remove.

## Consequences

Desktop presents session Plan/Subagents activity through status-bar popups
instead of a resizable right-side pane. Existing local-storage inspector keys
are inert and are no longer read or written. Workspace navigation, session
tabs, activity transport, and Plan clearing remain unchanged.

## Revisit when

The status-bar activity popups no longer provide the required live Plan or
Subagents information and a distinct replacement surface is explicitly
requested.
