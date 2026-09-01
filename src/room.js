// 房间 Durable Object（WebSocket Hibernation 模式）：
// 一个房间对应一个实例，内存中维护成员列表，通过 WebSocket 广播成员加入/离开。
// 成员信息只需要 (sessionId, trackNames)，真正媒体流转发由 Cloudflare Realtime SFU 完成。
//
// Hibernation 模式（this.ctx.acceptWebSocket）：
// - 连接由平台托管，DO 休眠/重启（evict）后连接不丢，唤醒时用 ctx.getWebSockets() 恢复
// - 每个连接的成员数据用 serializeAttachment() 附加，随连接由平台自动持久化，
//   唤醒后 deserializeAttachment() 取回，实现成员列表的完整恢复
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.members = new Map(); // server WebSocket -> { sessionId, trackNames } | null

    // DO 被唤醒（从休眠/重启恢复）时，重建 连接 -> 成员 的映射
    for (const socket of ctx.getWebSockets()) {
      this.members.set(socket, socket.deserializeAttachment() ?? null);
    }
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation 模式：连接交给平台托管（隐含 accept）。
    // 之后不能再 addEventListener，事件改由类方法 webSocketMessage / webSocketClose 接收。
    this.ctx.acceptWebSocket(server);
    this.members.set(server, null);
    return new Response(null, { status: 101, webSocket: client });
  }

  // 消息事件（Hibernation 模式必须定义为类方法）
  async webSocketMessage(server, message) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.type !== 'join' || !msg.sessionId) return;

    const member = { sessionId: msg.sessionId, trackNames: msg.trackNames || [] };
    this.members.set(server, member);
    // 成员数据附加到连接上，DO 休眠/重启时由平台持久化
    server.serializeAttachment(member);

    // 广播新成员给房间内其他人
    for (const [conn, m] of this.members) {
      if (conn !== server && m) {
        conn.send(JSON.stringify({ type: 'member-joined', member }));
      }
    }
    // 给新成员返回当前成员列表（不含自己）。
    // DO 重启恢复后，这里会包含由 getWebSockets() 恢复的老成员。
    const others = [...this.members.values()].filter(
      (m) => m && m.sessionId !== member.sessionId
    );
    server.send(JSON.stringify({ type: 'members', members: others }));
  }

  // 连接关闭事件
  async webSocketClose(server, code, reason, wasClean) {
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
  }
}
