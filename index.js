/**
 * index.js — NeatQueue-lite with auto-cycling queues (guild-scoped)
 * Always 2 teams of 4, max 8
 * Embed styling: author icon “Major League Sniping™”, red sidebar,
 * sub-header “8’s Queue”, description “Queue X/8” + numbered list,
 * “Open” in empty slots, clickable Socials field, timestamp footer,
 * buttons: Join Queue, Leave Queue, Leaderboard link.
 * Pre-seeded with 7 placeholder users for testing draft.
 * On 8th join, hands off to match.js.
 * Join/leave announcements post only to the log channel.
 * Prevents a user from joining more than one active queue or match at a time.
 * Delegates match logging/cleanup to match.js (and start.js).
 * Admin commands (including /endqueue, /resetleaderboard, /mmr, /wins, /losses)
 *   moved to admin.js
 */

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  PermissionsBitField,
  ChannelType
} = require('discord.js');
require('dotenv').config();

// ─────────── FIREBASE ADMIN + MMR SETUP ───────────
const firebaseAdmin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(serviceAccount),
});
const db = firebaseAdmin.firestore();

// ─────────── Leaderboard Query ───────────
/**
 * Fetch top-N user records (wins, losses, streak, mmr) ordered by mmr desc.
 */
async function getLeaderboardRecords(limit = 10) {
  const snap = await db
    .collection('users')
    .orderBy('mmr', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((doc, idx) => {
    const d = doc.data();
    return {
      rank:   idx + 1,
      id:     doc.id,
      wins:   typeof d.wins   === 'number' ? d.wins   : 0,
      losses: typeof d.losses === 'number' ? d.losses : 0,
      streak: typeof d.streak  === 'number' ? d.streak : 0,
      mmr:    typeof d.mmr     === 'number' ? d.mmr    : 1000
    };
  });
}

// ───────────────────────────────────────────────────

const match = require('./match');
const admin  = require('./admin.js');
global.activeUsers = new Set();

const TOKEN       = process.env.DISCORD_TOKEN;
const CLIENT_ID   = process.env.CLIENT_ID;
const GUILD_ID    = '1393580301082562821';
const CATEGORY_ID = '1394047708980969514';

const ICON_URL = 'https://i.imgur.com/YourLogo.png';
const SOCIALS = [
  '**YouTube:** [MajorLeagueSniping](https://www.youtube.com/MajorLeagueSniping)',
  '**Twitter:** [@MLSniingOG](https://twitter.com/MLSniingOG)',
  '**Twitch:** [MajorLeagueSniping](https://twitch.tv/MajorLeagueSniping)',
  '**TikTok:** [@MajorLeagueSniping](https://tiktok.com/@MajorLeagueSniping)',
  '**Discord:** [Join Us](https://discord.gg/MLSniping)'
].join('\n');

const TEST_USERS = Array.from({ length: 7 }, (_, i) => `TestUser${i+1}`);

// Safe reply/followUp to avoid “Unknown interaction” errors
async function safeReply(inter, opts) {
  if (inter.replied || inter.deferred) {
    try { return await inter.followUp({ ...opts, ephemeral: true }); }
    catch {}
  } else {
    try { return await inter.reply(opts); }
    catch {}
  }
}

// Post to log channel only
async function announceLog(guildId, text) {
  const logId = guildLogChannels.get(guildId);
  if (!logId) return;
  const ch = await client.channels.fetch(logId).catch(() => null);
  if (ch?.isTextBased()) ch.send(text).catch(() => {});
}

// Embed-style admin/action logger
async function actionLog(guildId, user, text, color = 0x00AE86) {
  const logId = guildLogChannels.get(guildId);
  if (!logId) return;
  const ch = await client.channels.fetch(logId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const emb = new EmbedBuilder()
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
    .setColor(color)
    .setDescription(text)
    .setTimestamp();
  ch.send({ embeds: [emb] }).catch(() => {});
}

// Register slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('setqueuechannel')
    .setDescription('Select the channel where queues will run')
    .addChannelOption(opt =>
      opt.setName('channel')
         .setDescription('Queue channel')
         .setRequired(true)
    ).toJSON(),

  new SlashCommandBuilder()
    .setName('setlogchannel')
    .setDescription('Select the channel for join/leave & match logs')
    .addChannelOption(opt =>
      opt.setName('channel')
         .setDescription('Log channel')
         .setRequired(true)
    ).toJSON(),

  new SlashCommandBuilder()
    .setName('startqueue')
    .setDescription('Start the 8-slot queue (pre-populated)')
    .toJSON(),

  // include all admin commands defined in admin.js
  ...admin.data.map(cmd => cmd.toJSON()),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('DM you the full leaderboard')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();

const client = new Client({
  intents: [ GatewayIntentBits.Guilds ]
});
global.client = client;

const guildSettings         = new Map(); // guildId → queueChannelId
const guildLogChannels      = new Map(); // guildId → logChannelId
const guildQueues           = new Map(); // guildId → { currentQueue, queueMessage, interval }
const guildLeaderboardChans = new Map(); // guildId → leaderboardChannelId

global.guildLogChannels      = guildLogChannels;
global.guildSettings         = guildSettings;
global.guildQueues           = guildQueues;
global.guildLeaderboardChans = guildLeaderboardChans;

/**
 * Ensure core channels exist and have correct permissions
 */
async function ensureCoreChannels(guild) {
  const category = guild.channels.cache.get(CATEGORY_ID);
  if (!category) {
    console.error('Category ID not found.');
    return;
  }

  // mw2-8s queue
  let queueCh = guild.channels.cache.find(ch =>
    ch.name === 'mw2-8s' &&
    ch.parentId === CATEGORY_ID &&
    ch.type === ChannelType.GuildText
  );
  if (!queueCh) {
    queueCh = await guild.channels.create({
      name: 'mw2-8s',
      type: ChannelType.GuildText,
      parent: category
    });
  }
  guildSettings.set(guild.id, queueCh.id);

  // mw2-8s-logs
  let logCh = guild.channels.cache.find(ch =>
    ch.name === 'mw2-8s-logs' &&
    ch.parentId === CATEGORY_ID &&
    ch.type === ChannelType.GuildText
  );
  if (!logCh) {
    logCh = await guild.channels.create({
      name: 'mw2-8s-logs',
      type: ChannelType.GuildText,
      parent: category,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }
      ]
    });
  }
  guildLogChannels.set(guild.id, logCh.id);

  // bot-info
  let botInfo = guild.channels.cache.find(ch =>
    ch.name === 'bot-info' &&
    ch.parentId === CATEGORY_ID &&
    ch.type === ChannelType.GuildText
  );
  if (!botInfo) {
    botInfo = await guild.channels.create({
      name: 'bot-info',
      type: ChannelType.GuildText,
      parent: category,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }
      ]
    });
  }
  // send detailed commands + MMR overview
  await botInfo.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('🤖 Bot Info & Commands')
        .setColor(0x5865F2)
        .setDescription([
          '**Slash Commands:**',
          '• `/setqueuechannel [#channel]` — set the queue channel',
          '• `/setlogchannel [#channel]` — set the log channel',
          '• `/startqueue` — manually launch the 8-slot queue',
          '• `/endqueue` — terminate a match (admin only)',
          '• `/resetleaderboard start` — generate confirmation code to reset leaderboard',
          '• `/resetleaderboard confirm code:<code>` — confirm & reset leaderboard',
          '• `/mmr add @user <amt>` — add MMR to a user',
          '• `/mmr remove @user <amt>` — remove MMR from a user',
          '• `/wins add @user <amt>` — add wins to a user',
          '• `/wins remove @user <amt>` — remove wins from a user',
          '• `/losses add @user <amt>` — add losses to a user',
          '• `/losses remove @user <amt>` — remove losses from a user',
          '• `/leaderboard` — DM you the full leaderboard',
          '',
          '**MMR System:**',
          '- Elo-style based on team-average MMR (K=32).',
          '- Underdogs gain more, favourites gain less or lose more.',
          '- Stored in Firestore `users` docs: `wins`,`losses`,`streak`,`mmr`.'
        ].join('\n'))
    ]
  });

  // leaderboards
  let lbCh = guild.channels.cache.find(ch =>
    ch.name === 'leaderboards' &&
    ch.parentId === CATEGORY_ID &&
    ch.type === ChannelType.GuildText
  );
  if (!lbCh) {
    lbCh = await guild.channels.create({
      name: 'leaderboards',
      type: ChannelType.GuildText,
      parent: category
    });
  }
  // perms: everyone read-only; bot + admins write
  const perms = [
    {
      id: guild.roles.everyone.id,
      allow: [PermissionsBitField.Flags.ViewChannel],
      deny:  [PermissionsBitField.Flags.SendMessages]
    },
    {
      id: client.user.id,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
    }
  ];
  guild.roles.cache
    .filter(r => r.permissions.has(PermissionsBitField.Flags.ManageChannels))
    .forEach(r => {
      perms.push({
        id:    r.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
      });
    });
  await lbCh.permissionOverwrites.set(perms);
  guildLeaderboardChans.set(guild.id, lbCh.id);
}

