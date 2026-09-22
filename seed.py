"""Seed FileHub with demo data: users, repos, files, follows, stars and comments.

Run with the server stopped or running — it writes straight to SQLite and uses
the same PBKDF2 parameters as the app, so the accounts can log in normally.

    python seed.py            # 100 users
    python seed.py 20         # 20 users

Every file this writes is a real file of its declared type: a .png is a PNG the
browser can draw, a .pdf opens, a .zip extracts, a .wav plays. That matters
because the repo page draws a row's picture from the file itself and falls back
to a type icon when it cannot — a row that merely claims to be an image shows up
as a generic icon and makes the whole page look fake. Images also get a
thumbnail written the way the server writes it (same size, same JPEG quality,
same `<stored>_thumb.jpg` name), so nothing downstream can tell a seeded row
from an uploaded one.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import random
import re
import secrets
import sqlite3
import struct
import sys
import time
import uuid
import wave
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

APP_DIR = Path(__file__).resolve().parent
# Same rule as the server: FILEHUB_DATA points at the writable state, so seeding
# a container's volume is a matter of setting the same variable here. Without
# it the script writes a database next to its own source and the running app
# never sees it.
DATA_DIR = Path(os.environ.get("FILEHUB_DATA") or APP_DIR)
DB_PATH = DATA_DIR / "filehub.db"
UPLOAD_DIR = DATA_DIR / "uploads"

# Mirrors of the server's constants. Duplicated rather than imported because
# importing server.main would start the app — open the database, sweep stray
# temp files — just to read four numbers.
THUMB_SIZE = (400, 400)
THUMB_QUALITY = 82
AVATAR_SIZE = (200, 200)
COVER_SIZE = 720
PRESET_AVATARS = 6

# The media routes guard their filenames with these, and the guard is a
# fullmatch — a name of the wrong length writes a file that is on disk, is
# referenced by the database, and still 404s. Asserted at write time so a
# change of generator cannot quietly break every avatar and cover.
AVATAR_NAME_RE = re.compile(r"avatar_[0-9a-f]{32}\.jpg")
COVER_NAME_RE = re.compile(r"cover_[0-9a-f]{32}\.jpg")
THUMB_NAME_RE = re.compile(r"[0-9a-f]{32}_thumb\.jpg")

# Deterministic output keeps re-runs comparable.
random.seed(20260919)

ADJECTIVES = [
    "swift", "quiet", "bright", "lunar", "amber", "vivid", "north", "solar",
    "azure", "crimson", "gentle", "rapid", "silent", "cosmic", "urban",
    "frost", "ember", "nova", "pixel", "vector", "atlas", "orbit", "echo",
]
NOUNS = [
    "fox", "otter", "falcon", "panda", "dolphin", "raven", "tiger", "koi",
    "wolf", "crane", "lynx", "heron", "moth", "gecko", "bison", "orca",
    "sparrow", "beetle", "marlin", "ibis", "puma", "yak",
]

REPO_TOPICS = [
    ("wallpapers", "高清壁纸合集，按风格分类"),
    ("design-assets", "设计素材：图标、插画、配色"),
    ("ebooks", "电子书收藏，持续更新"),
    ("music-library", "无损音乐与歌单存档"),
    ("datasets", "公开数据集整理"),
    ("fonts", "免费商用字体合集"),
    ("3d-models", "3D 模型与贴图资源"),
    ("templates", "文档与演示模板"),
    ("photography", "个人摄影作品归档"),
    ("notes", "学习笔记与知识整理"),
    ("game-mods", "游戏模组与补丁"),
    ("ui-kits", "UI 组件库设计稿"),
]

# (filename, mime) pairs. The extension and the mime always agree, and the
# bytes are built to match: see make_payload.
FILE_CATALOG = [
    ("cover.png", "image/png"),
    ("banner.jpg", "image/jpeg"),
    ("mockup.png", "image/png"),
    ("preview.jpg", "image/jpeg"),
    ("palette.png", "image/png"),
    ("screenshot.jpg", "image/jpeg"),
    ("guide.pdf", "application/pdf"),
    ("spec.pdf", "application/pdf"),
    ("notes.md", "text/markdown"),
    ("changelog.md", "text/markdown"),
    ("readme.txt", "text/plain"),
    ("data.csv", "text/csv"),
    ("config.json", "application/json"),
    ("assets.zip", "application/zip"),
    ("fonts.zip", "application/zip"),
    ("track.wav", "audio/wav"),
    ("ambient.wav", "audio/wav"),
]

FOLDERS = ["", "", "raw/", "final/", "docs/", "src/"]

COMMENTS = [
    "整理得很用心，感谢分享！",
    "收藏了，正好需要这个。",
    "请问后续还会更新吗？",
    "分类清晰，找东西很方便。",
    "已经下载，质量不错 👍",
    "这个系列的配色我很喜欢。",
    "有没有考虑再补一份索引？",
    "文件都能正常打开，辛苦啦。",
    "拿来做了参考，很实用。",
    "期待更新，先点个星。",
]


def hash_pw(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt_hex), 120_000
    ).hex()


# ------------------------------------------------------------- file payloads
#
# Each generator takes a seed string and returns bytes that are valid for the
# type they are labelled as. They are seeded per file so a given row always
# looks the same across re-runs, while two rows never look identical.


def _picture(seed: str, size: tuple[int, int]) -> Image.Image:
    """A deterministic abstract picture: gradient, then outlined shapes."""
    rng = random.Random(seed)
    w, h = size
    im = Image.new("RGB", size)
    draw = ImageDraw.Draw(im)

    top = (rng.randint(16, 110), rng.randint(16, 110), rng.randint(70, 190))
    bottom = (rng.randint(90, 225), rng.randint(70, 190), rng.randint(120, 245))
    for y in range(h):
        t = y / max(1, h - 1)
        draw.line(
            [(0, y), (w, y)],
            fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )

    for _ in range(rng.randint(3, 9)):
        cx, cy = rng.randint(0, w), rng.randint(0, h)
        r = rng.randint(w // 14, w // 5)
        draw.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            outline=(rng.randint(60, 255), rng.randint(60, 255), rng.randint(60, 255)),
            width=rng.randint(2, 7),
        )
    for _ in range(rng.randint(1, 4)):
        y = rng.randint(0, h)
        draw.line(
            [(0, y), (w, y)],
            fill=(rng.randint(120, 255), rng.randint(120, 255), rng.randint(120, 255)),
            width=rng.randint(1, 3),
        )
    return im


def png_bytes(seed: str) -> bytes:
    rng = random.Random(seed + "size")
    buf = io.BytesIO()
    # Kept small on purpose: a demo uploads directory of a few hundred files
    # should stay in the tens of megabytes.
    _picture(seed, (rng.randrange(320, 641, 32), rng.randrange(200, 401, 32))).save(
        buf, "PNG", optimize=True
    )
    return buf.getvalue()


def jpeg_bytes(seed: str) -> bytes:
    rng = random.Random(seed + "size")
    buf = io.BytesIO()
    _picture(seed, (rng.randrange(480, 801, 32), rng.randrange(300, 501, 32))).save(
        buf, "JPEG", quality=85
    )
    return buf.getvalue()


def pdf_bytes(seed: str, title: str) -> bytes:
    """A minimal single-page PDF, hand-built so seeding needs no PDF library."""
    rng = random.Random(seed)

    def esc(s: str) -> str:
        return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

    # Helvetica has no CJK glyphs, so the page body stays ASCII. Chinese titles
    # would need a font embedded, which is more machinery than a seed script
    # should carry.
    body = [
        title,
        "",
        f"Seeded demo document {rng.randrange(1000, 9999)}",
        f"Pages: 1    Size: {rng.randrange(2, 40)} KB",
        "",
        "This file was generated by seed.py to give the repository a",
        "downloadable document of a realistic type and size.",
    ]
    lines = ["BT", "/F1 18 Tf", "72 770 Td", "24 TL"]
    for i, line in enumerate(body):
        if i:
            lines.append("T*")
        lines.append(f"({esc(line)}) Tj")
    lines.append("ET")
    # No trailing newline in the stream itself: the EOL that separates the data
    # from `endstream` is written below and, per the spec, is not counted in
    # /Length. Folding it into the stream made the declared length one byte too
    # large.
    stream = "\n".join(lines).encode("latin-1", "replace")

    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]"
        b"/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
        b"<</Length %d>>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1) + b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1, xref,
    )
    return bytes(out)


def zip_bytes(seed: str, label: str) -> bytes:
    rng = random.Random(seed)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "README.txt",
            f"{label}\npacked by seed.py on {time.strftime('%Y-%m-%d')}\n",
        )
        for i in range(rng.randint(2, 5)):
            z.writestr(f"files/{i:02d}.txt", "seed payload\n" * rng.randint(20, 200))
    return buf.getvalue()


def wav_bytes(seed: str) -> bytes:
    """A real, playable mono WAV — a short tone with a decaying envelope."""
    rng = random.Random(seed)
    rate = 8000
    seconds = round(rng.uniform(0.6, 1.8), 2)
    freq = rng.choice([220.0, 277.2, 329.6, 392.0, 440.0, 523.3])
    total = int(rate * seconds)

    frames = bytearray()
    for i in range(total):
        t = i / rate
        envelope = max(0.0, 1.0 - t / seconds)
        frames += struct.pack(
            "<h", int(11000 * envelope * math.sin(2 * math.pi * freq * t))
        )

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def text_bytes(seed: str, fname: str, label: str, repo_name: str, owner: str) -> bytes:
    rng = random.Random(seed + fname)
    ext = fname.rsplit(".", 1)[-1].lower()

    if ext == "md":
        return (
            f"# {label}\n\n"
            f"来自仓库 `{owner}/{repo_name}`，共 {rng.randint(3, 40)} 条记录。\n\n"
            "## 说明\n\n"
            "- 文件按主题整理，命名统一\n"
            "- 每份都标注了来源与许可\n"
            "- 缺漏的部分会陆续补齐\n\n"
            "## 目录\n\n"
            + "".join(f"{i}. 第 {i} 组素材\n" for i in range(1, rng.randint(4, 9)))
        ).encode("utf-8")
    if ext == "json":
        return (
            json.dumps(
                {
                    "repo": f"{owner}/{repo_name}",
                    "file": fname,
                    "entries": rng.randint(2, 60),
                    "tags": ["demo", "seed", repo_name],
                    "generated": int(time.time()),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        ).encode("utf-8")
    if ext == "csv":
        rows = ["name,kind,size_kb"]
        for i in range(rng.randint(4, 20)):
            rows.append(
                f"entry_{i:03d},{rng.choice(['image', 'audio', 'doc'])},{rng.randint(1, 900)}"
            )
        return ("\n".join(rows) + "\n").encode("utf-8")

    return (
        f"{label}\n"
        f"{'=' * len(label)}\n\n"
        f"仓库：{owner}/{repo_name}\n"
        f"条目：{rng.randint(3, 50)}\n\n"
        "本文件由 seed.py 生成，用于填充演示数据。\n"
    ).encode("utf-8")


def make_payload(seed: str, fname: str, label: str, repo_name: str, owner: str) -> bytes:
    """Real bytes for a file, chosen by its extension."""
    ext = fname.rsplit(".", 1)[-1].lower()
    if ext == "png":
        return png_bytes(seed)
    if ext in ("jpg", "jpeg"):
        return jpeg_bytes(seed)
    if ext == "pdf":
        return pdf_bytes(seed, f"{label} — {owner}/{repo_name}")
    if ext == "zip":
        return zip_bytes(seed, f"{owner}/{repo_name}/{fname}")
    if ext == "wav":
        return wav_bytes(seed)
    return text_bytes(seed, fname, label, repo_name, owner)


def write_thumb(stored: str, data: bytes) -> str | None:
    """Mirror the server's make_thumbnail: same box, quality and naming."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            im = im.convert("RGB")
            im.thumbnail(THUMB_SIZE, Image.LANCZOS)
            name = f"{stored}_thumb.jpg"
            assert THUMB_NAME_RE.fullmatch(name), name
            im.save(UPLOAD_DIR / name, "JPEG", quality=THUMB_QUALITY)
        return name
    except Exception:
        # Not an image, or an image PIL cannot read: no thumbnail is not an
        # error, the row falls back to its type icon.
        return None


