//! User-global semantic provider configuration shared by Pi, ACP and Desktop.
//! Credentials are never returned or written here.
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

const CONFIG_LIMIT: u64 = 1024 * 1024;
const EMBEDDING_LIMIT: usize = 8192;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticConfigStatus {
    configured: bool,
    provider: Option<String>,
    model: Option<String>,
    vector_size: Option<u64>,
    ollama_base_url: Option<String>,
    key_available: bool,
    revision: Option<String>,
}

#[tauri::command]
pub(crate) async fn native_repository_semantic_config() -> Result<SemanticConfigStatus, String> {
    tauri::async_runtime::spawn_blocking(read_config)
        .await
        .map_err(|_| "Semantic settings worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn native_repository_semantic_config_set(
    embedding: Option<Value>,
    expected_revision: Option<String>,
) -> Result<SemanticConfigStatus, String> {
    tauri::async_runtime::spawn_blocking(move || write_config(embedding, expected_revision))
        .await
        .map_err(|_| "Semantic settings worker failed".to_string())?
}

fn read_config() -> Result<SemanticConfigStatus, String> {
    let path = config_path()?;
    // A malformed or unsafe saved file must never enable remote work. Keep
    // search local-only rather than turning status lookup into a search gate.
    let saved = read_file(&path).unwrap_or(None);
    status(
        saved.as_ref().map(|(data, _)| data),
        saved.as_ref().map(|(_, raw)| signature(raw)),
    )
}

fn write_config(
    embedding: Option<Value>,
    expected_revision: Option<String>,
) -> Result<SemanticConfigStatus, String> {
    let path = config_path()?;
    write_config_at(&path, embedding, expected_revision)
}

fn write_config_at(
    path: &PathBuf,
    embedding: Option<Value>,
    expected_revision: Option<String>,
) -> Result<SemanticConfigStatus, String> {
    if let Some(value) = &embedding {
        validate_embedding(value)?;
    }
    check_ancestors(path)?;
    let parent = path.parent().ok_or("Semantic settings path is invalid")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create semantic settings directory")?;
    check_ancestors(path)?;
    let _lock = acquire_lock(&path)?;
    let saved = read_file(&path)?;
    let before = saved.as_ref().map(|(_, raw)| raw.clone());
    let current = before.as_deref().map(signature);
    check_revision(current.as_deref(), expected_revision.as_deref())?;
    let data = saved
        .as_ref()
        .map(|(data, _)| data.clone())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let search = data.get("search").and_then(Value::as_object);
    let mut current_embedding = search.and_then(|search| search.get("embedding")).cloned();
    if let Some(value) = &current_embedding {
        validate_embedding(value)?;
    }
    merge_embedding(&mut current_embedding, embedding)?;
    if let Some(value) = &current_embedding {
        validate_embedding(value)?;
        if serde_json::to_vec(value)
            .map_err(|_| "Could not encode embedding settings")?
            .len()
            > EMBEDDING_LIMIT
        {
            return Err("Embedding settings exceed the size limit".into());
        }
    }
    let source = before.as_deref().unwrap_or(b"{}\n");
    let bytes = edit_suite_jsonc(source, current_embedding.as_ref())?;
    if bytes.len() as u64 > CONFIG_LIMIT {
        return Err("Semantic settings exceed the size limit".into());
    }
    let temporary = parent.join(format!(
        ".pi-tools-suite.jsonc.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let result: Result<(), String> = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Could not create temporary semantic settings")?;
        file.write_all(&bytes)
            .map_err(|_| "Could not write semantic settings")?;
        file.sync_all()
            .map_err(|_| "Could not flush semantic settings")?;
        if read_file(path)?.map(|(_, raw)| raw) != before {
            return Err("Semantic settings changed elsewhere. Reload before saving.".into());
        }
        fs::rename(&temporary, &path).map_err(|_| "Could not publish semantic settings")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    let parsed = parse_suite(&bytes)?;
    status(Some(&parsed), Some(signature(&bytes)))
}

fn config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir())
        .ok_or("User home directory is unavailable")?;
    Ok(home.join(".config/pi/pi-tools-suite.jsonc"))
}

