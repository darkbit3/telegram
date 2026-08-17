require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID;
const API = process.env.API_BASE_URL || 'http://localhost:3000';

if (!TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!ADMIN_CHAT_ID) { console.error('❌ ADMIN_CHAT_ID missing'); process.exit(1); }
if (!GROUP_CHAT_ID) { console.error('❌ TELEGRAM_GROUP_CHAT_ID missing'); process.exit(1); }

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  console.error('Unhandled rejection:', msg.length > 300 ? msg.substring(0, 300) : msg);
});

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('🤖 Miki Bot running...');
bot.on('polling_error', (err) => console.error('Polling error:', err.message));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isAdmin(id) { return String(id) === String(ADMIN_CHAT_ID); }
function ack(id, text = '', alert = false) {
  bot.answerCallbackQuery(id, { text, show_alert: alert }).catch(() => {});
}
function send(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
}
function api(method, path, data) {
  return axios[method](`${API}${path}`, data).then(r => r.data).catch(e => {
    console.error(`API ${method.toUpperCase()} ${path} failed:`, e.response?.data || e.message);
    return null;
  });
}
function getDisplayName(from) {
  return `${from.first_name || ''}${from.last_name ? ' ' + from.last_name : ''}`.trim() || from.username || String(from.id);
}

// ─── State ────────────────────────────────────────────────────────────────────
let posts = {};
let adminSession = null;
const takerSessions = {};
const inFlight = new Set();

// ─── Load from DB on startup ──────────────────────────────────────────────────
async function loadFromDB() {
  const res = await api('get', '/api/posts/active');
  if (!res) return;
  for (const p of res.posts) {
    posts[p.id] = {
      id: p.id, amount: p.amount, remaining: p.remaining,
      fullName: p.full_name, accountCBE: p.account_cbe,
      accountTelebirr: p.account_telebirr, groupMsgId: p.group_msg_id,
      locked: p.locked === 1,
      takers: (p.takers || []).map(t => ({
        takerId: t.id, userId: t.user_id, username: t.username,
        amount: t.amount, txnId: t.txn_id, status: t.status
      }))
    };
  }
  console.log(`✅ Loaded ${res.posts.length} active post(s) from DB`);
}
loadFromDB();

// ─── Smart post matching ──────────────────────────────────────────────────────
function findBestPost(amount) {
  const eligible = Object.values(posts).filter(p => p.remaining >= amount && !p.locked);
  if (!eligible.length) return null;
  eligible.sort((a, b) => a.remaining - b.remaining);
  return eligible[0];
}

// ─── Keyboards & text ────────────────────────────────────────────────────────
const DEPOSIT_AMOUNTS = [10000, 20000, 30000, 50000, 70000, 100000];

function buildAmountKeyboard(postId, remaining) {
  const buttons = [], row = [];
  for (const amt of DEPOSIT_AMOUNTS) {
    if (amt > remaining) break;
    row.push({ text: `💰 ${amt.toLocaleString()}`, callback_data: `take:${postId}:${amt}` });
    if (row.length === 3) { buttons.push([...row]); row.length = 0; }
  }
  if (row.length > 0) buttons.push([...row]);
  buttons.push([{ text: '❌ Cancel', callback_data: `cancel_post:${postId}` }]);
  return { inline_keyboard: buttons };
}

function buildGroupText(post, remaining) {
  let text = `💸 *Withdrawal Request #${post.id}*\n\n💰 Amount: *${post.amount.toLocaleString()} ETB*`;
  if (remaining < post.amount) text += `\n💰 Remaining: *${remaining.toLocaleString()} ETB*`;
  return text;
}