/**
 * Render (or edit) the standings embed in #leaderboards
 * – Shows up to 200 players (single ANSI code-block)
 * – Columns:  #  Player            W/L   STRK  MMR
 * – Uses each member’s displayName (not clickable)
 */
async function updateLeaderboard(guildId) {
  const lbId = guildLeaderboardChans.get(guildId);
  if (!lbId) return;
  const channel = await client.channels.fetch(lbId).catch(() => null);
  if (!channel?.isTextBased()) return;

  // 1) pull top records
  const records = await getLeaderboardRecords(200);

  // 2) fetch each member’s displayName
  const nameMap = new Map();
  await Promise.all(records.map(async r => {
    try {
      const m = await channel.guild.members.fetch(r.id);
      nameMap.set(r.id, m.displayName);
    } catch {
      nameMap.set(r.id, 'Unknown');
    }
  }));

  // 3) compute column widths
  const rankW   = Math.max(...records.map(r => String(r.rank).length), 1);
  const playerW = Math.max(
    'Player'.length,
    ...records.map(r => nameMap.get(r.id).length)
  );
  const wlW     = Math.max(
    ...records.map(r => `${r.wins}-${r.losses}`.length),
    'W/L'.length
  );
  const strkW   = Math.max(
    ...records.map(r => String(r.streak).length),
    'STRK'.length
  );
  const mmrW    = Math.max(
    ...records.map(r => String(r.mmr).length),
    'MMR'.length
  );

  const pad = (s, w, right = false) => {
    s = String(s);
    return right ? s.padEnd(w, ' ') : s.padStart(w, ' ');
  };

  const sep = '  ';
  // 4) header + divider
  const header =
    pad('#',     rankW, true)    + sep +
    pad('Player', playerW, true) + sep +
    pad('W/L',    wlW,   true)   + sep +
    pad('STRK',   strkW, true)   + sep +
    pad('MMR',    mmrW,  true);

  const divider =
    '-'.repeat(rankW)   + sep +
    '-'.repeat(playerW) + sep +
    '-'.repeat(wlW)     + sep +
    '-'.repeat(strkW)   + sep +
    '-'.repeat(mmrW);

  // 5) build rows
  const rows = records.map(r =>
    pad(r.rank, rankW, true)              + sep +
    pad(nameMap.get(r.id), playerW, true) + sep +
    pad(`${r.wins}-${r.losses}`, wlW, true)+ sep +
    pad(r.streak, strkW, true)            + sep +
    pad(r.mmr, mmrW, true)
  );

  const table = ['```ansi', header, divider, ...rows, '```'].join('\n');

  // 6) fetch last bot message & edit or send new
  const last = (await channel.messages.fetch({ limit: 5 }))
                 .filter(m => m.author.id === client.user.id)
                 .first();

  const embed = new EmbedBuilder()
    .setTitle('🏅 Official Leaderboards')
    .setColor(0xFFD700)
    .setDescription(table)
    .setTimestamp();

  if (last) {
    await last.edit({ embeds: [embed] }).catch(() => {
      channel.send({ embeds: [embed] });
    });
  } else {
    await channel.send({ embeds: [embed] });
  }
}

