#!/usr/bin/env python3
"""Summarize Hibiki's bounded development timing sessions (no metadata)."""
import argparse
import collections
import json
import math
import os
from pathlib import Path
import statistics
import sys


def app_data():
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/app.hibiki.client"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home())) / "app.hibiki.client"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "app.hibiki.client"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", nargs="?", type=Path, help="defaults to the latest development session")
    parser.add_argument("--min-ms", type=float, default=50, help="show operations reaching this duration")
    parser.add_argument("--limit", type=int, default=40)
    args = parser.parse_args()
    sessions = list(app_data().glob("performance-*.jsonl")) if args.file is None else [args.file]
    if not sessions:
        parser.error("No performance session found. Start a Hibiki development build first.")
    source = max(sessions, key=lambda p: p.stat().st_mtime)
    if source.stat().st_size > 4 * 1024 * 1024:
        parser.error("Session exceeds the 4 MiB development logging bound")
    groups = collections.defaultdict(list)
    skipped = 0
    for line in source.read_text().splitlines():
        try:
            event = json.loads(line)
            names = (event["operation"], event["phase"])
            duration = float(event["durationMs"])
            if any(not isinstance(name, str) or not name or len(name) > 64
                   or not all(char.isascii() and (char.isalnum() or char in "_.") for char in name)
                   for name in names) or not math.isfinite(duration) or not 0 <= duration <= 3_600_000:
                raise ValueError()
            groups[names].append(duration)
        except (ValueError, KeyError, TypeError):
            skipped += 1
    print(f"Timing groups: {len(groups)}; invalid/incomplete entries skipped: {skipped}")
    print(f"{'Operation / phase':55} {'Count':>6} {'Median':>10} {'P95':>10} {'Max ms':>10}")
    shown = 0
    for names, durations in sorted(groups.items(), key=lambda pair: max(pair[1]), reverse=True):
        if max(durations) < args.min_ms:
            continue
        durations.sort()
        p95 = durations[math.ceil(len(durations) * .95) - 1]
        print(f"{' / '.join(names):55} {len(durations):6} {statistics.median(durations):10.2f} {p95:10.2f} {max(durations):10.2f}")
        shown += 1
        if shown >= max(1, args.limit):
            break
    print("Phases can overlap; do not add native, IPC, cache and page totals together.")


if __name__ == "__main__":
    main()
