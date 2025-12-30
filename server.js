const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 게임 데이터 관리 ---
let players = {}; // { socketId: { nickname, role, isAlive } }
let gameState = 'ready'; // ready, night, day, vote
let votes = {}; // { voterId: targetId }
let mafiaTarget = null; // 마피아가 지목한 대상 ID
let doctorTarget = null; // 의사가 치료할 대상 ID

// --- 핵심 로직: 게임 상태 관리 ---
function changeState(newState) {
    gameState = newState;
    let duration = 0;

    if (newState === 'night') {
        duration = 20;
        io.emit('msg', '🌙 밤이 되었습니다. 마피아와 의사는 활동을 시작하세요.');
        mafiaTarget = null;
        doctorTarget = null;
        setTimeout(() => processNight(), duration * 1000);
    } else if (newState === 'day') {
        duration = 30;
        io.emit('msg', '☀️ 낮이 되었습니다. 토론을 시작하세요.');
        setTimeout(() => changeState('vote'), duration * 1000);
    } else if (newState === 'vote') {
        duration = 15;
        votes = {};
        io.emit('msg', '🗳️ 투표 시간이 되었습니다. 의심되는 사람을 선택하세요.');
        setTimeout(() => processVote(), duration * 1000);
    }

    // 상태 변경 알림 (남은 시간 포함)
    io.emit('state-change', {
        state: newState,
        players: Object.values(players),
        duration: duration
    });
    console.log(`게임 상태 변경: ${newState}`);
}

// 밤 결과 처리
function processNight() {
    let victimName = "";
    let isSaved = false;

    if (mafiaTarget && players[mafiaTarget]) {
        victimName = players[mafiaTarget].nickname;

        // 의사가 살렸는지 확인
        if (mafiaTarget === doctorTarget) {
            isSaved = true;
            io.emit('msg', `🏥 의사가 [${victimName}]님을 살려냈습니다! 아무도 죽지 않았습니다.`);
        } else {
            players[mafiaTarget].isAlive = false;
            io.emit('msg', `🔫 탕! 지난 밤, [${victimName}]님이 마피아에게 살해당했습니다.`);
        }
    } else {
        io.emit('msg', '🕊️ 지난 밤은 평화로웠습니다. 아무도 죽지 않았습니다.');
    }

    checkVictory();

    // 승패 결정 안 났으면 낮으로
    if (gameState !== 'ready') {
        changeState('day');
    }
}

// 투표 결과 처리
function processVote() {
    if (Object.keys(votes).length === 0) {
        io.emit('msg', '투표 결과: 아무도 처형되지 않았습니다.');
    } else {
        // 최다 득표자 찾기
        const voteCount = {};
        Object.values(votes).forEach(targetId => {
            voteCount[targetId] = (voteCount[targetId] || 0) + 1;
        });

        const sorted = Object.entries(voteCount).sort((a, b) => b[1] - a[1]); // 득표수 내림차순
        const deadId = sorted[0][0];

        if (players[deadId]) {
            players[deadId].isAlive = false;
            io.emit('msg', `📢 투표 결과, [${players[deadId].nickname}]님이 처형되었습니다.`);
        }
    }
    checkVictory();
    if (gameState !== 'ready') {
        changeState('night');
    }
}

function checkVictory() {
    const alive = Object.values(players).filter(p => p.isAlive);
    const mafiaCount = alive.filter(p => p.role === '마피아').length;
    const citizenCount = alive.length - mafiaCount; // 의사도 시민팀

    if (mafiaCount === 0) {
        io.emit('msg', '🎉 시민 승리! 모든 마피아가 소탕되었습니다.');
        resetGame();
    } else if (mafiaCount >= citizenCount) {
        io.emit('msg', '💀 마피아 승리! 도시가 점령되었습니다.');
        resetGame();
    }
}

function resetGame() {
    gameState = 'ready';
    mafiaTarget = null;
    doctorTarget = null;
    votes = {};
    Object.keys(players).forEach(id => {
        players[id].isAlive = true;
        players[id].role = '시민';
    });
    io.emit('state-change', { state: 'ready', players: Object.values(players), duration: 0 });
}

// --- 소켓 통신 ---
io.on('connection', (socket) => {
    socket.on('join', (nickname) => {
        players[socket.id] = { id: socket.id, nickname, role: '시민', isAlive: true };
        io.emit('update-players', Object.values(players));
    });

    socket.on('game-start', () => {
        const ids = Object.keys(players);
        // 4명 미만이면 시작 불가
        if (ids.length < 4) return socket.emit('msg', '최소 4명의 플레이어가 필요합니다.');

        // 역할 배정 (마피아 1, 의사 1, 나머지 시민)
        // 셔플
        ids.sort(() => Math.random() - 0.5);

        const mafiaId = ids[0];
        const doctorId = ids[1];

        ids.forEach(id => {
            if (id === mafiaId) players[id].role = '마피아';
            else if (id === doctorId) players[id].role = '의사';
            else players[id].role = '시민';

            io.to(id).emit('get-role', players[id].role);
        });

        changeState('night');
    });

    socket.on('chat', (msg) => {
        const user = players[socket.id];
        if (!user || !user.isAlive) return;

        // 밤에는 마피아끼리만 대화 가능 (여기선 마피아 1명이니 혼잣말)
        if (gameState === 'night') {
            if (user.role === '마피아') {
                socket.emit('msg', `[마피아 독백] ${user.nickname}: ${msg}`);
            } else if (user.role === '의사') {
                socket.emit('msg', `[의사 독백] ${user.nickname}: ${msg}`);
            } else {
                socket.emit('msg', `[시스템] 밤에는 대화할 수 없습니다.`);
            }
        } else {
            // 낮에는 전체 대화
            io.emit('msg', `${user.nickname}: ${msg}`);
        }
    });

    socket.on('submit-vote', (targetId) => {
        const player = players[socket.id];
        if (!player) return;

        // 죽은 사람은 투표 금지
        if (!player.isAlive) return;

        // 투표는 한 사람당 한 번 (재투표 불가)
        if (gameState === 'vote') {
            if (votes[socket.id]) {
                socket.emit('msg', '이미 투표하셨습니다. (변경 불가)');
                return;
            }
            votes[socket.id] = targetId;
            socket.emit('msg', '투표를 완료했습니다.');
        }
    });

    socket.on('mafia-kill', (targetId) => {
        const user = players[socket.id];
        if (gameState === 'night' && user && user.role === '마피아' && user.isAlive) {
            mafiaTarget = targetId;
            socket.emit('msg', `[마피아] ${players[targetId].nickname}님을 처형 대상으로 지목했습니다.`);
        }
    });

    socket.on('doctor-heal', (targetId) => {
        const user = players[socket.id];
        if (gameState === 'night' && user && user.role === '의사' && user.isAlive) {
            doctorTarget = targetId;
            socket.emit('msg', `[의사] ${players[targetId].nickname}님을 치료 대상으로 선택했습니다.`);
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update-players', Object.values(players));
    });
});

server.listen(process.env.PORT || 3000, () => console.log(`서버가 포트 ${process.env.PORT || 3000}에서 실행 중입니다.`));
