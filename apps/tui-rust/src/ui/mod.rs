//! UI module.

pub mod app;
pub mod attachments;
pub mod autocomplete;
pub mod clipboard;
pub mod clipboard_image;
pub mod context_bar;
pub mod enhancer;
pub mod input_editor;
pub mod links;
pub mod markdown;
pub mod model_picker;
pub mod mouse;
pub mod popup;
pub mod render;
pub mod scroll;
pub mod session_list;
pub mod session_search;
pub mod slash;
pub mod subagents_view;
pub mod syntax;
pub mod tabs_state;
pub mod theme;
pub mod toast;
pub mod todo_view;
pub mod tool_renderers;
pub mod viewport;
pub mod voice;
pub mod workspace_history;
pub mod wrap;

pub use app::{App, Block, DiagKind, ToolStatus};
pub use autocomplete::{
    AutocompleteState, AutocompleteSuggestion, AutocompleteTrigger, TriggerKind,
};
pub use context_bar::ContextBar;
pub use enhancer::{Enhancer, EnhancerError};
pub use input_editor::{InputEditor, InputVisualLine, RenderedInput};
pub use links::{
    apply_osc8_to_spans, envelope_osc8, extract_file_paths, index_click_targets, LinkClickTarget,
    LinkSpan,
};
pub use model_picker::{ModelPickerState, ModelSummary};
pub use popup::{ActivePopup, PopupKind};
pub use scroll::{PageDirection, ScrollMetrics, ScrollView};
pub use session_list::{SessionListState, SessionListStatus, SessionSummary};
pub use tabs_state::{OpenTab, TabsState};
pub use theme::{Theme, ThemeRole};
pub use toast::{Toast, ToastKindLabel, ToastLevel, ToastQueue};
pub use tool_renderers::{
    render_path_with_link, render_tool_call, render_tool_result, tool_call_line_count,
};
pub use viewport::{Viewport, ViewportWidth, VisualLine};
pub use voice::{VoiceController, VoiceEvent, VoiceInputState, VoiceTranscriptUpdate};
