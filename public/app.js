// Realtime 多人视频会议前端
//
// 架构：
//   1. 每个浏览器创建自己的 Realtime session，以 sendonly 发布本地音视频
//   2. 通过 WebSocket 连接 Worker 的 Durable Object（房间），交换各自的
//      (sessionId, trackNames)
//   3. 拿到房间内其他成员的 (sessionId, trackNames) 后逐个订阅
//      （newTracks location:'remote'），SFU 只转发被订阅的流
//   4. 成员加入/离开由房间广播通知，前端动态订阅/清理

// ---- 访问控制（可选）----
// 获取顺序：URL 参数 ?token=xxx > sessionStorage 缓存 > 弹窗输入。
// Worker 未配置 REALTIME_ACCESS_TOKEN 时不校验，此段不影响使用。
const accessToken =
    new URLSearchParams(location.search).get('token') ||
    sessionStorage.getItem('accessToken') ||
    prompt('请输入访问码（没有访问码可留空）') ||
    '';
if (accessToken) {
    sessionStorage.setItem('accessToken', accessToken);
}

// ---- 房间 ----
// 房间固定在服务端写死（Worker 中 ROOM_NAME = 'hello'），客户端无法指定。
document.getElementById('room-label').textContent = '房间：hello';

class RealtimeApp {
    // basePath 指向本 Worker 的代理路径（/api 前缀），鉴权由服务端完成
    constructor(basePath = '/api/realtime') {
        this.prefixPath = basePath;
    }

    async sendRequest(url, body, method = 'POST') {
        const request = {
            method: method,
            headers: {
                'content-type': 'application/json',
                ...(accessToken
                    ? { 'x-access-token': accessToken }
                    : {})
            },
            body: JSON.stringify(body)
        };
        const response = await fetch(url, request);
        const result = await response.json();
        return result;
    }

    checkErrors(result, tracksCount = 0) {
        if (result.errorCode) {
            throw new Error(result.errorDescription);
        }
        for (let i = 0; i < tracksCount; i++) {
            if (result.tracks[i].errorCode) {
                throw new Error(
                    `tracks[${i}]: ${result.tracks[i].errorDescription}`
                );
            }
        }
    }

    // newSession sends the initial offer and creates a session
    async newSession(offerSDP) {
        const url = `${this.prefixPath}/sessions/new`;
        const body = {
            sessionDescription: {
                type: 'offer',
                sdp: offerSDP
            }
        };
        const result = await this.sendRequest(url, body);
        this.checkErrors(result);
        this.sessionId = result.sessionId;
        return result;
    }

    // newTracks shares local tracks or gets tracks
    async newTracks(trackObjects, offerSDP = null) {
        const url = `${this.prefixPath}/sessions/${this.sessionId}/tracks/new`;
        const body = {
            sessionDescription: {
                type: 'offer',
                sdp: offerSDP
            },
            tracks: trackObjects
        };
        if (!offerSDP) {
            delete body['sessionDescription'];
        }
        const result = await this.sendRequest(url, body);
        this.checkErrors(result, trackObjects.length);
        return result;
    }

    // sendAnswerSDP sends an answer SDP if a renegotiation is required
    async sendAnswerSDP(answer) {
        const url = `${this.prefixPath}/sessions/${this.sessionId}/renegotiate`;
        const body = {
            sessionDescription: {
                type: 'answer',
                sdp: answer
            }
        };
        const result = await this.sendRequest(url, body, 'PUT');
        this.checkErrors(result);
    }
}

// Use Cloudflare's STUN server
self.pc = new RTCPeerConnection({
    iceServers: [
        {
            urls: 'stun:stun.cloudflare.com:3478'
        }
    ],
    bundlePolicy: 'max-bundle'
});

// 采集本地音视频
// 采集约束：请求 720p/30fps（ideal 是软约束，摄像头尽量满足；不设时会取原生最高分辨率）
const localStream = await navigator.mediaDevices.getUserMedia({
    video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 }
    },
    audio: true
});
const localVideoElement = document.getElementById('local-video');
localVideoElement.srcObject = localStream;

// 音视频开关：通过 track.enabled 控制采集/发送。
// enabled=false 时 WebRTC 发送黑帧/静音，连接保持，无需重新协商。
const videoTrack = localStream.getVideoTracks()[0];
const audioTrack = localStream.getAudioTracks()[0];
const videoToggle = document.getElementById('video-toggle');
const audioToggle = document.getElementById('audio-toggle');
const videoOffHint = document.getElementById('video-off-hint');

function updateToggle(button, on) {
    button.textContent = on ? button.dataset.on : button.dataset.off;
    button.classList.toggle('off', !on);
}

videoToggle.addEventListener('click', () => {
    const on = !videoTrack.enabled;
    videoTrack.enabled = on;
    updateToggle(videoToggle, on);
    localVideoElement.classList.toggle('muted', !on);
    videoOffHint.hidden = on;
});

audioToggle.addEventListener('click', () => {
    const on = !audioTrack.enabled;
    audioTrack.enabled = on;
    updateToggle(audioToggle, on);
});

