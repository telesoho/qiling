//! Match the one voice command V1 exposes without asking a model to decide.
//!
//! The pilot intent is "ask Siju to narrate the current position again". The
//! matcher is deliberately conservative: an unrecognised transcript stays a
//! normal conversation, and a command for a capability V1 does not expose to
//! voice is answered locally instead of invoking anything.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceCommand {
    /// The user asked the connected Siju client for a new narration.
    NarrateCurrent,
    /// A command-like request for a capability V1 does not expose to voice.
    Unsupported(UnsupportedCommand),
    /// Not a voice command: keep the usual conversation flow.
    Conversation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsupportedCommand {
    /// VS Code selection explanation is still a manual setting-page action.
    SelectionExplanation,
}

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

/// Classify one final speech transcript.
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
    use super::{classify, guidance, UnsupportedCommand, VoiceCommand};

    #[test]
    fn recognises_the_re_narrate_request() {
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
    }

    #[test]
    fn leaves_other_speech_to_the_conversation() {
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
    }

    #[test]
    fn refuses_negated_and_other_object_requests() {
        for phrase in [
            "不要重新解说当前局面",
            "不用重新解说当前局面",
            "别重新解说当前局面",
            "重新解说这段代码",
            "重新解释这个文件",
        ] {
            assert_eq!(classify(phrase), VoiceCommand::Conversation, "{phrase}");
        }
    }

    #[test]
    fn answers_unsupported_voice_requests_locally() {
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
    }

    #[test]
    fn normalizes_spacing_and_punctuation() {
        assert_eq!(
            classify(" 请 帮我，重新解说当前局面！ "),
            VoiceCommand::NarrateCurrent
        );
        assert_eq!(
            classify("VS Code 解释当前选区"),
            VoiceCommand::Unsupported(UnsupportedCommand::SelectionExplanation)
        );
    }

    #[test]
    fn empty_or_punctuation_only_speech_is_not_a_command() {
        assert_eq!(classify("   "), VoiceCommand::Conversation);
        assert_eq!(classify("。！？"), VoiceCommand::Conversation);
    }
}
