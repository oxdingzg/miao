//! Product config discovery inside the engine (S5, step 1).
//!
//! `specs/s5-config-ownership.md` moves config parsing out of the host: the
//! engine must read the same files in the same precedence as the product. This
//! module is that reader. It is deliberately free of runtime wiring so the
//! parser can be proven against fixtures before anything depends on it.
//!
//! Precedence within one directory follows `Config.fileNames` on the product
//! side: `miao.json`, `miao.jsonc`, `opencode.json`, `opencode.jsonc`, later
//! files winning key by key. Directories are given lowest to highest priority.

/// Config file names read from each config directory, lowest to highest.
pub const FILE_NAMES: [&str; 4] = ["miao.json", "miao.jsonc", "opencode.json", "opencode.jsonc"];

/// Strip JSONC comments and trailing commas so `serde_json` can read the rest.
///
/// Comment markers inside strings are content, not syntax, so the scanner tracks
/// string state and escapes; a `//` inside a URL or a `/*` inside a glob stays.
/// Comments and trailing commas become whitespace to preserve token boundaries
/// and the original byte/line positions used by parse diagnostics.
pub fn strip_jsonc(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len());
    let mut index = 0;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            out.push(byte);
            if byte == b'\\' && index + 1 < bytes.len() {
                index += 1;
                out.push(bytes[index]);
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' => {
                in_string = true;
                out.push(b'"');
                index += 1;
            }
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'/' => {
                while index < bytes.len() && !matches!(bytes[index], b'\n' | b'\r') {
                    out.push(b' ');
                    index += 1;
                }
            }
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'*' => {
                out.extend_from_slice(b"  ");
                index += 2;
                while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    out.push(match bytes[index] {
                        b'\n' | b'\r' => bytes[index],
                        _ => b' ',
                    });
                    index += 1;
                }
                if index + 1 >= bytes.len() {
                    return Err("unterminated block comment".into());
                }
                out.extend_from_slice(b"  ");
                index += 2;
            }
            _ => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(strip_trailing_commas(&out)).map_err(|error| error.to_string())
}

/// Blank a comma that is followed only by whitespace and a closing bracket.
fn strip_trailing_commas(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut in_string = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            out.push(byte);
            if byte == b'\\' && index + 1 < bytes.len() {
                index += 1;
                out.push(bytes[index]);
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            out.push(b'"');
            index += 1;
            continue;
        }
        if byte == b',' {
            let mut next = index + 1;
            while next < bytes.len() && bytes[next].is_ascii_whitespace() {
                next += 1;
            }
            let previous = bytes[..index]
                .iter()
                .rev()
                .copied()
                .find(|byte| !byte.is_ascii_whitespace());
            // A leading comma is invalid JSONC, not an optional trailing comma.
            if next < bytes.len()
                && (bytes[next] == b'}' || bytes[next] == b']')
                && !matches!(previous, None | Some(b'{' | b'[' | b',' | b':'))
            {
                out.push(b' ');
                index += 1;
                continue;
            }
        }
        out.push(byte);
        index += 1;
    }
    out
}

/// Parse one JSONC document. A malformed document is an error, not an empty one:
/// silently ignoring a broken config is how a Session ends up with defaults the
/// operator never chose.
pub fn parse_document(text: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(&strip_jsonc(text)?).map_err(|error| error.to_string())
}

/// Read every config document in `directories`, lowest priority first.
///
/// A missing file is not an error; an unreadable or malformed one is, and names
/// the path so the operator can fix it.
pub fn documents(
    directories: &[std::path::PathBuf],
) -> Result<Vec<(std::path::PathBuf, serde_json::Value)>, String> {
    let mut found = Vec::new();
    for directory in directories {
        for name in FILE_NAMES {
            let path = directory.join(name);
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("{}: {error}", path.display())),
            };
            let value =
                parse_document(&text).map_err(|error| format!("{}: {error}", path.display()))?;
            found.push((path, value));
        }
    }
    Ok(found)
}

/// Merge documents in order; a later object field replaces an earlier one, while
/// objects merge recursively. Arrays and scalars replace wholesale, matching the
/// product's whole-key replacement rule for a config section.
pub fn merge(documents: &[(std::path::PathBuf, serde_json::Value)]) -> serde_json::Value {
    merge_values(
        &documents
            .iter()
            .map(|(_, value)| value.clone())
            .collect::<Vec<_>>(),
    )
}

/// Merge raw document values in order under the same rules as [`merge`].
pub fn merge_values(documents: &[serde_json::Value]) -> serde_json::Value {
    let mut merged = serde_json::Value::Object(serde_json::Map::new());
    for value in documents {
        merge_into(&mut merged, value);
    }
    merged
}

