// 1. 주요 클래스 가져오기
const { Client, Events, GatewayIntentBits, EmbedBuilder, ChannelType, Partials, PermissionFlagsBits, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { token } = require('../config.json');

// 2. 클라이언트 객체 생성
const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions, // ← 추가
], partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User] }); // ← Reaction, User 추가

// 소유자 디스코드 ID (2명)
const OWNER_IDS = [
    '1550921230008324097',    // 소유자 1
    '1558550236643856407', // 소유자 2 (숫자 ID로 바꿔주세요)
];
const isOwnerId = id => OWNER_IDS.includes(id);

// 소유자만 쓸 수 있는 명령어 (허용된 사람도 못 씀)
const OWNER_ONLY = ['!허용', '!허용해제', '!허용목록', '!디엠', '!관리', '!서버나가기', '!서버목록', '!정복메세지허용', '!정복메세지허용해제', '!정복메세지허용목록'];

// ---------- 허용 사용자 저장/불러오기 ----------
const ALLOWED_FILE = path.join(__dirname, 'allowed.json');
let allowedIds = new Set();

function loadAllowed() {
    try {
        if (fs.existsSync(ALLOWED_FILE)) {
            allowedIds = new Set(JSON.parse(fs.readFileSync(ALLOWED_FILE, 'utf8')));
        }
    } catch (err) {
        console.error('allowed.json 읽기 실패:', err);
    }
}

function saveAllowed() {
    fs.writeFileSync(ALLOWED_FILE, JSON.stringify([...allowedIds], null, 2), 'utf8');
}

/* ===== 신고·사건 관리 데이터 ===== */
const INCIDENT_FILE = path.join(__dirname, 'incident-response.json');

const INCIDENT_STATUSES = ['접수', '검토중', '기관 전달', '종결'];

let incidentData = {
    channels: {},
    cases: [],
};

function loadIncidentData() {
    try {
        if (fs.existsSync(INCIDENT_FILE)) {
            const saved = JSON.parse(fs.readFileSync(INCIDENT_FILE, 'utf8'));
            incidentData = {
                channels: saved.channels || {},
                cases: Array.isArray(saved.cases) ? saved.cases : [],
            };
        }
    } catch (err) {
        console.error('사건 데이터 읽기 실패:', err);
    }
}

function saveIncidentData() {
    try {
        fs.writeFileSync(
            INCIDENT_FILE,
            JSON.stringify(incidentData, null, 2),
            'utf8'
        );
    } catch (err) {
        console.error('사건 데이터 저장 실패:', err);
        throw err;
    }
}

// 시작 시 저장된 사건 기록 불러오기
loadIncidentData();

// 서버 관리자 또는 봇 소유자 확인
function isIncidentAdmin(interaction) {
    return Boolean(
        interaction.guild &&
        (
            interaction.memberPermissions?.has(
                PermissionFlagsBits.Administrator
            ) ||
            isOwnerId(interaction.user.id)
        )
    );
}

// 서버별 신고 채널 가져오기
async function getIncidentChannel(guild) {
    const channelId = incidentData.channels[guild.id];
    if (!channelId) return null;

    try {
        const channel = await guild.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() ||
            typeof channel.send !== 'function') {
            return null;
        }
        return channel;
    } catch {
        return null;
    }
}

// 사건 번호 생성
function nextIncidentId() {
    return incidentData.cases.reduce(
        (max, item) => Math.max(max, item.id || 0),
        0
    ) + 1;
}

// 신고·경보 사건 저장 (anonymous면 신고자 ID를 저장하지 않음)
function createIncident({ guildId, reporterId, type, description, evidenceUrl = null, anonymous = false }) {
    const record = {
        id: nextIncidentId(),
        guildId,
        reporterId: anonymous ? null : reporterId,
        anonymous,
        type,
        description,
        evidenceUrl,
        status: '접수',
        createdAt: new Date().toISOString(),
    };

    incidentData.cases.push(record);
    saveIncidentData();
    return record;
}

// 사건 기록을 Embed로 만들기
function incidentEmbed(record) {
    const embed = new EmbedBuilder()
        .setColor(record.type === '긴급 경보' ? 0xe74c3c : 0x3498db)
        .setTitle(`사건 #${record.id} · ${record.type}`)
        .setDescription(record.description.slice(0, 4000))
        .addFields(
            { name: '상태', value: record.status, inline: true },
            {
                name: '접수 시각',
                value: new Date(record.createdAt).toLocaleString('ko-KR', {
                    timeZone: 'Asia/Seoul',
                }),
                inline: true,
            },
                        {
                name: '신고자',
                value: record.anonymous || !record.reporterId
                    ? '🕶️ 익명'
                    : `<@${record.reporterId}>\n\`${record.reporterId}\``,
                inline: true,
            }
        );

    if (record.evidenceUrl) {
        embed.addFields({
            name: '증거 링크',
            value: record.evidenceUrl,
        });
    }

    return embed;
}

// "@멘션" 또는 숫자 ID 문자열에서 ID만 뽑기
function parseId(text) {
    const id = (text || '').replace(/[<@!>]/g, '');
    return /^\d{17,20}$/.test(id) ? id : null;
}

loadAllowed();


// ---------- 가사 저장/불러오기 ----------
const LYRICS_FILE = path.join(__dirname, 'lyrics.json');
let lyricsDB = {}; // 정규화된 제목 -> { title, lyrics, userId, createdAt }

function loadLyrics() {
    try {
        if (fs.existsSync(LYRICS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(LYRICS_FILE, 'utf8'));
            const cleaned = {};
            for (const v of Object.values(raw)) {
                const key = normTitle(v.title);
                if (!key) continue;
                if (!cleaned[key] || (v.createdAt || 0) >= (cleaned[key].createdAt || 0)) cleaned[key] = v;
            }
            lyricsDB = cleaned;
            if (Object.keys(cleaned).length !== Object.keys(raw).length) saveLyrics();
        }
    } catch (err) {
        console.error('lyrics.json 읽기 실패:', err);
    }
}

function saveLyrics() {
    fs.writeFileSync(LYRICS_FILE, JSON.stringify(lyricsDB, null, 2), 'utf8');
}

// 띄어쓰기/대소문자 무시용 키
const normTitle = t => (t || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// 등록된 가사 찾기 (정확히 일치 -> 부분 일치)
function findLyrics(query) {
    const q = normTitle(query);
    if (!q) return null;
    if (lyricsDB[q]) return lyricsDB[q];
    for (const [key, v] of Object.entries(lyricsDB)) {
        if (q.includes(key) || (q.length >= 2 && key.includes(q))) return v;
    }
    return null;
}

// "!가사등록" 뒤의 문자열 -> { title, lyrics }
//  1) "노래 제목" 가사...   2) 첫 줄=제목, 나머지=가사   3) 첫 단어=제목, 나머지=가사
function parseLyricsInput(text) {
    const q = text.match(/^["“”'‘’]([^"“”'‘’]+)["“”'‘’]\s*([\s\S]+)$/);
    if (q) return { title: q[1].trim(), lyrics: q[2].trim() };
    const nl = text.indexOf('\n');
    if (nl !== -1) return { title: text.slice(0, nl).trim(), lyrics: text.slice(nl + 1).trim() };
    const sp = text.search(/\s/);
    if (sp === -1) return null;
    return { title: text.slice(0, sp), lyrics: text.slice(sp).trim() };
}

loadLyrics();

// ---------- 타자 게임 ----------
const TYPING_FILE = path.join(__dirname, 'typing.json');
// 주간 기록: { weekStart, records: { userId: { best, wins } }, lastWeek: [{ id, best }] }
let typingData = { weekStart: 0, records: {}, lastWeek: [] };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const KST_OFFSET = 9 * 60 * 60 * 1000;

// 이번 주 월요일 00:00 (한국 시간) 의 timestamp
function getWeekStart(now = Date.now()) {
    const t = new Date(now + KST_OFFSET);
    const sinceMonday = (t.getUTCDay() + 6) % 7; // 월=0 ... 일=6
    return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - sinceMonday) - KST_OFFSET;
}
const typingGames = new Map(); // channelId -> { started, text, startAt, timeout }
const TYPING_TIMEOUT_MS = 30 * 1000;
const TYPING_REWARD = 50; // 타자 게임 우승 보상 포인트

const TYPING_SENTENCES = [
    '오늘도 좋은 하루 보내세요',
    '느리더라도 꾸준히 걷는 사람이 결국 멀리 간다',
    '가는 말이 고우면 오는 말이 곱다',
    '천 리 길도 한 걸음부터 시작된다',
    '아침 햇살이 창문 너머로 따뜻하게 들어왔다',
    '비가 그친 뒤 하늘에 선명한 무지개가 떴다',
    '작은 습관 하나가 내일의 나를 바꾼다',
    '시작이 반이라는 말은 정말 맞는 말이다',
    '친구와 함께 먹는 라면은 언제나 맛있다',
    '주말에는 늦잠을 자고 느긋하게 커피를 마시고 싶다',
    '빠르고 정확하게 타자를 치는 연습을 해보자',
    '삶은 선택의 연속이다',
    '책을 읽는 것은 마음의 양식을 쌓는 일이다',
    '자연 속에서 걷는 것은 스트레스를 해소하는 좋은 방법이다',
    '하늘을 바라보며 깊게 숨을 쉬면 마음이 편안해진다',
    '오늘의 날씨는 맑고 화창하다',
    '작은 친절이 큰 행복을 만든다',
    '노력은 배신하지 않는다',
    '웃음은 최고의 약이다',
    '인생은 한 번뿐이다. 후회 없는 선택을 하자',
    '행복은 멀리 있는 것이 아니라 가까이에 있다',
    '성공은 준비된 사람에게 찾아온다',
];

function loadTyping() {
    try {
        if (fs.existsSync(TYPING_FILE)) {
            const raw = JSON.parse(fs.readFileSync(TYPING_FILE, 'utf8'));
            if (raw && raw.records) {
                typingData = { weekStart: raw.weekStart || 0, records: raw.records, lastWeek: raw.lastWeek || [] };
            } else if (raw) {
                // 예전 형식(주간 구분 없음)이면 이번 주 기록으로 이어받기
                typingData = { weekStart: getWeekStart(), records: raw, lastWeek: [] };
            }
        }
    } catch (err) {
        console.error('typing.json 읽기 실패:', err);
    }
}

function saveTyping() {
    fs.writeFileSync(TYPING_FILE, JSON.stringify(typingData, null, 2), 'utf8');
}

// 한글은 자모 단위로 풀어서 "타수"로 계산 (공백 포함)
const countStrokes = text => text.normalize('NFD').length;

// 복사-붙여넣기 방지용: 글자 사이에 보이지 않는 문자를 끼워 넣음
const ZWSP = '\u200b';
const antiCopy = text => [...text].join(ZWSP);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 주가 바뀌었으면 지난주 TOP 3를 저장하고 기록 초기화
function ensureTypingWeek() {
    const current = getWeekStart();
    if (typingData.weekStart === current) return;

    if (typingData.weekStart && Object.keys(typingData.records).length > 0) {
        typingData.lastWeek = Object.entries(typingData.records)
            .sort((a, b) => b[1].best - a[1].best)
            .slice(0, 3)
            .map(([id, r]) => ({ id, best: r.best }));
    } else if (typingData.weekStart) {
        typingData.lastWeek = [];
    }
    typingData.records = {};
    typingData.weekStart = current;
    saveTyping();
}

loadTyping();
ensureTypingWeek();

// ---------- 채팅 순위 ----------
const CHAT_FILE = path.join(__dirname, 'chat.json');
// { weekStart, guilds: { 서버ID: { 유저ID: { total, week } } } }
let chatData = { weekStart: 0, guilds: {} };
let chatDirty = false;

function loadChat() {
    try {
        if (fs.existsSync(CHAT_FILE)) {
            const raw = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
            chatData = { weekStart: raw.weekStart || 0, guilds: raw.guilds || {} };
        }
    } catch (err) {
        console.error('chat.json 읽기 실패:', err);
    }
}

function saveChat() {
    try {
        fs.writeFileSync(CHAT_FILE, JSON.stringify(chatData), 'utf8');
        chatDirty = false;
    } catch (err) {
        console.error('chat.json 저장 실패:', err);
    }
}

// 주가 바뀌었으면 주간 카운트만 0으로 (전체 카운트는 유지)
function ensureChatWeek() {
    const current = getWeekStart();
    if (chatData.weekStart === current) return;
    for (const users of Object.values(chatData.guilds)) {
        for (const u of Object.values(users)) u.week = 0;
    }
    chatData.weekStart = current;
    chatDirty = true;
}

function countChat(guildId, userId) {
    ensureChatWeek();
    const users = chatData.guilds[guildId] || (chatData.guilds[guildId] = {});
    const u = users[userId] || (users[userId] = { total: 0, week: 0 });
    u.total += 1;
    u.week += 1;
    chatDirty = true;
}

loadChat();
ensureChatWeek();

// ---------- 포인트 ----------
const POINTS_FILE = path.join(__dirname, 'points.json');
// { guilds: { 서버ID: { 유저ID: { points, chat, voice } } } }
//  points = 현재 보유 포인트(추가/제거 반영), chat/voice = 활동으로 번 누적 포인트
let pointsData = { guilds: {} };
let pointsDirty = false;

const POINT_CONFIG = {
    CHAT_POINT: 1,                  // 채팅 1회당 포인트
    CHAT_COOLDOWN_MS: 10 * 1000,    // 채팅 포인트 쿨타임 (도배 방지)
    VOICE_POINT: 2,                 // 통화방 1분당 포인트
    VOICE_INTERVAL_MS: 60 * 1000,   // 통화 포인트 지급 주기
    MAX_MANUAL: 1_000_000_000,      // !포인트 추가/제거 최대값
};
const chatCooldown = new Map(); // "서버ID-유저ID" -> 마지막 지급 시각

function loadPoints() {
    try {
        if (fs.existsSync(POINTS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8'));
            pointsData = { guilds: raw.guilds || {} };
        }
    } catch (err) {
        console.error('points.json 읽기 실패:', err);
    }
}

function savePoints() {
    try {
        fs.writeFileSync(POINTS_FILE, JSON.stringify(pointsData), 'utf8');
        pointsDirty = false;
    } catch (err) {
        console.error('points.json 저장 실패:', err);
    }
}

function getPointUser(guildId, userId) {
    const users = pointsData.guilds[guildId] || (pointsData.guilds[guildId] = {});
    return users[userId] || (users[userId] = { points: 0, chat: 0, voice: 0 });
}

// source: 'chat' | 'voice' | 'manual'
function addPoints(guildId, userId, amount, source = 'manual') {
    const u = getPointUser(guildId, userId);
    u.points = Math.max(0, u.points + amount);
    if (source === 'chat') u.chat += amount;
    if (source === 'voice') u.voice += amount;
    pointsDirty = true;
}

function givePointForChat(guildId, userId) {
    const key = `${guildId}-${userId}`;
    const now = Date.now();
    if (now - (chatCooldown.get(key) || 0) < POINT_CONFIG.CHAT_COOLDOWN_MS) return;
    chatCooldown.set(key, now);
    addPoints(guildId, userId, POINT_CONFIG.CHAT_POINT, 'chat');
}

// 통화방 포인트: 주기적으로 모든 서버의 통화방을 훑어서 지급
function giveVoicePoints() {
    for (const guild of client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
            if (channel.type !== ChannelType.GuildVoice) continue;
            if (channel.id === guild.afkChannelId) continue; // 잠수방 제외

            const humans = channel.members.filter(m => !m.user.bot);
            if (humans.size < 2) continue; // 혼자 있으면 지급 안 함

            for (const m of humans.values()) {
                if (m.voice.selfDeaf || m.voice.serverDeaf) continue; // 헤드셋 끈 사람 제외
                addPoints(guild.id, m.id, POINT_CONFIG.VOICE_POINT, 'voice');
            }
        }
    }
}

loadPoints();
setInterval(giveVoicePoints, POINT_CONFIG.VOICE_INTERVAL_MS);
setInterval(() => { if (pointsDirty) savePoints(); }, 30 * 1000);

// 메시지마다 저장하면 부담되니 30초마다 모아서 저장 + 종료 시 저장
setInterval(() => { if (chatDirty) saveChat(); }, 30 * 1000);
let extras = null; // 추가 기능 모듈 (맨 아래에서 대입)
function flushAndExit() {
    if (chatDirty) saveChat();
    if (pointsDirty) savePoints();
    if (extras) extras.flush();
    process.exit(0);
}
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);

// ---------- 타이머 ----------
const timers = new Map(); // 타이머번호 -> { userId, channelId, endAt, label, handle }
let timerSeq = 1;
const MAX_TIMER_MS = 24 * 60 * 60 * 1000; // 최대 24시간

// "10분", "1시간30분", "30초", "5m", "10"(숫자만 쓰면 분) -> { ms, label }
function parseDuration(text) {
    const m = text.match(/^((?:\d+\s*(?:시간|분|초|h|m|s)\s*)+)(.*)$/i);
    if (m) {
        let ms = 0;
        for (const [, n, unit] of m[1].matchAll(/(\d+)\s*(시간|분|초|h|m|s)/gi)) {
            const v = parseInt(n, 10);
            const u = unit.toLowerCase();
            if (u === '시간' || u === 'h') ms += v * 3600000;
            else if (u === '분' || u === 'm') ms += v * 60000;
            else ms += v * 1000;
        }
        return { ms, label: m[2].trim() };
    }
    const p = text.match(/^(\d+)\s*(.*)$/);
    if (p) return { ms: parseInt(p[1], 10) * 60000, label: p[2].trim() };
    return null;
}

// 밀리초 -> "1시간 30분 5초"
function formatDuration(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const parts = [];
    if (h) parts.push(`${h}시간`);
    if (m) parts.push(`${m}분`);
    if (s || parts.length === 0) parts.push(`${s}초`);
    return parts.join(' ');
}

// 타이머 길이에 따라 메시지 갱신 주기를 다르게 (너무 자주 수정하면 레이트리밋에 걸림)
function pickUpdateInterval(ms) {
    if (ms <= 60 * 1000) return 1000;          // 1분 이하: 1초마다
    if (ms <= 10 * 60 * 1000) return 5000;     // 10분 이하: 5초마다
    if (ms <= 60 * 60 * 1000) return 15000;    // 1시간 이하: 15초마다
    return 60000;                               // 그 이상: 1분마다
}

// ---------- 날씨 ----------
const WEATHER_CODES = {
    0: ['맑음', '☀️'], 1: ['대체로 맑음', '🌤️'], 2: ['구름 조금', '⛅'], 3: ['흐림', '☁️'],
    45: ['안개', '🌫️'], 48: ['짙은 안개', '🌫️'],
    51: ['약한 이슬비', '🌦️'], 53: ['이슬비', '🌦️'], 55: ['강한 이슬비', '🌦️'],
    56: ['약한 어는 이슬비', '🌧️'], 57: ['강한 어는 이슬비', '🌧️'],
    61: ['약한 비', '🌧️'], 63: ['비', '🌧️'], 65: ['강한 비', '🌧️'],
    66: ['약한 어는 비', '🌧️'], 67: ['강한 어는 비', '🌧️'],
    71: ['약한 눈', '🌨️'], 73: ['눈', '🌨️'], 75: ['강한 눈', '❄️'], 77: ['싸락눈', '🌨️'],
    80: ['약한 소나기', '🌦️'], 81: ['소나기', '🌦️'], 82: ['강한 소나기', '⛈️'],
    85: ['약한 눈소나기', '🌨️'], 86: ['강한 눈소나기', '❄️'],
    95: ['뇌우', '⛈️'], 96: ['우박 동반 뇌우', '⛈️'], 99: ['강한 우박 동반 뇌우', '⛈️'],
};

// 한국 환경부 기준 등급
function gradePM25(v) {
    if (v == null) return { text: '정보 없음', emoji: '⚪', color: 0x99aab5 };
    if (v <= 15) return { text: '좋음', emoji: '🔵', color: 0x3498db };
    if (v <= 35) return { text: '보통', emoji: '🟢', color: 0x2ecc71 };
    if (v <= 75) return { text: '나쁨', emoji: '🟠', color: 0xe67e22 };
    return { text: '매우 나쁨', emoji: '🔴', color: 0xe74c3c };
}

function gradePM10(v) {
    if (v == null) return { text: '정보 없음', emoji: '⚪', color: 0x99aab5 };
    if (v <= 30) return { text: '좋음', emoji: '🔵', color: 0x3498db };
    if (v <= 80) return { text: '보통', emoji: '🟢', color: 0x2ecc71 };
    if (v <= 150) return { text: '나쁨', emoji: '🟠', color: 0xe67e22 };
    return { text: '매우 나쁨', emoji: '🔴', color: 0xe74c3c };
}

// 풍향(도) -> 방위
function windDir(deg) {
    const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    return dirs[Math.round(deg / 45) % 8] + '풍';
}

async function fetchJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// 지역명 -> 좌표 (한국 결과 우선)
async function geocode(name) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=ko&format=json`;
    const data = await fetchJson(url);
    const results = data.results || [];
    return results.find(r => r.country_code === 'KR') || results[0] || null;
}

// ---------- 노래 검색 (iTunes Search API, 키 불필요) ----------
async function searchSong(query) {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=1&country=KR`;
    const data = await fetchJson(url);
    return data.results?.[0] || null;
}

