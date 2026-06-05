#!/usr/bin/env python3
"""PreToolUse guard: block edits to the published-snapshot xlsx in word-data/.

word-data/{WordList,PhraseList,category}.xlsx are publish artifacts — they are
only ever overwritten by update.command (publish-all.mjs step ①, which promotes
data_prep/*.xlsx into word-data/). All ACTUAL editing happens in
~/Desktop/data_prep/*.xlsx instead. This hook denies any Claude write to them.
"""
import json
import re
import sys

DENY_REASON = (
    "word-data/*.xlsx 是发布快照,只能由 update.command(publish-all)更新。"
    "请改去编辑 ~/Desktop/data_prep/ 里对应的 xlsx。"
)

# A path that lives under a word-data/ dir and ends in .xlsx (for Edit/Write file_path).
WORD_DATA_XLSX = re.compile(r"word-data[/\\][^\s'\"]*\.xlsx", re.IGNORECASE)

# Bash WRITES that TARGET a word-data xlsx. Each pattern requires the write op to
# sit right next to the word-data path, so merely mentioning the path elsewhere in
# the command (e.g. inside a commit message, alongside an unrelated ">") is allowed.
_P = r"['\"]?\S*word-data[/\\]\S*\.xlsx"  # a word-data xlsx path token
BASH_WRITES = [
    re.compile(r">>?\s*" + _P, re.IGNORECASE),                               # > / >> redirect into it
    re.compile(r"\b(?:cp|mv|tee|install|rsync|dd)\b[^\n;|&]*" + _P, re.IGNORECASE),  # copied/moved into it
    re.compile(r"(?:\.save|save_workbook)\s*\(\s*" + _P, re.IGNORECASE),     # openpyxl save into it
]


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # malformed input → don't block

    tool = data.get("tool_name", "")
    ti = data.get("tool_input", {}) or {}

    if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        path = ti.get("file_path") or ti.get("notebook_path") or ""
        if WORD_DATA_XLSX.search(str(path)):
            deny(DENY_REASON)

    elif tool == "Bash":
        cmd = str(ti.get("command", ""))
        if any(p.search(cmd) for p in BASH_WRITES):
            deny(DENY_REASON)

    sys.exit(0)  # allow


if __name__ == "__main__":
    main()