fn signature(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

// Small byte-offset JSONC reader used only to find the two fields Desktop owns.
// It never re-serializes the shared suite document, so comments and unrelated
// formatting remain byte-for-byte intact.
#[derive(Clone, Copy)]
struct Member {
    key_start: usize,
    value_start: usize,
    value_end: usize,
    comma: Option<usize>,
}

fn skip_jsonc(bytes: &[u8], mut i: usize) -> Result<usize, String> {
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes.get(i..i + 2) == Some(b"//") {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' && bytes[i] != b'\r' {
                i += 1;
            }
        } else if bytes.get(i..i + 2) == Some(b"/*") {
            i += 2;
            while i + 1 < bytes.len() && &bytes[i..i + 2] != b"*/" {
                i += 1;
            }
            if i + 1 >= bytes.len() {
                return Err("Suite settings are malformed".into());
            }
            i += 2;
        } else {
            return Ok(i);
        }
    }
}

fn scan_value(bytes: &[u8], start: usize) -> Result<usize, String> {
    let i = skip_jsonc(bytes, start)?;
    match bytes.get(i).copied() {
        Some(b'"') => {
            let mut j = i + 1;
            let mut escaped = false;
            while j < bytes.len() {
                let b = bytes[j];
                j += 1;
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    return Ok(j);
                }
            }
            Err("Suite settings are malformed".into())
        }
        Some(b'{' | b'[') => {
            let close = if bytes[i] == b'{' { b'}' } else { b']' };
            let mut j = i + 1;
            loop {
                j = skip_jsonc(bytes, j)?;
                if bytes.get(j) == Some(&close) {
                    return Ok(j + 1);
                }
                if bytes.get(j) == Some(&b',') {
                    j += 1;
                    continue;
                }
                if bytes[i] == b'{' {
                    let key_end = scan_value(bytes, j)?;
                    if bytes.get(skip_jsonc(bytes, key_end)?) != Some(&b':') {
                        return Err("Suite settings are malformed".into());
                    }
                    j = skip_jsonc(bytes, key_end)? + 1;
                }
                j = scan_value(bytes, j)?;
                j = skip_jsonc(bytes, j)?;
                if bytes.get(j) == Some(&b',') {
                    j += 1;
                } else if bytes.get(j) != Some(&close) {
                    return Err("Suite settings are malformed".into());
                }
            }
        }
        Some(_) => {
            let mut j = i;
            while j < bytes.len()
                && !matches!(
                    bytes[j],
                    b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t' | b'/'
                )
            {
                j += 1;
            }
            if j == i {
                Err("Suite settings are malformed".into())
            } else {
                Ok(j)
            }
        }
        None => Err("Suite settings are malformed".into()),
    }
}

fn object_member(
    bytes: &[u8],
    start: usize,
    wanted: &str,
) -> Result<(usize, Option<Member>), String> {
    let open = skip_jsonc(bytes, start)?;
    if bytes.get(open) != Some(&b'{') {
        return Err("Suite settings must be an object".into());
    }
    let close = scan_value(bytes, open)?.saturating_sub(1);
    let mut i = open + 1;
    loop {
        i = skip_jsonc(bytes, i)?;
        if bytes.get(i) == Some(&b'}') {
            return Ok((close, None));
        }
        let key_start = i;
        let key_end = scan_value(bytes, i)?;
        let key: String = serde_json::from_slice(&bytes[key_start..key_end])
            .map_err(|_| "Suite settings are malformed")?;
        i = skip_jsonc(bytes, key_end)?;
        if bytes.get(i) != Some(&b':') {
            return Err("Suite settings are malformed".into());
        }
        let value_start = skip_jsonc(bytes, i + 1)?;
        let value_end = scan_value(bytes, value_start)?;
        let next = skip_jsonc(bytes, value_end)?;
        let comma = if bytes.get(next) == Some(&b',') {
            Some(next)
        } else {
            None
        };
        if key == wanted {
            return Ok((
                close,
                Some(Member {
                    key_start,
                    value_start,
                    value_end,
                    comma,
                }),
            ));
        }
        if comma.is_none() && bytes.get(next) != Some(&b'}') {
            return Err("Suite settings are malformed".into());
        }
        i = comma.map_or(next, |comma| comma + 1);
    }
}