/**
 * Start a new queue embed + button row
 */
async function startQueueInChannel(guildId) {
  const queueCh = guildSettings.get(guildId);
  if (!queueCh) return;
  const ch = await client.channels.fetch(queueCh).catch(() => null);
  if (!ch?.isTextBased()) return;

  const initial = [...TEST_USERS];
  const lines = Array.from({ length: 8 }, (_, i) =>
    `${i+1}. ${initial[i] || 'Open'}`
  );

  const embed = new EmbedBuilder()
    .setAuthor({ name: 'Major League Sniping™', iconURL: ICON_URL })
    .setColor(0xFF0000)
    .setDescription([
      "8’s Queue",
      '',
      `Queue ${initial.length}/8`,
      ...lines
    ].join('\n'))
    .addFields({ name: 'Socials', value: SOCIALS })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('join').setLabel('Join Queue').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('leave').setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setLabel('Leaderboard').setStyle(ButtonStyle.Link).setURL('https://your.leaderboard.url/')
  );

  const msg      = await ch.send({ embeds: [embed], components: [row] });
  const interval = setInterval(() => updateQueueMessage(guildId), 60_000);
  guildQueues.set(guildId, { currentQueue: initial, queueMessage: msg, interval });

  await actionLog(guildId, client.user, `🚀 Queue started in <#${queueCh}>`);
}

