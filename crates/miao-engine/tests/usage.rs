use miao_engine::usage::{anthropic, chat, gemini, responses};
use serde_json::json;

#[test]
fn anthropic_reports_the_breakdown_and_sums_the_inclusive_total() {
    let usage = anthropic(
        &json!({"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":90,"cache_creation_input_tokens":5}),
    );
    assert_eq!(usage["nonCachedInputTokens"], 10);
    assert_eq!(usage["cacheReadInputTokens"], 90);
    assert_eq!(usage["cacheWriteInputTokens"], 5);
    assert_eq!(usage["inputTokens"], 105);
    assert_eq!(usage["outputTokens"], 4);
    assert_eq!(usage["totalTokens"], 109);
    // Extended thinking is billed inside output_tokens; never guessed here.
    assert!(usage.get("reasoningTokens").is_none());
    assert_eq!(
        usage["providerMetadata"]["anthropic-messages"]["input_tokens"],
        10
    );
    assert!(anthropic(&json!({})).get("providerMetadata").is_none());
}

#[test]
fn chat_covers_openai_and_deepseek_cache_reporting() {
    let openai = chat(
        &json!({"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":60},"completion_tokens_details":{"reasoning_tokens":7}}),
    );
    assert_eq!(openai["inputTokens"], 100);
    assert_eq!(openai["cacheReadInputTokens"], 60);
    assert_eq!(openai["nonCachedInputTokens"], 40);
    assert_eq!(openai["reasoningTokens"], 7);
    assert_eq!(openai["totalTokens"], 120);
    let deepseek = chat(
        &json!({"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}),
    );
    assert_eq!(deepseek["cacheReadInputTokens"], 80);
    assert_eq!(deepseek["nonCachedInputTokens"], 20);
    assert_eq!(deepseek["totalTokens"], 120);
}

#[test]
fn responses_and_gemini_keep_the_inclusive_output_contract() {
    let responses_usage = responses(
        &json!({"input_tokens":50,"output_tokens":9,"input_tokens_details":{"cached_tokens":30},"output_tokens_details":{"reasoning_tokens":4}}),
    );
    assert_eq!(responses_usage["nonCachedInputTokens"], 20);
    assert_eq!(responses_usage["reasoningTokens"], 4);
    assert_eq!(responses_usage["totalTokens"], 59);
    // Gemini reports visible candidates only, so output must include thinking.
    let gemini_usage = gemini(
        &json!({"promptTokenCount":40,"candidatesTokenCount":6,"thoughtsTokenCount":4,"cachedContentTokenCount":10,"totalTokenCount":50}),
    );
    assert_eq!(gemini_usage["inputTokens"], 40);
    assert_eq!(gemini_usage["nonCachedInputTokens"], 30);
    assert_eq!(gemini_usage["cacheReadInputTokens"], 10);
    assert_eq!(gemini_usage["outputTokens"], 10);
    assert_eq!(gemini_usage["reasoningTokens"], 4);
    assert_eq!(gemini_usage["totalTokens"], 50);
}
