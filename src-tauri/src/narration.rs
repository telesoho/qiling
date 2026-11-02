//! What the pet was last asked to read out loud for another app.
//!
//! A follow-up like "刚才讲了什么" is only answerable if the line is still
//! around, so the most recent narrations are kept for the session. Nothing is
//! written to disk: a VS Code selection explanation can quote source code, and
//! the connector deliberately keeps that out of any log.

use std::{
    collections::VecDeque,
    sync::Mutex,
};

/// Kept in memory per session; a stray burst of lines must not grow unbounded.
const MAX_ENTRIES: usize = 5;
const MAX_SOURCE_CHARS: usize = 64;
const MAX_TEXT_CHARS: usize = 400;
/// How much of that memory is worth sending with one question.
const CONTEXT_ENTRIES: usize = 3;
const MAX_CONTEXT_CHARS: usize = 900;

/// Questions that point back at what was just read out loud.
const RECAP_MARKERS: &[&str] = &[
    "刚才",
    "刚刚",
    "上面",
    "前面",
    "这段",
    "那段",
    "复述",
    "重复",
    "再说一遍",
    "讲了什么",
    "说了什么",
    "讲的什么",
    "说的什么",
    "念的什么",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Narration {
    pub source: String,
    pub text: String,
}

impl Narration {
    pub fn label(&self) -> &str {
        match self.source.as_str() {
            "com.qiling.vscode" => "VS Code 选区解释",
            "com.siju.app" => "识局解说",
            other => other,
        }
    }
}

/// Newest line first.
#[derive(Debug, Default)]
pub struct NarrationLog {
    recent: Mutex<VecDeque<Narration>>,
}

impl NarrationLog {
    pub fn record(&self, source: &str, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let text: String = text.chars().take(MAX_TEXT_CHARS).collect();
        let source: String = source.trim().chars().take(MAX_SOURCE_CHARS).collect();
        let Ok(mut recent) = self.recent.lock() else {
            return;
        };
        if recent.front().is_some_and(|entry| entry.text == text) {
            return;
        }
        recent.push_front(Narration { source, text });
        recent.truncate(MAX_ENTRIES);
    }

    /// The context to send with `question`, or `None` for unrelated questions.
    ///
    /// The reference check keeps the last narration out of ordinary questions:
    /// it can quote code, and a cloud model only ever gets text the user's
    /// question actually needs.
    pub fn context_for(&self, question: &str) -> Option<String> {
        if !asks_about_previous(question) {
            return None;
        }
        let recent = self.recent.lock().ok()?;
        format_context(&recent)
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.recent
            .lock()
            .map(|recent| recent.is_empty())
            .unwrap_or(true)
    }
}

pub fn asks_about_previous(question: &str) -> bool {
    let question = question.trim();
    RECAP_MARKERS.iter().any(|marker| question.contains(marker))
}

fn format_context(recent: &VecDeque<Narration>) -> Option<String> {
    let mut lines = Vec::new();
    let mut used = 0usize;
    for entry in recent.iter().take(CONTEXT_ENTRIES) {
        let count = entry.text.chars().count();
        if used + count > MAX_CONTEXT_CHARS {
            break;
        }
        used += count;
        lines.push(format!("{}. （{}）{}", lines.len() + 1, entry.label(), entry.text));
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::{asks_about_previous, NarrationLog};

    const FIRST: &str = "闭包会捕获定义它的环境，所以内层函数能用到外层的变量。";
    const SECOND: &str = "这里用的是迭代器适配器，map 之后再 collect 才真正求值。";

    #[test]
    fn keeps_the_newest_narration_first_and_ignores_repeats() {
        let log = NarrationLog::default();
        log.record("com.qiling.vscode", FIRST);
        log.record("com.qiling.vscode", FIRST);
        log.record("com.siju.app", SECOND);

        let context = log.context_for("刚才讲了什么").unwrap();
        assert!(context.contains("1. （识局解说）"), "{context}");
        assert!(context.contains("2. （VS Code 选区解释）"), "{context}");
        assert_eq!(context.matches(FIRST).count(), 1);
    }

    #[test]
    fn an_ordinary_question_carries_no_narration() {
        let log = NarrationLog::default();
        log.record("com.qiling.vscode", FIRST);

        assert!(log.context_for("帮我解释一下什么是闭包").is_none());
        assert!(log.context_for("今天天气怎么样").is_none());
        assert!(log.context_for("刚才说到哪了").is_some());
        assert!(log.context_for("再讲一遍上面那段").is_some());
    }

    #[test]
    fn an_empty_log_has_nothing_to_say() {
        let log = NarrationLog::default();
        assert!(log.is_empty());
        assert!(log.context_for("刚才讲了什么").is_none());

        log.record("com.qiling.vscode", "   ");
        assert!(log.is_empty());
    }

    #[test]
    fn the_log_does_not_grow_without_bound() {
        let log = NarrationLog::default();
        for index in 0..12 {
            log.record("com.qiling.vscode", &format!("第 {index} 句解说。"));
        }
        let context = log.context_for("刚才讲了什么").unwrap();

        assert!(context.starts_with("1. （VS Code 选区解释）第 11 句解说。"), "{context}");
        assert!(!context.contains("第 8 句解说"));
    }

    #[test]
    fn recap_questions_are_recognised() {
        assert!(asks_about_previous("刚才讲了什么"));
        assert!(asks_about_previous("刚才你说的是什么意思"));
        assert!(asks_about_previous("再复述一遍"));
        assert!(!asks_about_previous("讲个笑话"));
        assert!(!asks_about_previous("这个函数做什么"));
        // "是什么意思" alone does not point at the narration.
        assert!(!asks_about_previous("你说的是什么意思"));
    }
}