fn merge_into(target: &mut serde_json::Value, value: &serde_json::Value) {
    match (target, value) {
        (serde_json::Value::Object(target), serde_json::Value::Object(value)) => {
            for (key, item) in value {
                match target.get_mut(key) {
                    Some(existing) => merge_into(existing, item),
                    None => {
                        target.insert(key.clone(), item.clone());
                    }
                }
            }
        }
        (target, value) => *target = value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonc_commas_need_a_preceding_value() {
        for text in [
            "{,}",
            "[,]",
            "{/* note */,}",
            "[/* note */,]",
            r#"{"nested":[,]}"#,
            r#"{"nested":{,}}"#,
        ] {
            assert!(parse_document(text).is_err(), "accepted {text}");
        }
    }

    #[test]
    fn comments_separate_tokens_instead_of_repairing_invalid_json() {
        for text in [r#"{"n":1/**/2}"#, r#"{"ok":tru/**/e}"#, "[1/* comment */2]"] {
            assert!(parse_document(text).is_err(), "accepted {text}");
        }
    }

    #[test]
    fn a_carriage_return_ends_a_line_comment() {
        assert_eq!(
            parse_document("// comment\r{\"enabled\":true}").unwrap(),
            serde_json::json!({"enabled":true})
        );
    }

    #[test]
    fn stripping_preserves_source_offsets_for_configuration_errors() {
        let text = "{/* 中文🐱\r\n comment */\"a\":[1,],\"b\":?}";
        let stripped = strip_jsonc(text).unwrap();
        assert_eq!(stripped.len(), text.len());
        for (index, byte) in text.bytes().enumerate() {
            if byte == b'\n' || byte == b'\r' {
                assert_eq!(stripped.as_bytes()[index], byte);
            }
        }
        let error = serde_json::from_str::<serde_json::Value>(&stripped).unwrap_err();
        assert_eq!(error.line(), 2);
        assert_eq!(
            error.column(),
            text.lines().last().unwrap().find('?').unwrap() + 1
        );
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("miao.jsonc");
        std::fs::write(&file, text).unwrap();
        let diagnostic = documents(&[root.path().to_owned()]).unwrap_err();
        assert!(diagnostic.contains(file.to_str().unwrap()));
        assert!(diagnostic.contains(&format!("line 2 column {}", error.column())));
    }

    #[test]
    fn comments_inside_strings_are_content() {
        let text = r#"{
          // line comment
          "endpoint": "https://example.test/v1/chat", /* block */
          "glob": "src/*.rs",
          "escaped": "quote \" // still a string"
        }"#;
        let value = parse_document(text).unwrap();
        assert_eq!(value["endpoint"], "https://example.test/v1/chat");
        assert_eq!(value["glob"], "src/*.rs");
        assert_eq!(value["escaped"], "quote \" // still a string");
    }

    #[test]
    fn unicode_keys_and_values_survive_both_jsonc_passes() {
        let text = r#"{
          // 中文注释 🐱
          "代理": "中文 café café 🐱",
          "路径": "C:\\项目\\文件",
          "markers": "中文 // /* café */ 🐱",
          "escaped": "中文 \" // 仍是字符串",
          "encoded": "\u4e2d\u6587 \ud83d\udc31",
          "nested": ["目录", { "键": "值", }, ], /* 注释 */
        }"#;
        let value = parse_document(text).unwrap();
        assert_eq!(value["代理"], "中文 café café 🐱");
        assert_eq!(value["路径"], "C:\\项目\\文件");
        assert_eq!(value["markers"], "中文 // /* café */ 🐱");
        assert_eq!(value["escaped"], "中文 \" // 仍是字符串");
        assert_eq!(value["encoded"], "中文 🐱");
        assert_eq!(value["nested"], serde_json::json!(["目录", {"键": "值"}]));
    }

    #[test]
    fn trailing_commas_are_accepted_but_stray_text_is_not() {
        let value = parse_document(r#"{ "a": [1, 2, ], "b": { "c": 3, }, }"#).unwrap();
        assert_eq!(value["a"], serde_json::json!([1, 2]));
        assert_eq!(value["b"]["c"], 3);
        assert!(parse_document("{ \"a\": 1 ").is_err());
        assert!(parse_document("/* unterminated").is_err());
    }

    #[test]
    fn later_files_and_directories_win_by_key() {
        let documents = vec![
            (
                std::path::PathBuf::from("global/miao.json"),
                serde_json::json!({"model": "global-model", "engine": {"model": "a", "storage": "/x"}, "theme": "dark"}),
            ),
            (
                std::path::PathBuf::from("project/miao.json"),
                serde_json::json!({"engine": {"model": "b"}}),
            ),
        ];
        let merged = merge(&documents);
        assert_eq!(merged["model"], "global-model");
        assert_eq!(merged["theme"], "dark");
        // Objects merge; the untouched sibling key survives.
        assert_eq!(merged["engine"]["model"], "b");
        assert_eq!(merged["engine"]["storage"], "/x");
    }

    #[test]
    fn nested_objects_merge_while_arrays_replace() {
        let documents = vec![
            (
                std::path::PathBuf::from("a"),
                serde_json::json!({"mcp": {"servers": {"one": {}, "two": {}}}, "list": ["a", "b"]}),
            ),
            (
                std::path::PathBuf::from("b"),
                serde_json::json!({"mcp": {"servers": {"two": {"command": ["x"]}}}, "list": ["c"]}),
            ),
        ];
        let merged = merge(&documents);
        assert_eq!(
            merged["mcp"]["servers"]["two"]["command"],
            serde_json::json!(["x"])
        );
        assert!(merged["mcp"]["servers"].get("one").is_some());
        // A list is replaced whole, never concatenated.
        assert_eq!(merged["list"], serde_json::json!(["c"]));
    }

    #[test]
    fn discovery_reads_every_name_in_precedence_order_and_skips_missing_files() {
        let root = std::env::temp_dir().join(format!("miao-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("miao.json"), r#"{"engine": {"model": "first"}}"#).unwrap();
        std::fs::write(
            root.join("opencode.jsonc"),
            r#"{
              // trailing comma and a comment
              "engine": {"model": "last",},
            }"#,
        )
        .unwrap();
        let documents = documents(std::slice::from_ref(&root)).unwrap();
        assert_eq!(documents.len(), 2);
        assert!(documents[0].0.ends_with("miao.json"));
        assert!(documents[1].0.ends_with("opencode.jsonc"));
        assert_eq!(merge(&documents)["engine"]["model"], "last");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
