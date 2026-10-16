#!/usr/bin/env python3
"""Retire a pre-0.6 development Plex mirror, with Hibiki stopped and a full backup.

The application now retains only audio working sets and favorites. This one-time
maintenance reclaims the old full-library waveform archive without touching audio
files, preferences, favorite chronology, sync receipts or download intentions.
"""
import argparse
import datetime
import hashlib
import os
from pathlib import Path
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MUTABLE = {
    "plex_catalogue", "plex_audio_analysis", "plex_metadata_resources",
    "plex_catalogue_tasks", "plex_catalogue_changes", "plex_catalogue_incremental",
    "plex_catalogue_media", "plex_catalogue_invalidations",
    "plex_catalogue_browse_state", "plex_catalogue_browse_data", "plex_catalogue_browse_tags",
    "plex_catalogue_playlist_members", "plex_catalogue_playlist_versions",
}

def quote(name):
    return '"' + name.replace('"', '""') + '"'

def protected_digest(conn):
    result = {}
    for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        if name in MUTABLE or name.startswith("plex_catalogue_search"):
            continue
        columns = len(conn.execute(f"PRAGMA table_info({quote(name)})").fetchall())
        digest = hashlib.sha256()
        for row in conn.execute(f"SELECT * FROM {quote(name)} ORDER BY " + ','.join(str(i + 1) for i in range(columns))):
            digest.update(repr(row).encode())
            digest.update(b'\n')
        result[name] = digest.hexdigest()
    return result

def verify_retained_archive(conn, saved):
    for table, keys in [
        ('plex_catalogue', ['scope','kind','id']),
        ('plex_audio_analysis', ['scope','cache_key','stream_id','version']),
        ('plex_metadata_resources', ['scope','item_id','resource']),
        ('plex_catalogue_playlist_members', ['scope','playlist_id','generation','position']),
        ('plex_catalogue_playlist_versions', ['scope','playlist_id']),
    ]:
        columns = [row[1] for row in conn.execute(f'PRAGMA table_xinfo({quote(table)})')]
        key_positions = [columns.index(key) for key in keys]
        where = ' AND '.join(quote(key) + '=?' for key in keys)
        for row in conn.execute(f'SELECT * FROM {quote(table)}'):
            original = saved.execute(f'SELECT * FROM {quote(table)} WHERE {where}', [row[i] for i in key_positions]).fetchone()
            if original != row:
                raise RuntimeError('Retained archive validation failed; pruning must be rolled back.')

def prune(conn):
    conn.executescript("BEGIN IMMEDIATE; CREATE TEMP TABLE focused_scope(scope TEXT PRIMARY KEY); INSERT INTO focused_scope SELECT DISTINCT scope FROM plex_catalogue UNION SELECT DISTINCT scope FROM local_audio;")
    # executescript would implicitly commit an already-open transaction. Execute
    # complete SQL statements individually so failures roll back the entire prune.
    sql = (ROOT / 'src-tauri/src/db/focused_library.sql').read_text()
    statement = ''
    try:
        for line in sql.splitlines(keepends=True):
            statement += line
            if sqlite3.complete_statement(statement):
                conn.execute(statement)
                statement = ''
        conn.execute('DROP TABLE focused_scope')
    except BaseException:
        conn.rollback()
        raise

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    args = parser.parse_args()
    database = args.db.expanduser().resolve(strict=True)
    processes = subprocess.check_output(['ps', '-axo', 'comm='], text=True).splitlines()
    if any(p.rstrip().endswith('/hibiki') for p in processes):
        raise SystemExit('Stop all Hibiki processes before maintenance.')
    os.umask(0o077)
    folder = database.parent / 'maintenance-backups'
    folder.mkdir(mode=0o700, exist_ok=True)
    backup = folder / f'pre-plex-first-{datetime.datetime.now().strftime("%Y%m%d-%H%M%S")}.sqlite'
    with backup.open('xb'):
        pass
    original_bytes = database.stat().st_size
    conn = sqlite3.connect(database)
    try:
        if conn.execute('PRAGMA user_version').fetchone()[0] != 12:
            raise RuntimeError('This maintenance targets development schema V12 only.')
        before = protected_digest(conn)
        with sqlite3.connect(backup) as saved:
            conn.backup(saved, pages=4096)
        print(f'Backup saved: {backup}', flush=True)
        with sqlite3.connect(f'{backup.as_uri()}?mode=ro', uri=True) as saved:
            if protected_digest(saved) != before:
                raise RuntimeError('Backup protected-state verification failed; original unchanged.')
        conn.execute('PRAGMA foreign_keys=ON')
        prune(conn)
        if protected_digest(conn) != before:
            conn.rollback()
            raise RuntimeError('Protected state changed; pruning rolled back.')
        with sqlite3.connect(f'{backup.as_uri()}?mode=ro', uri=True) as saved:
            verify_retained_archive(conn, saved)
        conn.commit()
        print('Pruned retired mirror; protected-state checksums unchanged. Compacting…', flush=True)
        conn.execute('VACUUM')
        conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        if conn.execute('PRAGMA quick_check').fetchone()[0] != 'ok' or protected_digest(conn) != before:
            raise RuntimeError(f'Validation failed. Restore the verified backup at {backup}.')
        print(f'Validated: {original_bytes:,} -> {database.stat().st_size:,} bytes', flush=True)
        for table in ['plex_catalogue', 'plex_audio_analysis', 'local_audio', 'audio_download_entities', 'favorites_entries']:
            print(f'{table}: {conn.execute("SELECT count(*) FROM " + quote(table)).fetchone()[0]:,}', flush=True)
    finally:
        conn.close()

if __name__ == '__main__':
    main()
