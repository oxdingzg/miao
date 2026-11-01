//! Keybindings read from `tui.json`.
//!
//! A key event is resolved against named actions, so a `keybinds` object can
//! replace the strokes for any action the Rust TUI implements. Defaults follow
//! the TypeScript defaults (`packages/tui/src/config/keybind.ts`) where an
//! action exists there; overrides use the same names a user already knows.
//! Unknown action names are dropped silently, as the TypeScript host does.

use std::collections::BTreeMap;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Action {
    Leader,
    AppExit,
    TerminalRedraw,
    TerminalSuspend,
    TerminalTitleToggle,
    CommandList,
    CopyMessage,
    ToolOutputToggle,
    McpList,
    ProviderList,
    SkillList,
    DeviceList,
    /// Background jobs of the open Session: list and stop.
    JobList,
    /// Scheduled wakeups and cron jobs of the open Session.
    ScheduleList,
    WorkspaceList,
    WorkspaceChanges,
    WorkspaceCreate,
    MessageView,
    SessionList,
    SessionNew,
    SessionRename,
    SessionInterrupt,
    EditorOpen,
    ThemeList,
    ModelList,
    StatusView,
    DebugView,
    /// The key list, for the landing screen's advertised `? help`.
    Help,
    Accounts,
    Stash,
    StashDraft,
    InputClear,
    InputUndo,
    InputRedo,
    InputSubmit,
    InputNewline,
    InputBackspace,
    InputDelete,
    InputMoveLeft,
    InputMoveRight,
    InputMoveUp,
    InputMoveDown,
    InputLineHome,
    InputLineEnd,
    InputWordBackward,
    InputWordForward,
    InputDeleteWordBackward,
    InputDeleteWordForward,
    InputDeleteToLineStart,
    InputDeleteToLineEnd,
    HistoryPrevious,
    HistoryNext,
    PageUp,
    PageDown,
    LineUp,
    LineDown,
}

impl Action {
    /// The `keybinds` key that overrides this action.
    pub fn name(self) -> &'static str {
        match self {
            Action::Leader => "leader",
            Action::AppExit => "app_exit",
            Action::TerminalRedraw => "terminal_redraw",
            Action::TerminalSuspend => "terminal_suspend",
            Action::TerminalTitleToggle => "terminal_title_toggle",
            Action::CommandList => "command_list",
            Action::CopyMessage => "messages_copy",
            Action::ToolOutputToggle => "session_toggle_generic_tool_output",
            Action::McpList => "mcp_list",
            Action::ProviderList => "provider_list",
            Action::SkillList => "skill_list",
            Action::DeviceList => "device_list",
            Action::JobList => "job_list",
            Action::ScheduleList => "schedule_list",
            Action::WorkspaceList => "workspace_list",
            Action::WorkspaceChanges => "workspace_changes",
            Action::WorkspaceCreate => "workspace_create",
            Action::MessageView => "messages_toggle_details",
            Action::SessionList => "session_list",
            Action::SessionNew => "session_new",
            Action::SessionRename => "session_rename",
            Action::SessionInterrupt => "session_interrupt",
            Action::EditorOpen => "editor_open",
            Action::ThemeList => "theme_list",
            Action::ModelList => "model_list",
            Action::StatusView => "status_view",
            Action::DebugView => "debug_view",
            Action::Help => "help",
            Action::Accounts => "provider_accounts",
            Action::Stash => "stash",
            Action::StashDraft => "stash_draft",
            Action::InputClear => "input_clear",
            Action::InputUndo => "input_undo",
            Action::InputRedo => "input_redo",
            Action::InputSubmit => "input_submit",
            Action::InputNewline => "input_newline",
            Action::InputBackspace => "input_backspace",
            Action::InputDelete => "input_delete",
            Action::InputMoveLeft => "input_move_left",
            Action::InputMoveRight => "input_move_right",
            Action::InputMoveUp => "input_move_up",
            Action::InputMoveDown => "input_move_down",
            Action::InputLineHome => "input_line_home",
            Action::InputLineEnd => "input_line_end",
            Action::InputWordBackward => "input_word_backward",
            Action::InputWordForward => "input_word_forward",
            Action::InputDeleteWordBackward => "input_delete_word_backward",
            Action::InputDeleteWordForward => "input_delete_word_forward",
            Action::InputDeleteToLineStart => "input_delete_to_line_start",
            Action::InputDeleteToLineEnd => "input_delete_to_line_end",
            Action::HistoryPrevious => "history_previous",
            Action::HistoryNext => "history_next",
            Action::PageUp => "messages_page_up",
            Action::PageDown => "messages_page_down",
            Action::LineUp => "messages_line_up",
            Action::LineDown => "messages_line_down",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        ACTIONS.iter().copied().find(|action| action.name() == name)
    }
}

