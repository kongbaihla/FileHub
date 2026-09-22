"""FileHub — a site for hosting arbitrary user files.

FastAPI + SQLite, server-rendered Jinja2 templates, files stored on disk.
"""
from __future__ import annotations

import datetime
import email.utils
import hashlib
import html
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import time
import uuid
import zipfile
import contextlib
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote, urlencode

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from PIL import Image

APP_DIR = Path(__file__).resolve().parent.parent
# Everything this app writes at runtime — the SQLite database and every uploaded
# file — lives in one directory, so a deployment only has to make that one path
# durable. It defaults to the project root, which is what running from a
# checkout expects; a container points FILEHUB_DATA at a mounted volume instead,
# and then the writable state is separate from the code that can be replaced on
# every redeploy.
DATA_DIR = Path(os.environ.get("FILEHUB_DATA") or APP_DIR)
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "filehub.db"
MAX_FILE_SIZE = 200 * 1024 * 1024  # 200 MB per file
# The ceiling on everything in uploads/, until the owner changes it from the
# console. Expressed in bytes; the form offers MB/GB/TB.
DEFAULT_DISK_QUOTA = 1024 ** 4     # 1 TB
MAX_COVER_SIZE = 10 * 1024 * 1024   # 10 MB per cover / banner image
COVER_SIZE = 720                    # stored cover is 720x720 (3x the 240px hero)

# Set when the app runs behind a reverse proxy that terminates TLS (Cloudflare,
# nginx, a load balancer). Two things depend on it and both are wrong without
# it, so it is one switch rather than two:
#
#   · request.base_url would keep reporting http://, which is what the RSS feed
#     writes into every <link>. Subscribers would be sent to a URL that then
#     redirects, and some readers refuse a downgrade outright.
#   · The session cookie is emitted without `Secure` over plain http, which is
#     correct locally and wrong online: without it the cookie can leak over a
#     single http request.
#
# Off by default so local development over http://127.0.0.1 keeps working —
# a Secure cookie is not stored over http, which would make login silently fail.
BEHIND_PROXY = (os.environ.get("FILEHUB_BEHIND_PROXY") or "").lower() in ("1", "true", "yes")

app = FastAPI(title="FileHub")

if BEHIND_PROXY:
    # Trust the forwarding headers the proxy sets. Without this uvicorn reports
    # the proxy's own scheme and host, so base_url comes out as the upstream
    # address rather than the public one.
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

# Process-level cache for site_owner_name(); see that function.
_SITE_OWNER: str | None = None
templates = Jinja2Templates(directory=str(APP_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")


def _asset_version(*rel_paths: str) -> str:
    """A cache-busting token derived from the files' own mtime and size.

    The templates used to carry a hand-written ?v=92 that nobody remembered to
    bump, so an edited stylesheet kept being served from the browser cache and
    the page looked stale. Deriving the token from the file means any edit
    invalidates it on its own; mtime plus size is enough to catch a change and
    costs one stat per request rather than hashing the whole file.
    """
    stamp = []
    for rel in rel_paths:
        try:
            st = (APP_DIR / rel).stat()
            stamp.append(f"{int(st.st_mtime)}-{st.st_size}")
        except OSError:
            stamp.append("0")
    return hashlib.sha1("|".join(stamp).encode()).hexdigest()[:10]


ASSET_V = _asset_version("static/css/style.css", "static/js/app.js")

templates.env.globals["asset_v"] = ASSET_V

# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pw_salt TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(owner_id, name)
);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    path TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT DEFAULT 'application/octet-stream',
    downloads INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo_id);
CREATE TABLE IF NOT EXISTS stars (
    user_id INTEGER NOT NULL REFERENCES users(id),
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    PRIMARY KEY (user_id, repo_id)
);
-- repo_id is deliberately NOT a foreign key: the public chat room lives in
-- this table under the reserved id 0, which has no matching repo row.
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES users(id),
    followee_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_id, followee_id)
);
CREATE TABLE IF NOT EXISTS folder_names (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    path TEXT NOT NULL,
    display_name TEXT NOT NULL,
    PRIMARY KEY (repo_id, path)
);
-- Owner-editable scalars. A table rather than a config file or an environment
-- variable because the value has to change from the console and take effect
-- without a restart, and this is already where the site's state lives.
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# Columns added after the first release. SQLite has no "ADD COLUMN IF NOT
# EXISTS", so new columns are declared here and applied by migrate().
MIGRATIONS = {
    "comments": {"quote_id": "INTEGER"},
    "users": {
        "avatar": "TEXT",
        "bio": "TEXT NOT NULL DEFAULT ''",
        "banner": "TEXT",          # JSON: {image, scale, x, y, opacity, blur}
        "chat_bg": "TEXT",         # JSON, same shape, for the community page
    },
    "repos": {
        "is_private": "INTEGER NOT NULL DEFAULT 0",
        "cover": "TEXT NOT NULL DEFAULT ''",
    },
    "files": {
        "tags": "TEXT NOT NULL DEFAULT ''",
        "note": "TEXT NOT NULL DEFAULT ''",
        "thumb": "TEXT",
    },
}


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _comments_fk_removed(conn: sqlite3.Connection) -> bool:
    """True when comments.repo_id no longer carries a foreign key."""
    fks = list(conn.execute("PRAGMA foreign_key_list(comments)"))
    return all(fk["table"] != "repos" for fk in fks)


def migrate(conn: sqlite3.Connection) -> None:
    """Bring an existing database up to the current schema, in place."""
    # Earlier versions declared comments.repo_id as a foreign key to repos,
    # which blocks the reserved public-room id 0. Rebuild the table once.
    if not _comments_fk_removed(conn):
        conn.executescript("""
            CREATE TABLE comments_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id),
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                quote_id INTEGER
            );
            INSERT INTO comments_new (id, repo_id, user_id, body, created_at, quote_id)
                SELECT id, repo_id, user_id, body, created_at, quote_id FROM comments;
            DROP TABLE comments;
            ALTER TABLE comments_new RENAME TO comments;
        """)

    for table, columns in MIGRATIONS.items():
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


with db() as _c:
    _c.executescript(SCHEMA)
    migrate(_c)

# Uploads write to a tmp_ file first and rename on success. Anything still
# there at startup is debris from an interrupted upload, so sweep it away.
for _stale in UPLOAD_DIR.glob("tmp_*"):
    try:
        _stale.unlink()
    except OSError:
        pass

# ---------------------------------------------------------------- helpers


def hash_pw(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt_hex), 120_000
    ).hex()


def current_user(request: Request):
    token = request.cookies.get("fh_session")
    if not token:
        return None
    with db() as c:
        row = c.execute(
            """SELECT u.id, u.username, u.avatar,
                      (SELECT COUNT(*) FROM repos r WHERE r.owner_id = u.id) AS repo_count
               FROM sessions s
               JOIN users u ON u.id = s.user_id WHERE s.token = ?""",
            (token,),
        ).fetchone()
    if not row:
        return None
    user = dict(row)
    user.update(level_progress(user.get("repo_count", 0)))
    return user


def login_user(response, user_id: int):
    token = secrets.token_hex(32)
    with db() as c:
        c.execute(
            "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
            (token, user_id, int(time.time())),
        )
    response.set_cookie(
        "fh_session", token, httponly=True, samesite="lax",
        # Only over TLS. A Secure cookie is not stored over http, so setting it
        # unconditionally would break local development by making login appear
        # to succeed and then immediately forget the session.
        secure=BEHIND_PROXY,
        max_age=60 * 60 * 24 * 30,
    )


# Repo names may now be written in any script the user likes — Chinese, Latin,
# digits, punctuation — because a repo is a folder in a personal collection and
# forcing pinyin onto "设计稿" served nobody. What is still refused:
#
#   * characters that break the URL. A repo name travels as a path segment, so
#     it cannot contain "/" or "\" (they would forge a deeper path), the
#     control characters, or the reserved set that would change how the URL is
#     parsed. Encoding them instead of blocking them would make every link
#     look like %E4%B8%AD and break the breadcrumb.
#   * leading/trailing dots and spaces, which are either invisible or — in the
#     case of "." and ".." — mean something else to a filesystem.
#   * words that collide with markup, CSS or the DOM. A repo called "hidden"
#     or "class" is not a syntax error, but it becomes an element id, a CSS
#     custom-property suffix and a data attribute value all over the templates,
#     and the ones that collide with a real keyword (hidden, none, inherit,
#     important, …) silently break the page they are rendered on.
RESERVED_REPO_NAMES = {
    # CSS-wide keywords and values that would override the styles applied to
    # elements carrying the repo name.
    "hidden", "none", "inherit", "initial", "unset", "revert", "auto", "normal",
    "important", "block", "inline", "flex", "grid", "table", "contents",
    "static", "relative", "absolute", "fixed", "sticky", "transparent",
    "currentcolor", "visible", "collapse", "pointer", "default", "solid",
    "dashed", "dotted", "double", "groove", "ridge", "inset", "outset", "both",
    # HTML/DOM names and JS primitives that the templates or handlers use.
    "class", "id", "style", "href", "src", "data", "name", "value", "type",
    "input", "output", "form", "button", "select", "option", "label", "field",
    "true", "false", "null", "undefined", "nan", "infinity", "this", "self",
    "new", "delete", "typeof", "instanceof", "void", "yield", "await", "async",
    "function", "return", "var", "let", "const", "if", "else", "for", "while",
    "do", "switch", "case", "break", "continue", "try", "catch", "finally",
    "throw", "import", "export", "from", "of", "in", "with", "debugger", "enum",
    "extends", "super", "static", "get", "set",
    # Path segments and server terms that would be ambiguous in a URL or that
    # collide with the app's own routes.
    "new", "repos", "community", "search", "login", "logout", "register",
    "settings", "static", "media", "uploads", "api", "feed", "file", "files",
    "con", "prn", "aux", "nul", "com1", "com2", "lpt1", "lpt2",  # Windows devices
}

# Everything except the URL-hostile characters and the ASCII control range.
# Unicode letters/marks/digits cover Chinese, Japanese and Korean as a class,
# so this does not need a per-script list.
REPO_NAME_RE = re.compile(
    r"^[^\x00-\x1f\x7f/\\?#%<>\"'`|:*]+$"
)


def repo_name_error(name: str) -> str | None:
    """Return a human-readable reason the name is unusable, or None if it is fine."""
    if not name:
        return "仓库名不能为空"
    if len(name) > 64:
        return "仓库名不能超过 64 个字符"
    if name in (".", "..") or name != name.strip(" ."):
        return "仓库名不能以点或空格开头、结尾"
    if not REPO_NAME_RE.match(name):
        return "仓库名不能包含 / \\ ? # % < > \" ' ` | : * 或控制字符"
    # Case-folded comparison so "Hidden" is caught alongside "hidden".
    if name.casefold() in RESERVED_REPO_NAMES:
        return f"「{name}」与网页关键字冲突，换一个名字"
    return None


USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{2,32}$")


def sanitize_relpath(p: str) -> str:
    """Normalize a user-supplied relative path; raise ValueError if unusable."""
    p = p.replace("\\", "/")
    parts = []
    for seg in p.split("/"):
        seg = seg.strip()
        if seg in ("", ".", ".."):
            continue
        seg = re.sub(r'[<>:"|?*\x00-\x1f]', "_", seg)
        if len(seg) > 120:
            seg = seg[:120]
        parts.append(seg)
    if not parts or len(parts) > 16:
        raise ValueError("bad path")
    name = "/".join(parts)
    if len(name) > 400:
        raise ValueError("path too long")
    return name


def guess_mime(path: str) -> str:
    mime, _ = mimetypes.guess_type(path)
    return mime or "application/octet-stream"


def fmt_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def rel_time(ts: int) -> str:
    d = int(time.time()) - ts
    if d < 60:
        return "刚刚"
    if d < 3600:
        return f"{d // 60} 分钟前"
    if d < 86400:
        return f"{d // 3600} 小时前"
    if d < 86400 * 30:
        return f"{d // 86400} 天前"
    return time.strftime("%Y-%m-%d", time.localtime(ts))


templates.env.filters["size"] = fmt_size
templates.env.filters["reltime"] = rel_time


# ---------------------------------------------------------------- settings
#
# One key/value table for the few scalars the owner can change. Read through
# these helpers rather than off the table directly, so a missing row or a value
# that has been edited into nonsense falls back to the default instead of
# taking the page — or an upload — down with it.


def get_setting(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
        (key, value),
    )


def disk_quota(conn: sqlite3.Connection) -> int:
    """The storage ceiling in bytes, or the default when unset or unusable."""
    try:
        n = int(get_setting(conn, "disk_quota"))
    except (TypeError, ValueError):
        return DEFAULT_DISK_QUOTA
    return n if n > 0 else DEFAULT_DISK_QUOTA


def uploads_bytes() -> int:
    """Bytes actually held in uploads/, which is what a disk ceiling limits.

    Scanned rather than summed from `files.size`: the directory also holds
    thumbnails, avatars, covers, banners and any orphans, and those take up the
    same disk. The console shows this same figure against the quota, so what the
    owner reads and what an upload is refused by cannot drift apart.
    """
    total = 0
    with os.scandir(UPLOAD_DIR) as it:
        for entry in it:
            try:
                if entry.is_file():
                    total += entry.stat().st_size
            except OSError:
                pass
    return total


