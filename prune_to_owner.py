"""Trim the database down to the site owner's data only.

Keeps the account that created the site (the first row in `users`, which is
what site_owner_name() treats as the owner) and everything belonging to it, and
removes every other account along with the rows that depend on them.

    python prune_to_owner.py            # report what would go
    python prune_to_owner.py --apply    # do it
    python prune_to_owner.py --apply --keep-password    # keep the owner's login

By default the owner's password is CLEARED, so a deployment does not go live
with whatever password was in use locally. Set a new one through the site, or
pass --keep-password if you are moving a real account rather than a test one.

The script also deletes the uploaded files that belonged to the removed rows,
because a row and its file are a pair: leaving the files behind turns the
volume into a pile of unreferenced images, and leaving the rows behind gives
every page a broken picture.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("FILEHUB_DATA") or APP_DIR)
DB_PATH = DATA_DIR / "filehub.db"
UPLOAD_DIR = DATA_DIR / "uploads"


def _banner_file(raw) -> str | None:
    """The filename inside a stored banner value.

    The banner column is not a filename like avatar is — it holds JSON
    ({"image": ..., "scale": ...}), because a banner carries its framing with
    it. Treating the raw value as a filename protected nothing and would have
    deleted the owner's banner.
    """
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    name = data.get("image") if isinstance(data, dict) else None
    return name if isinstance(name, str) and name else None


def collect(c: sqlite3.Connection) -> dict:
    """The owner's id and the set of stored filenames that must survive."""
    owner = c.execute("SELECT id, username FROM users ORDER BY id LIMIT 1").fetchone()
    if owner is None:
        raise SystemExit("no users in the database; nothing to keep")
    oid = owner[0]

    keep_files = {
        r[0] for r in c.execute(
            "SELECT f.stored_name FROM files f JOIN repos r ON r.id = f.repo_id "
            "WHERE r.owner_id = ?", (oid,))
        if r[0]
    }
    # Single-file columns: avatar is a bare filename, banner and chat_bg are
    # JSON configs that name their file.
    row = c.execute(
        "SELECT avatar, banner, chat_bg FROM users WHERE id = ?", (oid,)).fetchone()
    if row:
        if row[0]:
            keep_files.add(row[0])
        for cfg in (row[1], row[2]):
            name = _banner_file(cfg)
            if name:
                keep_files.add(name)
    return {"owner_id": oid, "owner": owner[1], "keep_files": keep_files}


def report(c: sqlite3.Connection, info: dict) -> dict:
    oid = info["owner_id"]
    counts = {
        "users": c.execute("SELECT COUNT(*) FROM users").fetchone()[0] - 1,
        "repos": c.execute("SELECT COUNT(*) FROM repos WHERE owner_id != ?", (oid,)).fetchone()[0],
        "files": c.execute(
            "SELECT COUNT(*) FROM files f JOIN repos r ON r.id = f.repo_id "
            "WHERE r.owner_id != ?", (oid,)).fetchone()[0],
        "comments": c.execute(
            "SELECT COUNT(*) FROM comments WHERE user_id != ? "
            "OR repo_id IN (SELECT id FROM repos WHERE owner_id != ?)",
            (oid, oid)).fetchone()[0],
        "stars": c.execute(
            "SELECT COUNT(*) FROM stars WHERE user_id != ? "
            "OR repo_id IN (SELECT id FROM repos WHERE owner_id != ?)",
            (oid, oid)).fetchone()[0],
        "follows": c.execute(
            "SELECT COUNT(*) FROM follows WHERE follower_id != ? OR followee_id != ?",
            (oid, oid)).fetchone()[0],
        "sessions": c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0],
    }
    on_disk = {p.name for p in UPLOAD_DIR.glob("*")} if UPLOAD_DIR.exists() else set()
    counts["files_on_disk"] = len(on_disk - info["keep_files"])
    return counts


def prune(c: sqlite3.Connection, info: dict, keep_password: bool) -> None:
    oid = info["owner_id"]
    # Order matters: rows that reference a repo or a user go before the things
    # they point at, so no statement is ever working against a dangling id.
    #
    # The owner's own comments and stars on OTHER people's repos are deleted
    # too. Keying only on user_id left them behind when their repos went, which
    # is a dangling reference — the comment outlives the thing it was written
    # about. Both conditions are needed, not either.
    c.execute("DELETE FROM comments WHERE user_id != ? "
              "OR repo_id IN (SELECT id FROM repos WHERE owner_id != ?)", (oid, oid))
    c.execute("DELETE FROM stars WHERE user_id != ? "
              "OR repo_id IN (SELECT id FROM repos WHERE owner_id != ?)", (oid, oid))
    c.execute("DELETE FROM follows WHERE follower_id != ? OR followee_id != ?", (oid, oid))
    c.execute("DELETE FROM files WHERE repo_id IN (SELECT id FROM repos WHERE owner_id != ?)", (oid,))
    c.execute("DELETE FROM repos WHERE owner_id != ?", (oid,))
    c.execute("DELETE FROM users WHERE id != ?", (oid,))
    # Sessions are per-visit tokens, not data worth carrying.
    c.execute("DELETE FROM sessions")
    if not keep_password:
        # Force a re-set: the local password is a known test value.
        c.execute("UPDATE users SET pw_salt = '', pw_hash = '' WHERE id = ?", (oid,))
    c.commit()


def main() -> None:
    apply = "--apply" in sys.argv
    keep_password = "--keep-password" in sys.argv
    if not DB_PATH.exists():
        raise SystemExit(f"no database at {DB_PATH}")

    with sqlite3.connect(DB_PATH) as c:
        info = collect(c)
        print(f"owner: {info['owner']} (id {info['owner_id']})")
        before = report(c, info)
        print("\nrows that would be removed:")
        for k, v in before.items():
            print(f"  {k:14s} {v}")
        if not apply:
            print("\n(dry run — pass --apply to make the change)")
            return
        prune(c, info, keep_password)
        after = report(c, info)
        print("\nremoved:")
        for k in before:
            d = before[k] - after[k]
            if d:
                print(f"  {k:14s} {d}")
        if not keep_password:
            print("\nowner password cleared — set a new one on first login")

        # Files last, and only once the rows that referenced them are gone.
        removed = 0
        for p in UPLOAD_DIR.glob("*"):
            if p.name not in info["keep_files"]:
                p.unlink(missing_ok=True)
                removed += 1
        print(f"  {'files deleted':14s} {removed}")


if __name__ == "__main__":
    main()