const ACTIONS: &[Action] = &[
    Action::Leader,
    Action::AppExit,
    Action::TerminalRedraw,
    Action::TerminalSuspend,
    Action::TerminalTitleToggle,
    Action::CommandList,
    Action::CopyMessage,
    Action::ToolOutputToggle,
    Action::McpList,
    Action::ProviderList,
    Action::SkillList,
    Action::DeviceList,
    Action::JobList,
    Action::ScheduleList,
    Action::WorkspaceList,
    Action::WorkspaceChanges,
    Action::WorkspaceCreate,
    Action::MessageView,
    Action::SessionList,
    Action::SessionNew,
    Action::SessionRename,
    Action::SessionInterrupt,
    Action::EditorOpen,
    Action::ThemeList,
    Action::ModelList,
    Action::StatusView,
    Action::DebugView,
    Action::Help,
    Action::Accounts,
    Action::Stash,
    Action::StashDraft,
    Action::InputClear,
    Action::InputUndo,
    Action::InputRedo,
    Action::InputSubmit,
    Action::InputNewline,
    Action::InputBackspace,
    Action::InputDelete,
    Action::InputMoveLeft,
    Action::InputMoveRight,
    Action::InputMoveUp,
    Action::InputMoveDown,
    Action::InputLineHome,
    Action::InputLineEnd,
    Action::InputWordBackward,
    Action::InputWordForward,
    Action::InputDeleteWordBackward,
    Action::InputDeleteWordForward,
    Action::InputDeleteToLineStart,
    Action::InputDeleteToLineEnd,
    Action::HistoryPrevious,
    Action::HistoryNext,
    Action::PageUp,
    Action::PageDown,
    Action::LineUp,
    Action::LineDown,
];

/// Actions the TypeScript host declares as `keybind("none", ...)`: they are
/// reachable only when the operator binds them, so "no default stroke" is the
/// intended state rather than a mouse-only gap. Every other action must have a
/// default, which `every_action_is_reachable_without_a_mouse` enforces.
#[cfg(test)]
const UNBOUND_BY_DEFAULT: &[Action] = &[Action::TerminalTitleToggle];