/**
 * Update queue embed or hand off to match.js
 */
async function updateQueueMessage(guildId) {
  const data = guildQueues.get(guildId);
  if (!data) return;
  const { currentQueue: q, queueMessage: msg, interval } = data;
  const count = q.length;

  if (count < 8) {
    const lines = Array.from({ length: 8 }, (_, i) =>
      `${i+1}. ${q[i] || 'Open'}`
    );
    const embed = EmbedBuilder.from(msg.embeds[0])
      .setDescription([
        "8’s Queue",
        '',
        `Queue ${count}/8`,
        ...lines
      ].join('\n'))
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('join').setLabel('Join Queue').setStyle(ButtonStyle.Primary).setDisabled(count >= 8),
      new ButtonBuilder().setCustomId('leave').setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setDisabled(count === 0),
      new ButtonBuilder().setLabel('Leaderboard').setStyle(ButtonStyle.Link).setURL('https://your.leaderboard.url/')
    );
    return msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
  }

  clearInterval(interval);
  let seconds = 60;
  const full = q.map((u,i) => `${i+1}. ${u}`);
  const base = EmbedBuilder.from(msg.embeds[0])
    .setDescription([
      "8’s Queue — **FULL!**",
      '',
      `Queue 8/8`,
      ...full,
      '',
      `**Next queue starts in ${seconds}s**`
    ].join('\n'))
    .setTimestamp();
  const disabled = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('join').setLabel('Join Queue').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('leave').setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setLabel('Leaderboard').setStyle(ButtonStyle.Link).setURL('https://your.leaderboard.url/')
  );
  await msg.edit({ embeds: [base], components: [disabled] }).catch(() => {});

  const cd = setInterval(async () => {
    seconds--;
    if (seconds >= 0) {
      const e = EmbedBuilder.from(base)
        .setDescription([
          "8’s Queue — **FULL!**",
          '',
          `Queue 8/8`,
          ...full,
          '',
          `**Next queue starts in ${seconds}s**`
        ].join('\n'));
      await msg.edit({ embeds: [e] }).catch(() => {});
    }
    if (seconds <= 0) {
      clearInterval(cd);
      await msg.delete().catch(() => {});
      guildQueues.delete(guildId);
      startQueueInChannel(guildId);
    }
  }, 1000);

  try {
    await match.startMatch(msg, q);
  } catch (err) {
    console.error('Error running match:', err);
  }
}

/**
 * Handle slash commands, join/leave buttons, and admin components
 */
