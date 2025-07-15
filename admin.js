// admin.js — handles all admin commands
const {
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  PermissionsBitField,
  EmbedBuilder,
  ChannelType
} = require("discord.js");
const adminSDK = require("firebase-admin");
const db       = adminSDK.firestore();
const { DEFAULT_MMR } = require("./rewards"); // to know the base

// helper to extract a snowflake ID from a mention/string
const rawId = str => (str.match(/\d{17,19}/) || [str])[0];

// helper to write into your log channel
async function adminLog(guild, { by, text }) {
  const logId = global.guildLogChannels?.get(guild.id);
  if (!logId) return;
  const ch = await guild.channels.fetch(logId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const emb = new EmbedBuilder()
    .setColor(0xFFA500)
    .setAuthor({ name: by.tag, iconURL: by.displayAvatarURL() })
    .setDescription(text)
    .setTimestamp();
  await ch.send({ embeds: [emb] }).catch(() => {});
}

// for two-step reset confirmation
const pendingResets = new Map(); // userId → code

module.exports = {
  // 1) all slash‐command definitions
  data: [
    new SlashCommandBuilder()
      .setName("endqueue")
      .setDescription("Select and terminate an active match"),

    new SlashCommandBuilder()
      .setName("resetleaderboard")
      .setDescription("Reset all MMR and records to 0")
      .addSubcommand(sub =>
        sub.setName("start")
           .setDescription("Generate a confirmation code")
      )
      .addSubcommand(sub =>
        sub.setName("confirm")
           .setDescription("Confirm reset with code")
           .addStringOption(opt =>
             opt.setName("code")
                .setDescription("Confirmation code")
                .setRequired(true)
           )
      ),

    new SlashCommandBuilder()
      .setName("mmr")
      .setDescription("Add or remove MMR for a user")
      .addSubcommand(sub =>
        sub.setName("add")
           .setDescription("Add MMR")
           .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
           .addIntegerOption(o => o.setName("amount").setDescription("Amount to add").setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName("remove")
           .setDescription("Remove MMR")
           .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
           .addIntegerOption(o => o.setName("amount").setDescription("Amount to remove").setRequired(true))
      ),

    new SlashCommandBuilder()
      .setName("wins")
      .setDescription("Add or remove wins for a user")
      .addSubcommand(sub =>
        sub.setName("add")
           .setDescription("Add wins")
           .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
           .addIntegerOption(o => o.setName("amount").setDescription("Wins to add").setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName("remove")
           .setDescription("Remove wins")
           .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
           .addIntegerOption(o => o.setName("amount").setDescription("Wins to remove").setRequired(true))
      ),

    new SlashCommandBuilder()
      .setName("losses")
      .setDescription("Add or remove losses for a user")
      .addSubcommand(sub =>
        sub.setName("add")
           .setDescription("Add losses")
           .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
           .addIntegerOption(o => o.setName("amount").setDescription("Losses to add").setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName("remove")
           .setDescription("Remove losses")
           .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
           .addIntegerOption(o => o.setName("amount").setDescription("Losses to remove").setRequired(true))
      ),
  ],

  // 2) handler for chat‐input commands
  async execute(interaction) {
    // admin guard
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({ content: "❌ You lack permission.", ephemeral: true });
    }

    const cmd = interaction.commandName;
    const user = interaction.user;

    // ───── endqueue ─────
    if (cmd === "endqueue") {
      const active = global.activeMatches;
      if (!active?.size) {
        return interaction.reply({ content: "⚠️ No active matches.", ephemeral: true });
      }
      await adminLog(interaction.guild, {
        by: user,
        text: `📢 /endqueue invoked — ${active.size} active match(es).`
      });
      const menu = new StringSelectMenuBuilder()
        .setCustomId("endqueue_select")
        .setPlaceholder("Select match to terminate")
        .addOptions(
          [...active.values()].map(({ channel }) => ({
            label: channel.name,
            value: channel.id
          }))
        );
      return interaction.reply({
        content: "Select a match:",
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
      });
    }

    // ───── resetleaderboard ─────
    if (cmd === "resetleaderboard") {
      const sub = interaction.options.getSubcommand();
      const uid = user.id;

      if (sub === "start") {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        pendingResets.set(uid, code);
        return interaction.reply({
          content:
            `⚠️ This will wipe everyone’s MMR & records.\n` +
            `Run \`/resetleaderboard confirm code:${code}\` to confirm.`,
          ephemeral: true
        });
      } else {
        const input = interaction.options.getString("code", true);
        const want  = pendingResets.get(uid);
        if (!want || input !== want) {
          return interaction.reply({ content: "❌ Invalid code.", ephemeral: true });
        }
        pendingResets.delete(uid);

        // perform reset
        const batch = db.batch();
        const snap  = await db.collection("users").get();
        snap.docs.forEach(doc =>
          batch.set(doc.ref, {
            mmr: 0,
            wins: 0,
            losses: 0,
            streak: 0,
            last10: []
          }, { merge: true })
        );
        await batch.commit();

        await adminLog(interaction.guild, {
          by: user,
          text: `✅ Leaderboard reset by code:${input}`
        });
        return interaction.reply({ content: "✅ Leaderboard reset.", ephemeral: true });
      }
    }

    // ───── mmr ─────
    if (cmd === "mmr") {
      const sub = interaction.options.getSubcommand();
      const target = interaction.options.getUser("user", true);
      const amt    = interaction.options.getInteger("amount", true);
      const ref    = db.collection("users").doc(target.id);
      const snap   = await ref.get();
      const data   = snap.exists ? snap.data() : { mmr: DEFAULT_MMR };
      let mmr      = data.mmr ?? DEFAULT_MMR;

      if (sub === "add") {
        mmr += amt;
        await ref.set({ mmr }, { merge: true });
        await adminLog(interaction.guild, {
          by: user,
          text: `▶️ +${amt} MMR to <@${target.id}> (now ${mmr})`
        });
        return interaction.reply({ content: `✅ <@${target.id}>'s MMR is ${mmr}.`, ephemeral: true });
      } else {
        mmr = Math.max(0, mmr - amt);
        await ref.set({ mmr }, { merge: true });
        await adminLog(interaction.guild, {
          by: user,
          text: `⬇️ -${amt} MMR from <@${target.id}> (now ${mmr})`
        });
        return interaction.reply({ content: `✅ <@${target.id}>'s MMR is ${mmr}.`, ephemeral: true });
      }
    }

    // ───── wins ─────
    if (cmd === "wins") {
      const sub = interaction.options.getSubcommand();
      const target = interaction.options.getUser("user", true);
      const amt    = interaction.options.getInteger("amount", true);
      const ref    = db.collection("users").doc(target.id);
      const snap   = await ref.get();
      const data   = snap.exists ? snap.data() : { wins: 0 };
      let wins     = data.wins ?? 0;

      if (sub === "add") {
        wins += amt;
        await ref.set({ wins }, { merge: true });
        await adminLog(interaction.guild, {
          by: user,
          text: `▶️ +${amt} wins to <@${target.id}> (now ${wins})`
        });
        return interaction.reply({ content: `✅ <@${target.id}>'s wins: ${wins}.`, ephemeral: true });
      } else {
        wins = Math.max(0, wins - amt);
        await ref.set({ wins }, { merge: true });
        await adminLog(interaction.guild, {
          by: user,
          text: `⬇️ -${amt} wins from <@${target.id}> (now ${wins})`
        });
        return interaction.reply({ content: `✅ <@${target.id}>'s wins: ${wins}.`, ephemeral: true });
      }
    }

    // ───── losses ─────
    if (cmd === "losses") {
      const sub = interaction.options.getSubcommand();
      const target = interaction.options.getUser("user", true);
      const amt    = interaction.options.getInteger("amount", true);
      const ref    = db.collection("users").doc(target.id);
      const snap   = await ref.get();
      const data   = snap.exists ? snap.data() : { losses: 0 };
      let losses   = data.losses ?? 0;

      if (sub === "add") {
        losses += amt;
        await ref.set({ losses }, { merge: true });
        await adminLog(interaction.guild, {
          by: user,
          text: `▶️ +${amt} losses to <@${target.id}> (now ${losses})`
        });
        return interaction.reply({ content: `✅ <@${target.id}>'s losses: ${losses}.`, ephemeral: true });
      } else {
        losses = Math.max(0, losses - amt);
        await ref.set({ losses }, { merge: true });
        await adminLog(interaction.guild, {
          by: user,
          text: `⬇️ -${amt} losses from <@${target.id}> (now ${losses})`
        });
        return interaction.reply({ content: `✅ <@${target.id}>'s losses: ${losses}.`, ephemeral: true });
      }
    }
  },

  // 3) select‐menu handler for endqueue
  async handleComponent(interaction) {
    if (interaction.customId !== "endqueue_select") return;
    const guild     = interaction.guild;
    const user      = interaction.user;
    const channelId = interaction.values[0];
    const record    = global.activeMatches.get(channelId);

    await interaction.update({ components: [] }).catch(() => {});
    if (!record) {
      return interaction.followUp({ content: "⚠️ Match already closed.", ephemeral: true });
    }

    const { channel, players } = record;
    await adminLog(guild, {
      by: user,
      text: `🗑️ Terminating ${channel.name} and unlocking ${players.length}.`
    });

    // delete text + voice
    try { await channel.delete(); } catch {}
    for (const sfx of ["Team 1 VC","Team 2 VC"]) {
      const vc = guild.channels.cache.find(c =>
        c.type === ChannelType.GuildVoice &&
        c.name === `${channel.name} — ${sfx}`
      );
      if (vc) try { await vc.delete(); } catch {}
    }

    // unlock
    for (const m of players) global.activeUsers.delete(rawId(m));
    global.activeMatches.delete(channelId);

    await adminLog(guild, {
      by: user,
      text: `✅ ${channel.name} terminated, users unlocked.`
    });
  }
};