// 3. 봇 준비 완료
client.once(Events.ClientReady, readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

// 4. 메시지 이벤트 처리 (하나로 통합)
async function handleMainMessage(message) {
    if (message.author.bot) return;

    const content = message.content.trim();

    // 💬 채팅 수 집계 + 포인트 (서버 채팅만, 봇 명령어는 제외)
    if (message.guild && !content.startsWith('!')) {
        countChat(message.guild.id, message.author.id);
        givePointForChat(message.guild.id, message.author.id);
    }

    // ⌨️ 진행 중인 타자 게임 정답 확인 (누구나 참여 가능)
    const game = typingGames.get(message.channel.id);
    if (game && game.started && !content.startsWith('!') && content === game.text) {
        clearTimeout(game.timeout);
        typingGames.delete(message.channel.id);

        const sec = Math.max((message.createdTimestamp - game.startAt) / 1000, 0.1);
        const strokes = countStrokes(game.text);
        const spm = Math.round((strokes / sec) * 60); // 분당 타수

        ensureTypingWeek();
        const rec = typingData.records[message.author.id] || { best: 0, wins: 0 };
        const isNewBest = spm > rec.best;
        if (isNewBest) rec.best = spm;
        rec.wins += 1;
        typingData.records[message.author.id] = rec;
        saveTyping();
        if (message.guild) addPoints(message.guild.id, message.author.id, TYPING_REWARD, 'manual'); // 타자 우승 보상

        const embed = new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('🏆 타자 게임 우승!')
            .setDescription(`<@${message.author.id}> 님이 가장 먼저 정확히 입력했어요!`)
            .addFields(
                { name: '⏱️ 걸린 시간', value: `${sec.toFixed(2)}초`, inline: true },
                { name: '⌨️ 속도', value: `${spm}타/분`, inline: true },
                { name: '🥇 이번 주 최고 기록', value: `${rec.best}타/분${isNewBest ? ' 🎉 신기록!' : ''}`, inline: true },
            )
            .setFooter({ text: `이번 주 우승 ${rec.wins}회 · !타자순위로 순위 확인` });
        if (message.guild) embed.addFields({ name: '💰 보상', value: `+${TYPING_REWARD}P`, inline: true });
        return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id] } });
    }

    if (!content.startsWith('!')) return;

    const isOwner = isOwnerId(message.author.id);
    const isAllowed = isOwner || allowedIds.has(message.author.id);

    // ★ 소유자도, 허용된 사람도 아니면 무시
    if (!isAllowed) return;

    // ★ 소유자 전용 명령어는 허용된 사람도 차단
    const cmd = content.split(/\s+/)[0];
    if (OWNER_ONLY.includes(cmd) && !isOwner) {
        return message.reply('이 명령어는 봇 소유자만 사용할 수 있습니다.');
    }

    // !ping -> 봇 응답 속도 + 디스코드 연결 핑
    if (content === '!ping') {
        const sent = await message.reply('🏓 측정 중...');
        const msgLatency = sent.createdTimestamp - message.createdTimestamp;
        const wsPing = client.ws.ping;

        return sent.edit(
            `🏓 **Pong!**\n` +
            `📨 메시지 응답 속도: \`${msgLatency}ms\`\n` +
            `🌐 디스코드 연결 핑: \`${wsPing >= 0 ? wsPing + 'ms' : '측정 중'}\``
        );
    }


        if (content === '!목록') {
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('📋 명령어 목록')
            .setDescription('`[ ]`는 직접 입력하는 값이에요. 자세한 설명은 **`!설명서`** 를 확인하세요.')
            .addFields(
                { name: '🎮 기본', value: '`!ping` `!목록` `!설명서`\n`!올멘 [메세지]` `!환영 [@멘션]`' },
                { name: '💰 포인트', value: '`!출석` `!잔액 [@멘션]` `!포인트 [@멘션]` `!포인트순위 [채팅/통화]`\n`!출금 [@멘션] [포인트]` `!송금 [후원/송금] [액수] [메세지]`\n`!오늘의운세 [@멘션]`' },
                { name: '🎰 배팅 게임', value: '`!동전 [앞/뒤] [포인트]` `!슬롯 [포인트]`\n`!가위바위보 [가위/바위/보] [포인트]` (`!가바보`)' },
                { name: '🕹️ 게임', value: '`!타자` `!타자순위`\n`!끝말잇기` `!끝말잇기 봇` `!끝말잇기종료`' },
                { name: '🏅 레벨', value: '`!레벨 [@멘션]` `!레벨순위`' },
                { name: '🎂 생일', value: '`!생일등록 [닉네임] [월] [일]` `!생일삭제 [닉네임]` `!생일목록 [월]`' },
                { name: '🔧 편의', value: '`!아이디 [@멘션]` `!날씨 [지역명]` `!채팅순위` `!서버구성`\n`!가사 [제목]` `!가사등록 [제목] [가사]` `!가사삭제 [제목]` `!가사목록`' },
                { name: '⏱️ 타이머', value: '`!타이머 [시간] [메모]` `!타이머목록` `!타이머취소 [번호]`' },
                { name: '🛡️ 서버 관리', value: '`!타임아웃 [@멘션] [분]` `!타임아웃해제 [@멘션]`\n`!추방 [@멘션] [사유]` `!청소 [개수] [@멘션]`' },
                {
                    name: '⚙️ 서버 설정 (서버 관리 권한)',
                    value:
                        '`!로그채널` `!환영채널` `!환영메시지` `!환영테스트`\n' +
                        '`!생일채널` `!레벨채널` `!레벨닉네임`\n' +
                        '`!입금채널` `!출금채널` `!통화입장` `!통화퇴장`\n' +
                        '`!인증역할` `!인증채널` `!인증채널해제`\n' +
                        '(채널 설정은 `[#채널]`, 끄려면 뒤에 `해제`)',
                },
                {
                    name: '🔐 소유자 전용',
                    value:
                        '`!허용` `!허용해제` `!허용목록`\n' +
                        '`!포인트 추가/제거 [@멘션] [수]` `!포인트수거 [@멘션] [포인트/반/전부]`\n' +
                        '`!디엠 [사용자ID]` `!관리` `!서버나가기 [서버ID]` `!서버목록 [페이지]`',
                },
                {
                    name: '⚡ 슬래시 (/) 명령어',
                    value:
                        '`/ping` `/타이머` `/타이머목록` `/타이머취소`\n' +
                        '`/동전` `/슬롯` `/가위바위보` `/오늘의운세` `/끝말잇기` `/후원`\n' +
                        '`/서버인원` `/서버구성` `/초대링크` `/단어검색` `/환율` `/코인` `/주식` `/티켓설정`',
                },
                {
                    name: '🛡️ 돌격대 | 조직 대응',
                    value: '`/신고` `/신고채널설정` `/사건기록` `/경보` `/대응현황`\n자세한 절차는 `!설명서` 3번째 페이지를 확인하세요.',
                },
            )
            .setFooter({ text: '명령어는 ! 로 시작해요 · 자세한 설명은 !설명서' });
        return message.reply({ embeds: [embed] });
    }

    // !설명서 -> 기능별 자세한 사용법 (임베드 글자 수 제한 때문에 2개로 나눠서 보냄)
        if (content === '!설명서') {
        const rate = Math.round(CONFIG.TRANSFER_FEE_RATE * 1000) / 10;
        const bdayTime = CONFIG.BIRTHDAY_HOUR === 0 ? '밤 12시(자정)' : `낮 ${CONFIG.BIRTHDAY_HOUR}시`;

        const embed1 = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('📖 사용 설명서 (1/3) - 기본 · 포인트 · 게임')
            .setDescription(
                '`[ ]`는 직접 입력하는 값, `@멘션`은 멘션 또는 유저 ID예요.\n' +
                (CONFIG.EVERYONE
                    ? '💡 **출석·잔액·송금·출금·운세·배팅·끝말잇기·생일·레벨**은 누구나, 나머지는 소유자와 허용된 사람만 쓸 수 있어요.'
                    : '💡 소유자와 허용된 사람만 사용할 수 있어요.')
            )
            .addFields(
                {
                    name: '🎮 기본',
                    value:
                        '`!ping` 반응 속도 확인\n' +
                        '`!올멘 [메세지]` @everyone과 함께 전송 (**서버 관리자** 필요)\n' +
                        '`!환영 @멘션` 환영 인사 보내기',
                },
                {
                    name: '💰 포인트 모으기',
                    value:
                        `• 채팅 ${POINT_CONFIG.CHAT_POINT}P (${POINT_CONFIG.CHAT_COOLDOWN_MS / 1000}초 쿨타임)\n` +
                        `• 통화방 1분당 ${POINT_CONFIG.VOICE_POINT}P (2명 이상, 헤드셋 켠 상태, 잠수방 제외)\n` +
                        `• 타자 게임 우승 +${TYPING_REWARD}P\n` +
                        '`!잔액 [@멘션]` 잔액 확인 · `!포인트 [@멘션]` 순위와 획득 내역\n' +
                        '`!포인트순위 [채팅/통화]` TOP 10',
                },
                {
                    name: '🪙 출석 · 송금 · 출금 · 운세',
                    value:
                        `\`!출석\` 하루 1번 (한국 시간 자정 기준). 기본 ${fmt(CONFIG.DAILY_BASE)}P + 연속 출석 하루당 +${fmt(CONFIG.DAILY_STREAK_BONUS)}P (최대 ${CONFIG.DAILY_STREAK_MAX}일), 7일 연속마다 +${fmt(CONFIG.DAILY_WEEK_BONUS)}P\n` +
                                `\`!출금 @멘션 [포인트]\` 상대에게 포인트 전달, 수수료 ${rate}% (최소 ${fmt(CONFIG.TRANSFER_MIN)}P) · 내역은 출금 채널에 기록\n` +
                                '`!송금 [후원/송금] [액수] [메세지]` 내 포인트를 차감하고 입금 채널에 `출금자 ID · 출금액 · 메세지`로 기록\n' +
                        '`!오늘의운세 [@멘션]` 사람마다, 날마다 다른 운세',
                },
                {
                    name: '🎰 배팅 게임',
                    value:
                        '`!동전 [앞/뒤] [포인트]` 맞히면 +배팅액, 틀리면 -배팅액\n' +
                        '`!슬롯 [포인트]` 3개 일치 x8 (7️⃣ 3개는 x20), 2개 일치 본전, 꽝은 -배팅액\n' +
                        '`!가위바위보 [가위/바위/보] [포인트]` (`!가바보`) 이기면 +배팅액, 비기면 본전\n' +
                        `배팅 ${fmt(CONFIG.MIN_BET)}P ~ ${fmt(CONFIG.MAX_BET)}P · \`올인\` \`반\` 가능 · 쿨타임 ${CONFIG.GAMBLE_COOLDOWN_MS / 1000}초`,
                },
                {
                    name: '🕹️ 타자 · 끝말잇기',
                    value:
                        '`!타자` 나온 문장을 가장 먼저 똑같이 입력하면 우승 (복사 붙여넣기는 인식 안 돼요)\n' +
                        '`!타자순위` 이번 주 TOP 10 (매주 월요일 0시 초기화)\n' +
                        '`!끝말잇기` 여럿이 함께 · `!끝말잇기 봇` 봇과 1:1 · `!끝말잇기종료` 시작한 사람/관리자가 종료\n' +
                        `• 두음법칙 적용, 한방 단어 금지 (${CONFIG.CHAIN_BANNED_ENDINGS.join(' ')} 로 끝나는 단어)\n` +
                        '• 표준국어대사전에 있는 명사만 인정\n' +
                        `• ❤️ 목숨 ${CONFIG.CHAIN_LIVES}개: 틀리면 -1, 0개면 탈락\n` +
                        '• ✅ 성공 · ❌ 글자 불일치 · 🔁 이미 쓴 단어 · ⛔ 연속 입력 · ❓ 사전에 없음 · 🚫 한방 단어 · ⚠️ 사전 확인 실패',
                },
            );

        const embed2 = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('📖 사용 설명서 (2/3) - 레벨 · 생일 · 편의 · 타이머')
            .addFields(
                {
                    name: '🏅 레벨',
                    value:
                        `채팅 ${CONFIG.LEVEL_CHAT_XP_MIN}~${CONFIG.LEVEL_CHAT_XP_MAX}XP (${CONFIG.LEVEL_CHAT_COOLDOWN_MS / 1000}초 쿨타임), 통화방 1분당 ${CONFIG.LEVEL_VOICE_XP}XP\n` +
                        '`!레벨 [@멘션]` 레벨 · 경험치 · 순위 / `!레벨순위` TOP 10\n' +
                        '레벨업 알림 채널은 `!레벨채널`로 지정해요.',
                },
                {
                    name: '🎂 생일',
                    value:
                        '`!생일등록 [닉네임] [월] [일]` 예) `!생일등록 철수 3 15`, `!생일등록 @멘션 3 15`, 본인은 `!생일등록 3 15`\n' +
                        '`!생일삭제 [닉네임]` · `!생일목록 [월]`\n' +
                        `생일 당일 ${bdayTime}(한국 시간)에 축하 메시지를 보내요. (채널은 \`!생일채널\`)`,
                },
                {
                    name: '🔧 편의',
                    value:
                        '`!아이디 [@멘션]` ID 확인 · `!날씨 [지역명]` 날씨와 미세먼지\n' +
                        '`!채팅순위` 이번 주/전체 TOP 10 · `!서버구성` 인원, 온라인, 봇, 통화방별 인원\n' +
                        '`!가사 [제목]` 등록된 가사 또는 유튜브 검색 링크\n' +
                        '`!가사등록 [제목] [가사]` (제목에 띄어쓰기가 있으면 "따옴표") · `!가사삭제 [제목]` · `!가사목록 [페이지]`',
                },
                {
                    name: '⏱️ 타이머',
                    value:
                        '`!타이머 [시간] [메모]` 예) `10분`, `1시간30분 라면`, `30초` (숫자만 쓰면 분)\n' +
                        '`!타이머목록` 내 타이머 확인 · `!타이머취소 [번호]`\n' +
                        '최대 24시간, 한 사람당 5개까지',
                },
            );

        const embed3 = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('📖 사용 설명서 (3/3) - 관리 · 슬래시 · 조직 대응')
            .addFields(
                {
                    name: '🛡️ 서버 관리 (봇에게 권한 필요)',
                    value:
                        '`!타임아웃 @멘션 [분] [사유]` 채팅 금지 (생략 시 10분) · `!타임아웃해제 @멘션`\n' +
                        '`!추방 @멘션 [사유]` · `!청소 [개수] [@멘션]` 메시지 삭제 (1~100개)',
                },
                {
                    name: '⚙️ 서버 설정 (서버 관리 권한 필요)',
                    value:
                        '`!로그채널` 입퇴장, 메시지 삭제·수정, 역할·타임아웃, 통화 시간 기록\n' +
                        '`!환영채널` 새 멤버 자동 환영 · `!환영메시지 [내용]` 변수 `{유저}` `{서버명}` `{인원}` · `!환영테스트`\n' +
                        '`!생일채널` 생일 축하 · `!레벨채널` 레벨업 알림\n' +
                        '`!입금채널` 송금·후원 내역 · `!출금채널` `!출금` 내역 (미설정 시 입금채널로 전송)\n' +
                        '`!레벨닉네임 켜기/끄기/갱신/제거 [@멘션]` 닉네임 앞에 `[Lv.N]` (봇에게 닉네임 관리 권한 필요)\n' +
                        '`!통화입장 [#음성채널]` · `!통화퇴장` 봇이 통화방에 계속 상주\n' +
                        '`!인증역할 @역할` 반응하면 지급할 역할 지정`!인증채널 #채널` 그 채널에 인증 메시지를 보내고 ✅ 반응 달기 · `!인증채널해제`' +
                        '채널 설정은 `!○○채널 #채널`, 끄기는 `!○○채널해제`',
                },
                {
                    name: '⚡ 슬래시 (/) 명령어',
                    value:
                        '`/ping` `/타이머` `/타이머목록` `/타이머취소`\n' +
                        '`/동전` `/슬롯` `/가위바위보` `/오늘의운세` `/끝말잇기` `/후원`\n' +
                        '`/서버인원` `/서버구성` `/초대링크` `/단어검색` `/환율` `/코인` `/주식` `/티켓설정`\n' +
                        '디스코드 입력창에 `/`를 입력해 선택하세요.',
                },
                {
                    name: '🛡️ 돌격대 | 조직 운영 지침',
                    value:
                        '**목적** 테러 활동을 예방하고 관련 위협에 대응하여 구성원의 안전을 지킨다.\n' +
                        '**절차** `/신고`로 접수 → 관리자 검토·사실 확인 → 필요 시 증거 보존 후 관계 기관 전달 → `/사건기록`으로 상태 갱신 → `/대응현황`으로 확인\n' +
                        '**관리자 전용** `/신고채널설정` `/사건기록` `/경보` `/대응현황`\n' +
                        '**긴급 상황** 즉각적인 위험이 있으면 현지 긴급 신고 기관에 먼저 연락한다.\n' +
                        '**원칙** 확인되지 않은 혐의를 단정하지 않고, 개인정보와 기록을 보호하며, 합법적인 신고와 기관 협력을 우선한다.',
                },
                {
                    name: '🔐 소유자 전용',
                    value:
                        '`!허용 @멘션/ID` `!허용해제 @멘션/ID` `!허용목록` 봇 사용 권한 관리\n' +
                        '`!포인트 추가/제거 @멘션 [수]` · `!포인트수거 @멘션 [포인트/반/전부]`\n' +
                        '`!디엠 [사용자ID]` `!관리` `!서버나가기 [서버ID]` `!서버목록 [페이지]`',
                },
            )
            .setFooter({ text: '명령어만 빠르게 보려면 !목록' });

        await message.reply({ embeds: [embed1] });
        await message.channel.send({ embeds: [embed2] });
        return message.channel.send({ embeds: [embed3] });
    }



    // !올멘 [보낼 메세지]  -> @everyone 과 함께 메세지 전송 (서버 '관리자' 권한 필요)
    if (cmd === '!올멘') {
        if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
            return message.reply('이 명령어는 **관리자 권한**이 있는 사람만 사용할 수 있어요.');
        }
        const text = content.slice(cmd.length).trim();
        if (!text) {
            return message.reply('보낼 메세지를 입력해주세요! 예: `!올멘 오늘 8시에 모여요`');
        }
        if (text.length > 1900) {
            return message.reply('메세지는 1900자 이내로 입력해주세요.');
        }
        return message.channel.send({ content: `@everyone ${text}`, allowedMentions: { parse: ['everyone'] } });
    }

    // ---------- 환영 ----------

    // !환영 @멘션 (또는 사용자 ID)
    if (cmd === '!환영') {
        const arg = content.split(/\s+/)[1];
        const id = message.mentions.users.first()?.id || parseId(arg);
        const target = id ? await client.users.fetch(id).catch(() => null) : null;

        if (!target) {
            return message.reply('환영할 사람을 멘션해주세요! 예: `!환영 @닉네임`');
        }
        if (target.bot) {
            return message.reply('봇은 환영하지 않아도 괜찮아요 🤖');
        }

        const serverName = message.guild ? message.guild.name : '이곳';
        const greetings = [
            '와주셔서 정말 반가워요! 편하게 즐겨주세요 😊',
            '함께하게 되어 기뻐요! 많이 놀아주세요 🎉',
            '오신 걸 진심으로 환영합니다! 자주 놀러 와주세요 🙌',
            '새로운 얼굴이네요! 같이 재밌게 지내봐요 ✨',
        ];
        const greeting = greetings[Math.floor(Math.random() * greetings.length)];

        const embed = new EmbedBuilder()
            .setColor(0xff9ff3)
            .setTitle(`🎉 ${serverName}에 오신 것을 환영합니다!`)
            .setDescription(`<@${target.id}> 님, ${greeting}`)
            .setThumbnail(target.displayAvatarURL({ size: 256 }))
            .setFooter({ text: `${message.author.username} 님이 환영 인사를 보냈어요` })
            .setTimestamp();

        return message.channel.send({
            content: `<@${target.id}>`,
            embeds: [embed],
            allowedMentions: { users: [target.id] },
        });
    }

    // ---------- 날씨 ----------

    // !날씨 [지역명]
    if (cmd === '!날씨') {
        const region = content.slice(cmd.length).trim();
        if (!region) {
            return message.reply('지역명을 입력해주세요! 예: `!날씨 서울`, `!날씨 여수`');
        }

        try {
            await message.channel.sendTyping();

            // "여수시" 처럼 검색이 안 되면 끝의 시/군/구/도를 떼고 한 번 더 시도
            let place = await geocode(region);
            if (!place && /[시군구도]$/.test(region) && region.length > 2) {
                place = await geocode(region.slice(0, -1));
            }
            if (!place) {
                return message.reply(`'${region}' 지역을 찾을 수 없어요. 다른 이름으로 시도해보세요.`);
            }

            const { latitude, longitude } = place;
            const weatherUrl =
                `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m` +
                `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
                `&wind_speed_unit=ms&timezone=auto&forecast_days=1`;
            const airUrl =
                `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}` +
                `&current=pm10,pm2_5&timezone=auto`;

            const [weather, air] = await Promise.all([
                fetchJson(weatherUrl),
                fetchJson(airUrl).catch(() => null), // 미세먼지 실패해도 날씨는 표시
            ]);

            const cur = weather.current;
            const day = weather.daily;
            const [desc, icon] = WEATHER_CODES[cur.weather_code] || ['알 수 없음', '❔'];

            const pm25 = air?.current?.pm2_5 ?? null;
            const pm10 = air?.current?.pm10 ?? null;
            const g25 = gradePM25(pm25);
            const g10 = gradePM10(pm10);

            // 지역 표시 이름 (예: 여수시, 전라남도, 대한민국)
            const placeName = [place.name, place.admin1, place.country].filter(Boolean).join(', ');

            const embed = new EmbedBuilder()
                .setColor(air ? g25.color : 0x5865f2)
                .setTitle(`${icon} ${place.name} 날씨`)
                .setDescription(`${placeName}\n**${desc}**`)
                .addFields(
                    { name: '🌡️ 현재 기온', value: `${cur.temperature_2m}°C (체감 ${cur.apparent_temperature}°C)`, inline: true },
                    { name: '📊 오늘 최저/최고', value: `${day.temperature_2m_min[0]}°C / ${day.temperature_2m_max[0]}°C`, inline: true },
                    { name: '☔ 강수확률', value: `${day.precipitation_probability_max[0] ?? 0}%`, inline: true },
                    { name: '💧 습도', value: `${cur.relative_humidity_2m}%`, inline: true },
                    { name: '🌬️ 바람', value: `${windDir(cur.wind_direction_10m)} ${cur.wind_speed_10m}m/s`, inline: true },
                    { name: '🌧️ 강수량', value: `${cur.precipitation}mm`, inline: true },
                    {
                        name: '😷 미세먼지 (PM10)',
                        value: pm10 != null ? `${g10.emoji} ${g10.text} (${Math.round(pm10)}㎍/㎥)` : '정보 없음',
                        inline: true,
                    },
                    {
                        name: '😷 초미세먼지 (PM2.5)',
                        value: pm25 != null ? `${g25.emoji} ${g25.text} (${Math.round(pm25)}㎍/㎥)` : '정보 없음',
                        inline: true,
                    },
                )
                .setFooter({ text: '데이터: Open-Meteo · 미세먼지는 모델 추정값이라 에어코리아와 다를 수 있어요' })
                .setTimestamp();

            return message.reply({ embeds: [embed] });
        } catch (err) {
            console.error('날씨 조회 실패:', err);
            return message.reply('날씨 정보를 가져오지 못했어요. 잠시 후 다시 시도해주세요.');
        }
    }

    // ---------- 타자 게임 ----------

    // !타자 -> 게임 시작
    if (cmd === '!타자') {
        const channelId = message.channel.id;
        if (typingGames.has(channelId)) {
            return message.reply('이 채널에서 이미 타자 게임이 진행 중이에요!');
        }

        const state = { started: false, text: '', startAt: 0, timeout: null };
        typingGames.set(channelId, state);

        try {
            await message.reply('⌨️ **타자 게임 시작!** 3초 뒤 문장이 나와요. 나온 문장을 **그대로 입력**하세요! (복사 붙여넣기는 인식되지 않아요)');
            await sleep(3000);

            const text = TYPING_SENTENCES[Math.floor(Math.random() * TYPING_SENTENCES.length)];
            const sent = await message.channel.send(`\`\`\`\n${antiCopy(text)}\n\`\`\``);

            state.text = text;
            state.startAt = sent.createdTimestamp;
            state.started = true;
            state.timeout = setTimeout(() => {
                typingGames.delete(channelId);
                message.channel.send('⏰ 시간 초과! 아무도 성공하지 못했어요.').catch(() => {});
            }, TYPING_TIMEOUT_MS);
        } catch (err) {
            console.error('타자 게임 시작 실패:', err);
            typingGames.delete(channelId);
            return message.channel.send('타자 게임을 시작하지 못했어요. (봇 권한을 확인해주세요)').catch(() => {});
        }
        return;
    }

    // !타자순위 -> 이번 주 최고 기록 TOP 10 (매주 월요일 0시 초기화)
    if (cmd === '!타자순위') {
        ensureTypingWeek();
        const nextReset = Math.floor((typingData.weekStart + WEEK_MS) / 1000);

        const ranking = Object.entries(typingData.records)
            .sort((a, b) => b[1].best - a[1].best)
            .slice(0, 10);

        const medals = ['🥇', '🥈', '🥉'];
        const lines = ranking.length > 0
            ? ranking.map(([id, r], i) => `${medals[i] || `**${i + 1}.**`} <@${id}> - ${r.best}타/분 (우승 ${r.wins}회)`)
            : ['이번 주 기록이 아직 없어요. `!타자`로 게임을 시작해보세요!'];

        const embed = new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('🏆 이번 주 타자 게임 순위 TOP 10')
            .setDescription(`${lines.join('\n')}\n\n🔄 다음 초기화: <t:${nextReset}:R> (매주 월요일 0시)`);

        if (typingData.lastWeek && typingData.lastWeek.length > 0) {
            embed.addFields({
                name: '📅 지난주 TOP 3',
                value: typingData.lastWeek.map((r, i) => `${medals[i]} <@${r.id}> - ${r.best}타/분`).join('\n'),
            });
        }

        return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    // ---------- 포인트 ----------

    // !포인트 [@멘션]            -> 포인트 확인 (없으면 본인)
    // !포인트 추가 @멘션 [수]    -> 소유자 전용
    // !포인트 제거 @멘션 [수]    -> 소유자 전용
    if (cmd === '!포인트') {
        if (!message.guild) {
            return message.reply('서버 안에서만 사용할 수 있습니다.');
        }
        const args = content.split(/\s+/);
        const sub = args[1];

        if (sub === '추가' || sub === '제거') {
            if (!isOwner) {
                return message.reply('포인트 추가/제거는 봇 소유자만 사용할 수 있습니다.');
            }
            const id = message.mentions.users.first()?.id || parseId(args[2]);
            const amount = parseInt(args[3], 10);
            if (!id || Number.isNaN(amount) || amount < 1 || amount > POINT_CONFIG.MAX_MANUAL) {
                return message.reply(`사용법: \`!포인트 ${sub} @멘션 [포인트]\` (1 ~ ${POINT_CONFIG.MAX_MANUAL.toLocaleString()})`);
            }

            const u = getPointUser(message.guild.id, id);
            const before = u.points;
            addPoints(message.guild.id, id, sub === '추가' ? amount : -amount, 'manual');

            return message.reply({
                content: `${sub === '추가' ? '➕' : '➖'} <@${id}> 님의 포인트를 ${amount.toLocaleString()}P ${sub}했어요.\n` +
                         `💰 ${before.toLocaleString()}P → **${u.points.toLocaleString()}P**`,
                allowedMentions: { parse: [] },
            });
        }

        // 조회
        const id = message.mentions.users.first()?.id || parseId(sub) || message.author.id;
        const u = getPointUser(message.guild.id, id);
        const ranking = Object.entries(pointsData.guilds[message.guild.id] || {})
            .filter(([, v]) => v.points > 0)
            .sort((a, b) => b[1].points - a[1].points);
        const rank = ranking.findIndex(([uid]) => uid === id);

        const embed = new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('💰 포인트')
            .setDescription(`<@${id}> 님의 포인트`)
            .addFields(
                { name: '💰 보유 포인트', value: `${u.points.toLocaleString()}P`, inline: true },
                { name: '🏆 순위', value: rank >= 0 ? `${rank + 1}위` : '순위 없음', inline: true },
                { name: '\u200b', value: '\u200b', inline: true },
                { name: '💬 채팅으로 얻은 포인트', value: `${u.chat.toLocaleString()}P`, inline: true },
                { name: '🔊 통화로 얻은 포인트', value: `${u.voice.toLocaleString()}P`, inline: true },
            )
            .setFooter({ text: `채팅 ${POINT_CONFIG.CHAT_POINT}P (${POINT_CONFIG.CHAT_COOLDOWN_MS / 1000}초 쿨타임) · 통화 1분당 ${POINT_CONFIG.VOICE_POINT}P` });

        return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    // !포인트순위 [채팅|통화]
    if (cmd === '!포인트순위') {
        if (!message.guild) {
            return message.reply('서버 안에서만 사용할 수 있습니다.');
        }

        const type = content.split(/\s+/)[1];
        const TYPES = {
            '채팅': { key: 'chat',   title: '💬 채팅 포인트 순위' },
            '통화': { key: 'voice',  title: '🔊 통화 포인트 순위' },
        };
        const { key, title } = TYPES[type] || { key: 'points', title: '💰 전체 포인트 순위' };

        const users = pointsData.guilds[message.guild.id] || {};
        const medals = ['🥇', '🥈', '🥉'];
        const list = Object.entries(users)
            .filter(([, u]) => u[key] > 0)
            .sort((a, b) => b[1][key] - a[1][key]);

        const lines = list.length > 0
            ? list.slice(0, 10).map(([id, u], i) => `${medals[i] || `**${i + 1}.**`} <@${id}> - ${u[key].toLocaleString()}P`).join('\n')
            : '아직 기록이 없어요.';

        const myIdx = list.findIndex(([id]) => id === message.author.id);

        const embed = new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle(`${title} TOP 10`)
            .setDescription(lines)
            .setFooter({
                text: `내 순위 - ${myIdx >= 0 ? `${myIdx + 1}위 (${list[myIdx][1][key].toLocaleString()}P)` : '기록 없음'}` +
                      ' · !포인트순위 [채팅/통화]',
            });

        return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    // ---------- 채팅 순위 ----------

    // !채팅순위 -> 전체 / 이번 주 TOP 10
    if (cmd === '!채팅순위') {
        if (!message.guild) {
            return message.reply('서버 안에서만 사용할 수 있습니다.');
        }
        ensureChatWeek();

        const users = chatData.guilds[message.guild.id] || {};
        const medals = ['🥇', '🥈', '🥉'];
        const rank = key => Object.entries(users)
            .filter(([, u]) => u[key] > 0)
            .sort((a, b) => b[1][key] - a[1][key]);
        const format = (list, key) => list.length > 0
            ? list.slice(0, 10).map(([id, u], i) => `${medals[i] || `**${i + 1}.**`} <@${id}> - ${u[key].toLocaleString()}개`).join('\n')
            : '아직 기록이 없어요.';

        const totalList = rank('total');
        const weekList = rank('week');
        const myTotal = totalList.findIndex(([id]) => id === message.author.id);
        const myWeek = weekList.findIndex(([id]) => id === message.author.id);
        const nextReset = Math.floor((chatData.weekStart + WEEK_MS) / 1000);

        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`💬 ${message.guild.name} 채팅 순위`)
            .setDescription(`🔄 주간 순위 초기화: <t:${nextReset}:R> (매주 월요일 0시)`)
            .addFields(
                { name: '🔥 이번 주 TOP 10', value: format(weekList, 'week') },
                { name: '🏆 전체 TOP 10', value: format(totalList, 'total') },
            )
            .setFooter({
                text: '내 순위 - ' +
                    `이번 주 ${myWeek >= 0 ? `${myWeek + 1}위 (${users[message.author.id].week.toLocaleString()}개)` : '기록 없음'}` +
                    ' · ' +
                    `전체 ${myTotal >= 0 ? `${myTotal + 1}위 (${users[message.author.id].total.toLocaleString()}개)` : '기록 없음'}`,
            });

        return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    // ---------- 서버 구성 ----------

    // !서버구성 -> 전체 인원 / 온라인 / 봇 수 + 통화방별 인원
    if (cmd === '!서버구성') {
        if (!message.guild) {
            return message.reply('서버 안에서만 사용할 수 있습니다.');
        }

        try {
            await message.guild.members.fetch(); // 전체 멤버 캐시 확보 (멤버/프레즌스 인텐트 필요)

            const members = message.guild.members.cache;
            const totalCount = members.size;
            const botCount = members.filter(m => m.user.bot).size;
            const humanCount = totalCount - botCount;
            const onlineCount = members.filter(m => !m.user.bot && m.presence && m.presence.status !== 'offline').size;

            const voiceChannels = message.guild.channels.cache
                .filter(c => c.type === ChannelType.GuildVoice)
                .sort((a, b) => a.position - b.position);

            const voiceTotal = voiceChannels.reduce((sum, c) => sum + c.members.size, 0);
            const voiceLines = voiceChannels.size > 0
                ? voiceChannels.map(c => `🔊 ${c.name} - **${c.members.size}**명`).join('\n')
                : '음성 채널이 없어요.';

            const embed = new EmbedBuilder()
                .setColor(0x5865f2)
                .setTitle(`🧩 ${message.guild.name} 서버 구성`)
                .addFields(
                    { name: '👥 전체 인원', value: `${totalCount}명`, inline: true },
                    { name: '🙋 유저', value: `${humanCount}명`, inline: true },
                    { name: '🤖 봇', value: `${botCount}명`, inline: true },
                    { name: '🟢 온라인', value: `${onlineCount}명`, inline: true },
                    { name: '🔊 통화 중', value: `${voiceTotal}명`, inline: true },
                    { name: '\u200b', value: '\u200b', inline: true },
                    { name: '🔊 통화방별 인원', value: voiceLines },
                )
                .setThumbnail(message.guild.iconURL({ size: 256 }))
                .setTimestamp();

            return message.reply({ embeds: [embed] });
        } catch (err) {
            console.error('서버구성 조회 실패:', err);
            return message.reply(
                '서버 정보를 가져오지 못했어요.\n' +
                '디스코드 개발자 포털 > Bot 탭에서 **SERVER MEMBERS INTENT**와 **PRESENCE INTENT**가 켜져 있는지 확인해주세요.'
            );
        }
    }

    // ---------- 가사 ----------

    // !가사등록 [노래제목] [노래가사]
    if (cmd === '!가사등록') {
        const parsed = parseLyricsInput(content.slice(cmd.length).trim());
        if (!parsed || !parsed.title || !parsed.lyrics) {
            return message.reply(
                '사용법: `!가사등록 노래제목 가사내용`\n' +
                '제목에 띄어쓰기가 있으면 따옴표로 묶어주세요. 예: `!가사등록 "노래 제목" 가사...`\n' +
                '또는 첫 줄에 제목, 다음 줄부터 가사를 써도 돼요.'
            );
        }
        if (parsed.title.length > 100) {
            return message.reply('제목은 100자 이내로 입력해주세요.');
        }

        const key = normTitle(parsed.title);
        if (!key) {
            return message.reply('제목에 글자나 숫자가 하나 이상 있어야 해요.');
        }
        const existing = lyricsDB[key];

        // 같은 제목이면 새로 쌓지 않고 최신 내용으로 교체 (항상 1개만 유지)
        lyricsDB[key] = {
            title: parsed.title,
            lyrics: parsed.lyrics,
            userId: message.author.id,
            createdAt: Date.now(),
        };
        saveLyrics();
        return message.reply(
            existing
                ? `♻️ 이미 있던 **${parsed.title}** 가사를 새 내용으로 교체했어요. (중복 없이 1개만 유지돼요)`
                : `✅ **${parsed.title}** 가사를 등록했어요! \`!가사 ${parsed.title}\`로 확인할 수 있어요.`
        );
    }

    // !가사목록 [페이지]
    if (cmd === '!가사목록') {
        const entries = Object.values(lyricsDB).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
        if (entries.length === 0) {
            return message.reply('등록된 가사가 없어요. `!가사등록 노래제목 가사내용`으로 등록해보세요!');
        }

        const PER_PAGE = 15;
        const totalPages = Math.ceil(entries.length / PER_PAGE);
        let page = parseInt(content.split(/\s+/)[1], 10);
        if (Number.isNaN(page) || page < 1) page = 1;
        if (page > totalPages) page = totalPages;

        const start = (page - 1) * PER_PAGE;
        const lines = entries.slice(start, start + PER_PAGE).map((e, i) =>
            `**${start + i + 1}.** ${e.title}  ·  <@${e.userId}>`
        );

        const embed = new EmbedBuilder()
            .setColor(0x1db954)
            .setTitle(`📚 등록된 가사 목록 (${entries.length}곡)`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: `${page}/${totalPages} 페이지` + (totalPages > 1 ? ' · !가사목록 [페이지]' : '') + ' · !가사 [제목]으로 보기' });

        return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    // !가사삭제 [노래제목]
    if (cmd === '!가사삭제') {
        const title = content.slice(cmd.length).trim().replace(/^["“”'‘’]|["“”'‘’]$/g, '');
        if (!title) {
            return message.reply('삭제할 노래 제목을 입력해주세요! 예: `!가사삭제 노래제목`');
        }
        const key = normTitle(title);
        const entry = lyricsDB[key];
        if (!entry) {
            return message.reply('등록된 가사가 없어요. 제목을 정확히 입력해주세요.');
        }
        if (entry.userId !== message.author.id && !isOwner) {
            return message.reply('다른 사람이 등록한 가사는 삭제할 수 없어요.');
        }
        delete lyricsDB[key];
        saveLyrics();
        return message.reply(`🗑️ **${entry.title}** 가사를 삭제했어요.`);
    }


    // !가사 [노래제목] -> 곡 정보 + 가사 사이트 바로가기
    if (cmd === '!가사') {
        const query = content.slice(cmd.length).trim();
        if (!query) {
            return message.reply('노래 제목을 입력해주세요! 예: `!가사 봄날 방탄소년단`');
        }

        // 등록된 가사가 있으면 먼저 보여주기
        const saved = findLyrics(query);
        if (saved) {
            const embed = new EmbedBuilder()
                .setColor(0x1db954)
                .setTitle(`🎶 ${saved.title}`)
                .setDescription(saved.lyrics.slice(0, 4000))
                .setFooter({ text: '사용자가 등록한 가사예요' })
                .setTimestamp(saved.createdAt || Date.now());
            return message.reply({ embeds: [embed] });
        }

        try {
            await message.channel.sendTyping();

            const song = await searchSong(query);
            const title = song ? `${song.artistName} ${song.trackName}` : query;
            const lyricsUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' 가사')}`;
            const mvUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' MV')}`;
            const links =
                `[▶️ 유튜브에서 가사 영상 검색](${lyricsUrl})\n` +
                `[🎬 유튜브에서 MV 검색](${mvUrl})`;

            const embed = new EmbedBuilder().setColor(0x1db954).setTimestamp();

            if (song) {
                embed
                    .setTitle(`🎶 ${song.trackName}`)
                    .setDescription(`**${song.artistName}**\n💿 ${song.collectionName || '-'}`)
                    .setThumbnail((song.artworkUrl100 || '').replace('100x100', '300x300') || null)
                    .addFields(
                        { name: '📅 발매일', value: song.releaseDate ? song.releaseDate.slice(0, 10) : '정보 없음', inline: true },
                        { name: '📄 가사 보기 (유튜브)', value: links },
                    );
                if (song.trackViewUrl) embed.setURL(song.trackViewUrl);
            } else {
                embed
                    .setTitle(`🔎 '${query}'`)
                    .setDescription('곡 정보를 찾지 못했어요. 아래 링크로 유튜브에서 직접 검색해보세요.')
                    .addFields({ name: '📄 가사 보기 (유튜브)', value: links });
            }
            embed.setFooter({ text: '가사는 저작권 보호 대상이라 유튜브 검색 링크로 안내해요' });

            return message.reply({ embeds: [embed] });
        } catch (err) {
            console.error('가사 검색 실패:', err);
            return message.reply('노래 정보를 가져오지 못했어요. 잠시 후 다시 시도해주세요.');
        }
    }

    // ---------- 타이머 ----------

    // !타이머 [시간] [메모]
    if (cmd === '!타이머') {
        const text = content.slice(cmd.length).trim();
        const parsed = parseDuration(text);

        if (!parsed || parsed.ms <= 0) {
            return message.reply('시간을 입력해주세요! 예: `!타이머 10분`, `!타이머 1시간30분 라면`, `!타이머 30초`');
        }
        if (parsed.ms > MAX_TIMER_MS) {
            return message.reply('타이머는 최대 24시간까지 설정할 수 있어요.');
        }

        // 한 사람당 최대 5개
        const mine = [...timers.values()].filter(t => t.userId === message.author.id);
        if (mine.length >= 5) {
            return message.reply('타이머는 한 사람당 최대 5개까지 만들 수 있어요. `!타이머취소 [번호]`로 정리해주세요.');
        }

        const id = timerSeq++;
        const label = parsed.label || '타이머';
        const channel = message.channel;
        const userId = message.author.id;
        const endAt = Date.now() + parsed.ms;

        const sent = await message.reply(`⏱️ **#${id}** 타이머 시작! 남은 시간 **${formatDuration(parsed.ms)}** / ${label}`);

        const finish = async () => {
            const t = timers.get(id);
            if (t?.interval) clearInterval(t.interval);
            timers.delete(id);
            await Promise.resolve(sent.edit(`⏰ **#${id}** **${label}** 타이머가 끝났어요!`)).catch(() => {});
            try {
                await channel.send({
                    content: `⏰ <@${userId}> **${label}** 타이머가 끝났어요!`,
                    allowedMentions: { users: [userId] },
                });
            } catch (err) {
                // 개인챗(사용자 설치 앱)에서 응답 시간이 지났다면 DM으로 알림을 시도
                try {
                    const u = await client.users.fetch(userId);
                    await u.send(`⏰ **${label}** 타이머가 끝났어요!`);
                } catch (err2) {
                    console.error('타이머 알림 실패:', err2.message);
                }
            }
        };

        const handle = setTimeout(finish, parsed.ms);

        // 남은 시간이 줄어드는 걸 보여주기 위해 주기적으로 메시지 수정
        const interval = setInterval(() => {
            const remaining = endAt - Date.now();
            if (remaining <= 0) return; // 곧 finish()가 처리
            sent.edit(`⏱️ **#${id}** 남은 시간 **${formatDuration(remaining)}** / ${label}`).catch(() => {});
        }, pickUpdateInterval(parsed.ms));

        timers.set(id, { userId, channelId: channel.id, endAt, label, handle, interval, message: sent });
        return;
    }

    // !타이머목록 -> 내 타이머 보기
    if (cmd === '!타이머목록') {
        const mine = [...timers.entries()].filter(([, t]) => t.userId === message.author.id);
        if (mine.length === 0) {
            return message.reply('진행 중인 타이머가 없어요.');
        }
        const lines = mine.map(([id, t]) => `**#${id}** ${t.label} - 남은 시간 ${formatDuration(t.endAt - Date.now())}`);
        return message.reply(`**내 타이머 ${mine.length}개**\n${lines.join('\n')}`);
    }

    // !타이머취소 [번호]
    if (cmd === '!타이머취소') {
        const id = parseInt(content.split(/\s+/)[1], 10);
        if (Number.isNaN(id)) {
            return message.reply('취소할 타이머 번호를 입력해주세요! 예: `!타이머취소 1` (번호는 `!타이머목록`에서 확인)');
        }
        const t = timers.get(id);
        if (!t) {
            return message.reply('그런 번호의 타이머가 없어요.');
        }
        if (t.userId !== message.author.id && !isOwner) {
            return message.reply('다른 사람의 타이머는 취소할 수 없어요.');
        }
        clearTimeout(t.handle);
        if (t.interval) clearInterval(t.interval);
        timers.delete(id);
        if (t.message) {
            t.message.edit(`🗑️ **#${id}** ${t.label} 타이머가 취소되었어요.`).catch(() => {});
        }
        return message.reply(`🗑️ **#${id}** 타이머를 취소했어요.`);
    }

    // ---------- 허용 관리 (소유자 전용) ----------

    // !허용 [@멘션 또는 ID]
    if (cmd === '!허용') {
        const id = parseId(content.split(/\s+/)[1]);
        if (!id) {
            return message.reply('허용할 사람을 멘션하거나 ID를 입력해주세요! 예: !허용 123456789012345678');
        }
        if (isOwnerId(id)) {
            return message.reply('소유자는 이미 모든 권한이 있어요.');
        }
        if (allowedIds.has(id)) {
            return message.reply('이미 허용된 사용자입니다.');
        }
        allowedIds.add(id);
        saveAllowed();
        return message.reply(`✅ <@${id}> (\`${id}\`) 님을 허용 목록에 추가했습니다.`);
    }

    // !허용해제 [@멘션 또는 ID]
    if (cmd === '!허용해제') {
        const id = parseId(content.split(/\s+/)[1]);
        if (!id) {
            return message.reply('해제할 사람을 멘션하거나 ID를 입력해주세요! 예: !허용해제 123456789012345678');
        }
        if (!allowedIds.has(id)) {
            return message.reply('허용 목록에 없는 사용자입니다.');
        }
        allowedIds.delete(id);
        saveAllowed();
        return message.reply(`🚫 \`${id}\` 님을 허용 목록에서 제거했습니다.`);
    }

    // !허용목록
    if (cmd === '!허용목록') {
        if (allowedIds.size === 0) {
            return message.reply('허용된 사용자가 없습니다.');
        }
        const list = [...allowedIds].map((id, i) => `${i + 1}. <@${id}> (\`${id}\`)`).join('\n');
        return message.reply({ content: `**허용된 사용자 ${allowedIds.size}명**\n${list}`, allowedMentions: { parse: [] } });
    }

    // ---------- 일반 명령어 ----------

    // !청소 [개수] [@멘션]
    if (content === '!청소' || content.startsWith('!청소 ')) {
        if (!message.guild) {
            return message.reply('서버 안에서만 사용할 수 있습니다.');
        }

        const args = content.split(/\s+/).slice(1).filter(a => !a.startsWith('<@'));
        const amount = parseInt(args[0], 10);
        const targetUser = message.mentions.users.first();

        if (Number.isNaN(amount) || amount < 1 || amount > 100) {
            return message.reply('삭제할 개수를 1~100 사이로 입력해주세요! 예: !청소 10  /  !청소 20 @닉네임');
        }

        try {
            await message.delete().catch(() => {});

            let deleted;
            if (targetUser) {
                const fetched = await message.channel.messages.fetch({ limit: 100 });
                const toDelete = fetched.filter(m => m.author.id === targetUser.id).first(amount);
                deleted = await message.channel.bulkDelete(toDelete, true);
            } else {
                deleted = await message.channel.bulkDelete(amount, true);
            }

            const notice = await message.channel.send(`🧹 메시지 ${deleted.size}개를 삭제했습니다.`);
            setTimeout(() => notice.delete().catch(() => {}), 3000);
        } catch (err) {
            console.error(err);
            return message.channel.send('메시지 삭제에 실패했습니다. (봇 권한을 확인해주세요)');
        }
        return;
    }

    // !추방 @멘션 [사유]
    if (content === '!추방' || content.startsWith('!추방 ')) {
        if (!message.guild) {
            return message.reply('서버 안에서만 사용할 수 있습니다.');
        }

        const target = message.mentions.members?.first();
        if (!target) {
            return message.reply('추방할 사람을 멘션해주세요! 예: !추방 @닉네임 사유');
        }

        const reason = content.split(/\s+/).slice(1).filter(a => !a.startsWith('<@')).join(' ') || '사유 없음';

        if (target.id === message.author.id) {
            return message.reply('본인은 추방할 수 없어요 😅');
        }
        if (target.id === client.user.id) {
            return message.reply('저는 스스로를 추방할 수 없어요 😢');
        }
        if (isOwnerId(target.id)) {
            return message.reply('소유자는 추방할 수 없습니다.');
        }
        if (!target.kickable) {
            return message.reply('이 사람은 추방할 수 없습니다. (봇보다 높은 역할이거나 서버 소유자일 수 있어요)');
        }

        try {
            await target.kick(reason);
            return message.reply(`👢 ${target.user.tag} 님을 추방했습니다. (사유: ${reason})`);
        } catch (err) {
            console.error(err);
            return message.reply('추방에 실패했습니다. (봇 권한을 확인해주세요)');
        }
    }

    // !타임아웃해제 @멘션
    if (cmd === '!타임아웃해제') {
        const target = message.mentions.members?.first();
        if (!target) {
            return message.reply('해제할 사람을 멘션해주세요! 예: !타임아웃해제 @닉네임');
        }
        try {
            await target.timeout(null);
            return message.reply(`${target.user.tag} 님의 타임아웃을 해제했습니다.`);
        } catch (err) {
            console.error(err);
            return message.reply('타임아웃을 해제할 수 없습니다. (봇 권한을 확인해주세요)');
        }
    }

    // !타임아웃 @멘션 [분] [사유]
    if (cmd === '!타임아웃') {
        if (!message.guild) {
            return message.reply('서버 안에서만 사용할 수 있습니다.');
        }

        const target = message.mentions.members?.first();
        if (!target) {
            return message.reply('타임아웃할 사람을 멘션해주세요! 예: !타임아웃 @닉네임 10 도배');
        }

        const args = content.split(/\s+/).slice(1).filter(a => !a.startsWith('<@'));
        let minutes = parseInt(args[0], 10);
        let reason;
        if (Number.isNaN(minutes)) {
            minutes = 10;
            reason = args.join(' ') || '사유 없음';
        } else {
            reason = args.slice(1).join(' ') || '사유 없음';
        }

        if (minutes < 1 || minutes > 40320) {
            return message.reply('시간은 1분 ~ 40320분(28일) 사이로 입력해주세요.');
        }

        if (target.id === message.author.id) {
            return message.reply('본인은 타임아웃할 수 없어요 😅');
        }
        if (isOwnerId(target.id)) {
            return message.reply('소유자는 타임아웃할 수 없습니다.');
        }
        if (!target.moderatable) {
            return message.reply('이 사람은 타임아웃할 수 없습니다. (봇보다 높은 역할이거나 서버 관리자일 수 있어요)');
        }

        try {
            await target.timeout(minutes * 60 * 1000, reason);
            return message.reply(`⏱️ ${target.user.tag} 님을 ${minutes}분 동안 타임아웃했습니다. (사유: ${reason})`);
        } catch (err) {
            console.error(err);
            return message.reply('타임아웃에 실패했습니다. (봇 권한을 확인해주세요)');
        }
    }

    // !아이디 @닉네임 -> 멘션된 사용자 ID 확인 (없으면 본인 ID)
    if (cmd === '!아이디') {
        const target = message.mentions.users.first();
        if (!target) {
            return message.reply(`당신의 ID는 \`${message.author.id}\` 입니다.`);
        }
        return message.reply(`${target.tag} 님의 ID는 \`${target.id}\` 입니다.`);
    }

    // !디엠 [사용자ID] (소유자 전용)
    if (cmd === '!디엠') {
        const args = content.split(' ');
        const userId = args[1];
        const dmText = '안녕하세요! 활동 좀 많이 해주세요! 😊';

        if (!userId) {
            return message.reply('사용자 ID를 함께 입력해주세요! 예: !디엠 123456789012345678');
        }

        try {
            const target = await client.users.fetch(userId);
            await target.send(dmText);
            return message.reply(`${target.tag} 님에게 메시지를 보냈습니다.`);
        } catch (err) {
            return message.reply('메시지를 보낼 수 없습니다. (잘못된 ID이거나 상대방이 DM을 막아뒀을 수 있어요)');
        }
    }

    // !관리 (소유자 전용)
    if (cmd === '!관리') {
        return message.reply('관리자 명령어 실행!');
    }

    // !서버나가기 [서버ID] (소유자 전용, ID 없으면 현재 서버에서 나감)
    if (cmd === '!서버나가기') {
        const arg = content.split(/\s+/)[1];
        const targetGuildId = arg || message.guild?.id;

        if (!targetGuildId) {
            return message.reply('나갈 서버 ID를 입력해주세요! 예: `!서버나가기 123456789012345678`');
        }

        const guild = client.guilds.cache.get(targetGuildId);
        if (!guild) {
            return message.reply('봇이 해당 서버에 들어가 있지 않거나 ID가 잘못되었습니다.');
        }

        const guildName = guild.name;
        await message.reply(`서버 "${guildName}"에서 나갑니다...`);
        await guild.leave();
        return;
    }

    // !서버목록 [페이지] (소유자 전용) -> 봇이 들어가 있는 모든 서버 목록
    if (cmd === '!서버목록') {
        const guilds = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
        if (guilds.length === 0) {
            return message.reply('봇이 들어가 있는 서버가 없습니다.');
        }

        const PER_PAGE = 10;
        const totalPages = Math.ceil(guilds.length / PER_PAGE);
        let page = parseInt(content.split(/\s+/)[1], 10);
        if (Number.isNaN(page) || page < 1) page = 1;
        if (page > totalPages) page = totalPages;

        const start = (page - 1) * PER_PAGE;
        const lines = guilds.slice(start, start + PER_PAGE).map((g, i) =>
            `**${start + i + 1}.** ${g.name} · 👥 ${g.memberCount.toLocaleString()}명 · \`${g.id}\``
        );

        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`🌐 봇이 들어가 있는 서버 (${guilds.length}개)`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: `${page}/${totalPages} 페이지` + (totalPages > 1 ? ' · !서버목록 [페이지]' : '') + ' · !서버나가기 [서버ID]로 나가기' });

        return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
}
client.on(Events.MessageCreate, handleMainMessage);



// =====================================================================
//  추가 기능: 포인트 경제(출석/송금/동전/슬롯) · 서버 로그/자동 환영 · 끝말잇기
//  (설정값은 아래 CONFIG 에서 바꿀 수 있어요)
// =====================================================================

// 표준국어대사전 오픈API 키. config.json 에 "stdictKey": "발급받은키" 를 넣으면
// 끝말잇기에서 국어사전에 실제 있는 (명사) 단어인지 검사합니다. (CHAIN_STRICT_DICT 가 true 면 키가 꼭 필요해요)
let STDICT_KEY = null;
try { STDICT_KEY = require('../config.json').stdictKey || null; } catch { /* 없으면 사전 검사 생략 */ }

// ==================== 설정 (마음대로 바꾸세요) ====================
const CONFIG = {
    EVERYONE: true,                 // true: 출석/송금/도박/끝말잇기 시작을 누구나 사용 / false: 기존 '허용된 사람만' 규칙 적용

    // --- 출석 ---
    DAILY_BASE: 100,                // 기본 출석 포인트
    DAILY_STREAK_BONUS: 20,         // 연속 출석 1일당 추가 포인트
    DAILY_STREAK_MAX: 6,            // 연속 보너스가 붙는 최대 일수 (6 -> 최대 +120P)
    DAILY_WEEK_BONUS: 300,          // 7일 연속(7, 14, 21...) 달성 시 추가 보너스

    // --- 송금 ---
    TRANSFER_MIN: 1,               // 최소 송금액
    TRANSFER_FEE_RATE: 0.1,        // 송금 수수료 (0.1 = 10%, 0이면 없음)

    // --- 도박 ---
    MIN_BET: 1,
    MAX_BET: 100_000_000_000,       // 최대 배팅액(1천억)
    GAMBLE_COOLDOWN_MS: 3000,       // 도박 명령어 쿨타임
    COIN_WIN_RATE: 0.5,             // 동전 던지기 승률
    RPS_WIN_MULT: 1,                // 가위바위보 이겼을 때 배당 (1 = 배팅액만큼 획득, 비기면 본전, 지면 잃음)

    // --- 끝말잇기 ---
    CHAIN_TIMEOUT_MS: 60 * 1000,    // 이 시간 동안 아무도 못 잇으면 종료
    CHAIN_ALLOW_SAME_USER: false,   // 같은 사람이 연속으로 이어도 되는지
    CHAIN_LIVES: 3,                 // 끝말잇기 목숨 개수 (틀리면 -1, 0이 되면 탈락)
    CHAIN_LOSE_LIFE_ON_WRONG_LETTER: true, // 글자가 안 맞는 단어(❌)도 목숨을 깎을지 (false면 반응만 붙고 목숨은 그대로)
    CHAIN_STRICT_DICT: true,        // true: 표준국어대사전에 있는 (명사) 단어만 인정 (stdictKey 필요) / false: 사전 서버 오류나 키가 없으면 검사 없이 통과
    CHAIN_REWARD_PER_WORD: 3,       // 단어 1개당 보상 포인트 (참가자 2명 이상일 때만 지급)
    CHAIN_REWARD_MAX_WORDS: 30,     // 한 게임에서 1인당 보상받는 최대 단어 수
    // 한방 단어 금지: 이 글자로 끝나는 단어는 쓸 수 없어요 (이어갈 단어가 거의 없는 글자들)
    CHAIN_BANNED_ENDINGS: ['늄', '듐', '륨', '슘', '튬', '븀', '뮴', '릇', '즘', '쯤', '녘'],
    CHAIN_BOT_DELAY_MS: 800,        // 봇이 단어를 내기 전 잠깐 생각하는 시간
    CHAIN_BOT_WIN_REWARD: 50,       // 봇전에서 봇이 단어를 못 이어 항복했을 때 지급하는 포인트
    CHAIN_BOT_WIN_MIN_WORDS: 3,     // 위 보상을 받으려면 최소 몇 단어 이상 이어야 하는지 (연습 방지)

    // --- 로그 ---
    LOG_VOICE: true,                // 음성 채널 입퇴장/이동 로그 (시끄러우면 false)
    VOICE_LIVE_INTERVAL_MS: 60 * 1000, // 통화 로그 메시지 실시간 갱신 주기 (너무 짧게 하면 레이트리밋 위험)

    // --- 생일 ---
    BIRTHDAY_HOUR: 0,               // 생일 축하 메시지를 보낼 시각 (한국 시간, 0 = 밤 12시/자정, 12 = 낮 12시)
    BIRTHDAY_REWARD: 0,             // 생일 당사자(멘션으로 등록된 경우)에게 줄 선물 포인트 (0이면 없음)
    BIRTHDAY_MAX_ENTRIES: 500,      // 서버당 최대 등록 인원

    // --- 레벨링 ---
    LEVEL_CHAT_XP_MIN: 15,          // 채팅 1회당 경험치 (최소~최대 사이 랜덤)
    LEVEL_CHAT_XP_MAX: 25,
    LEVEL_CHAT_COOLDOWN_MS: 60 * 1000, // 채팅 경험치 쿨타임 (도배 방지)
    LEVEL_VOICE_XP: 10,             // 통화방 1분당 경험치 (2명 이상, 헤드셋 켠 상태, 잠수방 제외)
    LEVEL_UP_POINTS: 0,             // 레벨이 1 오를 때마다 주는 포인트 (0이면 없음)
    LEVEL_NICK_FORMAT: '[Lv.{level}]', // 닉네임 앞에 붙는 말머리 ({level} 자리에 레벨이 들어가요). 서버에서 !레벨닉네임 켜기 를 해야 적용돼요

   
    // --- 포인트 수거 ---
    COLLECT_GIVE_TO_COLLECTOR: false, // true: 수거한 포인트를 명령어 쓴 사람이 가져감 / false: 그냥 소멸
};

// ==================== 공용 유틸 ====================
const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (t = Date.now()) => new Date(t + KST_OFFSET).toISOString().slice(0, 10); // 한국 날짜 'YYYY-MM-DD'
const fmt = n => Number(n).toLocaleString();
const clip = (s, n = 1000) => (s ? (s.length > n ? s.slice(0, n) + '…' : s) : '');
const unix = ts => Math.floor(ts / 1000);

// JSON 저장소: 변경 시 2초 뒤 저장(몰아서), 임시파일 -> 교체 방식이라 저장 도중 꺼져도 파일이 안 깨짐
function createStore(file, defaults) {
    const filePath = path.join(__dirname, file);
    let data = defaults();
    try {
        if (fs.existsSync(filePath)) data = { ...data, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    } catch (err) {
        console.error(`${file} 읽기 실패:`, err);
    }
    let timer = null;
    const flush = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        try {
            const tmp = filePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmp, filePath);
        } catch (err) {
            console.error(`${file} 저장 실패:`, err);
        }
    };
    const save = () => { if (!timer) timer = setTimeout(flush, 2000); };
    return { data, save, flush };
}