QUOTA_UNITS = {"MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4}


def quota_form_value(quota: int) -> tuple[float, str]:
    """The quota as the largest unit that keeps the number readable.

    Editing "1" beside a TB selector is a kinder form than editing
    1099511627776, and this is the one place the stored bytes are turned back
    into something a person wrote.
    """
    for unit in ("TB", "GB", "MB"):
        size = QUOTA_UNITS[unit]
        if quota >= size and quota % size == 0:
            return quota // size, unit
    return round(quota / QUOTA_UNITS["MB"], 2), "MB"


def render(request: Request, name: str, ctx: dict, status_code: int = 200):
    ctx["request"] = request
    resp = templates.TemplateResponse(request, name, ctx, status_code=status_code)
    # Every page is per-user and per-moment — the nav shows who is signed in, the
    # profile shows live counts, the repo page shows the current files. Without
    # this the browser serves the previous visit from cache or from the
    # back/forward cache, so stepping back showed stale content: the page you
    # returned to still held the state from before you navigated away.
    # `no-store` (rather than `no-cache`) also keeps the page out of bfcache,
    # which is the one that would otherwise show the old DOM instantly.
    resp.headers["Cache-Control"] = "no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    return resp


# ---------------------------------------------------------------- media helpers

THUMB_SIZE = (400, 400)
AVATAR_SIZE = (200, 200)


def make_thumbnail(src: Path, is_video: bool = False) -> str | None:
    """Generate a square JPEG thumbnail. Returns the stored filename or None.

    Videos are skipped (no ffmpeg dependency); the UI falls back to a type
    icon for those, which keeps the install to pure-Python deps.
    """
    if is_video:
        return None
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail(THUMB_SIZE, Image.LANCZOS)
            name = f"{src.stem}_thumb.jpg"
            im.save(UPLOAD_DIR / name, "JPEG", quality=82)
        return name
    except Exception:
        # Corrupt/unsupported image: a missing thumbnail is not an error.
        return None


ALLOWED_COVER_FORMATS = {"JPEG", "PNG"}


def make_cover(src: Path, crop: dict | None = None) -> str | None:
    """Downscale an uploaded repository cover, preserving its aspect ratio.

    Only JPEG and PNG are accepted; anything else returns None so the caller
    can reject it with a clear message.

    `crop` is the square window the owner chose in the upload dialog:
    {"x": 0..100, "y": 0..100, "zoom": >=1} where x/y are the centre of the
    window as a percentage of the source and zoom is how far in it is. When it
    is given the square is cut here, at upload time, from the coordinates the
    user actually picked — which is the whole point of asking first. Without
    it the picture is scaled to fit inside a COVER_SIZE box, whole.

    The image is scaled to fit inside a COVER_SIZE box rather than cropped to
    a square. Centre-cropping unconditionally threw away everything outside
    the middle square before the cover was ever stored, so a wide picture
    arrived already missing its sides and no amount of framing could bring
    them back.
    """
    try:
        with Image.open(src) as im:
            if im.format not in ALLOWED_COVER_FORMATS:
                return None
            im = im.convert("RGB")
            if crop:
                im = _crop_square(im, crop)
            else:
                im.thumbnail((COVER_SIZE, COVER_SIZE), Image.LANCZOS)
            name = f"cover_{uuid.uuid4().hex}.jpg"
            im.save(UPLOAD_DIR / name, "JPEG", quality=88)
        return name
    except Exception:
        return None


def _crop_square(im, crop: dict):
    """Cut the square the upload dialog asked for.

    The dialog works in the same terms the CSS preview does: `zoom` is how far
    the picture is magnified and x/y are where its centre sits. A zoom of 1 is
    the largest square that fits inside the picture — the window the user sees
    framed when they first open the dialog — so the maths is the inverse of
    what the preview draws.
    """
    w, h = im.size
    # The largest square that fits, scaled down by the zoom.
    side = min(w, h) / max(1.0, float(crop.get("zoom") or 1))
    side = max(1.0, min(side, float(min(w, h))))

    def pct(v, fallback=50.0):
        try:
            return min(100.0, max(0.0, float(v)))
        except (TypeError, ValueError):
            return fallback

    # Centre of the window, as a percentage of the source. The window cannot
    # reach past the picture's edge, so the closest its centre can get to an
    # edge is half a side away from it.
    cx = pct(crop.get("x")) / 100.0 * w
    cy = pct(crop.get("y")) / 100.0 * h
    half = side / 2.0
    cx = min(max(cx, half), w - half)
    cy = min(max(cy, half), h - half)

    left, top = int(round(cx - half)), int(round(cy - half))
    left = max(0, min(left, w - int(side)))
    top = max(0, min(top, h - int(side)))
    out = im.crop((left, top, left + int(side), top + int(side)))
    return out.resize((COVER_SIZE, COVER_SIZE), Image.LANCZOS)


def make_banner(src: Path) -> str | None:
    """Downscale an uploaded banner. Wide aspect, generous max side."""
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((1920, 1080), Image.LANCZOS)
            name = f"banner_{uuid.uuid4().hex}.jpg"
            im.save(UPLOAD_DIR / name, "JPEG", quality=86)
        return name
    except Exception:
        return None


def make_avatar(src: Path) -> str | None:
    """Downscale an already-cropped avatar.

    The browser crop page sends a square JPEG framed by the user. Older or
    direct uploads may not be square, so the image is centre-cropped to a
    square here too — the result is always a clean circle in the UI.
    """
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            w, h = im.size
            side = min(w, h)
            left, top = (w - side) // 2, (h - side) // 2
            im = im.crop((left, top, left + side, top + side))
            im = im.resize(AVATAR_SIZE, Image.LANCZOS)
            name = f"avatar_{uuid.uuid4().hex}.jpg"
            im.save(UPLOAD_DIR / name, "JPEG", quality=88)
        return name
    except Exception:
        return None


# File-type buckets used by the stats panel and the type icons.
# Repository cover art. Each entry is a self-contained CSS background so a
# cover needs no image file and renders identically at any card size.
COVERS = {
    "aurora": {
        "label": "极光绿",
        "css": ("linear-gradient(135deg, rgba(10,228,72,.13) 0%, transparent 45%),"
                "radial-gradient(ellipse 70% 90% at 20% 10%, rgba(10,228,72,.33), transparent 60%),"
                "radial-gradient(ellipse 60% 80% at 85% 85%, rgba(10,108,255,.27), transparent 65%),"
                "#101512"),
    },
    "grid": {
        "label": "蓝图网格",
        "css": ("linear-gradient(rgba(59,157,255,.09) 1px, transparent 1px) 0 0 / 22px 22px,"
                "linear-gradient(90deg, rgba(59,157,255,.09) 1px, transparent 1px) 0 0 / 22px 22px,"
                "radial-gradient(ellipse 80% 70% at 50% 0%, rgba(59,157,255,.2), transparent 65%),"
                "#0a0f18"),
    },
    "waves": {
        "label": "霓虹波纹",
        "css": ("repeating-radial-gradient(circle at 15% 110%, transparent 0 28px, rgba(255,123,213,.08) 28px 30px),"
                "radial-gradient(ellipse 90% 80% at 15% 110%, rgba(255,123,213,.25), transparent 62%),"
                "#1a0813"),
    },
    "sunset": {
        "label": "暖阳",
        "css": ("linear-gradient(160deg, rgba(255,176,32,.2) 0%, transparent 50%),"
                "radial-gradient(ellipse 80% 70% at 80% 15%, rgba(255,92,80,.2), transparent 60%),"
                "radial-gradient(ellipse 70% 80% at 10% 90%, rgba(255,176,32,.18), transparent 65%),"
                "#1a0f06"),
    },
    "mint": {
        "label": "薄荷",
        "css": ("radial-gradient(circle at 30% 30%, rgba(45,212,191,.2), transparent 55%),"
                "radial-gradient(circle at 75% 70%, rgba(10,228,72,.15), transparent 55%),"
                "#061a18"),
    },
    "violet": {
        "label": "深紫",
        "css": ("linear-gradient(45deg, rgba(167,139,250,.12) 0%, transparent 55%),"
                "radial-gradient(ellipse 70% 90% at 70% 20%, rgba(167,139,250,.27), transparent 62%),"
                "#100823"),
    },

}
COVER_KEYS = list(COVERS)
DEFAULT_COVER = "aurora"

# How an uploaded cover is fitted into its box. `contain` shows the whole
# picture letterboxed; `cover` fills the box and crops the long side away. The
# card is square and uploads are not, so `cover` cropped every non-square
# upload — a 720x406 photo lost about 90px from each side. Defined once here so
# the card, the hero and the editor preview cannot drift apart.
COVER_FIT = "contain"


# The framing an upload starts at. 100 is the neutral state: cover_style draws
# the image whole and centred, and the 大小 slider only ever zooms in from here.
# It used to start at 130 to give the position sliders something to travel, but
# that meant every fresh upload arrived already cropped.
COVER_DEFAULT_SCALE = 100


def parse_cover(key: str | None) -> dict:
    """Split a stored cover key into its parts.

    An uploaded cover is "upload:<filename>" and may carry framing as
    "upload:<filename>:<scale>:<x>:<y>". Keeping the framing in the same string
    the column already holds avoids a migration and a second column for what is
    one piece of state; the extra segments are optional so every cover written
    before this existed still parses.
    """
    if not key or not key.startswith("upload:"):
        return {"kind": "preset", "key": key or DEFAULT_COVER}
    parts = key.split(":")
    out = {"kind": "upload", "name": parts[1] if len(parts) > 1 else "",
           "scale": COVER_DEFAULT_SCALE, "x": 50, "y": 50}
    if len(parts) >= 5:
        for field, idx in (("scale", 2), ("x", 3), ("y", 4)):
            try:
                out[field] = float(parts[idx])
            except ValueError:
                pass
    # Clamped on read, not only on write. Covers framed under the previous
    # model can hold a position outside 0..100 (that slider ran -50..150), and
    # rendered against the new transform such a value pulls the picture clear
    # of the frame — which is precisely the crop this model exists to remove.
    # Normalising here means old rows draw correctly without a migration.
    out["scale"] = min(300.0, max(100.0, out["scale"]))
    out["x"] = min(100.0, max(0.0, out["x"]))
    out["y"] = min(100.0, max(0.0, out["y"]))
    return out

def _cover_num(v) -> str:
    """A cover number without a trailing .0, so generated CSS stays tidy."""
    f = float(v)
    return str(int(f)) if f == int(f) else str(round(f, 2))


def build_cover(name: str, scale: float, x: float, y: float) -> str:
    """Compose a cover key: upload:<filename>:<scale>:<x>:<y>."""
    return f"upload:{name}:{_cover_num(scale)}:{_cover_num(x)}:{_cover_num(y)}"


def cover_css(key: str | None) -> str:
    """Background for a repo card.

    Uploaded covers render as an image; the built-in gradients remain as
    defaults for repos without an upload.

    An uploaded cover is drawn with `contain`, so the whole picture is visible
    in the card, and the same two-layer treatment the hero uses (see
    cover_style): the sharp picture over a blurred copy of itself that fills
    the bands a non-square photo leaves. It has to be written as separate
    properties rather than the `background` shorthand, because the shorthand
    resets background-image and the CSS needs --cover-src to reach the
    backdrop layer.
    """
    info = parse_cover(key)
    if info["kind"] == "upload":
        url = f"url(/media/cover/{info['name']})"
        return (f"--cover-src: {url};"
                # Only the URL is passed on; the layering lives in one place in
                # CSS. The element's own background stays empty so the picture
                # is painted by exactly one layer (::after) over the blurred
                # backdrop (::before). Setting it here too stacked a third copy
                # of the photo behind them and the composite rendered wrong.
                # No background-color either: the backdrop fills the box, so
                # there is nothing to backstop.
                f"background-image: none;")
    # A built-in gradient: no image to letterbox and no backdrop to build, so it
    # stays a plain single declaration. Wrapped in `background:` because the
    # caller writes these straight into a style attribute.
    return f"background: {COVERS.get(key or '', COVERS[DEFAULT_COVER])['css']}"


def cover_is_upload(key: str | None) -> bool:
    return parse_cover(key)["kind"] == "upload"


def cover_response(request: Request, cover: str, owner: str, repo_name: str, message: str):
    """The result of changing a cover, as JSON for an in-page update or a
    redirect for a plain form post.

    The page repaints the cover in place when the request came from fetch(),
    which is why the caller sends the pieces needed to redraw with: the cover
    key itself (the page re-derives the CSS from it), whether it is now a custom
    upload, and the wording for the toast. A browser that posts the form
    normally still gets the redirect it always did, so nothing here depends on
    JavaScript being present.
    """
    wants_json = "application/json" in (request.headers.get("accept") or "")
    if wants_json:
        return {
            "cover": cover,
            "is_upload": cover_is_upload(cover),
            "css": cover_css(cover),
            "style": cover_style(cover) if cover_is_upload(cover) else "",
            "label": cover_label(cover),
            "message": message,
        }
    return RedirectResponse(f"/r/{owner}/{repo_name}?msg={message}", status_code=303)


def cover_style(key: str | None) -> str:
    """The inline style string a cover element should carry.

    Framing is expressed as `contain` plus a transform, not as
    `background-size` / `background-position` percentages. Those percentages
    align the image edge to the box edge and are measured against the
    difference between the two, so any value away from 50% drags the picture
    out of the frame entirely — which is what made a framed cover look cut.

    `contain`, not `cover`: the card is a square and an uploaded picture rarely
    is, so `cover` had to crop the long side away to fill the box — a 720x406
    photo lost roughly 90px from each side. The whole picture is shown instead,
    and `100` is the neutral framing where nothing is cut at all. The zoom
    slider is the one control that deliberately crops, and it now means "zoom
    in", not "undo the crop".

    Two layers, both built in CSS: a blurred copy of the picture filling the
    box, and the sharp picture fitted over it with `contain`. That is why the
    letterbox bands a wide photo leaves carry the photo's own colours instead
    of dead strips. Only the sharp layer is transformed, so the backdrop stays
    put while the picture pans.

    The element itself carries no background — the photo is painted by ::after
    and the backdrop by ::before. Setting the picture here as well would stack
    a third copy and the composite renders wrong. The framing transform does
    live on the element, because ::after inherits it.
    """
    if cover_is_upload(key):
        info = parse_cover(key)
        scale, x, y = info["scale"], info["x"], info["y"]
        zoom = max(1.0, scale / 100.0)
        shift = (zoom - 1) * 50
        url = f"url('/media/cover/{info['name']}')"
        return (
            f"--cover-src: {url};"
            f"background-image: none;"
            f"transform: scale({round(zoom, 4)}) "
            f"translate({round((x - 50) / 50 * shift, 3)}%, "
            f"{round((y - 50) / 50 * shift, 3)}%);"
        )
    # cover_css already returns whole declarations for the gradient case.
    return cover_css(key)


def cover_label(key: str | None) -> str:
    """A human name for a cover. Uploads are not presets, so they have no entry
    in COVERS and must not fall through to the default's label — that would
    call a custom photo "极光绿"."""
    if cover_is_upload(key):
        return "自定义封面"
    return COVERS.get(key or "", COVERS[DEFAULT_COVER])["label"]


templates.env.globals["parse_cover"] = parse_cover
templates.env.globals["cover_css"] = cover_css
templates.env.globals["cover_style"] = cover_style
templates.env.globals["cover_is_upload"] = cover_is_upload
templates.env.globals["COVERS"] = COVERS


TYPE_BUCKETS = {
    "image": lambda m: m.startswith("image/"),
    "video": lambda m: m.startswith("video/"),
    "audio": lambda m: m.startswith("audio/"),
    "document": lambda m: m.startswith("text/") or m in (
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    "archive": lambda m: m in (
        "application/zip", "application/x-tar", "application/gzip",
        "application/x-7z-compressed", "application/x-rar-compressed",
    ),
}
TYPE_ICONS = {
    "image": "🖼️", "video": "🎬", "audio": "🎵",
    "document": "📄", "archive": "🗜️", "other": "📁",
}


def classify(mime: str) -> str:
    for bucket, test in TYPE_BUCKETS.items():
        if test(mime):
            return bucket
    return "other"



# ---------------------------------------------------------------- levels

# Repo counts required to reach each level. The curve is deliberately front-
# loaded: the first few levels come quickly, while the top level demands 100
# repositories, so reaching Lv10 is a genuine milestone.
LEVEL_THRESHOLDS = [0, 1, 2, 5, 10, 18, 30, 45, 65, 100]
MAX_LEVEL = len(LEVEL_THRESHOLDS)


def level_for(repo_count: int) -> int:
    """Level 1-10 derived from how many repositories the user has created."""
    lvl = 1
    for i, need in enumerate(LEVEL_THRESHOLDS, start=1):
        if repo_count >= need:
            lvl = i
    return lvl


def level_progress(repo_count: int) -> dict:
    """Everything the UI needs to render the level badge and its tooltip."""
    lvl = level_for(repo_count)
    if lvl >= MAX_LEVEL:
        return {
            "level": MAX_LEVEL, "max": MAX_LEVEL,
            "current": repo_count, "next_at": None,
            "to_next": 0, "percent": 100,
        }
    next_at = LEVEL_THRESHOLDS[lvl]          # thresholds[lvl] is the next gate
    floor = LEVEL_THRESHOLDS[lvl - 1]
    span = max(1, next_at - floor)
    return {
        "level": lvl, "max": MAX_LEVEL,
        "current": repo_count, "next_at": next_at,
        "to_next": max(0, next_at - repo_count),
        "percent": min(100, round((repo_count - floor) / span * 100)),
    }


templates.env.globals["level_for"] = level_for


def avatar_url(avatar: str | None) -> str:
    """Resolve a stored avatar value to an image URL.

    Uploaded avatars are filenames; built-in ones are stored as "preset:N"
    so they never collide with uploads and need no cleanup on the server.
    """
    if not avatar:
        return ""
    if avatar.startswith("preset:"):
        return f"/static/img/avatar-{avatar.split(':', 1)[1]}.svg"
    return f"/media/avatar/{avatar}"



def banner_image_url(banner: dict | str | None) -> str:
    """Resolve the banner config's image field to a servable URL."""
    if not banner:
        return ""
    if isinstance(banner, str):
        try:
            banner = json.loads(banner)
        except json.JSONDecodeError:
            return ""
    name = (banner or {}).get("image")
    return f"/media/banner/{name}" if name else ""


templates.env.globals["banner_image_url"] = banner_image_url


def chat_bg_image_url(cfg: dict | str | None) -> str:
    """Resolve a chat-background config's image field to a servable URL.

    Both backgrounds store a filename produced by make_banner(), so they share
    the same /media/banner/ route and the same regex guard there — a separate
    route would only duplicate the filename check.
    """
    if not cfg:
        return ""
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except json.JSONDecodeError:
            return ""
    name = (cfg or {}).get("image")
    return f"/media/banner/{name}" if name else ""

templates.env.globals["avatar_url"] = avatar_url

templates.env.globals["classify"] = classify
templates.env.globals["type_icon"] = lambda m: TYPE_ICONS[classify(m)]


def page_ctx(request: Request, nav: str = "", **extra):
    ctx = {"user": current_user(request), "q": "", "active_nav": nav,
           "site_owner": site_owner_name()}
    ctx.update(extra)
    return ctx


def site_owner_name() -> str:
    """The site owner: the account created first.

    There is no roles table and adding one for a single flag would be
    ceremony — the first row in `users` is the person who set the site up, and
    that is exactly the badge being shown. Cached per process because it is read
    on every page render and cannot change without a database edit.
    """
    global _SITE_OWNER
    if _SITE_OWNER is None:
        with db() as c:
            row = c.execute(
                "SELECT username FROM users ORDER BY id LIMIT 1"
            ).fetchone()
        _SITE_OWNER = row["username"] if row else ""
    return _SITE_OWNER


def can_view_repo(repo_row, user) -> bool:
    """Private repos are visible only to their owner."""
    if not repo_row["is_private"]:
        return True
    return bool(user and user["id"] == repo_row["owner_id"])


def get_repo_or_404(conn, owner: str, repo_name: str):
    row = conn.execute(
        """SELECT r.*, u.username AS owner_name FROM repos r
           JOIN users u ON u.id = r.owner_id
           WHERE u.username = ? AND r.name = ?""",
        (owner, repo_name),
    ).fetchone()
    if not row:
        raise HTTPException(404)
    return row


def require_repo_access(request: Request, owner: str, repo_name: str):
    """Fetch a repo and enforce read permission. Returns (repo_row, user)."""
    user = current_user(request)
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
    if not can_view_repo(repo, user):
        # 404 rather than 403 so a private repo's existence is not leaked.
        raise HTTPException(404)
    return repo, user


# markdown-lite renderer (escapes HTML first — output is safe)
MD_CODE_RE = re.compile(r"```(\w*)\n(.*?)```", re.S)
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")


def md_to_html(src: str) -> str:
    src = src.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    blocks: list[str] = []

    def _code(m):
        blocks.append(f"<pre><code>{m.group(2)}</code></pre>")
        return f"\x00{len(blocks) - 1}\x00"

    src = MD_CODE_RE.sub(_code, src)
    out, in_list = [], False
    for line in src.splitlines():
        if line.startswith("```"):  # stray fence
            continue
        stripped = line.strip()
        h = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        li = re.match(r"^[-*]\s+(.*)$", stripped)
        oli = re.match(r"^\d+\.\s+(.*)$", stripped)
        if h:
            if in_list:
                out.append("</ul>")
                in_list = False
            lvl = len(h.group(1))
            out.append(f"<h{lvl}>{h.group(2)}</h{lvl}>")
        elif li or oli:
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{(li or oli).group(1)}</li>")
        else:
            if in_list:
                out.append("</ul>")
                in_list = False
            if stripped in ("", "---"):
                out.append("<hr>" if stripped else "")
            elif stripped.startswith(">"):
                out.append(f"<blockquote>{stripped.lstrip('> ')}</blockquote>")
            else:
                out.append(f"<p>{stripped}</p>")
    if in_list:
        out.append("</ul>")
    html = "\n".join(out)
    html = MD_LINK_RE.sub(r'<a href="\2" target="_blank" rel="noopener">\1</a>', html)
    html = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html)
    html = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", html)
    html = re.sub(r"`([^`]+)`", r"<code>\1</code>", html)
    for i, b in enumerate(blocks):
        html = html.replace(f"\x00{i}\x00", b)
    return html


# ---------------------------------------------------------------- pages


@app.get("/", response_class=None)
def home(request: Request):
    with db() as c:
        stats = {
            "users": c.execute("SELECT COUNT(*) n FROM users").fetchone()["n"],
            "repos": c.execute("SELECT COUNT(*) n FROM repos").fetchone()["n"],
            "files": c.execute("SELECT COUNT(*) n FROM files").fetchone()["n"],
            "downloads": c.execute(
                "SELECT COALESCE(SUM(downloads),0) n FROM files"
            ).fetchone()["n"],
        }
        repos = c.execute(
            """SELECT r.id, r.name, r.description, r.updated_at, r.cover, r.is_private, u.username,
                      (SELECT COUNT(*) FROM files f WHERE f.repo_id = r.id) file_count,
                      (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.repo_id = r.id) total_size,
                      (SELECT COUNT(*) FROM stars s WHERE s.repo_id = r.id) star_count
               FROM repos r JOIN users u ON u.id = r.owner_id
               WHERE r.is_private = 0
               ORDER BY r.updated_at DESC LIMIT 6"""
        ).fetchall()
    return render(request, "index.html", page_ctx(request, nav="home", stats=stats, repos=repos))


@app.get("/login")
def login_page(request: Request):
    # Already signed in: there is nothing to do here, so go home rather than
    # showing a login modal over the site.
    if current_user(request):
        return RedirectResponse("/", status_code=303)
    return render(request, "login.html", page_ctx(request))


@app.post("/login")
def login_submit(request: Request, username: str = Form(""), password: str = Form("")):
    with db() as c:
        row = c.execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        ).fetchone()
    if row and hash_pw(password, row["pw_salt"]) == row["pw_hash"]:
        resp = RedirectResponse("/", status_code=303)
        login_user(resp, row["id"])
        return resp
    return render(
        request,
        "login.html",
        page_ctx(request, error="用户名或密码不正确"),
        status_code=401,
    )


