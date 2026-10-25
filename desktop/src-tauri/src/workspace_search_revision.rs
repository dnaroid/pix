//! Search-only generations for full-document Desktop workspace saves.
//! JSONC normalization preserves byte offsets, allowing a surgical nonce edit.
use serde_json::{value::RawValue, Value};
use std::collections::BTreeMap;

fn selection(content: &str) -> Option<Value> {
    let normalized = super::normalize_jsonc(content).ok()?;
    let root: Value = serde_json::from_str(&normalized).ok()?;
    root.as_object()?;
    let search = root.get("search");
    if search.is_some_and(|value| !value.is_object()) {
        return None;
    }
    if search
        .and_then(|value| value.get("revision"))
        .is_some_and(|value| {
            value
                .as_str()
                .is_none_or(|text| text.encode_utf16().count() > 128)
        })
    {
        return None;
    }
    let sources = search.and_then(|value| value.get("sources"));
    if let Some(sources) = sources {
        let map = sources.as_object()?;
        if map.iter().any(|(key, value)| {
            !["code", "knowledge", "sessions", "tasks", "commits"].contains(&key.as_str())
                || !value.is_boolean()
        }) {
            return None;
        }
    }
    Some(Value::Array(
        ["code", "knowledge", "sessions", "tasks", "commits"]
            .iter()
            .map(|source| {
                Value::Bool(
                    sources
                        .and_then(|value| value.get(source))
                        .and_then(Value::as_bool)
                        .unwrap_or(*source == "code"),
                )
            })
            .collect(),
    ))
}

pub(super) fn for_write(previous: Option<&str>, content: &str) -> String {
    // Invalid editor drafts stay invalid (search fails closed); never repair or
    // reformat user text. The subsequent valid save receives a new generation.
    if selection(content).is_none() {
        return content.to_owned();
    }
    let Ok(normalized) = super::normalize_jsonc(content) else {
        return content.to_owned();
    };
    let Ok(root) = serde_json::from_str::<BTreeMap<String, &RawValue>>(&normalized) else {
        return content.to_owned();
    };
    let previous = previous.unwrap_or("{}");
    let revision = if selection(previous) == selection(content) {
        let old: Value =
            serde_json::from_str(&super::normalize_jsonc(previous).unwrap_or_default())
                .unwrap_or(Value::Null);
        let old_revision = old
            .get("search")
            .and_then(|value| value.get("revision"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let current: Value = serde_json::from_str(&normalized).unwrap();
        let current_revision = current
            .get("search")
            .and_then(|value| value.get("revision"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if old_revision == current_revision {
            return content.to_owned();
        }
        serde_json::to_string(old_revision).unwrap()
    } else {
        format!("\"{}\"", uuid::Uuid::new_v4())
    };
    let (start, end, replacement) = if let Some(search) = root.get("search") {
        let Ok(fields) = serde_json::from_str::<BTreeMap<String, &RawValue>>(search.get()) else {
            return content.to_owned();
        };
        if let Some(value) = fields.get("revision") {
            let start = value.get().as_ptr() as usize - normalized.as_ptr() as usize;
            (start, start + value.get().len(), revision)
        } else {
            let start = search.get().as_ptr() as usize - normalized.as_ptr() as usize + 1;
            (
                start,
                start,
                format!(
                    "\"revision\":{revision}{}",
                    if fields.is_empty() { "" } else { "," }
                ),
            )
        }
    } else {
        let start = normalized.find('{').unwrap() + 1;
        (
            start,
            start,
            format!(
                "\"search\":{{\"revision\":{revision}}}{}",
                if root.is_empty() { "" } else { "," }
            ),
        )
    };
    let mut output = content.to_owned();
    output.replace_range(start..end, &replacement);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_search_revision_changes_only_for_policy_changes_preserving_jsonc() {
        let before = "{ /* keep */ \"search\": {\"sources\": {\"code\": false}, \"revision\": \"old\"}, \"color\":\"red\", }";
        let unrelated = before.replace("red", "blue");
        assert_eq!(for_write(Some(before), &unrelated), unrelated);
        let changed = before.replace("false", "true");
        let saved = for_write(Some(before), &changed);
        assert!(saved.contains("/* keep */"));
        assert!(!saved.contains("\"old\""));
        assert_eq!(selection(&saved), selection(&changed));
        for text in [
            "{}",
            "{\"search\":{}}",
            "{\"search\":{\"sources\":{\"tasks\":true}}}",
        ] {
            let stamped = for_write(Some(before), text);
            assert!(stamped.contains("revision"));
            assert_eq!(selection(text), selection(&stamped));
        }
        assert_eq!(for_write(Some(before), "{"), "{");
        let escaped =
            r#"{"s\u0065arch":{"sources":{"tasks":true},"r\u0065vision":"old"},"future\u1234":1}"#;
        let stamped = for_write(Some("{}"), escaped);
        assert!(!stamped.contains("\"old\""));
        let parsed: Value =
            serde_json::from_str(&super::super::normalize_jsonc(&stamped).unwrap()).unwrap();
        let nonce = parsed["search"]["revision"].as_str().unwrap();
        let copied_nonce = stamped.replace(nonce, "copied");
        assert_eq!(for_write(Some(&stamped), &copied_nonce), stamped);
    }
}
