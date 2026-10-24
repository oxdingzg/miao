//! Product model instructions share the TypeScript harness's canonical assets.
//! Kept request-scoped: switching models replaces the persona, never history.
use std::borrow::Cow;

pub(crate) fn system(provider: &str, model: &str, api: &str) -> Cow<'static, str> {
    let id = format!("{api} {model}").to_lowercase();
    if id.contains("muse") {
        return Cow::Owned(
            include_str!("../../../packages/core/src/system-context/persona/meta.txt").replace(
                "{{MODEL_NAME}}",
                if id.contains("muse-glimmer") {
                    "Muse Glimmer"
                } else {
                    "Muse Spark"
                },
            ),
        );
    }
    let text = if id.contains("gpt-4") || id.contains("o1") || id.contains("o3") {
        include_str!("../../../packages/core/src/system-context/persona/beast.txt")
    } else if id.contains("gpt") {
        if id.contains("gpt-6") {
            include_str!("../../../packages/core/src/system-context/persona/gpt-astra.txt")
        } else if id.contains("codex") {
            include_str!("../../../packages/core/src/system-context/persona/codex.txt")
        } else {
            include_str!("../../../packages/core/src/system-context/persona/gpt.txt")
        }
    } else if id.contains("gemini-") {
        include_str!("../../../packages/core/src/system-context/persona/gemini.txt")
    } else if id.contains("claude") {
        include_str!("../../../packages/core/src/system-context/persona/anthropic.txt")
    } else if id.contains("trinity") {
        include_str!("../../../packages/core/src/system-context/persona/trinity.txt")
    } else if id.contains("kimi")
        || ["kimi-for-coding", "moonshotai", "moonshotai-cn"].contains(&provider)
    {
        include_str!("../../../packages/core/src/system-context/persona/kimi.txt")
    } else {
        include_str!("../../../packages/core/src/system-context/persona/default.txt")
    };
    Cow::Borrowed(text)
}

#[cfg(test)]
mod tests {
    #[test]
    fn model_selection_and_assets_match_the_live_typescript_reference() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../tests/differential/personas.json")).unwrap();
        for case in cases {
            let text = super::system(
                case["providerID"].as_str().unwrap_or_default(),
                case["modelID"].as_str().unwrap_or_default(),
                case["apiID"].as_str().unwrap_or_default(),
            );
            assert_eq!(
                crate::permission::digest(text.as_bytes()),
                case["sha256"].as_str().unwrap(),
                "{case}"
            );
        }
    }
}
