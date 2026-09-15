use serde::Deserialize;

/// A closed command set, never arbitrary script or shell input from a menu.
#[derive(Clone, Copy, Deserialize)]
pub enum EditCommand {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

#[tauri::command]
pub fn desktop_edit(window: tauri::WebviewWindow, command: EditCommand) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::WebViewExt;
        let name = match command {
            EditCommand::Undo => "Undo",
            EditCommand::Redo => "Redo",
            EditCommand::Cut => "Cut",
            EditCommand::Copy => "Copy",
            EditCommand::Paste => "Paste",
            EditCommand::SelectAll => "SelectAll",
        };
        window
            .with_webview(move |webview| webview.inner().execute_editing_command(name))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, command);
        Err("This platform uses native predefined editing menu items".into())
    }
}

#[cfg(test)]
mod tests {
    use super::EditCommand;

    #[test]
    fn editing_commands_are_a_closed_set() {
        for command in ["Undo", "Redo", "Cut", "Copy", "Paste", "SelectAll"] {
            assert!(serde_json::from_value::<EditCommand>(serde_json::json!(command)).is_ok());
        }
        for command in ["Reload", "InspectElement", "Delete", "insertHTML", "eval"] {
            assert!(serde_json::from_value::<EditCommand>(serde_json::json!(command)).is_err());
        }
    }
}
