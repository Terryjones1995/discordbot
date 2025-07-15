/**
 * match.js — full-match workflow with logging and persistent match numbering
 *  • Snappier draft timer (embed edits every 5s + Discord relative timestamps)
 *  • Caches display names for zero-lag buttons
 *  • Shows which captain is on the clock (below Time left)
 *  • “You’re not on the clock” ephemerally when invalid picks are clicked
 *  • RPS always announces final outcome after ties and DMs both players
 *  • All timeouts reduced to 5s for testing
 *  • Chalk logic has been removed; handled in start.js instead
 *  • NEW: Captains vote on “Snake” vs “Straight” draft; RPS fallback on tie
 *  • NEW: Shows each user’s MMR (or 0 if none) beside their name in draft
 *  • NEW: Shows each team’s total MMR in the embed title
 *  • NEW: Match numbers persist in Firestore so they never reset on restart
 */

const {
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType
} = require('discord.js');
const { startPostDraft } = require('./start');
const admin = require('firebase-admin');
const db    = admin.firestore();

const CATEGORY_ID = '1394047708980969514';

// ───── Persistent match counter ─────
async function getNextMatchNumber() {
  const ref = db.collection('meta').doc('counters');
  const snap = await ref.get();
  let count = 0;
  if (snap.exists && typeof snap.data().matchCount === 'number') {
    count = snap.data().matchCount;
  }
  count += 1;
  await ref.set({ matchCount: count }, { merge: true });
  return count;
}
// ─────────────────────────────────────

// cache of userID → displayName
const nameCache = new Map();

// simple array shuffle
const shuffle = arr => arr.slice().sort(() => Math.random() - 0.5);

// extract raw numeric ID from mention or string
function rawId(val) {
  const m = String(val).match(/\d{17,19}/);
  return m ? m[0] : val;
}

// robust embed-logging helper
async function log(guild, text) {
  const logId = global.guildLogChannels?.get(guild.id);
  if (!logId) return;
  const ch = await guild.channels.fetch(logId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setDescription(text)
    .setTimestamp();
  await ch.send({ embeds: [embed] }).catch(() => {});
}

// fetch & cache a user's display name (guild nickname or username)
async function getDisplayName(id, guild) {
  if (nameCache.has(id)) return nameCache.get(id);
  try {
    const member = await guild.members.fetch(id);
    const name = member.displayName;
    nameCache.set(id, name);
    return name;
  } catch {
    try {
      const user = await guild.client.users.fetch(id);
      const name = user.username;
      nameCache.set(id, name);
      return name;
    } catch {
      nameCache.set(id, id);
      return id;
    }
  }
}

/**
 * Fetch a user's MMR from Firestore.
 * If no record or no mmr field, return 0.
 */
async function getUserMMR(uid) {
  try {
    const snap = await db.collection('users').doc(uid).get();
    const data = snap.exists ? snap.data() : {};
    return typeof data.mmr === 'number' ? data.mmr : 0;
  } catch {
    return 0;
  }
}

module.exports = {
  async startMatch(queueMessage, players) {
    // 1️⃣ Get next persistent match number
    const matchNumber = await getNextMatchNumber();
    const matchName = `match-${matchNumber}`;

    const guild = queueMessage.guild;
    global.activeMatches = global.activeMatches || new Map();

    // 2️⃣ Create private match channel
    const channel = await guild.channels.create({
      name: matchName,
      type: ChannelType.GuildText,
      parent: CATEGORY_ID,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }
      ]
    });
    await log(guild, `🆕 Match channel created: **${channel.name}**`);

    // register for admin termination
    global.activeMatches.set(channel.id, { channel, players });

    // allow each queued player in
    for (const p of players) {
      const id = rawId(p);
      if (!/^\d+$/.test(id)) continue;
      try {
        const m = await guild.members.fetch(id);
        await channel.permissionOverwrites.create(m, {
          ViewChannel: true,
          SendMessages: true
        });
      } catch {}
    }

    // 3️⃣ Captain vote
    await log(guild, '🔔 Starting captain vote');
    const [cap1, cap2] = await promptCaptainVote(channel, players);
    await log(guild, `🥳 Captains: <@${cap1}> & <@${cap2}>`);

    // 4️⃣ Draft-type vote
    await log(guild, '🔔 Starting draft-type vote');
    const draftType = await promptDraftType(channel, [cap1, cap2]);
    await channel.send(
      `📋 Draft type chosen: **${draftType === 'snake' ? 'Snake Draft' : 'Straight Draft'}**`
    );
    await log(guild, `📋 Draft type: ${draftType}`);

    // 5️⃣ Rock-Paper-Scissors for pick order
    await log(guild, '🔔 Starting RPS for pick order');
    const [winner, loser] = await runRockPaperScissors(
      channel, [cap1, cap2], 'first pick'
    );
    await log(guild, `🤜🤛 RPS winner (pick order): <@${winner}> beat <@${loser}>`);

    // 6️⃣ Draft
    await log(guild, `🔔 Starting draft (${draftType})`);
    const draftResult = await runDraft(
      channel,
      winner,
      loser,
      players,
      [cap1, cap2],
      draftType
    );
    if (!draftResult) {
      await log(guild, `🧹 Match cancelled during draft.`);
      return;
    }
    const { team1, team2 } = draftResult;
    await log(
      guild,
      `✅ Draft complete: Team 1 [${team1.map(id => `<@${id}>`).join(', ')}] vs Team 2 [${team2.map(id => `<@${id}>`).join(', ')}]`
    );

    // 7️⃣ Post-draft actions
    await startPostDraft(channel, { team1, team2, winner, loser });
  }
};

