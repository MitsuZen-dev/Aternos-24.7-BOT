const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');

const serverHost = process.env.SERVER_HOST || 'Jorooo.aternos.me';
const serverPort = parseInt(process.env.SERVER_PORT || '56651', 10);
const botUsername = process.env.BOT_USERNAME || 'Mizuhara';
const minecraftVersion = process.env.MC_VERSION || false;
const reconnectInterval = parseInt(process.env.RECONNECT_INTERVAL_MS || '40000', 10);
const antiAfkInterval = parseInt(process.env.ANTI_AFK_INTERVAL_MS || '20000', 10);
const httpPort = parseInt(process.env.PORT || '5000', 10);
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || null;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'main.html'));
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    botRunning: bot !== null,
    botUsername: bot && bot.player ? bot.username : null,
    target: `${serverHost}:${serverPort}`,
  });
});

// Discord webhook helper
function sendDiscord(content, color, title) {
  if (!discordWebhookUrl) return;
  try {
    const url = new URL(discordWebhookUrl);
    const body = JSON.stringify({
      embeds: [{
        title: title || 'Mizuhara Bot',
        description: content,
        color: color || 0x5865F2,
        timestamp: new Date().toISOString(),
        footer: { text: `${serverHost}:${serverPort}` }
      }]
    });
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options);
    req.on('error', (err) => console.error('Discord webhook error:', err.message));
    req.write(body);
    req.end();
  } catch (err) {
    console.error('Discord webhook send failed:', err.message);
  }
}

const DISCORD_GREEN  = 0x57F287;
const DISCORD_RED    = 0xED4245;
const DISCORD_YELLOW = 0xFEE75C;
const DISCORD_BLUE   = 0x5865F2;
const DISCORD_GREY   = 0x95A5A6;

let bot = null;
let antiAfkTimer = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let manualStop = false;
let botOnlineTime = null;

io.on('connection', (socket) => {
  console.log('Web client connected.');

  if (bot && bot.player) {
    socket.emit('bot_state', 'online');
    socket.emit('bot_status', `Bot ${bot.username} is online.`);
  } else if (bot) {
    socket.emit('bot_state', 'connecting');
    socket.emit('bot_status', 'Bot is connecting...');
  } else {
    socket.emit('bot_state', 'offline');
    socket.emit('bot_status', 'Bot is offline.');
  }

  socket.on('control_bot', (command) => {
    switch (command) {
      case 'start':
        manualStop = false;
        if (!bot) {
          createBot();
        } else {
          io.emit('bot_status', 'Bot is already running.');
        }
        break;
      case 'stop':
        manualStop = true;
        stopBot('Stopped by user.');
        break;
      case 'reconnect':
        manualStop = false;
        reconnectBot();
        break;
      default:
        console.log(`Unknown command: ${command}`);
        break;
    }
  });
});

server.listen(httpPort, () => {
  console.log(`HTTP server listening on port ${httpPort}.`);
});

function createBot() {
  clearReconnectTimer();

  if (bot) {
    console.log('Bot instance already exists; skipping create.');
    return;
  }

  console.log(`Connecting bot "${botUsername}" to ${serverHost}:${serverPort} ...`);
  io.emit('bot_state', 'connecting');
  io.emit('bot_status', `Connecting to ${serverHost}:${serverPort}...`);
  sendDiscord(`🔄 Connecting to **${serverHost}:${serverPort}**...`, DISCORD_BLUE, '🤖 Mizuhara');

  let newBot;
  try {
    newBot = mineflayer.createBot({
      host: serverHost,
      port: serverPort,
      username: botUsername,
      version: minecraftVersion,
      auth: 'offline',
      hideErrors: false,
    });
  } catch (err) {
    console.error('Failed to create bot:', err.message);
    io.emit('bot_status', `Failed to create bot: ${err.message}`);
    sendDiscord(`❌ Failed to create bot: **${err.message}**`, DISCORD_RED, '❌ Connection Failed');
    scheduleReconnect();
    return;
  }

  bot = newBot;

  bot.once('login', () => {
    console.log(`Bot "${bot.username}" logged in to ${serverHost}.`);
    io.emit('bot_state', 'connecting');
    io.emit('bot_status', `Bot ${bot.username} logged in.`);
    sendDiscord(`✅ **${bot.username}** logged in to \`${serverHost}\``, DISCORD_GREEN, '✅ Bot Online');
  });

  bot.once('spawn', () => {
    console.log(`Bot "${bot.username}" spawned in the world.`);
    botOnlineTime = Date.now();
    io.emit('bot_state', 'online');
    io.emit('bot_status', `Bot ${bot.username} is in the server.`);
    sendDiscord(`🌍 **${bot.username}** spawned and is now **in the server**. Anti-AFK active.`, DISCORD_GREEN, '🟢 Bot In Server');
    startAntiAfk();
    startHeartbeat();
  });

  bot.on('health', () => {
    if (bot && bot.health <= 0) {
      console.log('Bot has died, will respawn automatically.');
    }
  });

  bot.on('death', () => {
    console.log('Bot died. Respawning.');
    io.emit('bot_status', 'Bot died, respawning.');
    sendDiscord(`💀 **${botUsername}** died and is respawning.`, DISCORD_YELLOW, '💀 Bot Died');
  });

  bot.on('kicked', (reason) => {
    let message = reason;
    try {
      const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
      message = (parsed && (parsed.text || parsed.translate)) || JSON.stringify(parsed);
    } catch (_) {}
    console.log(`Bot kicked: ${message}`);
    io.emit('bot_state', 'offline');
    io.emit('bot_status', `Kicked: ${message}`);
    sendDiscord(`🚫 **${botUsername}** was kicked.\nReason: \`${message}\``, DISCORD_RED, '🚫 Bot Kicked');
  });

  bot.on('error', (err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error('Bot error:', msg);
    io.emit('bot_status', `Error: ${msg}`);
    sendDiscord(`⚠️ Bot error: \`${msg}\``, DISCORD_YELLOW, '⚠️ Bot Error');
  });

  bot.on('end', (reason) => {
    console.log(`Bot disconnected. Reason: ${reason || 'unknown'}.`);
    stopHeartbeat();
    cleanupBot();
    if (manualStop) {
      io.emit('bot_state', 'offline');
      io.emit('bot_status', 'Bot stopped.');
      sendDiscord(`🛑 **${botUsername}** was stopped manually.`, DISCORD_GREY, '🛑 Bot Stopped');
      return;
    }
    io.emit('bot_state', 'offline');
    io.emit('bot_status', `Disconnected (${reason || 'unknown'}). Reconnecting in ${reconnectInterval / 1000}s.`);
    sendDiscord(`🔌 **${botUsername}** disconnected (\`${reason || 'unknown'}\`). Reconnecting in **${reconnectInterval / 1000}s**...`, DISCORD_YELLOW, '🔌 Bot Disconnected');
    scheduleReconnect();
  });
}

