#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
extension_path=${POWERLINE_E2E_EXTENSION_PATH:-"$repo/index.ts"}
editor_fixture_path="$repo/tests/e2e/fixtures/editor-click.ts"
status_fixture_path="$repo/tests/e2e/fixtures/status-segments.ts"
queue_abort_fixture_path="$repo/tests/e2e/fixtures/queue-abort.ts"
temp_root=$(mktemp -d /tmp/pi-powerline-regressions-e2e.XXXXXX)
active_socket=""
active_session=""
case_number=0
CURRENT_RESULT_PATH=""
CURRENT_STATE_DIR=""
CURRENT_WORK_DIR=""
CURRENT_CASE_ROOT=""

cleanup_session() {
  if [[ -n "$active_socket" ]]; then
    env -u TMUX -u TMUX_PANE tmux -L "$active_socket" kill-server >/dev/null 2>&1 || true
    active_socket=""
    active_session=""
  fi
}

cleanup() {
  cleanup_session
  if [[ "$temp_root" == /tmp/pi-powerline-regressions-e2e.* ]]; then
    rm -rf -- "$temp_root"
  fi
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  if [[ -n "$active_socket" ]]; then
    printf '%s\n' '--- readable pane ---' >&2
    capture_plain | tail -40 >&2 || true
    printf '%s\n' '--- ANSI pane ---' >&2
    capture_ansi | tail -20 | sed $'s/\033/<ESC>/g' >&2 || true
  fi
  exit 1
}

capture_plain() {
  env -u TMUX -u TMUX_PANE tmux -L "$active_socket" capture-pane -p -t "$active_session" -S 0
}

capture_ansi() {
  env -u TMUX -u TMUX_PANE tmux -L "$active_socket" capture-pane -p -e -t "$active_session" -S 0
}

send_literal() {
  env -u TMUX -u TMUX_PANE tmux -L "$active_socket" send-keys -t "$active_session" -l -- "$1"
}

send_key() {
  env -u TMUX -u TMUX_PANE tmux -L "$active_socket" send-keys -t "$active_session" "$1"
}