@app.get("/register")
def register_page(request: Request):
    if current_user(request):
        return RedirectResponse("/", status_code=303)
    return render(request, "register.html", page_ctx(request))


@app.post("/register")
def register_submit(request: Request, username: str = Form(""), password: str = Form("")):
    error = None
    if not USERNAME_RE.match(username):
        error = "用户名只能包含字母、数字、下划线和连字符（2-32 位）"
    elif len(password) < 6:
        error = "密码至少 6 位"
    else:
        with db() as c:
            if c.execute(
                "SELECT 1 FROM users WHERE username = ?", (username,)
            ).fetchone():
                error = "该用户名已被注册"
            else:
                salt = secrets.token_hex(16)
                c.execute(
                    "INSERT INTO users (username, pw_salt, pw_hash, created_at)"
                    " VALUES (?, ?, ?, ?)",
                    (username, salt, hash_pw(password, salt), int(time.time())),
                )
                uid = c.execute(
                    "SELECT id FROM users WHERE username = ?", (username,)
                ).fetchone()["id"]
        if error is None:
            resp = RedirectResponse("/", status_code=303)
            login_user(resp, uid)
            return resp
    return render(
        request, "register.html", page_ctx(request, error=error), status_code=400
    )


@app.post("/logout")
def logout():
    resp = RedirectResponse("/", status_code=303)
    resp.delete_cookie("fh_session")
    return resp


@app.get("/new")
def new_repo_page(request: Request):
    if not current_user(request):
        return RedirectResponse("/login", status_code=303)
    return render(request, "new_repo.html", page_ctx(request))


@app.post("/new")
def new_repo_submit(
    request: Request,
    name: str = Form(""),
    description: str = Form(""),
    is_private: str = Form(""),
):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    name = name.strip()
    name_err = repo_name_error(name)
    if name_err:
        return render(
            request,
            "new_repo.html",
            page_ctx(request, error=name_err),
            status_code=400,
        )
    with db() as c:
        if c.execute(
            "SELECT 1 FROM repos WHERE owner_id = ? AND name = ?",
            (user["id"], name),
        ).fetchone():
            return render(
                request,
                "new_repo.html",
                page_ctx(request, error="你已有同名仓库"),
                status_code=400,
            )
        now = int(time.time())
        c.execute(
            "INSERT INTO repos (owner_id, name, description, created_at, updated_at, is_private)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (user["id"], name, description.strip()[:500], now, now, 1 if is_private else 0),
        )
    return RedirectResponse(f"/r/{user['username']}/{name}", status_code=303)


@app.get("/u/{username}")
def profile(request: Request, username: str, msg: str = ""):
    me = current_user(request)
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if not u:
            raise HTTPException(404)
        is_self = bool(me and me["id"] == u["id"])
        banner = {}
        if u["banner"]:
            try:
                banner = json.loads(u["banner"])
            except json.JSONDecodeError:
                banner = {}
        # A visitor sees public repos only; the owner sees everything.
        priv_clause = "" if is_self else " AND r.is_private = 0"
        repos = c.execute(
            f"""SELECT r.id, r.name, r.description, r.updated_at, r.cover, r.is_private,
                      (SELECT COUNT(*) FROM files f WHERE f.repo_id = r.id) file_count,
                      (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.repo_id = r.id) total_size,
                      (SELECT COUNT(*) FROM stars s WHERE s.repo_id = r.id) star_count
               FROM repos r WHERE r.owner_id = ?{priv_clause} ORDER BY r.updated_at DESC""",
            (u["id"],),
        ).fetchall()
        total_files = c.execute(
            f"""SELECT COUNT(*) n FROM files f JOIN repos r ON r.id = f.repo_id
               WHERE r.owner_id = ?{priv_clause}""",
            (u["id"],),
        ).fetchone()["n"]
        total_downloads = c.execute(
            f"""SELECT COALESCE(SUM(f.downloads),0) n FROM files f
               JOIN repos r ON r.id = f.repo_id WHERE r.owner_id = ?{priv_clause}""",
            (u["id"],),
        ).fetchone()["n"]
        total_size = c.execute(
            f"""SELECT COALESCE(SUM(f.size),0) n FROM files f
               JOIN repos r ON r.id = f.repo_id WHERE r.owner_id = ?{priv_clause}""",
            (u["id"],),
        ).fetchone()["n"]
        # Daily upload counts for the heatmap (last 365 days).
        follower_count = c.execute(
            "SELECT COUNT(*) n FROM follows WHERE followee_id = ?", (u["id"],)
        ).fetchone()["n"]
        following_count = c.execute(
            "SELECT COUNT(*) n FROM follows WHERE follower_id = ?", (u["id"],)
        ).fetchone()["n"]
        is_following = False
        if me and me["id"] != u["id"]:
            is_following = bool(c.execute(
                "SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?",
                (me["id"], u["id"]),
            ).fetchone())
        day_rows = c.execute(
            """SELECT f.created_at FROM files f JOIN repos r ON r.id = f.repo_id
               WHERE r.owner_id = ?""",
            (u["id"],),
        ).fetchall()
        file_type_rows = c.execute(
            """SELECT f.mime FROM files f JOIN repos r ON r.id = f.repo_id
               WHERE r.owner_id = ?""",
            (u["id"],),
        ).fetchall()

    counts: dict[str, int] = {}
    for r in day_rows:
        day = time.strftime("%Y-%m-%d", time.gmtime(r["created_at"]))
        counts[day] = counts.get(day, 0) + 1

    # Build the trailing ~26 weeks grid, Sunday-aligned like a contribution graph.
    today = datetime.date.today()
    start = today - datetime.timedelta(days=364)
    start -= datetime.timedelta(days=(start.weekday() + 1) % 7)  # back to Sunday
    weeks: list[list[dict]] = []
    day = start
    while day <= today:
        week = []
        for _ in range(7):
            key = day.isoformat()
            week.append({"date": key, "count": counts.get(key, 0)})
            day += datetime.timedelta(days=1)
        weeks.append(week)
    weeks = weeks[-26:]

    # Month labels are derived from the actual column dates, so each tick lines
    # up with the week it names instead of being spread evenly.
    month_ticks = []
    for i, week in enumerate(weeks):
        first = week[0]["date"]
        try:
            d = datetime.date.fromisoformat(first)
        except ValueError:
            continue
        if i == 0 or d.month != datetime.date.fromisoformat(weeks[i - 1][0]["date"]).month:
            month_ticks.append({"index": i, "label": f"{d.month}月"})

    type_counts: dict[str, int] = {}
    for r in file_type_rows:
        k = classify(r["mime"])
        type_counts[k] = type_counts.get(k, 0) + 1

    return render(
        request,
        "profile.html",
        page_ctx(
            request,
            nav="me" if is_self else "community",
            profile_user=dict(u),
            repos=repos,
            total_files=total_files,
            total_downloads=total_downloads,
            total_size=total_size,
            weeks=weeks,
            month_ticks=month_ticks,
            max_day=max(counts.values()) if counts else 1,
            type_counts=type_counts,
            banner=banner,
            level=level_progress(len([r for r in repos])),
            level_table=LEVEL_THRESHOLDS,
            follower_count=follower_count,
            following_count=following_count,
            is_following=is_following,
            is_self=is_self,
            msg=msg,
        ),
    )


@app.get("/repos")
def repos_page(request: Request, sort: str = "updated"):
    """Browse every public repository, with the people directory above it."""
    order = REPO_SORTS.get(sort, REPO_SORTS["updated"])
    with db() as c:
        rows = c.execute(
            f"""SELECT r.id, r.name, r.description, r.updated_at, r.cover, u.username,
                       (SELECT COUNT(*) FROM files f WHERE f.repo_id = r.id) file_count,
                       (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.repo_id = r.id) total_size,
                       (SELECT COUNT(*) FROM stars s WHERE s.repo_id = r.id) star_count
                FROM repos r JOIN users u ON u.id = r.owner_id
                WHERE r.is_private = 0
                ORDER BY {order} LIMIT 120"""
        ).fetchall()
        total = c.execute(
            "SELECT COUNT(*) n FROM repos WHERE is_private = 0"
        ).fetchone()["n"]
        # The people strip below the repos is a random sample, re-drawn on every
        # load, so the page surfaces different members each time instead of the
        # same top twelve. The owner is pinned to the front — see _random_people.
        people = _random_people(12)
        user_total = c.execute("SELECT COUNT(*) n FROM users").fetchone()["n"]
    return render(
        request,
        "repos.html",
        page_ctx(request, nav="repos", repos=rows, total=total, sort=sort,
                 people=people, user_total=user_total),
    )


# The community is a single public room. Messages live in the same comments
# table, under the reserved repo id 0, so every existing moderation and
# quoting path keeps working unchanged.
PUBLIC_ROOM = 0


@app.get("/community")
def community_page(request: Request):
    # The chat background is a per-visitor preference rather than a site-wide
    # setting: each person picks the backdrop they want to read messages
    # against, and it is stored on their own user row.
    me = current_user(request)
    chat_bg = {}
    if me:
        with db() as c:
            row = c.execute("SELECT chat_bg FROM users WHERE id = ?", (me["id"],)).fetchone()
        chat_bg, _ = _read_scene(row["chat_bg"] if row else None)
    return render(request, "community.html",
                  page_ctx(request, nav="community", chat_bg=chat_bg,
                           chat_bg_url=chat_bg_image_url(chat_bg)))