// ─── Publish post ─────────────────────────────────────────────────────────────
async function publishPost(chatId) {
  const s = adminSession;
  adminSession = null;

  const res = await api('post', '/api/posts', {
    amount: s.amount, full_name: s.fullName,
    account_cbe: s.accountCBE || null, account_telebirr: s.accountTelebirr || null
  });
  if (!res) { send(chatId, '⚠️ Failed to save post. Try again.'); return; }

  const post = {
    id: res.post.id, amount: s.amount, remaining: s.amount,
    fullName: s.fullName, accountCBE: s.accountCBE || null,
    accountTelebirr: s.accountTelebirr || null,
    groupMsgId: null, locked: false, takers: []
  };
  posts[post.id] = post;

  const [groupMsg] = await Promise.all([
    bot.sendMessage(GROUP_CHAT_ID, buildGroupText(post, post.amount), {
      parse_mode: 'Markdown', reply_markup: buildAmountKeyboard(post.id, post.amount)
    }),
    send(chatId, `✅ *Posted!*\n\n💰 ${post.amount.toLocaleString()} ETB | 👤 ${post.fullName}`)
  ]);
  post.groupMsgId = groupMsg.message_id;
  api('patch', `/api/posts/${post.id}/group-msg`, { group_msg_id: groupMsg.message_id });
}