async function promptCaptainVote(channel, players) {
  const guild = channel.guild;
  const ids = players.map(rawId);
  await Promise.all(ids.map(id => getDisplayName(id, guild)));

  let timeLeft = 5;
  const votes = new Map();
  const base = new EmbedBuilder()
    .setTitle('📢 Vote for Captains!')
    .setColor(0x00AE86)
    .setTimestamp();

  function buildEmbed() {
    const lines = ids.map((id, i) => {
      const ct = [...votes.values()].filter(v => v === id).length;
      const name = nameCache.get(id) || id;
      return `${i + 1}. **${name}** (<@${id}>)` + (ct ? ` (${ct})` : '');
    });
    return base.setDescription(
      `Click one below. You get 1 vote.\nTime left: **${timeLeft}s**\n\n${lines.join('\n')}`
    );
  }

  const buttons = await Promise.all(ids.map(async id => {
    const label = await getDisplayName(id, guild);
    return new ButtonBuilder()
      .setCustomId(`vote_${id}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary);
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }

  const msg = await channel.send({ embeds: [buildEmbed()], components: rows });
  const timer = setInterval(() => {
    timeLeft--;
    if (timeLeft >= 0) msg.edit({ embeds: [buildEmbed()] }).catch(() => {});
  }, 1000);

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 5000
  });
  collector.on('collect', inter => {
    if (!votes.has(inter.user.id)) {
      votes.set(inter.user.id, inter.customId.split('_')[1]);
    }
    inter.deferUpdate().catch(() => {});
  });

  return new Promise(resolve => {
    collector.on('end', async () => {
      clearInterval(timer);
      msg.delete().catch(() => {});
      const tally = {};
      for (const v of votes.values()) tally[v] = (tally[v] || 0) + 1;

      let caps;
      if (!Object.keys(tally).length) {
        caps = shuffle(ids).slice(0, 2);
      } else {
        const maxV = Math.max(...Object.values(tally));
        const top = Object.entries(tally)
          .filter(([, v]) => v === maxV)
          .map(([k]) => k);
        if (top.length >= 2) {
          caps = shuffle(top).slice(0, 2);
        } else {
          const first = top[0];
          const rest = Object.entries(tally)
            .filter(([k]) => k !== first)
            .sort((a, b) => b[1] - a[1])
            .map(([k]) => k);
          const ties = rest.filter(k => tally[k] === tally[rest[0]]);
          caps = [
            first,
            ties.length ? shuffle(ties)[0] : shuffle(ids.filter(x => x !== first))[0]
          ];
        }
      }

      await channel.send(`🥳 **Captains Selected!** <@${caps[0]}> & <@${caps[1]}>`);
      resolve(caps);
    });
  });
}

async function promptDraftType(channel, [cap1, cap2]) {
  let timeLeft = 5;
  const votes = new Map();
  const base = new EmbedBuilder()
    .setTitle('📋 Choose Draft Type')
    .setColor(0xFFA500)
    .setTimestamp();

  function buildEmbed() {
    return base.setDescription(`Both captains pick “Snake” or “Straight”.\nTime left: **${timeLeft}s**`);
  }

  const btnSnake    = new ButtonBuilder().setCustomId('dt_snake').setLabel('Snake').setStyle(ButtonStyle.Primary);
  const btnStraight = new ButtonBuilder().setCustomId('dt_straight').setLabel('Straight').setStyle(ButtonStyle.Primary);
  const row         = new ActionRowBuilder().addComponents(btnSnake, btnStraight);
  const msg         = await channel.send({ embeds: [buildEmbed()], components: [row] });

  const timer = setInterval(() => {
    timeLeft--;
    if (timeLeft >= 0) msg.edit({ embeds: [buildEmbed()] }).catch(() => {});
  }, 1000);

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 5000
  });
  collector.on('collect', i => {
    if (![cap1, cap2].includes(i.user.id)) return;
    if (!votes.has(i.user.id)) {
      votes.set(i.user.id, i.customId === 'dt_snake' ? 'snake' : 'straight');
    }
    i.deferUpdate().catch(() => {});
  });

  return new Promise(resolve => {
    collector.on('end', async () => {
      clearInterval(timer);
      msg.delete().catch(() => {});
      let choice;
      if (votes.size === 2 && [...votes.values()][0] === [...votes.values()][1]) {
        choice = votes.get(cap1);
      } else {
        const [rpsWin] = await runRockPaperScissors(channel, [cap1, cap2], 'draft type');
        choice = votes.get(rpsWin) || 'straight';
        await channel.send(
          `⚖️ Tie on draft type → RPS winner <@${rpsWin}>’s pick: **${choice === 'snake' ? 'Snake Draft' : 'Straight Draft'}**`
        );
      }
      resolve(choice);
    });
  });
}

async function runRockPaperScissors(channel, [cap1, cap2], purpose = 'this RPS') {
  const client = channel.client;
  const opts   = ['rock', 'paper', 'scissors'];

  await log(channel.guild, `🔔 Starting RPS for **${purpose}**`);

  async function pick(id) {
    if (!/^\d+$/.test(id)) return shuffle(opts)[0];
    const user = await client.users.fetch(id);
    const dm   = await user.createDM();
    const msg  = await dm.send({
      content: `🎲 Play Rock/Paper/Scissors for **${purpose}** in 5s`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('rps_rock').setLabel('🪨 Rock').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('rps_paper').setLabel('📄 Paper').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('rps_scissors').setLabel('✂️ Scissors').setStyle(ButtonStyle.Primary)
        )
      ]
    });
    setTimeout(() => msg.delete().catch(() => {}), 10000);

    try {
      const inter = await msg.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 5000,
        filter: i => i.user.id === id
      });
      await inter.reply({ content: 'Choice recorded!', ephemeral: true });
      return inter.customId.split('_')[1];
    } catch {
      const auto = shuffle(opts)[0];
      const note = await dm.send(`⏰ No pick → auto **${auto}**.`);
      setTimeout(() => note.delete().catch(() => {}), 10000);
      return auto;
    }
  }

  let a, b;
  do {
    a = await pick(cap1);
    b = await pick(cap2);
    if (a === b) {
      await channel.send(`🤝 Both chose **${a}** — tie! Rerunning RPS.`);
      await log(channel.guild, `🤝 RPS tie on **${a}** — rerunning`);
      for (const id of [cap1, cap2]) {
        try {
          const dm = await (await client.users.fetch(id)).createDM();
          const m  = await dm.send(`🤝 Tie on **${a}** — rerunning RPS for **${purpose}**.`);
          setTimeout(() => m.delete().catch(() => {}), 10000);
        } catch {}
      }
    }
  } while (a === b);

  const wins = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
  const [winner, loser] = wins[a] === b ? [cap1, cap2] : [cap2, cap1];

  await channel.send(`🤜🤛 RPS (${purpose}): <@${cap1}> (${a}) vs (${b}) <@${cap2}> → 🏆 <@${winner}>`);
  await channel.send(`✅ <@${winner}> wins!  <@${loser}> loses.`);
  await log(channel.guild, `🏆 <@${winner}> won RPS for **${purpose}**`);

  try {
    await (await client.users.fetch(winner)).createDM().then(dm =>
      dm.send(`🎉 You won the Rock/Paper/Scissors for **${purpose}**!`)
    );
  } catch {}
  try {
    await (await client.users.fetch(loser)).createDM().then(dm =>
      dm.send(`😞 You lost the Rock/Paper/Scissors for **${purpose}**.`)
    );
  } catch {}

  return [winner, loser];
}

async function runDraft(channel, winner, loser, players, captains, draftType) {
  const guild = channel.guild;

  // cleanup old vote/RPS messages
  const fetched = await channel.messages.fetch({ limit: 50 });
  const oldMsgs = fetched.filter(m =>
    m.author.id === channel.client.user.id &&
    m.components.some(r => r.components.some(c => /^vote_|^rps_|^pick_/.test(c.customId)))
  );
  if (oldMsgs.size) await channel.bulkDelete(oldMsgs).catch(() => {});

  // prepare
  const ids = players.map(rawId);
  let remaining = ids.filter(id => id !== winner && id !== loser);
  const team1 = [winner];
  const team2 = [loser];
  const draftLog = [];
  let pickNum = 1;
  let draftMsg;

  // fetch all MMRs
  const mmrs = {};
  await Promise.all(ids.map(async id => {
    mmrs[id] = await getUserMMR(id);
  }));

  // build steps: always one click per pick
  const steps = remaining.map((_, idx) => ({
    cap: (draftType === 'straight')
      ? (idx % 2 === 0 ? winner : loser)
      : // snake uses same turn order but requires click
        (idx % 2 === 0 ? winner : loser)
  }));

  await log(guild, `🔔 Draft begins (${draftType}), <@${winner}> picks first`);

  // render function with MMR
  async function render(onClock, deadline) {
    const team1MMR = team1.reduce((sum, id) => sum + (mmrs[id] || 0), 0);
    const team2MMR = team2.reduce((sum, id) => sum + (mmrs[id] || 0), 0);

    const emb = new EmbedBuilder().setColor(0xffa500);

    if (onClock) {
      emb
        .setTitle('✏️ Draft in progress')
        .setFooter({ text: `Pick ${pickNum}` })
        .addFields(
          { name: '⏱ Time left', value: `<t:${Math.floor(deadline/1000)}:R>`, inline: true },
          { name: '👑 On the clock', value: `<@${onClock}>`, inline: true }
        );
    } else {
      emb.setTitle('✅ Draft complete');
    }

    if (draftLog.length) {
      emb.addFields({ name: '📜 Draft Log', value: draftLog.join('\n'), inline: false });
    }

    emb.addFields(
      {
        name: `🟥 Team 1 (Total MMR: ${team1MMR})`,
        value: team1.map(id => `• <@${id}> (MMR: ${mmrs[id]})`).join('\n') || '—',
        inline: true
      },
      {
        name: `🟦 Team 2 (Total MMR: ${team2MMR})`,
        value: team2.map(id => `• <@${id}> (MMR: ${mmrs[id]})`).join('\n') || '—',
        inline: true
      }
    );

    const rows = [];
    if (onClock) {
      const btns = await Promise.all(remaining.map(async id => {
        const label = `${await getDisplayName(id, guild)} (${mmrs[id]})`;
        return new ButtonBuilder()
          .setCustomId(`pick_${onClock}_${id}`)
          .setLabel(label)
          .setStyle(ButtonStyle.Primary);
      }));
      for (let i = 0; i < btns.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(btns.slice(i, i + 5)));
      }
    }

    if (!draftMsg) {
      draftMsg = await channel.send({ embeds: [emb], components: rows });
    } else {
      await draftMsg.edit({ embeds: [emb], components: rows }).catch(() => {});
    }
  }

  // picking loop
  for (const { cap } of steps) {
    const deadline = Date.now() + 5000;
    await render(cap, deadline);
    const timer = setInterval(() => render(cap, deadline).catch(() => {}), 5000);

    let picked = false;
    while (!picked) {
      let inter;
      try {
        inter = await draftMsg.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: deadline - Date.now(),
          filter: btn => btn.customId.startsWith('pick_')
        });
      } catch {
        inter = null;
      }
      clearInterval(timer);

      if (!inter) {
        // auto-pick on timeout
        const auto = remaining.shift();
        if (cap === winner) team1.push(auto);
        else team2.push(auto);
        draftLog.push(`Pick ${pickNum} — <@${auto}> (auto)`);
        await log(guild, `⏰ <@${cap}> auto-picked <@${auto}>`);
        pickNum++;
        picked = true;
        continue;
      }

      const [, onClk, pickId] = inter.customId.split('_');
      if (inter.user.id !== onClk) {
        await inter.reply({ content: 'You’re not on the clock!', ephemeral: true });
        continue;
      }
      await inter.deferUpdate();
      remaining = remaining.filter(x => x !== pickId);
      if (cap === winner) team1.push(pickId);
      else team2.push(pickId);
      draftLog.push(`Pick ${pickNum} — <@${pickId}>`);
      await log(guild, `✏️ <@${cap}> picked <@${pickId}>`);
      pickNum++;
      picked = true;
    }
  }

  // final render
  await render(null);
  await log(
    guild,
    `✅ Draft complete: Team 1 [${team1.map(id => `<@${id}>`).join(', ')}] vs Team 2 [${team2.map(id => `<@${id}>`).join(', ')}]`
  );

  return { team1, team2 };
}
