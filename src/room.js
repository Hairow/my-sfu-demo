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
