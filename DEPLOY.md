# FileHub 部署指南

## 先说结论：不要部署到 Vercel

你给的是 `https://vercel.com/tokisaki-kurumi`。**这个站跑不了 Vercel**，不是配置问题，是形态不匹配：

| 这个站依赖什么 | Vercel 提供什么 |
|---|---|
| SQLite 数据库文件（可写） | 函数文件系统**只读**，只有 `/tmp` 可写且每次调用后回收 |
| `uploads/` 存用户上传的文件 | 同上，文件不会留存 |
| 常驻进程（`uvicorn`） | Serverless 函数，按请求启动 |

硬要上的话，注册、上传、评论、改封面这些写操作**全部会失败**，而且你现在看到的 7 个仓库和图片也传不过去。

所以下面给的是 **Docker / VPS** 路线，代码不用改。

---

## 第一步：准备一个服务器

任选其一（都是月付几美元级别）：

- **Railway** / **Render** —— 支持 Docker，有持久卷，最省事
- **Fly.io** —— 支持卷，命令行操作
- 自己的 **VPS**（阿里云/腾讯云/DigitalOcean 等）+ Docker

要求只有一点：**能挂载持久卷**。没有持久卷，数据每次重新部署就没了。

---

## 第二步：确认代码可以构建

项目已经准备好了这些文件，你不用改：

```
Dockerfile            镜像定义，数据放在 /app/data
docker-compose.yml    一条命令起服务，数据挂到命名卷
.dockerignore         排除备份和开发残留
requirements.txt      已补上漏掉的 Pillow
prune_to_owner.py     数据裁剪脚本
set_password.py       设置密码脚本
```

镜像会把你当前的 7 个仓库和图片**打进去作为初始数据**，所以第一次起来就能看到现在的样子，不是空站。

本地有 Docker 的话，先构建试试：

```bash
cd filehub
docker build -t filehub .
```

> **诚实说明**：我这边没装 Docker，**上面这条构建命令我没有实际跑过**。逻辑我用 Python 模拟验证了（数据目录种子、路径解析、21 个上传文件都能被应用找到），但镜像构建本身未经检验。如果报错，把错误发我。

---

## 第三步：起服务

```bash
docker compose up -d --build
```

然后访问 `http://你的服务器IP:8000`。

`docker-compose.yml` 里已经做了三件事：
- 数据挂到命名卷 `filehub-data` → 重新部署不影响数据库和上传的文件
- 设了 `restart: unless-stopped` → 服务器重启后自动拉起
- 健康检查打首页（首页要读数据库，返回 200 才算真的能服务）

**数据在哪**：卷里的 `/app/data`，包含 `filehub.db` 和 `uploads/`。这两个必须**一起**备份 —— 数据库里每行 `files` 都指向 `uploads/` 里的一个文件，分开恢复了页面就是一片坏图。

---

## 第四步：设置站长密码

**这一步必须做，否则你登不进去。**

我按你的要求「只保留站长数据」裁剪了数据库，并且**清空了 `alice` 的密码** —— 因为本地的 `secret123` 是公开的测试密码，带上线等于没设防。

设置新密码：

```bash
# 在容器里执行
docker compose exec filehub python set_password.py alice
# 会提示输入两次，不回显

# 或者非交互式（会留在 shell 历史里，不推荐）
docker compose exec filehub python set_password.py alice --password '你的新密码'
```

设完就能用这个密码登录 `alice` 了。

---

## 数据现状

裁剪脚本保留了站长（`users` 表第一行，也就是 `alice`）的全部内容：

| | 保留 | 删除 |
|---|---|---|
| 用户 | 1（alice） | 101 |
| 仓库 | 7 | 199 |
| 文件 | 18 | 641 |
| 评论 | alice 的（含聊天室消息） | 80 |
| 星标 | — | 664 |
| 上传文件 | 21 个被引用的 | 645 |

裁剪前我做了备份：`filehub.db.backup-20260922-162528`。想恢复就是 `cp` 回去。**这个备份里有测试密码和全部数据，不要提交到仓库或传到服务器。**

脚本删数据前会校验一致性，我实测过：删除后**没有任何悬空引用**（文件找不到仓库、仓库找不到用户等），文件行和磁盘字节一一对应。

---

## 用 Cloudflare 加 HTTPS（推荐这么做）

前面提过「HTTP 明文」是个问题。用 Cloudflare 放在前面就能解决，而且**代码一行不用改**：

1. 域名接入 Cloudflare（控制台 → 添加站点 → 按提示改 NS 记录）
2. 加一条 **A 记录**指向你服务器的 IP，**代理状态开成橙色云**（Proxied）
3. Cloudflare 控制台 → SSL/TLS → 加密模式选 **Full**（不是 Flexible —— Flexible 会让 CF 到源站这一段仍是明文）
4. 源站防火墙只放行 Cloudflare 的 IP 段（可选但建议），避免有人绕过 CF 直接打你的 IP

然后告诉应用它在代理后面：

```bash
# docker-compose.yml 同目录下建 .env
echo 'FILEHUB_BEHIND_PROXY=1' > .env
docker compose up -d
```

**这个开关为什么必须设**：开启后应用会信任 `X-Forwarded-*` 头（否则 `request.base_url` 一直报 `http://`，而 RSS 订阅源会把每个链接都写成 http），同时把会话 Cookie 标成 `Secure`。反过来，**没有 TLS 就别开** —— `Secure` 的 Cookie 在 http 下不会被保存，登录会表现为「成功但立刻掉登录」。

这样你顺带拿到了：免费 HTTPS 证书、CDN 缓存、DDoS 防护。登录限流也可以在 CF 的 WAF 里配 Rate Limiting 规则，不用碰 Nginx。

---

## 为什么不上 Vercel / Cloudflare Workers

两个平台**都能识别 FastAPI**（Vercel 原生 ASGI；Cloudflare 有 `workers.asgi` 连接器），但状态存不下来：

| | Vercel | Cloudflare Workers | Docker/VPS |
|---|---|---|---|
| 识别 FastAPI | ✅ | ✅ | ✅ |
| 持久化数据库 | ❌ 文件系统只读 | ✅ D1 | ✅ 直接读写文件 |
| 持久化上传文件 | ❌ `/tmp` 每次调用回收 | ✅ R2 | ✅ 直接读写文件 |
| Pillow（图片裁剪） | ✅ | ❌ **WASM 跑不了原生扩展** | ✅ |
| 代码改动量 | 数据层重写 | 数据层 + 图片处理重写 | **零** |

具体到代码：**33 个写操作路由**、**28 处文件写入**，在 Vercel 上全部会抛 `OSError: [Errno 30] Read-only file system`。Cloudflare 有 D1/R2 能解决存储，但要额外面对 Pillow —— 它是原生扩展包，Workers 的 WebAssembly 环境跑不了，而封面裁剪、缩略图、头像处理全靠它。

所以「Docker 跑应用 + Cloudflare 做前置」是这里性价比最高的组合：拿到 CF 的全部好处，且零改动。

---

## 常用命令

```bash
docker compose logs -f filehub      # 看日志
docker compose restart filehub      # 重启
docker compose down                 # 停止（数据保留在卷里）
docker compose up -d --build        # 改代码后重新部署

# 备份数据（数据库 + 上传文件一起）
docker run --rm -v filehub-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/filehub-backup.tar.gz -C /data .
```