// ==================== 끝말잇기용: 두음법칙 ====================
// 마지막 글자 -> 다음 단어가 시작할 수 있는 글자들 (예: '리' -> ['리','이'], '라' -> ['라','나'])
const HANGUL_BASE = 0xAC00;
function startVariants(ch) {
    const code = ch.charCodeAt(0) - HANGUL_BASE;
    if (code < 0 || code > 11171) return [ch];
    const cho = Math.floor(code / 588);
    const jung = Math.floor((code % 588) / 28);
    const jong = code % 28;
    const compose = c => String.fromCharCode(HANGUL_BASE + (c * 21 + jung) * 28 + jong);
    const iVowel = [2, 3, 6, 7, 12, 17, 20].includes(jung); // ㅑ ㅒ ㅕ ㅖ ㅛ ㅠ ㅣ
    const out = [ch];
    if (cho === 5) out.push(compose(iVowel ? 11 : 2));       // ㄹ -> ㅇ(이 계열) / ㄴ
    else if (cho === 2 && iVowel) out.push(compose(11));      // ㄴ -> ㅇ (녀 -> 여)
    return out;
}

const CHAIN_START_WORDS = ['사과', '나무', '바다', '하늘', '기차', '학교', '친구', '음악', '고양이', '자동차', '여행', '도서관'];
const dictCache = new Map();