def write_avatar(seed: str) -> str:
    """An uploaded-looking avatar file.

    The name must be exactly `avatar_<32 hex>.jpg`: /media/avatar/ guards the
    filename with that regex and 404s anything else, so a longer hex string
    writes a file that exists on disk and still cannot be served.
    """
    name = f"avatar_{uuid.uuid4().hex}.jpg"
    assert AVATAR_NAME_RE.fullmatch(name), name
    _picture(seed, AVATAR_SIZE).save(UPLOAD_DIR / name, "JPEG", quality=88)
    return name


def write_cover(seed: str, nx: float, ny: float) -> str:
    """A repo cover, stored in the same framed-key form the app writes.

    Same 32-hex filename rule as the avatar: /media/cover/ enforces it.
    """
    name = f"cover_{uuid.uuid4().hex}.jpg"
    assert COVER_NAME_RE.fullmatch(name), name
    _picture(seed, (COVER_SIZE, COVER_SIZE)).save(UPLOAD_DIR / name, "JPEG", quality=84)
    return f"upload:{name}:100:{int(nx)}:{int(ny)}"


BIO_TEMPLATES = [
    "把平时收集的 {topic} 归档在这里，慢慢补齐。",
    "业余整理 {topic}，欢迎来仓库里翻。",
    "{topic} 爱好者，文件都标了来源，取用请注明出处。",
    "只做整理，不做原创。{topic} 相关有问题可以直接留言。",
    "在攒一套能长期用的 {topic}，有缺的欢迎补充。",
]


