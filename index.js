const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Bot owner (super admin) by username
const OWNER_USERNAME = process.env.OWNER_USERNAME;

const matches = {}; // chatId -> match state

const ALWAYS_ALLOWED_CMDS = ["/start", "/info", "/help"];
const IN_MATCH_ALLOWED_CMDS = ["/end", "/batting", "/bowling"];

// 10 minutes in milliseconds
const INACTIVITY_LIMIT = 10 * 60 * 1000;

/**
 * Extract command part from a message text, e.g. "/start@botname" -> "/start"
 */
function getCommand(text = "") {
  if (!text.startsWith("/")) return "";
  const [cmd] = text.split(" ");
  return cmd;
}

/**
 * Human‑readable name for a user
 */
function getDisplayName(from) {
  if (!from) return "Unknown";
  if (from.username) return `@${from.username}`;
  if (from.first_name && from.last_name)
    return `${from.first_name} ${from.last_name}`;
  if (from.first_name) return from.first_name;
  return String(from.id);
}

/**
 * Ensure player info is stored in match.players
 */
function savePlayer(match, from) {
  if (!from || !from.id) return;
  if (!match.players) match.players = {};
  if (!match.players[from.id]) {
    match.players[from.id] = {
      id: from.id,
      name: getDisplayName(from),
    };
  }
}

/**
 * Get stored player name (or fallback)
 */
function getPlayerName(match, userId) {
  if (userId === "BOT") return "BOT";
  if (!match.players || !match.players[userId]) return `Player(${userId})`;
  return match.players[userId].name;
}

/**
 * Get current bowler id.
 * Prefers human bowlers; uses BOT only if there are no humans.
 */
function getCurrentBowlerId(match) {
  const humans = match.bowlingTeam.filter((id) => id !== "BOT");
  if (humans.length === 0) return "BOT";
  const idx = match.bowlIndex % humans.length;
  return humans[idx];
}

/**
 * Update or start inactivity timer for a match
 */
function refreshInactivityTimer(chatId) {
  const match = matches[chatId];
  if (!match) return;

  // Clear previous timer if any
  if (match.inactivityTimeout) {
    clearTimeout(match.inactivityTimeout);
  }

  match.lastActivity = Date.now();
  match.inactivityTimeout = setTimeout(() => {
    // If match still exists and no activity within limit, auto end
    if (!matches[chatId]) return;

    bot.sendMessage(
      chatId,
      "⏰ Match ended automatically due to 10 minutes of inactivity."
    );
    endMatch(chatId);
  }, INACTIVITY_LIMIT);
}

/**
 * Global message guard:
 *  - Restrict commands during an active match in group
 *  - Ignore plain text in private chats
 */
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const cmd = getCommand(text);
  const match = matches[chatId];

  // Restrict in groups when a match is running
  if (match && msg.chat.type !== "private") {
    if (!cmd) {
      return bot.sendMessage(
        chatId,
        "❗ A match is already in progress.\n" +
          "Allowed now:\n" +
          "- Host: /end\n" +
          "- Current batsman: /batting <0-6>"
      );
    }
    if (![...ALWAYS_ALLOWED_CMDS, ...IN_MATCH_ALLOWED_CMDS].includes(cmd)) {
      return bot.sendMessage(
        chatId,
        "❗ A match is in progress, other commands are disabled until it ends."
      );
    }
  }

  // Ignore plain text in private chat
  if (msg.chat.type === "private" && !cmd) return;
});

/**
 * /startmatch – create a new match in a group
 */
bot.onText(/\/startmatch(?:@[\w_]+)?/, (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type === "private") {
    return bot.sendMessage(
      chatId,
      "❗ You can only start a match in a group."
    );
  }

  if (matches[chatId]) {
    return bot.sendMessage(
      chatId,
      "❗ A match is already in progress! The host must use /end before starting a new one."
    );
  }

  const hostName = getDisplayName(msg.from);

  matches[chatId] = {
    chatId,
    host: msg.from.id,
    battingTeam: [],
    bowlingTeam: ["BOT"],
    players: {},
    batIndex: 0,
    bowlIndex: 0,
    score: 0,
    wickets: 0,
    state: "JOIN_TEAMS", // JOIN_TEAMS -> WAITING_BOWLER -> WAITING_BATSMAN
    currentBowlerId: null,
    bowlerNum: null,
    lastActivity: Date.now(),
    inactivityTimeout: null,
  };

  savePlayer(matches[chatId], msg.from);
  refreshInactivityTimer(chatId);

  bot.sendMessage(
    chatId,
    `🏏 Match started by ${hostName}!\n\n` +
      "Batting team join: /bat\n" +
      "Bowling team join: /bowl\n" +
      "Start game: /play\n" +
      "Host can end game anytime: /end"
  );
});

