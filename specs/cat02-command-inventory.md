# CAT-02:命令面板与 slash 全量映射盘点

状态:盘点完成;无代码改动。本文是全部内置命令及其键位、slash 别名的冻结清单,
生成自 main `680d81e25f` 的源码(2026-10-30):键位声明与 CommandMap 来自
`packages/tui/src/config/keybind.ts`,slash 别名来自各 `commands` 定义。数量:
**166 个命令映射、164 个键位声明、9 个 slash 别名**。

## 可搜索性与可用性(验收 2/3)

- 命令面板(`command-palette.tsx`)输入即过滤,每个条目的 footer 显示
  `formatKeyBindings` 生成的实际键位——"可搜索、显示键位"由同一数据源保证。
- 运行中命令的可用性由各 `useBindings` 的 `enabled` 门控与命令定义的
  `enabled` 字段表达:不可用的命令仍在面板中可见(带键位),执行被拒绝
  而非静默延迟;需要排队的输入走 steer/queue 回执(prompt-send 线),
  控制动作不走队列。

## 全量清单

| 命令 | 键位 | 标题 | slash |
|---|---|---|---|
| `agent_cycle` | `tab` | Next agent | — |
| `agent_cycle_reverse` | `shift+tab` | Previous agent | — |
| `agent_list` | `<leader>a` | List agents | — |
| `app_console` | `none` | Toggle console | — |
| `app_debug` | `none` | Toggle debug panel | — |
| `app_exit` | `ctrl+c,ctrl+d,<leader>q` | Exit the application | — |
| `app_heap_snapshot` | `none` | Write heap snapshot | — |
| `app_toggle_animations` | `none` | Toggle animations | — |
| `app_toggle_diffwrap` | `none` | Toggle diff wrapping | — |
| `app_toggle_file_context` | `none` | Toggle file context | — |
| `app_toggle_paste_summary` | `none` | Toggle paste summary | — |
| `app_toggle_session_directory_filter` | `none` | Toggle session directory filtering | — |
| `command_list` | `ctrl+p` | List available commands | — |
| `debug_view` | `none` | View debug info | — |
| `diff_close` | `escape,q` | Close diff viewer | — |
| `diff_collapse` | `left` | Collapse diff viewer item | — |
| `diff_expand` | `right` | Expand diff viewer item | — |
| `diff_expand_all` | `E` | Expand all diff viewer folders | — |
| `diff_help` | `?` | Show more diff viewer shortcuts | — |
| `diff_next_file` | `n` | Jump to next diff file | — |
| `diff_next_hunk` | `]` | Jump to next diff hunk | — |
| `diff_open` | `none` | Open diff viewer | — |
| `diff_previous_file` | `p` | Jump to previous diff file | — |
| `diff_previous_hunk` | `[` | Jump to previous diff hunk | — |
| `diff_single_patch` | `s` | Toggle single patch view | — |
| `diff_switch_focus` | `tab` | Switch diff viewer focus | — |
| `diff_switch_source` | `d` | Switch diff viewer source | — |
| `diff_toggle` | `enter,space` | Toggle diff viewer item | — |
| `diff_toggle_file_tree` | `b` | Toggle diff viewer file tree | — |
| `diff_toggle_view` | `v` | Toggle diff viewer split or unified view | — |
| `display_thinking` | `none` | Toggle thinking blocks visibility | — |
| `docs_open` | `none` | Open documentation | — |
| `editor_open` | `<leader>e` | Open external editor | — |
| `help_show` | `none` | Open help dialog | — |
| `history_next` | `down` | Next history item | — |
| `history_previous` | `up` | Previous history item | — |
| `input_backspace` | `backspace,shift+backspace` | Backspace in input | — |
| `input_buffer_end` | `end,ctrl+end,super+right` | Move to end of buffer in input | — |
| `input_buffer_home` | `home,ctrl+home,super+left` | Move to start of buffer in input | — |
| `input_clear` | `ctrl+c` | Clear input field | — |
| `input_delete` | `ctrl+d,delete,shift+delete` | Delete character in input | — |
| `input_delete_line` | `ctrl+shift+d` | Delete line in input | — |
| `input_delete_to_line_end` | `ctrl+k` | Delete to end of line in input | — |
| `input_delete_to_line_start` | `ctrl+u` | Delete to start of line in input | — |
| `input_delete_word_backward` | `ctrl+w,ctrl+backspace,alt+backspace` | Delete word backward in input | — |
| `input_delete_word_forward` | `alt+d,alt+delete,ctrl+delete` | Delete word forward in input | — |
| `input_line_end` | `ctrl+e` | Move to end of line in input | — |
| `input_line_home` | `ctrl+a` | Move to start of line in input | — |
| `input_move_down` | `down` | Move cursor down in input | — |
| `input_move_left` | `left,ctrl+b` | Move cursor left in input | — |
| `input_move_right` | `right,ctrl+f` | Move cursor right in input | — |
| `input_move_up` | `up` | Move cursor up in input | — |
| `input_newline` | `shift+return,ctrl+return,alt+return,ctrl+j` | Insert newline in input | — |
| `input_paste` | `(unbound)` |  | — |
| `input_redo` | `ctrl+.,super+shift+z` | Redo in input | — |
| `input_select_all` | `super+a` | Select all in input | — |
| `input_select_buffer_end` | `shift+end,ctrl+shift+end,super+shift+right` | Select to end of buffer in input | — |
| `input_select_buffer_home` | `(unbound)` |  | — |
| `input_select_down` | `shift+down` | Select down in input | — |
| `input_select_left` | `shift+left` | Select left in input | — |
| `input_select_line_end` | `ctrl+shift+e` | Select to end of line in input | — |
| `input_select_line_home` | `ctrl+shift+a` | Select to start of line in input | — |
| `input_select_right` | `shift+right` | Select right in input | — |
| `input_select_up` | `shift+up` | Select up in input | — |
| `input_select_visual_line_end` | `alt+shift+e` | Select to end of visual line in input | — |
| `input_select_visual_line_home` | `alt+shift+a` | Select to start of visual line in input | — |
| `input_select_word_backward` | `alt+shift+b,alt+shift+left` | Select word backward in input | — |
| `input_select_word_forward` | `alt+shift+f,alt+shift+right` | Select word forward in input | — |
| `input_submit` | `return` | Submit input | — |
| `input_undo` | `ctrl+-,super+z` | Undo in input | — |
| `input_visual_line_end` | `alt+e` | Move to end of visual line in input | — |
| `input_visual_line_home` | `alt+a` | Move to start of visual line in input | — |
| `input_word_backward` | `alt+b,alt+left,ctrl+left` | Move word backward in input | — |
| `input_word_forward` | `alt+f,alt+right,ctrl+right` | Move word forward in input | — |
| `mcp_list` | `none` | List MCP servers | — |
| `messages_copy` | `<leader>y` | Copy message | — |
| `messages_first` | `ctrl+g,home` | Navigate to first message | — |
| `messages_half_page_down` | `ctrl+alt+d` | Scroll messages down by half page | — |
| `messages_half_page_up` | `ctrl+alt+u` | Scroll messages up by half page | — |
| `messages_last` | `ctrl+alt+g,end` | Navigate to last message | — |
| `messages_last_user` | `none` | Navigate to last user message | — |
| `messages_line_down` | `ctrl+alt+e` | Scroll messages down by one line | — |
| `messages_line_up` | `ctrl+alt+y` | Scroll messages up by one line | — |
| `messages_next` | `none` | Navigate to next message | — |
| `messages_page_down` | `pagedown,ctrl+alt+f` | Scroll messages down by one page | — |
| `messages_page_up` | `pageup,ctrl+alt+b` | Scroll messages up by one page | — |
| `messages_previous` | `none` | Navigate to previous message | — |
| `messages_redo` | `<leader>r` | Redo message | — |
| `messages_toggle_conceal` | `<leader>h` | Toggle code block concealment in messages | — |
| `messages_undo` | `<leader>u` | Undo message | — |
| `model_cycle_favorite` | `none` | Next favorite model | — |
| `model_cycle_favorite_reverse` | `none` | Previous favorite model | — |
| `model_cycle_recent` | `f2` | Next recently used model | — |
| `model_cycle_recent_reverse` | `shift+f2` | Previous recently used model | — |
| `model_favorite_toggle` | `ctrl+f` | Toggle model favorite status | — |
| `model_list` | `<leader>m` | List available models | — |
| `model_provider_list` | `ctrl+a` | Open provider list from model dialog | — |
| `plugin_install` | `none` | Install plugin | — |
| `plugin_manager` | `none` | Open plugin manager dialog | — |
| `prompt_editor_context_clear` | `none` | Clear editor context | — |
| `prompt_skills` | `none` | Open skill selector | — |
| `prompt_stash` | `none` | Stash prompt | — |
| `prompt_stash_list` | `none` | List stashed prompts | — |
| `prompt_stash_pop` | `none` | Pop stashed prompt | — |
| `prompt_submit` | `none` | Submit prompt | — |
| `provider_account_add` | `alt+n` | Add provider account | — |
| `provider_account_pin` | `ctrl+y` | Use provider account in this session | — |
| `provider_account_remove` | `ctrl+d` | Remove provider account | — |
| `provider_account_rename` | `ctrl+r` | Rename provider account | — |
| `provider_accounts` | `ctrl+o` | Manage provider accounts | — |
| `provider_connect` | `none` | Connect provider | — |
| `scrollbar_toggle` | `none` | Toggle session scrollbar | — |
| `session_background` | `ctrl+b` | Background synchronous subagents | — |
| `session_child_cycle` | `right` | Go to next child session | — |
| `session_child_cycle_reverse` | `left` | Go to previous child session | — |
| `session_child_first` | `<leader>down` | Go to first child session | — |
| `session_compact` | `<leader>c` | Compact the session | — |
| `session_copy` | `none` | Copy session transcript | — |
| `session_delete` | `ctrl+d` | Delete session | — |
| `session_export` | `<leader>x` | Export session to editor | — |
| `session_fork` | `none` | Fork session from message | — |
| `session_interrupt` | `escape` | Cancel newest waiting prompt, or interrupt | — |
| `session_list` | `<leader>l` | List all sessions | — |
| `session_move` | `none` | Move session | — |
| `session_new` | `<leader>n` | Create a new session | — |
| `session_parent` | `up` | Go to parent session | — |
| `session_pin_toggle` | `ctrl+f` | Pin or unpin session in the session list | — |
| `session_queued_prompts` | `<leader>q` | Manage queued prompts | — |
| `session_quick_switch_1` | `<leader>1` | Switch to session in quick slot 1 | — |
| `session_quick_switch_2` | `<leader>2` | Switch to session in quick slot 2 | — |
| `session_quick_switch_3` | `<leader>3` | Switch to session in quick slot 3 | — |
| `session_quick_switch_4` | `<leader>4` | Switch to session in quick slot 4 | — |
| `session_quick_switch_5` | `<leader>5` | Switch to session in quick slot 5 | — |
| `session_quick_switch_6` | `<leader>6` | Switch to session in quick slot 6 | — |
| `session_quick_switch_7` | `<leader>7` | Switch to session in quick slot 7 | — |
| `session_quick_switch_8` | `<leader>8` | Switch to session in quick slot 8 | — |
| `session_quick_switch_9` | `<leader>9` | Switch to session in quick slot 9 | — |
| `session_rename` | `ctrl+r` | Rename session | — |
| `session_subagent_toggle` | `<leader>enter` | Expand or collapse the inline subagent transcript | — |
| `session_timeline` | `<leader>g` | Show session timeline | — |
| `session_toggle_generic_tool_output` | `none` | Toggle generic tool output | — |
| `session_toggle_timestamps` | `none` | Toggle message timestamps | — |
| `sidebar_toggle` | `<leader>b` | Toggle sidebar | — |
| `stash_delete` | `ctrl+d` | Delete stash entry | — |
| `status_view` | `<leader>s` | View status | — |
| `terminal_suspend` | `ctrl+z` | Suspend terminal | — |
| `terminal_title_toggle` | `none` | Toggle terminal title | — |
| `theme_list` | `<leader>t` | List available themes | — |
| `theme_mode_lock` | `none` | Lock or unlock theme mode | — |
| `theme_switch_mode` | `none` | Switch between light and dark theme mode | — |
| `tips_toggle` | `<leader>h` | Toggle tips on home screen | — |
| `tool_details` | `none` | Toggle tool details visibility | — |
| `variant_cycle` | `ctrl+t` | Cycle model variants | — |
| `variant_list` | `none` | List model variants | — |
| `which_key_end` | `ctrl+alt+end` | Jump to last which-key binding | — |
| `which_key_group_next` | `ctrl+alt+right,ctrl+alt+]` | Next which-key group | — |
| `which_key_group_previous` | `ctrl+alt+left,ctrl+alt+[` | Previous which-key group | — |
| `which_key_home` | `ctrl+alt+home` | Jump to first which-key binding | — |
| `which_key_layout_toggle` | `ctrl+alt+shift+k` | Switch which-key layout | — |
| `which_key_page_down` | `ctrl+alt+pagedown` | Page which-key down | — |
| `which_key_page_up` | `ctrl+alt+pageup` | Page which-key up | — |
| `which_key_pending_toggle` | `ctrl+alt+shift+p` | Toggle which-key pending preview | — |
| `which_key_scroll_down` | `ctrl+alt+down,ctrl+alt+n` | Scroll which-key down | — |
| `which_key_scroll_up` | `ctrl+alt+up,ctrl+alt+p` | Scroll which-key up | — |
| `which_key_toggle` | `ctrl+alt+k` | Toggle which-key panel | — |
| `workspace_set` | `none` | Set workspace | — |

本清单即验收 1 的盘点;清单本身由脚本从源码生成,可在键位变更后重新生成。