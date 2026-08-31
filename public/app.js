// Realtime Echo Demo 前端逻辑（原内联在 index.html 中的 <script type="module">）
// This is a class the defines the Realtime API interactions.
// It's not an SDK but a example of how Realtime API can be used.

// App Id / App Secret 不再放在浏览器里，由 Worker（src/index.js）代理
// 并通过环境变量保管，浏览器只请求同源路径 /realtime/*。

// 简单访问控制：页面公开可看，但调用 /realtime/* 需要访问码。
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

class RealtimeApp {
    // basePath 指向本 Worker 的代理路径，鉴权由服务端完成
    constructor(basePath = '/realtime') {
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

// In order to successfully establish a peer connection, we need at least one track to publish.
// In this case, we create two: video & audio
const localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
});

// Get the local video element in the HTML and set the source to show local stream
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

// Add sendonly trancievers to the PeerConnection
self.transceivers = localStream.getTracks().map(track =>
    self.pc.addTransceiver(track, {
        direction: 'sendonly'
    })
);

// Create a instance of RealtimeApp (defined below). Please note that this is not an official SDK but just a demo showing the HTML API.
self.app = new RealtimeApp();

// Send the first offer and create a session. The returned sessionId is required to retrieve any track published by this peer
await self.pc.setLocalDescription(await self.pc.createOffer());
const newSessionResult = await self.app.newSession(
    self.pc.localDescription.sdp
);
await self.pc.setRemoteDescription(
    new RTCSessionDescription(newSessionResult.sessionDescription)
);

// Make the peer connection was established
await new Promise((resolve, reject) => {
    self.pc.addEventListener('iceconnectionstatechange', ev => {
        if (ev.target.iceConnectionState === 'connected') {
            resolve();
        }
        setTimeout(reject, 5000, 'connect timeout');
    });
});

// We associate a trackName to a transceiver identified by a mid (media ID). This way the track
// is remotely reachable by the tuple (sessionId, trackName)
let trackObjects = self.transceivers.map(transceiver => {
    return {
        location: 'local',
        mid: transceiver.mid,
        trackName: transceiver.sender.track.id
    };
});

// Get local description, create a new track, set remote description with the response
await self.pc.setLocalDescription(await self.pc.createOffer());
const newLocalTracksResult = await self.app.newTracks(
    trackObjects,
    self.pc.localDescription.sdp
);
await self.pc.setRemoteDescription(
    new RTCSessionDescription(newLocalTracksResult.sessionDescription)
);

// At this point in code, we are successfully sending local stream to Cloudflare Realtime.
// Now, we will pull the same stream from Cloudflare Realtime.

// Update trackObjects to reference the tracks as "remote"
trackObjects = trackObjects.map(trackObject => {
    return {
        location: 'remote',
        sessionId: self.app.sessionId,
        trackName: trackObject.trackName
    };
});

// Prepare to receive the tracks before asking for them
const remoteTracksPromise = new Promise(resolve => {
    let tracks = [];
    self.pc.ontrack = event => {
        tracks.push(event.track);
        console.debug(`Got track mid=${event.track.mid}`);
        if (tracks.length >= 2) {
            // remote video & audio are ready
            resolve(tracks);
        }
    };
});

// Realtime API request to ask for the tracks
const newRemoteTracksResult = await self.app.newTracks(trackObjects);
if (newRemoteTracksResult.requiresImmediateRenegotiation) {
    switch (newRemoteTracksResult.sessionDescription.type) {
        case 'offer':
            // We let Cloudflare know we're ready to receive the tracks
            await self.pc.setRemoteDescription(
                new RTCSessionDescription(
                    newRemoteTracksResult.sessionDescription
                )
            );
            await self.pc.setLocalDescription(await self.pc.createAnswer());
            await self.app.sendAnswerSDP(self.pc.localDescription.sdp);
            break;
        case 'answer':
            throw new Error('An offer SDP was expected');
    }
}

// Once started receiving the tracks (video & audio) send the data to the video tag
const remoteTracks = await remoteTracksPromise;
const remoteVideoElement = document.getElementById('remote-video');
const remoteStream = new MediaStream();
remoteStream.addTrack(remoteTracks[0]);
remoteStream.addTrack(remoteTracks[1]);
remoteVideoElement.srcObject = remoteStream;
