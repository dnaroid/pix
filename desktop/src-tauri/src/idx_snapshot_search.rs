/// IDX hybrid/semantic queries auto-index. Snapshot search intentionally stays lexical.
pub(crate) fn snapshot_args(mut args: Vec<String>) -> Result<Vec<String>, String> {
    if args.first().map(String::as_str) != Some("search") {
        return Err("snapshot-only queries support code and knowledge search only".to_owned());
    }
    if let Some(index) = args.iter().position(|arg| arg == "--mode") {
        *args
            .get_mut(index + 1)
            .ok_or("snapshot-only mode value is missing")? = "lexical".to_owned();
    } else {
        args.extend(["--mode".to_owned(), "lexical".to_owned()]);
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_mode_never_uses_auto_indexing_modes() {
        let args = snapshot_args(vec![
            "search".into(),
            "question".into(),
            "--mode".into(),
            "hybrid".into(),
        ])
        .unwrap();
        assert_eq!(args.last().unwrap(), "lexical");
        let args = snapshot_args(vec![
            "search".into(),
            "question".into(),
            "--domain".into(),
            "document".into(),
        ])
        .unwrap();
        assert_eq!(&args[args.len() - 2..], &["--mode", "lexical"]);
        assert!(snapshot_args(vec!["context".into()]).is_err());
        assert!(snapshot_args(vec!["search".into(), "--mode".into()]).is_err());
    }
}
