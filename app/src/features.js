// features.js - 단어검색 / 티켓 / 환율 · 코인 · 주식
// 봇 파일과 같은 폴더에 두고, 봇 파일에서 require('./features')(...) 로 불러와요.
module.exports = function (ctx) {
const {
    client, Events, EmbedBuilder, ChannelType, PermissionFlagsBits,
    isOwnerId, allowedIds, CONFIG, getStdictKey, createStore, sleep, unix, KST_OFFSET,
} = ctx;

// ---------- 단어 검색 (표준국어대사전 + 영어사전) ----------
const stripTags = s => String(s || '').replace(/<[^>]*>/g, '').trim();

// 반환: 배열(없으면 []) / 검사 못 했으면 null (키 없음·서버 오류)
async function lookupStdict(word) {
    if (!getStdictKey()) return null;
    try {
        const url = `https://stdict.korean.go.kr/api/search.do?key=${encodeURIComponent(getStdictKey())}` +
                    `&q=${encodeURIComponent(word)}&req_type=json&type_search=search&method=exact&num=10`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return null;
        const text = (await res.text()).trim();
        if (!text) return [];
        const data = JSON.parse(text);
        if (data?.error) {
            console.error('표준국어대사전 API 오류:', JSON.stringify(data.error));
            return null;
        }
        let items = data?.channel?.item || [];
        if (!Array.isArray(items)) items = [items];
        return items.map(it => {
            let senses = it.sense || [];
            if (!Array.isArray(senses)) senses = [senses];
            return {
                word: String(it.word || '').replace(/[-^·]/g, ''),
                pos: it.pos || '',
                defs: senses.map(s => stripTags(s.definition)).filter(Boolean),
                link: it.link || null,
            };
        }).filter(e => e.defs.length > 0);
    } catch (err) {
        console.error('국어사전 검색 실패:', err.message);
        return null;
    }
}

async function lookupEnglish(word) {
    try {
        const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { signal: AbortSignal.timeout(6000) });
        if (res.status === 404) return [];
        if (!res.ok) return null;
        const data = await res.json();
        const out = [];
        for (const entry of data) {
            for (const m of entry.meanings || []) {
                const defs = (m.definitions || []).map(d => d.definition).filter(Boolean);
                if (defs.length) out.push({ word: entry.word, pos: m.partOfSpeech || '', defs, phonetic: entry.phonetic || '' });
            }
        }
        return out;
    } catch (err) {
        console.error('영어사전 검색 실패:', err.message);
        return null;
    }
}

