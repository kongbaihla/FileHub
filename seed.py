"""Seed FileHub with demo data: users, repos, follows and stars.

Run with the server stopped or running — it writes straight to SQLite and uses
the same PBKDF2 parameters as the app, so the accounts can log in normally.

    python seed.py            # 100 users
    python seed.py 20         # 20 users
"""
from __future__ import annotations

import hashlib
import os
import random
import secrets
import sqlite3
import sys
import time
import uuid
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
# Same rule as the server: FILEHUB_DATA points at the writable state, so seeding
# a container's volume is a matter of setting the same variable here. Without
# it the script writes a database next to its own source and the running app
# never sees it.
DATA_DIR = Path(os.environ.get("FILEHUB_DATA") or APP_DIR)
DB_PATH = DATA_DIR / "filehub.db"
UPLOAD_DIR = DATA_DIR / "uploads"

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

FILE_NAMES = {
    "image": ["cover.png", "banner.jpg", "mockup.png", "preview.jpg"],
    "document": ["guide.pdf", "notes.md", "readme.txt", "spec.pdf"],
    "archive": ["assets.zip", "backup.tar.gz"],
    "audio": ["track.mp3", "ambient.flac"],
    "other": ["data.bin", "config.json"],
}
MIMES = {
    "image": "image/png",
    "document": "application/pdf",
    "archive": "application/zip",
    "audio": "audio/mpeg",
    "other": "application/octet-stream",
}


def hash_pw(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt_hex), 120_000
    ).hex()


def main(count: int) -> None:
    if not DB_PATH.exists():
        sys.exit(f"数据库不存在：{DB_PATH}（请先启动一次服务）")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    now = int(time.time())
    # Salt differs per user, but the password is shared so demo accounts are
    # easy to use: <username> / demo1234
    password = "demo1234"

    created_users: list[int] = []
    created_repos: list[int] = []

    print(f"创建 {count} 个用户…")
    for i in range(count):
        name = f"{random.choice(ADJECTIVES)}_{random.choice(NOUNS)}_{i:03d}"
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
            continue
        salt = secrets.token_hex(16)
        cur = conn.execute(
            "INSERT INTO users (username, pw_salt, pw_hash, created_at, avatar) VALUES (?, ?, ?, ?, ?)",
            (name, salt, hash_pw(password, salt), now - random.randint(0, 86400 * 60),
             f"preset:{random.randint(1, 6)}"),
        )
        created_users.append(cur.lastrowid)

    created_users += [
        r["id"] for r in conn.execute(
            "SELECT id FROM users WHERE username IN ('alice', 'bob')"
        )
    ]

    print("创建仓库与文件…")
    for uid in created_users:
        for topic, desc in random.sample(REPO_TOPICS, random.randint(1, 3)):
            name = topic
            if conn.execute(
                "SELECT 1 FROM repos WHERE owner_id = ? AND name = ?", (uid, name)
            ).fetchone():
                continue
            private = 1 if random.random() < 0.15 else 0
            created = now - random.randint(0, 86400 * 45)
            cur = conn.execute(
                """INSERT INTO repos (owner_id, name, description, created_at, updated_at, is_private)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (uid, name, desc, created, created, private),
            )
            rid = cur.lastrowid
            created_repos.append(rid)

            for _ in range(random.randint(1, 6)):
                kind = random.choice(list(FILE_NAMES))
                fname = random.choice(FILE_NAMES[kind])
                folder = random.choice(["", "raw/", "final/", "docs/"])
                path = f"{folder}{fname}"
                if conn.execute(
                    "SELECT 1 FROM files WHERE repo_id = ? AND path = ?", (rid, path)
                ).fetchone():
                    continue
                stored = uuid.uuid4().hex
                # A small real file so downloads and archives work.
                blob = f"{name}/{path}\n".encode() * random.randint(1, 40)
                (UPLOAD_DIR / stored).write_bytes(blob)
                conn.execute(
                    """INSERT INTO files (repo_id, uploader_id, path, stored_name, size, mime,
                                          downloads, created_at, tags)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (rid, uid, path, stored, len(blob), MIMES[kind],
                     random.randint(0, 120), created + random.randint(0, 3600),
                     random.choice(["", "精选", "精选, 素材", "存档"])),
                )

    print("建立关注关系…")
    follows = 0
    for uid in created_users:
        for target in random.sample(created_users, random.randint(0, 6)):
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

    print("点亮星标…")
    stars = 0
    for uid in created_users:
        for rid in random.sample(created_repos, min(len(created_repos), random.randint(0, 12))):
            try:
                conn.execute(
                    "INSERT INTO stars (user_id, repo_id) VALUES (?, ?)", (uid, rid)
                )
                stars += 1
            except sqlite3.IntegrityError:
                pass

    print("写入评论…")
    comments = 0
    for rid in random.sample(created_repos, min(len(created_repos), 40)):
        for uid in random.sample(created_users, random.randint(1, 3)):
            conn.execute(
                "INSERT INTO comments (repo_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
                (rid, uid, random.choice([
                    "整理得很用心，感谢分享！",
                    "收藏了，正好需要这个。",
                    "请问后续还会更新吗？",
                    "分类清晰，找东西很方便。",
                    "已经下载，质量不错 👍",
                ]), now - random.randint(0, 86400 * 20)),
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
    conn.close()

    print()
    print("本次新增：")
    print(f"  用户 {len(created_users)} · 仓库 {len(created_repos)} · 关注 {follows} · 星标 {stars} · 评论 {comments}")
    print("数据库合计：")
    for k, v in totals.items():
        print(f"  {k}: {v}")
    print()
    print(f"所有新账号密码：{password}（用户名形如 swift_fox_001）")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    main(n)
