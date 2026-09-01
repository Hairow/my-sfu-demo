# my-sfu-demo

基于 Cloudflare Workers + Cloudflare Realtime（SFU）的固定房间多人视频会议 demo。

- 固定房间：房间名 `hello` 在 Worker 中写死，客户端无法指定
- 访问控制：页面公开，API 可通过 `REALTIME_ACCESS_TOKEN` 校验访问码（可选），token 不经过 URL 入口
- 视频质量：采集 720p/30fps，发送编码上限 1 Mbps / 30fps
- 响应式页面：支持深色模式与移动端适配

## 目录结构

```
├── src/
│   ├── index.js        # Worker 入口：/api/room/ws 信令、/api/realtime/* 代理、静态资源
│   └── room.js         # Room Durable Object：WebSocket 信令与成员管理（Hibernation 模式）
├── public/
│   ├── index.html      # 页面结构 + 响应式样式
│   └── app.js          # 前端全部逻辑（WebRTC 发布/订阅、信令、音视频开关）
└── wrangler.jsonc      # Workers 配置（vars / assets / durable_objects / migrations）
```

## 环境变量

| 变量 | 位置 | 说明 |
| --- | --- | --- |
| `REALTIME_APP_ID` | `wrangler.jsonc` 的 `vars` | Cloudflare Realtime App ID |
| `REALTIME_APP_SECRET` | `wrangler secret put` | 服务端代理时注入 `Authorization: Bearer`，不落浏览器 |
| `REALTIME_ACCESS_TOKEN` | `wrangler secret put`（可选） | 访问码，WebSocket 走 `?token=`，HTTP 走 `x-access-token` 头 |

## 部署

```bash
npx wrangler deploy
npx wrangler secret put REALTIME_APP_SECRET
npx wrangler secret put REALTIME_ACCESS_TOKEN   # 可选
```

本地开发时把 secret 写入 `.dev.vars`（已 gitignore）。

## 访问码（可选）

配置了 `REALTIME_ACCESS_TOKEN` 后，所有 API 请求（Realtime 代理 + WebSocket 信令）都需要访问码。

**前端获取顺序**（`public/app.js`）：

1. `sessionStorage` 缓存（同标签页内有效）
2. 都没有则 `prompt()` 弹窗输入

> 不支持 `?token=` URL 参数入口：访问码不会出现在 URL 中，避免访问日志 / 浏览器历史 / 分享链接泄露。

**传递方式**（服务端接收）：

| 请求类型 | 传递位置 |
| --- | --- |
| Realtime API（`/api/realtime/*`） | `x-access-token` 请求头 |
| WebSocket 信令（`/api/room/ws`） | `?token=` 查询参数（WebSocket 无法自定义请求头，不得已） |

**未配置** `REALTIME_ACCESS_TOKEN` 时，服务端跳过校验，访问码输入与否不影响使用。

## 实现原理

### 1. 整体架构：信令与媒体彻底分离

```
浏览器 A                                   浏览器 B
   │  ① WebSocket 信令（/api/room/ws）        │
   ├───────────────► Worker ◄───────────────┤
   │        Durable Object Room              │
   │         （只交换 sessionId/trackNames）   │
   │                                         │
   │  ② WebRTC 媒体（UDP 直连 SFU）           │
   ├───────────────► Cloudflare Realtime SFU ◄──┘
                    （只转发媒体，不碰信令）
```

两个平面各司其职，这是理解整个系统的钥匙：

| 平面 | 通道 | 传输内容 | 参与者 |
| --- | --- | --- | --- |
| 信令面 | WebSocket | 谁在房间、谁的流叫什么名字 | 浏览器 ↔ Worker(DO) |
| 媒体面 | WebRTC (UDP) | 音视频 RTP 包 | 浏览器 ↔ Cloudflare SFU |

**为什么分开**：信令量小（每秒几条 JSON）、需要房间语义（加入/离开/列表），适合 Durable Object 做有状态服务；媒体量大（每秒几 Mbps）、需要低延迟低丢包，必须走 UDP 直连，任何中转 HTTP 服务器都会成为瓶颈。Worker 全程不碰媒体。