// /단어검색 처리
async function handleWordSearch(interaction) {
    const uid = interaction.user.id;
    const allowedUser = isOwnerId(uid) || allowedIds.has(uid);
    if (!interaction.guild && !allowedUser) {
        return interaction.reply({ content: '개인챗에서는 봇 소유자와 허용된 사람만 사용할 수 있어요.', flags: 64 });
    }
    if (!(CONFIG.EVERYONE || allowedUser)) {
        return interaction.reply({ content: '이 명령어는 봇 소유자와 허용된 사람만 사용할 수 있어요.', flags: 64 });
    }

    const word = interaction.options.getString('단어').trim();
    await interaction.deferReply();

    const hasHangul = /[가-힣]/.test(word);
    const isLatin = /^[A-Za-z][A-Za-z\s'-]*$/.test(word);
    const order = hasHangul ? ['ko'] : isLatin ? ['en', 'ko'] : ['ko', 'en'];

    let failed = false;
    for (const src of order) {
        const result = src === 'ko' ? await lookupStdict(word) : await lookupEnglish(word);
        if (result === null) { failed = true; continue; }
        if (result.length === 0) continue;

        const embed = new EmbedBuilder().setTimestamp();
        if (src === 'ko') {
            embed.setColor(0x3498db).setTitle(`📖 ${word}`).setFooter({ text: '출처: 국립국어원 표준국어대사전' });
            for (const e of result.slice(0, 6)) {
                const lines = e.defs.slice(0, 4).map((d, i) => `**${i + 1}.** ${d}`).join('\n');
                embed.addFields({
                    name: `${e.word}${e.pos ? ` 「${e.pos}」` : ''}`,
                    value: (lines + (e.link ? `\n[사전에서 보기](${e.link})` : '')).slice(0, 1024),
                });
            }
        } else {
            embed.setColor(0xe67e22).setTitle(`📘 ${result[0].word}`)
                .setDescription(result[0].phonetic ? `발음: ${result[0].phonetic}` : null)
                .setFooter({ text: '출처: Free Dictionary API (영어사전)' });
            for (const e of result.slice(0, 5)) {
                const lines = e.defs.slice(0, 3).map((d, i) => `**${i + 1}.** ${d}`).join('\n');
                embed.addFields({ name: e.pos || '뜻', value: lines.slice(0, 1024) });
            }
        }
        return interaction.editReply({ embeds: [embed] });
    }

    return interaction.editReply(
        failed
            ? `⚠️ 사전 서버에 연결하지 못했거나 사전 API 키가 설정되지 않았어요. 잠시 후 다시 시도해주세요.`
            : `'${word}' 의 뜻풀이를 사전에서 찾지 못했어요. 철자를 확인해주세요.`
    );
}

// =====================================================================
//  추가 기능: 티켓 시스템 / 환율 · 코인 · 주식 시세
// =====================================================================

// 공통: 슬래시 명령어 사용 권한 확인
async function slashGate(i) {
    const uid = i.user.id;
    const allowedUser = isOwnerId(uid) || allowedIds.has(uid);
    if (!i.guild && !allowedUser) {
        await i.reply({ content: '개인챗에서는 봇 소유자와 허용된 사람만 사용할 수 있어요.', flags: 64 });
        return false;
    }
    if (!(CONFIG.EVERYONE || allowedUser)) {
        await i.reply({ content: '이 명령어는 봇 소유자와 허용된 사람만 사용할 수 있어요.', flags: 64 });
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------
//  🎫 티켓 시스템
//   /티켓설정  : 패널(버튼) 메시지를 보내고 담당 역할/카테고리/로그 채널을 저장 (서버 관리 권한)
//   [🎫 티켓 열기] 버튼 : 나와 담당자만 볼 수 있는 비공개 채널 생성 (1인 1티켓)
//   [🔒 티켓 닫기] 버튼 : 확인 후 대화 기록(.txt)을 로그 채널에 남기고 채널 삭제
//   /티켓추가, /티켓제거 : 티켓에 사람 초대/내보내기 (담당자만)
//   필요한 봇 권한: 채널 관리, 채널 보기, 메시지 보내기, 링크 임베드, 메시지 기록 보기
// ---------------------------------------------------------------------
const ticketStore = createStore('tickets.json', () => ({ guilds: {}, tickets: {} }));
// guilds: { 서버ID: { staffRole, category, logChannel, counter } } / tickets: { 채널ID: { guildId, userId, number, createdAt } }

const padNum = n => String(n).padStart(4, '0');
const TICKET_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];

const isTicketStaff = (member, gs) =>
    !!member && (isOwnerId(member.id) || (gs?.staffRole && member.roles.cache.has(gs.staffRole)) || member.permissions.has(PermissionFlagsBits.ManageChannels));

async function ticketSetup(i) {
    if (!i.guild) return i.reply({ content: '서버 안에서만 사용할 수 있어요.', flags: 64 });
    if (!(isOwnerId(i.user.id) || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild))) {
        return i.reply({ content: '이 명령어는 **서버 관리** 권한이 있는 사람만 사용할 수 있어요.', flags: 64 });
    }
    const me = i.guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return i.reply({ content: '봇에게 **채널 관리** 권한이 없어요. 권한을 준 뒤 다시 시도해주세요.', flags: 64 });
    }
    const panelCh = i.guild.channels.cache.get(i.options.getChannel('패널채널').id);
    const role = i.options.getRole('담당역할');
    const cat = i.options.getChannel('카테고리');
    const logCh = i.options.getChannel('로그채널');
    if (!panelCh || !panelCh.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        return i.reply({ content: '봇이 패널 채널에서 메시지를 보낼 권한이 없어요.', flags: 64 });
    }

    await i.deferReply({ flags: 64 });
    const old = ticketStore.data.guilds[i.guild.id] || {};
    ticketStore.data.guilds[i.guild.id] = {
        staffRole: role.id,
        category: cat?.id || null,
        logChannel: logCh?.id || null,
        counter: old.counter || 0,
    };
    ticketStore.flush();

    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎫 문의 / 지원 티켓')
        .setDescription('도움이 필요하거나 문의할 내용이 있으면 아래 버튼을 눌러주세요.\n나와 담당자만 볼 수 있는 비공개 채널이 만들어져요.')
        .setFooter({ text: '1인당 티켓은 한 개만 열 수 있어요' });
    await panelCh.send({
        embeds: [embed],
        components: [{ type: 1, components: [{ type: 2, style: 1, label: '🎫 티켓 열기', custom_id: 'ticket:open' }] }],
    });
    return i.editReply(
        `✅ 티켓 패널을 <#${panelCh.id}> 에 보냈어요.\n` +
        `담당 역할: <@&${role.id}> · 카테고리: ${cat ? cat.name : '없음'} · 로그: ${logCh ? `<#${logCh.id}>` : '없음'}`
    );
}

