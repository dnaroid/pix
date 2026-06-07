//! Slash command parsing and synchronous dispatch helpers.
//!
//! This module is intentionally UI-integration-light: `main.rs` owns the
//! key-handler and async bridge wiring. The dispatcher below only performs
//! immediate local mutations and emits visible breadcrumbs for commands that
//! will be wired asynchronously by the integration layer.

use crate::ui::app::App;
use crate::ui::popup::PopupKind;
use crate::ui::toast::{ToastKindLabel, ToastLevel};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashCommand {
    Help,
    Clear,
    Abort,
    Undo,
    Compact,
    New,
    Quit,
    Model { ref_: String },
    Search { query: String },
    Sessions,
    Unknown { raw: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashCommandInfo {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub usage: &'static str,
    pub hint: &'static str,
    pub needs_arg: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashCommandOutcome {
    Execute(SlashCommand),
    ShowAutocomplete { query: String },
    NotASlashCommand,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchResult {
    Consumed,
    NotASlashCommand,
    Error(String),
    Quit,
}

static SLASH_COMMANDS: &[SlashCommandInfo] = &[
    SlashCommandInfo {
        name: "help",
        aliases: &["h", "?"],
        usage: "/help",
        hint: "Open help",
        needs_arg: false,
    },
    SlashCommandInfo {
        name: "clear",
        aliases: &["cl"],
        usage: "/clear",
        hint: "Clear this conversation",
        needs_arg: false,
    },
    SlashCommandInfo {
        name: "abort",
        aliases: &["a"],
        usage: "/abort",
        hint: "Stop the current reply",
        needs_arg: false,
    },
    SlashCommandInfo {
        name: "undo",
        aliases: &["u"],
        usage: "/undo",
        hint: "Undo the last turn",
        needs_arg: false,
    },
    SlashCommandInfo {
        name: "compact",
        aliases: &["c"],
        usage: "/compact",
        hint: "Compact this session",
        needs_arg: false,
    },
    SlashCommandInfo {
        name: "new",
        aliases: &["n"],
        usage: "/new",
        hint: "Start a new session",
        needs_arg: false,
    },
    SlashCommandInfo {
        name: "quit",
        aliases: &["q", "exit"],
        usage: "/quit",
        hint: "Quit pix-tui",
        needs_arg: false,
    },
    SlashCommandInfo {
        name: "search",
        aliases: &["find"],
        usage: "/search <query>",
        hint: "Search this session",
        needs_arg: true,
    },
    SlashCommandInfo {
        name: "model",
        aliases: &["m"],
        usage: "/model [provider/model]",
        hint: "Switch models or open the model picker",
        needs_arg: true,
    },
    SlashCommandInfo {
        name: "sessions",
        aliases: &["s"],
        usage: "/sessions",
        hint: "Open the session picker",
        needs_arg: false,
    },
];

pub fn slash_commands_catalog() -> &'static [SlashCommandInfo] {
    SLASH_COMMANDS
}

pub fn parse_slash(input: &str) -> Option<SlashCommand> {
    let body = input.strip_prefix('/')?;
    let raw = body.trim();
    let (name, arg) = split_command_body(body);

    let Some(info) = find_command_info(name) else {
        return Some(SlashCommand::Unknown {
            raw: raw.to_string(),
        });
    };

    Some(match info.name {
        "help" => SlashCommand::Help,
        "clear" => SlashCommand::Clear,
        "abort" => SlashCommand::Abort,
        "undo" => SlashCommand::Undo,
        "compact" => SlashCommand::Compact,
        "new" => SlashCommand::New,
        "quit" => SlashCommand::Quit,
        "search" => SlashCommand::Search {
            query: arg.to_string(),
        },
        "model" => SlashCommand::Model {
            ref_: arg.to_string(),
        },
        "sessions" => SlashCommand::Sessions,
        _ => SlashCommand::Unknown {
            raw: raw.to_string(),
        },
    })
}

pub fn filter_catalog(query: &str) -> Vec<&'static SlashCommandInfo> {
    let q = normalize_query(query);
    if q.is_empty() {
        return slash_commands_catalog().iter().collect();
    }

    slash_commands_catalog()
        .iter()
        .filter(|info| {
            starts_with_ignore_ascii_case(info.name, &q)
                || info
                    .aliases
                    .iter()
                    .any(|alias| starts_with_ignore_ascii_case(alias, &q))
        })
        .collect()
}

pub fn evaluate_slash_input(input: &str) -> SlashCommandOutcome {
    if input.is_empty() || !input.starts_with('/') {
        return SlashCommandOutcome::NotASlashCommand;
    }
    if input == "/" {
        return SlashCommandOutcome::ShowAutocomplete {
            query: String::new(),
        };
    }

    let body = &input[1..];
    let has_space = body.chars().any(char::is_whitespace);
    let (name, _) = split_command_body(body);

    if !has_space {
        if let Some(info) = find_command_info(name) {
            if !info.needs_arg {
                return SlashCommandOutcome::Execute(
                    parse_slash(input).expect("leading slash already checked"),
                );
            }
        }

        // TODO(slash): when popup framework is ready, call
        // app.open_popup(PopupKind::SlashMenu { query }).
        return SlashCommandOutcome::ShowAutocomplete {
            query: name.to_string(),
        };
    }

    SlashCommandOutcome::Execute(parse_slash(input).expect("leading slash already checked"))
}

pub fn dispatch(
    cmd: SlashCommand,
    app: &mut App,
    client: &crate::bridge::BridgeClient,
    tx: &tokio::sync::mpsc::Sender<crate::bridge_event::AppEvent>,
) -> DispatchResult {
    let _ = (client, tx);
    dispatch_local(cmd, app)
}

fn dispatch_local(cmd: SlashCommand, app: &mut App) -> DispatchResult {
    match cmd {
        SlashCommand::Clear => {
            app.reset_conversation();
            DispatchResult::Consumed
        }
        SlashCommand::Help => {
            app.open_popup(PopupKind::Help);
            DispatchResult::Consumed
        }
        SlashCommand::Quit => {
            app.quit = true;
            DispatchResult::Quit
        }
        SlashCommand::Abort => sent_info(app, "/abort"),
        SlashCommand::Undo => sent_info(app, "/undo"),
        SlashCommand::Compact => sent_info(app, "/compact"),
        SlashCommand::New => sent_info(app, "/new"),
        SlashCommand::Sessions => sent_info(app, "/sessions"),
        SlashCommand::Search { query } => {
            app.open_session_search(query);
            DispatchResult::Consumed
        }
        SlashCommand::Model { ref_ } => {
            if ref_.trim().is_empty() {
                let msg = "missing model ref: use /model <provider/model>".to_string();
                app.toasts
                    .push(ToastLevel::Error, ToastKindLabel::Info, msg.clone(), 0);
                DispatchResult::Error(msg)
            } else {
                sent_info(app, &format!("/model {ref_}"))
            }
        }
        SlashCommand::Unknown { raw } => {
            let msg = if raw.is_empty() {
                "unknown slash command".to_string()
            } else {
                format!("unknown slash command: /{raw}")
            };
            app.toasts
                .push(ToastLevel::Error, ToastKindLabel::Info, msg.clone(), 0);
            DispatchResult::Error(msg)
        }
    }
}

fn sent_info(app: &mut App, command: &str) -> DispatchResult {
    app.toasts.push(
        ToastLevel::Info,
        ToastKindLabel::Info,
        format!("sent {command}"),
        0,
    );
    DispatchResult::Consumed
}

fn find_command_info(name: &str) -> Option<&'static SlashCommandInfo> {
    if name.is_empty() {
        return None;
    }
    slash_commands_catalog().iter().find(|info| {
        info.name.eq_ignore_ascii_case(name)
            || info
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(name))
    })
}