/**
 * /bat – join batting team
 */
bot.onText(/\/bat(?:@[\w_]+)?/, (msg) => {
  const chatId = msg.chat.id;
  const match = matches[chatId];
  if (!match) return;

  savePlayer(match, msg.from);

  if (match.state !== "JOIN_TEAMS") {
    return bot.sendMessage(
      chatId,
      "❗ Teams are already locked, you cannot join now."
    );
  }

  if (match.battingTeam.length >= 11) {
    return bot.sendMessage(
      chatId,
      "Batting team cannot have more than 11 members."
    );
  }

  if (match.battingTeam.includes(msg.from.id)) {
    return bot.sendMessage(chatId, "You are already in the batting team.");
  }

  if (match.bowlingTeam.includes(msg.from.id)) {
    return bot.sendMessage(
      chatId,
      "❗ You are already in the bowling team."
    );
  }

  match.battingTeam.push(msg.from.id);
  const name = getPlayerName(match, msg.from.id);
  bot.sendMessage(chatId, `${name} joined the Batting team 🏏`);

  refreshInactivityTimer(chatId);
});

/**
 * /bowl – join bowling team
 */
bot.onText(/\/bowl(?:@[\w_]+)?/, (msg) => {
  const chatId = msg.chat.id;
  const match = matches[chatId];
  if (!match) return;

  savePlayer(match, msg.from);

  if (match.state !== "JOIN_TEAMS") {
    return bot.sendMessage(
      chatId,
      "❗ Teams are already locked, you cannot join now."
    );
  }

  if (match.bowlingTeam.length >= 11) {
    return bot.sendMessage(
      chatId,
      "Bowling team cannot have more than 11 members."
    );
  }

  if (match.bowlingTeam.includes(msg.from.id)) {
    return bot.sendMessage(chatId, "You are already in the bowling team.");
  }

  if (match.battingTeam.includes(msg.from.id)) {
    return bot.sendMessage(
      chatId,
      "❗ You are already in the batting team."
    );
  }

  match.bowlingTeam.push(msg.from.id);
  const name = getPlayerName(match, msg.from.id);
  bot.sendMessage(chatId, `${name} joined the Bowling team 🎯`);

  refreshInactivityTimer(chatId);
});

/**
 * /play – lock teams and start the game
 */
bot.onText(/\/play(?:@[\w_]+)?/, (msg) => {
  const chatId = msg.chat.id;
  const match = matches[chatId];
  if (!match) return;

  if (msg.from.id !== match.host) {
    return bot.sendMessage(chatId, "❗ Only the host can start the match.");
  }

  if (match.battingTeam.length === 0) {
    return bot.sendMessage(chatId, "❗ No batsmen have joined yet.");
  }

  match.state = "WAITING_BOWLER";
  match.batIndex = 0;
  match.bowlIndex = 0;
  match.bowlerNum = null;

  const currentBatId = match.battingTeam[match.batIndex];
  const currentBatName = getPlayerName(match, currentBatId);
  const currentBowlerId = getCurrentBowlerId(match);
  const currentBowlerName = getPlayerName(match, currentBowlerId);

  bot.sendMessage(
    chatId,
    "🎮 Game started!\n\n" +
      `Current batsman: ${currentBatName}\n` +
      `Current bowler: ${currentBowlerName}\n\n` +
      "Human bowler: send /bowling <0-6> in private chat.\n" +
      "If BOT is bowling, it will bowl automatically when batsman sends /batting."
  );

  refreshInactivityTimer(chatId);
});

