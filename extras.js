// extras.js
// 추가 기능 모듈
//   1) 포인트 경제: !출석 / !송금 / !동전 / !슬롯
//   2) 서버 운영: 입장 자동 환영 + 로그 채널 (입퇴장, 메시지 삭제/수정, 타임아웃, 역할, 음성)
//   3) 끝말잇기: !끝말잇기 / !끝말잇기종료
//
// index.js 에서 require('./extras')(client, ctx) 로 연결합니다.

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, Events, PermissionFlagsBits, ChannelType } = require('discord.js');

// (선택) 표준국어대사전 오픈API 키. config.json 에 "stdictKey": "발급받은키" 를 넣으면
// 끝말잇기에서 실제 있는 단어인지 검사합니다. 없으면 규칙(글자/중복)만 검사해요.
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
    TRANSFER_MIN: 10,               // 최소 송금액
    TRANSFER_FEE_RATE: 0.05,        // 송금 수수료 (0.05 = 5%, 0이면 없음)

    // --- 도박 ---
    MIN_BET: 10,
    MAX_BET: 100_000,
    GAMBLE_COOLDOWN_MS: 3000,       // 도박 명령어 쿨타임
    COIN_WIN_RATE: 0.5,             // 동전 던지기 승률

    // --- 끝말잇기 ---
    CHAIN_TIMEOUT_MS: 60 * 1000,    // 이 시간 동안 아무도 못 잇으면 종료
    CHAIN_ALLOW_SAME_USER: false,   // 같은 사람이 연속으로 이어도 되는지
    CHAIN_REWARD_PER_WORD: 3,       // 단어 1개당 보상 포인트 (참가자 2명 이상일 때만 지급)
    CHAIN_REWARD_MAX_WORDS: 30,     // 한 게임에서 1인당 보상받는 최대 단어 수

    // --- 로그 ---
    LOG_VOICE: true,                // 음성 채널 입퇴장/이동 로그 (시끄러우면 false)
};

// ==================== 공용 유틸 ====================
const KST_OFFSET = 9 * 60 * 60 * 1000;
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

// 표준국어대사전 검사. 키가 없거나 API 오류면 통과(fail-open)시켜서 게임이 멈추지 않게 함
async function checkDictionary(word) {
    if (!STDICT_KEY) return true;
    if (dictCache.has(word)) return dictCache.get(word);
    try {
        const url = `https://stdict.korean.go.kr/api/search.do?key=${encodeURIComponent(STDICT_KEY)}` +
                    `&q=${encodeURIComponent(word)}&req_type=json&type_search=search&method=exact`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return true;
        const data = JSON.parse(await res.text());
        let items = data?.channel?.item || [];
        if (!Array.isArray(items)) items = [items];
        const found = items.some(it =>
            String(it.word || '').replace(/[-^·\s\d]/g, '') === word && (!it.pos || String(it.pos).includes('명사'))
        );
        dictCache.set(word, found);
        return found;
    } catch (err) {
        console.error('사전 검사 실패(통과 처리):', err.message);
        return true;
    }
}