async function ticketOpen(i) {
    const guild = i.guild;
    if (!guild) return;
    const gs = ticketStore.data.guilds[guild.id];
    if (!gs) return i.reply({ content: '티켓 설정이 아직 안 되어 있어요. 관리자에게 문의해주세요.', flags: 64 });

    // 이미 열린 티켓이 있는지 (채널이 사라진 기록은 정리)
    for (const [cid, t] of Object.entries(ticketStore.data.tickets)) {
        if (t.guildId !== guild.id || t.userId !== i.user.id) continue;
        if (guild.channels.cache.has(cid)) return i.reply({ content: `이미 열려 있는 티켓이 있어요: <#${cid}>`, flags: 64 });
        delete ticketStore.data.tickets[cid];
    }

    await i.deferReply({ flags: 64 });
    const number = (gs.counter = (gs.counter || 0) + 1);
    const staffRole = guild.roles.cache.get(gs.staffRole);
    const overwrites = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: i.user.id, allow: TICKET_PERMS },
        { id: client.user.id, allow: [...TICKET_PERMS, PermissionFlagsBits.ManageChannels] },
    ];
    if (staffRole) overwrites.push({ id: staffRole.id, allow: TICKET_PERMS });

    let ch;
    try {
        ch = await guild.channels.create({
            name: `${i.user.username}님의-티켓`
                .replace(/[^a-zA-Z0-9가-힣_-]/g, '')
                .slice(0, 90),
            type: ChannelType.GuildText,
            parent: gs.category && guild.channels.cache.has(gs.category) ? gs.category : undefined,
            topic: `티켓 #${number} · ${i.user.tag} (${i.user.id})`,
            permissionOverwrites: overwrites,
        });
    } catch (err) {
        console.error('티켓 채널 생성 실패:', err);
        return i.editReply('⚠️ 티켓 채널을 만들지 못했어요. 봇 권한(채널 관리)을 확인해달라고 관리자에게 알려주세요.');
    }

    ticketStore.data.tickets[ch.id] = { guildId: guild.id, userId: i.user.id, number, createdAt: Date.now() };
    ticketStore.flush();

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(`🎫 티켓 #${padNum(number)}`)
        .setDescription(`<@${i.user.id}> 님, 문의 내용을 자세히 적어주세요.\n담당자가 확인하는 대로 답변드릴게요.`)
        .setTimestamp();
    await ch.send({
        content: `<@${i.user.id}>${staffRole ? ` <@&${staffRole.id}>` : ''}`,
        embeds: [embed],
        components: [{ type: 1, components: [{ type: 2, style: 4, label: '🔒 티켓 닫기', custom_id: 'ticket:close' }] }],
        allowedMentions: { users: [i.user.id], roles: staffRole ? [staffRole.id] : [] },
    }).catch(() => {});
    return i.editReply(`🎫 티켓이 열렸어요: <#${ch.id}>`);
}