fn parse_suite(raw: &[u8]) -> Result<Value, String> {
    let text = std::str::from_utf8(raw).map_err(|_| "Suite settings are malformed")?;
    let mut normalized = text.as_bytes().to_vec();
    let mut i = 0;
    let mut string = false;
    let mut escaped = false;
    while i < normalized.len() {
        if string {
            if escaped {
                escaped = false;
            } else if normalized[i] == b'\\' {
                escaped = true;
            } else if normalized[i] == b'"' {
                string = false;
            }
            i += 1;
            continue;
        }
        if normalized[i] == b'"' {
            string = true;
            i += 1;
            continue;
        }
        if normalized.get(i..i + 2) == Some(b"//") {
            normalized[i..i + 2].fill(b' ');
            i += 2;
            while i < normalized.len() && !matches!(normalized[i], b'\n' | b'\r') {
                normalized[i] = b' ';
                i += 1;
            }
            continue;
        }
        if normalized.get(i..i + 2) == Some(b"/*") {
            let begin = i;
            i += 2;
            while i + 1 < normalized.len() && &normalized[i..i + 2] != b"*/" {
                if !matches!(normalized[i], b'\n' | b'\r') {
                    normalized[i] = b' ';
                }
                i += 1;
            }
            if i + 1 >= normalized.len() {
                return Err("Suite settings are malformed".into());
            }
            normalized[begin..begin + 2].fill(b' ');
            normalized[i..i + 2].fill(b' ');
            i += 2;
            continue;
        }
        i += 1;
    }
    if string {
        return Err("Suite settings are malformed".into());
    }
    i = 0;
    string = false;
    escaped = false;
    while i < normalized.len() {
        if string {
            if escaped {
                escaped = false;
            } else if normalized[i] == b'\\' {
                escaped = true;
            } else if normalized[i] == b'"' {
                string = false;
            }
        } else if normalized[i] == b'"' {
            string = true;
        } else if normalized[i] == b',' {
            let mut j = i + 1;
            while j < normalized.len() && normalized[j].is_ascii_whitespace() {
                j += 1;
            }
            if matches!(normalized.get(j), Some(b']' | b'}')) {
                normalized[i] = b' ';
            }
        }
        i += 1;
    }
    let value: Value =
        serde_json::from_slice(&normalized).map_err(|_| "Suite settings are malformed")?;
    if !value.is_object() {
        return Err("Suite settings must be an object".into());
    }
    Ok(value)
}