// 표준국어대사전 검사. 반환: true(사전에 있음) / false(없음) / null(검사 못 함: 키 없음·서버 오류)
//  - CHAIN_STRICT_DICT=true 면 검사 못 했을 때 null 을 돌려줘서 단어를 인정하지 않음
//  - false 면 예전처럼 검사 못 했을 때 통과(true)
async function checkDictionary(word) {
    const unknown = CONFIG.CHAIN_STRICT_DICT ? null : true;
    if (!STDICT_KEY) return unknown;
    if (dictCache.has(word)) return dictCache.get(word);
    try {
        const url = `https://stdict.korean.go.kr/api/search.do?key=${encodeURIComponent(STDICT_KEY)}` +
                    `&q=${encodeURIComponent(word)}&req_type=json&type_search=search&method=exact`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return unknown;
        const text = (await res.text()).trim();
        let items = [];
        if (text) {
            const data = JSON.parse(text);
            if (data?.error) { // 키 오류 등
                console.error('표준국어대사전 API 오류:', JSON.stringify(data.error));
                return unknown;
            }
            items = data?.channel?.item || [];
            if (!Array.isArray(items)) items = [items];
        }
        const found = items.some(it =>
            String(it.word || '').replace(/[-^·\s\d]/g, '') === word && (!it.pos || String(it.pos).includes('명사'))
        );
        dictCache.set(word, found);
        return found;
    } catch (err) {
        console.error('사전 검사 실패:', err.message);
        return unknown;
    }
}

// ==================== 끝말잇기: 한방 단어 금지 / 봇 단어장 ====================
// 한방 단어: 끝 글자가 CONFIG.CHAIN_BANNED_ENDINGS 에 있는 단어
const isBannedWord = word => CONFIG.CHAIN_BANNED_ENDINGS.some(e => word.endsWith(e));

// 봇이 쓰는 기본 단어장 (표준국어대사전 키가 없어도 봇전이 가능하도록 내장). 더 추가하고 싶으면 아래 문자열에 단어만 붙여넣으세요.
const BOT_WORD_LIST = `
가방 가위 가수 가족 가을 가격 가게 가구 가마 가발 가스 가지 가슴 가정 가로수 가로등 가습기 가오리 가시나무
나무 나비 나라 나이 나팔 나침반 나그네 나룻배 나사 나물 나이프 나팔꽃 나무꾼 낙타 낙엽 낚시 난로 남자 낭떠러지 낫 낮잠
다리 다람쥐 다이어리 다리미 다방 다락 다도 다시마 다이아몬드 단추 달력 달걀 달팽이 담요 당근 대문 대나무 대통령 대추 댄서 더위 도서관
도시 도로 도토리 도마뱀 도깨비 도장 도끼 도넛 도둑 도화지 독수리 돌고래 돌다리 동물 동네 동전 동굴 동화책 동생 돼지 된장 두부 두더지 두루미 두레박
라디오 라면 라이터 라켓 라벨 라일락 라이벌 로봇 로켓 로션 로또 리본 리모컨 리어카 리듬 레몬 레코드 레이저
마을 마늘 마차 마당 마스크 마술 마법 마음 마라톤 마이크 마루 마녀 마스코트 막걸리 만두 만화 만년필 말미잘 망원경 망고 맥주 메달 메뚜기 메아리 멜론 면도기
모자 모기 모래 모닥불 모니터 모델 모험 모서리 모종삽 목걸이 목도리 목욕탕 목수 몽둥이 무지개 무릎 무당벌레 무궁화 무대 무역 무화과 문어 문방구 문제 물고기 물감 물결 물방울 물병 물안경 뭉게구름
미끄럼틀 미역 미소 미용실 미술관 미로 미꾸라지 민들레 믹서기
바다 바람 바나나 바구니 바위 바늘 바닥 바둑 바지 바이올린 바퀴 바닷가 바다표범 박물관 박수 반지 반딧불 발가락 발자국 밤하늘 밥솥 방학 방울 방패 방석 방송국 배추 배구 배낭 배꼽 배달 배우 백조 백화점 뱀장어 버스 버섯 번개 벌레 벚꽃 별똥별 별빛 별자리 병아리 보리 보름달 보물 보자기 보석 보트 복숭아 볼펜 봉투 부엌 부채 부모 부엉이 부자 북극곰 분수 불꽃 불고기 불빛 붓 비행기 비누 비밀 비둘기 비빔밥 비옷 빗자루 빵집
사과 사자 사슴 사탕 사진 사전 사람 사다리 사막 사랑 사이다 사무실 사거리 산책 산타 산호 산토끼 산골 상자 상추 상어 상점 새우 새벽 새싹 새장 생일 생선 생강 생활 서점 서랍 서울 서리 선물 선생님 선풍기 선인장 선반 세탁기 세수 세계 세월 소나무 소금 소풍 소나기 소방차 소라 소포 소파 속옷 손수건 손톱 솜사탕 수박 수영 수건 수첩 수염 수족관 수저 숙제 순두부 숟가락 숲속 스케이트 스키 스웨터 스피커 시계 시장 시소 시내 시골 시금치 시냇물 식탁 신발 신문 신호등 신랑 실내화 심장 쌀밥 쌀국수 쌍둥이 쓰레기 쓰레받기 씨앗
아침 아기 아이 아버지 아파트 아궁이 아가씨 아이스크림 아이디어 악기 안경 안개 안방 알약 앨범 앵무새 야구 야자수 약국 양말 양파 양초 양배추 어린이 어머니 어항 어깨 어부 얼음 에어컨 엘리베이터 여름 여우 여행 여자 여권 연필 연못 연극 연기 연꽃 연탄 열쇠 영화 오리 오이 오징어 오토바이 오렌지 옥수수 옥상 온도계 온천 옷장 우산 우유 우체국 우주 우표 우동 우물 운동장 운동화 운전사 원숭이 원피스 유리 유치원 유모차 은행 은하수 은반지 음악 음식 음료수 의자 의사 이불 이마 이름 이웃 이사 이야기 이삿짐 인형 인사 인삼 인터넷 일기 일요일 일출 임금 입술 입구 입학
자동차 자전거 자유 자석 자두 자라 자판기 자랑 자갈 자장면 자동문 작대기 잔디 잠자리 잠옷 장갑 장난감 장미 장독 장마 재료 재채기 저울 전화 전구 전봇대 전철 젓가락 정원 정글 정거장 제비 제주도 조개 조약돌 조각 주머니 주전자 주사위 주차장 줄넘기 중학생 지도 지갑 지구 지우개 지하철 지붕 지팡이 진주 진달래 질문 집게 짜장면 쪽지 찌개
차표 차이 차도 차량 차례 차고 차창 참새 참외 창문 창고 책상 책가방 책장 처마 천둥 천장 천사 청소 청바지 체육관 초콜릿 초원 초록 초승달 초대 축구 축제 춤 치마 치약 치즈 치킨 친구 침대 침묵 칫솔
카메라 카레 카페 카드 카펫 카누 카네이션 칼국수 칼 캐릭터 캠핑 커피 커튼 컴퓨터 컵라면 케이크 코끼리 코스모스 코트 콩나물 콧물 크레파스 크리스마스 키위 키보드
타조 타이어 타자기 타일 타워 탁자 탑승 태양 택시 터널 토끼 토마토 토요일 통나무 통닭 트럭 튤립 티셔츠 팽이 팔찌
파도 파리 파랑 파마 파인애플 파일 파티 파라솔 팥빙수 편지 포도 포크 포장 풍선 풀잎 피리 피아노 피자 필통 핑크
하늘 하마 하루 하품 하모니카 학교 학생 한복 한강 한글 할머니 할아버지 해바라기 해적 해삼 해변 해초 햇빛 햄버거 행복 행성 향기 허리 호랑이 호수 호박 호떡 호두 홍시 홍차 화분 화장실 화산 화단 확성기 환자 회사 회전목마 후추 후라이팬 휴지 휴대폰 흙 희망 힘
고양이 고래 고구마 고추 고향 고속도로 고사리 고기 고무신 구름 구두 구슬 구멍 구급차 구두쇠 기차 기타 기린 기름 기억 기와 기러기 기둥 기쁨 기숙사 노래 노을 노트 노인 노루 노트북 눈사람 눈썹 눈물 누나 누룽지 녹차 농부 농구
`;
const BOT_WORDS = [...new Set(BOT_WORD_LIST.split(/\s+/).filter(w => /^[가-힣]{2,8}$/.test(w) && !isBannedWord(w)))];
const BOT_INDEX = new Map(); // 첫 글자 -> 단어들
for (const w of BOT_WORDS) {
    if (!BOT_INDEX.has(w[0])) BOT_INDEX.set(w[0], []);
    BOT_INDEX.get(w[0]).push(w);
}

// (선택) 표준국어대사전에서 특정 글자로 시작하는 명사 목록을 가져와 봇 단어를 늘림. 키가 없으면 빈 배열
const stdictWordCache = new Map();
async function fetchStdictWords(ch) {
    if (!STDICT_KEY) return [];
    if (stdictWordCache.has(ch)) return stdictWordCache.get(ch);
    try {
        const url = `https://stdict.korean.go.kr/api/search.do?key=${encodeURIComponent(STDICT_KEY)}` +
                    `&q=${encodeURIComponent(ch)}&req_type=json&type_search=search&method=start&num=100`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return [];
        const data = JSON.parse(await res.text());
        let items = data?.channel?.item || [];
        if (!Array.isArray(items)) items = [items];
        const words = [];
        for (const it of items) {
            const w = String(it.word || '').replace(/[-^·\s\d]/g, '');
            if (/^[가-힣]{2,8}$/.test(w) && w[0] === ch && (!it.pos || String(it.pos).includes('명사'))) words.push(w);
        }
        stdictWordCache.set(ch, words);
        return words;
    } catch (err) {
        console.error('봇 단어 불러오기 실패(내장 단어장만 사용):', err.message);
        return [];
    }
}