// 以 sendonly 发布本地音视频
// 视频 track 限制编码上限：1 Mbps / 30fps，避免默认 4K 高码率浪费带宽
self.transceivers = localStream.getTracks().map(track => {
    const isVideo = track.kind === 'video';
    return self.pc.addTransceiver(track, {
        direction: 'sendonly',
        ...(isVideo
            ? { sendEncodings: [{ maxBitrate: 1_000_000, maxFramerate: 30 }] }
            : {})
    });
});

self.app = new RealtimeApp();

// 创建 session，拿到本浏览器的 sessionId
await self.pc.setLocalDescription(await self.pc.createOffer());
const newSessionResult = await self.app.newSession(
    self.pc.localDescription.sdp
);
await self.pc.setRemoteDescription(
    new RTCSessionDescription(newSessionResult.sessionDescription)
);

// 等待 ICE 连接建立
await new Promise((resolve, reject) => {
    self.pc.addEventListener('iceconnectionstatechange', ev => {
        if (ev.target.iceConnectionState === 'connected') {
            resolve();
        }
        setTimeout(reject, 5000, 'connect timeout');
    });
});

// 发布本地 tracks：trackName 是远端订阅本浏览器的标识
const localTrackObjects = self.transceivers.map(transceiver => {
    return {
        location: 'local',
        mid: transceiver.mid,
        trackName: transceiver.sender.track.id
    };
});
await self.pc.setLocalDescription(await self.pc.createOffer());
const newLocalTracksResult = await self.app.newTracks(
    localTrackObjects,
    self.pc.localDescription.sdp
);
await self.pc.setRemoteDescription(
    new RTCSessionDescription(newLocalTracksResult.sessionDescription)
);
const myTrackNames = localTrackObjects.map(t => t.trackName);

// ---- 房间信令 ----
const members = new Map(); // sessionId -> { sessionId, trackNames, stream, videoEl, received }
const remoteGrid = document.getElementById('videos');
let ws = null;
// 订阅串行队列：多个订阅并发会互相打断 SDP 协商，必须排队逐个执行
let renegotiationQueue = Promise.resolve();

// 接收远端 track：按订阅顺序放入第一个未收满的成员
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

function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const tokenParam = accessToken
        ? `?token=${encodeURIComponent(accessToken)}`
        : '';
    return `${proto}://${location.host}/api/room/ws${tokenParam}`;
}

function connectWS() {
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', () => {
        ws.send(
            JSON.stringify({
                type: 'join',
                sessionId: self.app.sessionId,
                trackNames: myTrackNames
            })
        );
    });
    ws.addEventListener('message', async event => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'members') {
            for (const m of msg.members) {
                await subscribeMember(m);
            }
        } else if (msg.type === 'member-joined') {
            await subscribeMember(msg.member);
        } else if (msg.type === 'member-left') {
            removeMember(msg.sessionId);
        }
    });
    ws.addEventListener('close', () => {
        // 断开时清理远端并自动重连（重连后重新 join，服务器会补发成员列表）
        for (const sid of [...members.keys()]) {
            removeMember(sid);
        }
        setTimeout(connectWS, 2000);
    });
}

async function subscribeMember(member) {
    if (members.has(member.sessionId)) return;
    const entry = {
        sessionId: member.sessionId,
        trackNames: member.trackNames,
        stream: new MediaStream(),
        videoEl: null,
        received: 0
    };
    members.set(member.sessionId, entry);

    const remoteTrackObjects = member.trackNames.map(name => ({
        location: 'remote',
        sessionId: member.sessionId,
        trackName: name
    }));

    renegotiationQueue = renegotiationQueue
        .then(async () => {
            const result = await self.app.newTracks(remoteTrackObjects);
            if (
                result.requiresImmediateRenegotiation &&
                result.sessionDescription.type === 'offer'
            ) {
                await self.pc.setRemoteDescription(
                    new RTCSessionDescription(result.sessionDescription)
                );
                await self.pc.setLocalDescription(await self.pc.createAnswer());
                await self.app.sendAnswerSDP(self.pc.localDescription.sdp);
            }
        })
        .catch(err => {
            console.error('订阅失败：', err);
            removeMember(member.sessionId);
        });
    await renegotiationQueue;
}

function renderMember(entry) {
    const card = document.createElement('div');
    card.className = 'video-card';
    const name = document.createElement('h2');
    name.textContent = `成员 ${entry.sessionId.slice(0, 8)}`;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = entry.stream;
    entry.videoEl = video;
    card.append(name, video);
    remoteGrid.appendChild(card);
}

function removeMember(sessionId) {
    const entry = members.get(sessionId);
    if (!entry) return;
    if (entry.videoEl) {
        entry.videoEl.closest('.video-card')?.remove();
    }
    entry.stream.getTracks().forEach(t => t.stop());
    members.delete(sessionId);
}

window.addEventListener('beforeunload', () => ws?.close());

connectWS();