fn split_command_body(body: &str) -> (&str, &str) {
    let body = body.trim_start();
    match body.find(char::is_whitespace) {
        Some(idx) => (&body[..idx], body[idx..].trim()),
        None => (body, ""),
    }
}

fn normalize_query(query: &str) -> String {
    let q = query.strip_prefix('/').unwrap_or(query).trim_start();
    q.split_whitespace()
        .next()
        .unwrap_or(q)
        .to_ascii_lowercase()
}

fn starts_with_ignore_ascii_case(candidate: &str, query: &str) -> bool {
    candidate
        .get(..query.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(query))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_names(items: Vec<&'static SlashCommandInfo>) -> Vec<&'static str> {
        items.into_iter().map(|info| info.name).collect()
    }

    #[test]
    fn parse_help_and_aliases() {
        assert_eq!(parse_slash("/help"), Some(SlashCommand::Help));
        assert_eq!(parse_slash("/h"), Some(SlashCommand::Help));
        assert_eq!(parse_slash("/?"), Some(SlashCommand::Help));
    }

    #[test]
    fn dispatch_help_opens_help_popup() {
        let mut app = App::new("/tmp".to_string());

        let result = dispatch_local(SlashCommand::Help, &mut app);

        assert_eq!(result, DispatchResult::Consumed);
        assert_eq!(app.current_popup_kind(), Some(&PopupKind::Help));
    }

    #[test]
    fn parse_clear_and_alias() {
        assert_eq!(parse_slash("/clear"), Some(SlashCommand::Clear));
        assert_eq!(parse_slash("/cl"), Some(SlashCommand::Clear));
    }

    #[test]
    fn parse_abort_and_aliases() {
        assert_eq!(parse_slash("/abort"), Some(SlashCommand::Abort));
        assert_eq!(parse_slash("/a"), Some(SlashCommand::Abort));
    }

    #[test]
    fn parse_undo_and_alias() {
        assert_eq!(parse_slash("/undo"), Some(SlashCommand::Undo));
        assert_eq!(parse_slash("/u"), Some(SlashCommand::Undo));
    }

    #[test]
    fn parse_compact_and_alias() {
        assert_eq!(parse_slash("/compact"), Some(SlashCommand::Compact));
        assert_eq!(parse_slash("/c"), Some(SlashCommand::Compact));
    }

    #[test]
    fn parse_new_and_alias() {
        assert_eq!(parse_slash("/new"), Some(SlashCommand::New));
        assert_eq!(parse_slash("/n"), Some(SlashCommand::New));
    }

    #[test]
    fn parse_quit_and_aliases() {
        assert_eq!(parse_slash("/quit"), Some(SlashCommand::Quit));
        assert_eq!(parse_slash("/q"), Some(SlashCommand::Quit));
        assert_eq!(parse_slash("/exit"), Some(SlashCommand::Quit));
    }

    #[test]
    fn parse_model_and_alias_with_arg() {
        assert_eq!(
            parse_slash("/model claude-3-7"),
            Some(SlashCommand::Model {
                ref_: "claude-3-7".to_string()
            })
        );
        assert_eq!(
            parse_slash("/m provider/model"),
            Some(SlashCommand::Model {
                ref_: "provider/model".to_string()
            })
        );
    }

    #[test]
    fn parse_sessions_and_alias() {
        assert_eq!(parse_slash("/sessions"), Some(SlashCommand::Sessions));
        assert_eq!(parse_slash("/s"), Some(SlashCommand::Sessions));
    }

    #[test]
    fn parse_search_and_alias_with_arg() {
        assert_eq!(
            parse_slash("/search rust"),
            Some(SlashCommand::Search {
                query: "rust".to_string()
            })
        );
        assert_eq!(
            parse_slash("/find session search"),
            Some(SlashCommand::Search {
                query: "session search".to_string()
            })
        );
    }

    #[test]
    fn parse_unknown_and_non_slash() {
        assert_eq!(
            parse_slash("/x"),
            Some(SlashCommand::Unknown {
                raw: "x".to_string()
            })
        );
        assert_eq!(parse_slash("hello"), None);
    }

    #[test]
    fn filter_catalog_all_for_empty_or_slash() {
        assert_eq!(filter_catalog("").len(), slash_commands_catalog().len());
        assert_eq!(filter_catalog("/").len(), slash_commands_catalog().len());
    }

    #[test]
    fn filter_catalog_prefixes_names() {
        assert_eq!(catalog_names(filter_catalog("/cl")), vec!["clear"]);
        assert_eq!(catalog_names(filter_catalog("/u")), vec!["undo"]);
        assert_eq!(
            catalog_names(filter_catalog("/S")),
            vec!["search", "sessions"]
        );
    }

    #[test]
    fn filter_catalog_prefixes_aliases_case_insensitive() {
        assert_eq!(catalog_names(filter_catalog("/A")), vec!["abort"]);
        assert_eq!(catalog_names(filter_catalog("/EX")), vec!["quit"]);
    }

    #[test]
    fn evaluate_empty_and_non_slash_are_not_commands() {
        assert_eq!(
            evaluate_slash_input(""),
            SlashCommandOutcome::NotASlashCommand
        );
        assert_eq!(
            evaluate_slash_input("hello"),
            SlashCommandOutcome::NotASlashCommand
        );
    }

    #[test]
    fn evaluate_autocomplete_states() {
        assert_eq!(
            evaluate_slash_input("/"),
            SlashCommandOutcome::ShowAutocomplete {
                query: String::new()
            }
        );
        assert_eq!(
            evaluate_slash_input("/foo"),
            SlashCommandOutcome::ShowAutocomplete {
                query: "foo".to_string()
            }
        );
        assert_eq!(
            evaluate_slash_input("/model"),
            SlashCommandOutcome::ShowAutocomplete {
                query: "model".to_string()
            }
        );
        assert_eq!(
            evaluate_slash_input("/search"),
            SlashCommandOutcome::ShowAutocomplete {
                query: "search".to_string()
            }
        );
    }

    #[test]
    fn evaluate_execute_known_no_arg_and_unknown_with_space() {
        assert_eq!(
            evaluate_slash_input("/help"),
            SlashCommandOutcome::Execute(SlashCommand::Help)
        );
        assert_eq!(
            evaluate_slash_input("/foo bar"),
            SlashCommandOutcome::Execute(SlashCommand::Unknown {
                raw: "foo bar".to_string()
            })
        );
    }

    #[test]
    fn dispatch_clear_resets_conversation() {
        let mut app = App::new(".".to_string());
        app.push_user_message("hello");
        app.input.insert("draft");

        assert_eq!(
            dispatch_local(SlashCommand::Clear, &mut app),
            DispatchResult::Consumed
        );

        assert!(app.blocks.is_empty());
        assert!(app.input.is_empty());
    }

    #[test]
    fn dispatch_quit_sets_quit() {
        let mut app = App::new(".".to_string());

        assert_eq!(
            dispatch_local(SlashCommand::Quit, &mut app),
            DispatchResult::Quit
        );

        assert!(app.quit);
    }
}
