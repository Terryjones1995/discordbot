/**
 * start.js — post-draft actions
 * ───────────────────────────────────────────────────────────────
 * 1. Create two temporary voice channels
 * 2. Summary embed + report / chalk buttons
 * 3. Auto-refresh embed every 30 s
 * 4. Live countdown → auto-move players into their VCs (if already in voice) or DM them to join
 * 5. When reported, chalked, tied, or forced:
 *    • Cancel countdown if running
 *    • Unlock users
 *    • Save transcript
 *    • Adjust MMR via rewards.processMatch()
 *    • Show per-user deltas, DM each user, wait 20 s
 *    • Clean up channels
 *    • Log final summary to Firestore and log channel
 */

const rewards = require('./rewards');
const admin   = require('firebase-admin');
const {
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType
} = require('discord.js');
const fs   = require('fs');
const path = require('path');

const db          = admin.firestore();
const CATEGORY_ID = '1394047708980969514';

const rawId = v => (String(v).match(/\d{17,19}/) || [v])[0];

async function log(guild, content, file) {
  const logId = global.guildLogChannels?.get(guild.id);
  if (!logId) return;
  const ch = await guild.channels.fetch(logId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const opts = { content };
  if (file) opts.files = [file];
  await ch.send(opts).catch(() => {});
}

module.exports.startPostDraft = async function startPostDraft(
  channel,
  { team1, team2, winner, loser }
) {
  const guild     = channel.guild;
  const matchName = channel.name;

  // ─── 0️⃣ Create Firestore doc for this match ─────────────────
  const matchRef = db.collection('matchLogs').doc(matchName);
  await matchRef.set({
    team1,
    team2,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    status:    'ready'
  });

  // 1️⃣ Voice channels
  const basePerms = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.Connect] }];
  const makePerms = ids => {
    const perms = [...basePerms];
    for (const u of ids) {
      const id = rawId(u);
      if (/^\d{17,19}$/.test(id)) {
        perms.push({ id, allow: [PermissionsBitField.Flags.Connect] });
      }
    }
    return perms;
  };
  const vc1 = await guild.channels.create({
    name: `${matchName} — Team 1 VC`,
    type: ChannelType.GuildVoice,
    parent: CATEGORY_ID,
    permissionOverwrites: makePerms(team1)
  });
  const vc2 = await guild.channels.create({
    name: `${matchName} — Team 2 VC`,
    type: ChannelType.GuildVoice,
    parent: CATEGORY_ID,
    permissionOverwrites: makePerms(team2)
  });

  // 2️⃣ Summary embed
  const embed = new EmbedBuilder()
    .setTitle(`🎮 ${matchName} Ready`)
    .setDescription(
      `**Team 1:** ${team1.map(u => `<@${rawId(u)}>`).join(', ')}\n` +
      `**Team 2:** ${team2.map(u => `<@${rawId(u)}>`).join(', ')}\n\n` +
      `🔊 <#${vc1.id}>\n🔊 <#${vc2.id}>`
    )
    .addFields({ name: '🧹 Chalk Votes', value: '0 / 4', inline: true })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('report_team1').setLabel('Report Team 1 Win').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('report_team2').setLabel('Report Team 2 Win').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('chalk').setLabel('🧹 Chalk Match').setStyle(ButtonStyle.Danger)
  );
  const msg = await channel.send({ embeds: [embed], components: [row] });

  // ─── 2️⃣ Also post “ready” embed to logs channel ─────────────
  {
    const logId = global.guildLogChannels.get(guild.id);
    if (logId) {
      const logCh = await guild.channels.fetch(logId).catch(() => null);
      if (logCh?.isTextBased()) {
        await logCh.send({ embeds: [embed] });
      }
    }
  }

  // 3️⃣ Auto-refresh embed
  const refresher = setInterval(() => {
    embed.setTimestamp();
    msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
  }, 30_000);

  // 4️⃣ Live countdown → auto-move or DM
  let countdown = 60;
  const countdownMsg = await channel.send(
    `⏳ Players will be moved to their voice channels automatically in ${countdown}s`
  );
  const mover = setInterval(async () => {
    countdown--;
    if (countdown > 0) {
      await countdownMsg.edit(
        `⏳ Players will be moved to their voice channels automatically in ${countdown}s`
      ).catch(() => {});
    } else {
      clearInterval(mover);
      await countdownMsg.edit(`✅ Moving players now…`).catch(() => {});

      // team1
      for (const u of team1) {
        const id = rawId(u);
        let member;
        try {
          member = await guild.members.fetch(id);
        } catch { continue; }
        if (member.voice.channel) {
          await member.voice.setChannel(vc1).catch(() => {});
        } else {
          await member.send(
            `🔊 I tried to move you into **${vc1.name}**, but you weren’t in a voice channel.` +
            ` Please join one now, and I’ll move you next time.`
          ).catch(() => {});
        }
      }

      // team2
      for (const u of team2) {
        const id = rawId(u);
        let member;
        try {
          member = await guild.members.fetch(id);
        } catch { continue; }
        if (member.voice.channel) {
          await member.voice.setChannel(vc2).catch(() => {});
        } else {
          await member.send(
            `🔊 I tried to move you into **${vc2.name}**, but you weren’t in a voice channel.` +
            ` Please join one now, and I’ll move you next time.`
          ).catch(() => {});
        }
      }

      await channel.send(`🔊 Move complete.`).catch(() => {});
    }
  }, 1000);

  // 5️⃣ Voting state
  const votes = { team1: new Set(), team2: new Set(), chalk: new Set() };
  function updateChalkField() {
    const idx = embed.data.fields.findIndex(f => f.name === '🧹 Chalk Votes');
    if (idx !== -1) {
      embed.spliceFields(idx, 1, {
        name: '🧹 Chalk Votes',
        value: `${votes.chalk.size} / 4`,
        inline: true
      });
    }
  }

  const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button });
  const cmdCollector = channel.createMessageCollector({
    filter: m => m.content.trim() === '/endqueue' && !m.author.bot
  });
  cmdCollector.on('collect', m => {
    if (!channel.name.startsWith('match-') ||
        !m.member.permissions.has(PermissionsBitField.Flags.ManageChannels)
    ) {
      return m.reply('❌ You cannot end this match.').catch(() => {});
    }
    m.delete().catch(() => {});
    collector.stop('forced');
    cmdCollector.stop();
  });

  collector.on('collect', async interaction => {
    const { customId, user } = interaction;
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    // Chalk vote
    if (customId === 'chalk') {
      votes.chalk.add(user.id);
      updateChalkField();
      await msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
      const total = votes.chalk.size;
      const isCap = [winner, loser].includes(user.id);
      if (isCap || total >= 4) {
        await interaction.followUp({ content: '🧹 Chalk threshold reached—closing.', ephemeral: true });
        await log(guild, `🧹 Chalked by ${isCap ? 'captain' : 'players'} (${total}/4)`);
        collector.stop('chalked');
      } else {
        await interaction.followUp({ content: `🧹 Vote recorded (${total}/4).`, ephemeral: true });
      }
      return;
    }

    // Report win
    let side = null;
    if (customId === 'report_team1') side = 'team1';
    if (customId === 'report_team2') side = 'team2';
    if (side) {
      const participants = new Set([...team1, ...team2].map(rawId));
      if (!participants.has(user.id)) {
        return interaction.followUp({ content: '❌ Only participants can report.', ephemeral: true });
      }
      votes[side].add(user.id);
      const total = votes[side].size;
      const isCap = [winner, loser].includes(user.id);
      if (isCap || total >= 3) {
        await interaction.followUp({ content: `🏆 Team ${side==='team1'? '1':'2'} wins—closing.`, ephemeral: true });
        await log(guild, `🏆 Team ${side==='team1'? '1':'2'} reported win (${total}/3)`);
        collector.stop('reported');
      } else {
        await interaction.followUp({ content: `✅ Vote recorded (${total}/3).`, ephemeral: true });
      }
      return;
    }
  });

  collector.on('end', async (_collected, reason) => {
    // stop intervals
    clearInterval(refresher);
    clearInterval(mover);
    cmdCollector.stop();

    // Unlock users
    for (const u of [...team1, ...team2]) {
      global.activeUsers?.delete(rawId(u));
    }

    // Save transcript
    try {
      const fetched = await channel.messages.fetch({ limit: 100 });
      const transcript = fetched
        .map(m => `${m.createdAt.toISOString()} [${m.author.tag}]: ${m.content}`)
        .reverse()
        .join('\n');
      const fn = `${matchName}-transcript.txt`;
      const fp = path.join(__dirname, fn);
      fs.writeFileSync(fp, transcript);
      await log(guild, `📜 Transcript for ${matchName}`, { attachment: fp, name: fn });
      fs.unlinkSync(fp);
    } catch {}

    // Determine outcome
    let team1Wins = false, team2Wins = false;
    if (reason === 'forced') {
      await log(guild, `⚖️ Match force-ended—tie.`);
    } else if (reason === 'chalked') {
      await log(guild, `🧹 ${matchName} was chalked—no result.`);
    } else {
      const cap1V = votes.team1.has(winner) || votes.team1.has(loser);
      const cap2V = votes.team2.has(winner) || votes.team2.has(loser);
      const p1    = votes.team1.size >= 3;
      const p2    = votes.team2.size >= 3;
      team1Wins = (cap1V || p1) && !(cap2V || p2);
      team2Wins = (cap2V || p2) && !(cap1V || p1);
      const resultLog = team1Wins
        ? `🏆 Team 1 wins ${matchName}!`
        : team2Wins
        ? `🏆 Team 2 wins ${matchName}!`
        : `⚖️ Match tied—no clear winner.`;
      await log(guild, resultLog);
    }

    // ───── Adjust MMR ─────
    const allIds     = [...team1, ...team2].map(rawId);
    const refs       = allIds.map(id => db.collection('users').doc(id));

    // snapshot before
    const beforeSnap = await Promise.all(refs.map(r => r.get()));
    const beforeData = beforeSnap.map(s =>
      s.exists ? s.data() : { mmr: 1000 }
    );

    // apply rewards
    try {
      if (team1Wins) {
        await rewards.processMatch({ team1Ids: team1, team2Ids: team2, winner: 1, chalked: false });
      } else if (team2Wins) {
        await rewards.processMatch({ team1Ids: team2, team2Ids: team1, winner: 1, chalked: false });
      } else {
        await rewards.processMatch({ team1Ids: allIds, team2Ids: [], winner: null, chalked: false });
      }
      await log(guild, `📈 MMR updated for participants.`);
    } catch (err) {
      console.error('Error updating MMR:', err);
      await log(guild, `⚠️ Error updating MMR: ${err.message}`);
    }

    // snapshot after
    const afterSnap = await Promise.all(refs.map(r => r.get()));
    const afterData = afterSnap.map((s, i) =>
      s.exists ? s.data() : beforeData[i]
    );

    // compute deltas
    const deltas = allIds.map((id, i) => {
      const mmrB = beforeData[i].mmr  ?? 1000;
      const mmrA = afterData[i].mmr   ?? mmrB;
      return { id, mmrDelta: mmrA - mmrB };
    });

    // ───── Build final summary embed ─────
    const resultEmbed = new EmbedBuilder()
      .setTitle(`📝 ${matchName} — Final Summary`)
      .addFields(
        { name: '🟥 Team 1', value: team1.map(u=>`<@${rawId(u)}>`).join('\n'), inline: true },
        { name: '🟦 Team 2', value: team2.map(u=>`<@${rawId(u)}>`).join('\n'), inline: true },
        { name: '🏁 Outcome', value:
            team1Wins ? 'Team 1 Wins' :
            team2Wins ? 'Team 2 Wins' :
            'Chalked / Tie', inline: false },
        { name: '📊 MMR Changes',
          value: deltas.map(d=>`<@${d.id}>: ${d.mmrDelta>=0?'+':''}${d.mmrDelta} MMR`).join('\n'),
          inline: false }
      )
      .setTimestamp();

    // send in match channel
    await channel.send({ embeds: [resultEmbed] });

    // DM each user
    for (const d of deltas) {
      guild.client.users.fetch(d.id)
        .then(u => u.send(`You gained ${d.mmrDelta>=0?'+':''}${d.mmrDelta} MMR in **${matchName}**.`).catch(()=>{}))
        .catch(()=>{});
    }

    // ─── Update Firestore with outcome ─────────
    await matchRef.update({
      status:   team1Wins ? 'team1_win'
               : team2Wins ? 'team2_win'
               : 'chalked',
      endedAt:  admin.firestore.FieldValue.serverTimestamp(),
      deltas
    });

    // ─── Post summary to logs channel ─────────
    {
      const logId = global.guildLogChannels.get(guild.id);
      if (logId) {
        const logCh = await guild.channels.fetch(logId).catch(()=>null);
        if (logCh?.isTextBased()) {
          await logCh.send({ embeds: [resultEmbed] });
        }
      }
    }

    // cleanup channels after 20s
    setTimeout(async () => {
      await channel.delete().catch(()=>{});
      await vc1.delete().catch(()=>{});
      await vc2.delete().catch(()=>{});
    }, 20_000);
  });
};
