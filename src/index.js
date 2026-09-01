// Cloudflare Realtime 反向代理 + 多人视频会议房间（Durable Object）
//
// 职责：
// 1. 在前端与 rtc.live.cloudflare.com 之间加一层代理（/api/realtime/*）
// 2. 通过 Durable Object 实现房间信令（/api/room/ws），浏览器经 WebSocket
//    交换各自的 (sessionId, trackNames)，实现多人互相订阅
// 3. App Id 与 App Secret 由服务端保管，避免密钥暴露到浏览器
//
// 路由约定：非静态路径统一以 /api 开头
//   GET /api/room/ws                WebSocket 房间信令
//   POST /api/realtime/...          Realtime API 反向代理
//
// 部署前配置：
//   REALTIME_APP_ID          已配置在 wrangler.jsonc 的 vars 中
//   REALTIME_APP_SECRET      需通过命令设置：wrangler secret put REALTIME_APP_SECRET
//   REALTIME_ACCESS_TOKEN    可选。设置后 /api/* 都需要访问码。

const REALTIME_BASE = 'https://rtc.live.cloudflare.com/v1/apps';

// 固定房间名：整个应用只用一个房间，客户端无法指定
const ROOM_NAME = 'hello';

// Room Durable Object 拆分在 ./room.js，这里 re-export 供 wrangler 绑定
export { Room } from './room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket 信令必须最先拦截：静态托管不认识 upgrade 请求，
    // 不能把 WebSocket 握手交给 ASSETS 处理
    if (url.pathname === '/api/room/ws') {
      // 访问控制（可选），WebSocket 无法自定义 header，token 只能走查询参数
      if (env.REALTIME_ACCESS_TOKEN) {
        const token = url.searchParams.get('token');
        if (token !== env.REALTIME_ACCESS_TOKEN) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
      }
      const id = env.ROOMS.idFromName(ROOM_NAME);
      /** @type {import('./room.js').Room} */
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // 静态资源不存在 → 走 Realtime API 代理：
    //   /api/realtime/<path> -> /v1/apps/<APP_ID>/<path>
    //   /api/realtime/sessions/new                       进房时创建 session，传初始 offer
    //   /api/realtime/sessions/{sessionId}/tracks/new    ① 发布本地 tracks（带 offer），把本地音视频告诉 SFU。② 订阅远端成员（不带 offer），SFU 返回带 offer 的响应
    //   /api/realtime/sessions/{sessionId}/renegotiate   订阅后应答 SFU 的 offer（回 answer SDP）
    if (url.pathname.startsWith('/api/realtime/')) {
      // 简单访问控制：页面本身公开，但 API 需要访问码（可选）
      if (env.REALTIME_ACCESS_TOKEN) {
        const provided = request.headers.get('x-access-token');
        if (provided !== env.REALTIME_ACCESS_TOKEN) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
      }

      const apiPath = url.pathname.replace(/^\/api\/realtime\//, '') + url.search;
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
        method: request.method,//透传 method
        headers,  //header 仅透传必要的
        body: request.body//透传 body
      });

      return new Response(response.body, {
        status: response.status,
        headers: response.headers
      });
    }

    // 既不是静态资源也不是 API → 404
    return new Response('Not Found', { status: 404 });
  }
};