wait_for_text() {
  local text=$1
  local timeout_ms=${2:-10000}
  local attempts=$((timeout_ms / 50))
  local attempt
  for ((attempt=1; attempt<=attempts; attempt++)); do
    if capture_plain 2>/dev/null | grep -Fq -- "$text"; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

wait_for_file() {
  local path=$1
  local timeout_ms=${2:-3000}
  local attempts=$((timeout_ms / 30))
  local attempt
  for ((attempt=1; attempt<=attempts; attempt++)); do
    [[ -f "$path" ]] && return 0
    sleep 0.03
  done
  return 1
}

write_keybindings() {
  local state_dir=$1
  cat > "$state_dir/keybindings.json" <<'JSON'
{
  "app.thinking.cycle": ["ctrl+t"],
  "app.thinking.toggle": ["alt+k"]
}
JSON
}

write_settings() {
  local state_dir=$1
  local placement=$2
  local alignment=${3:-left}
  local wrapper=${4:-brackets}
  mkdir -p "$state_dir"
  cat > "$state_dir/settings.json" <<JSON
{
  "quietStartup": true,
  "tuiMode": "fullscreen",
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "high",
  "powerlineShortcuts": {
    "editorStart": "ctrl+shift+a",
    "editorEnd": "ctrl+shift+e"
  },
  "powerline": {
    "welcome": false,
    "preset": "ascii",
    "placement": "$placement",
    "separator": "dot",
    "showLastPrompt": false,
    "model": { "color": "#12ab34", "bold": true },
    "modelThinking": { "wrapper": "$wrapper" },
    "sessionTitle": { "enabled": true, "alignment": "$alignment" },
    "layout": {
      "left": ["model_thinking", "shell_mode", "path"],
      "right": ["context_pct"],
      "secondary": ["extension_statuses"]
    }
  }
}
JSON
  write_keybindings "$state_dir"
}

prepare_case() {
  local name=$1
  cleanup_session
  case_number=$((case_number + 1))
  CURRENT_CASE_ROOT="$temp_root/$case_number-$name"
  local home_dir="$CURRENT_CASE_ROOT/home"
  CURRENT_STATE_DIR="$home_dir/.pi/agent"
  CURRENT_WORK_DIR="$home_dir/work"
  CURRENT_RESULT_PATH="$CURRENT_CASE_ROOT/result.txt"
  mkdir -p "$CURRENT_WORK_DIR/alpha" "$CURRENT_WORK_DIR/beta" "$CURRENT_STATE_DIR"
  active_socket="pi-e2e-powerline-regressions-$$-$case_number"
  active_session="case-$case_number"
}

launch_tmux() {
  local columns=$1
  local rows=$2
  shift 2
  local -a command=("$@")
  local command_string
  printf -v command_string '%q ' "${command[@]}"
  env -u TMUX -u TMUX_PANE tmux -L "$active_socket" new-session -d \
    -s "$active_session" -n "$active_session" -x "$columns" -y "$rows" -c "$CURRENT_WORK_DIR" \
    "$command_string"
}

start_case() {
  local name=$1
  local placement=$2
  local columns=$3
  local rows=$4
  local title=${5:-"POWERLINE-E2E-$name"}
  local scan_startup=${6:-no}
  local alignment=${7:-left}
  local wrapper=${8:-brackets}

  prepare_case "$name"
  write_settings "$CURRENT_STATE_DIR" "$placement" "$alignment" "$wrapper"
  launch_tmux "$columns" "$rows" \
    env HOME="$CURRENT_CASE_ROOT/home" PI_CODING_AGENT_DIR="$CURRENT_STATE_DIR" PI_OFFLINE=1 \
    CLICK_RESULT_PATH="$CURRENT_RESULT_PATH" TERM=tmux-256color COLORTERM=truecolor \
    COLUMNS="$columns" LINES="$rows" \
    pi --tui-mode fullscreen --no-session --no-context-files \
    --no-prompt-templates --no-themes --no-extensions --no-skills --no-tools \
    --provider openai-codex --model gpt-5.6-sol \
    --name "$title" -e "$extension_path" -e "$editor_fixture_path" -e "$status_fixture_path"

  if [[ "$scan_startup" == yes ]]; then
    scan_transition startup 150 no
  fi
  wait_for_text 'dir ' 12000 \
    || fail "Powerline did not become ready for $name at ${columns}x${rows}"
}

assert_geometry_and_style() {
  local placement=$1
  local columns=$2
  local rows=$3
  local alignment=${4:-left}
  local title='LAYOUT-ALPHA-BRAVO-CHARLIE-DELTA-ECHO-FOXTROT-GOLF'
  start_case "layout-$placement-$columns-$alignment" "$placement" "$columns" "$rows" "$title" no "$alignment"

  local pane flat title_line editor_line primary_line path_line status_line rendered_title
  pane=$(capture_plain)
  flat=$(printf '%s' "$pane" | tr -d '[:space:]')
  [[ "$flat" == *"$title"* ]] || fail "$placement title was clipped at ${columns}x${rows}"
  [[ "$pane" != *shell_mode* && "$pane" != *'Bash mode'* ]] \
    || fail 'deprecated shell_mode segment rendered'

  title_line=$(printf '%s\n' "$pane" | grep -n -m1 'LAYOUT-ALPHA' | cut -d: -f1 || true)
  editor_line=$(printf '%s\n' "$pane" | grep -n -m1 '^>' | cut -d: -f1 || true)
  primary_line=$(printf '%s\n' "$pane" | grep -En -m1 '\[high\]| high( |$)' | cut -d: -f1 || true)
  path_line=$(printf '%s\n' "$pane" | grep -n -m1 'dir ' | cut -d: -f1 || true)
  status_line=$(printf '%s\n' "$pane" | grep -n -m1 'RED.*GREEN.*SECONDARY-E2E' | cut -d: -f1 || true)
  [[ -n "$title_line" && -n "$editor_line" && -n "$primary_line" && -n "$path_line" && -n "$status_line" ]] \
    || fail "could not locate all footer rows at ${columns}x${rows}"

  if [[ "$placement" == above ]]; then
    (( primary_line < editor_line && editor_line < title_line )) \
      || fail "above placement order was not primary, editor, title at ${columns}x${rows}"
    if (( columns == 50 )); then
      (( title_line < path_line && path_line <= status_line )) \
        || fail 'above narrow order was not primary, editor, title, overflow'
    fi
  else
    (( title_line < editor_line && editor_line < primary_line && primary_line <= status_line )) \
      || fail "below placement order was not title, editor, primary, overflow at ${columns}x${rows}"
  fi

  rendered_title=$(printf '%s\n' "$pane" | grep -m1 'LAYOUT-ALPHA' || true)
  [[ "$rendered_title" != *'…'* ]] || fail 'full session title used an ellipsis'
  if [[ "$alignment" == right ]]; then
    [[ "$rendered_title" =~ ^[[:space:]]+LAYOUT-ALPHA ]] \
      || fail 'right-aligned session title did not have left padding'
    [[ "$rendered_title" == *GOLF ]] || fail 'right-aligned session title did not reach its right edge'
  else
    [[ "$rendered_title" == LAYOUT-ALPHA* ]] || fail 'left-aligned session title had unexpected left padding'
  fi

  local status_text
  status_text=$(printf '%s\n' "$pane" | grep -m1 'RED.*GREEN.*SECONDARY-E2E' || true)
  [[ "$status_text" == *'RED · GREEN · SECONDARY-E2E'* ]] \
    || fail 'extension status separator adjacency changed'
  [[ "$status_text" != *'RED  '* && "$status_text" != *'  GREEN'* ]] \
    || fail 'extension status row gained duplicate spaces'

  if (( columns == 282 )); then
    local primary_text
    primary_text=$(printf '%s\n' "$pane" | grep -E -m1 '\[high\]| high( |$)' || true)
    [[ "$primary_text" == *'%'* ]] || fail 'wide right-side context segment was not in the primary row'
    (( ${#primary_text} == columns )) \
      || fail "wide right-side context ended at column ${#primary_text}, expected $columns"
  fi

  if (( columns == 80 )) && [[ "$placement" == below && "$alignment" == left ]]; then
    local ansi model_ansi status_ansi
    ansi=$(capture_ansi)
    model_ansi=$(printf '%s\n' "$ansi" | grep -m1 'GPT-5.6 Sol' || true)
    status_ansi=$(printf '%s\n' "$ansi" | grep -m1 'RED.*GREEN.*SECONDARY-E2E' || true)
    [[ "$model_ansi" == *$'\033[38;2;18;171;52m'* && "$model_ansi" == *$'\033[1m'* ]] \
      || fail 'custom #12ab34 bold model styling was not present in the rendered ANSI'
    [[ "$status_ansi" == *$'\033[31mRED'* && "$status_ansi" == *$'\033[38;2;102;102;102m · '* \
      && "$status_ansi" == *$'\033[32mGREEN'* ]] \
      || fail 'status ANSI did not transition red, separator gray, green'
  fi
}

write_config_matrix_settings() {
  local session_title=${1:-}
  local session_title_line=""
  if [[ -n "$session_title" ]]; then
    session_title_line="    \"sessionTitle\": $session_title,"
  fi
  cat > "$CURRENT_STATE_DIR/settings.json" <<JSON
{
  "quietStartup": true,
  "tuiMode": "fullscreen",
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "high",
  "powerline": {
    "welcome": false,
    "separator": "dot",
    "showLastPrompt": false,
$session_title_line
    "layout": {
      "left": ["model_thinking", "path"],
      "right": ["context_pct"],
      "secondary": ["extension_statuses"]
    }
  }
}
JSON
  write_keybindings "$CURRENT_STATE_DIR"
}

launch_config_matrix_case() {
  local title=$1
  shift
  launch_tmux 100 28 \
    env HOME="$CURRENT_CASE_ROOT/home" PI_CODING_AGENT_DIR="$CURRENT_STATE_DIR" PI_OFFLINE=1 \
    TERM=tmux-256color COLORTERM=truecolor COLUMNS=100 LINES=28 \
    pi --tui-mode fullscreen "$@" --no-context-files --no-prompt-templates \
    --no-themes --no-extensions --no-skills --no-tools --provider openai-codex \
    --model gpt-5.6-sol --name "$title" -e "$extension_path" -e "$status_fixture_path"
  wait_for_text 'dir ' 12000 || fail "$title config case did not become ready"
}

assert_config_and_context_defaults() {
  prepare_case config-defaults
  write_config_matrix_settings
  local session_path="$CURRENT_CASE_ROOT/unknown-context.jsonl"
  cat > "$session_path" <<JSONL
{"type":"session","version":3,"id":"50000000-0000-4000-8000-000000000001","timestamp":"2026-01-01T00:00:00.000Z","cwd":"$CURRENT_WORK_DIR"}
{"type":"message","id":"user0001","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z","message":{"role":"user","content":"unknown context fixture","timestamp":1767225600001}}
{"type":"compaction","id":"compact1","parentId":"user0001","timestamp":"2026-01-01T00:00:00.002Z","summary":"model-free summary","firstKeptEntryId":"user0001","tokensBefore":1234}
JSONL
  launch_config_matrix_case DEFAULT-TITLE-MUST-STAY-HIDDEN --session "$session_path"
  local pane ansi status_line model_line
  pane=$(capture_plain)
  [[ "$pane" != *DEFAULT-TITLE-MUST-STAY-HIDDEN* ]] \
    || fail 'sessionTitle rendered even though the option was omitted'
  grep -Fq '?/272k' <<<"$pane" || fail 'unknown compacted-session context did not render ?/272k'
  status_line=$(printf '%s\n' "$pane" | grep -m1 'RED.*GREEN.*SECONDARY-E2E' || true)
  [[ "$status_line" == *'RED · GREEN · SECONDARY-E2E'* ]] \
    || fail 'default config did not preserve the exact single-spaced dot separator row'
  ansi=$(capture_ansi)
  model_line=$(printf '%s\n' "$ansi" | grep -m1 'GPT-5.6 Sol' || true)
  [[ "$model_line" == *$'\033[38;2;215;135;175m'* ]] \
    || fail 'default model color did not fall back to #d787af'

  prepare_case config-title-disabled
  write_config_matrix_settings '{ "enabled": false }'
  launch_config_matrix_case EXPLICIT-TITLE-MUST-STAY-HIDDEN --no-session
  ! capture_plain | grep -Fq EXPLICIT-TITLE-MUST-STAY-HIDDEN \
    || fail 'explicitly disabled sessionTitle rendered'

  prepare_case config-title-default-left
  write_config_matrix_settings '{ "enabled": true }'
  launch_config_matrix_case DEFAULT-LEFT-SESSION-TITLE --no-session
  local title_line
  title_line=$(capture_plain | grep -m1 DEFAULT-LEFT-SESSION-TITLE || true)
  [[ "$title_line" == DEFAULT-LEFT-SESSION-TITLE* ]] \
    || fail 'sessionTitle without alignment was not left-aligned'
}

footer_ansi_line() {
  capture_ansi | grep 'dir ' | tail -1
}

footer_plain_line() {
  capture_plain | grep 'dir ' | tail -1
}

wait_for_level() {
  local level=$1
  local attempt
  for ((attempt=1; attempt<=100; attempt++)); do
    if footer_plain_line 2>/dev/null | grep -Fq -- "$level"; then
      return 0
    fi
    sleep 0.03
  done
  return 1
}

assert_thinking_wrappers() {
  local wrapper expected
  for wrapper in none parentheses brackets; do
    case "$wrapper" in
      none) expected='GPT-5.6 Sol high' ;;
      parentheses) expected='GPT-5.6 Sol (high)' ;;
      brackets) expected='GPT-5.6 Sol [high]' ;;
    esac
    start_case "thinking-wrapper-$wrapper" below 80 24 "WRAPPER-$wrapper" no left "$wrapper"
    footer_plain_line | grep -Fq -- "$expected" \
      || fail "$wrapper model_thinking wrapper did not render '$expected'"
  done
}

assert_thinking_cycle() {
  start_case thinking below 80 24 THINKING-E2E

  wait_for_level high || fail 'initial high thinking level did not render'
  local high_a high_b xhigh_a xhigh_b max_a max_b off_line
  high_a=$(footer_ansi_line)
  sleep 0.35
  high_b=$(footer_ansi_line)
  [[ "$high_a" == "$high_b" ]] || fail 'high thinking level animated unexpectedly'
  local color
  for color in \
    '178;129;214' '215;135;175' '254;188;56' '228;192;15' '137;210;129' '0;175;175'; do
    [[ "$high_a" == *"${color}m"* ]] || fail "high thinking rainbow omitted RGB $color"
  done

  send_key C-t
  wait_for_level xhigh || fail 'ctrl+t did not advance high to xhigh'
  xhigh_a=$(footer_ansi_line)
  sleep 0.35
  xhigh_b=$(footer_ansi_line)
  [[ "$xhigh_a" == "$xhigh_b" ]] || fail 'xhigh thinking level animated unexpectedly'
  [[ "$xhigh_a" == *$'\033[1m'* ]] || fail 'xhigh thinking level was not bold'
  for color in '190;148;220' '221;153;187' '254;198;86' '232;201;51' '155;217;148'; do
    [[ "$xhigh_a" == *"${color}m"* ]] || fail "xhigh thinking rainbow omitted bright RGB $color"
  done

  send_key C-t
  wait_for_level max || fail 'ctrl+t did not advance xhigh to max'
  max_a=$(footer_ansi_line)
  sleep 0.35
  max_b=$(footer_ansi_line)
  [[ "$max_a" != "$max_b" ]] || fail 'max thinking level did not animate'

  send_key C-t
  local attempt
  for ((attempt=1; attempt<=100; attempt++)); do
    off_line=$(footer_plain_line || true)
    if [[ -n "$off_line" ]] && ! grep -Eq '(minimal|low|medium|high|xhigh|max)' <<<"$off_line"; then
      return 0
    fi
    sleep 0.03
  done
  fail 'ctrl+t did not hide the off thinking level'
}

assert_restored_max() {
  prepare_case restored-max
  write_settings "$CURRENT_STATE_DIR" below left brackets
  local session_path="$CURRENT_CASE_ROOT/restored-max.jsonl"
  cat > "$session_path" <<JSONL
{"type":"session","version":3,"id":"00000000-0000-4000-8000-000000000001","timestamp":"2026-01-01T00:00:00.000Z","cwd":"$CURRENT_WORK_DIR"}
{"type":"message","id":"user0001","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z","message":{"role":"user","content":"restore fixture","timestamp":1767225600001}}
{"type":"thinking_level_change","id":"think001","parentId":"user0001","timestamp":"2026-01-01T00:00:00.002Z","thinkingLevel":"max"}
JSONL
  launch_tmux 80 24 \
    env HOME="$CURRENT_CASE_ROOT/home" PI_CODING_AGENT_DIR="$CURRENT_STATE_DIR" PI_OFFLINE=1 \
    TERM=tmux-256color COLORTERM=truecolor COLUMNS=80 LINES=24 \
    pi --tui-mode fullscreen --session "$session_path" --no-context-files \
    --no-prompt-templates --no-themes --no-extensions --no-skills --no-tools \
    --provider openai-codex --model gpt-5.6-sol -e "$extension_path"

  local frame pane powerline_frames=0 stale_frames=0
  for ((frame=1; frame<=250; frame++)); do
    pane=$(capture_plain 2>/dev/null || true)
    if grep -Fq 'GPT-5.6 Sol' <<<"$pane"; then
      powerline_frames=$((powerline_frames + 1))
      grep -Fq '[max]' <<<"$pane" || stale_frames=$((stale_frames + 1))
      grep -Fq '[max]' <<<"$pane" && break
    fi
    sleep 0.02
  done
  (( powerline_frames > 0 && stale_frames == 0 )) \
    || fail "restored max showed $stale_frames stale Powerline frames"

  local max_a max_b
  max_a=$(footer_ansi_line)
  sleep 0.35
  max_b=$(footer_ansi_line)
  [[ "$max_a" != "$max_b" ]] || fail 'restored max thinking did not animate'
}

assert_menu() {
  local input=$1
  shift
  send_key C-u
  send_literal "$input"
  local expected last_expected=""
  for expected in "$@"; do
    wait_for_text "$expected" 3000 || fail "$input menu omitted $expected"
    last_expected=$expected
  done
  local pane last_item_line boundary_line border_found=no offset
  pane=$(capture_plain)
  last_item_line=$(printf '%s\n' "$pane" | grep -Fn "$last_expected" | tail -1 | cut -d: -f1 || true)
  [[ -n "$last_item_line" ]] || fail "$input menu lost its final visible item"
  for offset in 1 2; do
    boundary_line=$(printf '%s\n' "$pane" | sed -n "$((last_item_line + offset))p")
    if [[ "$boundary_line" == *'──────────'* && "${boundary_line//─/}" =~ ^[[:space:]]*$ ]]; then
      border_found=yes
      break
    fi
  done
  [[ "$border_found" == yes ]] \
    || fail "$input menu omitted its closing border within two lines of the final visible item"
}

assert_editor_text() {
  local text=$1
  local timeout_ms=${2:-3000}
  local attempts=$((timeout_ms / 30))
  local attempt pane
  for ((attempt=1; attempt<=attempts; attempt++)); do
    pane=$(capture_plain 2>/dev/null || true)
    if printf '%s\n' "$pane" | grep '^>' | tail -1 | grep -Fq -- "$text"; then
      return 0
    fi
    sleep 0.03
  done
  return 1
}

assert_commands_shortcuts_and_history() {
  start_case commands below 80 30 COMMANDS-E2E

  assert_menu '/powerline ' 'placement' 'default' 'minimal' 'compact'
  assert_menu '/vibe ' 'off' 'mode' 'model' 'generate'
  assert_menu '/queue ' 'alias' 'send' 'retry' 'clear'
  assert_menu '/cd a' 'alpha/'

  send_key C-u
  send_literal 'middle'
  send_literal $'\033[97;6u'
  send_literal 'START-'
  send_literal $'\033[101;6u'
  send_literal '-END'
  send_key Enter
  wait_for_file "$CURRENT_RESULT_PATH" 3000 || fail 'configured boundary shortcuts did not submit text'
  local actual
  actual=$(cat "$CURRENT_RESULT_PATH")
  [[ "$actual" == 'START-middle-END' ]] || fail "configured boundary shortcuts submitted '$actual'"

  send_literal '/queue'
  send_key Enter
  wait_for_text 'No queued items' 3000 || fail '/queue did not acknowledge an empty queue'

  send_key C-u
  send_literal '!printf E2E_NATIVE_HISTORY'
  send_key Enter
  wait_for_text 'E2E_NATIVE_HISTORY' 3000 || fail 'native bash history command did not run'
  send_key Up
  assert_editor_text '!printf E2E_NATIVE_HISTORY' \
    || fail 'Up did not recall the native history item before reload'
  send_key C-a
  send_key C-k
  send_literal '/reload'
  send_key Enter
  wait_for_text 'Reloaded keybindings' 5000 || fail '/reload did not complete during history test'
  send_key Up
  assert_editor_text '!printf E2E_NATIVE_HISTORY' \
    || fail 'Up did not recall the native history item after reload reconstruction'
  send_key C-a
  send_key C-k
}

assert_dynamic_completions() {
  prepare_case dynamic-completions
  write_settings "$CURRENT_STATE_DIR" below left brackets
  mkdir -p "$CURRENT_STATE_DIR/powerline-footer" "$CURRENT_STATE_DIR/vibes"
  cat > "$CURRENT_STATE_DIR/powerline-footer/inbox.jsonl" <<JSONL
{"id":"dyn12345","text":"DYNAMIC-COMPLETION-PREVIEW","createdAt":1767225600000,"updatedAt":1767225600000,"source":{"cwd":"$CURRENT_WORK_DIR"},"target":{"kind":"global"},"intent":"follow-up","status":"queued"}
JSONL
  printf '{"alphaalias":"%s/alpha"}\n' "$CURRENT_WORK_DIR" \
    > "$CURRENT_STATE_DIR/powerline-footer/projects.json"
  printf 'one...\n' > "$CURRENT_STATE_DIR/vibes/neon-river.txt"
  launch_tmux 110 34 \
    env HOME="$CURRENT_CASE_ROOT/home" PI_CODING_AGENT_DIR="$CURRENT_STATE_DIR" PI_OFFLINE=1 \
    TERM=tmux-256color COLORTERM=truecolor COLUMNS=110 LINES=34 \
    pi --tui-mode fullscreen --no-session --no-context-files --no-prompt-templates \
    --no-themes --no-extensions --no-skills --no-tools \
    --provider openai-codex --model gpt-5.6-sol -e "$extension_path"
  wait_for_text 'dir ' 12000 || fail 'dynamic completion case did not become ready'

  local pane
  send_literal '/sta'
  sleep 0.25
  pane=$(capture_plain)
  ! grep -Eq '^[[:space:]→]*stash([[:space:]]|$)' <<<"$pane" \
    || fail 'removed /stash command appeared in filtered completions'
  send_key C-u
  send_literal '/bash'
  sleep 0.25
  pane=$(capture_plain)
  ! grep -Eq '^[[:space:]→]*bash([[:space:]]|$)' <<<"$pane" \
    || fail 'removed /bash command appeared in filtered completions'

  send_key C-u
  send_literal '/queue send dyn'
  wait_for_text 'send dyn12345' 3000 || fail 'queue ID completion did not use the live inbox'
  wait_for_text 'DYNAMIC-COMPLETION-PREVIEW' 3000 \
    || fail 'queue ID completion omitted the queued prompt preview'
  send_key C-u
  send_literal '/queue target dyn12345 '
  wait_for_text 'target dyn12345 @alphaalias' 3000 \
    || fail 'queue target completion did not use the live project alias'
  send_key C-u
  send_literal '/vibe neo'
  wait_for_text 'neon-river' 3000 || fail '/vibe did not complete a saved vibe filename'
}

has_native_footer() {
  grep -Eq '↑[0-9]+ ↓[0-9]+|\([0-9]+%\).*cost'
}

scan_transition() {
  local label=$1
  local frames=$2
  local require_powerline_every_frame=$3
  local completion_marker=${4:-}
  local powerline_frames=0
  local native_frames=0
  local completion_frames=0
  local frame pane
  for ((frame=1; frame<=frames; frame++)); do
    pane=$(capture_plain 2>/dev/null || true)
    grep -Fq 'dir ' <<<"$pane" && powerline_frames=$((powerline_frames + 1))
    has_native_footer <<<"$pane" && native_frames=$((native_frames + 1))
    if [[ -n "$completion_marker" ]] && grep -Fq "$completion_marker" <<<"$pane"; then
      completion_frames=$((completion_frames + 1))
    fi
    sleep 0.02
  done
  (( native_frames == 0 )) || fail "$label showed the native footer in $native_frames/$frames frames"
  if [[ "$require_powerline_every_frame" == yes ]]; then
    (( powerline_frames == frames )) \
      || fail "$label kept Powerline in only $powerline_frames/$frames frames"
  else
    (( powerline_frames > 0 )) || fail "$label never rendered Powerline"
  fi
  if [[ -n "$completion_marker" ]]; then
    (( completion_frames > 0 )) \
      || fail "$label did not show '$completion_marker' during its $frames-frame scan"
  fi
}

assert_lifecycle() {
  start_case lifecycle below 80 24 LIFECYCLE-E2E yes
  send_key C-u
  send_literal '/reload'
  send_key Enter
  scan_transition reload 100 yes 'Reloaded keybindings'
  send_key C-u
  send_literal '/new'
  send_key Enter
  scan_transition session-reset 100 yes 'New session started'
}

write_rgb_theme() {
  local theme_path=$1
  cat > "$theme_path" <<'JSON'
{
  "name": "e2e-rgb",
  "vars": {
    "text": "#d4d4d4",
    "accent": "#8abeb7",
    "border": "#234567",
    "section": "#345678",
    "muted": "#456789",
    "dim": "#56789a",
    "green": "#12ab34",
    "red": "#cc6666",
    "yellow": "#ffff00",
    "bg": "#282832"
  },
  "colors": {
    "accent": "accent", "border": "border", "borderAccent": "section", "borderMuted": "border",
    "success": "green", "error": "red", "warning": "yellow", "muted": "muted", "dim": "dim",
    "text": "text", "thinkingText": "muted", "selectedBg": "bg", "scrollbarTrack": "bg",
    "scrollbarThumb": "text", "searchMatchBg": "bg", "searchMatchText": "text",
    "userMessageBg": "bg", "userMessageText": "text", "customMessageBg": "bg",
    "customMessageText": "text", "customMessageLabel": "accent", "toolPendingBg": "bg",
    "toolSuccessBg": "bg", "toolErrorBg": "bg", "toolTitle": "text", "toolOutput": "muted",
    "mdHeading": "yellow", "mdLink": "accent", "mdLinkUrl": "dim", "mdCode": "accent",
    "mdCodeBlock": "green", "mdCodeBlockBorder": "border", "mdQuote": "muted",
    "mdQuoteBorder": "border", "mdHr": "border", "mdListBullet": "accent",
    "toolDiffAdded": "green", "toolDiffRemoved": "red", "toolDiffContext": "muted",
    "syntaxComment": "dim", "syntaxKeyword": "accent", "syntaxFunction": "yellow",
    "syntaxVariable": "text", "syntaxString": "green", "syntaxNumber": "yellow",
    "syntaxType": "accent", "syntaxOperator": "text", "syntaxPunctuation": "text",
    "thinkingOff": "dim", "thinkingMinimal": "dim", "thinkingLow": "accent",
    "thinkingMedium": "accent", "thinkingHigh": "yellow", "thinkingXhigh": "yellow",
    "thinkingMax": "red", "bashMode": "green"
  }
}
JSON
}

assert_custom_agent_theme() {
  prepare_case custom-agent-theme
  write_settings "$CURRENT_STATE_DIR" below left brackets
  python3 - "$CURRENT_STATE_DIR/settings.json" <<'PY'
import json, sys
p = sys.argv[1]
data = json.load(open(p))
data["powerline"].pop("model")
json.dump(data, open(p, "w"))
PY
  mkdir -p "$CURRENT_STATE_DIR/extensions/powerline-footer"
  cat > "$CURRENT_STATE_DIR/extensions/powerline-footer/theme.json" <<'JSON'
{
  "colors": { "model": "#12ab34" }
}
JSON
  local pi_theme="$CURRENT_CASE_ROOT/e2e-rgb.json"
  write_rgb_theme "$pi_theme"
  launch_tmux 80 24 \
    env HOME="$CURRENT_CASE_ROOT/home" PI_CODING_AGENT_DIR="$CURRENT_STATE_DIR" PI_OFFLINE=1 \
    TERM=tmux-256color COLORTERM=truecolor COLUMNS=80 LINES=24 \
    pi --tui-mode fullscreen --no-session --no-context-files --no-prompt-templates \
    --no-themes --theme "$pi_theme" --use-theme e2e-rgb --no-extensions --no-skills --no-tools \
    --provider openai-codex --model gpt-5.6-sol -e "$extension_path"
  wait_for_text 'dir ' 12000 || fail 'custom agent-dir theme case did not become ready'
  local ansi
  ansi=$(capture_ansi)
  [[ "$ansi" == *$'\033[38;2;18;171;52mGPT-5.6 Sol'* ]] \
    || fail 'custom agent-dir Powerline theme RGB was not used for model color'
}

logo_hash() {
  local logo
  logo=$(capture_ansi | grep '█' || true)
  [[ -n "$logo" ]] || return 1
  printf '%s\n' "$logo" | shasum -a 256 | cut -d' ' -f1
}

assert_welcome() {
  prepare_case welcome
  mkdir -p "$CURRENT_STATE_DIR/cache/pi-powerline-footer" "$CURRENT_STATE_DIR/sessions/e2e"
  cat > "$CURRENT_STATE_DIR/settings.json" <<'JSON'
{
  "quietStartup": true,
  "tuiMode": "fullscreen",
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "high",
  "powerline": {
    "welcome": true,
    "model": { "color": "warning", "bold": true }
  }
}
JSON
  write_keybindings "$CURRENT_STATE_DIR"
  local pi_theme="$CURRENT_CASE_ROOT/e2e-rgb.json"
  local resolved_work_dir long_name
  pi_theme="$CURRENT_CASE_ROOT/e2e-rgb.json"
  resolved_work_dir=$(cd "$CURRENT_WORK_DIR" && pwd -P)
  long_name='Powerline footer loaded-resource metrics and startup token burden verification'
  write_rgb_theme "$pi_theme"
  python3 - "$CURRENT_STATE_DIR/cache/pi-powerline-footer/recent-sessions.json" \
    "$resolved_work_dir" "$long_name" <<'PY'
import json, sys
path, workspace, long_name = sys.argv[1:]
json.dump({"version": 2, "workspaces": {workspace: [
    {"name": "Anonymous", "timeAgo": "1m ago"},
    {"name": long_name, "timeAgo": "2m ago"},
]}}, open(path, "w"))
PY
  cat > "$CURRENT_STATE_DIR/sessions/e2e/anonymous.jsonl" <<JSONL
{"type":"session","version":3,"id":"60000000-0000-4000-8000-000000000001","timestamp":"2026-01-01T00:00:00.000Z","cwd":"$resolved_work_dir"}
{"type":"session_info","id":"infoanon","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z","name":" "}
JSONL
  cat > "$CURRENT_STATE_DIR/sessions/e2e/long.jsonl" <<JSONL
{"type":"session","version":3,"id":"60000000-0000-4000-8000-000000000002","timestamp":"2026-01-01T00:00:00.000Z","cwd":"$resolved_work_dir"}
{"type":"session_info","id":"infolong","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z","name":"$long_name"}
JSONL
  launch_tmux 140 38 \
    env HOME="$CURRENT_CASE_ROOT/home" PI_CODING_AGENT_DIR="$CURRENT_STATE_DIR" PI_OFFLINE=1 \
    TERM=tmux-256color COLORTERM=truecolor COLUMNS=140 LINES=38 \
    pi --tui-mode fullscreen --no-session --no-context-files --no-prompt-templates \
    --no-themes --theme "$pi_theme" --use-theme e2e-rgb \
    --no-extensions --no-skills --no-tools \
    --provider openai-codex --model gpt-5.6-sol -e "$extension_path"
  wait_for_text 'Welcome back!' 12000 || fail 'quiet startup welcome did not render'

  local hashes="" frame hash unique_count
  for ((frame=1; frame<=40; frame++)); do
    hash=$(logo_hash)
    [[ -n "$hash" ]] && hashes+="$hash"$'\n'
    sleep 0.04
  done
  unique_count=$(printf '%s' "$hashes" | grep -v '^$' | sort -u | wc -l | tr -d ' ')
  (( unique_count >= 3 )) || fail "welcome logo animated through only $unique_count distinct frames"

  sleep 1.7
  local stable_a stable_b pane ansi first_line second_line version
  stable_a=$(logo_hash)
  sleep 0.25
  stable_b=$(logo_hash)
  [[ "$stable_a" == "$stable_b" ]] || fail 'welcome logo did not settle after its intro'
  pane=$(capture_plain)
  ansi=$(capture_ansi)
  first_line=$(printf '%s\n' "$pane" | sed -n '1p')
  second_line=$(printf '%s\n' "$pane" | sed -n '2p')
  version=$(pi --version)
  [[ -z "$first_line" ]] || fail 'quiet startup omitted its leading blank row'
  [[ "$second_line" == *"Pi v$version"* ]] || fail 'welcome top border omitted the runtime Pi version'
  for text in 'ctrl+t cycle thinking' 'Tips' 'Loaded' 'Recent sessions' \
    'tokens loaded at startup' 'Anonymous' "$long_name"; do
    grep -Fq -- "$text" <<<"$pane" || fail "welcome omitted '$text'"
  done
  [[ "$pane" != *'Shift+Tab'* && "$pane" != *'…'* ]] \
    || fail 'welcome showed Shift+Tab or truncated the long session name'
  grep -Eq '[0-9]+ extension' <<<"$pane" || fail 'welcome omitted the loaded extension count'

  local tips_ansi provider_ansi ctrl_ansi loaded_ansi sessions_ansi count_ansi border_ansi welcome_model_ansi
  tips_ansi=$(printf '%s\n' "$ansi" | grep -m1 'Tips' || true)
  provider_ansi=$(printf '%s\n' "$ansi" | grep -m1 'openai-codex' || true)
  ctrl_ansi=$(printf '%s\n' "$ansi" | grep -m1 'ctrl+t' || true)
  loaded_ansi=$(printf '%s\n' "$ansi" | grep -m1 'Loaded' || true)
  sessions_ansi=$(printf '%s\n' "$ansi" | grep -m1 'Recent sessions' || true)
  count_ansi=$(printf '%s\n' "$ansi" | grep -m1 'extension' || true)
  border_ansi=$(printf '%s\n' "$ansi" | grep -m1 'Pi' || true)
  welcome_model_ansi=$(printf '%s\n' "$ansi" | grep -m1 'GPT-5.6 Sol' || true)
  [[ "$tips_ansi" == *$'\033[38;2;52;86;120m'* && "$tips_ansi" == *$'\033[1m'* \
    && "$loaded_ansi" == *$'\033[38;2;52;86;120m'* \
    && "$sessions_ansi" == *$'\033[38;2;52;86;120m'* ]] \
    || fail 'prototype D section labels did not use bold #345678'
  [[ "$provider_ansi" == *$'\033[38;2;86;120;154m'* \
    && "$ctrl_ansi" == *$'\033[38;2;69;103;137m'* \
    && "$count_ansi" == *$'\033[38;2;86;120;154m'* \
    && "$count_ansi" == *$'\033[38;2;69;103;137m'* ]] \
    || fail 'prototype D provider, shortcut, bullet, or count tone changed'
  [[ "$border_ansi" == *$'\033[38;2;35;69;103m'* \
    && "$border_ansi" == *$'\033[38;2;138;190;183m'* ]] \
    || fail 'prototype D border or Pi accent tone changed'
  [[ "$welcome_model_ansi" == *$'\033[38;2;255;255;0m'* \
    && "$welcome_model_ansi" == *$'\033[1m'* ]] \
    || fail 'welcome model color and bold appearance were not applied'

  send_literal 'WELCOME-PERSISTS-WHILE-TYPING'
  wait_for_text 'WELCOME-PERSISTS-WHILE-TYPING' 3000 || fail 'welcome test input did not render'
  [[ "$(logo_hash)" == "$stable_a" ]] || fail 'welcome logo restarted while typing'
  capture_plain | grep -Fq 'Welcome back!' || fail 'welcome disappeared while typing'
  send_key C-a
  send_key C-k
  send_literal '!printf WELCOME_BASH_DONE'
  send_key Enter
  wait_for_text 'WELCOME_BASH_DONE' 3000 || fail 'welcome bash command did not run'
  capture_plain | grep -Fq 'Welcome back!' || fail 'welcome disappeared after native bash input'
  [[ "$(logo_hash)" == "$stable_a" ]] || fail 'welcome logo restarted after native bash input'

  send_key C-u
  send_literal '/new'
  send_key Enter
  wait_for_text 'New session started' 5000 || fail '/new did not complete during welcome test'
  sleep 0.25
  ! capture_plain | grep -Fq 'Welcome back!' || fail 'welcome remained visible after /new'
}

assert_resumed_session_has_no_welcome() {
  prepare_case welcome-resume
  cat > "$CURRENT_STATE_DIR/settings.json" <<'JSON'
{
  "quietStartup": true,
  "tuiMode": "fullscreen",
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "powerline": { "welcome": true }
}
JSON
  local session_path="$CURRENT_CASE_ROOT/resume.jsonl"
  cat > "$session_path" <<JSONL
{"type":"session","version":3,"id":"70000000-0000-4000-8000-000000000001","timestamp":"2026-01-01T00:00:00.000Z","cwd":"$CURRENT_WORK_DIR"}
{"type":"message","id":"user0001","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z","message":{"role":"user","content":"VALID-MODEL-FREE-RESUME","timestamp":1767225600001}}
{"type":"message","id":"asst0001","parentId":"user0001","timestamp":"2026-01-01T00:00:00.002Z","message":{"role":"assistant","content":[{"type":"text","text":"MODEL-FREE-RECORDED-REPLY"}],"provider":"openai-codex","model":"gpt-5.6-sol","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1767225600002}}
JSONL
  launch_tmux 100 30 \
    env HOME="$CURRENT_CASE_ROOT/home" PI_CODING_AGENT_DIR="$CURRENT_STATE_DIR" PI_OFFLINE=1 \
    TERM=tmux-256color COLORTERM=truecolor COLUMNS=100 LINES=30 \
    pi --tui-mode fullscreen --session "$session_path" --no-context-files \
    --no-prompt-templates --no-themes --no-extensions --no-skills --no-tools \
    --provider openai-codex --model gpt-5.6-sol -e "$extension_path"
  wait_for_text 'MODEL-FREE-RECORDED-REPLY' 12000 \
    || fail 'valid model-free resumed session did not render its recorded reply'
  ! capture_plain | grep -Fq 'Welcome back!' || fail 'welcome rendered for a valid resumed session'
}

assert_file_working_vibe() {
  prepare_case file-working-vibe
  mkdir -p "$CURRENT_STATE_DIR/vibes"
  local extension_package
  extension_package=$(dirname "$extension_path")
  cat > "$CURRENT_STATE_DIR/settings.json" <<JSON
{
  "quietStartup": true,
  "tuiMode": "fullscreen",
  "defaultProvider": "e2e-abort",
  "defaultModel": "queue-fixture",
  "defaultThinkingLevel": "off",
  "packages": ["$extension_package"],
  "workingVibe": "e2e",
  "workingVibeMode": "file",
  "powerline": {
    "welcome": false,
    "showLastPrompt": false,
    "layout": { "left": ["model_thinking", "path"], "right": [], "secondary": [] }
  }
}
JSON
  printf '%s\n' 'Orbiting the regression...' > "$CURRENT_STATE_DIR/vibes/e2e.txt"
  write_keybindings "$CURRENT_STATE_DIR"

  local expected_prompt='VIBE-E2E-PROVIDER-MUST-NOT-RUN'
  local before_agent="$CURRENT_CASE_ROOT/before-agent.txt"
  local before_provider="$CURRENT_CASE_ROOT/before-provider.txt"
  launch_tmux 90 26 \
    env HOME="$CURRENT_CASE_ROOT/home" PI_CODING_AGENT_DIR="$CURRENT_STATE_DIR" PI_OFFLINE=1 \
    QUEUE_E2E_EXPECTED_PROMPT="$expected_prompt" QUEUE_E2E_BEFORE_AGENT_PATH="$before_agent" \
    QUEUE_E2E_BEFORE_PROVIDER_PATH="$before_provider" QUEUE_E2E_ABORT_DELAY_MS=3000 \
    QUEUE_E2E_BLOCK_BEFORE_PROVIDER=1 TERM=tmux-256color COLORTERM=truecolor \
    COLUMNS=90 LINES=26 \
    pi --tui-mode fullscreen --no-session --no-context-files --no-prompt-templates \
    --no-themes --no-skills --no-tools \
    --provider e2e-abort --model queue-fixture \
    -e "$queue_abort_fixture_path"
  env -u TMUX -u TMUX_PANE tmux -L "$active_socket" set-option -t "$active_session" remain-on-exit on
  wait_for_text 'Queue Fixture' 12000 || fail 'file Working Vibe case did not become ready'
  send_literal "$expected_prompt"
  send_key Enter
  wait_for_file "$before_agent" 5000 || fail 'file Working Vibe did not reach before_agent_start'
  wait_for_text 'Orbiting the regression' 1000 \
    || fail 'file Working Vibe was not visible in the working-message row'

  [[ "$(cat "$before_agent")" == "$expected_prompt" ]] \
    || fail 'file Working Vibe used the wrong prompt'
  wait_for_file "$before_provider" 1000 \
    || fail 'file Working Vibe did not reach the before-provider stream gate'
  [[ "$(cat "$before_provider")" == 'blocked-before-stream' ]] \
    || fail 'file Working Vibe did not block before provider streaming'

  local working_line working_text
  working_line=$(capture_plain | grep -F -m1 'Orbiting the regression' || true)
  [[ -n "$working_line" ]] || fail 'file Working Vibe was not visible in the working-message row'
  working_text=$(sed -E 's/^[[:space:]]*[^[:space:]]+[[:space:]]+//' <<<"$working_line")
  [[ "$working_text" == 'Orbiting the regression' ]] \
    || fail "file Working Vibe had unexpected visible text: $working_text"
  [[ "$working_line" != *'...' && "$working_line" != *'…' ]] \
    || fail 'file Working Vibe kept a trailing ellipsis'
}

assert_queue_delivery() {
  prepare_case queue-delivery
  mkdir -p "$CURRENT_STATE_DIR/powerline-footer"
  cat > "$CURRENT_STATE_DIR/settings.json" <<'JSON'
{
  "quietStartup": true,
  "tuiMode": "fullscreen",
  "defaultProvider": "e2e-abort",
  "defaultModel": "queue-fixture",
  "defaultThinkingLevel": "off",
  "powerline": {
    "welcome": false,
    "showLastPrompt": false,
    "layout": { "left": ["model_thinking", "path"], "right": [], "secondary": ["extension_statuses"] }
  }
}
JSON
  write_keybindings "$CURRENT_STATE_DIR"
  local queue_path="$CURRENT_STATE_DIR/powerline-footer/inbox.jsonl"
  local expected_prompt='QUEUE-E2E-PROVIDER-MUST-NOT-RUN'
  cat > "$queue_path" <<JSONL
{"id":"abc12345","text":"$expected_prompt","createdAt":1767225600000,"updatedAt":1767225600000,"source":{"cwd":"$CURRENT_WORK_DIR"},"target":{"kind":"global"},"intent":"follow-up","status":"queued"}
JSONL
  local before_agent="$CURRENT_CASE_ROOT/before-agent.txt"
  local before_provider="$CURRENT_CASE_ROOT/before-provider.txt"
  launch_tmux 90 26 \
    env HOME="$CURRENT_CASE_ROOT/home" PI_CODING_AGENT_DIR="$CURRENT_STATE_DIR" PI_OFFLINE=1 \
    QUEUE_E2E_EXPECTED_PROMPT="$expected_prompt" QUEUE_E2E_BEFORE_AGENT_PATH="$before_agent" \
    QUEUE_E2E_BEFORE_PROVIDER_PATH="$before_provider" TERM=tmux-256color COLORTERM=truecolor \
    COLUMNS=90 LINES=26 \
    pi --tui-mode fullscreen --no-session --no-context-files --no-prompt-templates \
    --no-themes --no-extensions --no-skills --no-tools \
    --provider e2e-abort --model queue-fixture \
    -e "$extension_path" -e "$queue_abort_fixture_path"
  env -u TMUX -u TMUX_PANE tmux -L "$active_socket" set-option -t "$active_session" remain-on-exit on
  wait_for_text 'dir ' 12000 || fail 'queue delivery case did not become ready'
  send_literal '/queue'
  send_key Enter
  wait_for_text 'abc12345' 3000 || fail 'seeded queue item did not appear in /queue'
  send_key Enter
  wait_for_text 'Send to current session' 3000 || fail 'queue action picker did not open'
  send_key Enter
  wait_for_file "$before_agent" 5000 || fail 'queue delivery did not reach before_agent_start'
  sleep 0.35

  [[ "$(cat "$before_agent")" == "$expected_prompt" ]] \
    || fail 'queue delivered the wrong prompt to before_agent_start'
  [[ ! -f "$before_provider" ]] || fail 'abort fixture allowed a provider request'
  grep -F '"id":"abc12345"' "$queue_path" | tail -1 | grep -Fq '"status":"sent"' \
    || fail 'queue item did not transition to sent'
  local pane
  pane=$(capture_plain)
  grep -Fq 'Sent queued item abc12345' <<<"$pane" \
    || fail 'queue sent acknowledgement did not appear before provider abort'
  [[ "$pane" != *"↳ $expected_prompt"* && "$pane" != *"↳$expected_prompt"* ]] \
    || fail 'nested queued prompt leaked through showLastPrompt=false'
}

[[ -f "$extension_path" ]] || fail "extension not found: $extension_path"
for path in "$editor_fixture_path" "$status_fixture_path" "$queue_abort_fixture_path"; do
  [[ -f "$path" ]] || fail "fixture not found: $path"
done

only=${POWERLINE_E2E_ONLY:-all}
if [[ "$only" == all || "$only" == layout ]]; then
  for placement in above below; do
    assert_geometry_and_style "$placement" 282 34
    assert_geometry_and_style "$placement" 80 24
    assert_geometry_and_style "$placement" 50 24
  done
  assert_geometry_and_style below 80 24 right
  assert_config_and_context_defaults
fi
if [[ "$only" == all || "$only" == thinking ]]; then
  assert_thinking_wrappers
  assert_thinking_cycle
  assert_restored_max
fi
if [[ "$only" == all || "$only" == commands ]]; then
  assert_commands_shortcuts_and_history
  assert_dynamic_completions
fi
if [[ "$only" == all || "$only" == lifecycle ]]; then
  assert_lifecycle
fi
if [[ "$only" == all || "$only" == theme ]]; then
  assert_custom_agent_theme
fi
if [[ "$only" == all || "$only" == welcome ]]; then
  assert_welcome
  assert_resumed_session_has_no_welcome
fi
if [[ "$only" == all || "$only" == vibe ]]; then
  assert_file_working_vibe
fi
if [[ "$only" == all || "$only" == queue ]]; then
  assert_queue_delivery
fi

pi_version=$(pi --version)
printf 'PASS Powerline real-TUI regression E2E (%s) on Pi %s\n' "$only" "$pi_version"