fn edit_suite_jsonc(raw: &[u8], embedding: Option<&Value>) -> Result<Vec<u8>, String> {
    let parsed = parse_suite(raw)?;
    let root = object_member(raw, 0, "search")?;
    let (search_start, search_end) = if let Some(member) = root.1 {
        if !parsed.get("search").is_some_and(Value::is_object) {
            return Err("Suite search settings must be an object".into());
        }
        (member.value_start, scan_value(raw, member.value_start)? - 1)
    } else if embedding.is_none() {
        return Ok(raw.to_vec());
    } else {
        let value = format!(
            "\"search\": {{\"embedding\": {}}}",
            serde_json::to_string(embedding.unwrap())
                .map_err(|_| "Could not encode embedding settings")?
        );
        return insert_member(
            raw,
            root.0,
            parsed.as_object().is_some_and(|object| !object.is_empty()),
            &value,
        );
    };
    let search = object_member(raw, search_start, "embedding")?;
    match (search.1, embedding) {
        (Some(member), Some(value)) => {
            let encoded =
                serde_json::to_string(value).map_err(|_| "Could not encode embedding settings")?;
            let mut out = raw.to_vec();
            out.splice(member.value_start..member.value_end, encoded.bytes());
            Ok(out)
        }
        (Some(member), None) => {
            let (start, end) = if let Some(comma) = member.comma {
                (member.key_start, comma + 1)
            } else {
                let prefix = &raw[search_start..member.key_start];
                let comma = prefix.iter().rposition(|b| *b == b',');
                (
                    comma.map_or(member.key_start, |comma| search_start + comma),
                    member.value_end,
                )
            };
            let mut out = raw.to_vec();
            out.drain(start..end);
            Ok(out)
        }
        (None, Some(value)) => {
            let encoded = format!(
                "\"embedding\": {}",
                serde_json::to_string(value).map_err(|_| "Could not encode embedding settings")?
            );
            let has_existing = parsed["search"]
                .as_object()
                .is_some_and(|object| !object.is_empty());
            insert_member_at(raw, search_end, has_existing, &encoded)
        }
        (None, None) => Ok(raw.to_vec()),
    }
}

fn insert_member(
    raw: &[u8],
    close: usize,
    has_existing: bool,
    member: &str,
) -> Result<Vec<u8>, String> {
    insert_member_at(raw, close, has_existing, member)
}
fn insert_member_at(
    raw: &[u8],
    close: usize,
    has_existing: bool,
    member: &str,
) -> Result<Vec<u8>, String> {
    let insert = if raw.get(close) == Some(&b'}') {
        close
    } else {
        return Err("Suite settings are malformed".into());
    };
    let before = if has_existing {
        let mut i = insert;
        while i > 0 && raw[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        if i > 0 && raw[i - 1] == b',' {
            format!("\n  {member}")
        } else {
            format!(",\n  {member}")
        }
    } else {
        format!("\n  {member}\n")
    };
    let mut out = raw.to_vec();
    out.splice(insert..insert, before.bytes());
    Ok(out)
}

fn check_ancestors(path: &PathBuf) -> Result<(), String> {
    for ancestor in path.ancestors().skip(1).take(2) {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err("Semantic settings directory is unsafe".into()),
        }
    }
    Ok(())
}

fn read_file(path: &PathBuf) -> Result<Option<(Value, Vec<u8>)>, String> {
    check_ancestors(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not inspect semantic settings".into()),
    };
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > CONFIG_LIMIT
        || hard_linked(&metadata)
    {
        return Err("Semantic settings are not a safe bounded regular file".into());
    }
    let bytes = fs::read(path).map_err(|_| "Could not read semantic settings")?;
    if bytes.len() as u64 > CONFIG_LIMIT {
        return Err("Semantic settings exceed the size limit".into());
    }
    let value = parse_suite(&bytes)?;
    if !value.is_object() {
        return Err("Semantic settings must be a JSON object".into());
    }
    let search = value.get("search");
    if search.is_some_and(|search| !search.is_object()) {
        return Err("Suite search settings must be an object".into());
    }
    if let Some(embedding) = search.and_then(|search| search.get("embedding")) {
        validate_embedding(embedding)?;
        if serde_json::to_vec(embedding)
            .map_err(|_| "Could not encode embedding settings")?
            .len()
            > EMBEDDING_LIMIT
        {
            return Err("Embedding settings exceed the size limit".into());
        }
    }
    Ok(Some((value, bytes)))
}