// ==================== 메인 ====================
function setupExtras(client, ctx) {
    const { addPoints, getPointUser, parseId, sleep, isOwnerId, isAllowed } = ctx;

    const economy = createStore('economy.json', () => ({ guilds: {} }));   // { guilds: { 서버ID: { 유저ID: { lastDaily, streak } } } }
    const settings = createStore('settings.json', () => ({ guilds: {} })); // { guilds: { 서버ID: { logChannel, welcomeChannel, welcomeMsg } } }

    const getEco = (gid, uid) => {
        const g = (economy.data.guilds[gid] ||= {});
        return (g[uid] ||= { lastDaily: '', streak: 0 });
    };
    const getSet = gid => (settings.data.guilds[gid] ||= {});

    // ---------------------------------------------------------------
    // 통화 시간 집계 (로그 표시용)
    // ---------------------------------------------------------------
    const voiceTime = createStore('voicetime.json', () => ({ guilds: {} })); // { guilds: { 서버ID: { 유저ID: 누적ms } } }
    const voiceJoinAt = new Map(); // "서버ID-유저ID" -> 현재 채널 입장 시각
    const voiceLive = new Map();   // "서버ID-유저ID" -> { userId, channelId, joinedAt, base, message } (실시간 갱신 중인 로그)

    const vKey = (gid, uid) => `${gid}-${uid}`;
    const getVoiceTotal = (gid, uid) => voiceTime.data.guilds[gid]?.[uid] || 0;
    const addVoiceTotal = (gid, uid, ms) => {
        if (ms <= 0) return;
        const g = (voiceTime.data.guilds[gid] ||= {});
        g[uid] = (g[uid] || 0) + ms;
        voiceTime.save();
    };
    // 1시간 이상이면 "125분 (2시간 5분)" 형태로 표시
    const fmtMinutes = ms => {
        const min = Math.floor(ms / 60000);
        if (min < 60) return `${fmt(min)}분`;
        return `${fmt(min)}분 (${Math.floor(min / 60)}시간 ${min % 60}분)`;
    };

    // 봇이 켜질 때 이미 통화방에 있는 사람도 집계 시작
    client.once(Events.ClientReady, () => {
        const now = Date.now();
        for (const guild of client.guilds.cache.values()) {
            for (const vs of guild.voiceStates.cache.values()) {
                if (vs.channelId && vs.member && !vs.member.user.bot) voiceJoinAt.set(vKey(guild.id, vs.id), now);
            }
        }
    });

    // ---------------------------------------------------------------
    // 2) 로그 / 환영 헬퍼
    // ---------------------------------------------------------------
    const DEFAULT_WELCOME =
        '{유저}님, **{서버명}**에 오신 것을 환영합니다.\n' +
        '⚜️ 이곳에서 새로운 동료를 만나고\n' +
        '📜 새로운 전설을 만들어가시길 바랍니다.\n' +
        '조직의 일원이 되신 것을 진심으로 환영합니다.';
    // {유저}/{user}, {서버명}/{server}, {인원}/{count} 모두 사용 가능
    const fillTemplate = (tpl, member) => tpl
        .replaceAll('{유저}', `<@${member.id}>`).replaceAll('{user}', `<@${member.id}>`)
        .replaceAll('{서버명}', member.guild.name).replaceAll('{server}', member.guild.name)
        .replaceAll('{인원}', String(member.guild.memberCount)).replaceAll('{count}', String(member.guild.memberCount));

    async function sendWelcome(member) {
        const gs = settings.data.guilds[member.guild.id];
        if (!gs?.welcomeChannel) return;
        const ch = member.guild.channels.cache.get(gs.welcomeChannel);
        if (!ch) return;
        const embed = new EmbedBuilder()
            .setColor(0xff9ff3)
            .setTitle('🏢 새로운 사람이 조직에 입성했습니다.')
            .setDescription(fillTemplate(gs.welcomeMsg || DEFAULT_WELCOME, member))
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .setTimestamp();
        await ch.send({ content: `<@${member.id}>`, embeds: [embed], allowedMentions: { users: [member.id] } })
            .catch(err => console.error('환영 메시지 전송 실패:', err.message));
    }

    const logEmbed = (color, title) => new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
    // 로그 채널에 전송. 성공하면 보낸 메시지를 돌려줘요 (실시간 수정용), 실패/미설정이면 null
    async function sendLog(guild, embed) {
        const id = settings.data.guilds[guild.id]?.logChannel;
        if (!id) return null;
        const ch = guild.channels.cache.get(id);
        if (!ch) return null;
        return ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
    }

    const isTextChannel = ch => ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement);
    const botCanSend = (guild, ch) => ch.permissionsFor(guild.members.me)?.has([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    ]);


        // 입금/출금 내역 채널로 전송. kind: '송금' | '후원' (입금채널) / '출금' 계열은 출금채널 우선
    async function sendTransferLog(guild, { userId, amount, kind, text }, channelKey = 'depositChannel') {
        const gs = settings.data.guilds[guild.id];
        const chId = channelKey === 'withdrawChannel' ? (gs?.withdrawChannel || gs?.depositChannel) : gs?.depositChannel;
        const ch = chId && guild.channels.cache.get(chId);
        if (!ch || !isTextChannel(ch) || !botCanSend(guild, ch)) return false;
        const embed = new EmbedBuilder()
            .setColor(kind === '후원' ? 0xf1c40f : 0x3498db)
            .setTitle(`💸 ${kind} 내역`)
            .addFields(
                { name: '출금자 ID', value: `<@${userId}>\n\`${userId}\``, inline: true },
                { name: '출금액', value: `${fmt(amount)}P`, inline: true },
                { name: `${kind} 메세지`, value: clip(text, 900) || kind, inline: false },
            )
            .setTimestamp();
        return ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
    }


    // ---------------------------------------------------------------
    // 생일 등록 / 당일 밤 12시(자정, 한국 시간) 축하 메시지
    // ---------------------------------------------------------------
    const birthdays = createStore('birthdays.json', () => ({ guilds: {} })); // { guilds: { 서버ID: { 키: { name, userId, month, day, registeredBy, channelId, lastWished } } } }

    const daysInMonth = month => new Date(Date.UTC(2024, month, 0)).getUTCDate(); // 2월은 29일까지 허용(윤년 기준)
    const isLeapYear = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    // 오늘(KST)이 이 생일인지. 2/29생은 평년에는 2/28에 축하
    const isBirthdayToday = (e, now = new Date(Date.now() + KST_OFFSET)) => {
        const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1, d = now.getUTCDate();
        if (e.month === m && e.day === d) return true;
        return e.month === 2 && e.day === 29 && !isLeapYear(y) && m === 2 && d === 28;
    };

    // "[닉네임]" 부분 -> { targetId, name, key }  (멘션/ID면 그 유저, 아니면 글자 그대로의 닉네임, 비었으면 본인)
    async function resolveBirthdayWho(message, tokens) {
        const text = tokens.join(' ').trim();
        let targetId = null;
        if (!text) targetId = message.author.id;
        else if (message.mentions.users.first()) targetId = message.mentions.users.first().id;
        else if (tokens.length === 1 && parseId(tokens[0])) targetId = parseId(tokens[0]);

        if (targetId) {
            const member = await message.guild.members.fetch(targetId).catch(() => null);
            if (!member) return { error: '이 서버에서 해당 사용자를 찾을 수 없어요.' };
            if (member.user.bot) return { error: '봇의 생일은 등록할 수 없어요 🤖' };
            return { targetId, name: member.displayName, key: `u${targetId}` };
        }
        if (text.length > 30) return { error: '닉네임은 30자 이내로 입력해주세요.' };
        return { targetId: null, name: text, key: `n${text.toLowerCase().replace(/\s+/g, '')}` };
    }

    async function sendBirthday(guild, e) {
        const gs = settings.data.guilds[guild.id];
        const ch = guild.channels.cache.get(gs?.birthdayChannel) || guild.channels.cache.get(e.channelId) || guild.systemChannel;
        if (!ch || !isTextChannel(ch) || !botCanSend(guild, ch)) return;

        let name = e.name;
        if (e.userId) {
            const member = await guild.members.fetch(e.userId).catch(() => null);
            if (!member) return; // 서버를 나간 사람은 건너뜀
            name = member.displayName;
        }
        const wishes = [
            `오늘은 **${name}**님의 특별한 날이에요! 모두 함께 축하해 주세요 🥳`,
            `**${name}**님, 생일 진심으로 축하드려요! 오늘 하루 행복하고 즐거운 일만 가득하길 바라요 🎉`,
            `🎈 **${name}**님의 생일을 축하합니다! 맛있는 거 많이 드시고 좋은 하루 보내세요 🍰`,
        ];
        let desc = wishes[Math.floor(Math.random() * wishes.length)];
        if (e.userId && CONFIG.BIRTHDAY_REWARD > 0) {
            addPoints(guild.id, e.userId, CONFIG.BIRTHDAY_REWARD, 'manual');
            desc += `\n\n🎁 생일 선물로 **${fmt(CONFIG.BIRTHDAY_REWARD)}P**를 드렸어요!`;
        }
        const embed = new EmbedBuilder()
            .setColor(0xff6b9d)
            .setTitle('🎂 생일 축하합니다!')
            .setDescription(desc)
            .setFooter({ text: `${e.month}월 ${e.day}일` })
            .setTimestamp();
        await ch.send({
            content: e.userId ? `<@${e.userId}>` : undefined,
            embeds: [embed],
            allowedMentions: { users: e.userId ? [e.userId] : [] },
        }).catch(err => console.error('생일 메시지 전송 실패:', err.message));
    }

    let birthdayRunning = false;
    async function runBirthdays() {
        if (birthdayRunning || !client.isReady()) return;
        const now = new Date(Date.now() + KST_OFFSET);
        if (now.getUTCHours() < CONFIG.BIRTHDAY_HOUR) return; // 아직 설정한 시각 전 (자정이면 항상 통과)
        birthdayRunning = true;
        try {
            const today = dayKey();
            for (const [gid, entries] of Object.entries(birthdays.data.guilds)) {
                const guild = client.guilds.cache.get(gid);
                if (!guild) continue;
                for (const e of Object.values(entries)) {
                    if (e.lastWished === today || !isBirthdayToday(e, now)) continue;
                    e.lastWished = today; // 먼저 표시해서 중복 전송 방지 (봇이 자정에 꺼져 있었어도 켜지면 그날 안에 보내줌)
                    birthdays.save();
                    await sendBirthday(guild, e);
                    await sleep(500);
                }
            }
        } finally {
            birthdayRunning = false;
        }
    }
    setInterval(() => runBirthdays().catch(err => console.error('생일 알림 오류:', err)), 30 * 1000);

    // ---------------------------------------------------------------
    // 레벨링 (채팅 + 통화 경험치)
    // ---------------------------------------------------------------
    const levels = createStore('levels.json', () => ({ guilds: {} })); // { guilds: { 서버ID: { 유저ID: { xp, chat, voice } } } }
    const levelChatCd = new Map(); // "서버ID-유저ID" -> 마지막 경험치 지급 시각
    const nickSyncing = new Set(); // 닉네임 일괄 갱신이 진행 중인 서버

    // 레벨 L -> L+1 에 필요한 경험치 (레벨이 오를수록 점점 많이 필요)
    const xpForLevel = l => 5 * l * l + 50 * l + 100;
    function levelInfo(xp) {
        let level = 0, cur = xp;
        while (cur >= xpForLevel(level)) { cur -= xpForLevel(level); level++; }
        return { level, cur, need: xpForLevel(level) };
    }
    const getLv = (gid, uid) => {
        const g = (levels.data.guilds[gid] ||= {});
        return (g[uid] ||= { xp: 0, chat: 0, voice: 0 });
    };
    const peekLv = (gid, uid) => levels.data.guilds[gid]?.[uid] || { xp: 0, chat: 0, voice: 0 };

    async function announceLevelUp(guild, uid, level, fallbackChannel) {
        const gs = settings.data.guilds[guild.id];
        const ch = guild.channels.cache.get(gs?.levelChannel) || fallbackChannel || guild.systemChannel;
        if (!ch || !isTextChannel(ch) || !botCanSend(guild, ch)) return;
        let text = `🎉 <@${uid}> 님이 **Lv.${level}** 이(가) 되었어요! 축하합니다!`;
        if (CONFIG.LEVEL_UP_POINTS > 0) text += ` (+${fmt(CONFIG.LEVEL_UP_POINTS)}P)`;
        await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
    }

    // ---- 레벨 말머리 닉네임: "[Lv.5] 원래닉네임" ----
    const escapeRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const NICK_PREFIX_RE = new RegExp('^' + escapeRe(CONFIG.LEVEL_NICK_FORMAT).replace(escapeRe('{level}'), '\\d+') + '\\s*');
    const nickPrefix = level => CONFIG.LEVEL_NICK_FORMAT.replace('{level}', String(level)) + ' ';
    const nickWarned = new Set(); // 권한 문제 경고를 서버당 한 번만 로그로 남기기

    // 멤버 닉네임을 레벨에 맞게 바꿈. level 이 null 이면 말머리를 제거. 반환: 'ok' | 'skip' | 'fail'
    async function setLevelNick(member, level) {
        if (member.user.bot || member.id === member.guild.ownerId || !member.manageable) return 'skip';
        const globalName = member.user.globalName || member.user.username;
        const base = ((member.nickname || globalName).replace(NICK_PREFIX_RE, '').trim()) || globalName;
        let next;
        if (level == null) next = base === globalName ? null : base; // 말머리만 제거 (원래 닉네임이 없었으면 닉네임 해제)
        else next = (nickPrefix(level) + base).slice(0, 32); // 닉네임 최대 32자
        if ((member.nickname ?? null) === next) return 'skip';
        try {
            await member.setNickname(next, level == null ? '레벨 말머리 제거' : `레벨 ${level} 달성`);
            return 'ok';
        } catch (err) {
            if (!nickWarned.has(member.guild.id)) {
                nickWarned.add(member.guild.id);
                console.error(`[${member.guild.name}] 닉네임 변경 실패: ${err.message} (봇에게 '닉네임 관리' 권한이 있고, 봇 역할이 멤버 역할보다 위에 있어야 해요)`);
            }
            return 'fail';
        }
    }

    // 이 멤버에게 레벨 닉네임을 적용할지: 멤버별 설정(켜기/끄기 @멘션)이 있으면 그걸 따르고, 없으면 서버 전체 설정을 따름
    const isNickOn = (gs, uid) => (gs?.levelNickUsers?.[uid] ?? gs?.levelNick) === true;

    async function updateLevelNick(guild, uid, level) {
        if (!isNickOn(settings.data.guilds[guild.id], uid)) return;
        const member = await guild.members.fetch(uid).catch(() => null);
        if (member) await setLevelNick(member, level);
    }

    // source: 'chat' | 'voice'
    function addXp(guild, uid, amount, source, fallbackChannel = null) {
        const u = getLv(guild.id, uid);
        const before = levelInfo(u.xp).level;
        u.xp += amount;
        u[source] = (u[source] || 0) + amount;
        levels.save();
        const after = levelInfo(u.xp).level;
        if (after > before) {
            if (CONFIG.LEVEL_UP_POINTS > 0) addPoints(guild.id, uid, CONFIG.LEVEL_UP_POINTS * (after - before), 'manual');
            announceLevelUp(guild, uid, after, fallbackChannel);
            updateLevelNick(guild, uid, after);
        }
    }

    function giveChatXp(message) {
        const key = `${message.guild.id}-${message.author.id}`;
        const now = Date.now();
        if (now - (levelChatCd.get(key) || 0) < CONFIG.LEVEL_CHAT_COOLDOWN_MS) return;
        levelChatCd.set(key, now);
        const amount = CONFIG.LEVEL_CHAT_XP_MIN + Math.floor(Math.random() * (CONFIG.LEVEL_CHAT_XP_MAX - CONFIG.LEVEL_CHAT_XP_MIN + 1));
        addXp(message.guild, message.author.id, amount, 'chat', message.channel);
    }

    // 통화방 경험치: 1분마다 통화방을 훑어서 지급 (혼자 있거나 헤드셋을 끈 사람, 잠수방은 제외)
    setInterval(() => {
        for (const guild of client.guilds.cache.values()) {
            for (const channel of guild.channels.cache.values()) {
                if (channel.type !== ChannelType.GuildVoice || channel.id === guild.afkChannelId) continue;
                const humans = channel.members.filter(m => !m.user.bot);
                if (humans.size < 2) continue;
                for (const m of humans.values()) {
                    if (m.voice.selfDeaf || m.voice.serverDeaf) continue;
                    addXp(guild, m.id, CONFIG.LEVEL_VOICE_XP, 'voice');
                }
            }
        }
    }, 60 * 1000);

    // ---------------------------------------------------------------
    // 통화방 상주: 봇이 지정한 음성 채널에 계속 들어가 있어요 (끊기거나 봇을 껐다 켜도 자동으로 다시 들어감)
    //  - 필요한 패키지: npm install @discordjs/voice tweetnacl
    // ---------------------------------------------------------------
    let voiceLib = null;
    try { voiceLib = require('@discordjs/voice'); } catch { /* 설치 안 됐으면 이 기능만 비활성 */ }
    const VOICE_LIB_MSG = '통화방 상주에는 `@discordjs/voice` 패키지가 필요해요. 터미널에서 `npm install @discordjs/voice tweetnacl` 를 실행하고 봇을 다시 켜주세요.';
    const stayTimers = new Map(); // 서버ID -> 다시 들어가기 예약 타이머

    // 음성 채널에 들어가기. 반환: { ok, channel } | { ok:false, error, gone? }
    async function joinStay(guild, channelId) {
        if (!voiceLib) return { ok: false, error: VOICE_LIB_MSG };
        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.type !== ChannelType.GuildVoice) return { ok: false, error: '음성 채널을 찾을 수 없어요.', gone: true };
        const perms = channel.permissionsFor(guild.members.me);
        if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
            return { ok: false, error: '봇이 그 채널을 보거나 입장할 권한(채널 보기 / 연결)이 없어요.' };
        }
        const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } = voiceLib;
        getVoiceConnection(guild.id)?.destroy(); // 이미 연결이 있으면 정리하고 새로 연결

        const connection = joinVoiceChannel({
            channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true, selfMute: true, // 소리를 듣거나 내지 않고 그냥 앉아만 있어요
        });
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try { // 잠깐 끊긴 거면 스스로 다시 연결될 때까지 기다림
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                ]);
            } catch { // 안 돌아오면 정리 -> Destroyed 에서 다시 들어가기 예약
                try { connection.destroy(); } catch { /* 이미 정리됨 */ }
            }
        });
        connection.on(VoiceConnectionStatus.Destroyed, () => scheduleRejoin(guild));
        connection.on('error', err => console.error(`[${guild.name}] 음성 연결 오류:`, err.message));
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 20000);
            return { ok: true, channel };
        } catch {
            try { connection.destroy(); } catch { /* 이미 정리됨 */ }
            return { ok: false, error: '통화방에 연결하지 못했어요. 잠시 후 다시 시도해주세요.' };
        }
    }

    // 저장된 상주 채널이 있는데 연결이 없으면 잠시 뒤 다시 들어감 (안 되면 30초마다 재시도)
    function scheduleRejoin(guild, delay = 5000) {
        if (!settings.data.guilds[guild.id]?.stayChannel || stayTimers.has(guild.id)) return;
        stayTimers.set(guild.id, setTimeout(async () => {
            stayTimers.delete(guild.id);
            const chId = settings.data.guilds[guild.id]?.stayChannel;
            if (!chId || !voiceLib) return;
            const existing = voiceLib.getVoiceConnection(guild.id);
            if (existing && existing.state.status !== voiceLib.VoiceConnectionStatus.Destroyed) return; // 이미 연결돼 있음
            const r = await joinStay(guild, chId);
            if (r.ok) return;
            if (r.gone) { // 채널이 삭제됐다면 상주 해제
                delete settings.data.guilds[guild.id].stayChannel;
                settings.save();
                return;
            }
            console.error(`[${guild.name}] 통화방 다시 들어가기 실패: ${r.error}`);
            scheduleRejoin(guild, 30000);
        }, delay));
    }

    // 봇이 켜질 때 저장된 통화방에 자동으로 들어감
    client.once(Events.ClientReady, async () => {
        for (const guild of client.guilds.cache.values()) {
            const chId = settings.data.guilds[guild.id]?.stayChannel;
            if (!chId) continue;
            const r = await joinStay(guild, chId);
            if (r.ok) continue;
            console.error(`[${guild.name}] 통화방 상주 시작 실패: ${r.error}`);
            if (r.gone) { delete settings.data.guilds[guild.id].stayChannel; settings.save(); }
            else scheduleRejoin(guild, 30000);
        }
    });

    // 봇이 쫓겨나거나 다른 방으로 옮겨진 경우
    client.on(Events.VoiceStateUpdate, (oldS, newS) => {
        if (newS.id !== client.user?.id) return;
        const gs = settings.data.guilds[newS.guild.id];
        if (!gs?.stayChannel) return;
        if (!newS.channelId) return scheduleRejoin(newS.guild);      // 연결이 끊김/강퇴 -> 다시 들어감
        if (newS.channelId !== gs.stayChannel) {                      // 관리자가 다른 방으로 옮김 -> 그 방을 새 상주 채널로
            gs.stayChannel = newS.channelId;
            settings.save();
        }
    });

    // ---------------------------------------------------------------
    // 2) 로그/환영 이벤트
    // ---------------------------------------------------------------
    client.on(Events.GuildMemberAdd, async member => {
        if (!member.user.bot) await sendWelcome(member);
        sendLog(member.guild, logEmbed(0x2ecc71, '📥 멤버 입장')
            .setDescription(`<@${member.id}> (${member.user.username})${member.user.bot ? ' 🤖' : ''}`)
            .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
            .addFields(
                { name: '계정 생성', value: `<t:${unix(member.user.createdTimestamp)}:R>`, inline: true },
                { name: '현재 인원', value: `${fmt(member.guild.memberCount)}명`, inline: true },
            ));
    });

    client.on(Events.GuildMemberRemove, member => {
        const roles = member.roles?.cache
            ?.filter(r => r.id !== member.guild.id)
            .map(r => `<@&${r.id}>`).join(' ') || '없음';
        sendLog(member.guild, logEmbed(0xe74c3c, '📤 멤버 퇴장')
            .setDescription(`<@${member.id}> (${member.user.username})`)
            .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
            .addFields(
                { name: '서버 가입', value: member.joinedTimestamp ? `<t:${unix(member.joinedTimestamp)}:R>` : '알 수 없음', inline: true },
                { name: '현재 인원', value: `${fmt(member.guild.memberCount)}명`, inline: true },
                { name: '역할', value: clip(roles, 500) },
            ));
    });

    client.on(Events.MessageDelete, message => {
        const guild = message.guild;
        if (!guild || message.author?.bot) return;
        const embed = logEmbed(0xe74c3c, '🗑️ 메시지 삭제')
            .setDescription(`${message.author ? `<@${message.author.id}> · ` : ''}<#${message.channelId}>`)
            .addFields({ name: '내용', value: clip(message.content) || '(내용 없음 또는 알 수 없음)' });
        if (message.attachments?.size) {
            embed.addFields({ name: '첨부파일', value: clip(message.attachments.map(a => a.name).join('\n'), 500) });
        }
        sendLog(guild, embed);
    });

    client.on(Events.MessageBulkDelete, (messages, channel) => {
        if (!channel.guild) return;
        sendLog(channel.guild, logEmbed(0xe67e22, '🧹 메시지 일괄 삭제')
            .setDescription(`<#${channel.id}> 에서 **${messages.size}개** 메시지가 일괄 삭제됐어요.`));
    });

    client.on(Events.MessageUpdate, (oldMsg, newMsg) => {
        const guild = newMsg.guild;
        if (!guild || newMsg.author?.bot) return;
        // 이전/이후 내용을 모르거나 내용이 같으면(링크 미리보기 등) 무시
        if (oldMsg.partial || oldMsg.content == null || newMsg.content == null || oldMsg.content === newMsg.content) return;
        sendLog(guild, logEmbed(0xf1c40f, '✏️ 메시지 수정')
            .setDescription(`<@${newMsg.author.id}> · <#${newMsg.channelId}> · [메시지로 이동](${newMsg.url})`)
            .addFields(
                { name: '수정 전', value: clip(oldMsg.content, 900) || '(없음)' },
                { name: '수정 후', value: clip(newMsg.content, 900) || '(없음)' },
            ));
    });

    client.on(Events.GuildMemberUpdate, (oldM, newM) => {
        if (oldM.partial) return;
        const now = Date.now();
        const oldT = oldM.communicationDisabledUntilTimestamp;
        const newT = newM.communicationDisabledUntilTimestamp;

        if (newT && newT > now && newT !== oldT) {
            sendLog(newM.guild, logEmbed(0xe67e22, '⏱️ 타임아웃')
                .setDescription(`<@${newM.id}> 님이 타임아웃 됐어요.\n해제 예정: <t:${unix(newT)}:F> (<t:${unix(newT)}:R>)`));
        } else if (oldT && oldT > now && !newT) {
            sendLog(newM.guild, logEmbed(0x2ecc71, '✅ 타임아웃 해제')
                .setDescription(`<@${newM.id}> 님의 타임아웃이 해제됐어요.`));
        }

        const added = newM.roles.cache.filter(r => !oldM.roles.cache.has(r.id));
        const removed = oldM.roles.cache.filter(r => !newM.roles.cache.has(r.id));
        if (added.size || removed.size) {
            const embed = logEmbed(0x9b59b6, '🏷️ 역할 변경').setDescription(`<@${newM.id}>`);
            if (added.size) embed.addFields({ name: '추가', value: added.map(r => `<@&${r.id}>`).join(' ') });
            if (removed.size) embed.addFields({ name: '제거', value: removed.map(r => `<@&${r.id}>`).join(' ') });
            sendLog(newM.guild, embed);
        }
    });

        // ---------------------------------------------------------------
    // 함정 채널: 지정 채널에 메시지를 보낸 사람은 즉시 추방
    //  - 제외: OWNER_IDS, 봇 본인 / 다른 봇 계정과 일반 유저는 구분하지 않고 추방
    //  - 메시지 삭제 여부와 상관없이, 감지되면 추방 시도
    //  - DM은 대상 아님
    // ---------------------------------------------------------------
    client.on(Events.MessageCreate, async message => {
        try {
            if (!message.guild) return;                                    // DM 제외
            const gs = settings.data.guilds[message.guild.id];
            if (!gs?.trapChannel || message.channelId !== gs.trapChannel) return;
            if (message.author.id === client.user.id) return;              // 봇 본인 제외
            if (isOwnerId(message.author.id)) return;                      // 관리자 제외
            if (message.webhookId) return;                                 // 웹훅은 멤버가 아니라 추방 불가

            const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
            if (!member) return;                                           // 이미 서버를 나간 경우

            if (!member.kickable) {
                sendLog(message.guild, logEmbed(0xe67e22, '⚠️ 함정 채널 추방 실패')
                    .setDescription(`<@${member.id}> (${member.user.username})\n추방 권한이 없거나 봇보다 높은 역할이에요.`));
                return;
            }

            await member.kick('함정 채널에 메시지 작성');
            sendLog(message.guild, logEmbed(0xe74c3c, '🪤 함정 채널 추방')
                .setDescription(`<@${member.id}> (${member.user.username})${member.user.bot ? ' 🤖' : ''}`)
                .addFields({ name: '채널', value: `<#${message.channelId}>`, inline: true }));
        } catch (err) {
            console.error('함정 채널 처리 오류:', err.message);
        }
    });

        // ---------------------------------------------------------------
    // 반응 인증: 인증 메시지에 반응하면 역할 지급 / 반응 취소하면 회수
    // ---------------------------------------------------------------
    const VERIFY_EMOJI = '✅';
    const VERIFY_REMOVE_ON_UNREACT = true; // false면 반응을 취소해도 역할을 유지

    async function handleVerifyReaction(reaction, user, add) {
        try {
            if (user.bot) return;
            if (reaction.partial) await reaction.fetch();
            if (reaction.message.partial) await reaction.message.fetch();
            const guild = reaction.message.guild;
            if (!guild) return;

            const gs = settings.data.guilds[guild.id];
            if (!gs?.verifyMessage || reaction.message.id !== gs.verifyMessage) return;
            if (reaction.emoji.name !== VERIFY_EMOJI) return;
            if (!gs.verifyRole) return;
            if (!add && !VERIFY_REMOVE_ON_UNREACT) return;

            const role = guild.roles.cache.get(gs.verifyRole);
            if (!role) return;
            const member = await guild.members.fetch(user.id).catch(() => null);
            if (!member) return;

            if (add) {
                if (!member.roles.cache.has(role.id)) await member.roles.add(role, '반응 인증');
            } else if (member.roles.cache.has(role.id)) {
                await member.roles.remove(role, '반응 인증 취소');
            }
        } catch (err) {
            console.error('반응 인증 처리 오류:', err.message);
        }
    }
    client.on(Events.MessageReactionAdd, (reaction, user) => handleVerifyReaction(reaction, user, true));
    client.on(Events.MessageReactionRemove, (reaction, user) => handleVerifyReaction(reaction, user, false));

    // ---------------------------------------------------------------
    // 실시간 통화 시간 로그
    //  - 입장하면 "통화 중" 메시지를 보내고, 일정 주기마다 그 메시지를 수정해서 시간을 갱신
    //  - 퇴장/이동하면 같은 메시지를 "통화 종료"로 바꿔서 최종 시간을 표시
    // ---------------------------------------------------------------
    // e: 통화 세션 정보. ended=true면 종료 표시
    const liveEmbed = (e, ended, now = Date.now()) => {
        const elapsed = now - e.joinedAt;
        return logEmbed(ended ? 0xe74c3c : 0x2ecc71, ended ? '🎧 통화 종료' : '🎧 통화 중')
            .setDescription(`<@${e.userId}> · <#${e.channelId}>`)
            .addFields(
                { name: ended ? '⏱️ 이번 체류 시간' : '⏱️ 현재 통화 시간', value: fmtMinutes(elapsed), inline: true },
                { name: '📊 총 통화 시간', value: fmtMinutes(e.base + elapsed), inline: true },
                { name: '입장', value: `<t:${unix(e.joinedAt)}:R>`, inline: true },
            );
    };

    // 주기적으로 진행 중인 로그 메시지 수정 (레이트리밋 방지로 사이사이 잠깐 쉼)
    setInterval(async () => {
        for (const e of [...voiceLive.values()]) {
            await e.message.edit({ embeds: [liveEmbed(e, false)], allowedMentions: { parse: [] } }).catch(() => {});
            await sleep(300);
        }
    }, CONFIG.VOICE_LIVE_INTERVAL_MS);

    client.on(Events.VoiceStateUpdate, async (oldS, newS) => {
        const member = newS.member || oldS.member;
        if (!member || member.user.bot) return;
        if (oldS.channelId === newS.channelId) return; // 음소거/헤드셋 변경 등은 무시

        const gid = member.guild.id;
        const uid = member.id;
        const key = vKey(gid, uid);
        const now = Date.now();

        // 1) 이전 채널 세션 마무리 (시간 누적은 LOG_VOICE 설정과 상관없이 항상 집계)
        if (oldS.channelId) {
            let stayMs = 0;
            if (voiceJoinAt.has(key)) {
                stayMs = now - voiceJoinAt.get(key);
                addVoiceTotal(gid, uid, stayMs);
            }
            const live = voiceLive.get(key);
            voiceLive.delete(key);

            if (live) {
                // 실시간으로 갱신하던 메시지를 "통화 종료"로 마무리
                live.message.edit({ embeds: [liveEmbed(live, true, now)], allowedMentions: { parse: [] } }).catch(() => {});
            } else if (CONFIG.LOG_VOICE) {
                // 입장 로그가 없던 경우(봇 재시작 등)엔 종료 로그를 새로 보냄
                const ended = {
                    userId: uid, channelId: oldS.channelId,
                    joinedAt: now - stayMs, base: getVoiceTotal(gid, uid) - stayMs,
                };
                sendLog(member.guild, liveEmbed(ended, true, now));
            }
        }

        // 2) 새 채널 세션 시작
        if (newS.channelId) {
            voiceJoinAt.set(key, now);
            if (!CONFIG.LOG_VOICE) return;

            const e = { userId: uid, channelId: newS.channelId, joinedAt: now, base: getVoiceTotal(gid, uid), message: null };
            const msg = await sendLog(member.guild, liveEmbed(e, false, now));
            if (!msg) return;
            e.message = msg;

            if (voiceJoinAt.get(key) === now) {
                voiceLive.set(key, e); // 아직 그 채널에 있음 -> 실시간 갱신 시작
            } else {
                // 메시지를 보내는 사이에 이미 나갔다면 바로 종료 처리
                msg.edit({ embeds: [liveEmbed(e, true)], allowedMentions: { parse: [] } }).catch(() => {});
            }
        } else {
            voiceJoinAt.delete(key);
        }
    });

    // ---------------------------------------------------------------
    // 3) 끝말잇기
    // ---------------------------------------------------------------
    const chains = new Map(); // channelId -> game

    function armChainTimer(channel, game) {
        clearTimeout(game.timer);
        game.timer = setTimeout(() => onChainTimeout(channel, game), CONFIG.CHAIN_TIMEOUT_MS);
    }

    // ---- 목숨(하트) ----
    const hearts = n => '❤️'.repeat(Math.max(0, n)) + '🖤'.repeat(Math.max(0, CONFIG.CHAIN_LIVES - n));
    const livesOf = (game, uid) => (game.lives.has(uid) ? game.lives.get(uid) : CONFIG.CHAIN_LIVES);
    const nextLetters = game => startVariants(game.lastWord.slice(-1)).join(' / ');
    // 참가자별 남은 목숨 한 줄 (채팅에 계속 띄워줌)
    function heartsLine(game) {
        const list = [...game.lives.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (list.length === 0) return '';
        return list.map(([uid, n]) => (n > 0 ? `<@${uid}> ${hearts(n)}` : `<@${uid}> ☠️`)).join(' · ');
    }

    // 게임이 끝나야 하는 상태인지 확인 (아니면 null)
    function chainEndState(game) {
        const alive = id => livesOf(game, id) > 0;
        if (game.bot) {
            return alive(game.starterId) ? null : { reason: '💀 목숨을 모두 잃었어요!', outcome: 'lives' };
        }
        const contenders = [...game.scores.keys()]; // 단어를 한 번이라도 성공시킨 사람들 (채팅만 한 사람은 제외)
        const aliveC = contenders.filter(alive);
        if (contenders.length >= 2 && aliveC.length <= 1) {
            return { reason: aliveC.length ? `🏆 <@${aliveC[0]}> 님이 마지막까지 살아남았어요!` : '💀 모두 탈락했어요!', outcome: 'last' };
        }
        if (contenders.length === 1 && aliveC.length === 0) return { reason: '💀 목숨을 모두 잃었어요!', outcome: 'lives' };
        return null;
    }

    // 목숨 1개 깎고, 남은 하트를 채팅에 바로 띄움. 탈락/게임 종료까지 처리
    async function loseLife(channel, game, uid, reason) {
        if (chains.get(channel.id) !== game) return;
        const left = Math.max(0, livesOf(game, uid) - 1);
        game.lives.set(uid, left);
        const end = chainEndState(game);

        let text = `💔 <@${uid}> ${reason} 목숨 -1 → ${left > 0 ? hearts(left) : '☠️ **탈락!**'}\n❤️ ${heartsLine(game)}`;
        if (!end) text += `\n➡️ 현재 단어 **${game.lastWord}** → 다음 글자: **${nextLetters(game)}**`;
        await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
        if (end) await endChain(channel, end.reason, end.outcome);
    }

    // 제한 시간 초과: 봇전은 목숨 -1 하고 계속, 여럿이 하는 게임은 종료
    async function onChainTimeout(channel, game) {
        if (chains.get(channel.id) !== game) return;
        if (!game.bot) return endChain(channel, '⏰ 시간이 다 됐어요!');
        armChainTimer(channel, game);
        await loseLife(channel, game, game.starterId, '⏰ 시간 초과!');
    }

    // outcome: 'timeout'(시간 초과) | 'user'(봇전에서 유저 승리) | 'stop'(수동 종료)  -- 봇전에서만 의미 있어요
    async function endChain(channel, reason, outcome = 'timeout') {
        const game = chains.get(channel.id);
        if (!game) return;
        clearTimeout(game.timer);
        chains.delete(channel.id);

        // ---- 봇전 종료 ----
        if (game.bot) {
            const myWords = game.scores.get(game.starterId) || 0;
            let result;
            let footer = '봇전은 포인트가 거의 지급되지 않아요';
            if (outcome === 'user') {
                result = `🎉 <@${game.starterId}> 님의 승리!`;
                if (myWords >= CONFIG.CHAIN_BOT_WIN_MIN_WORDS && CONFIG.CHAIN_BOT_WIN_REWARD > 0) {
                    addPoints(channel.guild.id, game.starterId, CONFIG.CHAIN_BOT_WIN_REWARD, 'manual');
                    result += ` (+${fmt(CONFIG.CHAIN_BOT_WIN_REWARD)}P)`;
                    footer = '봇을 항복시켜서 포인트를 받았어요!';
                } else {
                    footer = `${CONFIG.CHAIN_BOT_WIN_MIN_WORDS}단어 이상 이어야 승리 보상이 지급돼요`;
                }
            } else if (outcome === 'stop') {
                result = '🏁 게임이 종료됐어요.';
            } else if (outcome === 'lives') {
                result = '💀 목숨을 모두 잃었어요... 🤖 봇의 승리!';
            } else {
                result = '🤖 봇의 승리! 시간 안에 단어를 잇지 못했어요.';
            }
            const botWords = game.used.size - 1 - myWords; // 시작 단어 제외
            const embed = new EmbedBuilder()
                .setColor(0x1abc9c)
                .setTitle('🤖 끝말잇기 (봇전) 종료')
                .setDescription(`${result}\n\n👤 내 단어 **${myWords}개** · 🤖 봇 단어 **${Math.max(botWords, 0)}개**\n마지막 단어: **${game.lastWord}**\n❤️ ${heartsLine(game)}`)
                .setFooter({ text: footer });
            return channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
        }

        const rank = [...game.scores.entries()].sort((a, b) => b[1] - a[1]);
        const medals = ['🥇', '🥈', '🥉'];
        const rewarded = rank.length >= 2;

        let lines = '아무도 단어를 잇지 않았어요.';
        if (rank.length > 0) {
            lines = rank.slice(0, 10).map(([uid, n], i) => {
                const reward = rewarded ? Math.min(n, CONFIG.CHAIN_REWARD_MAX_WORDS) * CONFIG.CHAIN_REWARD_PER_WORD : 0;
                const left = livesOf(game, uid);
                return `${medals[i] || `**${i + 1}.**`} <@${uid}> - ${n}단어 · ${left > 0 ? hearts(left) : '☠️'}${reward ? ` (+${fmt(reward)}P)` : ''}`;
            }).join('\n');
        }
        if (rewarded) {
            for (const [uid, n] of rank) {
                const reward = Math.min(n, CONFIG.CHAIN_REWARD_MAX_WORDS) * CONFIG.CHAIN_REWARD_PER_WORD;
                if (reward > 0) addPoints(channel.guild.id, uid, reward, 'manual');
            }
        }

        const embed = new EmbedBuilder()
            .setColor(0x1abc9c)
            .setTitle('🔤 끝말잇기 종료')
            .setDescription(`${reason}\n\n**총 ${game.used.size}단어** · 마지막 단어: **${game.lastWord}**\n\n${lines}`)
            .setFooter({ text: rewarded ? '참가자 2명 이상이라 포인트가 지급됐어요' : '참가자가 2명 미만이라 포인트는 지급되지 않아요' });
        channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
    }

    // 봇이 낼 단어 고르기 (이미 쓴 단어/한방 단어 제외). 없으면 null
    async function pickBotWord(game) {
        const starts = startVariants(game.lastWord.slice(-1));
        let cands = [];
        for (const ch of starts) cands.push(...(BOT_INDEX.get(ch) || []));
        for (const ch of starts) cands.push(...await fetchStdictWords(ch));
        cands = [...new Set(cands)].filter(w => !game.used.has(w) && !isBannedWord(w));
        if (cands.length === 0) return null;

        // 70%는 상대가 이어가기 어려운 단어(이을 수 있는 단어가 적은 끝 글자)를 우선, 30%는 아무거나
        if (Math.random() < 0.7) {
            const follow = w => startVariants(w.slice(-1)).reduce((n, c) => n + (BOT_INDEX.get(c)?.length || 0), 0);
            cands.sort((a, b) => follow(a) - follow(b));
            cands = cands.slice(0, Math.max(3, Math.ceil(cands.length * 0.15)));
        }
        return cands[Math.floor(Math.random() * cands.length)];
    }

    async function botTurn(channel, game) {
        game.pending = true;
        try {
            await sleep(CONFIG.CHAIN_BOT_DELAY_MS);
            if (chains.get(channel.id) !== game) return;
            const word = await pickBotWord(game);
            if (chains.get(channel.id) !== game) return;
            if (!word) {
                return endChain(channel, '🤖 봇이 이을 단어를 찾지 못했어요. 항복!', 'user');
            }
            game.used.add(word);
            game.lastWord = word;
            game.lastUserId = 'BOT';
            armChainTimer(channel, game);
            await channel.send({
                content: `🤖 **${word}** → 다음 글자: **${nextLetters(game)}**\n❤️ ${heartsLine(game)}`,
                allowedMentions: { parse: [] },
            }).catch(() => {});
        } finally {
            game.pending = false;
        }
    }

    async function handleChainWord(message, game, word) {
        const react = e => message.react(e).catch(() => {});
        if (game.pending) return; // 사전 검사 중에는 다른 입력 무시 (동시 입력 꼬임 방지)

        const uid = message.author.id;
        if (game.bot && uid !== game.starterId) return; // 봇전은 시작한 사람만 참여
        if (livesOf(game, uid) <= 0) return react('💀'); // 탈락한 사람은 더 못 해요
        if (!CONFIG.CHAIN_ALLOW_SAME_USER && game.lastUserId === uid) return react('⛔');

        if (!startVariants(game.lastWord.slice(-1)).includes(word[0])) {
            react('❌');
            if (CONFIG.CHAIN_LOSE_LIFE_ON_WRONG_LETTER) await loseLife(message.channel, game, uid, `❌ 글자가 안 맞아요 (${word}).`);
            return;
        }
        if (game.used.has(word)) { react('🔁'); return loseLife(message.channel, game, uid, '🔁 이미 쓴 단어예요.'); }
        if (isBannedWord(word)) { react('🚫'); return loseLife(message.channel, game, uid, '🚫 한방 단어예요.'); } // 한방 단어

        game.pending = true;
        let ok;
        try { ok = await checkDictionary(word); } finally { game.pending = false; }
        if (chains.get(message.channel.id) !== game) return; // 검사 도중 게임이 끝났으면 무시
        if (ok === null) { // 사전 서버에 연결 못 함 -> 단어를 인정하지 않고 다시 입력하게 안내 (안내는 10초에 한 번만)
            react('⚠️');
            if (!game.dictWarnAt || Date.now() - game.dictWarnAt > 10000) {
                game.dictWarnAt = Date.now();
                message.channel.send('⚠️ 국어사전을 확인하지 못했어요. 잠시 후 다시 입력해 주세요.').catch(() => {});
            }
            return;
        }
        if (!ok) { // 국어사전에 없는 단어
            react('❓');
            return loseLife(message.channel, game, uid, `❓ 국어사전에 없는 단어예요 (${word}).`);
        }

        game.used.add(word);
        game.lastWord = word;
        game.lastUserId = uid;
        game.scores.set(uid, (game.scores.get(uid) || 0) + 1);
        if (!game.lives.has(uid)) game.lives.set(uid, CONFIG.CHAIN_LIVES);
        armChainTimer(message.channel, game);

        react('✅');
        if (game.bot) return botTurn(message.channel, game); // 봇전: 봇이 이어받음
        message.channel.send({
            content: `➡️ 다음 글자: **${nextLetters(game)}**\n❤️ ${heartsLine(game)}`,
            allowedMentions: { parse: [] },
        }).catch(() => {});
    }

    // ---------------------------------------------------------------
    // 1) 경제: 도박 공통 처리
    // ---------------------------------------------------------------
    const gambleCd = new Map();
    // 배팅액 검증. 문제가 있으면 안내하고 null, 통과하면 배팅액 반환 (동기 처리라 중복 배팅 불가)
    function prepareBet(message, rawArg) {
        const gid = message.guild.id, uid = message.author.id;
        const key = `${gid}-${uid}`;
        const now = Date.now();
        if (now - (gambleCd.get(key) || 0) < CONFIG.GAMBLE_COOLDOWN_MS) {
            message.react('⏳').catch(() => {});
            return null;
        }
        const balance = getPointUser(gid, uid).points;
        const a = (rawArg || '').toLowerCase().replace(/,/g, '');
        let bet;
        if (['올인', 'all'].includes(a)) bet = Math.min(balance, CONFIG.MAX_BET);
        else if (['반', 'half'].includes(a)) bet = Math.min(Math.floor(balance / 2), CONFIG.MAX_BET);
        else bet = parseInt(a, 10);

        if (!Number.isInteger(bet) || bet < CONFIG.MIN_BET) {
            message.reply(`배팅 금액은 **${fmt(CONFIG.MIN_BET)}P 이상**이어야 해요. (\`올인\`, \`반\` 도 가능)`);
            return null;
        }
        if (bet > CONFIG.MAX_BET) {
            message.reply(`한 번에 최대 **${fmt(CONFIG.MAX_BET)}P**까지 배팅할 수 있어요.`);
            return null;
        }
        if (bet > balance) {
            message.reply(`포인트가 부족해요! 보유: **${fmt(balance)}P**`);
            return null;
        }
        gambleCd.set(key, now);
        return bet;
    }

    const SLOT_SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '7️⃣'];
    const spinSlots = () => [0, 1, 2].map(() => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]);
    // 3개 일치: 7️⃣ x20 / 그 외 x8, 2개 일치: 본전(x1), 꽝: x0  (기댓값 약 89.6%)
    function slotMultiplier(r) {
        if (r[0] === r[1] && r[1] === r[2]) return r[0] === '7️⃣' ? 20 : 8;
        if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) return 1;
        return 0;
    }

    // ---------------------------------------------------------------
    // 오늘의 운세 (사람 + 날짜로 시드를 만들어서, 사람마다 다르고 같은 날엔 같은 결과)
    // ---------------------------------------------------------------
    const hashSeed = str => {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    };
    const makeRng = seed => () => {            // mulberry32
        seed = (seed + 0x6D2B79F5) >>> 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const FORTUNE_GRADES = [
        { min: 90, name: '대길 🌟', color: 0xf1c40f },
        { min: 75, name: '길 😄',   color: 0x2ecc71 },
        { min: 55, name: '중길 🙂', color: 0x3498db },
        { min: 35, name: '소길 😐', color: 0x95a5a6 },
        { min: 0,  name: '흉 😥',   color: 0xe74c3c },
    ];
    const FORTUNE_MESSAGES = {
        high: [
            '무엇을 해도 술술 풀리는 날이에요. 미뤄둔 일을 시작해 보세요!',
            '좋은 기운이 가득해요. 뜻밖의 기쁜 소식이 올 수 있어요.',
            '주변 사람들의 도움을 받는 날이에요. 자신감을 가지세요!',
            '오늘의 노력이 큰 결실로 돌아와요. 적극적으로 움직여 보세요.',
        ],
        mid: [
            '평범하지만 안정적인 하루예요. 작은 행복을 놓치지 마세요.',
            '조금 느려도 꾸준히 가면 괜찮아요. 서두르지 않아도 돼요.',
            '새로운 만남이 작은 활력이 되어줄 거예요.',
            '무리하지 않는 선에서 하고 싶은 걸 해보세요.',
        ],
        low: [
            '오늘은 한 박자 쉬어가세요. 말과 행동을 조심하면 무난해요.',
            '작은 실수가 생길 수 있으니 확인 또 확인! 차분하게 가요.',
            '충동적인 선택은 잠시 미루세요. 내일은 더 나아질 거예요.',
            '잠깐 흐린 날도 있는 법이에요. 맛있는 거 먹고 푹 쉬세요.',
        ],
    };
    const LUCKY_COLORS = ['빨강', '주황', '노랑', '초록', '파랑', '남색', '보라', '분홍', '하양', '검정', '하늘색', '금색'];
    const LUCKY_ITEMS = ['이어폰', '커피', '손거울', '노트', '텀블러', '반지', '모자', '초콜릿', '책', '양말', '키링', '우산'];
    const LUCKY_TIMES = ['아침 7시', '오전 10시', '정오', '오후 2시', '오후 5시', '저녁 8시', '밤 10시', '자정 무렵'];
    const starBar = score => {
        const n = Math.max(1, Math.round(score / 20));
        return '★'.repeat(n) + '☆'.repeat(5 - n);
    };

    function makeFortune(guildId, userId, dateStr) {
        const rng = makeRng(hashSeed(`${userId}:${dateStr}:fortune`));
        const pick = arr => arr[Math.floor(rng() * arr.length)];
        const range = (a, b) => a + Math.floor(rng() * (b - a + 1));

        const total = range(10, 100);
        const grade = FORTUNE_GRADES.find(g => total >= g.min);
        const msgPool = total >= 70 ? FORTUNE_MESSAGES.high : total >= 40 ? FORTUNE_MESSAGES.mid : FORTUNE_MESSAGES.low;
        // 세부 운은 종합 점수 근처에서 흔들리게
        const sub = () => Math.max(5, Math.min(100, total + range(-25, 25)));
        return {
            total, grade,
            money: sub(), love: sub(), work: sub(), health: sub(),
            message: pick(msgPool),
            color: pick(LUCKY_COLORS),
            item: pick(LUCKY_ITEMS),
            time: pick(LUCKY_TIMES),
            number: range(1, 99),
        };
    }

    // ---------------------------------------------------------------
    // 메시지 처리
    // ---------------------------------------------------------------
        async function onMessage(message) {
        if (message.author.bot) return;
        const content = message.content.trim();



  // 아래에는 기존 봇의 다른 명령어 코드가 계속 이어짐
        
    


        // 개인챗(DM/사용자 설치 앱)에서는 서버 정보가 필요 없는 !오늘의운세 만 처리
        if (!message.guild && !/^!오늘의운세(\s|$)/.test(content)) return;
        const gid = message.guild?.id;
        const uid = message.author.id;

        // --- 일반 채팅: 레벨 경험치 + 끝말잇기 진행 중인 채널의 단어 ---
        if (!content.startsWith('!')) {
            giveChatXp(message);
            const game = chains.get(message.channel.id);
            if (game && /^[가-힣]{2,20}$/.test(content)) await handleChainWord(message, game, content);
            return;
        }

        const args = content.split(/\s+/);
        const cmd = args[0];
        const canUse = CONFIG.EVERYONE || isAllowed(uid);
        const isManager = isOwnerId(uid) || message.member?.permissions.has(PermissionFlagsBits.ManageGuild);

        // ================= 1) 경제 =================

        // !출석
        if (cmd === '!출석') {
            if (!canUse) return;
            const today = dayKey();
            const eco = getEco(gid, uid);
            if (eco.lastDaily === today) {
                const nextReset = unix(Date.parse(`${today}T00:00:00Z`) - KST_OFFSET + DAY_MS);
                return message.reply(`이미 오늘 출석했어요! 다음 출석: <t:${nextReset}:R>`);
            }
            eco.streak = eco.lastDaily === dayKey(Date.now() - DAY_MS) ? eco.streak + 1 : 1;
            eco.lastDaily = today;

            const streakBonus = Math.min(eco.streak - 1, CONFIG.DAILY_STREAK_MAX) * CONFIG.DAILY_STREAK_BONUS;
            const weekBonus = eco.streak % 7 === 0 ? CONFIG.DAILY_WEEK_BONUS : 0;
            const reward = CONFIG.DAILY_BASE + streakBonus + weekBonus;
            addPoints(gid, uid, reward, 'manual');
            economy.save();

            const embed = new EmbedBuilder()
                .setColor(0x2ecc71)
                .setTitle('📅 출석 완료!')
                .setDescription(`<@${uid}> 님 출석 보상 **+${fmt(reward)}P**`)
                .addFields(
                    { name: '🔥 연속 출석', value: `${eco.streak}일`, inline: true },
                    { name: '💰 보유 포인트', value: `${fmt(getPointUser(gid, uid).points)}P`, inline: true },
                    { name: '보상 내역', value: `기본 ${CONFIG.DAILY_BASE}P` + (streakBonus ? ` + 연속 ${streakBonus}P` : '') + (weekBonus ? ` + 7일 달성 ${weekBonus}P` : '') },
                );
            return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        // !오늘의운세 [@멘션]  -> 사람마다/날마다 다른 운세 (같은 날엔 같은 결과)
        if (cmd === '!오늘의운세') {
            if (!canUse) return;
            const targetId = message.mentions.users.first()?.id || parseId(args[1]) || uid;
            const f = makeFortune(gid, targetId, dayKey());
            const embed = new EmbedBuilder()
                .setColor(f.grade.color)
                .setTitle(`🔮 오늘의 운세 - ${f.grade.name}`)
                .setDescription(`<@${targetId}> 님의 ${dayKey()} 운세\n\n${f.message}`)
                .addFields(
                    { name: '📈 종합운', value: `${starBar(f.total)} **${f.total}**점`, inline: false },
                    { name: '💰 금전운', value: `${starBar(f.money)} ${f.money}`, inline: true },
                    { name: '💕 애정운', value: `${starBar(f.love)} ${f.love}`, inline: true },
                    { name: '📚 학업/직장운', value: `${starBar(f.work)} ${f.work}`, inline: true },
                    { name: '💪 건강운', value: `${starBar(f.health)} ${f.health}`, inline: true },
                    { name: '🎨 행운의 색', value: f.color, inline: true },
                    { name: '🔢 행운의 숫자', value: String(f.number), inline: true },
                    { name: '🎁 행운의 물건', value: f.item, inline: true },
                    { name: '⏰ 행운의 시간', value: f.time, inline: true },
                )
                .setFooter({ text: '운세는 하루에 한 번 정해져요 · 재미로만 봐주세요!' });
            return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        // !잔액 [@멘션]  -> 포인트 잔액 확인 (없으면 본인)
        if (cmd === '!잔액') {
            if (!canUse) return;
            const targetId = message.mentions.users.first()?.id || parseId(args[1]) || uid;
            const u = getPointUser(gid, targetId);
            return message.reply({
                content: targetId === uid
                    ? `💰 <@${uid}> 님의 잔액: **${fmt(u.points)}P**`
                    : `💰 <@${targetId}> 님의 잔액: **${fmt(u.points)}P**`,
                allowedMentions: { parse: [] },
            });
        }

        // !출금 @멘션 [포인트] -> 상대에게 포인트 전달, 출금채널(없으면 입금채널)에 기록
        if (cmd === '!출금') {
            if (!canUse) return;
            const targetId = message.mentions.users.first()?.id || parseId(args[1]);
            const amount = parseInt((args[2] || '').replace(/,/g, ''), 10);
            if (!targetId || !Number.isInteger(amount)) {
                return message.reply('사용법: `!출금 @멘션 [포인트]`');
            }
            if (amount < CONFIG.TRANSFER_MIN) {
                return message.reply(`최소 **${fmt(CONFIG.TRANSFER_MIN)}P**부터 출금할 수 있어요.`);
            }
            if (targetId === uid) return message.reply('본인에게는 출금할 수 없어요 😅');

            const targetMember = await message.guild.members.fetch(targetId).catch(() => null);
            if (!targetMember) return message.reply('이 서버에서 해당 사용자를 찾을 수 없어요.');
            if (targetMember.user.bot) return message.reply('봇에게는 출금할 수 없어요 🤖');

            // ↓ 여기부터 await 없이 동기 처리 (잔액 확인과 차감이 끊기지 않게)
            const fee = Math.floor(amount * CONFIG.TRANSFER_FEE_RATE);
            const received = amount - fee;
            const me = getPointUser(gid, uid);
            if (me.points < amount) return message.reply(`포인트가 부족해요! 보유: **${fmt(me.points)}P**`);
            addPoints(gid, uid, -amount, 'manual');
            addPoints(gid, targetId, received, 'manual');

            sendTransferLog(message.guild, {
                userId: uid, amount, kind: '출금',
                text: `<@${targetId}> 님에게 출금 (수수료 ${fmt(fee)}P, 실수령 ${fmt(received)}P)`,
            }, 'withdrawChannel');

            // 통합로그에 후원 출력: 디스코드 닉네임, 입금 포인트 순
            if (CONFIG.DONATE_RECEIVER_IDS.length === 0 || CONFIG.DONATE_RECEIVER_IDS.includes(targetId)) {
                sendLog(message.guild, logEmbed(0xf1c40f, '💝 포인트 후원')
                    .addFields(
                        { name: '닉네임', value: message.member?.displayName || message.author.username, inline: true },
                        { name: '입금 포인트', value: `${fmt(amount)}P`, inline: true },
                        { name: '받는 사람', value: `<@${targetId}>`, inline: true },
                    )
                    .setFooter({ text: fee ? `수수료 ${fmt(fee)}P 제외, 실수령 ${fmt(received)}P` : '수수료 없음' }));
            }

            return message.reply({
                content: `💸 <@${targetId}> 님에게 **${fmt(amount)}P**를 보냈어요.` +
                         (fee ? ` (수수료 ${fmt(fee)}P, 받은 금액 ${fmt(received)}P)` : '') +
                         `\n💰 내 잔액: **${fmt(me.points)}P**`,
                allowedMentions: { parse: [] },
            });
        }

                // !출금 @멘션 [포인트] -> 상대에게 포인트 전달, 출금채널(없으면 입금채널)에 기록
        if (cmd === '!출금') {
            if (!canUse) return;
            const targetId = message.mentions.users.first()?.id || parseId(args[1]);
            const amount = parseInt((args[2] || '').replace(/,/g, ''), 10);
            if (!targetId || !Number.isInteger(amount)) {
                return message.reply('사용법: `!출금 @멘션 [포인트]`');
            }
            if (amount < CONFIG.TRANSFER_MIN) {
                return message.reply(`최소 **${fmt(CONFIG.TRANSFER_MIN)}P**부터 출금할 수 있어요.`);
            }
            if (targetId === uid) return message.reply('본인에게는 출금할 수 없어요 😅');

            const targetMember = await message.guild.members.fetch(targetId).catch(() => null);
            if (!targetMember) return message.reply('이 서버에서 해당 사용자를 찾을 수 없어요.');
            if (targetMember.user.bot) return message.reply('봇에게는 출금할 수 없어요 🤖');

            // ↓ 여기부터 await 없이 동기 처리 (잔액 확인과 차감이 끊기지 않게)
            const fee = Math.floor(amount * CONFIG.TRANSFER_FEE_RATE);
            const received = amount - fee;
            const me = getPointUser(gid, uid);
            if (me.points < amount) return message.reply(`포인트가 부족해요! 보유: **${fmt(me.points)}P**`);
            addPoints(gid, uid, -amount, 'manual');
            addPoints(gid, targetId, received, 'manual');

            sendTransferLog(message.guild, {
                userId: uid, amount, kind: '출금',
                text: `<@${targetId}> 님에게 출금 (수수료 ${fmt(fee)}P, 실수령 ${fmt(received)}P)`,
            }, 'withdrawChannel');

            // 통합로그에 후원 출력: 디스코드 닉네임, 입금 포인트 순
            if (CONFIG.DONATE_RECEIVER_IDS.length === 0 || CONFIG.DONATE_RECEIVER_IDS.includes(targetId)) {
                sendLog(message.guild, logEmbed(0xf1c40f, '💝 포인트 후원')
                    .addFields(
                        { name: '닉네임', value: message.member?.displayName || message.author.username, inline: true },
                        { name: '입금 포인트', value: `${fmt(amount)}P`, inline: true },
                        { name: '받는 사람', value: `<@${targetId}>`, inline: true },
                    )
                    .setFooter({ text: fee ? `수수료 ${fmt(fee)}P 제외, 실수령 ${fmt(received)}P` : '수수료 없음' }));
            }

            return message.reply({
                content: `💸 <@${targetId}> 님에게 **${fmt(amount)}P**를 보냈어요.` +
                         (fee ? ` (수수료 ${fmt(fee)}P, 받은 금액 ${fmt(received)}P)` : '') +
                         `\n💰 내 잔액: **${fmt(me.points)}P**`,
                allowedMentions: { parse: [] },
            });
        }

        // !동전 [앞/뒤] [포인트]
        if (cmd === '!동전') {
            if (!canUse) return;
            const side = args[1];
            if (side !== '앞' && side !== '뒤') {
                return message.reply('사용법: `!동전 [앞/뒤] [포인트]` 예) `!동전 앞 100`, `!동전 뒤 올인`');
            }
            const bet = prepareBet(message, args[2]);
            if (bet === null) return;

            const win = Math.random() < CONFIG.COIN_WIN_RATE;
            const result = win ? side : (side === '앞' ? '뒤' : '앞');
            addPoints(gid, uid, win ? bet : -bet, 'manual');
            const balance = getPointUser(gid, uid).points;

            return message.reply(
                `🪙 **${result}면**이 나왔어요!\n` +
                (win ? `🎉 이겼어요! **+${fmt(bet)}P**` : `💸 졌어요... **-${fmt(bet)}P**`) +
                `\n💰 잔액: **${fmt(balance)}P**`
            );
        }

        // !가위바위보 [가위/바위/보] [포인트]  (줄임말: !가바보)
        if (cmd === '!가위바위보' || cmd === '!가바보') {
            if (!canUse) return;
            const RPS = { '가위': '✌️', '바위': '✊', '보': '🖐️' };
            const BEATS = { '가위': '보', '바위': '가위', '보': '바위' }; // 키가 값을 이김
            const pickRaw = (args[1] || '').replace('보자기', '보');
            const choice = RPS[pickRaw] ? pickRaw : null;
            if (!choice) {
                return message.reply('사용법: `!가위바위보 [가위/바위/보] [포인트]` 예) `!가위바위보 바위 100`, `!가위바위보 보 올인`');
            }
            const bet = prepareBet(message, args[2]);
            if (bet === null) return;

            const names = Object.keys(RPS);
            const botChoice = names[Math.floor(Math.random() * names.length)];
            let delta, verdict;
            if (choice === botChoice) {
                delta = 0;
                verdict = '🤝 비겼어요! 배팅한 포인트는 그대로예요. (±0P)';
            } else if (BEATS[choice] === botChoice) {
                delta = Math.floor(bet * CONFIG.RPS_WIN_MULT);
                verdict = `🎉 이겼어요! **+${fmt(delta)}P**`;
            } else {
                delta = -bet;
                verdict = `💸 졌어요... **-${fmt(bet)}P**`;
            }
            if (delta !== 0) addPoints(gid, uid, delta, 'manual'); // 결과를 먼저 반영하고 연출은 그 뒤에
            const balance = getPointUser(gid, uid).points;

            const sent = await message.reply(`🎮 가위... 바위... 보! (배팅 ${fmt(bet)}P)`);
            await sleep(1000);
            return sent.edit(
                `나: ${RPS[choice]} **${choice}**  vs  봇: ${RPS[botChoice]} **${botChoice}**\n` +
                `${verdict}\n💰 잔액: **${fmt(balance)}P**`
            ).catch(() => {});
        }

        // !슬롯 [포인트]
        if (cmd === '!슬롯') {
            if (!canUse) return;
            const bet = prepareBet(message, args[1]);
            if (bet === null) return;

            const reels = spinSlots();
            const mult = slotMultiplier(reels);
            const payout = bet * mult;
            addPoints(gid, uid, -bet, 'manual'); // 결과를 먼저 확정하고 포인트 반영 (연출은 그 뒤에)
            if (payout > 0) addPoints(gid, uid, payout, 'manual');
            const balance = getPointUser(gid, uid).points;

            let verdict;
            if (mult === 20) verdict = `🎉 **JACKPOT!!** x20 → **+${fmt(payout - bet)}P**`;
            else if (mult === 8) verdict = `🎊 3개 일치! x8 → **+${fmt(payout - bet)}P**`;
            else if (mult === 1) verdict = '😐 2개 일치 - 본전이에요 (±0P)';
            else verdict = `💸 꽝... **-${fmt(bet)}P**`;

            const sent = await message.reply(`🎰 | 🔄 | 🔄 | 🔄 |  (배팅 ${fmt(bet)}P)`);
            await sleep(1000);
            return sent.edit(`🎰 | ${reels.join(' | ')} |\n${verdict}\n💰 잔액: **${fmt(balance)}P**`).catch(() => {});
        }

        // ================= 레벨 =================

        // !레벨 [@멘션]
        if (cmd === '!레벨') {
            if (!canUse) return;
            const targetId = message.mentions.users.first()?.id || parseId(args[1]) || uid;
            const u = peekLv(gid, targetId);
            const info = levelInfo(u.xp);
            const ranking = Object.entries(levels.data.guilds[gid] || {}).filter(([, v]) => v.xp > 0).sort((a, b) => b[1].xp - a[1].xp);
            const rank = ranking.findIndex(([id]) => id === targetId);
            const filled = Math.min(10, Math.round((info.cur / info.need) * 10));
            const embed = new EmbedBuilder()
                .setColor(0x9b59b6)
                .setTitle(`🏅 Lv.${info.level}`)
                .setDescription(`<@${targetId}> 님의 레벨\n\n${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}  **${fmt(info.cur)} / ${fmt(info.need)}** XP`)
                .addFields(
                    { name: '🏆 순위', value: rank >= 0 ? `${rank + 1}위` : '순위 없음', inline: true },
                    { name: '✨ 누적 경험치', value: `${fmt(u.xp)} XP`, inline: true },
                    { name: '\u200b', value: '\u200b', inline: true },
                    { name: '💬 채팅으로 얻은 XP', value: `${fmt(u.chat || 0)} XP`, inline: true },
                    { name: '🔊 통화로 얻은 XP', value: `${fmt(u.voice || 0)} XP`, inline: true },
                )
                .setFooter({ text: `채팅 ${CONFIG.LEVEL_CHAT_XP_MIN}~${CONFIG.LEVEL_CHAT_XP_MAX}XP (${CONFIG.LEVEL_CHAT_COOLDOWN_MS / 1000}초 쿨타임) · 통화 1분당 ${CONFIG.LEVEL_VOICE_XP}XP` });
            return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        // !레벨순위
        if (cmd === '!레벨순위') {
            if (!canUse) return;
            const ranking = Object.entries(levels.data.guilds[gid] || {}).filter(([, v]) => v.xp > 0).sort((a, b) => b[1].xp - a[1].xp);
            const medals = ['🥇', '🥈', '🥉'];
            const lines = ranking.length > 0
                ? ranking.slice(0, 10).map(([id, v], i) => `${medals[i] || `**${i + 1}.**`} <@${id}> - **Lv.${levelInfo(v.xp).level}** (${fmt(v.xp)} XP)`).join('\n')
                : '아직 기록이 없어요. 채팅하거나 통화방에 있으면 경험치가 쌓여요!';
            const myIdx = ranking.findIndex(([id]) => id === uid);
            const embed = new EmbedBuilder()
                .setColor(0x9b59b6)
                .setTitle(`🏅 ${message.guild.name} 레벨 순위 TOP 10`)
                .setDescription(lines)
                .setFooter({ text: `내 순위 - ${myIdx >= 0 ? `${myIdx + 1}위 (Lv.${levelInfo(ranking[myIdx][1].xp).level})` : '기록 없음'}` });
            return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        // ================= 생일 =================

        // !생일등록 [닉네임] [월] [일]   (닉네임 생략하면 본인, @멘션도 가능)
        if (cmd === '!생일등록') {
            if (!canUse) return;
            const usage = '사용법: `!생일등록 [닉네임] [월] [일]`\n예) `!생일등록 철수 3 15` · `!생일등록 @멘션 3 15` · 본인은 `!생일등록 3 15`';
            const rest = args.slice(1);
            const combo = (rest[rest.length - 1] || '').match(/^(\d{1,2})[\/.\-](\d{1,2})$/); // 3/15 형태도 허용
            const num = t => { const m = /^(\d{1,2})(?:월|일)?$/.exec(t || ''); return m ? parseInt(m[1], 10) : NaN; };
            let month, day, nickTokens;
            if (combo) {
                month = parseInt(combo[1], 10); day = parseInt(combo[2], 10); nickTokens = rest.slice(0, -1);
            } else {
                if (rest.length < 2) return message.reply(usage);
                month = num(rest[rest.length - 2]); day = num(rest[rest.length - 1]); nickTokens = rest.slice(0, -2);
            }
            if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > daysInMonth(month)) {
                return message.reply('날짜가 올바르지 않아요. 월은 1~12, 일은 그 달에 있는 날짜로 입력해주세요.\n' + usage);
            }

            const who = await resolveBirthdayWho(message, nickTokens);
            if (who.error) return message.reply(who.error);

            const g = (birthdays.data.guilds[gid] ||= {});
            const existing = g[who.key];
            if (!existing && Object.keys(g).length >= CONFIG.BIRTHDAY_MAX_ENTRIES) {
                return message.reply(`이 서버에는 생일을 최대 ${CONFIG.BIRTHDAY_MAX_ENTRIES}명까지 등록할 수 있어요.`);
            }
            if (existing && existing.registeredBy !== uid && existing.userId !== uid && !isManager) {
                return message.reply('다른 사람이 등록한 생일은 수정할 수 없어요.');
            }

            const nowKst = new Date(Date.now() + KST_OFFSET);
            const entry = { key: who.key, name: who.name, userId: who.targetId, month, day, registeredBy: uid, channelId: message.channel.id, lastWished: existing?.lastWished || '' };
            // 오늘이 생일인데 이미 축하 시각이 지난 뒤에 등록했다면, 방금 등록하자마자 축하가 나가지 않게 오늘 분은 건너뜀
            if (isBirthdayToday(entry, nowKst) && nowKst.getUTCHours() >= CONFIG.BIRTHDAY_HOUR) entry.lastWished = dayKey();
            g[who.key] = entry;
            birthdays.save();

            const chId = settings.data.guilds[gid]?.birthdayChannel;
            return message.reply({
                content: `🎂 **${who.name}** 님의 생일을 **${month}월 ${day}일**로 ${existing ? '수정' : '등록'}했어요!\n` +
                         `그날 ${CONFIG.BIRTHDAY_HOUR === 0 ? '밤 12시(자정)' : `낮 ${CONFIG.BIRTHDAY_HOUR}시`}(한국 시간)에 ${chId ? `<#${chId}>` : '이 채널'}에 축하 메시지를 보내드릴게요.`,
                allowedMentions: { parse: [] },
            });
        }

        // !생일삭제 [닉네임]
        if (cmd === '!생일삭제') {
            if (!canUse) return;
            const who = await resolveBirthdayWho(message, args.slice(1));
            if (who.error) return message.reply(who.error);
            const g = birthdays.data.guilds[gid] || {};
            const entry = g[who.key];
            if (!entry) return message.reply('등록된 생일이 없어요. 닉네임을 정확히 입력해주세요.');
            if (entry.registeredBy !== uid && entry.userId !== uid && !isManager) {
                return message.reply('다른 사람이 등록한 생일은 삭제할 수 없어요.');
            }
            delete g[who.key];
            birthdays.save();
            return message.reply({ content: `🗑️ **${entry.name}** 님의 생일 등록을 삭제했어요.`, allowedMentions: { parse: [] } });
        }

        // !생일목록 [월]
        if (cmd === '!생일목록') {
            const month = parseInt(args[1], 10);
            const list = Object.values(birthdays.data.guilds[gid] || {})
                .filter(e => Number.isNaN(month) || e.month === month)
                .sort((a, b) => a.month - b.month || a.day - b.day || a.name.localeCompare(b.name, 'ko'));
            if (list.length === 0) {
                return message.reply(Number.isNaN(month) ? '등록된 생일이 없어요. `!생일등록 [닉네임] [월] [일]`로 등록해보세요!' : `${month}월에 등록된 생일이 없어요.`);
            }
            const lines = list.slice(0, 30).map(e => `**${e.month}월 ${e.day}일** · ${e.userId ? `<@${e.userId}>` : e.name}`);
            const embed = new EmbedBuilder()
                .setColor(0xff6b9d)
                .setTitle(`🎂 생일 목록${Number.isNaN(month) ? '' : ` (${month}월)`} - ${list.length}명`)
                .setDescription(lines.join('\n') + (list.length > 30 ? `\n… 외 ${list.length - 30}명` : ''))
                .setFooter({ text: '!생일목록 [월] 로 월별 확인' });
            return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        // ================= 포인트 수거 (소유자 전용) =================
        // !포인트수거 @멘션 [포인트|반|전부]
        if (cmd === '!포인트수거') {
            if (!isOwnerId(uid)) return message.reply('이 명령어는 봇 소유자만 사용할 수 있어요.');
            const targetId = message.mentions.users.first()?.id || parseId(args[1]);
            const a = (args[2] || '').toLowerCase().replace(/,/g, '');
            if (!targetId || !a) {
                return message.reply('사용법: `!포인트수거 @멘션 [포인트|반|전부]`\n예) `!포인트수거 @멘션 500` · `!포인트수거 @멘션 전부`');
            }
            const u = getPointUser(gid, targetId);
            const before = u.points;
            let amount;
            if (['전부', '전체', '올', '올인', 'all'].includes(a)) amount = before;
            else if (['반', 'half'].includes(a)) amount = Math.floor(before / 2);
            else amount = parseInt(a, 10);

            if (!Number.isInteger(amount) || amount < 1) {
                return message.reply(before < 1 ? '이 사람은 수거할 포인트가 없어요.' : '수거할 포인트를 1 이상의 숫자(또는 `반`, `전부`)로 입력해주세요.');
            }
            amount = Math.min(amount, before); // 가진 것보다 많이 입력하면 가진 만큼만
            if (amount < 1) return message.reply('이 사람은 수거할 포인트가 없어요.');

            addPoints(gid, targetId, -amount, 'manual');
            if (CONFIG.COLLECT_GIVE_TO_COLLECTOR) addPoints(gid, uid, amount, 'manual');

            return message.reply({
                content: `🧺 <@${targetId}> 님에게서 **${fmt(amount)}P**를 수거했어요.\n` +
                         `💰 ${fmt(before)}P → **${fmt(getPointUser(gid, targetId).points)}P**` +
                         (CONFIG.COLLECT_GIVE_TO_COLLECTOR ? `\n📥 수거한 포인트는 <@${uid}> 님이 가져갔어요.` : ''),
                allowedMentions: { parse: [] },
            });
        }

        // ================= 2) 로그 / 환영 설정 (서버 관리 권한 필요) =================
        const SETTING_CMDS = ['!로그채널', '!로그채널해제', '!환영채널', '!환영채널해제', '!환영메시지', '!환영테스트', '!생일채널', '!생일채널해제', '!레벨채널', '!레벨채널해제', '!레벨닉네임', '!통화입장', '!통화퇴장', "!입금채널", "!입금채널해제", "!출금채널", "!출금채널해제", '!인증채널', '!인증채널해제', '!인증역할', '!함정채널', '!함정채널해제'];
        if (SETTING_CMDS.includes(cmd)) {
            if (!isManager) return message.reply('이 명령어는 **서버 관리** 권한이 있는 사람만 사용할 수 있어요.');
            const gs = getSet(gid);

            // 채널 지정 공통 처리
            const pickChannel = () => {
                const ch = message.mentions.channels.first() || message.guild.channels.cache.get(args[1]);
                if (!ch) return { error: null };
                if (!isTextChannel(ch)) return { error: '텍스트 채널만 지정할 수 있어요.' };
                if (!botCanSend(message.guild, ch)) return { error: '봇이 그 채널에서 메시지를 보낼 권한(채널 보기/메시지 보내기/링크 임베드)이 없어요.' };
                return { ch };
            };

            if (cmd === '!로그채널') {
                const { ch, error } = pickChannel();
                if (error) return message.reply(error);
                if (!ch) {
                    return message.reply(`현재 로그 채널: ${gs.logChannel ? `<#${gs.logChannel}>` : '설정 안 됨'}\n사용법: \`!로그채널 #채널\``);
                }
                gs.logChannel = ch.id;
                settings.save();
                return message.reply(`✅ 로그 채널을 <#${ch.id}> 로 설정했어요.`);
            }
            if (cmd === '!로그채널해제') {
                delete gs.logChannel;
                settings.save();
                return message.reply('🚫 로그 기록을 껐어요.');
            }

            if (cmd === '!환영채널') {
                const { ch, error } = pickChannel();
                if (error) return message.reply(error);
                if (!ch) {
                    return message.reply(`현재 환영 채널: ${gs.welcomeChannel ? `<#${gs.welcomeChannel}>` : '설정 안 됨'}\n사용법: \`!환영채널 #채널\``);
                }
                gs.welcomeChannel = ch.id;
                settings.save();
                return message.reply(`✅ 환영 채널을 <#${ch.id}> 로 설정했어요. \`!환영테스트\`로 미리 볼 수 있어요.`);
            }
            if (cmd === '!환영채널해제') {
                delete gs.welcomeChannel;
                settings.save();
                return message.reply('🚫 자동 환영을 껐어요.');
            }

            if (cmd === '!환영메시지') {
                const text = content.slice(cmd.length).trim();
                if (!text) {
                    return message.reply(
                        '사용법: `!환영메시지 내용`\n' +
                        '사용 가능한 변수: `{유저}` 멘션, `{서버명}` 서버 이름, `{인원}` 현재 인원\n' +
                        '예) `!환영메시지 {유저}님 어서오세요! {서버명}의 {인원}번째 멤버예요 🎉`'
                    );
                }
                if (text.length > 500) return message.reply('환영 메시지는 500자 이내로 입력해주세요.');
                gs.welcomeMsg = text;
                settings.save();
                return message.reply('✅ 환영 메시지를 저장했어요. `!환영테스트`로 확인해보세요.');
            }

                        if (cmd === '!입금채널') {
                const { ch, error } = pickChannel();
                if (error) return message.reply(error);
                if (!ch) {
                    return message.reply(`현재 입금 채널: ${gs.depositChannel ? `<#${gs.depositChannel}>` : '설정 안 됨'}\n사용법: \`!입금채널 #채널\``);
                }
                gs.depositChannel = ch.id;
                settings.save();
                return message.reply(`✅ 송금/후원/출금 내역을 <#${ch.id}> 에 출력할게요.`);
            }
            if (cmd === '!입금채널해제') {
                delete gs.depositChannel;
                settings.save();
                return message.reply('🚫 입금 채널 설정을 해제했어요.');
            }
                        // !함정채널 #채널 -> 이 채널에 메시지를 보내면 작성자 추방
            if (cmd === '!함정채널') {
                if (!message.guild) return message.reply('서버 안에서만 사용할 수 있어요.');
                const ch = message.mentions.channels.first() || message.guild.channels.cache.get(args[1]);
                if (!ch) {
                    return message.reply(`현재 함정 채널: ${gs.trapChannel ? `<#${gs.trapChannel}>` : '설정 안 됨'}\n사용법: \`!함정채널 #채널\``);
                }
                if (!isTextChannel(ch)) return message.reply('텍스트 채널만 지정할 수 있어요.');
                const me = message.guild.members.me;
                if (!me?.permissions.has(PermissionFlagsBits.KickMembers)) {
                    return message.reply('봇에게 **멤버 추방하기** 권한이 없어요. 권한을 주고 다시 시도해주세요.');
                }
                if (!ch.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)) {
                    return message.reply('봇이 그 채널을 볼 수 없어요. 채널 권한을 확인해주세요.');
                }
                gs.trapChannel = ch.id;
                settings.save();
                ch.send('⚠️ 이 채널에 메시지를 보내면 서버에서 **즉시 추방**됩니다.').catch(() => {});
                return message.reply(`✅ <#${ch.id}> 를 함정 채널로 설정했어요. 이 채널에 메시지를 보내면 (소유자 제외) 모두 추방돼요.`);
            }
            if (cmd === '!함정채널해제') {
                delete gs.trapChannel;
                settings.save();
                return message.reply('🚫 함정 채널을 해제했어요.');
            }

                        // !인증역할 @역할  -> 반응하면 지급할 역할 지정
            if (cmd === '!인증역할') {
                const role = message.mentions.roles.first() || message.guild.roles.cache.get(args[1]);
                if (!role) {
                    return message.reply(`현재 인증 역할: ${gs.verifyRole ? `<@&${gs.verifyRole}>` : '설정 안 됨'}\n사용법: \`!인증역할 @역할\``);
                }
                const me = message.guild.members.me;
                if (role.id === message.guild.id) return message.reply('@everyone 역할은 지정할 수 없어요.');
                if (role.managed) return message.reply('봇/연동 서비스가 관리하는 역할은 지정할 수 없어요.');
                if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    return message.reply('봇에게 **역할 관리** 권한이 없어요. 권한을 주고 다시 시도해주세요.');
                }
                if (role.comparePositionTo(me.roles.highest) >= 0) {
                    return message.reply('그 역할이 봇의 최상위 역할보다 높거나 같아서 줄 수 없어요. 서버 설정에서 **봇 역할을 그 역할보다 위로** 올려주세요.');
                }
                gs.verifyRole = role.id;
                settings.save();
                return message.reply({ content: `✅ 인증 역할을 <@&${role.id}> 로 설정했어요. 이제 \`!인증채널 #채널\`로 인증 메시지를 보내세요.`, allowedMentions: { parse: [] } });
            }

            // !인증채널 #채널  -> 그 채널에 인증 메시지를 보내고 반응 달기
            if (cmd === '!인증채널') {
                const { ch, error } = pickChannel();
                if (error) return message.reply(error);
                if (!ch) {
                    return message.reply(`현재 인증 채널: ${gs.verifyChannel ? `<#${gs.verifyChannel}>` : '설정 안 됨'}\n사용법: \`!인증채널 #채널\` (먼저 \`!인증역할 @역할\` 필요)`);
                }
                if (!gs.verifyRole || !message.guild.roles.cache.has(gs.verifyRole)) {
                    return message.reply('먼저 `!인증역할 @역할`로 지급할 역할을 지정해주세요.');
                }
                if (!ch.permissionsFor(message.guild.members.me)?.has([PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory])) {
                    return message.reply('봇에게 그 채널의 **반응 추가하기 / 메시지 기록 보기** 권한이 없어요.');
                }

                // 예전 인증 메시지가 있으면 삭제
                if (gs.verifyChannel && gs.verifyMessage) {
                    const oldCh = message.guild.channels.cache.get(gs.verifyChannel);
                    await oldCh?.messages.delete(gs.verifyMessage).catch(() => {});
                }

                const embed = new EmbedBuilder()
                    .setColor(0x2ecc71)
                    .setTitle('✅ 인증')
                    .setDescription(`아래 ${VERIFY_EMOJI} 반응을 누르면 <@&${gs.verifyRole}> 역할이 지급돼요.\n반응을 취소하면 역할이 회수돼요.`);
                const sent = await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
                if (!sent) return message.reply('인증 메시지를 보내지 못했어요. 봇 권한을 확인해주세요.');
                await sent.react(VERIFY_EMOJI).catch(() => {});

                gs.verifyChannel = ch.id;
                gs.verifyMessage = sent.id;
                settings.save();
                return message.reply(`✅ <#${ch.id}> 에 인증 메시지를 보냈어요.`);
            }
            if (cmd === '!인증채널해제') {
                if (gs.verifyChannel && gs.verifyMessage) {
                    const oldCh = message.guild.channels.cache.get(gs.verifyChannel);
                    await oldCh?.messages.delete(gs.verifyMessage).catch(() => {});
                }
                delete gs.verifyChannel;
                delete gs.verifyMessage;
                settings.save();
                return message.reply('🚫 인증 메시지와 설정을 해제했어요. (인증 역할 설정은 유지돼요)');
            }

                        if (cmd === '!출금채널') {
                const { ch, error } = pickChannel();
                if (error) return message.reply(error);
                if (!ch) {
                    return message.reply(`현재 출금 채널: ${gs.withdrawChannel ? `<#${gs.withdrawChannel}>` : '설정 안 됨 (입금 채널로 전송)'}\n사용법: \`!출금채널 #채널\``);
                }
                gs.withdrawChannel = ch.id;
                settings.save();
                return message.reply(`✅ \`!출금\` 내역을 <#${ch.id}> 에 출력할게요.`);
            }
            if (cmd === '!출금채널해제') {
                delete gs.withdrawChannel;
                settings.save();
                return message.reply('🚫 출금 채널 설정을 해제했어요. 이제 입금 채널로 보내요.');
            }

            
            if (cmd === '!생일채널') {
                const { ch, error } = pickChannel();
                if (error) return message.reply(error);
                if (!ch) {
                    return message.reply(`현재 생일 채널: ${gs.birthdayChannel ? `<#${gs.birthdayChannel}>` : '설정 안 됨 (등록한 채널에 보내요)'}\n사용법: \`!생일채널 #채널\``);
                }
                gs.birthdayChannel = ch.id;
                settings.save();
                return message.reply(`✅ 생일 축하 메시지를 <#${ch.id}> 에 보낼게요.`);
            }
            if (cmd === '!생일채널해제') {
                delete gs.birthdayChannel;
                settings.save();
                return message.reply('🚫 생일 채널 설정을 해제했어요. 이제 생일을 등록한 채널에 보내요.');
            }
            if (cmd === '!레벨채널') {
                const { ch, error } = pickChannel();
                if (error) return message.reply(error);
                if (!ch) {
                    return message.reply(`현재 레벨업 알림 채널: ${gs.levelChannel ? `<#${gs.levelChannel}>` : '설정 안 됨 (채팅한 채널에 알려요)'}\n사용법: \`!레벨채널 #채널\``);
                }
                gs.levelChannel = ch.id;
                settings.save();
                return message.reply(`✅ 레벨업 알림을 <#${ch.id}> 에 보낼게요.`);
            }
            if (cmd === '!레벨채널해제') {
                delete gs.levelChannel;
                settings.save();
                return message.reply('🚫 레벨 채널 설정을 해제했어요. 이제 채팅한 채널에 레벨업을 알려요.');
            }
            if (cmd === '!레벨닉네임') {
                const sub = args[1];
                const me = message.guild.members.me;
                const mentionId = message.mentions.users.first()?.id || parseId(args[2]);
                const overrides = (gs.levelNickUsers ||= {});
                const prefixExample = nickPrefix('N').trim();
                const needPerm = () => !me?.permissions.has(PermissionFlagsBits.ManageNicknames);
                const permMsg = '봇에게 **닉네임 관리** 권한이 없어요. 봇 역할에 권한을 주고, 봇 역할을 멤버 역할들보다 위로 올려주세요.';

                if (!sub) {
                    const on = Object.values(overrides).filter(v => v === true).length;
                    const off = Object.values(overrides).filter(v => v === false).length;
                    return message.reply(
                        `현재 상태: 서버 전체 ${gs.levelNick ? '✅ 켜짐' : '❌ 꺼짐'}` +
                        (on || off ? ` · 개별 설정 켬 ${on}명 / 끔 ${off}명` : '') + '\n' +
                        `레벨이 오르면 닉네임 앞에 \`${prefixExample}\` 말머리가 붙고, 레벨업마다 숫자가 올라가요.\n` +
                        '**서버 전체**: `!레벨닉네임 켜기` · `끄기` · `갱신` (지금 레벨로 모두 적용) · `제거` (모두 지우고 끄기)\n' +
                        '**한 명만**: `!레벨닉네임 켜기 @멘션` · `끄기 @멘션` (끄면 그 사람 말머리도 지워요)'
                    );
                }

                // ---- 멘션한 한 명만 켜기/끄기 ----
                if ((sub === '켜기' || sub === '끄기') && args[2]) {
                    if (!mentionId) return message.reply('대상을 멘션하거나 ID로 입력해주세요! 예: `!레벨닉네임 켜기 @닉네임`');
                    if (needPerm()) return message.reply(permMsg);
                    const member = await message.guild.members.fetch(mentionId).catch(() => null);
                    if (!member) return message.reply('이 서버에서 해당 사용자를 찾을 수 없어요.');
                    if (member.user.bot) return message.reply('봇에게는 설정할 수 없어요 🤖');
                    if (member.id === message.guild.ownerId || !member.manageable) {
                        return message.reply('이 멤버는 디스코드 제한으로 닉네임을 바꿀 수 없어요. (서버 주인이거나 봇보다 높은 역할이에요)');
                    }
                    const lv = levelInfo(peekLv(gid, mentionId).xp).level;
                    if (sub === '켜기') {
                        overrides[mentionId] = true;
                        settings.save();
                        let note;
                        if (lv >= 1) {
                            const r = await setLevelNick(member, lv);
                            note = r === 'fail' ? '⚠️ 닉네임을 바꾸지 못했어요. 권한과 역할 순서를 확인해주세요.' : `지금 **Lv.${lv}** 이라서 바로 적용했어요.`;
                        } else {
                            note = '아직 레벨 0이라서 **Lv.1이 되면** 닉네임이 바뀌어요.';
                        }
                        return message.reply({ content: `✅ <@${mentionId}> 님의 레벨 닉네임을 켰어요. ${note}`, allowedMentions: { parse: [] } });
                    }
                    overrides[mentionId] = false;
                    settings.save();
                    await setLevelNick(member, null); // 붙어 있던 말머리 제거
                    return message.reply({ content: `🚫 <@${mentionId}> 님의 레벨 닉네임을 끄고 말머리를 지웠어요.`, allowedMentions: { parse: [] } });
                }

                // ---- 서버 전체 ----
                if (sub === '켜기') {
                    if (needPerm()) return message.reply(permMsg);
                    gs.levelNick = true;
                    settings.save();
                    return message.reply(`✅ 레벨업하면 닉네임이 \`${prefixExample} 이름\` 으로 바뀌어요. 지금 레벨을 바로 적용하려면 \`!레벨닉네임 갱신\` 을 입력하세요.\n(서버 주인, 봇보다 높은 역할의 멤버는 디스코드 제한으로 바꿀 수 없어요)`);
                }
                if (sub === '끄기') {
                    gs.levelNick = false;
                    settings.save();
                    return message.reply('🚫 서버 전체 레벨 닉네임을 껐어요. 이미 붙은 말머리는 그대로이고, 지우려면 `!레벨닉네임 제거` 를 쓰세요. (`켜기 @멘션`으로 켠 사람은 계속 적용돼요)');
                }
                if (sub === '갱신' || sub === '제거') {
                    const removing = sub === '제거';
                    const anyOn = gs.levelNick || Object.values(overrides).some(v => v === true);
                    if (!removing && !anyOn) return message.reply('먼저 `!레벨닉네임 켜기` (또는 `켜기 @멘션`) 를 해주세요.');
                    if (needPerm()) return message.reply('봇에게 **닉네임 관리** 권한이 없어요.');
                    if (nickSyncing.has(gid)) return message.reply('이미 처리 중이에요. 잠시만 기다려주세요.');
                    const targets = Object.entries(levels.data.guilds[gid] || {})
                        .map(([id, v]) => [id, levelInfo(v.xp).level])
                        .filter(([id, lv]) => removing || (lv >= 1 && isNickOn(gs, id)));
                    if (removing) { gs.levelNick = false; gs.levelNickUsers = {}; settings.save(); }
                    if (targets.length === 0) return message.reply('처리할 멤버가 없어요.');
                    nickSyncing.add(gid);
                    await message.reply(`⏳ ${targets.length}명의 닉네임을 ${removing ? '정리' : '갱신'}하는 중이에요... (디스코드 제한 때문에 천천히 진행돼요)`);
                    const count = { ok: 0, skip: 0, fail: 0 };
                    try {
                        for (const [id, lv] of targets) {
                            const member = await message.guild.members.fetch(id).catch(() => null);
                            const r = member ? await setLevelNick(member, removing ? null : lv) : 'skip';
                            count[r]++;
                            if (r === 'ok') await sleep(1000);
                        }
                    } finally {
                        nickSyncing.delete(gid);
                    }
                    return message.channel.send(`✅ 완료! 변경 ${count.ok}명 · 변경 없음/불가 ${count.skip}명 · 실패 ${count.fail}명`);
                }
                return message.reply('사용법: `!레벨닉네임 켜기` · `끄기` · `갱신` · `제거` (한 명만: `켜기 @멘션` · `끄기 @멘션`)');
            }
            // !통화입장 [#음성채널 | 채널ID]  (생략하면 내가 들어가 있는 통화방)
            if (cmd === '!통화입장') {
                const target = message.mentions.channels.first()
                    || (args[1] && message.guild.channels.cache.get(args[1]))
                    || message.member?.voice?.channel;
                if (!target) {
                    return message.reply('들어갈 통화방을 알려주세요! 통화방에 들어간 상태에서 `!통화입장` 을 치거나, `!통화입장 #음성채널` (또는 채널 ID) 로 입력해주세요.');
                }
                if (target.type !== ChannelType.GuildVoice) return message.reply('일반 음성 채널만 지정할 수 있어요.');
                const r = await joinStay(message.guild, target.id);
                if (!r.ok) return message.reply(`⚠️ ${r.error}`);
                gs.stayChannel = target.id;
                settings.save();
                return message.reply(`🔊 <#${target.id}> 에 들어왔어요! 이제 계속 이 통화방에 있을게요. (끊기거나 봇을 껐다 켜도 자동으로 다시 들어가요. 나가려면 \`!통화퇴장\`)`);
            }
            // !통화퇴장
            if (cmd === '!통화퇴장') {
                if (!gs.stayChannel) return message.reply('지금 상주 중인 통화방이 없어요.');
                delete gs.stayChannel; // 먼저 지워야 다시 들어가지 않아요
                settings.save();
                if (stayTimers.has(gid)) { clearTimeout(stayTimers.get(gid)); stayTimers.delete(gid); }
                voiceLib?.getVoiceConnection(gid)?.destroy();
                return message.reply('👋 통화방에서 나왔어요. 상주도 해제했어요.');
            }
            if (cmd === '!환영테스트') {
                if (!gs.welcomeChannel) return message.reply('먼저 `!환영채널 #채널`로 환영 채널을 설정해주세요.');
                await sendWelcome(message.member);
                return message.react('✅').catch(() => {});
            }
            return;
        }

        // ================= 3) 끝말잇기 =================
        if (cmd === '!끝말잇기') {
            if (!canUse) return;
            if (CONFIG.CHAIN_STRICT_DICT && !STDICT_KEY) {
                return message.reply(
                    '📕 끝말잇기는 **표준국어대사전**에 있는 단어만 인정하도록 되어 있는데, 사전 API 키가 설정되지 않아서 시작할 수 없어요.\n' +
                    '`config.json`에 `"stdictKey": "발급받은키"`를 추가하고 봇을 다시 켜주세요.\n' +
                    '키 발급: https://stdict.korean.go.kr/openapi/openApiInfo.do (회원가입 후 오픈 API 신청)'
                );
            }
            const existing = chains.get(message.channel.id);
            if (existing) {
                return message.reply(`이미 진행 중이에요! 마지막 단어: **${existing.lastWord}** → 다음 글자: **${startVariants(existing.lastWord.slice(-1)).join(' / ')}**`);
            }

            const botMode = ['봇', '봇전', 'bot', 'ai'].includes((args[1] || '').toLowerCase());
            const first = CHAIN_START_WORDS[Math.floor(Math.random() * CHAIN_START_WORDS.length)];
            const game = {
                bot: botMode,
                starterId: uid,
                lastWord: first,
                used: new Set([first]),
                lastUserId: null,
                scores: new Map(),
                lives: new Map(), // 유저ID -> 남은 목숨
                pending: false,
                timer: null,
            };
            if (botMode) game.lives.set(uid, CONFIG.CHAIN_LIVES); // 봇전은 시작할 때부터 하트 표시
            chains.set(message.channel.id, game);
            armChainTimer(message.channel, game);

            const embed = new EmbedBuilder()
                .setColor(0x1abc9c)
                .setTitle(botMode ? '🤖 끝말잇기 시작! (봇전)' : '🔤 끝말잇기 시작!')
                .setDescription(
                    `시작 단어: **${first}**\n다음 글자: **${startVariants(first.slice(-1)).join(' / ')}**\n\n` +
                    (botMode ? `• 🤖 봇과 1:1 대결이에요! <@${uid}> 님만 참여할 수 있어요. 봇이 못 이으면 승리!\n` : '') +
                    '• 한글 2글자 이상 **단어 하나만** 입력하세요 (두음법칙 적용)\n' +
                    `• 🚫 한방 단어 금지: **${CONFIG.CHAIN_BANNED_ENDINGS.join(' ')}** 로 끝나는 단어는 쓸 수 없어요\n` +
                    '• 표준국어대사전에 있는 **명사**만 인정돼요\n' +
                    `• ❤️ 목숨 **${CONFIG.CHAIN_LIVES}개**! 틀리면 💔 -1 (이미 쓴 단어 · 사전에 없는 단어 · 한방 단어${CONFIG.CHAIN_LOSE_LIFE_ON_WRONG_LETTER ? ' · 글자 불일치' : ''}), 0개가 되면 ☠️ 탈락\n` +
                    '• ✅ 성공 · ❌ 글자 불일치 · 🔁 이미 쓴 단어 · ⛔ 연속 입력 · ❓ 사전에 없는 단어 · 🚫 한방 단어 · ⚠️ 사전 확인 실패\n' +
                    (botMode
                        ? `• ${CONFIG.CHAIN_TIMEOUT_MS / 1000}초 안에 못 이으면 목숨 -1\n`
                        : `• ${CONFIG.CHAIN_TIMEOUT_MS / 1000}초 동안 아무도 못 이으면 종료, 마지막까지 살아남은 사람이 승리!\n`) +
                    (botMode ? `• 내 목숨: ${hearts(CONFIG.CHAIN_LIVES)}\n` : '') +
                    '• 종료: `!끝말잇기종료`'
                )
                .setFooter({ text: STDICT_KEY ? '표준국어대사전으로 단어를 검사해요' : '⚠️ 사전 키가 없어 단어 검사를 하지 않아요 (CHAIN_STRICT_DICT=false 상태)' });
            return message.channel.send({ embeds: [embed] });
        }

        if (cmd === '!끝말잇기종료') {
            const game = chains.get(message.channel.id);
            if (!game) return message.reply('진행 중인 끝말잇기가 없어요.');
            if (game.starterId !== uid && !isManager) {
                return message.reply('게임을 시작한 사람이나 서버 관리자만 종료할 수 있어요.');
            }
            return endChain(message.channel, '🏁 게임이 종료됐어요.', 'stop');
        }
    }

    client.on(Events.MessageCreate, async message => {
        try {
            await onMessage(message);
        } catch (err) {
            console.error('extras 처리 중 오류:', err);
        }
    });

    return {
        handleMessage: onMessage, // 슬래시(/) 명령어에서 재사용
        flush() {
            // 종료 시 통화 중이던 사람의 시간도 저장
            const now = Date.now();
            for (const [key, joinedAt] of voiceJoinAt) {
                const [gid, uid] = key.split('-');
                addVoiceTotal(gid, uid, now - joinedAt);
                voiceJoinAt.set(key, now);
            }
            economy.flush(); settings.flush(); voiceTime.flush(); birthdays.flush(); levels.flush();
        },
    };
}

// 추가 기능 연결
extras = setupExtras(client, {
    addPoints, getPointUser, parseId, sleep, isOwnerId,
    isAllowed: id => isOwnerId(id) || allowedIds.has(id),
});

// =====================================================================
//  슬래시(/) 명령어: 기존 ! 명령어와 같은 기능을 /로도 쓸 수 있게 연결
//   - ping,  타이머(+목록/취소), 동전, 슬롯, 가위바위보, 오늘의운세, 끝말잇기,
//   - 실제 동작은 ! 명령어 코드를 그대로 재사용해요 (슬래시 입력을 "!명령어 옵션..." 메시지처럼 바꿔서 처리)
// =====================================================================
function setupSlash(client, { handleMain, handleExtras }) {
    const STR = 3, INT = 4, USER = 6; // 옵션 타입
    // 설치/사용 위치: integration_types 0=서버에 설치, 1=사용자 계정에 설치 / contexts 0=서버, 1=봇과의 DM, 2=개인챗(DM·그룹챗)
    const EVERYWHERE = { integration_types: [0, 1], contexts: [0, 1, 2] };
    const GUILD_ONLY = { integration_types: [0], contexts: [0] };
    const bet = { type: STR, name: '포인트', description: '배팅할 포인트 (숫자, 올인, 반) - 서버에서만 필요해요' };
    const NOTE = '\n(개인챗에서는 포인트 없이 가볍게 즐기는 모드예요)';
    const SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '7️⃣'];

    // target: 'main'(허용된 사람만) | 'extras'(CONFIG.EVERYONE 설정을 따름)
    // free: 서버 밖(개인챗)에서 쓸 때 포인트 없이 실행하는 간단 버전
    const SLASH = [
                   ...features.slash({ EVERYWHERE, GUILD_ONLY, STR, USER }),
        {
            target: 'main', where: EVERYWHERE,
            def: { name: 'ping', description: '봇 반응 속도를 확인해요' },
            build: () => '!ping',
        },


        {
            target: 'main',
            where: EVERYWHERE,
            def: {
                name: '타자',
                description: '타자 게임을 시작합니다'
            },
            build: () => '!타자'
        },

        {
            target: 'main',
            where: EVERYWHERE,
            def: {
                name: '타자순위',
                description: '이번 주 타자 게임 순위를 확인합니다'
            },
            build: () => '!타자순위'
        },

        
        {
            target: 'main', where: EVERYWHERE,
            def: {
                name: '타이머', description: '타이머를 시작해요 (최대 24시간)',
                options: [
                    { type: STR, name: '시간', description: '예: 10분, 1시간30분, 30초 (숫자만 쓰면 분)', required: true },
                    { type: STR, name: '메모', description: '타이머 이름/메모 (선택)' },
                ],
            },
            build: i => `!타이머 ${i.options.getString('시간')} ${i.options.getString('메모') || ''}`.trim(),
        },
        {
            target: 'main', where: EVERYWHERE,
            def: { name: '타이머목록', description: '내가 만든 타이머를 확인해요' },
            build: () => '!타이머목록',
        },
        {
            target: 'main', where: EVERYWHERE,
            def: {
                name: '타이머취소', description: '타이머를 취소해요',
                options: [{ type: INT, name: '번호', description: '취소할 타이머 번호 (/타이머목록에서 확인)', required: true, min_value: 1 }],
            },
            build: i => `!타이머취소 ${i.options.getInteger('번호')}`,
        },
        {
            target: 'extras', where: EVERYWHERE,
            def: {
                name: '동전', description: '동전 던지기에 포인트를 걸어요',
                options: [
                    { type: STR, name: '면', description: '앞면 또는 뒷면', required: true, choices: [{ name: '앞', value: '앞' }, { name: '뒤', value: '뒤' }] },
                    bet,
                ],
            },
            build: i => `!동전 ${i.options.getString('면')} ${i.options.getString('포인트') ?? ''}`.trim(),
            free: async i => {
                const side = i.options.getString('면');
                const result = Math.random() < 0.5 ? '앞' : '뒤';
                await i.reply(`🪙 **${result}면**이 나왔어요! ${result === side ? '🎉 맞혔어요!' : '😢 아쉽게 틀렸어요.'}${NOTE}`);
            },
        },
        {
            target: 'extras', where: EVERYWHERE,
            def: { name: '슬롯', description: '슬롯머신에 포인트를 걸어요', options: [bet] },
            build: i => `!슬롯 ${i.options.getString('포인트') ?? ''}`.trim(),
            free: async i => {
                const reels = [0, 1, 2].map(() => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]);
                await i.reply('🎰 | 🔄 | 🔄 | 🔄 |');
                await sleep(1000);
                const kinds = new Set(reels).size;
                const verdict = kinds === 1 ? '🎉 3개 일치!' : kinds === 2 ? '😐 2개 일치 - 본전이에요' : '💸 꽝...';
                await i.editReply(`🎰 | ${reels.join(' | ')} |\n${verdict}${NOTE}`);
            },
        },
        {
            target: 'extras', where: EVERYWHERE,
            def: {
                name: '가위바위보', description: '봇과 가위바위보에 포인트를 걸어요',
                options: [
                    { type: STR, name: '선택', description: '가위, 바위, 보 중 하나', required: true, choices: [{ name: '가위', value: '가위' }, { name: '바위', value: '바위' }, { name: '보', value: '보' }] },
                    bet,
                ],
            },
            build: i => `!가위바위보 ${i.options.getString('선택')} ${i.options.getString('포인트') ?? ''}`.trim(),
            free: async i => {
                const E = { '가위': '✌️', '바위': '✊', '보': '🖐️' };
                const BEATS = { '가위': '보', '바위': '가위', '보': '바위' };
                const me = i.options.getString('선택');
                const bot = Object.keys(E)[Math.floor(Math.random() * 3)];
                const verdict = me === bot ? '🤝 비겼어요!' : BEATS[me] === bot ? '🎉 이겼어요!' : '💸 졌어요...';
                await i.reply(`나: ${E[me]} **${me}**  vs  봇: ${E[bot]} **${bot}**\n${verdict}${NOTE}`);
            },
        },
        {
            target: 'extras', where: EVERYWHERE,
            def: {
                name: '오늘의운세', description: '오늘의 운세를 확인해요',
                options: [{ type: USER, name: '유저', description: '다른 사람의 운세를 볼 때 (선택)' }],
            },
            build: i => { const u = i.options.getUser('유저'); return u ? `!오늘의운세 ${u.id}` : '!오늘의운세'; },
        },
                {
            target: 'extras', where: EVERYWHERE, // 봇이 없는 서버·개인챗에서도 보이게
            def: {
                name: '서버인원',
                description: '이 서버에 몇 명이 있는지 나에게만 보여줘요',
                options: [
                    { type: STR, name: '초대링크', description: '봇이 없는 서버에서 인원수를 보려면 이 서버의 초대 링크를 넣어주세요 (선택)' },
                ],
            },
            custom: async i => {
                const uid = i.user.id;
                if (!(CONFIG.EVERYONE || isOwnerId(uid) || allowedIds.has(uid))) {
                    return i.reply({ content: '이 명령어는 봇 소유자와 허용된 사람만 사용할 수 있어요.', flags: 64 });
                }
                if (!i.guildId) {
                    return i.reply({ content: '이 명령어는 서버 안에서만 사용할 수 있어요.', flags: 64 });
                }

                // 1) 봇이 들어가 있는 서버: 정확한 인원수
                if (i.guild) {
                    return i.reply({ content: `👥 **${i.guild.name}** 에는 **${fmt(i.guild.memberCount)}명**이 있어요.`, flags: 64 });
                }

                // 2) 봇이 없는 서버: 인원수는 초대 링크로만 알 수 있어요
                const raw = (i.options.getString('초대링크') || '').trim();
                if (!raw) {
                    return i.reply({
                        content:
                            `🆔 서버 ID: \`${i.guildId}\`\n` +
                            '이 서버에는 봇이 없어서 인원수를 직접 조회할 수 없어요.\n' +
                            '`/서버인원 초대링크:https://discord.gg/코드` 처럼 초대 링크를 같이 넣으면 대략적인 인원수를 보여드려요.',
                        flags: 64,
                    });
                }

                const code = raw.match(/([A-Za-z0-9-]+)\/?$/)?.[1];
                if (!code) return i.reply({ content: '초대 링크 형식이 올바르지 않아요.', flags: 64 });

                await i.deferReply({ flags: 64 });
                try {
                    const inv = await fetchJson(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`);
                    if (!inv.guild) return i.editReply('서버 초대 링크가 아니에요.');
                    if (inv.guild.id !== i.guildId) {
                        return i.editReply('이 서버의 초대 링크가 아니에요. 지금 있는 서버의 초대 링크를 넣어주세요.');
                    }
                    return i.editReply(
                        `👥 **${inv.guild.name}**\n` +
                        `🆔 서버 ID: \`${inv.guild.id}\`\n` +
                        `• 전체 인원: 약 **${fmt(inv.approximate_member_count ?? 0)}명**\n` +
                        `• 온라인: 약 **${fmt(inv.approximate_presence_count ?? 0)}명**\n` +
                        '(봇이 없는 서버라 디스코드가 알려주는 근사값이에요)'
                    );
                } catch (err) {
                    console.error('/서버인원 초대 조회 실패:', err.message);
                    return i.editReply('초대 링크를 확인하지 못했어요. 만료됐거나 잘못된 링크일 수 있어요.');
                }
            },
        },
                {
            target: 'extras', where: EVERYWHERE,
            def: {
                name: '초대링크',
                description: '이 서버의 초대 링크를 만들어 나에게만 보여줘요 (봇이 있는 서버 전용)',
                options: [
                    { type: INT, name: '시간', description: '유효 시간(시간 단위, 기본 24, 0이면 무제한)', min_value: 0, max_value: 168 },
                    { type: INT, name: '횟수', description: '최대 사용 횟수 (기본 무제한, 0이면 무제한)', min_value: 0, max_value: 100 },
                ],
            },
            custom: async i => {
                const uid = i.user.id;
                if (!i.guild || !i.channel) {
                    return i.reply({
                        content: '봇이 들어가 있는 서버에서만 초대 링크를 만들 수 있어요. (봇이 없는 서버는 디스코드 제한으로 불가능해요)',
                        flags: 64,
                    });
                }
                // 누구나 초대 링크를 뽑지 못하게: 소유자 또는 초대 권한이 있는 사람만
                const canInvite = isOwnerId(uid) || i.memberPermissions?.has(PermissionFlagsBits.CreateInstantInvite);
                if (!canInvite) {
                    return i.reply({ content: '이 서버에서 **초대 코드 만들기** 권한이 있는 사람만 사용할 수 있어요.', flags: 64 });
                }

                // 스레드면 부모 채널에서 만들어야 해요
                const channel = i.channel.isThread?.() ? i.channel.parent : i.channel;
                if (!channel || typeof channel.createInvite !== 'function') {
                    return i.reply({ content: '이 채널에서는 초대 링크를 만들 수 없어요. 다른 채널에서 시도해주세요.', flags: 64 });
                }
                if (!channel.permissionsFor(i.guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)) {
                    return i.reply({ content: '봇에게 이 채널의 **초대 코드 만들기** 권한이 없어요.', flags: 64 });
                }

                const hours = i.options.getInteger('시간') ?? 24;
                const uses = i.options.getInteger('횟수') ?? 0;

                try {
                    const invite = await channel.createInvite({
                        maxAge: hours * 3600,   // 0이면 만료 없음
                        maxUses: uses,          // 0이면 무제한
                        unique: true,
                        reason: `${i.user.tag} 님이 /초대링크로 생성`,
                    });
                    return i.reply({
                        content:
                            `🔗 **${i.guild.name}** 초대 링크\n${invite.url}\n` +
                            `• 유효 시간: ${hours === 0 ? '무제한' : `${hours}시간`}\n` +
                            `• 사용 횟수: ${uses === 0 ? '무제한' : `${uses}회`}`,
                        flags: 64, // 나에게만 보임
                    });
                } catch (err) {
                    console.error('/초대링크 생성 실패:', err.message);
                    return i.reply({ content: '초대 링크를 만들지 못했어요. 봇 권한을 확인해주세요.', flags: 64 });
                }
            },
        },

                {
            target: 'extras', where: GUILD_ONLY, guildOnly: true,
            def: {
                name: '후원', description: '포인트를 후원해요',
                options: [
                    { type: STR, name: '포인트', description: '후원할 포인트 (숫자, 올인, 반)', required: true },
                ],
            },
             build: i => {
                const receiver = CONFIG.DONATE_RECEIVER_IDS[0];
                return `!출금 ${receiver} ${i.options.getString('포인트')}`;
            },
        },

                {
            target: 'extras', where: GUILD_ONLY, guildOnly: true,
            def: { name: '서버구성', description: '이 서버의 ID, 전체 인원, 봇 인원을 보여줘요' },
            custom: async i => {
                const uid = i.user.id;
                if (!(CONFIG.EVERYONE || isOwnerId(uid) || allowedIds.has(uid))) {
                    return i.reply({ content: '이 명령어는 봇 소유자와 허용된 사람만 사용할 수 있어요.', flags: 64 });
                }
                if (!i.guild) {
                    return i.reply({ content: '이 명령어는 서버 안에서만 사용할 수 있어요.', flags: 64 });
                }

                await i.deferReply();

                // 봇 수를 정확히 세려면 멤버 목록이 필요해요 (실패하면 캐시된 멤버 기준)
                let members = i.guild.members.cache;
                try {
                    members = await i.guild.members.fetch();
                } catch (err) {
                    console.error('/서버구성 멤버 조회 실패 (캐시로 대체):', err.message);
                }

                const total = i.guild.memberCount;
                const botCount = members.filter(m => m.user.bot).size;
                const humanCount = Math.max(0, total - botCount);

                const embed = new EmbedBuilder()
                    .setColor(0x5865f2)
                    .setTitle(`🧩 ${i.guild.name} 서버 구성`)
                    .setThumbnail(i.guild.iconURL({ size: 256 }))
                    .addFields(
                        { name: '🆔 서버 ID', value: `\`${i.guild.id}\``, inline: false },
                        { name: '👥 전체 인원', value: `${fmt(total)}명`, inline: true },
                        { name: '🙋 유저', value: `${fmt(humanCount)}명`, inline: true },
                        { name: '🤖 봇', value: `${fmt(botCount)}명`, inline: true },
                    )
                    .setTimestamp();

                return i.editReply({ embeds: [embed] });
            },
        },

        {
            target: 'extras', where: GUILD_ONLY, guildOnly: true, // 채팅 메시지를 읽어야 해서 서버에서만 가능
            def: {
                name: '끝말잇기', description: '끝말잇기를 시작하거나 종료해요 (서버 전용)',
                options: [{
                    type: STR, name: '모드', description: '기본은 일반(여럿이 함께)',
                    choices: [{ name: '일반 (여럿이 함께)', value: 'normal' }, { name: '봇전 (봇과 1:1)', value: 'bot' }, { name: '종료', value: 'stop' }],
                }],
            },
            build: i => {
                const mode = i.options.getString('모드') || 'normal';
                return mode === 'bot' ? '!끝말잇기 봇' : mode === 'stop' ? '!끝말잇기종료' : '!끝말잇기';
            },
        },
        
        // ===== 돌격대: 통합 신고·대응 명령어 =====

        {
            target: 'extras',
            where: GUILD_ONLY,
            def: {
                name: '신고',
                description: '의심스러운 활동을 관리자에게 신고합니다',
                options: [
                    {
                        type: STR,
                        name: '내용',
                        description: '확인한 활동과 상황을 설명하세요',
                        required: true,
                        max_length: 1000,
                    },
                    {
                        type: STR,
                        name: '증거링크',
                        description: '관련 증거 링크 (선택)',
                        required: false,
                        max_length: 500,
                    },
                    
                    {
                        type: 5, // BOOLEAN
                        name: '익명',
                        description: '신고자를 숨기고 익명으로 접수할지 선택 (기본: 공개)',
                        required: false,
                    },
                ],
            },

            custom: async i => {
                if (!i.guild) {
                    return i.reply({
                        content: '서버 안에서 신고해 주세요.',
                        flags: 64,
                    });
                }

                const description = i.options.getString('내용', true).trim();
                const evidenceUrl = i.options.getString('증거링크')?.trim() || null;
                const anonymous = i.options.getBoolean('익명') ?? false;

                const record = createIncident({
                    guildId: i.guild.id,
                    reporterId: i.user.id,
                    type: '신고',
                    description,
                    evidenceUrl,
                    anonymous,
                });

                const channel = await getIncidentChannel(i.guild);
                if (!channel) {
                    return i.reply({
                        content:
                            `신고 #${record.id}을 기록했지만 접수 채널이 설정되지 않았거나 접근할 수 없습니다.\n` +
                            '관리자에게 /신고채널설정을 실행해 달라고 요청해 주세요.',
                        flags: 64,
                    });
                }

                try {
                    await channel.send({
                        embeds: [incidentEmbed(record)],
                        allowedMentions: { parse: [] },
                    });
                } catch (err) {
                    console.error('신고 채널 전송 실패:', err);
                    return i.reply({
                        content:
                            `신고 #${record.id}은 저장됐지만 관리자 채널 알림에 실패했습니다.`,
                        flags: 64,
                    });
                }

                return i.reply({
                    content: `신고가 ${anonymous ? '**익명으로** ' : ''}접수됐습니다. 사건 번호: #${record.id}`,
                    flags: 64,
                });
            },
        },

        {
            target: 'extras',
            where: GUILD_ONLY,
            def: {
                name: '신고채널설정',
                description: '신고 접수와 경보를 받을 채널을 설정합니다',
                options: [
                    {
                        type: 7,
                        name: '채널',
                        description: '신고 접수 채널',
                        required: true,
                        channel_types: [0],
                    },
                ],
            },
            custom: async i => {
                if (!isIncidentAdmin(i)) {
                    return i.reply({
                        content: '서버 관리자만 사용할 수 있습니다.',
                        flags: 64,
                    });
                }

                const channel = i.options.getChannel('채널', true);
                const permissions = channel.permissionsFor(client.user);

                if (
                    !channel.isTextBased() ||
                    !permissions?.has([
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.EmbedLinks,
                    ])
                ) {
                    return i.reply({
                        content: '봇이 해당 채널을 보고 메시지와 Embed를 보낼 수 있는지 확인해 주세요.',
                        flags: 64,
                    });
                }

                incidentData.channels[i.guild.id] = channel.id;
                saveIncidentData();

                return i.reply({
                    content: `신고 접수 채널을 ${channel} 로 설정했습니다.`,
                    flags: 64,
                });
            },
        },

        {
            target: 'extras',
            where: GUILD_ONLY,
            def: {
                name: '사건기록',
                description: '사건을 조회하거나 처리 상태를 변경합니다',
                options: [
                    {
                        type: INT,
                        name: '번호',
                        description: '조회 또는 수정할 사건 번호 (생략하면 최근 기록)',
                        required: false,
                        min_value: 1,
                    },
                    {
                        type: STR,
                        name: '상태',
                        description: '변경할 상태 (번호를 지정한 경우)',
                        required: false,
                        choices: INCIDENT_STATUSES.map(s => ({
                            name: s,
                            value: s,
                        })),
                    },
                ],
            },
            custom: async i => {
                if (!isIncidentAdmin(i)) {
                    return i.reply({
                        content: '서버 관리자만 사건 기록을 조회하거나 수정할 수 있습니다.',
                        flags: 64,
                    });
                }

                const number = i.options.getInteger('번호');
                const status = i.options.getString('상태');

                const cases = incidentData.cases.filter(
                    c => c.guildId === i.guild.id
                );

                if (number !== null) {
                    const record = cases.find(c => c.id === number);

                    if (!record) {
                        return i.reply({
                            content: `사건 #${number}을 찾을 수 없습니다.`,
                            flags: 64,
                        });
                    }

                    if (status) {
                        record.status = status;
                        record.updatedAt = new Date().toISOString();
                        saveIncidentData();
                    }

                    return i.reply({
                        content: status
                            ? `사건 #${number}의 상태를 **${status}**(으)로 변경했습니다.`
                            : `사건 #${number} 기록입니다.`,
                        embeds: [incidentEmbed(record)],
                        flags: 64,
                    });
                }

                const recent = cases.slice(-10).reverse();

                if (!recent.length) {
                    return i.reply({
                        content: '등록된 사건이 없습니다.',
                        flags: 64,
                    });
                }

                const lines = recent.map(c =>
                    `**#${c.id}** · ${c.type} · ${c.status}\n` +
                    `${c.description.slice(0, 120)}`
                );

                return i.reply({
                    content: lines.join('\n\n').slice(0, 1900),
                    flags: 64,
                });
            },
        },

        {
            target: 'extras',
            where: GUILD_ONLY,
            def: {
                name: '경보',
                description: '관리자 전용 긴급 상황 경보를 등록합니다',
                options: [
                    {
                        type: STR,
                        name: '내용',
                        description: '확인된 긴급 상황과 필요한 주의사항',
                        required: true,
                        max_length: 1000,
                    },
                ],
            },
            custom: async i => {
                if (!isIncidentAdmin(i)) {
                    return i.reply({
                        content: '서버 관리자만 긴급 경보를 등록할 수 있습니다.',
                        flags: 64,
                    });
                }

                const description = i.options.getString('내용', true).trim();
                const record = createIncident({
                    guildId: i.guild.id,
                    reporterId: i.user.id,
                    type: '긴급 경보',
                    description,
                });

                const channel = await getIncidentChannel(i.guild);
                if (!channel) {
                    return i.reply({
                        content: `경보 #${record.id}은 기록했지만 신고 채널이 설정되지 않았습니다.`,
                        flags: 64,
                    });
                }

                try {
                    await channel.send({
                        content: '⚠️ **관리자 긴급 경보**',
                        embeds: [incidentEmbed(record)],
                        allowedMentions: { parse: [] },
                    });
                } catch (err) {
                    console.error('긴급 경보 전송 실패:', err);
                    return i.reply({
                        content: `경보 #${record.id}은 저장됐지만 채널 전송에 실패했습니다.`,
                        flags: 64,
                    });
                }

                return i.reply({
                    content: `긴급 경보 #${record.id}을 등록했습니다.`,
                    flags: 64,
                });
            },
        },

        {
            target: 'extras',
            where: GUILD_ONLY,
            def: {
                name: '대응현황',
                description: '현재 서버의 사건 처리 현황을 확인합니다',
            },
            custom: async i => {
                if (!isIncidentAdmin(i)) {
                    return i.reply({
                        content: '서버 관리자만 대응 현황을 확인할 수 있습니다.',
                        flags: 64,
                    });
                }

                const cases = incidentData.cases.filter(
                    c => c.guildId === i.guild.id
                );

                const counts = Object.fromEntries(
                    INCIDENT_STATUSES.map(s => [
                        s,
                        cases.filter(c => c.status === s).length,
                    ])
                );

                return i.reply({
                    content:
                        `📋 **${i.guild.name} 대응 현황**\n` +
                        `전체 사건: **${cases.length}건**\n` +
                        INCIDENT_STATUSES.map(s => `${s}: **${counts[s]}건**`).join('\n'),
                    flags: 64,
                });
            },
        },

    ];
    const byName = new Map(SLASH.map(c => [c.def.name, c]));
    const payload = SLASH.map(c => ({ ...c.def, ...c.where }));

    // 전역(global)으로 등록: 서버 + 개인챗(사용자 설치 앱)에서 모두 보여요. (REST로 직접 보내서 설치 위치 옵션이 그대로 전달돼요)
    client.once(Events.ClientReady, async () => {
        try {
            const appId = client.application.id;
            await client.rest.put(Routes.applicationCommands(appId), { body: payload });
            console.log(`슬래시 명령어 ${payload.length}개 등록 완료 (전역)`);
            // 예전에 서버별로 등록해 둔 같은 이름의 명령어는 중복으로 보이니 정리
            for (const guild of client.guilds.cache.values()) {
                await client.rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: [] }).catch(() => {});
            }
        } catch (err) {
            console. error(`슬래시 명령어 등록 실패: ${err.message}\n→ 봇 토큰/권한을 확인해주세요. (서버에서 쓰려면 "applications.commands" 스코프가 필요해요)`);
        }
    });


    // 슬래시 입력을 "메시지처럼" 보이게 감싸서 기존 ! 명령어 코드에 넘겨줌
    function makeFakeMessage(interaction, content, session = null) {
        // 봇이 그 채널에 직접 메시지를 보낼 수 있는 곳(봇이 설치된 서버)인지. 개인챗/사용자 설치 앱이면 응답(followUp)으로만 보내요.
        const botAccess = !!interaction.guild && !!interaction.channel;
        let replied = false;
        const wrap = (id, edit) => ({ id, createdTimestamp: Date.now(), edit });
        const respond = async o => {
            const opts = typeof o === 'string' ? { content: o } : { ...o };
            
            session?.deleters.push(() => interaction.webhook.deleteMessage(m.id));
            return wrap(m.id, e => interaction.webhook.editMessage(m.id, e));
        };
        const baseChannel = interaction.channel || { id: interaction.channelId };
        // channel.send 는 (봇이 접근 가능하고 이미 응답했다면) 일반 채널 메시지로, 아니면 슬래시 응답/후속 응답으로 보냄
        const channel = new Proxy(baseChannel, {
            get(target, prop) {
                if (prop === 'send') {
                    return async o => {
                        if (!(botAccess && replied)) return respond(o);
                        const m = await target.send(o);
                        session?.deleters.push(() => m.delete());
                        return m;
                    };
                }
                const v = Reflect.get(target, prop, target);
                return typeof v === 'function' ? v.bind(target) : v;
            },
        });
        const fake = {
            id: interaction.id,
            content,
            author: interaction.user,
            member: interaction.member,
            guild: interaction.guild,
            channel,
            channelId: interaction.channelId,
            createdTimestamp: interaction.createdTimestamp,
            maxSpam: botAccess ? undefined : CONFIG.SLASH_SPAM_MAX_PRIVATE,
            mentions: { users: { first: () => null }, members: { first: () => null }, channels: { first: () => null } },
            reply: respond,
            // 반응(react)은 슬래시에서 쓸 수 없으니 본인에게만 보이는 안내로 대신함 (예: 도박 쿨타임 ⏳)
            react: async emoji => {
                if (replied) return;
                replied = true;
                await interaction.reply({ content: emoji === '⏳' ? '⏳ 잠깐만요! 잠시 후에 다시 시도해주세요. (쿨타임)' : String(emoji), flags: 64 });
            },
            delete: async () => {},
        };
        return { fake, isReplied: () => replied };
    }

    client.on(Events.InteractionCreate, async interaction => {
       
        if (!interaction.isChatInputCommand()) return;
        const cmd = byName.get(interaction.commandName);
        if (!cmd) return;
        const deny = text => interaction.reply({ content: text, flags: 64 });
        try {
            const uid = interaction.user.id;
            const allowedUser = isOwnerId(uid) || allowedIds.has(uid);
            // ping/타이머는 ! 명령어와 똑같이 소유자·허용된 사람만 사용 가능
            if (cmd.target === 'main' && !allowedUser) {
                return deny('이 명령어는 봇 소유자와 허용된 사람만 사용할 수 있어요.');
            }
            if (cmd.custom) return await cmd.custom(interaction); 
            
            // 서버 밖(개인챗)
            if (!interaction.guild) {
                // 개인챗(DM·그룹챗)에서는 CONFIG.EVERYONE 과 상관없이 소유자·허용된 사람만 사용 가능
                if (!allowedUser) return deny('개인챗에서는 봇 소유자와 허용된 사람만 사용할 수 있어요.');
                if (cmd.guildOnly) return deny('이 명령어는 서버 안에서만 사용할 수 있어요.');
                if (cmd.free) return await cmd.free(interaction); // 포인트 없이 가볍게 즐기는 버전
            }
            
            const { fake, isReplied } = makeFakeMessage(interaction, cmd.build(interaction), session);
            await (cmd.target === 'main' ? handleMain(fake) : handleExtras(fake));
            if (!isReplied()) { // 처리 중 아무 응답도 안 나갔다면(권한 없음 등) 안내
                await deny('이 명령어를 사용할 수 없어요. (권한이 없거나 처리할 수 없는 요청이에요)');
            }
        } catch (err) {
            console.error(`/${interaction.commandName} 처리 중 오류:`, err);
            const msg = { content: '⚠️ 명령어를 처리하는 중 오류가 났어요. 잠시 후 다시 시도해주세요.', flags: 64 };
            if (interaction.replied || interaction.deferred) interaction.followUp(msg).catch(() => {});
            else interaction.reply(msg).catch(() => {});
        }
    });
}

const features = require('./features')({
    client, Events, EmbedBuilder, ChannelType, PermissionFlagsBits,
    isOwnerId, allowedIds, CONFIG, getStdictKey: () => STDICT_KEY,
    createStore, sleep, unix, KST_OFFSET,
});

setupSlash(client, { handleMain: handleMainMessage, handleExtras: msg => extras.handleMessage(msg) });

// 5. 로그인
client.login(token).catch(console.error);