// ─── Show confirm preview ─────────────────────────────────────────────────────
function showConfirm(chatId) {
  const s = adminSession;
  let preview = `📋 *Preview*\n\n💰 Amount: *${s.amount.toLocaleString()} ETB*\n👤 ${s.fullName}`;
  if (s.accountCBE) preview += `\n💳 CBE: \`${s.accountCBE}\``;
  if (s.accountTelebirr) preview += `\n📱 Telebirr: \`${s.accountTelebirr}\``;
  return send(chatId, preview, {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Post to Group', callback_data: 'admin_post_confirm' }],
      [{ text: '❌ Cancel',        callback_data: 'admin_post_cancel'  }],
    ]}
  });
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  console.log(`▶️  /start | ID: ${msg.from.id} | ${getDisplayName(msg.from)}`)
  if (isAdmin(msg.from.id)) {
    send(msg.chat.id, `👑 *Admin Panel*\n\nUse the menu below:`, {
      reply_markup: {
        keyboard: [
          [{ text: '➕ New Post' }, { text: '📋 Active Posts' }],
          [{ text: '🔑 Transactions' }]
        ],
        resize_keyboard: true, is_persistent: true
      }
    });
  } else {
    send(msg.chat.id, `👋 Check the group for available withdrawal requests.`);
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (msg.chat.type !== 'private' || !msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text.trim();

  // ── TAKER: submit TXN ID — check FIRST (admin can also be a taker) ─────────
  if (takerSessions[userId]) {
    const sess = takerSessions[userId];
    const post = posts[sess.postId];
    if (!post) { delete takerSessions[userId]; return; }
    if (text.length < 3) { send(chatId, '⚠️ Transaction ID too short. Try again:'); return; }

    const { postId, takerId, amount, username } = sess;
    const txnId = text;
    delete takerSessions[userId];
    post.locked = false;
    post.takers.push({ takerId, userId, username, amount, txnId, status: 'pending' });
    post.remaining -= amount;

    await Promise.all([
      api('patch', `/api/posts/takers/${takerId}`, { txn_id: txnId, status: 'pending' }),
      api('patch', `/api/posts/${postId}/remaining`, { remaining: post.remaining }),
    ]);

    const txnKey = `${postId}:${takerId}:${userId}`;

    // Extract URL from TXN text if present
    const urlMatch = txnId.match(/https?:\/\/[^\s]+/);
    const txnUrl = urlMatch ? urlMatch[0] : null;

    // Share text with amount + account + URL
    const shareParts = [
      `💰 Amount: ${amount.toLocaleString()} ETB`,
      `👤 ${post.fullName}`,
      post.accountCBE ? `💳 CBE: ${post.accountCBE}` : null,
      post.accountTelebirr ? `📱 Telebirr: ${post.accountTelebirr}` : null,
      txnUrl ? `🔗 ${txnUrl}` : null,
    ].filter(Boolean).join('\n');

    const shareUrl = txnUrl
      ? `https://t.me/share/url?url=${encodeURIComponent(txnUrl)}&text=${encodeURIComponent(shareParts)}`
      : `https://t.me/share/url?url=${encodeURIComponent('https://t.me')}&text=${encodeURIComponent(shareParts)}`;

    const shareBtn = { text: '📤 Share', url: shareUrl };

    let adminMsg = `🔔 *Transaction Submitted*\n\n`;
    adminMsg += `💰 Amount: *${amount.toLocaleString()} ETB*\n`;
    adminMsg += `👤 By: ${username || userId}\n\n`;
    adminMsg += `📋 *Post #${postId}* | 👤 ${post.fullName}\n`;
    if (post.accountCBE) adminMsg += `💳 CBE: \`${post.accountCBE}\`\n`;
    if (post.accountTelebirr) adminMsg += `📱 Telebirr: \`${post.accountTelebirr}\`\n`;
    adminMsg += `\n💰 Total: *${post.amount.toLocaleString()} ETB* | Remaining: *${post.remaining.toLocaleString()} ETB*\n\n`;
    adminMsg += `🔑 *Receipt:*\n${txnId}`;

    await Promise.all([
      send(ADMIN_CHAT_ID, adminMsg, {
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [
          [
            { text: '✅ Done',   callback_data: `txn_done:${txnKey}` },
            { text: '❌ Reject', callback_data: `txn_reject:${txnKey}` },
          ],
          [ shareBtn ],
        ]}
      }),
      send(chatId,
        `✅ *Transaction ID received!*\n\nWaiting for admin confirmation.`,
        { disable_web_page_preview: true }
      ),
    ]);
    return;
  }

  // ── ADMIN ──────────────────────────────────────────────────────────────────
  if (isAdmin(userId)) {

    // ── New Post: single message input ──
    if (text === '➕ New Post') {
      adminSession = { step: 'ask_info' };
      send(chatId,
        `📝 *New Post*\n\nSend the details in *one message* like this:\n\n` +
        `\`50000\nKaleab Tesfaye\n1000123456\n0911234567\`\n\n` +
        `• Line 1: Amount\n• Line 2: Full name\n• Line 3: CBE account _(or skip)_\n• Line 4: Telebirr account _(or skip)_`
      );
      return;
    }

    if (adminSession?.step === 'ask_info') {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) {
        send(chatId, '⚠️ Need at least 2 lines (amount + name). Try again:');
        return;
      }
      const amount = parseFloat(lines[0].replace(/,/g, ''));
      if (isNaN(amount) || amount <= 0) {
        send(chatId, '⚠️ First line must be a valid amount. Try again:');
        return;
      }
      const fullName = lines[1];
      const accountCBE = (lines[2] && lines[2].toLowerCase() !== 'skip') ? lines[2] : null;
      const accountTelebirr = (lines[3] && lines[3].toLowerCase() !== 'skip') ? lines[3] : null;
      adminSession = { step: 'confirm', amount, fullName, accountCBE, accountTelebirr };
      showConfirm(chatId);
      return;
    }

    // ── Active Posts ──
    if (text === '📋 Active Posts') {
      const active = Object.values(posts).filter(p => p.remaining > 0 || p.takers.length > 0);
      if (!active.length) { send(chatId, '📋 No active posts.'); return; }
      for (const p of active) {
        const paid = p.amount - p.remaining;
        let info = `📋 *Post #${p.id}*\n`;
        info += `💰 Total: *${p.amount.toLocaleString()} ETB*\n`;
        info += `✅ Paid: *${paid.toLocaleString()} ETB*\n`;
        info += `⏳ Remaining: *${p.remaining.toLocaleString()} ETB*\n`;
        info += `👤 ${p.fullName}`;
        if (p.accountCBE) info += `\n💳 CBE: \`${p.accountCBE}\``;
        if (p.accountTelebirr) info += `\n📱 Telebirr: \`${p.accountTelebirr}\``;
        if (p.takers.length > 0) {
          info += `\n\n📊 *Payments:*`;
          for (const t of p.takers) {
            info += `\n• ${t.username || t.userId} — *${t.amount.toLocaleString()} ETB*`;
            if (t.txnId) info += ` | TXN: \`${t.txnId}\``;
            info += ` (${t.status})`;
          }
        }
        send(chatId, info, { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel Post', callback_data: `cancel_post:${p.id}` }]] } });
      }
      return;
    }

    // ── Transactions ──
    if (text === '🔑 Transactions') {
      const all = Object.values(posts).flatMap(p => p.takers.map(t => ({ ...t, postId: p.id })));
      if (!all.length) { send(chatId, '🔑 No transactions yet.'); return; }
      let t = `🔑 *Transactions*\n\n`;
      for (const tk of all) {
        t += `Post #${tk.postId} | 💰 *${tk.amount.toLocaleString()} ETB* | ${tk.username || tk.userId}\n`;
        if (tk.txnId) t += `🔑 \`${tk.txnId}\` (${tk.status})\n`;
        t += '\n';
      }
      send(chatId, t);
      return;
    }

    return;
  }
});