def main(count: int) -> None:
    if not DB_PATH.exists():
        sys.exit(f"数据库不存在：{DB_PATH}（请先启动一次服务）")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    now = int(time.time())
    # Salt differs per user, but the password is shared so demo accounts are
    # easy to use: <username> / demo1234
    password = "demo1234"

    created_users: list[int] = []
    created_repos: list[int] = []
    public_repos: list[int] = []
    written_files = 0
    written_bytes = 0
    written_thumbs = 0

    print(f"创建 {count} 个用户…")
    for i in range(count):
        # Every draw for this user happens before the existence check. Drawing
        # them after it was a trap: a skipped user consumes fewer random numbers
        # than a created one, so on a re-run the stream slid and every following
        # username was a different one — a second run quietly added another
        # hundred accounts instead of finding the first hundred already there.
        adjective = random.choice(ADJECTIVES)
        noun = random.choice(NOUNS)
        topic = random.choice(REPO_TOPICS)[0]
        template = random.choice(BIO_TEMPLATES)
        # A mix keeps both avatar paths in the demo: most users get a built-in
        # geometric preset, some get a generated upload.
        use_avatar_upload = random.random() < 0.4
        preset = random.randint(1, PRESET_AVATARS)
        joined_at = now - random.randint(0, 86400 * 60)

        name = f"{adjective}_{noun}_{i:03d}"
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
            continue
        bio = template.format(topic=topic)
        avatar = write_avatar(name) if use_avatar_upload else f"preset:{preset}"
        salt = secrets.token_hex(16)
        cur = conn.execute(
            """INSERT INTO users (username, pw_salt, pw_hash, created_at, avatar, bio)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (name, salt, hash_pw(password, salt), joined_at, avatar, bio),
        )
        created_users.append(cur.lastrowid)

    # The site owner and any demo accounts already present take part in the
    # social graph, so the pages the operator actually looks at show activity.
    # They get follows, stars and comments — not repos, so re-running never
    # litters the owner's account with demo repositories.
    neighbours = [
        r["id"] for r in conn.execute(
            "SELECT id FROM users WHERE username IN ('alice', 'bob')"
        )
    ]
    social_users = created_users + neighbours

    print("创建仓库与文件…")
    for uid in created_users:
        owner = conn.execute(
            "SELECT username FROM users WHERE id = ?", (uid,)
        ).fetchone()["username"]
        for topic, desc in random.sample(REPO_TOPICS, random.randint(1, 3)):
            # Same rule as the user loop: draw before the check.
            private = 1 if random.random() < 0.15 else 0
            created = now - random.randint(0, 86400 * 45)
            wants_cover = random.random() < 0.45
            cover_x, cover_y = random.randint(20, 80), random.randint(20, 80)

            name = topic
            if conn.execute(
                "SELECT 1 FROM repos WHERE owner_id = ? AND name = ?", (uid, name)
            ).fetchone():
                continue
            cover = (
                write_cover(f"{owner}/{name}", cover_x, cover_y) if wants_cover else ""
            )
            cur = conn.execute(
                """INSERT INTO repos (owner_id, name, description, created_at, updated_at,
                                      is_private, cover)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (uid, name, desc, created, created, private, cover),
            )
            rid = cur.lastrowid
            created_repos.append(rid)
            if not private:
                public_repos.append(rid)

            for fname, mime in random.sample(FILE_CATALOG, random.randint(3, 6)):
                # Draw before the check, as above.
                folder = random.choice(FOLDERS)
                downloads = random.randint(0, 120)
                offset = random.randint(0, 3600)
                tags = random.choice(["", "精选", "精选, 素材", "存档"])

                path = f"{folder}{fname}"
                if conn.execute(
                    "SELECT 1 FROM files WHERE repo_id = ? AND path = ?", (rid, path)
                ).fetchone():
                    continue
                stored = uuid.uuid4().hex
                data = make_payload(f"{owner}/{name}/{path}", fname, path, name, owner)
                (UPLOAD_DIR / stored).write_bytes(data)
                written_files += 1
                written_bytes += len(data)
                thumb = write_thumb(stored, data)
                if thumb:
                    written_thumbs += 1
                conn.execute(
                    """INSERT INTO files (repo_id, uploader_id, path, stored_name, size,
                                          mime, downloads, created_at, tags, thumb)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (rid, uid, path, stored, len(data), mime, downloads,
                     created + offset, tags, thumb),
                )

    print("建立关注关系…")
    follows = 0
    for uid in social_users:
        for target in random.sample(social_users, min(len(social_users), random.randint(0, 6))):
            if target == uid:
                continue
            try:
                conn.execute(
                    "INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)",
                    (uid, target, now - random.randint(0, 86400 * 30)),
                )
                follows += 1
            except sqlite3.IntegrityError:
                pass  # already following

    # Point some of the new users at the owner as well, so her follower list is
    # not empty on a fresh database.
    for target in neighbours:
        for uid in random.sample(social_users, min(len(social_users), random.randint(0, 8))):
            if uid == target:
                continue
            try:
                conn.execute(
                    "INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)",
                    (uid, target, now - random.randint(0, 86400 * 20)),
                )
                follows += 1
            except sqlite3.IntegrityError:
                pass

    print("点亮星标…")
    # Stars and comments land on public repos only: a private repo with other
    # people's names on it would contradict what the privacy flag promises.
    stars = 0
    for uid in social_users:
        for rid in random.sample(public_repos, min(len(public_repos), random.randint(0, 12))):
            try:
                conn.execute(
                    "INSERT INTO stars (user_id, repo_id) VALUES (?, ?)", (uid, rid)
                )
                stars += 1
            except sqlite3.IntegrityError:
                pass

    print("写入评论…")
    comments = 0
    for rid in random.sample(public_repos, min(len(public_repos), 60)):
        for uid in random.sample(social_users, min(len(social_users), random.randint(1, 3))):
            conn.execute(
                "INSERT INTO comments (repo_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
                (rid, uid, random.choice(COMMENTS), now - random.randint(0, 86400 * 20)),
            )
            comments += 1

    conn.commit()
    totals = {
        "用户": conn.execute("SELECT COUNT(*) n FROM users").fetchone()["n"],
        "仓库": conn.execute("SELECT COUNT(*) n FROM repos").fetchone()["n"],
        "文件": conn.execute("SELECT COUNT(*) n FROM files").fetchone()["n"],
        "关注": conn.execute("SELECT COUNT(*) n FROM follows").fetchone()["n"],
        "星标": conn.execute("SELECT COUNT(*) n FROM stars").fetchone()["n"],
        "评论": conn.execute("SELECT COUNT(*) n FROM comments").fetchone()["n"],
    }
    thumbs = conn.execute(
        "SELECT COUNT(*) n FROM files WHERE thumb IS NOT NULL"
    ).fetchone()["n"]
    conn.close()

    print()
    print("本次新增：")
    print(f"  用户 {len(created_users)} · 仓库 {len(created_repos)} · 关注 {follows} · 星标 {stars} · 评论 {comments}")
    print(f"  真实文件 {written_files} 个（{written_bytes / 1024 / 1024:.1f} MB），"
          f"其中本次生成缩略图 {written_thumbs} 个（库内合计 {thumbs} 个）")
    print("数据库合计：")
    for k, v in totals.items():
        print(f"  {k}: {v}")
    print()
    print(f"所有新账号密码：{password}（用户名形如 swift_fox_001）")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    main(n)