// ==================== 메인 ====================
module.exports = function setupExtras(client, ctx) {
    const { addPoints, getPointUser, parseId, sleep, isOwnerId, isAllowed } = ctx;

    const economy = createStore('economy.json', () => ({ guilds: {} }));   // { guilds: { 서버ID: { 유저ID: { lastDaily, streak } } } }
    const settings = createStore('settings.json', () => ({ guilds: {} })); // { guilds: { 서버ID: { logChannel, welcomeChannel, welcomeMsg } } }

    const getEco = (gid, uid) => {
        const g = (economy.data.guilds[gid] ||= {});
        return (g[uid] ||= { lastDaily: '', streak: 0 });
    };
    const getSet = gid => (settings.data.guilds[gid] ||= {});

    // ---------------------------------------------------------------
    // 2) 로그 / 환영 헬퍼
    // ---------------------------------------------------------------
    const DEFAULT_WELCOME = '{user} 님, **{server}**에 오신 것을 환영합니다! 🎉\n현재 **{count}번째** 멤버예요. 편하게 즐겨주세요!';
    const fillTemplate = (tpl, member) => tpl
        .replaceAll('{user}', `<@${member.id}>`)
        .replaceAll('{server}', member.guild.name)
        .replaceAll('{count}', String(member.guild.memberCount));

    async function sendWelcome(member) {
        const gs = settings.data.guilds[member.guild.id];
        if (!gs?.welcomeChannel) return;
        const ch = member.guild.channels.cache.get(gs.welcomeChannel);
        if (!ch) return;
        const embed = new EmbedBuilder()
            .setColor(0xff9ff3)
            .setTitle(`🎉 ${member.guild.name}에 오신 것을 환영합니다!`)
            .setDescription(fillTemplate(gs.welcomeMsg || DEFAULT_WELCOME, member))
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .setTimestamp();
        await ch.send({ content: `<@${member.id}>`, embeds: [embed], allowedMentions: { users: [member.id] } })
            .catch(err => console.error('환영 메시지 전송 실패:', err.message));
    }

    const logEmbed = (color, title) => new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
    async function sendLog(guild, embed) {
        const id = settings.data.guilds[guild.id]?.logChannel;
        if (!id) return;
        const ch = guild.channels.cache.get(id);
        if (!ch) return;
        await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
    }

    const isTextChannel = ch => ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement);
    const botCanSend = (guild, ch) => ch.permissionsFor(guild.members.me)?.has([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    ]);

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

    client.on(Events.VoiceStateUpdate, (oldS, newS) => {
        if (!CONFIG.LOG_VOICE) return;
        const member = newS.member || oldS.member;
        if (!member || member.user.bot) return;
        if (oldS.channelId === newS.channelId) return; // 음소거/헤드셋 변경 등은 무시
        let desc;
        if (!oldS.channelId) desc = `<@${member.id}> 님이 <#${newS.channelId}> 에 입장`;
        else if (!newS.channelId) desc = `<@${member.id}> 님이 <#${oldS.channelId}> 에서 퇴장`;
        else desc = `<@${member.id}> 님이 <#${oldS.channelId}> → <#${newS.channelId}> 이동`;
        sendLog(member.guild, logEmbed(0x3498db, '🎧 음성 채널').setDescription(desc));
    });

    // ---------------------------------------------------------------
    // 3) 끝말잇기
    // ---------------------------------------------------------------
    const chains = new Map(); // channelId -> game

    function armChainTimer(channel, game) {
        clearTimeout(game.timer);
        game.timer = setTimeout(() => endChain(channel, '⏰ 시간이 다 됐어요!'), CONFIG.CHAIN_TIMEOUT_MS);
    }

    async function endChain(channel, reason) {
        const game = chains.get(channel.id);
        if (!game) return;
        clearTimeout(game.timer);
        chains.delete(channel.id);

        const rank = [...game.scores.entries()].sort((a, b) => b[1] - a[1]);
        const medals = ['🥇', '🥈', '🥉'];
        const rewarded = rank.length >= 2;

        let lines = '아무도 단어를 잇지 않았어요.';
        if (rank.length > 0) {
            lines = rank.slice(0, 10).map(([uid, n], i) => {
                const reward = rewarded ? Math.min(n, CONFIG.CHAIN_REWARD_MAX_WORDS) * CONFIG.CHAIN_REWARD_PER_WORD : 0;
                return `${medals[i] || `**${i + 1}.**`} <@${uid}> - ${n}단어${reward ? ` (+${fmt(reward)}P)` : ''}`;
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

    async function handleChainWord(message, game, word) {
        const react = e => message.react(e).catch(() => {});
        if (game.pending) return; // 사전 검사 중에는 다른 입력 무시 (동시 입력 꼬임 방지)

        const uid = message.author.id;
        if (!CONFIG.CHAIN_ALLOW_SAME_USER && game.lastUserId === uid) return react('⛔');

        if (!startVariants(game.lastWord.slice(-1)).includes(word[0])) return react('❌');
        if (game.used.has(word)) return react('🔁');

        game.pending = true;
        let ok;
        try { ok = await checkDictionary(word); } finally { game.pending = false; }
        if (chains.get(message.channel.id) !== game) return; // 검사 도중 게임이 끝났으면 무시
        if (!ok) return react('❓');

        game.used.add(word);
        game.lastWord = word;
        game.lastUserId = uid;
        game.scores.set(uid, (game.scores.get(uid) || 0) + 1);
        armChainTimer(message.channel, game);

        react('✅');
        message.channel.send(`➡️ 다음 글자: **${startVariants(word.slice(-1)).join(' / ')}**`).catch(() => {});
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
    // 메시지 처리
    // ---------------------------------------------------------------
    async function onMessage(message) {
        if (message.author.bot || !message.guild) return;
        const content = message.content.trim();
        const gid = message.guild.id;
        const uid = message.author.id;

        // --- 끝말잇기 진행 중인 채널의 일반 메시지 ---
        if (!content.startsWith('!')) {
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

        // !송금 @멘션 [포인트]
        if (cmd === '!송금') {
            if (!canUse) return;
            const targetId = message.mentions.users.first()?.id || parseId(args[1]);
            const amount = parseInt((args[2] || '').replace(/,/g, ''), 10);
            if (!targetId || !Number.isInteger(amount)) {
                return message.reply('사용법: `!송금 @멘션 [포인트]`');
            }
            if (amount < CONFIG.TRANSFER_MIN) {
                return message.reply(`최소 **${fmt(CONFIG.TRANSFER_MIN)}P**부터 송금할 수 있어요.`);
            }
            if (targetId === uid) return message.reply('본인에게는 송금할 수 없어요 😅');

            const targetMember = await message.guild.members.fetch(targetId).catch(() => null);
            if (!targetMember) return message.reply('이 서버에서 해당 사용자를 찾을 수 없어요.');
            if (targetMember.user.bot) return message.reply('봇에게는 송금할 수 없어요 🤖');

            // ↓ 여기부터 await 없이 동기 처리 (잔액 확인과 차감이 끊기지 않게)
            const fee = Math.floor(amount * CONFIG.TRANSFER_FEE_RATE);
            const received = amount - fee;
            const me = getPointUser(gid, uid);
            if (me.points < amount) return message.reply(`포인트가 부족해요! 보유: **${fmt(me.points)}P**`);
            addPoints(gid, uid, -amount, 'manual');
            addPoints(gid, targetId, received, 'manual');

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

        // ================= 2) 로그 / 환영 설정 (서버 관리 권한 필요) =================
        const SETTING_CMDS = ['!로그채널', '!로그채널해제', '!환영채널', '!환영채널해제', '!환영메시지', '!환영메시지초기화', '!환영테스트'];
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
                        '사용 가능한 변수: `{user}` 멘션, `{server}` 서버 이름, `{count}` 현재 인원\n' +
                        '예) `!환영메시지 {user} 님 어서오세요! {server}의 {count}번째 멤버예요 🎉`'
                    );
                }
                if (text.length > 500) return message.reply('환영 메시지는 500자 이내로 입력해주세요.');
                gs.welcomeMsg = text;
                settings.save();
                return message.reply('✅ 환영 메시지를 저장했어요. `!환영테스트`로 확인해보세요.');
            }
            if (cmd === '!환영메시지초기화') {
                delete gs.welcomeMsg;
                settings.save();
                return message.reply('♻️ 환영 메시지를 기본값으로 되돌렸어요.');
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
            const existing = chains.get(message.channel.id);
            if (existing) {
                return message.reply(`이미 진행 중이에요! 마지막 단어: **${existing.lastWord}** → 다음 글자: **${startVariants(existing.lastWord.slice(-1)).join(' / ')}**`);
            }

            const first = CHAIN_START_WORDS[Math.floor(Math.random() * CHAIN_START_WORDS.length)];
            const game = {
                starterId: uid,
                lastWord: first,
                used: new Set([first]),
                lastUserId: null,
                scores: new Map(),
                pending: false,
                timer: null,
            };
            chains.set(message.channel.id, game);
            armChainTimer(message.channel, game);

            const embed = new EmbedBuilder()
                .setColor(0x1abc9c)
                .setTitle('🔤 끝말잇기 시작!')
                .setDescription(
                    `시작 단어: **${first}**\n다음 글자: **${startVariants(first.slice(-1)).join(' / ')}**\n\n` +
                    '• 한글 2글자 이상 **단어 하나만** 입력하세요 (두음법칙 적용)\n' +
                    '• ✅ 성공 · ❌ 글자 불일치 · 🔁 이미 쓴 단어 · ⛔ 연속 입력 · ❓ 사전에 없는 단어\n' +
                    `• ${CONFIG.CHAIN_TIMEOUT_MS / 1000}초 동안 아무도 못 이으면 종료돼요\n` +
                    '• 종료: `!끝말잇기종료`'
                )
                .setFooter({ text: STDICT_KEY ? '표준국어대사전으로 단어를 검사해요' : '사전 검사 없이 글자·중복 규칙만 확인해요' });
            return message.channel.send({ embeds: [embed] });
        }

        if (cmd === '!끝말잇기종료') {
            const game = chains.get(message.channel.id);
            if (!game) return message.reply('진행 중인 끝말잇기가 없어요.');
            if (game.starterId !== uid && !isManager) {
                return message.reply('게임을 시작한 사람이나 서버 관리자만 종료할 수 있어요.');
            }
            return endChain(message.channel, '🏁 게임이 종료됐어요.');
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
        flush() { economy.flush(); settings.flush(); },
    };
};

module.exports.startVariants = startVariants; // 테스트용