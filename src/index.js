// Cloudflare Realtime 反向代理 + 多人视频会议房间（Durable Object）
//
// 职责：
// 1. 在前端与 rtc.live.cloudflare.com 之间加一层代理（/realtime/*）
// 2. 通过 Durable Object 实现房间信令（/room/:id/ws），浏览器经 WebSocket
//    交换各自的 (sessionId, trackNames)，实现多人互相订阅
// 3. App Id 与 App Secret 由服务端保管，避免密钥暴露到浏览器
//
// 部署前配置：
//   REALTIME_APP_ID          已配置在 wrangler.jsonc 的 vars 中
//   REALTIME_APP_SECRET      需通过命令设置：wrangler secret put REALTIME_APP_SECRET
//   REALTIME_ACCESS_TOKEN    可选。设置后 /realtime/* 与房间信令都需要访问码。

const REALTIME_BASE = 'https://rtc.live.cloudflare.com/v1/apps';

// 固定房间名：整个应用只用一个房间，客户端无法指定
const ROOM_NAME = 'hello';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 房间信令 WebSocket：固定房间 /room/ws（房间名写死在 ROOM_NAME）
    if (url.pathname === '/room/ws') {
      // 访问控制（可选），token 走查询参数或请求头
      if (env.REALTIME_ACCESS_TOKEN) {
        const token = url.searchParams.get('token') || request.headers.get('x-access-token');
        if (token !== env.REALTIME_ACCESS_TOKEN) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
      }
      const id = env.ROOMS.idFromName(ROOM_NAME);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // 代理 Realtime API：/realtime/<path> -> /v1/apps/<APP_ID>/<path>
    if (url.pathname.startsWith('/realtime/')) {
      // 简单访问控制：页面本身公开，但 API 需要访问码（可选）
      if (env.REALTIME_ACCESS_TOKEN) {
        const provided = request.headers.get('x-access-token');
        if (provided !== env.REALTIME_ACCESS_TOKEN) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
      }

      const apiPath = url.pathname.replace(/^\/realtime\//, '') + url.search;
      const targetUrl = `${REALTIME_BASE}/${env.REALTIME_APP_ID}/${apiPath}`;

      // 只透传必要的头，避免把浏览器侧的 host/origin 等带过去
      const headers = new Headers({
        Authorization: `Bearer ${env.REALTIME_APP_SECRET}`,
        Accept: 'application/json'
      });
      if (request.headers.has('content-type')) {
        headers.set('content-type', request.headers.get('content-type'));
      }

      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body
      });

      return new Response(response.body, {
        status: response.status,
        headers: response.headers
      });
    }

    // 其余请求由 Workers Static Assets 托管 public 目录
    return env.ASSETS.fetch(request);
  }
};

// 房间 Durable Object：
// 一个房间对应一个实例，内存中维护成员列表，通过 WebSocket 广播成员加入/离开。
// 成员信息只需要 (sessionId, trackNames)，真正媒体流转发由 Cloudflare Realtime SFU 完成。
export class Room {
  constructor(ctx, env) {
    this.members = new Map(); // server WebSocket -> { sessionId, trackNames } | null
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.members.set(server, null);

    server.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type !== 'join' || !msg.sessionId) return;

      const member = { sessionId: msg.sessionId, trackNames: msg.trackNames || [] };
      this.members.set(server, member);

      // 广播新成员给房间内其他人
      for (const [conn, m] of this.members) {
        if (conn !== server && m) {
          conn.send(JSON.stringify({ type: 'member-joined', member }));
        }
      }
      // 给新成员返回当前成员列表（不含自己）
      const others = [...this.members.values()].filter(
        (m) => m && m.sessionId !== member.sessionId
      );
      server.send(JSON.stringify({ type: 'members', members: others }));
    });

    server.addEventListener('close', () => {
      const member = this.members.get(server);
      this.members.delete(server);
      if (member) {
        // 广播成员离开
        for (const [conn, m] of this.members) {
          if (m) {
            conn.send(JSON.stringify({ type: 'member-left', sessionId: member.sessionId }));
          }
        }
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