async function ticketAskClose(i) {
    const t = ticketStore.data.tickets[i.channelId];
    if (!t) return i.reply({ content: '이 채널은 티켓으로 등록되어 있지 않아요.', flags: 64 });
    const gs = ticketStore.data.guilds[t.guildId];
    if (i.user.id !== t.userId && !isTicketStaff(i.member, gs)) {
        return i.reply({ content: '티켓을 연 사람이나 담당자만 닫을 수 있어요.', flags: 64 });
    }
    return i.reply({
        content: '정말 이 티켓을 닫을까요? 대화 기록이 저장된 뒤 채널이 **삭제**돼요.',
        components: [{ type: 1, components: [
            { type: 2, style: 4, label: '닫기', custom_id: 'ticket:confirm' },
            { type: 2, style: 2, label: '취소', custom_id: 'ticket:cancel' },
        ] }],
        flags: 64,
    });
}

async function buildTranscript(channel) {
    const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!msgs) return null;
    const lines = [...msgs.values()].reverse()
        .filter(m => m.content || m.attachments.size)
        .map(m => {
            const t = new Date(m.createdTimestamp + KST_OFFSET).toISOString().replace('T', ' ').slice(0, 19);
            const att = m.attachments.size ? ' ' + m.attachments.map(a => a.url).join(' ') : '';
            return `[${t}] ${m.author.tag}: ${m.content}${att}`;
        });
    return Buffer.from(lines.join('\n') || '(내용 없음)', 'utf8');
}

async function ticketConfirmClose(i) {
    const t = ticketStore.data.tickets[i.channelId];
    if (!t) return i.update({ content: '이미 처리된 티켓이에요.', components: [] });
    const gs = ticketStore.data.guilds[t.guildId];
    if (i.user.id !== t.userId && !isTicketStaff(i.member, gs)) {
        return i.reply({ content: '티켓을 연 사람이나 담당자만 닫을 수 있어요.', flags: 64 });
    }
    await i.update({ content: '🔒 5초 뒤에 티켓이 닫혀요...', components: [] });

    const channel = i.channel;
    const buf = await buildTranscript(channel);
    const logCh = gs?.logChannel && i.guild.channels.cache.get(gs.logChannel);
    if (logCh && buf) {
        const embed = new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle(`🔒 티켓 #${padNum(t.number)} 닫힘`)
            .addFields(
                { name: '연 사람', value: `<@${t.userId}>`, inline: true },
                { name: '닫은 사람', value: `<@${i.user.id}>`, inline: true },
                { name: '열린 시간', value: `<t:${unix(t.createdAt)}:R>`, inline: true },
            )
            .setTimestamp();
        await logCh.send({
            embeds: [embed],
            files: [{ attachment: buf, name: `ticket-${padNum(t.number)}.txt` }],
            allowedMentions: { parse: [] },
        }).catch(err => console.error('티켓 로그 전송 실패:', err.message));
    }

    delete ticketStore.data.tickets[channel.id];
    ticketStore.flush();
    await sleep(5000);
    channel.delete(`티켓 닫힘 (${i.user.tag})`).catch(() => {});
}

// /티켓추가, /티켓제거 (담당자 전용)
async function ticketMember(i, add) {
    const t = ticketStore.data.tickets[i.channelId];
    if (!i.guild || !t) return i.reply({ content: '티켓 채널 안에서만 사용할 수 있어요.', flags: 64 });
    const gs = ticketStore.data.guilds[t.guildId];
    if (!isTicketStaff(i.member, gs)) return i.reply({ content: '담당자만 사용할 수 있어요.', flags: 64 });

    const user = i.options.getUser('유저');
    if (user.bot) return i.reply({ content: '봇은 추가/제거할 수 없어요.', flags: 64 });
    if (user.id === t.userId && !add) return i.reply({ content: '티켓을 연 사람은 내보낼 수 없어요.', flags: 64 });
    try {
        if (add) await i.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
        else await i.channel.permissionOverwrites.delete(user.id);
    } catch (err) {
        console.error('티켓 멤버 변경 실패:', err);
        return i.reply({ content: '권한을 바꾸지 못했어요. 봇 권한을 확인해주세요.', flags: 64 });
    }
    return i.reply({ content: `${add ? '➕' : '➖'} <@${user.id}> 님을 티켓에서 ${add ? '추가' : '제거'}했어요.`, allowedMentions: { parse: [] } });
}

