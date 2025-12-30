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
let votes = {}; // { voterId: targetId } ("skip"일 수 있음)
let mafiaTarget = null;
let doctorTarget = null;
let policeCheck = false; // 경찰 조사 여부 (밤마다 리셋)

// 타이머 핸들
let stateTimer = null;

// --- 핵심 로직: 게임 상태 관리 ---
function changeState(newState) {
    if (stateTimer) clearTimeout(stateTimer); // 기존 타이머 제거

    gameState = newState;
    let duration = 0;

    // 상태별 초기화 및 시간 설정
    if (newState === 'night') {
        duration = 20;
        io.emit('msg', '🌙 밤이 되었습니다. 마피아, 의사, 경찰은 활동을 시작하세요.');
        mafiaTarget = null;
        doctorTarget = null;
        policeCheck = false; // 경찰 조사 기회 초기화
        stateTimer = setTimeout(() => processNight(), duration * 1000);
    } else if (newState === 'day') {
        duration = 30;
        io.emit('msg', '☀️ 낮이 되었습니다. 토론을 시작하세요.');
        stateTimer = setTimeout(() => changeState('vote'), duration * 1000);
    } else if (newState === 'vote') {
        duration = 15;
        votes = {};
        io.emit('msg', '🗳️ 투표 시간이 되었습니다. 의심되는 사람을 선택하거나 투표를 건너뛰세요.');
        stateTimer = setTimeout(() => processVote(), duration * 1000);
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
    if (stateTimer) clearTimeout(stateTimer); // 조기 종료 시 타이머 해제

    // 유효한(살아있는) 플레이어 수
    const aliveCount = Object.values(players).filter(p => p.isAlive).length;
    const voteKeys = Object.keys(votes);

    if (voteKeys.length === 0) {
        io.emit('msg', '투표 결과: 아무도 투표하지 않았습니다.');
    } else {
        // 득표 집계 (skip 포함)
        const voteCount = {};
        let skipCount = 0;

        Object.values(votes).forEach(targetId => {
            if (targetId === 'skip') {
                skipCount++;
            } else {
                voteCount[targetId] = (voteCount[targetId] || 0) + 1;
            }
        });

        // 최다 득표자 찾기
        const sorted = Object.entries(voteCount).sort((a, b) => b[1] - a[1]);

        // 1등 득표수 확인
        let maxVotes = 0;
        let deadId = null;

        if (sorted.length > 0) {
            maxVotes = sorted[0][1];
            deadId = sorted[0][0];
        }

        // 스킵이 과반수 이상이거나, 동률이거나, 스킵이 최다 득표보다 많으면 부결
        // 여기서는 "최다 득표자가 스킵보다 많아야 처형" 룰 적용
        if (sorted.length > 0 && maxVotes > skipCount) {
            // 동률 체크 (동률이면 부결 처리하는 경우도 많음, 여기선 간단히 1등 처형)
            if (players[deadId]) {
                players[deadId].isAlive = false;
                io.emit('msg', `📢 투표 결과, [${players[deadId].nickname}]님이 처형되었습니다.`);
            }
        } else {
            io.emit('msg', `📢 투표 결과, 과반수가 넘지 않거나 스킵이 많아 아무도 처형되지 않았습니다. (스킵: ${skipCount}표)`);
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
    const citizenCount = alive.length - mafiaCount;

    if (mafiaCount === 0) {
        io.emit('msg', '🎉 시민 승리! 모든 마피아가 소탕되었습니다.');
        resetGame();
    } else if (mafiaCount >= citizenCount) {
        io.emit('msg', '💀 마피아 승리! 도시가 점령되었습니다.');
        resetGame();
    }
}

function resetGame() {
    if (stateTimer) clearTimeout(stateTimer);
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

        // 역할 배정 (인원수 기반 동적 배정)
        let mafiaCount = 1;
        if (ids.length >= 6) mafiaCount = 2;
        if (ids.length >= 9) mafiaCount = 3;

        const doctorCount = 1;
        const policeCount = 1;

        ids.sort(() => Math.random() - 0.5);

        let cur = 0;
        const assign = (count, role) => {
            for (let i = 0; i < count; i++) {
                if (cur < ids.length) {
                    players[ids[cur]].role = role;
                    cur++;
                }
            }
        };

        assign(mafiaCount, '마피아');
        assign(doctorCount, '의사');
        assign(policeCount, '경찰');

        while (cur < ids.length) {
            players[ids[cur]].role = '시민';
            cur++;
        }

        ids.forEach(id => {
            io.to(id).emit('get-role', players[id].role);
        });

        changeState('night');
    });

    socket.on('chat', (msg) => {
        const user = players[socket.id];
        if (!user) return;

        if (!user.isAlive) {
            // 죽은 사람끼리 대화 (죽은 사람에게만 전송)
            Object.values(players).forEach(p => {
                if (!p.isAlive) {
                    io.to(p.id).emit('msg', `[🪦사망자] ${user.nickname}: ${msg}`);
                }
            });
            return;
        }

        // 밤에는 마피아끼리만 대화 가능 (여기선 마피아 1명이니 혼잣말)
        if (gameState === 'night') {
            if (user.role === '마피아') {
                Object.values(players).forEach(p => {
                    if (p.role === '마피아') {
                        io.to(p.id).emit('msg', `[마피아 채팅] ${user.nickname}: ${msg}`);
                    }
                });
            } else if (user.role === '의사') {
                socket.emit('msg', `[의사 독백] ${user.nickname}: ${msg}`);
            } else if (user.role === '경찰') {
                socket.emit('msg', `[경찰 독백] ${user.nickname}: ${msg}`);
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
        if (!player.isAlive) return;

        if (gameState === 'vote') {
            if (votes[socket.id]) {
                socket.emit('msg', '이미 투표하셨습니다. (변경 불가)');
                return;
            }
            votes[socket.id] = targetId; // targetId가 'skip'일 수 있음

            const targetName = (targetId === 'skip') ? '투표 건너뛰기' : players[targetId].nickname;
            socket.emit('msg', `${targetName}에 투표했습니다.`);

            // 모든 생존자가 투표했는지 확인
            const aliveCount = Object.values(players).filter(p => p.isAlive).length;
            if (Object.keys(votes).length >= aliveCount) {
                // 전원 투표 완료 시 즉시 개표
                processVote();
            }
        }
    });

    socket.on('mafia-kill', (targetId) => {
        const user = players[socket.id];
        if (gameState === 'night' && user && user.role === '마피아' && user.isAlive) {
            mafiaTarget = targetId;
            Object.values(players).forEach(p => {
                if (p.role === '마피아') {
                    io.to(p.id).emit('msg', `[마피아] ${user.nickname}님이 ${players[targetId].nickname}님을 처형 대상으로 지목했습니다.`);
                }
            });
        }
    });

    socket.on('doctor-heal', (targetId) => {
        const user = players[socket.id];
        if (gameState === 'night' && user && user.role === '의사' && user.isAlive) {
            doctorTarget = targetId;
            socket.emit('msg', `[의사] ${players[targetId].nickname}님을 치료 대상으로 선택했습니다.`);
        }
    });

    socket.on('police-investigate', (targetId) => {
        const user = players[socket.id];
        if (gameState === 'night' && user && user.role === '경찰' && user.isAlive) {
            if (policeCheck) {
                socket.emit('msg', '이미 조사를 수행했습니다.');
                return;
            }
            const target = players[targetId];
            if (target) {
                policeCheck = true;
                // 직업 확인 (마피아인지 아닌지만 알려줌)
                const result = (target.role === '마피아') ? '마피아입니다!' : '선량한 시민입니다.';
                socket.emit('msg', `[경찰 조사] ${target.nickname}님은 ${result}`);
            }
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update-players', Object.values(players));
    });
});

server.listen(process.env.PORT || 3000, () => console.log(`서버가 포트 ${process.env.PORT || 3000}에서 실행 중입니다.`));
