//! Match one final speech transcript against the voice commands that paired
//! clients declared.
//!
//! The catalog is built elsewhere (from the Spirit Protocol capability
//! manifests) and passed in. Matching is deliberately conservative and
//! deterministic:
//!
//! * a client-provided example must match after whitespace/punctuation
//!   normalization, optionally prefixed with the client name or ID;
//! * ambiguous matches are clarified instead of guessed;
//! * a recognised command that belongs to a disconnected client is reported as
//!   offline, never sent to the conversation model;
//! * anything else stays a normal conversation.
//!
//! Two legacy rules keep the existing products working while Siju and the VS
//! Code connector have not declared voice metadata yet.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvailableAction {
    pub client_id: String,
    pub client_name: String,
    pub action_id: String,
    /// `Some` when the client declared voice metadata. `None` means the action
    /// may still be covered by a legacy rule.
    pub voice: Option<Vec<String>>,
    pub connected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchedAction {
    pub client_id: String,
    pub client_name: String,
    pub action_id: String,
    pub connected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceOutcome {
    /// Exactly one command matched.
    Action(MatchedAction),
    /// More than one client or action matched; ask the user to disambiguate.
    Ambiguous(Vec<MatchedAction>),
    /// A legacy command that V1 intentionally keeps out of the voice entry.
    Guidance(UnsupportedCommand),
    /// Not a voice command: keep the usual conversation flow.
    Conversation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsupportedCommand {
    /// VS Code selection explanation is still a manual setting-page action.
    SelectionExplanation,
}

/// Local commands that are handled by the voice runtime itself. A client must
/// not claim them as a spoken example.
const RESERVED_COMMANDS: &[&str] = &["停", "停止", "取消", "等一下", "别说了", "安静", "闭嘴"];
const NARRATE_AGAIN_MARKERS: &[&str] = &["重新", "再次", "再", "从新", "又"];
const NARRATE_VERBS: &[&str] = &["解说", "解释", "讲解"];
const SPEAK_VERBS: &[&str] = &["讲", "说"];
const POSITION_MARKERS: &[&str] = &[
    "局面",
    "棋局",
    "棋盘",
    "这局",
    "这盘",
    "当前局面",
    "当前棋局",
    "棋",
];
const OTHER_OBJECTS: &[&str] = &["代码", "文件", "函数", "文章", "段落", "选段", "文本"];
const RECAP_MARKERS: &[&str] = &[
    "刚才", "刚刚", "上面", "前面", "这段", "那段", "复述", "重复",
];
const INFO_QUESTION_MARKERS: &[&str] = &["什么", "为什么", "怎么", "哪", "多少", "是否"];
const NEGATIONS: &[&str] = &[
    "不要",
    "不用",
    "不想",
    "不必",
    "不需要",
    "停止",
    "取消",
    "别再",
    "别重新",
    "别解",
    "别说",
    "别讲",
];
const SELECTION_MARKERS: &[&str] = &["选区", "选中的", "选中", "vscode"];
const EXPLAIN_VERBS: &[&str] = &["解释", "说明", "解说", "讲"];
const POLITE_PREFIXES: &[&str] = &[
    "请帮我",
    "帮我",
    "麻烦",
    "请",
    "能不能",
    "可以",
    "给我",
    "你",
    "嗯",
    "呃",
    "那个",
    "就是",
];
const TRAILING_PARTICLES: &[&str] = &["好吗", "行吗", "谢谢", "吧", "啊", "呀", "哦", "嗯"];
const BARE_COMMANDS: &[&str] = &[
    "重新解说",
    "再解说",
    "从新解说",
    "再次解说",
    "重新解说下",
    "再解说下",
    "重新解说一下",
    "再解说一下",
    "重新解说一遍",
    "再解说一遍",
    "重新解说一次",
    "再解说一次",
];

pub fn guidance(command: UnsupportedCommand) -> &'static str {
    match command {
        UnsupportedCommand::SelectionExplanation => {
            "语音暂不支持触发 VS Code 选区解释；请在设定页点击“解释当前选区”，或在 VS Code 中执行“器灵：解释当前选区”。"
        }
    }
}

/// Canonical form used for examples, transcripts, client names and IDs.
pub(crate) fn spoken_key(input: &str) -> String {
    input
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

/// A client must not take over a phrase the voice runtime handles locally.
pub(crate) fn is_reserved_example(text: &str) -> bool {
    RESERVED_COMMANDS
        .iter()
        .any(|command| text.contains(command))
}

pub(crate) fn contains_negation(text: &str) -> bool {
    has_any(text, NEGATIONS)
}

/// Classify one final speech transcript against the available commands.
pub fn match_transcript(actions: &[AvailableAction], input: &str) -> VoiceOutcome {
    let text = spoken_key(input);
    if text.is_empty() || contains_negation(&text) {
        return VoiceOutcome::Conversation;
    }

    let variants = text_variants(&text);
    let mut candidates: Vec<(MatchedAction, bool)> = Vec::new();

    for action in actions {
        let Some(examples) = &action.voice else {
            continue;
        };
        let name_key = spoken_key(&action.client_name);
        let id_key = spoken_key(&action.client_id);
        for example in examples {
            let example_key = spoken_key(example);
            if example_key.is_empty() {
                continue;
            }
            for variant in &variants {
                let named = starts_with(variant, &name_key) || starts_with(variant, &id_key);
                if variant == &example_key
                    || variant == &format!("{name_key}{example_key}")
                    || variant == &format!("{id_key}{example_key}")
                {
                    push_candidate(&mut candidates, action, named);
                }
            }
        }
    }

    // Legacy rule: Siju has not declared voice metadata yet, so keep the
    // existing natural-language matcher until it does.
    if let Some(action) = actions.iter().find(|action| {
        action.client_id == "com.siju.app"
            && action.action_id == "siju.narrate_current"
            && action.voice.is_none()
    }) {
        if matches!(classify(input), VoiceCommand::NarrateCurrent) {
            let named = starts_with(&text, &spoken_key(&action.client_name))
                || starts_with(&text, &spoken_key(&action.client_id));
            push_candidate(&mut candidates, action, named);
        }
    }

    if candidates.is_empty() {
        // Legacy rule: keep answering the VS Code selection request locally
        // instead of letting the conversation model claim it can do it.
        if let VoiceCommand::Unsupported(command) = classify(input) {
            return VoiceOutcome::Guidance(command);
        }
        return VoiceOutcome::Conversation;
    }

    let has_named = candidates.iter().any(|(_, named)| *named);
    let mut matches: Vec<MatchedAction> = candidates
        .into_iter()
        .filter(|(_, named)| !has_named || *named)
        .map(|(action, _)| action)
        .collect();
    matches.sort_by(|left, right| {
        left.client_name
            .cmp(&right.client_name)
            .then_with(|| left.client_id.cmp(&right.client_id))
            .then_with(|| left.action_id.cmp(&right.action_id))
    });
    match matches.len() {
        0 => VoiceOutcome::Conversation,
        1 => VoiceOutcome::Action(matches.remove(0)),
        _ => VoiceOutcome::Ambiguous(matches),
    }
}

/// Clarify an ambiguous command without executing anything.
pub fn ambiguity_text(candidates: &[MatchedAction]) -> String {
    let mut client_ids: Vec<&str> = Vec::new();
    let mut names: Vec<&str> = Vec::new();
    for candidate in candidates {
        if !client_ids.contains(&candidate.client_id.as_str()) {
            client_ids.push(candidate.client_id.as_str());
            names.push(candidate.client_name.as_str());
        }
    }
    if client_ids.len() == 1 {
        format!("{}有多个操作符合这个口令，请换一种说法。", names[0])
    } else {
        format!(
            "{} 都能执行这个口令，请先说要哪个客户端，再说一遍口令。",
            names.join("、")
        )
    }
}

/// Classify one final speech transcript for the legacy Siju/VS Code rules.
/// New commands never use this function directly.
pub fn classify(input: &str) -> VoiceCommand {
    let text = normalize(input);
    if text.is_empty() || has_any(&text, NEGATIONS) {
        return VoiceCommand::Conversation;
    }
    if let Some(command) = unsupported(&text) {
        return VoiceCommand::Unsupported(command);
    }
    if !is_narrate_request(&text) {
        return VoiceCommand::Conversation;
    }
    if has_any(&text, OTHER_OBJECTS) {
        return VoiceCommand::Conversation;
    }
    let position = has_any(&text, POSITION_MARKERS);
    if has_any(&text, RECAP_MARKERS) && (!position || has_any(&text, INFO_QUESTION_MARKERS)) {
        return VoiceCommand::Conversation;
    }
    if position || text.contains("识局") {
        return VoiceCommand::NarrateCurrent;
    }
    if is_bare_command(&text) {
        return VoiceCommand::NarrateCurrent;
    }
    VoiceCommand::Conversation
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceCommand {
    /// The user asked the connected Siju client for a new narration.
    NarrateCurrent,
    /// A command-like request for a capability V1 does not expose to voice.
    Unsupported(UnsupportedCommand),
    /// Not a voice command: keep the usual conversation flow.
    Conversation,
}

fn push_candidate(
    candidates: &mut Vec<(MatchedAction, bool)>,
    action: &AvailableAction,
    named: bool,
) {
    if let Some(existing) = candidates.iter_mut().find(|(matched, _)| {
        matched.client_id == action.client_id && matched.action_id == action.action_id
    }) {
        existing.1 = existing.1 || named;
        return;
    }
    candidates.push((
        MatchedAction {
            client_id: action.client_id.clone(),
            client_name: action.client_name.clone(),
            action_id: action.action_id.clone(),
            connected: action.connected,
        },
        named,
    ));
}

fn starts_with(text: &str, prefix: &str) -> bool {
    !prefix.is_empty() && text.starts_with(prefix)
}

fn text_variants(text: &str) -> Vec<String> {
    let mut variants = vec![text.to_string()];
    let without_prefix = strip_polite_prefixes(text);
    let without_suffix = strip_trailing_particles(text);
    let without_both = strip_trailing_particles(without_prefix);
    for variant in [without_prefix, without_suffix, without_both] {
        if !variants.iter().any(|existing| existing == variant) {
            variants.push(variant.to_string());
        }
    }
    variants
}

fn unsupported(text: &str) -> Option<UnsupportedCommand> {
    if has_any(text, SELECTION_MARKERS)
        && has_any(text, EXPLAIN_VERBS)
        && !has_any(text, INFO_QUESTION_MARKERS)
    {
        return Some(UnsupportedCommand::SelectionExplanation);
    }
    None
}

fn is_narrate_request(text: &str) -> bool {
    if !has_any(text, NARRATE_AGAIN_MARKERS) {
        return false;
    }
    has_any(text, NARRATE_VERBS)
        || ((text.contains("识局") || has_any(text, POSITION_MARKERS))
            && has_any(text, SPEAK_VERBS))
}

fn is_bare_command(text: &str) -> bool {
    if has_any(text, INFO_QUESTION_MARKERS) {
        return false;
    }
    let text = strip_polite_prefixes(text);
    let text = strip_trailing_particles(text);
    BARE_COMMANDS.contains(&text)
}

fn strip_polite_prefixes(mut text: &str) -> &str {
    'outer: loop {
        for prefix in POLITE_PREFIXES {
            if let Some(rest) = text.strip_prefix(prefix) {
                text = rest;
                continue 'outer;
            }
        }
        return text;
    }
}

fn strip_trailing_particles(mut text: &str) -> &str {
    'outer: loop {
        for suffix in TRAILING_PARTICLES {
            if let Some(rest) = text.strip_suffix(suffix) {
                text = rest;
                continue 'outer;
            }
        }
        return text;
    }
}

fn has_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn normalize(input: &str) -> String {
    input
        .chars()
        .filter(|character| !character.is_whitespace() && !is_punctuation(*character))
        .flat_map(|character| character.to_lowercase())
        .collect()
}

fn is_punctuation(character: char) -> bool {
    matches!(
        character,
        '，' | '。'
            | '！'
            | '？'
            | '、'
            | '；'
            | '：'
            | ','
            | '.'
            | '!'
            | '?'
            | ';'
            | ':'
            | '…'
            | '—'
            | '-'
            | '_'
            | '('
            | ')'
            | '（'
            | '）'
            | '['
            | ']'
            | '【'
            | '】'
            | '"'
            | '\''
            | '“'
            | '”'
            | '‘'
            | '’'
            | '《'
            | '》'
            | '〈'
            | '〉'
    )
}

#[cfg(test)]
mod tests {
    use super::{
        ambiguity_text, classify, guidance, match_transcript, spoken_key, AvailableAction,
        MatchedAction, UnsupportedCommand, VoiceCommand, VoiceOutcome,
    };

    fn action(
        client_id: &str,
        client_name: &str,
        action_id: &str,
        examples: Option<&[&str]>,
        connected: bool,
    ) -> AvailableAction {
        AvailableAction {
            client_id: client_id.into(),
            client_name: client_name.into(),
            action_id: action_id.into(),
            voice: examples
                .map(|examples| examples.iter().map(|value| value.to_string()).collect()),
            connected,
        }
    }

    fn demo(connected: bool) -> AvailableAction {
        action(
            "com.example.voice-demo",
            "示例客户端",
            "demo.say_hello",
            Some(&["打个招呼", "说声你好"]),
            connected,
        )
    }

    #[test]
    fn matches_a_declared_example_and_reports_connection_state() {
        let outcome = match_transcript(&[demo(true)], "打个招呼");
        assert_eq!(
            outcome,
            VoiceOutcome::Action(MatchedAction {
                client_id: "com.example.voice-demo".into(),
                client_name: "示例客户端".into(),
                action_id: "demo.say_hello".into(),
                connected: true,
            })
        );

        let offline = match_transcript(&[demo(false)], "说声你好");
        assert_eq!(
            offline,
            VoiceOutcome::Action(MatchedAction {
                client_id: "com.example.voice-demo".into(),
                client_name: "示例客户端".into(),
                action_id: "demo.say_hello".into(),
                connected: false,
            })
        );
    }

    #[test]
    fn tolerates_polite_prefixes_particles_and_punctuation() {
        for phrase in [
            "请帮我打个招呼",
            "示例客户端，打个招呼！",
            "打个招呼吧",
            "嗯，打个招呼。",
        ] {
            assert!(
                matches!(
                    match_transcript(&[demo(true)], phrase),
                    VoiceOutcome::Action(_)
                ),
                "{phrase}"
            );
        }
    }

    #[test]
    fn prefers_the_client_named_by_the_user() {
        let named = action(
            "com.example.one",
            "客户端甲",
            "demo.one",
            Some(&["打个招呼"]),
            true,
        );
        // This client's example contains the other client's name, so the
        // transcript matches both entries. The explicit client-name prefix must
        // win over the generic example.
        let also_matches = action(
            "com.example.two",
            "客户端乙",
            "demo.two",
            Some(&["客户端甲打个招呼"]),
            true,
        );
        let outcome = match_transcript(&[named, also_matches], "客户端甲打个招呼");
        assert!(
            matches!(
                outcome,
                VoiceOutcome::Action(MatchedAction { ref action_id, .. })
                    if action_id == "demo.one"
            ),
            "{outcome:?}"
        );
    }

    #[test]
    fn asks_for_clarification_when_two_clients_share_a_phrase() {
        let first = action(
            "com.example.one",
            "客户端一",
            "demo.one",
            Some(&["打个招呼"]),
            true,
        );
        let second = action(
            "com.example.two",
            "客户端二",
            "demo.two",
            Some(&["打个招呼"]),
            true,
        );
        let outcome = match_transcript(&[first, second], "打个招呼");
        let VoiceOutcome::Ambiguous(candidates) = outcome else {
            panic!("expected ambiguity, got {outcome:?}");
        };
        assert_eq!(candidates.len(), 2);
        let text = ambiguity_text(&candidates);
        assert!(text.contains("客户端一"), "{text}");
        assert!(text.contains("客户端二"), "{text}");
    }

    #[test]
    fn asks_for_clarification_when_one_client_has_two_matching_actions() {
        let first = action(
            "com.example.voice-demo",
            "示例客户端",
            "demo.one",
            Some(&["打个招呼"]),
            true,
        );
        let second = action(
            "com.example.voice-demo",
            "示例客户端",
            "demo.two",
            Some(&["打个招呼"]),
            true,
        );
        let outcome = match_transcript(&[first, second], "打个招呼");
        let VoiceOutcome::Ambiguous(candidates) = outcome else {
            panic!("expected ambiguity, got {outcome:?}");
        };
        let text = ambiguity_text(&candidates);
        assert!(text.contains("多个操作"), "{text}");
    }

    #[test]
    fn unknown_or_negated_speech_stays_conversation() {
        assert_eq!(
            match_transcript(&[demo(true)], "今天天气怎么样"),
            VoiceOutcome::Conversation
        );
        assert_eq!(
            match_transcript(&[demo(true)], "不要打个招呼"),
            VoiceOutcome::Conversation
        );
        assert_eq!(
            match_transcript(&[demo(true)], ""),
            VoiceOutcome::Conversation
        );
    }

    #[test]
    fn keeps_the_legacy_siju_command_working() {
        let siju = action("com.siju.app", "识局", "siju.narrate_current", None, true);
        assert!(matches!(
            match_transcript(&[siju], "再讲一遍这盘棋"),
            VoiceOutcome::Action(MatchedAction { ref action_id, .. })
                if action_id == "siju.narrate_current"
        ));
    }

    #[test]
    fn declared_siju_metadata_takes_over_from_the_legacy_matcher() {
        let siju = action(
            "com.siju.app",
            "识局",
            "siju.narrate_current",
            Some(&["重新解说当前局面"]),
            true,
        );
        assert!(matches!(
            match_transcript(&[siju.clone()], "重新解说当前局面"),
            VoiceOutcome::Action(_)
        ));
        assert_eq!(
            match_transcript(&[siju], "再讲一遍这盘棋"),
            VoiceOutcome::Conversation
        );
    }

    #[test]
    fn keeps_the_legacy_selection_guidance_local() {
        assert_eq!(
            match_transcript(&[], "解释当前选区"),
            VoiceOutcome::Guidance(UnsupportedCommand::SelectionExplanation)
        );
    }

    #[test]
    fn canonical_form_removes_punctuation_and_case() {
        assert_eq!(
            spoken_key(" 请 帮我，重新解说 VS Code！ "),
            "请帮我重新解说vscode"
        );
    }

    #[test]
    fn legacy_tests_still_describe_the_existing_siju_behaviour() {
        for phrase in [
            "请识局重新解说当前局面",
            "重新解说",
            "再解说一次",
            "帮我重新解说这盘棋",
            "再讲一遍这局",
            "重新说一下当前局面",
            "重新解释当前局面",
            "识局再讲一遍",
            "请帮我再解说一遍吧",
            "嗯，重新解说一下",
        ] {
            assert_eq!(classify(phrase), VoiceCommand::NarrateCurrent, "{phrase}");
        }
        for phrase in [
            "刚才讲了什么",
            "再复述一遍",
            "帮我解释什么是闭包",
            "今天天气怎么样",
            "重新解说的意思是什么",
            "识局怎么还没解说",
            "再讲个故事",
            "重新解说这个视频",
            "刚才识局重新解说的当前局面是什么",
        ] {
            assert_eq!(classify(phrase), VoiceCommand::Conversation, "{phrase}");
        }
        for phrase in [
            "不要重新解说当前局面",
            "不用重新解说当前局面",
            "别重新解说当前局面",
            "重新解说这段代码",
            "重新解释这个文件",
        ] {
            assert_eq!(classify(phrase), VoiceCommand::Conversation, "{phrase}");
        }
        for phrase in [
            "解释当前选区",
            "VS Code 解释一下选中的代码",
            "重新解说当前选区",
        ] {
            assert_eq!(
                classify(phrase),
                VoiceCommand::Unsupported(UnsupportedCommand::SelectionExplanation),
                "{phrase}"
            );
        }
        assert!(guidance(UnsupportedCommand::SelectionExplanation).contains("暂不支持"));
        assert_eq!(
            classify(" 请 帮我，重新解说当前局面！ "),
            VoiceCommand::NarrateCurrent
        );
        assert_eq!(
            classify("VS Code 解释当前选区"),
            VoiceCommand::Unsupported(UnsupportedCommand::SelectionExplanation)
        );
        assert_eq!(classify("   "), VoiceCommand::Conversation);
        assert_eq!(classify("。！？"), VoiceCommand::Conversation);
    }
}
