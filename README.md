# delphi-mcp

让 Agent 读取 Chief Delphi（chiefdelphi.com，Discourse 论坛）数据的本地 stdio MCP server。只读、免登录、无需 API key。

- 运行时：Node 18+，纯 ESM JavaScript，无编译步骤
- 依赖：`@modelcontextprotocol/sdk` + `zod`
- 上游：Discourse 匿名只读 JSON 接口

## 接入 Qoder

`C:\Users\caryw\.qoder-cn\settings.json` 的 `mcpServers` 里加一条（形状与本机已有的 `colab-mcp` 一致）：

```json
{
  "mcpServers": {
    "chief-delphi": {
      "command": "node",
      "args": ["C:\\Users\\caryw\\Desktop\\codes\\delphi-mcp\\src\\index.js"]
    }
  }
}
```

改完重启 Qoder，或先发 `/mcp reload` 再看连接器状态。

## 六个工具

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `cd_categories` | 列出全部分类与子分类（id + slug），用来给检索划定范围 | — |
| `cd_topics` | 浏览帖子列表：`latest` / `new` / `top`，可按分类和期段过滤，翻页 | `mode` `category` `period` `order` `page` `limit` |
| `cd_find` | 关键词找帖：拉列表池 → 匹配标题/标签/摘要 → 排序 → 取 `/raw` 证实正文命中并报出命中的帖子号 | `query` `mode` `pages` `match` `with_body` `category` |
| `cd_topic` | 读一个楼：作者、用户头衔、时间、点赞数、回复对象、post id、删帖/隐藏标记 | `topic` `at_post` `page` `max_posts` `format` |
| `cd_raw` | 以 Discourse 纯文本读整条 thread，最省 token；可按帖子号区间只读一段 | `topic` `start_post` `end_post` |
| `cd_user` | 查账号资料：信任等级、注册时间、资料字段（如 FRC Team Number）、profile 浏览量 | `username` |

所有工具有 `max_chars`（默认 20000，上限 120000），超出会在结尾标注截断并提示怎么继续，避免一次调用灌爆上下文。

## 合规立场

CD 的 robots.txt 对 `User-agent: *` 声明了 `Disallow: /search`。本项目**不调用 `/search.json`**，并且这不是靠注释约束的：`src/discourse.js` 每次请求前都会按 robots.txt 的最长匹配规则判定，命中 Disallow 直接抛 `RobotsBlockedError`。`/admin/`、`/session`、`*.rss` 同样会被拦。要改这个立场就得改 robots 判定本身。

`cd_find` 因此不是全文检索，而是「列表窗口内的检索」：

- 默认 `mode=auto` 同时取 `top`（最热）与 `latest`（最新）两个池，避免只看历史热帖而漏掉近期主题
- 空结果的含义是「不在这个窗口里」，不代表论坛没有这帖；输出里会明说这一点，并给出加 `pages=`、加 `category=`、换 `mode=latest` 这几条出路
- 窗口大小由 `pages` 决定（每页约 30 帖，上限 40 页 ≈ 1200 帖）

对上游礼貌：所有请求串行化并强制最小间隔 350ms；CD 在 Cloudflare 后面，并发或过快会被质询。响应落盘缓存在 `.cache/`（列表 10 分钟、帖子与 robots 分别 3 小时与 24 小时），重复调用不再打站点。论坛正文是用户生成内容，本工具只做取回，不代为再发布。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DELPHI_BASE_URL` | `https://www.chiefdelphi.com` | 换 Discourse 站点即可复用 |
| `DELPHI_MIN_INTERVAL_MS` | `350` | 被 403/429/503 时调大 |
| `DELPHI_REQUEST_TIMEOUT_MS` | `20000` | 单请求超时 |
| `DELPHI_USER_AGENT` | `delphi-mcp/0.1 (+read-only Discourse client)` | robots 判定按这个 token 匹配规则组 |
| `DELPHI_CACHE_DIR` | `<项目>/.cache` | 缓存目录；没有关闭缓存的开关，清空该目录即等于强制重新抓取 |

## 自检

```bash
npm install
node test/smoke.js
```

`test/smoke.js` 会真的起一个 server 进程、走 stdio 协议逐个调用 6 个工具，共 19 项断言全部通过：冷启动约 21 秒（缓存命中后约 3.5 秒）。其中三项是专门用来证明合规逻辑有牙的：`/search.json` 被拦、`/admin/logs.json` 被拦、以及**控制组** `/latest.json` 仍然放行——只验证拦截不作数，必须同时证明没把正常路径一起封掉。删掉 `.cache/` 即可强制重新走网络。

已实测确认的接口事实（写进代码前逐条核过）：

- `/t/<id>/<n>.json` 里的 `n` 是**帖子号**不是页码，且窗口从 `n-5` 开始；`page` 参数在 `/t/<id>/posts.json` 上对匿名请求无效
- Discourse 会把窗口填满约 20 个存活帖子，所以含删帖的 thread 里相邻 `page` 可能重复 1 个帖子号；需要精确续读就用 `at_post`
- `/u/<name>.json` 返回 `{user: …}` 包裹，且不含 `topic_count` / `likes_received` 这类统计；资料字段的数字编号要靠 `/site.json` 的 `user_fields` 才能翻译成人话