@app.get("/api/chat")
def api_chat_messages(request: Request):
    """Public room history, oldest first (chat reading order)."""
    me = current_user(request)
    with db() as c:
        rows = c.execute(
            """SELECT cm.id, cm.body, cm.created_at, cm.user_id, u.username, u.avatar,
                      cm.quote_id
               FROM comments cm JOIN users u ON u.id = cm.user_id
               WHERE cm.repo_id = ? ORDER BY cm.created_at ASC LIMIT 400""",
            (PUBLIC_ROOM,),
        ).fetchall()
        by_id = {r["id"]: r for r in rows}
        senders = len({r["user_id"] for r in rows})
        messages = []
        for r in rows:
            quoted = None
            if r["quote_id"] and r["quote_id"] in by_id:
                q = by_id[r["quote_id"]]
                quoted = {"id": q["id"], "username": q["username"], "body": q["body"][:160]}
            messages.append({
                "id": r["id"],
                "username": r["username"],
                "avatar": avatar_url(r["avatar"]),
                "body": r["body"],
                "created_at": r["created_at"],
                "time_label": time.strftime("%H:%M", time.localtime(r["created_at"])),
                "mine": bool(me and me["id"] == r["user_id"]),
                "quote": quoted,
            })
    return {"me": me["username"] if me else None, "senders": senders,
            "messages": messages}