function startAntiAfk() {
  stopAntiAfk();

  let yaw = 0;
  let pitch = 0;
  let yawTarget = 0;
  let pitchTarget = 0;
  let moveTick = 0;
  let lastMoveDir = null;
  const opposite = { forward: 'back', back: 'forward', left: 'right', right: 'left' };

  // Head rotation — runs every 200ms for smooth, constant scanning
  const headTimer = setInterval(() => {
    if (!bot || !bot.entity) return;
    try {
      // Every 10 ticks (~2s) pick a new target to look at
      if (moveTick % 10 === 0) {
        yawTarget = yaw + (Math.random() - 0.5) * Math.PI * 1.5;
        pitchTarget = (Math.random() - 0.5) * 0.9;
      }
      moveTick++;

      // Smoothly interpolate toward target (looks like real player scanning)
      yaw += (yawTarget - yaw) * 0.18;
      pitch += (pitchTarget - pitch) * 0.18;
      pitch = Math.max(-0.8, Math.min(0.8, pitch));
      bot.look(yaw, pitch, false).catch(() => {});
    } catch (err) {}
  }, 200);

  // Movement AI — runs every 800ms, steps then reverses to stay in place
  const moveTimer = setInterval(() => {
    if (!bot || !bot.entity) return;
    try {
      // Always cancel last move first (return to origin)
      if (lastMoveDir) {
        const rev = opposite[lastMoveDir];
        bot.setControlState(rev, true);
        setTimeout(() => { if (bot) bot.setControlState(rev, false); }, 350);
        lastMoveDir = null;
        return;
      }

      // Pick a new direction and step into it
      const dirs = ['forward', 'back', 'left', 'right'];
      const dir = dirs[Math.floor(Math.random() * dirs.length)];
      bot.setControlState(dir, true);
      setTimeout(() => { if (bot) bot.setControlState(dir, false); }, 350);
      lastMoveDir = dir;

      // Arm swing on movement
      bot.swingArm(Math.random() < 0.5 ? 'right' : 'left');

      // Occasional jump mid-step
      if (Math.random() < 0.2) {
        bot.setControlState('jump', true);
        setTimeout(() => { if (bot) bot.setControlState('jump', false); }, 150);
      }

      // Occasional sneak
      if (Math.random() < 0.15) {
        bot.setControlState('sneak', true);
        setTimeout(() => { if (bot) bot.setControlState('sneak', false); }, 500);
      }

    } catch (err) {
      console.error('Anti-AFK move error:', err.message);
    }
  }, 800);

  antiAfkTimer = { headTimer, moveTimer };
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!bot || !bot.entity) return;
    const uptime = botOnlineTime ? Math.floor((Date.now() - botOnlineTime) / 60000) : 0;
    sendDiscord(`💚 **${botUsername}** is still **in the server**.\nUptime: **${uptime} min**`, DISCORD_GREEN, '💚 Status: Online');
  }, 10 * 60 * 1000); // every 10 minutes
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function stopAntiAfk() {
  if (antiAfkTimer) {
    if (typeof antiAfkTimer === 'object' && antiAfkTimer.headTimer) {
      clearInterval(antiAfkTimer.headTimer);
      clearInterval(antiAfkTimer.moveTimer);
    } else {
      clearInterval(antiAfkTimer);
    }
    antiAfkTimer = null;
  }
}

function cleanupBot() {
  stopAntiAfk();
  stopHeartbeat();
  botOnlineTime = null;
  if (bot) {
    bot.removeAllListeners();
  }
  bot = null;
}

function stopBot(message) {
  clearReconnectTimer();
  if (bot) {
    try {
      bot.quit(message || 'Bye');
    } catch (err) {
      console.error('Error quitting bot:', err.message);
    }
    cleanupBot();
    console.log(message || 'Bot stopped.');
    io.emit('bot_status', message || 'Bot stopped.');
  } else {
    io.emit('bot_status', 'Bot is not running.');
  }
}

function reconnectBot() {
  console.log('Manual reconnect requested.');
  io.emit('bot_status', 'Reconnecting bot...');
  sendDiscord(`🔄 Manual reconnect triggered for **${botUsername}**.`, DISCORD_BLUE, '🔄 Reconnecting');
  if (bot) {
    try {
      bot.quit('Reconnecting');
    } catch (err) {
      console.error('Error during manual reconnect:', err.message);
    }
    cleanupBot();
  }
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, 1000);
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!bot && !manualStop) createBot();
  }, reconnectInterval);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down.');
  manualStop = true;
  stopBot('Server shutting down.');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