### 2. 访问控制链路

**前端获取**（`app.js`）：`sessionStorage` 缓存 → `prompt()` 弹窗。刻意**不读 URL 参数**，避免 token 进入日志/历史/分享链接。

**传递**（两种请求、两种位置）：

| 请求 | 位置 | 原因 |
| --- | --- | --- |
| Realtime API | `x-access-token` 请求头 | fetch 可自定义头 |
| WebSocket | `?token=` 查询参数 | WS 握手协议不允许自定义头，只能放 URL（唯一例外） |

**服务端校验**（`index.js` 两处）：`/api/room/ws` 分支与 `/api/realtime/*` 分支分别与 `REALTIME_ACCESS_TOKEN` 比对，不匹配返回 401。未配置 secret 则跳过。

### 3. 前端启动时序（一次完整进房）

```
① 采集       getUserMedia({video: 720p/30fps ideal, audio})
② 建连接     new RTCPeerConnection({STUN, bundlePolicy:'max-bundle'})
③ 发布       本地 2 条 track → addTransceiver(direction:'sendonly',
             视频带 sendEncodings: [{maxBitrate:1Mbps, maxFramerate:30}])
④ 建会话     createOffer → POST /sessions/new → 拿到 sessionId
⑤ 等连接     iceConnectionState === 'connected'
⑥ 再协商     createOffer(含本地 track 的 m-line) → POST /tracks/new(local)
⑦ 进房间     WebSocket open → join{sessionId, trackNames}
⑧ 等订阅     收到 members/member-joined → 逐个 newTracks(remote)
```

三个细节值得展开：

**③ 为什么用 `addTransceiver` 而非 `addTrack`**：`addTrack` 只能加 track，`addTransceiver` 能顺带指定 `direction`（sendonly）和 `sendEncodings`（编码参数）。`sendEncodings` 里的 `maxBitrate`/`maxFramerate` 会被写进 SDP，从源头限制发送码率——这是"720p 却不会跑满 4K 码率"的实现点。

**④ 建会话的本质**：`sessions/new` 是浏览器与 SFU 之间的**首次 SDP 协商**。offer 里包含本地媒体能力（m-line 列表、编解码、ICE candidate），SFU 返回 answer 并分配一个 `sessionId`（UUID），此后所有操作都以它为索引。

**⑤ 为什么必须等 connected 再发布 tracks**：媒体传输依赖 ICE 连接，先确保数据通路可用，再谈订阅，避免协商成功但收不到流。

### 4. 信令协议：Room DO 的状态机

WebSocket 消息共 4 种，全部是 JSON：

| 方向 | 类型 | 内容 | 触发动作 |
| --- | --- | --- | --- |
| 浏览器→Room | `join` | `{sessionId, trackNames}` | 登记成员，广播 `member-joined`，回 `members` 列表 |
| Room→新成员 | `members` | 其他成员数组 | 逐个订阅（补历史） |
| Room→老成员 | `member-joined` | 新成员信息 | 订阅新成员（实时增量） |
| Room→所有人 | `member-left` | sessionId | 移除视频卡片 |

**Hibernation 模式**（`room.js` 的关键设计）：

- `ctx.acceptWebSocket(server)`：连接交给平台托管，DO 休眠/重启（evict）后**连接不丢**
- `serializeAttachment(member)`：每个连接的成员数据附加其上，由平台持久化
- 构造函数 `getWebSockets()` + `deserializeAttachment()`：唤醒时重建 `连接→成员` 映射
- 事件处理必须是类方法 `webSocketMessage`/`webSocketClose`（Hibernation 的硬性约束）

这样设计解决的是：DO 是无状态容器，随时可能被平台回收。没有 Hibernation，重启即全员掉线；有了它，重启对在线用户透明，新成员还能拿到完整老成员列表。

### 5. 订阅与多路流（核心机制）

**为什么必须主动订阅**：SFU 的默认行为是"只接收发布，不主动推送"。订阅者必须在自己的会话里对每个远端成员发 `newTracks(location:'remote', sessionId, trackName)`，SFU 才开始转发。

**一次订阅的完整协商**（`app.js`）：