// 티켓 버튼 처리
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isButton() || !interaction.customId.startsWith('ticket:')) return;
    try {
        if (!interaction.guild) return;
        switch (interaction.customId) {
            case 'ticket:open': return await ticketOpen(interaction);
            case 'ticket:close': return await ticketAskClose(interaction);
            case 'ticket:confirm': return await ticketConfirmClose(interaction);
            case 'ticket:cancel': return await interaction.update({ content: '취소했어요.', components: [] });
        }
    } catch (err) {
        console.error('티켓 버튼 처리 중 오류:', err);
        const msg = { content: '⚠️ 처리 중 오류가 났어요. 잠시 후 다시 시도해주세요.', flags: 64 };
        if (interaction.replied || interaction.deferred) interaction.followUp(msg).catch(() => {});
        else interaction.reply(msg).catch(() => {});
    }
});

// 티켓 채널을 수동으로 지웠을 때 기록 정리
client.on(Events.ChannelDelete, ch => {
    if (ticketStore.data.tickets[ch.id]) {
        delete ticketStore.data.tickets[ch.id];
        ticketStore.flush();
    }
});

// 종료 시 티켓 기록도 저장
process.on('SIGINT', () => ticketStore.flush());
process.on('SIGTERM', () => ticketStore.flush());

// ---------------------------------------------------------------------
//  💹 환율 / 코인 / 주식
// ---------------------------------------------------------------------
const MARKET_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)', 'Accept': 'application/json' };
async function fetchJsonUA(url) {
    const res = await fetch(url, { headers: MARKET_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}
const UPDOWN = (chg) => (chg > 0 ? { arrow: '🔺', color: 0xe74c3c } : chg < 0 ? { arrow: '🔻', color: 0x3498db } : { arrow: '➖', color: 0x95a5a6 }); // 한국식: 상승 빨강, 하락 파랑
const priceStr = (n, max = 8) => Number(n).toLocaleString('ko-KR', { maximumFractionDigits: max });
const signed = (n, max = 2) => (n > 0 ? '+' : '') + Number(n).toLocaleString('ko-KR', { maximumFractionDigits: max });

// ---------- 환율 ----------
const CURRENCY_ALIASES = {
    '원': 'KRW', '원화': 'KRW', '한화': 'KRW', '달러': 'USD', '미국달러': 'USD', '엔': 'JPY', '엔화': 'JPY', '일본엔': 'JPY',
    '유로': 'EUR', '위안': 'CNY', '위안화': 'CNY', '파운드': 'GBP', '영국파운드': 'GBP', '호주달러': 'AUD', '캐나다달러': 'CAD',
    '홍콩달러': 'HKD', '싱가포르달러': 'SGD', '바트': 'THB', '루피': 'INR', '페소': 'PHP', '동': 'VND', '프랑': 'CHF', '루블': 'RUB', '리라': 'TRY',
};
const toCurrencyCode = t => { const s = String(t || '').replace(/\s+/g, ''); return CURRENCY_ALIASES[s] || s.toUpperCase(); };

let rateCache = { at: 0, data: null };
async function getRates() {
    if (rateCache.data && Date.now() - rateCache.at < 10 * 60 * 1000) return rateCache.data;
    const d = await fetchJsonUA('https://open.er-api.com/v6/latest/USD');
    if (d.result !== 'success') throw new Error('환율 응답 오류');
    rateCache = { at: Date.now(), data: d };
    return d;
}

async function handleExchange(i) {
    if (!(await slashGate(i))) return;
    const from = toCurrencyCode(i.options.getString('통화'));
    const to = toCurrencyCode(i.options.getString('기준통화') || 'KRW');
    const amount = i.options.getNumber('금액') ?? 1;
    await i.deferReply();
    try {
        const d = await getRates();
        const rf = d.rates[from], rt = d.rates[to];
        if (!rf || !rt) {
            return i.editReply(`'${!rf ? from : to}' 통화를 찾지 못했어요. \`USD\`, \`JPY\`, \`EUR\` 같은 코드나 \`달러\`, \`엔\`, \`유로\` 처럼 입력해주세요.`);
        }
        const rate = rt / rf;                // 1 from = rate to
        const result = amount * rate;
        const digits = n => (n >= 100 ? 2 : n >= 1 ? 4 : 6);
        const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle(`💱 ${from} → ${to}`)
            .setDescription(`**${priceStr(amount)} ${from}** = **${priceStr(result, digits(result))} ${to}**`)
            .addFields(
                { name: `1 ${from}`, value: `${priceStr(rate, digits(rate))} ${to}`, inline: true },
                { name: `1 ${to}`, value: `${priceStr(1 / rate, digits(1 / rate))} ${from}`, inline: true },
            )
            .setFooter({ text: '출처: open.er-api.com · 은행 매매기준율과 다를 수 있어요' })
            .setTimestamp(d.time_last_update_unix ? d.time_last_update_unix * 1000 : Date.now());
        return i.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('환율 조회 실패:', err.message);
        return i.editReply('환율 정보를 가져오지 못했어요. 잠시 후 다시 시도해주세요.');
    }
}

// ---------- 코인 (업비트 원화 마켓) ----------
let upbitCache = { at: 0, list: [] };
async function getUpbitMarkets() {
    if (upbitCache.list.length && Date.now() - upbitCache.at < 60 * 60 * 1000) return upbitCache.list;
    const data = await fetchJsonUA('https://api.upbit.com/v1/market/all?isDetails=false');
    upbitCache = { at: Date.now(), list: data.filter(m => m.market.startsWith('KRW-')) };
    return upbitCache.list;
}
function findUpbitMarket(list, q) {
    const raw = q.trim(), low = raw.toLowerCase().replace(/\s+/g, '');
    return list.find(m => m.market.slice(4).toLowerCase() === low || m.korean_name === raw || m.english_name.toLowerCase().replace(/\s+/g, '') === low)
        || list.find(m => m.korean_name.includes(raw) || m.english_name.toLowerCase().includes(raw.toLowerCase()));
}

async function handleCoin(i) {
    if (!(await slashGate(i))) return;
    const q = i.options.getString('코인');
    await i.deferReply();
    try {
        const list = await getUpbitMarkets();
        const m = findUpbitMarket(list, q);
        if (!m) return i.editReply(`'${q}' 코인을 업비트 원화 마켓에서 찾지 못했어요. 예: \`비트코인\`, \`ETH\`, \`리플\``);
        const [t] = await fetchJsonUA(`https://api.upbit.com/v1/ticker?markets=${m.market}`);
        const ud = UPDOWN(t.signed_change_price);
        const embed = new EmbedBuilder()
            .setColor(ud.color)
            .setTitle(`🪙 ${m.korean_name} (${m.market.slice(4)})`)
            .setDescription(`# ${priceStr(t.trade_price)}원\n${ud.arrow} ${signed(t.signed_change_price)}원 (${signed(t.signed_change_rate * 100)}%) · 전일 대비`)
            .addFields(
                { name: '📈 당일 고가', value: `${priceStr(t.high_price)}원`, inline: true },
                { name: '📉 당일 저가', value: `${priceStr(t.low_price)}원`, inline: true },
                { name: '💰 24시간 거래대금', value: `${priceStr(Math.round(t.acc_trade_price_24h / 1e8))}억원`, inline: true },
                { name: '🏔️ 52주 최고', value: `${priceStr(t.highest_52_week_price)}원`, inline: true },
                { name: '🕳️ 52주 최저', value: `${priceStr(t.lowest_52_week_price)}원`, inline: true },
                { name: '⏮️ 전일 종가', value: `${priceStr(t.prev_closing_price)}원`, inline: true },
            )
            .setFooter({ text: '출처: 업비트 · 투자 참고용이며 손실에 책임지지 않아요' })
            .setTimestamp();
        return i.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('코인 조회 실패:', err.message);
        return i.editReply('코인 시세를 가져오지 못했어요. 잠시 후 다시 시도해주세요.');
    }
}

// ---------- 주식 (Yahoo Finance, 키 불필요) ----------
const STOCK_ALIASES = {
    '삼성전자': '005930.KS', '삼성': '005930.KS', 'SK하이닉스': '000660.KS', '하이닉스': '000660.KS', '네이버': '035420.KS', 'NAVER': '035420.KS',
    '카카오': '035720.KS', '현대차': '005380.KS', '현대자동차': '005380.KS', '기아': '000270.KS', 'LG에너지솔루션': '373220.KS', '셀트리온': '068270.KS',
    '애플': 'AAPL', '테슬라': 'TSLA', '엔비디아': 'NVDA', '마이크로소프트': 'MSFT', '구글': 'GOOGL', '알파벳': 'GOOGL', '아마존': 'AMZN', '메타': 'META', '넷플릭스': 'NFLX',
};

// 반환: { symbol, meta, closes } / 없으면 null
async function getStockChart(symbol) {
    try {
        const d = await fetchJsonUA(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`);
        const r = d?.chart?.result?.[0];
        if (!r?.meta || r.meta.regularMarketPrice == null) return null;
        const closes = (r.indicators?.quote?.[0]?.close || []).filter(v => v != null);
        return { symbol, meta: r.meta, closes };
    } catch { return null; }
}

async function findStock(q) {
    const key = q.replace(/\s+/g, '');
    if (STOCK_ALIASES[key]) return getStockChart(STOCK_ALIASES[key]);
    if (/^\d{6}$/.test(key)) return (await getStockChart(`${key}.KS`)) || (await getStockChart(`${key}.KQ`));
    if (/^[A-Za-z.\-]{1,10}$/.test(key)) {
        const direct = await getStockChart(key.toUpperCase());
        if (direct) return direct;
    }
    const s = await fetchJsonUA(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0&lang=ko-KR&region=KR`).catch(() => null);
    const hit = s?.quotes?.find(x => ['EQUITY', 'ETF'].includes(x.quoteType));
    return hit ? getStockChart(hit.symbol) : null;
}

async function handleStock(i) {
    if (!(await slashGate(i))) return;
    const q = i.options.getString('종목').trim();
    await i.deferReply();
    try {
        const r = await findStock(q);
        if (!r) return i.editReply(`'${q}' 종목을 찾지 못했어요. 종목코드(예: \`005930\`, \`AAPL\`)나 정확한 이름으로 다시 검색해보세요.`);
        const { meta, closes } = r;
        const cur = meta.regularMarketPrice;
        const prev = closes.length >= 2 ? closes[closes.length - 2] : (meta.chartPreviousClose ?? cur);
        const chg = cur - prev, pct = prev ? (chg / prev) * 100 : 0;
        const ud = UPDOWN(chg);
        const cc = meta.currency || '';
        const digits = cc === 'KRW' ? 0 : 2;
        const unit = cc === 'KRW' ? '원' : ` ${cc}`;
        const embed = new EmbedBuilder()
            .setColor(ud.color)
            .setTitle(`📊 ${meta.longName || meta.shortName || r.symbol} (${r.symbol})`)
            .setDescription(`# ${priceStr(cur, digits)}${unit}\n${ud.arrow} ${signed(chg, digits)}${unit} (${signed(pct)}%) · 전일 대비`)
            .addFields(
                { name: '📈 당일 고가', value: meta.regularMarketDayHigh != null ? `${priceStr(meta.regularMarketDayHigh, digits)}${unit}` : '-', inline: true },
                { name: '📉 당일 저가', value: meta.regularMarketDayLow != null ? `${priceStr(meta.regularMarketDayLow, digits)}${unit}` : '-', inline: true },
                { name: '📦 거래량', value: meta.regularMarketVolume != null ? priceStr(meta.regularMarketVolume, 0) : '-', inline: true },
                { name: '🏔️ 52주 최고', value: meta.fiftyTwoWeekHigh != null ? `${priceStr(meta.fiftyTwoWeekHigh, digits)}${unit}` : '-', inline: true },
                { name: '🕳️ 52주 최저', value: meta.fiftyTwoWeekLow != null ? `${priceStr(meta.fiftyTwoWeekLow, digits)}${unit}` : '-', inline: true },
                { name: '🏛️ 거래소', value: meta.fullExchangeName || meta.exchangeName || '-', inline: true },
            )
            .setFooter({ text: '출처: Yahoo Finance · 시세가 지연될 수 있어요 · 투자 참고용' })
            .setTimestamp();
        return i.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('주식 조회 실패:', err.message);
        return i.editReply('주식 시세를 가져오지 못했어요. 잠시 후 다시 시도해주세요.');
    }
}


return {
    // 슬래시 명령어 정의 (봇 파일의 SLASH 배열에 펼쳐 넣어요)
    slash: ({ EVERYWHERE, GUILD_ONLY, STR, USER }) => [

        // ---------- 단어검색 ----------
        {
            target: 'extras', where: EVERYWHERE,
            def: {
                name: '단어검색', description: '단어의 뜻풀이를 사전에서 찾아줘요 (국어사전/영어사전)',
                options: [{ type: STR, name: '단어', description: '뜻을 알고 싶은 단어', required: true, max_length: 50 }],
            },
            custom: i => handleWordSearch(i),
        },
        // ---------- 시세 ----------
        {
            target: 'extras', where: EVERYWHERE,
            def: {
                name: '환율', description: '환율을 조회하고 금액을 환산해요',
                options: [
                    { type: STR, name: '통화', description: '예: USD, 달러, 엔, JPY, 유로', required: true },
                    { type: 10, name: '금액', description: '환산할 금액 (생략하면 1)', min_value: 0 },
                    { type: STR, name: '기준통화', description: '바꿀 통화 (생략하면 원화)' },
                ],
            },
            custom: i => handleExchange(i),
        },
        {
            target: 'extras', where: EVERYWHERE,
            def: {
                name: '코인', description: '업비트 원화 시세를 조회해요',
                options: [{ type: STR, name: '코인', description: '예: 비트코인, BTC, 이더리움, 리플', required: true }],
            },
            custom: i => handleCoin(i),
        },
        {
            target: 'extras', where: EVERYWHERE,
            def: {
                name: '주식', description: '한국/미국 주식 시세를 조회해요',
                options: [{ type: STR, name: '종목', description: '예: 삼성전자, 005930, 애플, AAPL, TSLA', required: true }],
            },
            custom: i => handleStock(i),
        },
        // ---------- 티켓 ----------
        {
            target: 'extras', where: GUILD_ONLY, guildOnly: true,
            def: {
                name: '티켓설정', description: '티켓 패널을 만들어요 (서버 관리 권한 필요)',
                options: [
                    { type: 7, name: '패널채널', description: '티켓 열기 버튼을 보낼 채널', required: true, channel_types: [0, 5] },
                    { type: 8, name: '담당역할', description: '티켓을 볼 수 있는 담당자 역할', required: true },
                    { type: 7, name: '카테고리', description: '티켓 채널이 만들어질 카테고리 (선택)', channel_types: [4] },
                    { type: 7, name: '로그채널', description: '닫힌 티켓의 대화 기록을 보낼 채널 (선택)', channel_types: [0, 5] },
                ],
            },
            custom: i => ticketSetup(i),
        },
        {
            target: 'extras', where: GUILD_ONLY, guildOnly: true,
            def: {
                name: '티켓추가', description: '이 티켓에 사람을 추가해요 (담당자 전용)',
                options: [{ type: USER, name: '유저', description: '추가할 사람', required: true }],
            },
            custom: i => ticketMember(i, true),
        },
        {
            target: 'extras', where: GUILD_ONLY, guildOnly: true,
            def: {
                name: '티켓제거', description: '이 티켓에서 사람을 내보내요 (담당자 전용)',
                options: [{ type: USER, name: '유저', description: '제거할 사람', required: true }],
            },
            custom: i => ticketMember(i, false),
        },

    ],
};
};
