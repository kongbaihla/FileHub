"""Set a user's password directly.

prune_to_owner.py clears the owner's password so a deployment does not go live
with whatever test password was in use locally. That leaves the account unable
to log in — an empty hash matches nothing — so this is the counterpart that
gives it a real one again.

    python set_password.py <username>                # prompt, not echoed
    python set_password.py <username> --password X   # non-interactive

The PBKDF2 parameters are imported from the server rather than repeated, so a
password set here hashes exactly the way the login route expects.
"""
from __future__ import annotations

import argparse
import getpass
import os
import sqlite3
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("FILEHUB_DATA") or APP_DIR)
DB_PATH = DATA_DIR / "filehub.db"

sys.path.insert(0, str(APP_DIR / "server"))


def main() -> None:
    ap = argparse.ArgumentParser(description="Set a FileHub user's password.")
    ap.add_argument("username")
    ap.add_argument("--password", help="skip the prompt (visible in shell history)")
    args = ap.parse_args()

    # Imported here so --help works without the server's dependencies installed.
    # hash_pw comes from the server; the salt format (16 random bytes as hex) is
    # the one the register route uses, so the two produce interchangeable rows.
    import secrets

    from main import hash_pw

    if not DB_PATH.exists():
        raise SystemExit(f"no database at {DB_PATH}")

    pw = args.password or getpass.getpass(f"new password for {args.username}: ")
    if not pw:
        raise SystemExit("empty password; nothing changed")
    if not args.password:
        again = getpass.getpass("repeat: ")
        if again != pw:
            raise SystemExit("the two entries did not match; nothing changed")

    salt = secrets.token_hex(16)
    with sqlite3.connect(DB_PATH) as c:
        row = c.execute("SELECT id FROM users WHERE username = ?", (args.username,)).fetchone()
        if not row:
            raise SystemExit(f"no user named {args.username!r}")
        c.execute("UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?",
                  (salt, hash_pw(pw, salt), row[0]))
        # Any existing session for this user stays valid; a password change is
        # not a logout. Sessions are cleared separately if that is what you want.
        c.commit()
    print(f"password set for {args.username}")


if __name__ == "__main__":
    main()
