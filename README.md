# my-sfu-demo

基于 Cloudflare Workers + Cloudflare Realtime（SFU）的固定房间多人视频会议 demo。

- 固定房间：房间名 `hello` 在 Worker 中写死，客户端无法指定
- 访问控制：页面公开，API 可通过 `REALTIME_ACCESS_TOKEN` 校验访问码（可选）
- 视频质量：采集 720p/30fps，发送编码上限 1 Mbps / 30fps
- 响应式页面：支持深色模式与移动端适配

## 架构

```
浏览器 A ──── WebSocket 信令 ────> Worker (Durable Object Room) <──── WebSocket ──── 浏览器 B
   │                                   (交换 sessionId / trackNames)                     │
   └─────── WebRTC (UDP, 媒体流) ─────── Cloudflare Realtime SFU ─────── WebRTC ────────┘
```

- **媒体流**：浏览器与 Cloudflare SFU 之间直接建立 WebRTC 连接（发布 + 订阅），Worker 不碰媒体。
- **信令**：浏览器通过 WebSocket 连接 Worker 的 Durable Object（`Room`），交换各成员的 `(sessionId, trackNames)`，成员加入/离开由房间广播通知。
- **订阅制**：浏览器以 `sendonly` 发布本地音视频；SFU 不会自动推送任何流，必须用 `newTracks(location: 'remote')` 逐个订阅，n 人会议 = 订阅 n-1 人。

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

## 多路视频流：SFU 如何返回给客户端

多路视频流是 **WebRTC 原生能力（单连接多轨道 multi-track）**，不是 SFU 特有的。SFU 的作用是把来自不同人的轨道汇聚转发进客户端同一条连接。

### 1. 单条 PeerConnection 承载任意多路流

WebRTC 的 `RTCPeerConnection` 不是"一路流一个连接"，而是一个**多路复用**的连接。SDP 里每个媒体流对应一组 `m=video` / `m=audio`（m-line），一个连接可以同时包含多个 m-line。

本项目还用 `bundlePolicy: 'max-bundle'` 把所有 m-line 打包进**同一条** ICE/UDP 传输：

```js
self.pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    bundlePolicy: 'max-bundle'
});
```

"一路连接 + 多路流"是标准的 WebRTC 模型（RFC 8829 多 m-line + RFC 9143 BUNDLE）。

### 2. 多路流如何在一条连接里区分

传输层面是**同一根 UDP 通道**，区分靠协议头：

- 每路轨道有自己的 **SSRC**（同步源标识符）
- 每路轨道还有自己的 **mid**（SDP 里 m-line 的 `a=mid:` 值）
- 收到 RTP 包后，接收端按 SSRC/mid 分拣，识别出一条新轨道就触发一次 `ontrack` 事件

### 3. SFU 的角色：只转发，不合并

订阅 N 个成员后，SFU（Cloudflare Realtime）在**你那条连接**里，向 SDP 追加 N 个成员的 m-line：

```
你的连接（与 SFU 之间的单条 PeerConnection）
├── m=video  SSRC-A  成员1 的视频（SFU 从成员1的连接转发过来）
├── m=audio  SSRC-B  成员1 的音频
├── m=video  SSRC-C  成员2 的视频（SFU 从成员2的连接转发过来）
├── m=audio  SSRC-D  成员2 的音频
└── ...
```

SFU 收到各发送者的 RTP 包后，**原样改路由（转发）**到你的连接上，每条流保持独立的 SSRC，不做混流、不改编码。

### 4. 前端感知方式

`ontrack` 会**按轨道逐条触发**，前端按"该成员应有 track 数"（`trackNames.length`）收齐后渲染：

```js
self.pc.ontrack = event => {
    for (const entry of members.values()) {
        if (entry.received < entry.trackNames.length) {
            entry.stream.addTrack(event.track);
            entry.received++;
            if (entry.received === entry.trackNames.length) {
                renderMember(entry);
            }
            break;
        }
    }
};
```

### 5. 订阅几次，就有几路

- 连接阶段（`newSession`）不会收到任何流
- 每订阅**一个成员**就发起一次 `newTracks(remote)`，一次 renegotiation 加入该成员全部 track
- 3 人房间 → 订阅 2 个成员 → 2 路视频流（各带 1 路音频），共 4 条 track
- 订阅请求必须指定 `sessionId + trackName`，指向具体成员；订阅多个成员需多次 renegotiation，因此前端用串行队列排队，避免协商冲突

## 已知限制

- 无昵称 / 音视频开关状态角标
- 无人数限制
- 未实现用户选择性订阅（取消订阅需真正 renegotiation）