fn validate_embedding(value: &Value) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or("Embedding settings must be an object")?;
    let provider = obj.get("embeddingProvider").and_then(Value::as_str);
    if !matches!(provider, Some("openrouter" | "ollama")) {
        return Err("Choose OpenRouter or Ollama".into());
    }
    let model = obj
        .get("embeddingModel")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 256 && !s.contains('\0'));
    if model.is_none() {
        return Err("Embedding model is required".into());
    }
    if !obj
        .get("vectorSize")
        .and_then(Value::as_u64)
        .is_some_and(|n| (1..=8192).contains(&n))
    {
        return Err("Vector dimension must be between 1 and 8192".into());
    }
    for field in [
        "knowledgeEmbeddingModel",
        "knowledgeEmbeddingQueryPrefix",
        "knowledgeEmbeddingDocumentPrefix",
        "ollamaBaseUrl",
    ] {
        if obj.get(field).is_some_and(|v| !v.is_string()) {
            return Err("Optional embedding settings must be strings".into());
        }
    }
    if obj
        .get("knowledgeEmbeddingModel")
        .and_then(Value::as_str)
        .is_some_and(|s| s.trim().is_empty() || s.encode_utf16().count() > 256 || s.contains('\0'))
    {
        return Err("Knowledge model is too long".into());
    }
    for field in [
        "knowledgeEmbeddingQueryPrefix",
        "knowledgeEmbeddingDocumentPrefix",
    ] {
        if obj
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|s| s.encode_utf16().count() > 512 || s.contains('\0'))
        {
            return Err("Embedding prefix is too long".into());
        }
    }
    if provider == Some("ollama") {
        let base = obj
            .get("ollamaBaseUrl")
            .and_then(Value::as_str)
            .unwrap_or("http://127.0.0.1:11434");
        let url = tauri::Url::parse(base).map_err(|_| "Ollama URL is invalid")?;
        if base.encode_utf16().count() > 2048
            || !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Ollama URL is invalid".into());
        }
    }
    Ok(())
}

fn check_revision(current: Option<&str>, expected: Option<&str>) -> Result<(), String> {
    if current == expected {
        Ok(())
    } else {
        Err("Semantic settings changed elsewhere. Reload before saving.".into())
    }
}

fn merge_embedding(current: &mut Option<Value>, embedding: Option<Value>) -> Result<(), String> {
    match embedding {
        Some(value) => {
            let settings = value
                .as_object()
                .ok_or("Embedding settings must be an object")?;
            let mut merged = current
                .as_ref()
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (key, value) in settings {
                merged.insert(key.clone(), value.clone());
            }
            *current = Some(Value::Object(merged));
        }
        None => *current = None,
    }
    Ok(())
}