/// Defaults for the actions above. `messages_copy` keeps miao's `ctrl+y` and
/// adds the TypeScript `<leader>y`; `debug_view` is miao-only.
const DEFAULTS: &[(Action, &str)] = &[
    (Action::Leader, "ctrl+x"),
    (Action::AppExit, "ctrl+c,ctrl+d,<leader>q"),
    (Action::TerminalRedraw, "ctrl+l"),
    #[cfg(unix)]
    (Action::TerminalSuspend, "ctrl+z"),
    (Action::CommandList, "ctrl+p"),
    (Action::CopyMessage, "ctrl+y,<leader>y"),
    (Action::ToolOutputToggle, "<leader>u"),
    (Action::McpList, "<leader>i"),
    (Action::ProviderList, "<leader>a"),
    (Action::SkillList, "<leader>k"),
    (Action::DeviceList, "<leader>D"),
    (Action::JobList, "<leader>j"),
    (Action::ScheduleList, "<leader>S"),
    (Action::WorkspaceList, "<leader>w"),
    (Action::WorkspaceChanges, "<leader>g"),
    (Action::WorkspaceCreate, "<leader>C"),
    (Action::MessageView, "<leader>v"),
    (Action::SessionList, "<leader>l"),
    (Action::SessionNew, "<leader>n"),
    (Action::SessionRename, "ctrl+r"),
    (Action::SessionInterrupt, "escape"),
    (Action::EditorOpen, "<leader>e"),
    (Action::ThemeList, "<leader>t"),
    (Action::ModelList, "<leader>m"),
    (Action::StatusView, "<leader>s"),
    (Action::DebugView, "<leader>d"),
    (Action::Help, "?"),
    (Action::Accounts, "ctrl+o"),
    (Action::Stash, "<leader>p"),
    (Action::StashDraft, "<leader>P"),
    (Action::InputClear, "ctrl+c"),
    (Action::InputUndo, "ctrl+z"),
    // ctrl+shift+z is what a terminal sends for shift+ctrl+z; ctrl+y is
    // the other convention people reach for, so both redo.
    (Action::InputRedo, "ctrl+shift+z,ctrl+y"),
    (Action::InputSubmit, "return"),
    (
        Action::InputNewline,
        "shift+return,ctrl+return,alt+return,ctrl+j",
    ),
    (Action::InputBackspace, "backspace,shift+backspace"),
    (Action::InputDelete, "ctrl+d,delete,shift+delete"),
    (Action::InputMoveLeft, "left,ctrl+b"),
    (Action::InputMoveRight, "right,ctrl+f"),
    (Action::InputMoveUp, "up"),
    (Action::InputMoveDown, "down"),
    (Action::InputLineHome, "ctrl+a"),
    (Action::InputLineEnd, "ctrl+e"),
    (Action::InputWordBackward, "alt+b,alt+left,ctrl+left"),
    (Action::InputWordForward, "alt+f,alt+right,ctrl+right"),
    (
        Action::InputDeleteWordBackward,
        "ctrl+w,ctrl+backspace,alt+backspace",
    ),
    (
        Action::InputDeleteWordForward,
        "alt+d,alt+delete,ctrl+delete",
    ),
    (Action::InputDeleteToLineStart, "ctrl+u"),
    (Action::InputDeleteToLineEnd, "ctrl+k"),
    (Action::HistoryPrevious, "up"),
    (Action::HistoryNext, "down"),
    (Action::PageUp, "pageup,ctrl+alt+b"),
    (Action::PageDown, "pagedown,ctrl+alt+f"),
    (Action::LineUp, "ctrl+alt+y"),
    (Action::LineDown, "ctrl+alt+e"),
];