```
① POST /sessions/{id}/tracks/new    body: {tracks:[remote...]}（无 offer）
② SFU 返回 requiresImmediateRenegotiation:true + 一个 offer SDP
   （offer 里包含被订阅成员的 video/audio m-line）
③ setRemoteDescription(offer)
④ createAnswer() → PUT /sessions/{id}/renegotiate 回传 answer
⑤ 协商完成，SFU 开始把该成员的流转发过来
```

**多路流的本质**：这不是"SFU 发明了多流"，而是 WebRTC 原生支持**单连接多轨道**：

- 一条 `RTCPeerConnection` 的 SDP 里可以有很多 `m=video` / `m=audio`（m-line）
- 传输时全部 m-line 通过 `bundlePolicy:'max-bundle'` 打包进**同一根 UDP 通道**
- 每条轨道用独立的 **SSRC** 标识，接收端按 SSRC/mid 分拣，识别出新轨道就触发一次 `ontrack`

**`ontrack` 的分组逻辑**（`app.js`）：订阅是按"成员"为单位的，所以收到的 track 也要按成员归组。前端给每个订阅成员建一个 `MediaStream`，`ontrack` 事件把 track 放进"还没收满"（`received < trackNames.length`）的那个成员，收齐才渲染视频卡片。

**串行队列的必要性**：订阅 2 个成员 = 2 轮独立 renegotiation。若并发进行，两轮协商会互相打断（`setRemoteDescription` 只能串行）。所以用 `renegotiationQueue` 把订阅请求串起来，逐个完成。

**为什么 n 人 = 订阅 n-1 人**：每人发布自己的 2 条 track（video+audio），其他人各自订阅你——你的连接同时承担"上行 2 条 + 下行 2×(n-1) 条"，全部走同一根 UDP 通道。

### 6. 媒体传输与 NAT：单边穿透

```
浏览器(内网)  ──UDP──►  NAT  ──► 公网 ──►  SFU(公网)
                 ▲                          │
                 └──── 回包经 NAT 映射 ──────┘
```

- 浏览器在 NAT 后，只有内网 host candidate；SFU 在公网，无法主动往内网地址发包
- **STUN 的作用**：浏览器向 `stun.cloudflare.com:3478` 问"我的公网映射地址是什么"，拿到 server-reflexive (srflx) candidate
- 这个 srflx 写进 SDP offer → SFU 知道往哪回包 → ICE 连通性检查通过 → 媒体开始双向流动
- 这是**单边穿透**：只有浏览器需要穿透，SFU 是公网服务器（ICE-Lite 角色），无需打洞
- 所以不需要 TURN：普通家庭/办公 NAT 下，srflx 足够；对称 NAT 极端场景才需要 TURN（当前未配置）

### 7. 数据流全景

```
成员A的摄像头 ──► A的RTCPeerConnection ──► SFU（收 A 的流）
                                              │ 转发（不混流、不改码）
                                              ├──► B（若 B 订阅了 A）
                                              └──► C（若 C 订阅了 A）
```

- SFU 做的是**路由转发**：A 的 RTP 包到达 SFU 后，SFU 查"谁订阅了 A"，把包复制转发到对应订阅者的连接，保持原 SSRC
- **订阅关系不对称**：B 订阅 A 不代表 A 订阅 B，各自独立管理

### 8. 可靠性设计

| 故障 | 机制 |
| --- | --- |
| WS 断线 | 前端 2 秒自动重连，重连后重新 `join`，Room 补发 `members` 列表 |
| DO 重启 | Hibernation：连接与附件数据由平台恢复，成员列表不丢 |
| 成员离开 | `webSocketClose` 广播 `member-left`，前端移除卡片、停止 track |
| 订阅失败 | 队列 `catch` 中移除成员并打日志，不影响其他订阅 |

### 9. 已知限制（设计取舍）

- 无昵称 / 音视频开关状态角标：识别靠 sessionId 前 8 位
- 无人数上限与选择性订阅（取消订阅需真正 renegotiation，当前未实现）
- 对称 NAT 场景无 TURN 兜底
- token 明文存 sessionStorage（XSS 可读，本页面无第三方输入，风险可接受）