// ─── Callback queries ─────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const userId = String(query.from.id);
  const username = getDisplayName(query.from);
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;

  // ── Admin: confirm post ──
  if (data === 'admin_post_confirm') {
    if (!isAdmin(userId)) { ack(query.id, '⚠️ Not allowed.', true); return; }
    ack(query.id);
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    await publishPost(chatId);
    return;
  }

  // ── Admin: cancel post creation ──
  if (data === 'admin_post_cancel') {
    if (!isAdmin(userId)) { ack(query.id, '⚠️ Not allowed.', true); return; }
    ack(query.id);
    adminSession = null;
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    send(chatId, '❌ Post creation cancelled.');
    return;
  }

  // ── Take an amount ──
  if (data.startsWith('take:')) {
    const amount = Number(data.split(':')[2]);
    const dedupKey = `${userId}:${amount}`;
    if (inFlight.has(dedupKey)) { ack(query.id, '⏳ Processing...', true); return; }
    inFlight.add(dedupKey);
    ack(query.id);

    try {
      if (takerSessions[userId]) {
        send(chatId, '⚠️ You have a pending transaction. Send the TXN ID first.');
        return;
      }

      const bestPost = findBestPost(amount);
      if (!bestPost) { send(chatId, `⚠️ No post available for *${amount.toLocaleString()} ETB* right now.`); return; }

      // Lock immediately — no await between check and lock
      bestPost.locked = true;

      const takerRes = await api('post', `/api/posts/${bestPost.id}/takers`, { user_id: userId, username, amount });
      if (!takerRes) {
        bestPost.locked = false;
        send(chatId, '⚠️ Failed to process. Try again.');
        return;
      }
      const takerId = takerRes.taker.id;
      api('patch', `/api/posts/${bestPost.id}/lock`, { locked: true });
      takerSessions[userId] = { postId: bestPost.id, takerId, amount, username };

      let payMsg = `✅ *You are depositing ${amount.toLocaleString()} ETB*\n\n📋 *Send payment to:*\n👤 ${bestPost.fullName}`;
      if (bestPost.accountCBE) payMsg += `\n💳 CBE: \`${bestPost.accountCBE}\``;
      if (bestPost.accountTelebirr) payMsg += `\n📱 Telebirr: \`${bestPost.accountTelebirr}\``;
      payMsg += `\n\nAfter sending, enter the *Transaction ID*:`;

      await Promise.all([
        bot.editMessageText(
          query.message.text + `\n\n⏳ *${amount.toLocaleString()} ETB being processed...*`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }
        ).catch(() => {}),
        bot.sendMessage(userId, payMsg, { parse_mode: 'Markdown' }).catch(async () => {
          bestPost.locked = false;
          delete takerSessions[userId];
          api('patch', `/api/posts/${bestPost.id}/lock`, { locked: false });
          api('patch', `/api/posts/takers/${takerId}`, { status: 'cancelled' });
          await Promise.all([
            bot.editMessageReplyMarkup(buildAmountKeyboard(bestPost.id, bestPost.remaining), { chat_id: chatId, message_id: msgId }).catch(() => {}),
            bot.sendMessage(chatId, `${username} — please start the bot first before accepting a request.`)
          ]);
        })
      ]);
    } finally {
      inFlight.delete(dedupKey);
    }
    return;
  }

  // ── Admin: transaction Done ──
  if (data.startsWith('txn_done:')) {
    if (!isAdmin(userId)) { ack(query.id, '⚠️ Not allowed.', true); return; }
    ack(query.id);

    // Keep the Share button, remove only Done/Reject
    const existingButtons = query.message.reply_markup?.inline_keyboard || [];
    const shareRow = existingButtons.find(row => row.some(btn => btn.text === '📤 Share'));
    const newKeyboard = shareRow ? [shareRow] : [];
    bot.editMessageReplyMarkup({ inline_keyboard: newKeyboard }, { chat_id: chatId, message_id: msgId }).catch(() => {});

    const parts = data.slice('txn_done:'.length).split(':');
    const postId = Number(parts[0]);
    const takerId = Number(parts[1]);
    const takingUserId = parts[2];
    const post = posts[postId];
    const taker = post?.takers.find(t => t.takerId === takerId);
    const amount = taker?.amount ?? 0;

    api('patch', `/api/posts/takers/${takerId}`, { status: 'done' });

    if (post?.groupMsgId) {
      if (post.remaining > 0) {
        bot.editMessageText(buildGroupText(post, post.remaining), {
          chat_id: GROUP_CHAT_ID, message_id: post.groupMsgId,
          parse_mode: 'Markdown', reply_markup: buildAmountKeyboard(postId, post.remaining)
        }).catch(() => {});
      } else {
        bot.deleteMessage(GROUP_CHAT_ID, post.groupMsgId).catch(() => {});
        api('patch', `/api/posts/${postId}/status`, { status: 'done' });
      }
    }

    send(takingUserId, `✅ *Payment Confirmed!*\n\nYour deposit of *${amount.toLocaleString()} ETB* has been confirmed by admin. Thank you!`);
    return;
  }

  // ── Admin: transaction Reject ──
  if (data.startsWith('txn_reject:')) {
    if (!isAdmin(userId)) { ack(query.id, '⚠️ Not allowed.', true); return; }
    ack(query.id);
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});

    const parts = data.slice('txn_reject:'.length).split(':');
    const postId = Number(parts[0]);
    const takerId = Number(parts[1]);
    const takingUserId = parts[2];
    const post = posts[postId];
    const takerIdx = post?.takers.findIndex(t => t.takerId === takerId) ?? -1;
    const amount = takerIdx >= 0 ? post.takers[takerIdx].amount : 0;

    if (post && takerIdx >= 0) {
      post.remaining += amount;
      post.locked = false;
      post.takers.splice(takerIdx, 1);
      api('patch', `/api/posts/takers/${takerId}`, { status: 'rejected' });
      api('patch', `/api/posts/${postId}/remaining`, { remaining: post.remaining });
      bot.editMessageText(buildGroupText(post, post.remaining), {
        chat_id: GROUP_CHAT_ID, message_id: post.groupMsgId,
        parse_mode: 'Markdown', reply_markup: buildAmountKeyboard(postId, post.remaining)
      }).catch(async () => {
        const newMsg = await bot.sendMessage(GROUP_CHAT_ID, buildGroupText(post, post.remaining), {
          parse_mode: 'Markdown', reply_markup: buildAmountKeyboard(postId, post.remaining)
        });
        post.groupMsgId = newMsg.message_id;
        api('patch', `/api/posts/${postId}/group-msg`, { group_msg_id: newMsg.message_id });
      });
    }

    send(takingUserId, `❌ *Transaction Rejected*\n\nYour deposit of *${amount.toLocaleString()} ETB* was rejected by admin.\n\nThe request has been reposted. Please try again or contact support.`);
    return;
  }

  // ── Cancel a post ──
  if (data.startsWith('cancel_post:')) {
    if (!isAdmin(userId)) { ack(query.id, '⚠️ Only admin can cancel posts.', true); return; }
    ack(query.id);
    const postId = Number(data.split(':')[1]);
    const post = posts[postId];
    if (!post) { send(chatId, '⚠️ Post not found.'); return; }

    post.remaining = 0;
    post.locked = false;

    await Promise.all([
      post.groupMsgId ? bot.deleteMessage(GROUP_CHAT_ID, post.groupMsgId).catch(() => {}) : Promise.resolve(),
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {}),
      api('patch', `/api/posts/${postId}/status`, { status: 'cancelled' }),
      send(ADMIN_CHAT_ID, `✅ Post #${postId} cancelled and removed from group.`)
    ]);
    return;
  }
});