/// The composer's vocabulary, in priority order. `input_move_up` and
/// `history_previous` share a stroke; the cursor motion wins and the history
/// becomes its fallback.
const INPUT_ACTIONS: &[Action] = &[
    Action::InputUndo,
    Action::InputRedo,
    Action::InputSubmit,
    Action::InputNewline,
    Action::InputBackspace,
    Action::InputDelete,
    Action::InputMoveLeft,
    Action::InputMoveRight,
    Action::InputMoveUp,
    Action::InputMoveDown,
    Action::InputLineHome,
    Action::InputLineEnd,
    Action::InputWordBackward,
    Action::InputWordForward,
    Action::InputDeleteWordBackward,
    Action::InputDeleteWordForward,
    Action::InputDeleteToLineStart,
    Action::InputDeleteToLineEnd,
    Action::HistoryPrevious,
    Action::HistoryNext,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Key {
    code: KeyCode,
    modifiers: KeyModifiers,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stroke {
    /// The stroke on its own.
    Plain(Key),
    /// The stroke after the leader key.
    Leader(Key),
}

#[derive(Debug, Clone)]
pub struct Keymap {
    strokes: BTreeMap<Action, Vec<Stroke>>,
}

impl Default for Keymap {
    fn default() -> Self {
        Self::from_overrides(&BTreeMap::new())
    }
}

impl Keymap {
    /// Builds the default table and replaces the strokes of every action named
    /// in `overrides`; `None` means the action was unbound (`false`/`"none"`).
    pub fn from_overrides(overrides: &BTreeMap<String, Option<Vec<String>>>) -> Self {
        let mut strokes: BTreeMap<Action, Vec<Stroke>> = BTreeMap::new();
        for (action, defaults) in DEFAULTS {
            strokes.insert(*action, parse_list(defaults));
        }
        for (name, value) in overrides {
            let Some(action) = Action::from_name(name) else {
                continue;
            };
            let parsed = match value {
                None => Vec::new(),
                Some(specs) => specs
                    .iter()
                    .filter_map(|spec| parse_spec(spec).ok())
                    .collect(),
            };
            strokes.insert(action, parsed);
        }
        Self { strokes }
    }

    /// A plain stroke bound to `action` matched this key.
    pub fn matches(&self, action: Action, key: &KeyEvent) -> bool {
        self.strokes.get(&action).is_some_and(|strokes| {
            strokes
                .iter()
                .any(|stroke| matches!(stroke, Stroke::Plain(bound) if bound.matches(key)))
        })
    }

    /// The action whose leader chord is this key.
    pub fn leader_action(&self, key: &KeyEvent) -> Option<Action> {
        self.strokes.iter().find_map(|(action, strokes)| {
            strokes
                .iter()
                .any(|stroke| matches!(stroke, Stroke::Leader(bound) if bound.matches(key)))
                .then_some(*action)
        })
    }

    /// The first composer action matched by this key.
    ///
    /// Only `input_*` actions are considered: `ctrl+d` is also `app_exit`, and
    /// the composer must still see it as `input_delete` while it holds a draft.
    pub fn input_action(&self, key: &KeyEvent) -> Option<Action> {
        INPUT_ACTIONS
            .iter()
            .copied()
            .find(|action| self.matches(*action, key))
    }

    /// Every bound action with its effective strokes, so a help or which-key
    /// view cannot claim a key the keymap does not use.
    ///
    /// Actions left unbound are included with an empty spelling: silently
    /// dropping them would hide that the binding was removed.
    pub fn bindings(&self) -> Vec<(Action, String)> {
        let leader = self.strokes.get(&Action::Leader).and_then(|strokes| {
            strokes.iter().find_map(|stroke| match stroke {
                Stroke::Plain(key) => Some(*key),
                Stroke::Leader(_) => None,
            })
        });
        self.strokes
            .iter()
            .map(|(action, strokes)| {
                let specs = strokes
                    .iter()
                    .map(|stroke| match stroke {
                        Stroke::Plain(key) => key.spec(),
                        Stroke::Leader(key) => match &leader {
                            Some(leader) => format!("{}+{}", leader.spec(), key.spec()),
                            None => format!("<leader>+{}", key.spec()),
                        },
                    })
                    .collect::<Vec<_>>();
                (*action, specs.join(", "))
            })
            .collect()
    }

    /// The leader key itself, as configured.
    pub fn is_leader(&self, key: &KeyEvent) -> bool {
        self.strokes.get(&Action::Leader).is_some_and(|strokes| {
            strokes
                .iter()
                .any(|stroke| matches!(stroke, Stroke::Plain(bound) if bound.matches(key)))
        })
    }
}

impl Key {
    /// The `keybinds` spelling of this key. Shift is left out for character
    /// keys because the character already carries its case, exactly as
    /// `parse_spec` treats `shift+e` and `E` as the same key.
    fn spec(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        for (modifier, name) in [
            (KeyModifiers::CONTROL, "ctrl"),
            (KeyModifiers::ALT, "alt"),
            (KeyModifiers::META, "meta"),
            (KeyModifiers::SUPER, "super"),
            (KeyModifiers::HYPER, "hyper"),
        ] {
            if self.modifiers.contains(modifier) {
                parts.push(name.to_string());
            }
        }
        if self.modifiers.contains(KeyModifiers::SHIFT) && !matches!(self.code, KeyCode::Char(_)) {
            parts.push("shift".to_string());
        }
        parts.push(match self.code {
            KeyCode::Esc => "esc".to_string(),
            KeyCode::Enter => "return".to_string(),
            KeyCode::Tab => "tab".to_string(),
            KeyCode::Backspace => "backspace".to_string(),
            KeyCode::Delete => "delete".to_string(),
            KeyCode::Insert => "insert".to_string(),
            KeyCode::Up => "up".to_string(),
            KeyCode::Down => "down".to_string(),
            KeyCode::Left => "left".to_string(),
            KeyCode::Right => "right".to_string(),
            KeyCode::Home => "home".to_string(),
            KeyCode::End => "end".to_string(),
            KeyCode::PageUp => "pageup".to_string(),
            KeyCode::PageDown => "pagedown".to_string(),
            KeyCode::Char(' ') => "space".to_string(),
            KeyCode::Char(c) => c.to_string(),
            KeyCode::F(number) => format!("f{number}"),
            other => format!("{other:?}").to_ascii_lowercase(),
        });
        parts.join("+")
    }

    /// Only the modifiers a terminal reports for a shortcut are compared, so
    /// `ctrl+return` stays distinct from `return`. Shift is part of the
    /// character for letters (`shift+e` and `E` are the same key), so it is
    /// compared only for keys that are not characters.
    fn matches(&self, event: &KeyEvent) -> bool {
        if self.code != event.code {
            return false;
        }
        const SHORTCUT: KeyModifiers = KeyModifiers::CONTROL
            .union(KeyModifiers::ALT)
            .union(KeyModifiers::META);
        if (self.modifiers & SHORTCUT) != (event.modifiers & SHORTCUT) {
            return false;
        }
        if matches!(self.code, KeyCode::Char(_)) {
            return true;
        }
        self.modifiers.contains(KeyModifiers::SHIFT)
            == event.modifiers.contains(KeyModifiers::SHIFT)
    }
}

fn parse_list(text: &str) -> Vec<Stroke> {
    text.split(',')
        .filter(|spec| !spec.trim().is_empty())
        .map(|spec| parse_spec(spec).expect("default bindings are valid"))
        .collect()
}

fn parse_spec(text: &str) -> Result<Stroke, String> {
    let text = text.trim();
    let (leader, rest) = match text.strip_prefix("<leader>") {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let parts: Vec<&str> = rest.split('+').collect();
    let (name, modifier_names) = parts.split_last().ok_or("empty key spec")?;
    let mut modifiers = KeyModifiers::NONE;
    for modifier in modifier_names {
        modifiers |= match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => KeyModifiers::CONTROL,
            "shift" => KeyModifiers::SHIFT,
            "alt" | "option" => KeyModifiers::ALT,
            "meta" => KeyModifiers::META,
            "super" => KeyModifiers::SUPER,
            "hyper" => KeyModifiers::HYPER,
            other => return Err(format!("unknown modifier \"{other}\"")),
        };
    }
    let code = parse_code(name, modifiers)?;
    let key = Key { code, modifiers };
    Ok(if leader {
        Stroke::Leader(key)
    } else {
        Stroke::Plain(key)
    })
}

fn parse_code(name: &str, modifiers: KeyModifiers) -> Result<KeyCode, String> {
    let code = match name.to_ascii_lowercase().as_str() {
        "escape" | "esc" => KeyCode::Esc,
        "return" | "enter" => KeyCode::Enter,
        "tab" => KeyCode::Tab,
        "backspace" => KeyCode::Backspace,
        "delete" | "del" => KeyCode::Delete,
        "insert" => KeyCode::Insert,
        "up" => KeyCode::Up,
        "down" => KeyCode::Down,
        "left" => KeyCode::Left,
        "right" => KeyCode::Right,
        "home" => KeyCode::Home,
        "end" => KeyCode::End,
        "pageup" => KeyCode::PageUp,
        "pagedown" => KeyCode::PageDown,
        "space" => KeyCode::Char(' '),
        other => {
            if let Some(number) = other.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                KeyCode::F(number)
            } else if name.chars().count() == 1 {
                // The original spelling decides the case: `shift+e` types `E`,
                // and a bare `E` is the same key.
                let character = name.chars().next().expect("one character");
                KeyCode::Char(if modifiers.contains(KeyModifiers::SHIFT) {
                    character.to_ascii_uppercase()
                } else {
                    character
                })
            } else {
                return Err(format!("unknown key \"{name}\""));
            }
        }
    };
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    fn overrides(pairs: &[(&str, Option<&[&str]>)]) -> BTreeMap<String, Option<Vec<String>>> {
        pairs
            .iter()
            .map(|(name, specs)| {
                (
                    name.to_string(),
                    specs.map(|specs| specs.iter().map(|spec| spec.to_string()).collect()),
                )
            })
            .collect()
    }

    #[test]
    fn defaults_match_the_type_script_bindings() {
        let keymap = Keymap::default();
        assert!(keymap.matches(
            Action::CommandList,
            &key(KeyCode::Char('p'), KeyModifiers::CONTROL)
        ));
        assert!(keymap.matches(
            Action::SessionRename,
            &key(KeyCode::Char('r'), KeyModifiers::CONTROL)
        ));
        assert!(keymap.matches(
            Action::SessionInterrupt,
            &key(KeyCode::Esc, KeyModifiers::NONE)
        ));
        assert!(keymap.matches(
            Action::InputNewline,
            &key(KeyCode::Enter, KeyModifiers::SHIFT)
        ));
        assert!(keymap.matches(
            Action::InputDeleteWordBackward,
            &key(KeyCode::Char('w'), KeyModifiers::CONTROL)
        ));
        // Submit and newline are told apart by the modifier, not the key.
        assert!(!keymap.matches(
            Action::InputSubmit,
            &key(KeyCode::Enter, KeyModifiers::SHIFT)
        ));
        assert!(!keymap.matches(
            Action::InputNewline,
            &key(KeyCode::Enter, KeyModifiers::NONE)
        ));
        assert!(keymap.matches(
            Action::InputNewline,
            &key(KeyCode::Enter, KeyModifiers::CONTROL)
        ));
        // `up` is bound twice; the composer action wins the generic lookup so
        // history stays the fallback when the cursor cannot move.
        assert_eq!(
            keymap.input_action(&key(KeyCode::Up, KeyModifiers::NONE)),
            Some(Action::InputMoveUp)
        );
        // `ctrl+d` is both `app_exit` and `input_delete`; the composer looks up
        // only its own actions, so the draft gets the delete.
        assert_eq!(
            keymap.input_action(&key(KeyCode::Char('d'), KeyModifiers::CONTROL)),
            Some(Action::InputDelete)
        );
    }

    #[test]
    fn leader_chords_resolve_by_action() {
        let keymap = Keymap::default();
        assert_eq!(
            keymap.leader_action(&key(KeyCode::Char('m'), KeyModifiers::NONE)),
            Some(Action::ModelList)
        );
        assert_eq!(
            keymap.leader_action(&key(KeyCode::Char('y'), KeyModifiers::NONE)),
            Some(Action::CopyMessage)
        );
        assert_eq!(
            keymap.leader_action(&key(KeyCode::Char('q'), KeyModifiers::NONE)),
            Some(Action::AppExit)
        );
    }

    #[test]
    fn an_override_replaces_the_default_strokes() {
        let keymap =
            Keymap::from_overrides(&overrides(&[("command_list", Some(&["ctrl+space"][..]))]));
        assert!(!keymap.matches(
            Action::CommandList,
            &key(KeyCode::Char('p'), KeyModifiers::CONTROL)
        ));
        assert!(keymap.matches(
            Action::CommandList,
            &key(KeyCode::Char(' '), KeyModifiers::CONTROL)
        ));
    }

    #[test]
    fn bindings_print_the_effective_strokes_including_the_leader() {
        let keymap = Keymap::default();
        let bindings: BTreeMap<Action, String> = keymap.bindings().into_iter().collect();
        // A plain chord keeps its spelling.
        assert_eq!(bindings[&Action::SessionRename], "ctrl+r");
        // A leader chord prints the configured leader, not the placeholder.
        assert_eq!(bindings[&Action::SessionNew], "ctrl+x+n");
        // Several strokes stay together, so help shows every way to reach it.
        assert_eq!(bindings[&Action::AppExit], "ctrl+c, ctrl+d, ctrl+x+q");
    }

    #[test]
    fn bindings_follow_an_override_instead_of_the_defaults() {
        let overrides = overrides(&[("session_rename", Some(&["ctrl+n"])), ("session_new", None)]);
        let bindings: BTreeMap<Action, String> = Keymap::from_overrides(&overrides)
            .bindings()
            .into_iter()
            .collect();
        assert_eq!(bindings[&Action::SessionRename], "ctrl+n");
        // An unbound action stays listed: help must not hide a removed binding.
        assert_eq!(bindings[&Action::SessionNew], "");
    }

    #[test]
    fn an_action_can_be_unbound() {
        let keymap = Keymap::from_overrides(&overrides(&[("session_new", None)]));
        assert_eq!(
            keymap.leader_action(&key(KeyCode::Char('n'), KeyModifiers::NONE)),
            None
        );
    }

    #[test]
    fn the_leader_key_itself_is_configurable() {
        let keymap = Keymap::from_overrides(&overrides(&[("leader", Some(&["ctrl+space"][..]))]));
        assert!(keymap.is_leader(&key(KeyCode::Char(' '), KeyModifiers::CONTROL)));
        assert!(!keymap.is_leader(&key(KeyCode::Char('x'), KeyModifiers::CONTROL)));
    }

    #[test]
    fn unknown_actions_and_invalid_specs_are_ignored() {
        let keymap = Keymap::from_overrides(&overrides(&[
            ("no_such_action", Some(&["ctrl+space"][..])),
            ("session_list", Some(&["nonsense+key"][..])),
        ]));
        // The invalid override leaves the action unbound rather than dangling.
        assert_eq!(
            keymap.leader_action(&key(KeyCode::Char('l'), KeyModifiers::NONE)),
            None
        );
        // Other defaults still work.
        assert!(keymap.matches(
            Action::CommandList,
            &key(KeyCode::Char('p'), KeyModifiers::CONTROL)
        ));
    }

    #[test]
    fn every_action_is_reachable_without_a_mouse() {
        // UX-02: no critical action may require a pointer. Everything the TUI
        // knows has to carry a default stroke, or the only way to reach it would
        // be a click.
        let bound = Keymap::default()
            .bindings()
            .into_iter()
            .collect::<std::collections::BTreeMap<_, _>>();
        let unbound = ACTIONS
            .iter()
            .filter(|action| !UNBOUND_BY_DEFAULT.contains(action))
            .filter(|action| bound.get(action).is_none_or(|spec| spec.is_empty()))
            .map(|action| action.name())
            .collect::<Vec<_>>();
        assert!(
            unbound.is_empty(),
            "these actions have no default key and would need a mouse: {unbound:?}"
        );
        // The exception list cannot go stale: an action named there really has
        // to be unbound, so removing a default has to be a deliberate edit here.
        for action in UNBOUND_BY_DEFAULT {
            assert!(
                bound.get(action).is_none_or(|spec| spec.is_empty()),
                "{} is listed as unbound by default but has a stroke",
                action.name()
            );
        }
    }

    #[test]
    fn the_only_shared_strokes_are_the_documented_dual_purpose_ones() {
        // INP-07: a stroke that reaches two actions is a conflict unless the
        // TUI means it — `ctrl+c` clears a draft in the composer and quits
        // everywhere else. This pins the intended overlaps, so a new accidental
        // one fails here instead of in an operator's hands.
        let mut owners: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for (action, strokes) in Keymap::default().bindings() {
            for stroke in strokes.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                owners
                    .entry(stroke.to_string())
                    .or_default()
                    .push(action.name().to_string());
            }
        }
        let shared = owners
            .into_iter()
            .filter(|(_, actions)| actions.len() > 1)
            .map(|(stroke, mut actions)| {
                actions.sort();
                (stroke, actions)
            })
            .collect::<Vec<_>>();
        // Each pair is deliberate: the composer owns the stroke while it has
        // the keyboard, and the page owns it otherwise.
        let documented = [
            // Clear a draft, or quit outside the composer.
            ("ctrl+c", vec!["app_exit", "input_clear"]),
            // Delete forward, or quit outside the composer.
            ("ctrl+d", vec!["app_exit", "input_delete"]),
            // Redo inside the composer, or copy the last message outside it.
            ("ctrl+y", vec!["input_redo", "messages_copy"]),
            // Undo inside the composer, or suspend the process outside it.
            ("ctrl+z", vec!["input_undo", "terminal_suspend"]),
            // Walk prompt history, or move inside a multi-line draft.
            ("down", vec!["history_next", "input_move_down"]),
            ("up", vec!["history_previous", "input_move_up"]),
        ];
        assert_eq!(
            shared,
            documented
                .into_iter()
                .map(|(stroke, actions)| (
                    stroke.to_string(),
                    actions.iter().map(|a| a.to_string()).collect::<Vec<_>>()
                ))
                .collect::<Vec<_>>(),
            "an unexpected shared stroke is a keybinding conflict"
        );
    }

    #[test]
    fn shift_letters_and_function_keys_parse() {
        let keymap = Keymap::from_overrides(&overrides(&[(
            "debug_view",
            Some(&["shift+f2", "<leader>P"][..]),
        )]));
        assert!(keymap.matches(Action::DebugView, &key(KeyCode::F(2), KeyModifiers::SHIFT)));
        assert_eq!(
            keymap.leader_action(&key(KeyCode::Char('P'), KeyModifiers::SHIFT)),
            Some(Action::DebugView)
        );
    }
}