/**
 * /bowling <num> – bowler sends number in private chat
 */
bot.onText(/\/bowling(?:@[\w_]+)?\s+(-?\d+)/, (msg, matchText) => {
  if (msg.chat.type !== "private") return;

  const num = Number(matchText[1]);
  if (isNaN(num) || num < 0 || num > 6) {
    return bot.sendMessage(
      msg.chat.id,
      "❗ Send a valid number between 0 and 6."
    );
  }

  let accepted = false;

  for (const [chatId, match] of Object.entries(matches)) {
    if (match.state !== "WAITING_BOWLER") continue;

    const expectedBowlerId = getCurrentBowlerId(match);

    // If BOT is expected, this match does not accept human bowling for this ball
    if (expectedBowlerId === "BOT") continue;

    if (expectedBowlerId === msg.from.id) {
      savePlayer(match, msg.from);

      match.bowlerNum = num;
      match.currentBowlerId = msg.from.id;
      match.state = "WAITING_BATSMAN";
      accepted = true;

      const bowlerName = getPlayerName(match, msg.from.id);
      const currentBatId =
        match.battingTeam[match.batIndex % match.battingTeam.length];
      const currentBatName = getPlayerName(match, currentBatId);

      bot.sendMessage(
        msg.chat.id,
        `✅ Number received from ${bowlerName}.\n` +
          `Now waiting for batsman (${currentBatName}) in the group.`
      );

      bot.sendMessage(
        Number(chatId),
        `Bowler: ${bowlerName} has chosen a number.\n` +
          `Current batsman: ${currentBatName}, send /batting <0-6>.`
      );

      refreshInactivityTimer(Number(chatId));
      break;
    }
  }

  if (!accepted) {
    bot.sendMessage(
      msg.chat.id,
      "❌ It is not your bowling turn or the game is not ready for a bowling number."
    );
  }
});

/**
 * Automatic BOT bowling for BOT turn
 */
function botBowl(match) {
  match.bowlerNum = Math.floor(Math.random() * 7);
  match.currentBowlerId = "BOT";
  match.state = "WAITING_BATSMAN";
}

/**
 * /batting <num> – batsman sends number in group
 */
bot.onText(/\/batting(?:@[\w_]+)?\s+(-?\d+)/, (msg, matchText) => {
  if (msg.chat.type === "private") return;

  const chatId = msg.chat.id;
  const match = matches[chatId];
  if (!match) return;

  if (match.state !== "WAITING_BATSMAN") {
    return bot.sendMessage(
      chatId,
      "❗ It is not the batsman's turn yet. Please wait."
    );
  }

  const currentBatId =
    match.battingTeam[match.batIndex % match.battingTeam.length];

  if (msg.from.id !== currentBatId) {
    const currentBatName = getPlayerName(match, currentBatId);
    return bot.sendMessage(
      chatId,
      `❗ It is not your batting turn.\nCurrent batsman: ${currentBatName}`
    );
  }

  savePlayer(match, msg.from);

  const num = Number(matchText[1]);
  if (isNaN(num) || num < 0 || num > 6) {
    return bot.sendMessage(
      chatId,
      "❗ Send a valid number between 0 and 6."
    );
  }

  const expectedBowlerId = getCurrentBowlerId(match);

  if (expectedBowlerId === "BOT") {
    botBowl(match);
  } else if (match.bowlerNum == null) {
    const nextBowlerName = getPlayerName(match, expectedBowlerId);
    return bot.sendMessage(
      chatId,
      `❗ The bowler (${nextBowlerName}) has not sent a number yet.\n` +
        "Bowler, send /bowling <0-6> in private."
    );
  }

  resolveTurn(match, num, chatId);
  refreshInactivityTimer(chatId);
});

/**
 * Resolve one ball: update score / wicket and prepare next turn
 */