client.on(Events.InteractionCreate, async inter => {
  const gid = inter.guildId;

  if (inter.isChatInputCommand()) {
    const adminCmds = [
      'setqueuechannel','setlogchannel','startqueue',
      'endqueue','resetleaderboard','mmr','wins','losses'
    ];
    if (adminCmds.includes(inter.commandName) &&
        !inter.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return safeReply(inter, { content: 'You don’t have permission.', ephemeral: true });
    }

    switch (inter.commandName) {
      case 'setqueuechannel': {
        const c = inter.options.getChannel('channel');
        guildSettings.set(gid, c.id);
        await safeReply(inter, { content: `Queue → <#${c.id}>`, ephemeral: true });
        await actionLog(gid, inter.user, `🛠️ Queue channel set to <#${c.id}>`);
        break;
      }
      case 'setlogchannel': {
        const c = inter.options.getChannel('channel');
        guildLogChannels.set(gid, c.id);
        await safeReply(inter, { content: `Log → <#${c.id}>`, ephemeral: true });
        await actionLog(gid, inter.user, `🛠️ Log channel set to <#${c.id}>`);
        break;
      }
      case 'startqueue': {
        if (!guildSettings.has(gid)) {
          await safeReply(inter, { content: 'Use /setqueuechannel first.', ephemeral: true });
        } else if (guildQueues.has(gid)) {
          await safeReply(inter, { content: 'Queue already running.', ephemeral: true });
        } else {
          await startQueueInChannel(gid);
          await safeReply(inter, { content: '✅ Queue started!', ephemeral: true });
          await actionLog(gid, inter.user, `🚀 Queue manually started.`);
        }
        break;
      }
      case 'leaderboard': {
        const recs = await getLeaderboardRecords(10);
        const cols = {
          rank:   recs.map(r => `${r.rank}`).join('\n'),
          player: recs.map(r => `<@${r.id}>`).join('\n'),
          wl:     recs.map(r => `${r.wins}-${r.losses}`).join('\n'),
          streak: recs.map(r => `${r.streak}`).join('\n'),
          mmr:    recs.map(r => `${r.mmr}`).join('\n'),
        };
        const emb = new EmbedBuilder()
          .setTitle('🏅 Official Leaderboards')
          .setColor(0xFFD700)
          .addFields(
            { name: '#',      value: cols.rank,   inline: true },
            { name: 'Player', value: cols.player, inline: true },
            { name: 'W/L',    value: cols.wl,     inline: true },
            { name: 'STRK',   value: cols.streak, inline: true },
            { name: 'MMR',    value: cols.mmr,    inline: true }
          )
          .setTimestamp();
        return inter.reply({ embeds: [emb], ephemeral: true });
      }
      case 'endqueue':
      case 'resetleaderboard':
      case 'mmr':
      case 'wins':
      case 'losses':
        return admin.execute(inter);
    }
  }

  if (inter.isButton() && ['join','leave'].includes(inter.customId)) {
    const data = guildQueues.get(gid);
    if (!data || inter.message.id !== data.queueMessage.id) {
      return safeReply(inter, { content: 'No active queue.', ephemeral: true });
    }

    const q   = data.currentQueue;
    const uid = inter.user.id;
    const tag = `<@${uid}>`;

    if (inter.customId === 'join') {
      if (global.activeUsers.has(uid)) {
        return safeReply(inter, { content: 'Already in a queue/match.', ephemeral: true });
      }
      if (q.includes(tag)) {
        return safeReply(inter, { content: 'Already in this queue.', ephemeral: true });
      }
      if (q.length >= 8) {
        return safeReply(inter, { content: 'Queue full.', ephemeral: true });
      }
      q.push(tag);
      global.activeUsers.add(uid);
      inter.deferUpdate().catch(() => {});
      announceLog(gid, `${tag} joined the queue.`);
      await actionLog(gid, inter.user, `👥 ${tag} joined the queue.`);
      return updateQueueMessage(gid);
    }

    if (inter.customId === 'leave') {
      if (!q.includes(tag)) {
        return safeReply(inter, { content: 'Not in this queue.', ephemeral: true });
      }
      data.currentQueue = q.filter(u => u !== tag);
      global.activeUsers.delete(uid);
      inter.deferUpdate().catch(() => {});
      announceLog(gid, `${tag} left the queue.`);
      await actionLog(gid, inter.user, `❌ ${tag} left the queue.`);
      return updateQueueMessage(gid);
    }
  }

  if (inter.isStringSelectMenu()) {
    return admin.handleComponent(inter);
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  await ensureCoreChannels(guild);

  if (guildSettings.has(guild.id) && !guildQueues.has(guild.id)) {
    await startQueueInChannel(guild.id);
    console.log(`Auto-started queue in <#${guildSettings.get(guild.id)}>`);
  }

  // initial leaderboard update + schedule
  await updateLeaderboard(guild.id);
  setInterval(() => updateLeaderboard(guild.id), 60_000);
});

client.login(TOKEN);