@app.post("/api/chat")
async def api_chat_send(request: Request):
    me = current_user(request)
    if not me:
        raise HTTPException(401, "请先登录后发言")
    payload = {}
    try:
        payload = json.loads((await request.body()).decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        pass
    body = (payload.get("body") or "").strip()
    if not body or len(body) > 2000:
        raise HTTPException(400, "消息长度需为 1-2000 字符")
    quote_id = payload.get("quote_id")

    with db() as c:
        if quote_id:
            quoted = c.execute(
                "SELECT id, repo_id FROM comments WHERE id = ?", (quote_id,)
            ).fetchone()
            if not quoted or quoted["repo_id"] != PUBLIC_ROOM:
                quote_id = None
        now = int(time.time())
        cur = c.execute(
            """INSERT INTO comments (repo_id, user_id, body, created_at, quote_id)
               VALUES (?, ?, ?, ?, ?)""",
            (PUBLIC_ROOM, me["id"], body, now, quote_id),
        )
        cid = cur.lastrowid
        quoted_msg = None
        if quote_id:
            q = c.execute(
                """SELECT cm.body, u.username FROM comments cm
                   JOIN users u ON u.id = cm.user_id WHERE cm.id = ?""",
                (quote_id,),
            ).fetchone()
            if q:
                quoted_msg = {"id": quote_id, "username": q["username"], "body": q["body"][:160]}

    return {
        "id": cid,
        "username": me["username"],
        "avatar": avatar_url(me.get("avatar")),
        "body": body,
        "created_at": now,
        "time_label": time.strftime("%H:%M", time.localtime(now)),
        "mine": True,
        "quote": quoted_msg,
    }


# The three shelves shown on an empty search page. Each is a plain ordering of
# the same public repos, so they reuse one query shape rather than three.
DISCOVER_SETS = (
    ("stars", "最多星标", "star_count DESC, r.updated_at DESC"),
    ("recent", "最近更新", "r.updated_at DESC"),
    ("downloads", "下载最多", "download_count DESC, star_count DESC"),
)


def _discover_repos(which: str, per_set: int = 24):
    """One curated shelf of repositories, chosen by the tab that is active."""
    entry = next((e for e in DISCOVER_SETS if e[0] == which), DISCOVER_SETS[0])
    _, _, order = entry
    with db() as c:
        return c.execute(
            f"""SELECT r.id, r.name, r.description, r.updated_at, r.cover, u.username,
                       (SELECT COUNT(*) FROM files f WHERE f.repo_id = r.id) file_count,
                       (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.repo_id = r.id) total_size,
                       (SELECT COUNT(*) FROM stars s WHERE s.repo_id = r.id) star_count,
                       (SELECT COALESCE(SUM(f.downloads),0) FROM files f
                         WHERE f.repo_id = r.id) download_count
                FROM repos r JOIN users u ON u.id = r.owner_id
                WHERE r.is_private = 0
                ORDER BY {order} LIMIT ?""",
            (per_set,),
        ).fetchall()


def _random_people(limit: int = 50):
    """A fresh random sample of users, with the site owner always included.

    Randomised per request so the page looks different on each refresh, which is
    what makes a directory feel alive. The owner is prepended rather than left to
    chance: the person who runs the site should not be missing from the list
    two times out of three. `ORDER BY RANDOM()` is fine at this scale — it is a
    single scan of a few hundred rows with no index to defeat.
    """
    owner = site_owner_name()
    with db() as c:
        rows = c.execute(
            """SELECT u.username, u.avatar, u.bio, u.created_at,
                      (SELECT COUNT(*) FROM repos r
                        WHERE r.owner_id = u.id AND r.is_private = 0) repo_count,
                      (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) follower_count
               FROM users u
               WHERE u.username != ?
               ORDER BY RANDOM() LIMIT ?""",
            (owner, max(0, limit - (1 if owner else 0))),
        ).fetchall()
        pinned = []
        if owner:
            row = c.execute(
                """SELECT u.username, u.avatar, u.bio, u.created_at,
                          (SELECT COUNT(*) FROM repos r
                            WHERE r.owner_id = u.id AND r.is_private = 0) repo_count,
                          (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) follower_count
                   FROM users u WHERE u.username = ?""",
                (owner,),
            ).fetchone()
            if row:
                pinned.append(row)
    return pinned + list(rows)


# Sort options for the full repository list. Each entry is (key, label, ORDER BY).
REPO_SORTS = {
    "updated": "r.updated_at DESC",
    "stars": "star_count DESC, r.updated_at DESC",
    "name": "r.name COLLATE NOCASE ASC",
    "size": "total_size DESC",
}


# Sort options for the full member list. Each entry is (key, label, ORDER BY).
PEOPLE_SORTS = (
    ("joined_desc", "最新加入", "u.created_at DESC"),
    ("joined_asc", "最早加入", "u.created_at ASC"),
    ("name_asc", "名称 A→Z", "u.username COLLATE NOCASE ASC"),
    ("name_desc", "名称 Z→A", "u.username COLLATE NOCASE DESC"),
    ("followers", "粉丝最多", "follower_count DESC, u.created_at ASC"),
    ("repos", "仓库最多", "repo_count DESC, u.created_at ASC"),
)


@app.get("/people")
def people_page(request: Request, sort: str = "joined_desc"):
    """Every member, in one sortable six-column list."""
    order = next((s[2] for s in PEOPLE_SORTS if s[0] == sort), PEOPLE_SORTS[0][2])
    with db() as c:
        rows = c.execute(
            f"""SELECT u.username, u.avatar, u.bio, u.created_at,
                       (SELECT COUNT(*) FROM repos r
                         WHERE r.owner_id = u.id AND r.is_private = 0) repo_count,
                       (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) follower_count
                FROM users u
                ORDER BY {order} LIMIT 1000"""
        ).fetchall()
    return render(
        request,
        "people.html",
        page_ctx(request, nav="repos", people=rows, total=len(rows),
                 sorts=PEOPLE_SORTS, sort=sort),
    )


@app.get("/api/discover/{which}")
def api_discover(which: str):
    """The repository shelf for one discover tab.

    The search page swaps shelves in place rather than reloading, so it needs
    the shelf as data. The cards are rendered server-side and sent as HTML: the
    alternative is a second copy of the card markup written in JavaScript, which
    would then have to be kept in step with the template by hand.
    """
    if which not in {k for k, _, _ in DISCOVER_SETS}:
        raise HTTPException(404)
    rows = _discover_repos(which)
    html = templates.get_template("_repo_cards.html").render(repos=rows, cover_tab=which)
    return {"tab": which, "html": html, "count": len(rows)}


@app.get("/api/sort/repos")
def api_sort_repos(sort: str = "updated"):
    """The repository grid for /repos, in one sort order.

    Sorting is a view of the same page, so the tabs swap the grid in place
    rather than navigating. Cards come from the template the page itself uses —
    a JavaScript copy of the card markup would drift out of step with it.
    """
    order = REPO_SORTS.get(sort, REPO_SORTS["updated"])
    with db() as c:
        rows = c.execute(
            f"""SELECT r.id, r.name, r.description, r.updated_at, r.cover, u.username,
                       (SELECT COUNT(*) FROM files f WHERE f.repo_id = r.id) file_count,
                       (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.repo_id = r.id) total_size,
                       (SELECT COUNT(*) FROM stars s WHERE s.repo_id = r.id) star_count
                FROM repos r JOIN users u ON u.id = r.owner_id
                WHERE r.is_private = 0
                ORDER BY {order} LIMIT 120"""
        ).fetchall()
    html = templates.get_template("_repo_cards.html").render(repos=rows, cover_tab=sort)
    return {"sort": sort, "html": html, "count": len(rows)}


@app.get("/api/sort/people")
def api_sort_people(sort: str = "joined_desc"):
    """The member list for /people, in one sort order."""
    order = next((s[2] for s in PEOPLE_SORTS if s[0] == sort), PEOPLE_SORTS[0][2])
    with db() as c:
        rows = c.execute(
            f"""SELECT u.username, u.avatar, u.bio, u.created_at,
                       (SELECT COUNT(*) FROM repos r
                         WHERE r.owner_id = u.id AND r.is_private = 0) repo_count,
                       (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) follower_count
                FROM users u
                ORDER BY {order} LIMIT 1000"""
        ).fetchall()
    html = templates.get_template("_people_cards.html").render(
        people=rows, site_owner=site_owner_name(),
        grid_class="people-grid-6 people-grid-stack", show_bio=False,
    )
    return {"sort": sort, "html": html, "count": len(rows)}


@app.get("/search")
def search(request: Request, q: str = "", type: str = "", tab: str = "stars"):
    q = q.strip()
    like = f"%{q}%"
    # An empty query is the discover view: one shelf of repositories behind three
    # tabs, plus a random sample of users. It deliberately does NOT fall back to
    # listing the whole site — an unbounded dump under a search box is not a
    # browse experience, and the tabs give the page a shape.
    if not q:
        return render(request, "search.html",
                      page_ctx(request, q=q, repos=[], users=[],
                               discover_tabs=DISCOVER_SETS,
                               discover_tab=tab,
                               discover=_discover_repos(tab),
                               people=_random_people(50)))
    with db() as c:
        repos = c.execute(
            """SELECT r.id, r.name, r.description, r.updated_at, r.cover, u.username,
                      (SELECT COUNT(*) FROM files f WHERE f.repo_id = r.id) file_count,
                      (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.repo_id = r.id) total_size,
                      (SELECT COUNT(*) FROM stars s WHERE s.repo_id = r.id) star_count
               FROM repos r JOIN users u ON u.id = r.owner_id
               WHERE r.is_private = 0 AND (r.name LIKE ? OR r.description LIKE ?)
               ORDER BY r.updated_at DESC LIMIT 30""",
            (like, like),
        ).fetchall()
        users = c.execute(
            "SELECT username, created_at, avatar FROM users WHERE username LIKE ? LIMIT 20",
            (like,),
        ).fetchall()
    return render(request, "search.html", page_ctx(request, q=q, repos=repos, users=users))


@app.get("/r/{owner}/{repo_name}")
def repo_page(request: Request, owner: str, repo_name: str, dir: str = "", msg: str = ""):
    me = current_user(request)
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
        if not can_view_repo(repo, me):
            raise HTTPException(404)
        repo = dict(repo)
        all_files = c.execute(
            "SELECT id, path, size, mime, downloads, created_at, tags, note, thumb"
            " FROM files WHERE repo_id = ?",
            (repo["id"],),
        ).fetchall()
        star_count = c.execute(
            "SELECT COUNT(*) n FROM stars WHERE repo_id = ?", (repo["id"],)
        ).fetchone()["n"]
        comments = c.execute(
            """SELECT cm.id, cm.body, cm.created_at, u.username, u.avatar FROM comments cm
               JOIN users u ON u.id = cm.user_id
               WHERE cm.repo_id = ? ORDER BY cm.created_at DESC LIMIT 100""",
            (repo["id"],),
        ).fetchall()
        aliases = {
            r["path"]: r["display_name"]
            for r in c.execute(
                "SELECT path, display_name FROM folder_names WHERE repo_id = ?",
                (repo["id"],),
            )
        }

    starred = False
    if me:
        with db() as c:
            starred = bool(
                c.execute(
                    "SELECT 1 FROM stars WHERE user_id = ? AND repo_id = ?",
                    (me["id"], repo["id"]),
                ).fetchone()
            )

    prefix = ""
    try:
        if dir:
            prefix = sanitize_relpath(dir) + "/"
    except ValueError:
        raise HTTPException(404)

    folders: dict[str, dict] = {}
    files_here = []
    for f in all_files:
        if not f["path"].startswith(prefix):
            continue
        rest = f["path"][len(prefix):]
        if "/" in rest:
            top = rest.split("/", 1)[0]
            agg = folders.setdefault(top, {"name": top, "count": 0, "size": 0})
            agg["count"] += 1
            agg["size"] += f["size"]
        else:
            files_here.append(dict(f, name=rest))
    files_here.sort(key=lambda f: f["name"].lower())
    folder_list = sorted(folders.values(), key=lambda d: d["name"].lower())
    for d in folder_list:
        d["display"] = aliases.get(prefix + d["name"], d["name"])

    # ---- stats panel: size and count per file-type bucket
    buckets = {k: {"count": 0, "size": 0} for k in TYPE_ICONS}
    for f in all_files:
        b = buckets[classify(f["mime"])]
        b["count"] += 1
        b["size"] += f["size"]
    total_size = sum(f["size"] for f in all_files) or 1
    type_stats = [
        {
            "key": k,
            "icon": TYPE_ICONS[k],
            "count": v["count"],
            "size": v["size"],
            "pct": round(v["size"] / total_size * 100, 1),
        }
        for k, v in buckets.items()
        if v["count"]
    ]
    type_stats.sort(key=lambda d: d["size"], reverse=True)

    total_downloads = sum(f["downloads"] for f in all_files)
    readme = next(
        (f for f in all_files if "/" not in f["path"] and f["path"].lower() in
         ("readme.md", "readme.markdown", "readme.txt")),
        None,
    )
    readme_html = ""
    if readme:
        # UPLOAD_DIR, not APP_DIR/"uploads": these two walks are the only places
        # that spelled the path out again, so they kept reading the checkout's
        # directory after FILEHUB_DATA moved the real one — the README rendered
        # empty in a container while the file sat right there on the volume.
        stored = UPLOAD_DIR / readme["stored_name"] if "stored_name" in readme.keys() else None
        if stored is None:
            with db() as c:
                row = c.execute(
                    "SELECT stored_name FROM files WHERE id = ?", (readme["id"],)
                ).fetchone()
            stored = UPLOAD_DIR / row["stored_name"] if row else None
        if stored and stored.exists():
            try:
                readme_html = md_to_html(stored.read_text("utf-8", errors="replace")[:100_000])
            except OSError:
                pass

    crumbs = [{"name": "..", "dir": ""}] if prefix else []
    if prefix:
        acc = ""
        for seg in prefix.rstrip("/").split("/"):
            acc = f"{acc}/{seg}" if acc else seg
            crumbs.append({"name": aliases.get(acc, seg), "dir": acc})
    if crumbs:
        crumbs[-1]["name"] = ""

    with db() as c:
        readme_id = readme["id"] if readme else None
        readme_exists = bool(readme)

    return render(
        request,
        "repo.html",
        page_ctx(
            request,
            nav="repos",
            repo=repo,
            owner=owner,
            dir=dir,
            prefix=prefix,
            aliases=aliases,
            folders=folder_list,
            files=files_here,
            file_count=len(all_files),
            total_size=sum(f["size"] for f in all_files),
            total_downloads=total_downloads,
            type_stats=type_stats,
            star_count=star_count,
            starred=starred,
            comments=comments,
            readme_html=readme_html,
            readme_id=readme_id,
            readme_exists=readme_exists,
            is_owner=bool(me and me["id"] == repo["owner_id"]),
            msg=msg,
        ),
    )


# ---------------------------------------------------------------- files & api


@app.post("/r/{owner}/{repo_name}/upload")
async def upload(
    request: Request,
    owner: str,
    repo_name: str,
    files: list[UploadFile] = File(default=[]),
):
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
        quota = disk_quota(c)
    if repo["owner_id"] != me["id"]:
        raise HTTPException(403, "只有仓库所有者可以上传")

    # Read the ceiling once for the whole request, then carry the running total
    # as files are accepted. Rescanning per file would let one request walk past
    # the limit with a batch of files that are each individually small enough.
    used = uploads_bytes()
    saved = 0
    refused = ""

    for uf in files:
        rel = sanitize_relpath(uf.filename or "unnamed")
        stored_name = uuid.uuid4().hex
        dest = UPLOAD_DIR / stored_name
        size = 0
        try:
            with dest.open("wb") as out:
                while chunk := await uf.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_FILE_SIZE:
                        raise ValueError("单个文件超过 200 MB 限制")
                    if used + size > quota:
                        raise ValueError(
                            f"磁盘已达上限 {fmt_size(quota)}，请先清理空间或调高上限"
                        )
                    out.write(chunk)
        except ValueError as exc:
            # A refusal is an ordinary outcome, not a fault — the partial write
            # is dropped and the reason is handed back through the page's own
            # message channel rather than as a bare error response.
            dest.unlink(missing_ok=True)
            refused = str(exc)
            break
        except Exception:
            dest.unlink(missing_ok=True)
            raise

        mime = uf.content_type or guess_mime(rel)
        thumb = None
        if mime.startswith("image/"):
            thumb = make_thumbnail(dest)
        elif mime.startswith("video/"):
            thumb = make_thumbnail(dest, is_video=True)

        with db() as c:
            # Re-uploading the same path replaces the file, matching how a
            # repository is expected to behave (and keeping archive names unique).
            old = c.execute(
                "SELECT id, stored_name, thumb FROM files WHERE repo_id = ? AND path = ?",
                (repo["id"], rel),
            ).fetchone()
            if old:
                (UPLOAD_DIR / old["stored_name"]).unlink(missing_ok=True)
                if old["thumb"]:
                    (UPLOAD_DIR / old["thumb"]).unlink(missing_ok=True)
                c.execute("DELETE FROM files WHERE id = ?", (old["id"],))
                # Replacing frees the bytes it held. Its thumbnail's bytes are
                # not credited back (they are not recorded anywhere), which
                # makes the running total slightly conservative.
                used -= old["size"]

            c.execute(
                """INSERT INTO files (repo_id, uploader_id, path, stored_name, size, mime, created_at, thumb)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (repo["id"], me["id"], rel, stored_name, size, mime, int(time.time()), thumb),
            )
            c.execute(
                "UPDATE repos SET updated_at = ? WHERE id = ?",
                (int(time.time()), repo["id"]),
            )
        used += size
        saved += 1

    if refused:
        msg = f"{refused}（本次已保存 {saved} 个）" if saved else refused
        return RedirectResponse(
            f"/r/{owner}/{repo_name}?msg={quote(msg)}", status_code=303
        )
    return RedirectResponse(
        f"/r/{owner}/{repo_name}?msg={saved}+个文件已上传", status_code=303
    )


def _get_file_or_404(fid: int):
    with db() as c:
        f = c.execute(
            """SELECT f.*, r.owner_id, u.username AS owner, r.name AS repo_name
               FROM files f
               JOIN repos r ON r.id = f.repo_id
               JOIN users u ON u.id = r.owner_id
               WHERE f.id = ?""",
            (fid,),
        ).fetchone()
    if not f:
        raise HTTPException(404)
    return f


@app.get("/file/{fid}/download")
def download(fid: int):
    f = _get_file_or_404(fid)
    path = UPLOAD_DIR / f["stored_name"]
    if not path.exists():
        raise HTTPException(404)
    with db() as c:
        c.execute(
            "UPDATE files SET downloads = downloads + 1 WHERE id = ?", (fid,)
        )
    filename = f["path"].split("/")[-1]
    return FileResponse(
        path,
        media_type=f["mime"],
        filename=filename,
        headers={"Content-Length": str(f["size"])},
    )


@app.get("/file/{fid}/raw")
def raw(fid: int):
    f = _get_file_or_404(fid)
    path = UPLOAD_DIR / f["stored_name"]
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type=f["mime"])


@app.post("/file/{fid}/delete")
def delete_file(request: Request, fid: int):
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    f = _get_file_or_404(fid)
    if f["owner_id"] != me["id"] and f["uploader_id"] != me["id"]:
        raise HTTPException(403)
    (UPLOAD_DIR / f["stored_name"]).unlink(missing_ok=True)
    with db() as c:
        c.execute("DELETE FROM files WHERE id = ?", (fid,))
    return RedirectResponse(
        f"/r/{f['owner']}/{f['repo_name']}", status_code=303
    )


@app.post("/api/star/{repo_id}")
def toggle_star(request: Request, repo_id: int):
    me = current_user(request)
    if not me:
        raise HTTPException(401, "请先登录")
    with db() as c:
        if c.execute(
            "SELECT 1 FROM stars WHERE user_id = ? AND repo_id = ?",
            (me["id"], repo_id),
        ).fetchone():
            c.execute(
                "DELETE FROM stars WHERE user_id = ? AND repo_id = ?",
                (me["id"], repo_id),
            )
            starred = False
        else:
            c.execute(
                "INSERT INTO stars (user_id, repo_id) VALUES (?, ?)",
                (me["id"], repo_id),
            )
            starred = True
        count = c.execute(
            "SELECT COUNT(*) n FROM stars WHERE repo_id = ?", (repo_id,)
        ).fetchone()["n"]
    return {"starred": starred, "count": count}


@app.post("/api/comment/{repo_id}")
async def add_comment(request: Request, repo_id: int):
    me = current_user(request)
    if not me:
        raise HTTPException(401, "请先登录")
    payload = {}
    try:
        payload = json.loads((await request.body()).decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        pass
    body = (payload.get("body") or "").strip()
    if not body or len(body) > 2000:
        raise HTTPException(400, "评论内容需为 1-2000 字符")
    with db() as c:
        if not c.execute(
            "SELECT 1 FROM repos WHERE id = ?", (repo_id,)
        ).fetchone():
            raise HTTPException(404)
        now = int(time.time())
        cur = c.execute(
            "INSERT INTO comments (repo_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
            (repo_id, me["id"], body, now),
        )
        cid = cur.lastrowid
    return {
        "id": cid,
        "username": me["username"],
        "avatar": avatar_url(me.get("avatar")),
        "body": body,
        "created_at": rel_time(now),
    }


@app.post("/api/comment/{comment_id}/edit")
async def edit_comment(request: Request, comment_id: int):
    me = current_user(request)
    if not me:
        raise HTTPException(401, "请先登录")
    payload = {}
    try:
        payload = json.loads((await request.body()).decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        pass
    body = (payload.get("body") or "").strip()
    if not body or len(body) > 2000:
        raise HTTPException(400, "评论内容需为 1-2000 字符")
    with db() as c:
        row = c.execute(
            "SELECT user_id FROM comments WHERE id = ?", (comment_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404)
        # Only the author may edit their own comment.
        if row["user_id"] != me["id"]:
            raise HTTPException(403, "只能编辑自己的评论")
        c.execute("UPDATE comments SET body = ? WHERE id = ?", (body, comment_id))
    return {"id": comment_id, "body": body, "edited": True}


@app.post("/api/comment/{comment_id}/delete")
def delete_comment(request: Request, comment_id: int):
    me = current_user(request)
    if not me:
        raise HTTPException(401, "请先登录")
    with db() as c:
        row = c.execute(
            "SELECT user_id FROM comments WHERE id = ?", (comment_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404)
        if row["user_id"] != me["id"]:
            raise HTTPException(403, "只能删除自己的评论")
        c.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
    return {"id": comment_id, "deleted": True}


@app.exception_handler(404)
async def not_found(request: Request, exc):
    return render(request, "error.html", page_ctx(request), status_code=404)


# ---------------------------------------------------------------- avatar


@app.post("/settings/avatar")
async def upload_avatar(request: Request, avatar: UploadFile = File(...)):
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    stored_old = None
    with db() as c:
        row = c.execute("SELECT avatar FROM users WHERE id = ?", (me["id"],)).fetchone()
        stored_old = row["avatar"] if row else None

    tmp = UPLOAD_DIR / f"tmp_{uuid.uuid4().hex}"
    size = 0
    oversized = False
    with tmp.open("wb") as out:
        while chunk := await avatar.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_COVER_SIZE:
                oversized = True
                break
            out.write(chunk)

    # Close the handle before deleting: Windows refuses to unlink an open file.
    if oversized:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, "头像不能超过 10 MB")

    name = make_avatar(tmp)
    tmp.unlink(missing_ok=True)
    if not name:
        raise HTTPException(400, "无法识别该图片格式")

    with db() as c:
        c.execute("UPDATE users SET avatar = ? WHERE id = ?", (name, me["id"]))
    if stored_old:
        (UPLOAD_DIR / stored_old).unlink(missing_ok=True)
    return RedirectResponse(f"/u/{me['username']}?msg=头像已更新", status_code=303)


@app.post("/settings/avatar/delete")
def delete_avatar(request: Request):
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    with db() as c:
        row = c.execute("SELECT avatar FROM users WHERE id = ?", (me["id"],)).fetchone()
        if row and row["avatar"]:
            (UPLOAD_DIR / row["avatar"]).unlink(missing_ok=True)
        c.execute("UPDATE users SET avatar = NULL WHERE id = ?", (me["id"],))
    return RedirectResponse(f"/u/{me['username']}", status_code=303)


@app.get("/settings/avatar/crop")
def avatar_crop_page(request: Request):
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    return render(request, "avatar_crop.html", page_ctx(request, username=me["username"]))


@app.get("/media/avatar/{stored_name}")
def serve_avatar(stored_name: str):
    if not re.fullmatch(r"avatar_[0-9a-f]{32}\.jpg", stored_name):
        raise HTTPException(404)
    path = UPLOAD_DIR / stored_name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


@app.get("/media/thumb/{stored_name}")
def serve_thumb(stored_name: str):
    if not re.fullmatch(r"[0-9a-f]{32}_thumb\.jpg", stored_name):
        raise HTTPException(404)
    path = UPLOAD_DIR / stored_name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


# ---------------------------------------------------------------- repo settings


@app.post("/r/{owner}/{repo_name}/visibility")
def toggle_visibility(request: Request, owner: str, repo_name: str):
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
        if repo["owner_id"] != me["id"]:
            raise HTTPException(403)
        new_val = 0 if repo["is_private"] else 1
        c.execute("UPDATE repos SET is_private = ? WHERE id = ?", (new_val, repo["id"]))
    label = "已设为私有仓库 🔒" if new_val else "已设为公开仓库 🌐"
    return RedirectResponse(f"/r/{owner}/{repo_name}?msg={label}", status_code=303)


@app.post("/r/{owner}/{repo_name}/delete")
def delete_repo(request: Request, owner: str, repo_name: str):
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
        if repo["owner_id"] != me["id"]:
            raise HTTPException(403)
        for f in c.execute(
            "SELECT stored_name, thumb FROM files WHERE repo_id = ?", (repo["id"],)
        ):
            (UPLOAD_DIR / f["stored_name"]).unlink(missing_ok=True)
            if f["thumb"]:
                (UPLOAD_DIR / f["thumb"]).unlink(missing_ok=True)
        c.execute("DELETE FROM files WHERE repo_id = ?", (repo["id"],))
        c.execute("DELETE FROM comments WHERE repo_id = ?", (repo["id"],))
        c.execute("DELETE FROM stars WHERE repo_id = ?", (repo["id"],))
        c.execute("DELETE FROM folder_names WHERE repo_id = ?", (repo["id"],))
        c.execute("DELETE FROM repos WHERE id = ?", (repo["id"],))
    return RedirectResponse(f"/u/{owner}?msg=仓库已删除", status_code=303)


@app.get("/r/{owner}/{repo_name}/archive")
def download_archive(request: Request, owner: str, repo_name: str):
    repo, _ = require_repo_access(request, owner, repo_name)
    if repo["owner_id"] != (current_user(request) or {}).get("id") and repo["is_private"]:
        raise HTTPException(404)
    with db() as c:
        rows = c.execute(
            "SELECT path, stored_name FROM files WHERE repo_id = ? ORDER BY path",
            (repo["id"],),
        ).fetchall()
    if not rows:
        raise HTTPException(404, "仓库为空")

    buf = io.BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in rows:
            src = UPLOAD_DIR / r["stored_name"]
            if not src.exists():
                continue
            arcname = r["path"]
            # Duplicate paths cannot occur (validated at upload) but a zip with
            # repeated names is broken, so disambiguate defensively.
            if arcname in used:
                stem, dot, ext = arcname.rpartition(".")
                arcname = f"{stem}_{uuid.uuid4().hex[:6]}{dot}{ext}" if dot else f"{arcname}_{uuid.uuid4().hex[:6]}"
            used.add(arcname)
            zf.write(src, arcname)
    buf.seek(0)

    safe = re.sub(r"[^A-Za-z0-9_-]", "_", repo_name) or "repo"
    return Response(
        buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe}.zip"'},
    )


# ---------------------------------------------------------------- file ops


@app.post("/r/{owner}/{repo_name}/bulk-delete")
async def bulk_delete(request: Request, owner: str, repo_name: str):
    me = current_user(request)
    if not me:
        raise HTTPException(401)
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
    if repo["owner_id"] != me["id"]:
        raise HTTPException(403)

    payload = {}
    try:
        payload = json.loads((await request.body()).decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        pass
    ids = payload.get("ids") or []
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "未选择文件")

    # Only delete rows that actually belong to this repo.
    placeholders = ",".join("?" * len(ids))
    with db() as c:
        rows = c.execute(
            f"SELECT id, stored_name, thumb FROM files"
            f" WHERE repo_id = ? AND id IN ({placeholders})",
            [repo["id"], *ids],
        ).fetchall()
        for r in rows:
            (UPLOAD_DIR / r["stored_name"]).unlink(missing_ok=True)
            if r["thumb"]:
                (UPLOAD_DIR / r["thumb"]).unlink(missing_ok=True)
            c.execute("DELETE FROM files WHERE id = ?", (r["id"],))
        c.execute("UPDATE repos SET updated_at = ? WHERE id = ?", (int(time.time()), repo["id"]))
    return {"deleted": len(rows)}


@app.post("/file/{fid}/meta")
async def update_file_meta(request: Request, fid: int):
    me = current_user(request)
    if not me:
        raise HTTPException(401)
    f = _get_file_or_404(fid)
    if f["owner_id"] != me["id"] and f["uploader_id"] != me["id"]:
        raise HTTPException(403)
    payload = {}
    try:
        payload = json.loads((await request.body()).decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        pass
    tags = str(payload.get("tags") or "").strip()[:200]
    note = str(payload.get("note") or "").strip()[:1000]
    with db() as c:
        c.execute("UPDATE files SET tags = ?, note = ? WHERE id = ?", (tags, note, fid))
    return {"tags": tags, "note": note}


@app.post("/r/{owner}/{repo_name}/rename-folder")
async def rename_folder(request: Request, owner: str, repo_name: str):
    me = current_user(request)
    if not me:
        raise HTTPException(401)
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
    if repo["owner_id"] != me["id"]:
        raise HTTPException(403)

    payload = {}
    try:
        payload = json.loads((await request.body()).decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        pass
    path = (payload.get("path") or "").strip()
    display = (payload.get("display_name") or "").strip()[:120]
    try:
        path = sanitize_relpath(path)
    except ValueError:
        raise HTTPException(400, "无效的文件夹路径")
    if not display:
        raise HTTPException(400, "名称不能为空")

    with db() as c:
        c.execute(
            """INSERT INTO folder_names (repo_id, path, display_name) VALUES (?, ?, ?)
               ON CONFLICT(repo_id, path) DO UPDATE SET display_name = excluded.display_name""",
            (repo["id"], path, display),
        )
    return {"path": path, "display_name": display}


PRESET_AVATARS = 6


@app.post("/settings/avatar/preset/{index}")
def set_preset_avatar(request: Request, index: int):
    """Assign one of the built-in geometric avatars."""
    me = current_user(request)
    if not me:
        raise HTTPException(401)
    if not 1 <= index <= PRESET_AVATARS:
        raise HTTPException(404)
    with db() as c:
        row = c.execute("SELECT avatar FROM users WHERE id = ?", (me["id"],)).fetchone()
        old = row["avatar"] if row else None
        c.execute("UPDATE users SET avatar = ? WHERE id = ?", (f"preset:{index}", me["id"]))
    # only delete a previously uploaded file, never another preset marker
    if old and not old.startswith("preset:"):
        (UPLOAD_DIR / old).unlink(missing_ok=True)
    return {"avatar": f"preset:{index}"}


@app.post("/api/follow/{username}")
def toggle_follow(request: Request, username: str):
    me = current_user(request)
    if not me:
        raise HTTPException(401, "请先登录")
    with db() as c:
        target = c.execute(
            "SELECT id FROM users WHERE username = ?", (username,)
        ).fetchone()
        if not target:
            raise HTTPException(404)
        if target["id"] == me["id"]:
            raise HTTPException(400, "不能关注自己")
        existing = c.execute(
            "SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?",
            (me["id"], target["id"]),
        ).fetchone()
        if existing:
            c.execute(
                "DELETE FROM follows WHERE follower_id = ? AND followee_id = ?",
                (me["id"], target["id"]),
            )
            following = False
        else:
            c.execute(
                "INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)",
                (me["id"], target["id"], int(time.time())),
            )
            following = True
        followers = c.execute(
            "SELECT COUNT(*) n FROM follows WHERE followee_id = ?", (target["id"],)
        ).fetchone()["n"]
    return {"following": following, "followers": followers}


@app.post("/r/{owner}/{repo_name}/edit")
async def edit_repo(request: Request, owner: str, repo_name: str):
    """Rename a repository and/or change its description (owner only)."""
    me = current_user(request)
    if not me:
        raise HTTPException(401, "请先登录")
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
    if repo["owner_id"] != me["id"]:
        raise HTTPException(403, "只有仓库所有者可以修改")

    payload = {}
    try:
        payload = json.loads((await request.body()).decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        pass

    new_name = (payload.get("name") or repo["name"]).strip()
    description = (payload.get("description") or "").strip()[:500]

    name_err = repo_name_error(new_name)
    if name_err:
        raise HTTPException(400, name_err)

    with db() as c:
        if new_name != repo["name"]:
            clash = c.execute(
                "SELECT 1 FROM repos WHERE owner_id = ? AND name = ? AND id != ?",
                (me["id"], new_name, repo["id"]),
            ).fetchone()
            if clash:
                raise HTTPException(400, "你已有同名仓库")
        c.execute(
            "UPDATE repos SET name = ?, description = ?, updated_at = ? WHERE id = ?",
            (new_name, description, int(time.time()), repo["id"]),
        )
    return {"name": new_name, "description": description, "owner": owner}


@app.post("/r/{owner}/{repo_name}/cover")
async def upload_repo_cover(
    request: Request,
    owner: str,
    repo_name: str,
    cover: UploadFile = File(...),
    crop: str = Form(""),
):
    """Set the repository cover from an uploaded image (max 10 MB).

    The crop dialog and the upload share this one request: the file arrives
    from the picker's change event, the dialog opens on it locally, and the
    form is only submitted once the owner confirms — so `crop` carries the
    square they chose and the picture is cut to it before it is stored. Asking
    after the upload instead (the old framing dialog) meant every cover was
    saved whole and then re-framed from a lossy preview.
    """
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
    if repo["owner_id"] != me["id"]:
        raise HTTPException(403)

    tmp = UPLOAD_DIR / ("tmp_" + uuid.uuid4().hex)
    size = 0
    oversized = False
    with tmp.open("wb") as out:
        while chunk := await cover.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_COVER_SIZE:
                oversized = True
                break
            out.write(chunk)

    # Cleanup happens after the handle closes: unlinking an open file raises on
    # Windows, which would mask the real error with a 500.
    if oversized:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, "封面图片不能超过 10 MB")

    crop_spec = None
    if crop:
        try:
            parsed = json.loads(crop)
            if isinstance(parsed, dict):
                crop_spec = parsed
        except json.JSONDecodeError:
            crop_spec = None

    name = make_cover(tmp, crop_spec)
    tmp.unlink(missing_ok=True)
    if not name:
        raise HTTPException(400, "封面仅支持 JPG 或 PNG 格式")

    previous = parse_cover(repo["cover"])
    key = build_cover(name, COVER_DEFAULT_SCALE, 50, 50)
    with db() as c:
        # Already cropped to the square the owner picked, so the framing starts
        # neutral: there is nothing left to zoom or pan.
        c.execute("UPDATE repos SET cover = ? WHERE id = ?", (key, repo["id"]))
    # Drop the file this cover replaced, but never the built-in gradients.
    if previous["kind"] == "upload" and previous["name"]:
        (UPLOAD_DIR / previous["name"]).unlink(missing_ok=True)

    return cover_response(request, key, owner, repo_name, "封面已更新")


@app.post("/r/{owner}/{repo_name}/cover/frame")
async def frame_repo_cover(request: Request, owner: str, repo_name: str):
    """Store the cover's framing: size, horizontal and vertical position.

    The framing is appended to the cover key rather than kept in its own column,
    so one value describes the whole cover and the card helper keeps working
    unchanged for every cover that has no framing.
    """
    me = current_user(request)
    if not me:
        raise HTTPException(401)
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
    if repo["owner_id"] != me["id"]:
        raise HTTPException(403)

    info = parse_cover(repo["cover"])
    if info["kind"] != "upload":
        raise HTTPException(400, "这个仓库还没有自定义封面")
    try:
        payload = json.loads((await request.body()).decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        payload = {}

    def clamp(v, lo, hi, fallback):
        try:
            return max(lo, min(hi, float(v)))
        except (TypeError, ValueError):
            return fallback

    key = build_cover(
        info["name"],
        clamp(payload.get("scale"), 100, 300, 100),
        # 0..100 across the image's own width, matching the dialog's sliders:
        # 50 is centred, and either end puts the relevant edge of the picture on
        # the relevant edge of the frame. The old range ran to -50..150, which
        # could only ever pull the image clear of the frame and leave bare box
        # showing — that is a crop, not a framing.
        clamp(payload.get("x"), 0, 100, 50),
        clamp(payload.get("y"), 0, 100, 50),
    )
    with db() as c:
        c.execute("UPDATE repos SET cover = ? WHERE id = ?", (key, repo["id"]))
    return parse_cover(key)


@app.post("/r/{owner}/{repo_name}/cover/reset")
def reset_repo_cover(request: Request, owner: str, repo_name: str):
    """Revert to the built-in default cover."""
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
        if repo["owner_id"] != me["id"]:
            raise HTTPException(403)
        previous = parse_cover(repo["cover"])
        c.execute("UPDATE repos SET cover = ? WHERE id = ?", (DEFAULT_COVER, repo["id"]))
    if previous["kind"] == "upload" and previous["name"]:
        (UPLOAD_DIR / previous["name"]).unlink(missing_ok=True)
    return cover_response(request, DEFAULT_COVER, owner, repo_name, "已恢复默认封面")


@app.post("/r/{owner}/{repo_name}/cover/preset")
def set_repo_cover_preset(request: Request, owner: str, repo_name: str, preset: str = Form("")):
    """Switch to one of the built-in covers.

    Replaces the upload path rather than sitting beside it: a repo has one
    cover, and picking a preset is how you get rid of an upload.
    """
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    if preset not in COVERS:
        raise HTTPException(400, "没有这个封面预设")
    with db() as c:
        repo = get_repo_or_404(c, owner, repo_name)
        if repo["owner_id"] != me["id"]:
            raise HTTPException(403)
        previous = parse_cover(repo["cover"])
        c.execute("UPDATE repos SET cover = ? WHERE id = ?", (preset, repo["id"]))
    # The uploaded file is no longer referenced, so it goes with it — otherwise
    # switching presets would quietly accumulate orphaned images on disk.
    if previous["kind"] == "upload" and previous["name"]:
        (UPLOAD_DIR / previous["name"]).unlink(missing_ok=True)
    return cover_response(
        request, preset, owner, repo_name,
        f"封面已更换为{COVERS[preset]['label']}")


@app.get("/media/cover/{stored_name}")
def serve_cover(stored_name: str):
    if not re.fullmatch(r"cover_[0-9a-f]{32}\.jpg", stored_name):
        raise HTTPException(404)
    path = UPLOAD_DIR / stored_name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/jpeg",
                        headers={"Cache-Control": "max-age=86400"})


@app.post("/settings/bio")
async def save_bio(request: Request):
    me = current_user(request)
    if not me:
        raise HTTPException(401)
    payload = {}
    try:
        payload = json.loads((await request.body()).decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        pass
    bio = str(payload.get("bio") or "").strip()[:600]
    with db() as c:
        c.execute("UPDATE users SET bio = ? WHERE id = ?", (bio, me["id"]))
    return {"bio": bio}


@app.post("/settings/banner/upload")
async def upload_banner(request: Request, banner: UploadFile = File(...)):
    return await _upload_scene_image(request, banner, "banner")


@app.post("/settings/chat-bg/upload")
async def upload_chat_bg(request: Request, chat_bg: UploadFile = File(...)):
    return await _upload_scene_image(request, chat_bg, "chat_bg")


async def _upload_scene_image(request: Request, upload: UploadFile, column: str):
    """Store an uploaded background image and point its JSON config at it.

    Used by both the profile banner and the community chat background: they are
    the same feature on two different surfaces, so they share one code path
    rather than four near-identical route bodies. `column` selects which users
    column holds the JSON (scale / x / y / opacity / blur / image).
    """
    back = "/community" if column == "chat_bg" else "/u/{u}"
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    back = back.format(u=me["username"])

    with db() as c:
        row = c.execute(f"SELECT {column} FROM users WHERE id = ?", (me["id"],)).fetchone()
    current, stored_old = _read_scene(row[column] if row else None)

    tmp = UPLOAD_DIR / f"tmp_{uuid.uuid4().hex}"
    size = 0
    oversized = False
    with tmp.open("wb") as out:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_COVER_SIZE:
                oversized = True
                break
            out.write(chunk)

    # Close the handle before deleting: Windows refuses to unlink an open file.
    if oversized:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, "背景图片不能超过 10 MB")

    name = make_banner(tmp)
    tmp.unlink(missing_ok=True)
    if not name:
        raise HTTPException(400, "无法识别该图片格式")

    current["image"] = name
    with db() as c:
        c.execute(f"UPDATE users SET {column} = ? WHERE id = ?",
                  (json.dumps(current), me["id"]))
    if stored_old and stored_old != name:
        (UPLOAD_DIR / stored_old).unlink(missing_ok=True)
    sep = "&" if "?" in back else "?"
    return RedirectResponse(f"{back}{sep}msg=背景已更新", status_code=303)


@app.post("/settings/banner/remove")
def remove_banner(request: Request):
    return _remove_scene_image(request, "banner")


@app.post("/settings/chat-bg/remove")
def remove_chat_bg(request: Request):
    return _remove_scene_image(request, "chat_bg")


def _remove_scene_image(request: Request, column: str):
    me = current_user(request)
    if not me:
        return RedirectResponse("/login", status_code=303)
    back = "/community" if column == "chat_bg" else f"/u/{me['username']}"
    with db() as c:
        row = c.execute(f"SELECT {column} FROM users WHERE id = ?", (me["id"],)).fetchone()
        current, stored = _read_scene(row[column] if row else None)
        if stored:
            (UPLOAD_DIR / stored).unlink(missing_ok=True)
        # Drop the image but keep the user's framing, so re-uploading a picture
        # lands on the position they had already tuned.
        current.pop("image", None)
        c.execute(f"UPDATE users SET {column} = ? WHERE id = ?",
                  (json.dumps(current), me["id"]))
    return RedirectResponse(back, status_code=303)


@app.get("/media/banner/{stored_name}")
def serve_banner(stored_name: str):
    if not re.fullmatch(r"banner_[0-9a-f]{32}\.jpg", stored_name):
        raise HTTPException(404)
    path = UPLOAD_DIR / stored_name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


def _read_scene(raw) -> tuple[dict, str | None]:
    """Split a stored background value into its config dict and image filename."""
    if isinstance(raw, str) and raw:
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            raw = {}
    if not isinstance(raw, dict):
        raw = {}
    stored = raw.get("image")
    return dict(raw), stored if isinstance(stored, str) and stored else None


@app.post("/settings/banner")
async def save_banner(request: Request):
    return await _save_scene(request, "banner", 70)


@app.post("/settings/chat-bg")
async def save_chat_bg(request: Request):
    # A chat background sits behind message bubbles, so its default opacity is
    # lower than a profile banner's — at 70% the conversation stops being
    # readable.
    return await _save_scene(request, "chat_bg", 30)


async def _save_scene(request: Request, column: str, default_opacity: float):
    """Store a background config as JSON: scale, position, opacity and blur."""
    me = current_user(request)
    if not me:
        raise HTTPException(401)
    payload = {}
    try:
        payload = json.loads((await request.body()).decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        pass

    def clamp(v, lo, hi, fallback):
        try:
            n = float(v)
        except (TypeError, ValueError):
            return fallback
        return max(lo, min(hi, n))

    with db() as c:
        row = c.execute(f"SELECT {column} FROM users WHERE id = ?", (me["id"],)).fetchone()
        current, _ = _read_scene(row[column] if row else None)
        current.update({
            "scale": clamp(payload.get("scale"), 50, 300, 100),
            "x": clamp(payload.get("x"), 0, 100, 50),
            "y": clamp(payload.get("y"), 0, 100, 50),
            "opacity": clamp(payload.get("opacity"), 0, 100, default_opacity),
            # Blur is in px and capped well below the layer's oversized inset,
            # so the softened edge always has room to fall off inside the frame.
            "blur": clamp(payload.get("blur"), 0, 40, 0),
        })
        c.execute(f"UPDATE users SET {column} = ? WHERE id = ?",
                  (json.dumps(current), me["id"]))
    return current


@app.get("/api/profile/{username}/bio")
def api_profile_extras(username: str):
    """Bio + banner, used by the profile page to render saved customisation."""
    with db() as c:
        row = c.execute(
            "SELECT bio, banner FROM users WHERE username = ?", (username,)
        ).fetchone()
    if not row:
        raise HTTPException(404)
    banner = {}
    if row["banner"]:
        try:
            banner = json.loads(row["banner"])
        except json.JSONDecodeError:
            banner = {}
    return {"bio": row["bio"] or "", "banner": banner}


# ---------------------------------------------------------------- README editing


@app.get("/api/r/{owner}/{repo_name}/readme")
def api_readme(request: Request, owner: str, repo_name: str):
    """The README source, for the in-page editor.

    The editor opens over the repository rather than navigating to its own page,
    so it needs the text as data. The POST route is unchanged — it already
    redirects back to the repo, which is where the dialog closes.
    """
    repo, me = require_repo_access(request, owner, repo_name)
    if not me or me["id"] != repo["owner_id"]:
        raise HTTPException(403, "只有仓库所有者可以编辑 README")
    with db() as c:
        row = c.execute(
            """SELECT id, stored_name FROM files
               WHERE repo_id = ? AND lower(path) IN ('readme.md','readme.markdown','readme.txt')
               LIMIT 1""",
            (repo["id"],),
        ).fetchone()
    content = ""
    if row:
        stored = UPLOAD_DIR / row["stored_name"]
        if stored.exists():
            content = stored.read_text("utf-8", errors="replace")[:200_000]
    return {"content": content, "exists": bool(row), "repo": repo["name"], "owner": owner}


@app.get("/r/{owner}/{repo_name}/readme/edit")
def edit_readme_page(request: Request, owner: str, repo_name: str):
    repo, me = require_repo_access(request, owner, repo_name)
    if not me or me["id"] != repo["owner_id"]:
        raise HTTPException(403, "只有仓库所有者可以编辑 README")
    with db() as c:
        row = c.execute(
            """SELECT id, stored_name, path FROM files
               WHERE repo_id = ? AND lower(path) IN ('readme.md','readme.markdown','readme.txt')
               LIMIT 1""",
            (repo["id"],),
        ).fetchone()
    content = ""
    if row:
        stored = UPLOAD_DIR / row["stored_name"]
        if stored.exists():
            content = stored.read_text("utf-8", errors="replace")[:200_000]
    return render(
        request,
        "readme_edit.html",
        page_ctx(request, repo=repo, owner=owner, content=content, exists=bool(row)),
    )


@app.post("/r/{owner}/{repo_name}/readme/edit")
async def save_readme(request: Request, owner: str, repo_name: str):
    repo, me = require_repo_access(request, owner, repo_name)
    if not me or me["id"] != repo["owner_id"]:
        raise HTTPException(403, "只有仓库所有者可以编辑 README")
    form = await request.form()
    content = (form.get("content") or "")[:200_000]

    data = content.encode("utf-8")
    with db() as c:
        row = c.execute(
            """SELECT id, stored_name FROM files
               WHERE repo_id = ? AND lower(path) IN ('readme.md','readme.markdown','readme.txt')
               LIMIT 1""",
            (repo["id"],),
        ).fetchone()
        now = int(time.time())
        if row:
            (UPLOAD_DIR / row["stored_name"]).write_bytes(data)
            c.execute(
                "UPDATE files SET size = ?, created_at = ? WHERE id = ?",
                (len(data), now, row["id"]),
            )
        else:
            stored = uuid.uuid4().hex
            (UPLOAD_DIR / stored).write_bytes(data)
            c.execute(
                """INSERT INTO files (repo_id, uploader_id, path, stored_name, size, mime, created_at)
                   VALUES (?, ?, 'README.md', ?, ?, 'text/markdown', ?)""",
                (repo["id"], me["id"], stored, len(data), now),
            )
        c.execute("UPDATE repos SET updated_at = ? WHERE id = ?", (now, repo["id"]))
    return RedirectResponse(f"/r/{owner}/{repo_name}?msg=README 已保存", status_code=303)


# ---------------------------------------------------------------- feed & api


@app.get("/feed/{username}/{repo_name}.xml")
def repo_feed(request: Request, username: str, repo_name: str):
    repo, _ = require_repo_access(request, username, repo_name)
    with db() as c:
        files = c.execute(
            """SELECT id, path, size, created_at FROM files
               WHERE repo_id = ? ORDER BY created_at DESC LIMIT 50""",
            (repo["id"],),
        ).fetchall()
    base = str(request.base_url).rstrip("/")
    items = "\n".join(
        f"""    <item>
      <title>{html.escape(f['path'])}</title>
      <link>{base}/file/{f['id']}/download</link>
      <guid>{base}/file/{f['id']}</guid>
      <pubDate>{email.utils.formatdate(f['created_at'], usegmt=True)}</pubDate>
      <description>{html.escape(f['path'])} ({fmt_size(f['size'])})</description>
    </item>"""
        for f in files
    )
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>{html.escape(username)}/{html.escape(repo['name'])} · FileHub</title>
    <link>{base}/r/{username}/{repo_name}</link>
    <description>{html.escape(repo['description'] or '')}</description>
    <lastBuildDate>{email.utils.formatdate(repo['updated_at'], usegmt=True)}</lastBuildDate>
{items}
  </channel>
</rss>"""
    return Response(xml, media_type="application/rss+xml; charset=utf-8")


@app.get("/api/repos")
def api_repos(limit: int = 20):
    limit = max(1, min(limit, 100))
    with db() as c:
        rows = c.execute(
            """SELECT r.id, r.name, r.description, r.cover, r.is_private, r.created_at, r.updated_at,
                      u.username, (SELECT COUNT(*) FROM files f WHERE f.repo_id = r.id) AS file_count,
                      (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.repo_id = r.id) AS total_size,
                      (SELECT COUNT(*) FROM stars s WHERE s.repo_id = r.id) AS stars
               FROM repos r JOIN users u ON u.id = r.owner_id
               WHERE r.is_private = 0
               ORDER BY r.updated_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    return {"count": len(rows), "repos": [dict(r) for r in rows]}


@app.get("/api/repos/{owner}/{repo_name}")
def api_repo(owner: str, repo_name: str, request: Request):
    repo, _ = require_repo_access(request, owner, repo_name)
    with db() as c:
        files = c.execute(
            """SELECT id, path, size, mime, downloads, created_at, tags, note
               FROM files WHERE repo_id = ? ORDER BY path""",
            (repo["id"],),
        ).fetchall()
    return {
        "owner": owner,
        "name": repo["name"],
        "description": repo["description"],
        "private": bool(repo["is_private"]),
        "updated_at": repo["updated_at"],
        "files": [dict(f) for f in files],
    }


@app.get("/api/profile/{username}/{tab}")
def api_follow_list(request: Request, username: str, tab: str):
    """Followers or following list for the profile modal."""
    if tab not in ("followers", "following"):
        raise HTTPException(404)
    with db() as c:
        u = c.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if not u:
            raise HTTPException(404)
        me = current_user(request)
        my_id = me["id"] if me else -1
        if tab == "followers":
            rows = c.execute(
                """SELECT u.username, u.avatar,
                          EXISTS(SELECT 1 FROM follows f2
                                 WHERE f2.follower_id = ? AND f2.followee_id = u.id) AS following
                   FROM follows f
                   JOIN users u ON u.id = f.follower_id
                   WHERE f.followee_id = ? ORDER BY f.created_at DESC LIMIT 200""",
                (my_id, u["id"]),
            ).fetchall()
        else:
            rows = c.execute(
                """SELECT u.username, u.avatar,
                          EXISTS(SELECT 1 FROM follows f2
                                 WHERE f2.follower_id = ? AND f2.followee_id = u.id) AS following
                   FROM follows f
                   JOIN users u ON u.id = f.followee_id
                   WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT 200""",
                (my_id, u["id"]),
            ).fetchall()
    return {
        "tab": tab,
        "count": len(rows),
        "users": [
            {"username": r["username"], "avatar": avatar_url(r["avatar"]),
             "following": bool(r["following"])}
            for r in rows
        ],
    }


@app.get("/api/suggest")
def api_suggest(q: str = ""):
    """Typeahead suggestions for the header search box."""
    q = q.strip()
    if not q:
        return {"results": []}
    like = f"%{q}%"
    results: list[dict] = []
    with db() as c:
        for r in c.execute(
            """SELECT r.name, r.description, u.username FROM repos r
               JOIN users u ON u.id = r.owner_id
               WHERE r.is_private = 0 AND (r.name LIKE ? OR r.description LIKE ?)
               ORDER BY r.updated_at DESC LIMIT 6""",
            (like, like),
        ):
            results.append({
                "icon": "📚",
                "label": f"{r['username']} / {r['name']}",
                "type": "仓库",
                "href": f"/r/{r['username']}/{r['name']}",
            })
        for f in c.execute(
            """SELECT f.path, r.name AS repo_name, u.username FROM files f
               JOIN repos r ON r.id = f.repo_id JOIN users u ON u.id = r.owner_id
               WHERE r.is_private = 0 AND (f.path LIKE ? OR f.tags LIKE ?)
               ORDER BY f.created_at DESC LIMIT 5""",
            (like, like),
        ):
            results.append({
                "icon": "📄",
                "label": f["path"],
                "type": f"{f['username']}/{f['repo_name']}",
                "href": f"/r/{f['username']}/{f['repo_name']}",
            })
        for u in c.execute(
            "SELECT username FROM users WHERE username LIKE ? LIMIT 4", (like,)
        ):
            results.append({
                "icon": "👤",
                "label": u["username"],
                "type": "用户",
                "href": f"/u/{u['username']}",
            })
    return {"results": results[:12]}


@app.get("/api/stats/{username}")
def api_user_stats(username: str, request: Request):
    """Daily upload counts for the activity heatmap."""
    me = current_user(request)
    with db() as c:
        u = c.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if not u:
            raise HTTPException(404)
        rows = c.execute(
            """SELECT f.created_at, COUNT(*) n, COALESCE(SUM(f.size),0) bytes
               FROM files f JOIN repos r ON r.id = f.repo_id
               WHERE r.owner_id = ? GROUP BY date(f.created_at, 'unixepoch')""",
            (u["id"],),
        ).fetchall()
    days: dict[str, dict] = {}
    for r in rows:
        day = time.strftime("%Y-%m-%d", time.gmtime(r["created_at"]))
        entry = days.setdefault(day, {"count": 0, "bytes": 0})
        entry["count"] += r["n"]
        entry["bytes"] += r["bytes"]
    return {"username": username, "days": days}


# ---------------------------------------------------------------- admin
#
# The owner's console at /admin. "Owner" here is the same definition the 站长
# badge already uses — the first row in `users` (site_owner_name) — so the
# console adds no roles table for a single account.
#
# This is the one place in the app that treats that badge as a permission
# instead of a label, which is why the check lives in a single function that
# every route below goes through. A missing check here would be a silent hole
# rather than a visible bug, so each route re-derives the owner rather than
# trusting a flag passed down from the page.
#
# A visitor who is not the owner is sent to the home page. Answering 403 would
# tell them the console exists; the home page tells them nothing.


def _require_owner(request: Request):
    """The signed-in owner, or None when the caller has no business here."""
    me = current_user(request)
    if not me or me["username"] != site_owner_name():
        return None
    return me


def _admin_redirect(msg: str) -> RedirectResponse:
    """Back to the console with a flash message, via the ?msg= chain."""
    return RedirectResponse(f"/admin?msg={quote(msg)}", status_code=303)


def _delete_repo_tree(c: sqlite3.Connection, repo_id: int) -> int:
    """Delete a repo and every row and file that hangs off it.

    Returns the number of files removed. Factored out because the repo-delete
    route, bulk-delete and this console all need the same sweep — three inlined
    copies is already two too many, and each copy is its own chance to forget a
    table.

    Note `comments` is swept by repo_id, which is safe with the reserved public
    room: chat messages live under repo_id 0 and no repo ever has that id.
    """
    removed = 0
    for f in c.execute(
        "SELECT stored_name, thumb FROM files WHERE repo_id = ?", (repo_id,)
    ):
        (UPLOAD_DIR / f["stored_name"]).unlink(missing_ok=True)
        if f["thumb"]:
            (UPLOAD_DIR / f["thumb"]).unlink(missing_ok=True)
        removed += 1
    # The repo's own cover is an upload too, and nothing else references it —
    # dropping the row without this leaves the picture on disk forever. (The
    # repo-delete route predates this helper and still leaks its cover; the
    # console's orphan cleaner reclaims those.)
    repo = c.execute("SELECT cover FROM repos WHERE id = ?", (repo_id,)).fetchone()
    if repo and (repo["cover"] or "").startswith("upload:"):
        (UPLOAD_DIR / repo["cover"].split(":")[1]).unlink(missing_ok=True)
    c.execute("DELETE FROM files WHERE repo_id = ?", (repo_id,))
    c.execute("DELETE FROM comments WHERE repo_id = ?", (repo_id,))
    c.execute("DELETE FROM stars WHERE repo_id = ?", (repo_id,))
    c.execute("DELETE FROM folder_names WHERE repo_id = ?", (repo_id,))
    c.execute("DELETE FROM repos WHERE id = ?", (repo_id,))
    return removed


def _delete_user_tree(c: sqlite3.Connection, user_id: int) -> dict:
    """Delete a user and every row and file that refers to them.

    The order is forced by the foreign keys: `repos.owner_id`, `files.uploader_id`,
    `comments.user_id`, `stars.user_id`, `follows.follower_id/followee_id` and
    `sessions.user_id` all point at `users`, and the connection runs with
    `PRAGMA foreign_keys = ON`, so the user row cannot go until nothing refers to
    it any more.
    """
    # Files this user uploaded into *other* people's repos. The repo sweep below
    # never reaches them, and leaving them would both orphan the payload on disk
    # and block the user delete.
    elsewhere = c.execute(
        "SELECT stored_name, thumb FROM files WHERE uploader_id = ?", (user_id,)
    ).fetchall()
    for f in elsewhere:
        (UPLOAD_DIR / f["stored_name"]).unlink(missing_ok=True)
        if f["thumb"]:
            (UPLOAD_DIR / f["thumb"]).unlink(missing_ok=True)

    repos_removed = 0
    files_removed = 0
    for r in c.execute("SELECT id FROM repos WHERE owner_id = ?", (user_id,)):
        files_removed += _delete_repo_tree(c, r["id"])
        repos_removed += 1

    # Whatever is still tagged with this uploader sits in someone else's repo.
    c.execute("DELETE FROM files WHERE uploader_id = ?", (user_id,))
    files_removed += len(elsewhere)

    # Other people's comments may quote this user's; clear the pointer before the
    # target disappears, so no comment is left referring to an id that is gone.
    c.execute(
        """UPDATE comments SET quote_id = NULL
            WHERE quote_id IN (SELECT id FROM comments WHERE user_id = ?)""",
        (user_id,),
    )
    # Includes their public-room messages, which is intended: deleting an account
    # takes its chat history with it.
    c.execute("DELETE FROM comments WHERE user_id = ?", (user_id,))
    c.execute("DELETE FROM stars WHERE user_id = ?", (user_id,))
    c.execute("DELETE FROM follows WHERE follower_id = ? OR followee_id = ?",
              (user_id, user_id))
    c.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    row = c.execute(
        "SELECT avatar, banner, chat_bg FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if row:
        # An uploaded avatar is a file in uploads; "preset:N" names a static SVG
        # that the user does not own.
        avatar = row["avatar"]
        if avatar and not avatar.startswith("preset:"):
            (UPLOAD_DIR / avatar).unlink(missing_ok=True)
        for raw in (row["banner"], row["chat_bg"]):
            _, image = _read_scene(raw)
            if image:
                (UPLOAD_DIR / image).unlink(missing_ok=True)

    c.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return {"repos": repos_removed, "files": files_removed}


def _referenced_uploads() -> set[str]:
    """Every filename in uploads/ that some row in the database still points at.

    Collected from all five places a filename is stored, not just `files`: a
    profile avatar, a repo cover and a banner/chat background are uploads too,
    and missing any of them would make the orphan cleaner delete a picture that
    is still in use.
    """
    names: set[str] = set()
    with db() as c:
        for r in c.execute("SELECT stored_name, thumb FROM files"):
            names.add(r["stored_name"])
            if r["thumb"]:
                names.add(r["thumb"])
        for r in c.execute("SELECT avatar FROM users"):
            if r["avatar"] and not r["avatar"].startswith("preset:"):
                names.add(r["avatar"])
        for r in c.execute("SELECT cover FROM repos"):
            key = r["cover"] or ""
            if key.startswith("upload:"):
                names.add(key.split(":")[1])
        for r in c.execute("SELECT banner, chat_bg FROM users"):
            for raw in (r["banner"], r["chat_bg"]):
                _, image = _read_scene(raw)
                if image:
                    names.add(image)
    return names


def _upload_health(sample: int = 20) -> dict:
    """Reconcile uploads/ against what the database references.

    Two failures worth surfacing, in opposite directions:

    * orphans — files on disk nothing points at. The known producer is
      `delete_file`, which removes the payload but not the thumbnail, so those
      accumulate silently; a crashed upload's `tmp_*` file is the other.
    * missing — rows whose payload is gone. The row still renders in a file
      list and 404s on download, which is the state a real repo cover was found
      in on this site.

    The orphan and missing lists are capped for display; only the counts are
    complete.
    """
    referenced = _referenced_uploads()

    disk_count = 0
    disk_bytes = 0
    orphans: list[tuple[str, int]] = []
    for path in UPLOAD_DIR.iterdir():
        if not path.is_file():
            continue
        try:
            size = path.stat().st_size
        except OSError:
            continue
        disk_count += 1
        disk_bytes += size
        if path.name not in referenced:
            orphans.append((path.name, size))

    missing = sorted(n for n in referenced if not (UPLOAD_DIR / n).exists())
    orphans.sort(key=lambda item: -item[1])
    # The console draws a composition ring over these three, so it needs them to
    # be a partition rather than four overlapping counts: a file is either on
    # disk and referenced, referenced but gone, or on disk and referenced by
    # nothing. `healthy` is the first of those — what `disk_count - orphan_count`
    # works out to, which is the same as `referenced_count - missing_count`.
    return {
        "disk_count": disk_count,
        "disk_bytes": disk_bytes,
        "referenced_count": len(referenced),
        "healthy_count": disk_count - len(orphans),
        "orphan_count": len(orphans),
        "orphan_bytes": sum(size for _, size in orphans),
        "orphans": orphans if sample <= 0 else orphans[:sample],
        "missing_count": len(missing),
        "missing": missing if sample <= 0 else missing[:sample],
    }


def _clean_orphans() -> tuple[int, int]:
    """Delete every file in uploads/ the database does not reference."""
    referenced = _referenced_uploads()
    removed = 0
    freed = 0
    for path in UPLOAD_DIR.iterdir():
        if not path.is_file() or path.name in referenced:
            continue
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        path.unlink(missing_ok=True)
        removed += 1
        freed += size
    return removed, freed


# Rows per table on the console. At 50 the three tables stay a scrollable
# length while a page is still a single cheap query; what they must not do is
# grow without bound, which is what they did at first — 200 repos made a
# 9000-pixel page and every load rendered all of them.
ADMIN_PER_PAGE = 50


def _like(q: str) -> str:
    """A LIKE pattern for `q`, with the wildcards in the input neutralised.

    Escaped with "!" rather than the usual backslash so the SQL can say
    ESCAPE '!' — a backslash inside a Python string literal that also has to
    survive into SQL is exactly the quoting tangle this avoids. Without the
    escaping a search for "_" would match every row, and the seeded usernames
    are made of underscores.
    """
    return "%" + q.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"


def _pager(total: int, page: int, params: dict, prefix: str) -> dict:
    """Paging state for one console table.

    Links carry the whole current state with only this table's page number
    replaced, so paging the repo list does not silently drop the filter you had
    typed into the user list. The page strip is a window rather than every page:
    a table with hundreds of pages would otherwise render hundreds of links.
    """
    pages = max(1, (total + ADMIN_PER_PAGE - 1) // ADMIN_PER_PAGE)
    page = min(max(1, page), pages)

    def url(target: int) -> str:
        query = {k: v for k, v in params.items() if v not in ("", None)}
        # Drop this table's own page first: params carries the current page, and
        # leaving it in would make the "previous" link point at the page you are
        # already on. Page 1 is the default, so it is simply left out.
        query.pop(f"{prefix}_page", None)
        if target > 1:
            query[f"{prefix}_page"] = target
        return "/admin?" + urlencode(query)

    first = max(1, min(page - 2, pages - 4))
    last = min(pages, first + 4)
    return {
        "page": page,
        "pages": pages,
        "total": total,
        "prev": url(page - 1) if page > 1 else None,
        "next": url(page + 1) if page < pages else None,
        "links": [(n, url(n), n == page) for n in range(first, last + 1)],
        "offset": (page - 1) * ADMIN_PER_PAGE,
    }


@app.get("/admin")
def admin_page(request: Request, msg: str = "",
               user_q: str = "", user_page: int = 1,
               repo_q: str = "", repo_page: int = 1,
               comment_q: str = "", comment_page: int = 1):
    me = _require_owner(request)
    if not me:
        return RedirectResponse("/", status_code=303)

    # Whitespace is not a search. Without this, a stray space in the box matched
    # nothing and the table reported "no results" for a query the user cannot
    # even see.
    user_q, repo_q, comment_q = user_q.strip(), repo_q.strip(), comment_q.strip()

    # Every link built from here must be able to restate the other tables'
    # state, so the current values travel as one dict — the filters and the page
    # numbers, or paging one table would drop where you were in another. Page 1
    # is left out because it is the default; the filters are not, since "1" is a
    # legitimate search (it looks up that id).
    params = {"user_q": user_q, "repo_q": repo_q, "comment_q": comment_q}
    for name, value in (("user_page", user_page), ("repo_page", repo_page),
                        ("comment_page", comment_page)):
        if value > 1:
            params[name] = value

    with db() as c:
        def one(sql: str, args: tuple = ()) -> int:
            """A single scalar COUNT/SUM, named so the table below reads as data."""
            return c.execute(sql, args).fetchone()["n"]

        totals = {
            "users": one("SELECT COUNT(*) n FROM users"),
            "repos": one("SELECT COUNT(*) n FROM repos"),
            "repos_private": one("SELECT COUNT(*) n FROM repos WHERE is_private = 1"),
            "files": one("SELECT COUNT(*) n FROM files"),
            "follows": one("SELECT COUNT(*) n FROM follows"),
            "stars": one("SELECT COUNT(*) n FROM stars"),
            "comments": one("SELECT COUNT(*) n FROM comments"),
            "chat": one("SELECT COUNT(*) n FROM comments WHERE repo_id = 0"),
            "downloads": one("SELECT COALESCE(SUM(downloads),0) n FROM files"),
        }

        # A search of digits looks up an id, because that is the one column of
        # the user table that cannot be found by name.
        user_where, user_args = "", ()
        if user_q:
            if user_q.isdigit():
                user_where, user_args = "WHERE u.id = ?", (int(user_q),)
            else:
                user_where = "WHERE u.username LIKE ? ESCAPE '!'"
                user_args = (_like(user_q),)

        repo_where, repo_args = "", ()
        if repo_q:
            repo_where = ("WHERE r.name LIKE ? ESCAPE '!'"
                          " OR u.username LIKE ? ESCAPE '!'")
            repo_args = (_like(repo_q), _like(repo_q))

        comment_where, comment_args = "", ()
        if comment_q:
            comment_where = ("WHERE cm.body LIKE ? ESCAPE '!'"
                             " OR u.username LIKE ? ESCAPE '!'")
            comment_args = (_like(comment_q), _like(comment_q))

        user_total = one(f"SELECT COUNT(*) n FROM users u {user_where}", user_args)
        repo_total = one(
            f"SELECT COUNT(*) n FROM repos r JOIN users u ON u.id = r.owner_id {repo_where}",
            repo_args,
        )
        comment_total = one(
            f"""SELECT COUNT(*) n FROM comments cm
                 JOIN users u ON u.id = cm.user_id {comment_where}""",
            comment_args,
        )

        user_pager = _pager(user_total, user_page, params, "user")
        repo_pager = _pager(repo_total, repo_page, params, "repo")
        comment_pager = _pager(comment_total, comment_page, params, "comment")

        users = c.execute(
            f"""SELECT u.id, u.username, u.avatar, u.created_at,
                       (SELECT COUNT(*) FROM repos r WHERE r.owner_id = u.id) repo_count,
                       (SELECT COUNT(*) FROM files f JOIN repos r ON r.id = f.repo_id
                         WHERE r.owner_id = u.id) file_count
                  FROM users u {user_where}
                 ORDER BY u.id LIMIT ? OFFSET ?""",
            user_args + (ADMIN_PER_PAGE, user_pager["offset"]),
        ).fetchall()
        repos = c.execute(
            f"""SELECT r.id, r.name, r.is_private, r.created_at, u.username,
                       (SELECT COUNT(*) FROM files f WHERE f.repo_id = r.id) file_count,
                       (SELECT COALESCE(SUM(f.size),0) FROM files f
                         WHERE f.repo_id = r.id) total_size,
                       (SELECT COUNT(*) FROM stars s WHERE s.repo_id = r.id) star_count
                  FROM repos r JOIN users u ON u.id = r.owner_id {repo_where}
                 ORDER BY r.id LIMIT ? OFFSET ?""",
            repo_args + (ADMIN_PER_PAGE, repo_pager["offset"]),
        ).fetchall()
        comments = c.execute(
            f"""SELECT cm.id, cm.repo_id, cm.body, cm.created_at, u.username,
                       r.name AS repo_name, ru.username AS repo_owner
                  FROM comments cm
                  JOIN users u ON u.id = cm.user_id
                  LEFT JOIN repos r ON r.id = cm.repo_id
                  LEFT JOIN users ru ON ru.id = r.owner_id
                 {comment_where}
                 ORDER BY cm.id DESC LIMIT ? OFFSET ?""",
            comment_args + (ADMIN_PER_PAGE, comment_pager["offset"]),
        ).fetchall()

    health = _upload_health()

    # The quota is shown against the same figure an upload is measured by —
    # the directory's actual size — so the console cannot report headroom that
    # an upload would then refuse.
    with db() as c:
        quota = disk_quota(c)
    quota_value, quota_unit = quota_form_value(quota)
    used_pct = round(100 * health["disk_bytes"] / quota, 2) if quota else 0.0

    # What the console visualises, as data rather than markup: the numbers ship
    # once as JSON and the canvases look themselves up by key, so a chart can
    # never disagree with the count beside it.
    #
    # Only the counts go into the bar series. 占用空间 is a size, and stacking
    # bytes beside a download count would put a number with a different unit and
    # a different meaning on the same axis; it keeps its plain figure. The counts
    # themselves span four orders of magnitude (5 chat messages against 52269
    # downloads), which the client handles by stacking on a log scale.
    charts = {
        "bars": {
            "users": totals["users"],
            "repos": totals["repos"],
            "files": totals["files"],
            "follows": totals["follows"],
            "stars": totals["stars"],
            "comments": totals["comments"],
            "chat": totals["chat"],
            "downloads": totals["downloads"],
            "private_repos": totals["repos_private"],
        },
        # A partition, not four overlapping figures: every known file is either
        # on disk and referenced, referenced but gone, or on disk and referenced
        # by nothing. See _upload_health.
        "ring": [
            {"key": "ok", "label": "正常在盘", "value": health["healthy_count"]},
            {"key": "missing", "label": "缺失", "value": health["missing_count"]},
            {"key": "orphan", "label": "孤立", "value": health["orphan_count"]},
        ],
    }

    return render(
        request,
        "admin.html",
        page_ctx(request, nav="admin", msg=msg, totals=totals, health=health,
                 charts=charts,
                 quota=quota, quota_value=quota_value, quota_unit=quota_unit,
                 used_pct=used_pct, used_bytes=health["disk_bytes"],
                 units=list(QUOTA_UNITS),
                 user_list={"rows": users, "pager": user_pager, "q": user_q},
                 repo_list={"rows": repos, "pager": repo_pager, "q": repo_q},
                 comment_list={"rows": comments, "pager": comment_pager, "q": comment_q}),
    )


@app.post("/admin/quota")
def admin_set_quota(request: Request, value: str = Form(""), unit: str = Form("TB")):
    me = _require_owner(request)
    if not me:
        return RedirectResponse("/", status_code=303)
    if unit not in QUOTA_UNITS:
        return _admin_redirect("单位只能是 MB / GB / TB")
    try:
        amount = float(value)
    except ValueError:
        return _admin_redirect("上限必须是一个数字")
    if not amount > 0:
        return _admin_redirect("上限必须大于 0")
    quota = int(amount * QUOTA_UNITS[unit])
    # A ceiling below what is already stored would refuse every future upload
    # over one typo, so it is allowed but called out rather than silently set.
    with db() as c:
        set_setting(c, "disk_quota", str(quota))
    used = uploads_bytes()
    if used > quota:
        return _admin_redirect(
            f"上限已设为 {fmt_size(quota)}，但当前已占用 {fmt_size(used)}，上传会被拒绝"
        )
    return _admin_redirect(f"磁盘上限已设为 {fmt_size(quota)}")


@app.post("/admin/user/{username}/delete")
def admin_delete_user(request: Request, username: str):
    me = _require_owner(request)
    if not me:
        return RedirectResponse("/", status_code=303)
    # The console exists to moderate everyone else; removing the account that
    # defines the console would leave nobody able to open it again.
    if username == site_owner_name():
        return _admin_redirect("站长账号不能删除")
    with db() as c:
        row = c.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            return _admin_redirect(f"用户 {username} 不存在")
        stats = _delete_user_tree(c, row["id"])
    return _admin_redirect(
        f"已删除用户 {username}（仓库 {stats['repos']}、文件 {stats['files']}）"
    )


@app.post("/admin/repo/{repo_id}/delete")
def admin_delete_repo(request: Request, repo_id: int):
    me = _require_owner(request)
    if not me:
        return RedirectResponse("/", status_code=303)
    with db() as c:
        row = c.execute(
            """SELECT r.name, u.username FROM repos r JOIN users u ON u.id = r.owner_id
                WHERE r.id = ?""",
            (repo_id,),
        ).fetchone()
        if not row:
            return _admin_redirect("仓库不存在")
        files = _delete_repo_tree(c, repo_id)
    return _admin_redirect(
        f"已删除仓库 {row['username']}/{row['name']}（{files} 个文件）"
    )


@app.post("/admin/comment/{comment_id}/delete")
def admin_delete_comment(request: Request, comment_id: int):
    me = _require_owner(request)
    if not me:
        return RedirectResponse("/", status_code=303)
    with db() as c:
        row = c.execute("SELECT id FROM comments WHERE id = ?", (comment_id,)).fetchone()
        if not row:
            return _admin_redirect("评论不存在")
        c.execute("UPDATE comments SET quote_id = NULL WHERE quote_id = ?", (comment_id,))
        c.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
    return _admin_redirect("评论已删除")


@app.post("/admin/orphans/clean")
def admin_clean_orphans(request: Request):
    me = _require_owner(request)
    if not me:
        return RedirectResponse("/", status_code=303)
    removed, freed = _clean_orphans()
    if not removed:
        return _admin_redirect("没有孤立文件需要清理")
    return _admin_redirect(
        f"已清理 {removed} 个孤立文件，释放 {freed / 1024 / 1024:.1f} MB"
    )


if __name__ == "__main__":
    import asyncio
    import logging

    import uvicorn

    # On Windows the Proactor event loop logs a full traceback whenever a
    # client disconnects mid-response (WinError 10054). Browsers do this
    # routinely — it is not an application error, so it is kept out of the log.
    if sys.platform == "win32":

        class _QuietDisconnects(logging.Filter):
            def filter(self, record: logging.LogRecord) -> bool:
                exc = record.exc_info[1] if record.exc_info else None
                return not isinstance(exc, ConnectionResetError)

        logging.getLogger("asyncio").addFilter(_QuietDisconnects())
        with contextlib.suppress(Exception):
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    # The port comes from the environment when there is one. A container host
    # injects PORT and routes to it, so a hardcoded 8000 would leave the
    # deployment listening where nothing is forwarded.
    port = int(os.environ.get("PORT") or 8000)
    uvicorn.run(app, host="0.0.0.0", port=port)