function resolveTurn(match, batNum, chatId) {
  const bowlerNum = match.bowlerNum;
  const batsmanId =
    match.battingTeam[match.batIndex % match.battingTeam.length];
  const batsmanName = getPlayerName(match, batsmanId);
  const bowlerId = getCurrentBowlerId(match);
  const bowlerName = getPlayerName(match, bowlerId);

  if (batNum === bowlerNum) {
    match.wickets++;
    match.batIndex++;

    let nextBatsmanText = "No next batsman (all out).";
    if (match.batIndex < match.battingTeam.length) {
      const nextBatId =
        match.battingTeam[match.batIndex % match.battingTeam.length];
      const nextBatName = getPlayerName(match, nextBatId);
      nextBatsmanText = `Next batsman: ${nextBatName}`;
    }

    bot.sendMessage(
      chatId,
      `❌ OUT!\n` +
        `Batsman out: ${batsmanName}\n` +
        `Bowler: ${bowlerName}\n` +
        nextBatsmanText
    );
  } else {
    match.score += batNum;
    bot.sendMessage(
      chatId,
      `🏏 Runs scored: ${batNum}\n` +
        `Batsman: ${batsmanName}\n` +
        `Bowler: ${bowlerName}`
    );
  }

  bot.sendMessage(chatId, `Live Score: ${match.score}/${match.wickets}`);

  // All out
  if (match.batIndex >= match.battingTeam.length) {
    return endMatch(chatId);
  }

  // Prepare next ball
  match.bowlIndex++;
  match.bowlerNum = null;
  match.currentBowlerId = null;
  match.state = "WAITING_BOWLER";

  const nextBatId =
    match.battingTeam[match.batIndex % match.battingTeam.length];
  const nextBatName = getPlayerName(match, nextBatId);
  const nextBowlerId = getCurrentBowlerId(match);
  const nextBowlerName = getPlayerName(match, nextBowlerId);

  bot.sendMessage(
    chatId,
    `Next ball:\n` +
      `Current batsman: ${nextBatName}\n` +
      `Current bowler: ${nextBowlerName}\n\n` +
      "Bowler: send /bowling <0-6> in private.\n" +
      "If BOT is bowling, it will bowl automatically when batsman sends /batting."
  );
}

/**
 * /end – end match; allowed for host or owner
 */
bot.onText(/\/end(?:@[\w_]+)?/, (msg) => {
  const chatId = msg.chat.id;
  const match = matches[chatId];
  if (!match) return;

  const isHost = msg.from.id === match.host;
  const isOwner =
    msg.from.username &&
    OWNER_USERNAME &&
    msg.from.username.toLowerCase() === OWNER_USERNAME.toLowerCase();

  if (!isHost && !isOwner) {
    return bot.sendMessage(
      chatId,
      "❌ Only the host or the bot owner can end the match."
    );
  }

  endMatch(chatId);
});

/**
 * Finalize and clear match for a chat
 */
function endMatch(chatId) {
  const match = matches[chatId];
  if (!match) return;

  // Clear inactivity timer if present
  if (match.inactivityTimeout) {
    clearTimeout(match.inactivityTimeout);
  }

  bot.sendMessage(
    chatId,
    `🏁 Match Ended!\nFinal Score: ${match.score}/${match.wickets}`
  );
  delete matches[chatId];
}

/**
 * /start – show command list
 */
bot.onText(/\/start(?:@[\w_]+)?/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `⚡ Cricket Game Bot Commands ⚡\n\n` +
      `/info - Creator information\n` +
      `/help - How to use this bot\n` +
      `/startmatch - Start a new match (group only)\n` +
      `/bat - Join Batting Team\n` +
      `/bowl - Join Bowling Team\n` +
      `/play - Start the game\n` +
      `/end - End the match (host or owner)\n\n` +
      `During a match:\n` +
      `- Bowler (human): /bowling <0-6> (private chat)\n` +
      `- Batsman: /batting <0-6> (group chat)\n\n` +
      `👤 Created by Rudra\n` +
      `💬 Username: @rudra6548`
  );
});

/**
 * /help – short usage flow
 */
bot.onText(/\/help(?:@[\w_]+)?/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Flow:\n" +
      "/startmatch → /bat & /bowl → /play → /batting & /bowling → /end"
  );
});

/**
 * /info – creator info
 */
bot.onText(/\/info(?:@[\w_]+)?/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👤 Created by Rudra\n` + `💬 Username: @${process.env.OWNER_USERNAME}`
  );
});