fn status(data: Option<&Value>, revision: Option<String>) -> Result<SemanticConfigStatus, String> {
    let embedding = data
        .and_then(|v| v.get("search"))
        .and_then(|search| search.get("embedding"));
    let configured = embedding.is_some();
    let provider = embedding
        .and_then(|e| e.get("embeddingProvider"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let model = embedding
        .and_then(|e| e.get("embeddingModel"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let vector_size = embedding
        .and_then(|e| e.get("vectorSize"))
        .and_then(Value::as_u64);
    let ollama_base_url = embedding
        .and_then(|e| e.get("ollamaBaseUrl"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let key_available = provider.as_deref() != Some("openrouter") || openrouter_key_available();
    Ok(SemanticConfigStatus {
        configured,
        provider,
        model,
        vector_size,
        ollama_base_url,
        key_available,
        revision,
    })
}

fn openrouter_key_available() -> bool {
    if std::env::var("OPENROUTER_API_KEY").is_ok_and(|key| !key.trim().is_empty()) {
        return true;
    }
    let user_home = std::env::var("HOME")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .or_else(std::env::home_dir);
    let home = std::env::var("PI_CODING_AGENT_DIR")
        .ok()
        .filter(|p| !p.is_empty())
        .map(|p| {
            if p == "~" {
                user_home.clone().unwrap_or_else(|| PathBuf::from(p))
            } else if let (Some(relative), Some(base)) = (p.strip_prefix("~/"), user_home.as_ref())
            {
                base.join(relative)
            } else {
                PathBuf::from(p)
            }
        })
        .or_else(|| user_home.map(|p| p.join(".pi/agent")));
    home.and_then(|dir| {
        let path = dir.join("auth.json");
        let metadata = fs::symlink_metadata(&path).ok()?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || hard_linked(&metadata)
            || metadata.len() > 512 * 1024
        {
            return None;
        }
        let bytes = fs::read(path).ok()?;
        if bytes.len() > 512 * 1024 {
            return None;
        }
        serde_json::from_slice::<Value>(&bytes).ok()
    })
    .is_some_and(|value| {
        value.get("openrouter").is_some_and(|entry| {
            entry.get("type").and_then(Value::as_str) == Some("api_key")
                && entry
                    .get("key")
                    .and_then(Value::as_str)
                    .is_some_and(|key| !key.trim().is_empty() && key.len() <= 10000)
        })
    })
}

struct ConfigLock(PathBuf);
impl Drop for ConfigLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}
fn acquire_lock(path: &PathBuf) -> Result<ConfigLock, String> {
    // Share the lock name and bounded retry protocol with the generic user
    // settings editor (`<filename>.search.lock`). Both writers touch the same
    // suite file, so independent lock paths would permit lost updates.
    let file_name = path
        .file_name()
        .ok_or("Semantic settings path is invalid")?
        .to_string_lossy();
    let parent = path.parent().ok_or("Semantic settings path is invalid")?;
    let parent =
        fs::canonicalize(parent).map_err(|_| "Semantic settings directory is unavailable")?;
    let lock_path = parent.join(format!("{file_name}.search.lock"));
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match fs::create_dir(&lock_path) {
            Ok(_) => return Ok(ConfigLock(lock_path)),
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(20))
            }
            _ => return Err("user config is busy; retry after the current writer finishes".into()),
        }
    }
}

#[cfg(unix)]
fn hard_linked(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() != 1
}
#[cfg(not(unix))]
fn hard_linked(_: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (TestDirectory, PathBuf) {
        let artifacts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.pi/artifacts");
        fs::create_dir_all(&artifacts).unwrap();
        let temp = TestDirectory(
            artifacts.join(format!("central-semantic-rust-{}", uuid::Uuid::new_v4())),
        );
        fs::create_dir(&temp.0).unwrap();
        let path = temp.path().join(".config/pi/pi-tools-suite.jsonc");
        (temp, path)
    }

    #[test]
    fn central_settings_round_trip_uses_content_revision_and_shared_directory_lock() {
        let (_temp, path) = fixture();
        let embedding = serde_json::json!({"embeddingProvider":"ollama","embeddingModel":"fixture","vectorSize":3});
        let first = write_config_at(&path, Some(embedding.clone()), None).unwrap();
        assert!(first.configured);
        assert!(first.revision.is_some());
        let mut data: Value = parse_suite(&fs::read(&path).unwrap()).unwrap();
        data["unrelated"] = Value::Bool(true);
        fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(write_config_at(&path, None, first.revision).is_err());
        let current = signature(&fs::read(&path).unwrap());
        let disabled = write_config_at(&path, None, Some(current)).unwrap();
        assert!(!disabled.configured);
        assert_eq!(read_file(&path).unwrap().unwrap().0["unrelated"], true);
        let lock = acquire_lock(&path).unwrap();
        assert!(path
            .with_file_name("pi-tools-suite.jsonc.search.lock")
            .is_dir());
        assert!(write_config_at(&path, None, None).is_err());
        drop(lock);
        assert!(!path
            .with_file_name("pi-tools-suite.jsonc.search.lock")
            .exists());
    }

    #[test]
    fn central_settings_reject_unsafe_bounds_and_invalid_endpoints() {
        let (_temp, path) = fixture();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            format!("{{\"padding\":\"{}\"}}", "x".repeat(CONFIG_LIMIT as usize)),
        )
        .unwrap();
        assert!(read_file(&path).is_err());
        for url in [
            "",
            "file:///tmp/model",
            "https://user:password@example.com",
            "http://localhost:11434?token=secret",
        ] {
            assert!(validate_embedding(&serde_json::json!({"embeddingProvider":"ollama","embeddingModel":"fixture","vectorSize":3,"ollamaBaseUrl":url})).is_err());
        }
    }

    #[test]
    #[cfg(unix)]
    fn central_settings_reject_redirected_parent_before_creating_or_writing() {
        let (temp, path) = fixture();
        let target = temp.path().join("elsewhere");
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, temp.path().join(".config")).unwrap();
        assert!(write_config_at(&path, None, None).is_err());
        assert!(!target.join("pi").exists());
    }
    #[test]
    fn config_validation_rejects_missing_model_and_bad_dimension() {
        assert!(validate_embedding(&serde_json::json!({"embeddingProvider":"openrouter","embeddingModel":"m","vectorSize":3})).is_ok());
        assert!(validate_embedding(&serde_json::json!({"embeddingProvider":"openrouter","embeddingModel":"m","vectorSize":0})).is_err());
        assert!(validate_embedding(
            &serde_json::json!({"embeddingProvider":"legacy","embeddingModel":"m","vectorSize":3})
        )
        .is_err());
    }

    #[test]
    fn config_update_preserves_unknown_fields_and_rejects_stale_revisions() {
        let mut data =
            Some(serde_json::json!({ "legacyCustomField": "retained", "embeddingModel": "old" }));
        merge_embedding(
            &mut data,
            Some(serde_json::json!({
                "embeddingProvider": "ollama", "embeddingModel": "new", "vectorSize": 768
            })),
        )
        .unwrap();
        assert_eq!(data.as_ref().unwrap()["legacyCustomField"], "retained");
        assert_eq!(data.as_ref().unwrap()["embeddingModel"], "new");
        assert!(check_revision(Some("current"), Some("stale")).is_err());
        assert!(check_revision(Some("current"), Some("current")).is_ok());
        merge_embedding(&mut data, None).unwrap();
        assert!(data.is_none());
    }

    #[test]
    fn suite_jsonc_surgical_edit_preserves_comments_trailing_commas_and_unrelated_settings() {
        let raw = br#"{
  // suite comment
  "theme": "dark",
  "search": { /* nested comment */ "enabled": true, },
  "other": { "keep": [1, 2,], },
}
"#;
        let embedding = serde_json::json!({"embeddingProvider":"ollama","embeddingModel":"fixture","vectorSize":3});
        let edited = edit_suite_jsonc(raw, Some(&embedding)).unwrap();
        let text = String::from_utf8(edited.clone()).unwrap();
        assert!(text.contains("// suite comment"));
        assert!(text.contains("/* nested comment */"));
        assert!(text.contains("\"other\": { \"keep\": [1, 2,], }"));
        assert_eq!(parse_suite(&edited).unwrap()["search"]["enabled"], true);
        assert_eq!(
            parse_suite(&edited).unwrap()["search"]["embedding"],
            embedding
        );
        let removed = edit_suite_jsonc(&edited, None).unwrap();
        assert!(String::from_utf8(removed.clone())
            .unwrap()
            .contains("// suite comment"));
        assert_eq!(parse_suite(&removed).unwrap()["search"]["enabled"], true);
        assert!(parse_suite(&removed).unwrap()["search"]
            .get("embedding")
            .is_none());
    }

    #[test]
    fn suite_writer_rejects_stale_raw_content() {
        let (_temp, path) = fixture();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{\n // keep\n \"theme\": \"dark\"\n}\n").unwrap();
        let stale = signature(&fs::read(&path).unwrap());
        fs::write(&path, b"{\n // keep\n \"theme\": \"light\"\n}\n").unwrap();
        assert!(write_config_at(&path, None, Some(stale)).is_err());
    }
}
