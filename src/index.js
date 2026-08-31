// Cloudflare Realtime API 反向代理
//
// 职责：
// 1. 在前端与 rtc.live.cloudflare.com 之间加一层代理
// 2. App Id 与 App Secret 由服务端保管，避免密钥暴露到浏览器
// 3. 前端请求 /realtime/<path> 会被转发为
//    https://rtc.live.cloudflare.com/v1/apps/<APP_ID>/<path> 并注入 Authorization
//
// 部署前配置：
//   REALTIME_APP_ID          已配置在 wrangler.jsonc 的 vars 中
//   REALTIME_APP_SECRET      需通过命令设置：wrangler secret put REALTIME_APP_SECRET
//   REALTIME_ACCESS_TOKEN    可选。设置后，前端调用 /realtime/* 必须携带相同的
//                            X-Access-Token 请求头，否则返回 401。
//                            不设置则不做校验（页面保持完全公开）。

const REALTIME_BASE = 'https://rtc.live.cloudflare.com/v1/apps';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
