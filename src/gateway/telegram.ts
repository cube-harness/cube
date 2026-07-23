import { createServer } from "node:http";
import { Telegraf, Context } from "telegraf";
import { message } from "telegraf/filters";
import { Client } from "@langchain/langgraph-sdk";
import { createLogger } from "@/config/logger.js";
import { env } from "@/config/env.js";

const log = createLogger("gateway.telegram");

const client = new Client({ apiUrl: env.LANGGRAPH_API_URL });

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN, { handlerTimeout: 9_000_000 });

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TYPING_INTERVAL_MS = 4000;

const splitMessage = (
  text: string,
  maxLength = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] => {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) splitAt = maxLength;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);

  return chunks;
};

// Map chatId -> thread_id. Tạm thời in-memory — mất khi restart process.
// TODO: thay bằng lưu trữ bền vững (DB/Redis) khi lên production.
const threadByChat = new Map<number, string>();

// Map chatId -> run đang chạy (để /cancel và /status tra cứu).
const runningRunByChat = new Map<number, { threadId: string; runId: string }>();

// Map chatId -> danh sách message_id trong phiên hiện tại.
// Dùng để /clear xoá thật sự khỏi màn hình (tương đương "Clear chat history > Delete for me and bot").
// Cũng in-memory, mất khi restart — chấp nhận được vì hệ quả chỉ là /clear bỏ sót vài tin cũ, không nghiêm trọng.
const messageIdsByChat = new Map<number, number[]>();

const trackMessage = (chatId: number, messageId: number) => {
  const ids = messageIdsByChat.get(chatId) ?? [];
  ids.push(messageId);
  messageIdsByChat.set(chatId, ids);
};


const replyChunked = async (ctx: Context, chatId: number, text: string) => {
  for (const chunk of splitMessage(text)) {
    const sent = await ctx.reply(chunk);
    trackMessage(chatId, sent.message_id);
  }
};

// Thread
const getOrCreateThreadId = async (chatId: number): Promise<string> => {
  const existing = threadByChat.get(chatId);
  if (existing) return existing;

  const thread = await client.threads.create();
  threadByChat.set(chatId, thread.thread_id);
  return thread.thread_id;
};

// Command interface
interface CommandDefinition {
  name: string;
  description: string;
  handler: (ctx: Context) => Promise<void>;
}

// Command config
const commands: CommandDefinition[] = [
  {
    name: "start",
    description: "Start the conversation",
    handler: async (ctx) => {
      await getOrCreateThreadId(ctx.chat!.id);
      await ctx.reply("Xin chào! Mình sẵn sàng hỗ trợ bạn.");
    },
  },
  {
    name: "clear",
    description: "Clear chat history",
    handler: async (ctx) => {
      const chatId = ctx.chat!.id;

      // 1. Xoá tin nhắn khỏi màn hình, cả tin user gửi lẫn tin bot trả lời.
      const ids = messageIdsByChat.get(chatId) ?? [];
      let deleted = 0;
      for (const id of ids) {
        try {
          await ctx.telegram.deleteMessage(chatId, id);
          deleted++;
        } catch {
          // Quá 48h hoặc đã bị xoá trước đó — bỏ qua, không phải lỗi nghiêm trọng.
        }
      }
      messageIdsByChat.delete(chatId);

      // 2. Xoá thread cũ trên LangGraph server, tạo thread mới — bộ nhớ ngắn hạn của agent
      // mất theo, đúng nghĩa "xoá sạch" chứ không phải chỉ ẩn đi.
      const oldThreadId = threadByChat.get(chatId);
      if (oldThreadId) {
        try {
          await client.threads.delete(oldThreadId);
        } catch (e) {
          log
            .child({ chatId, oldThreadId })
            .warn({ err: e }, "Failed to delete old thread, continuing anyway");
        }
      }
      threadByChat.delete(chatId);
      const newThreadId = await getOrCreateThreadId(chatId);

      log
        .child({ chatId, oldThreadId, newThreadId, deletedCount: deleted })
        .info("Cleared chat history and reset thread");

      const confirmation = await ctx.reply("Đã xoá cuộc trò chuyện.");
      trackMessage(chatId, confirmation.message_id);
    },
  },
  {
    name: "cancel",
    description: "Cancel running task",
    handler: async (ctx) => {
      const chatId = ctx.chat!.id;
      const running = runningRunByChat.get(chatId);

      if (!running) {
        await ctx.reply("Không có tác vụ nào đang chạy.");
        return;
      }

      try {
        await client.runs.cancel(running.threadId, running.runId, false, "interrupt");
        await ctx.reply("Đã huỷ tác vụ đang chạy.");
      } catch (e) {
        log.child({ chatId }).error({ err: e }, "Failed to cancel run");
        await ctx.reply("Không thể huỷ tác vụ, có thể nó đã xong.");
      }
    },
  },
  {
    name: "status",
    description: "View current task status",
    handler: async (ctx) => {
      const chatId = ctx.chat!.id;
      const running = runningRunByChat.get(chatId);

      if (!running) {
        await ctx.reply("Không có tác vụ nào đang chạy.");
        return;
      }

      try {
        const run = await client.runs.get(running.threadId, running.runId);
        await ctx.reply(`Trạng thái: ${run.status}`);
      } catch (e) {
        log.child({ chatId }).error({ err: e }, "Failed to get run status");
        await ctx.reply("Không lấy được trạng thái tác vụ.");
      }
    },
  },
  {
    name: "help",
    description: "Hiện danh sách lệnh",
    handler: async (ctx) => {
      const lines = commands.map((c) => `/${c.name} - ${c.description}`);
      await ctx.reply(lines.join("\n"));
    },
  },
];

// Register command
const registerCommands = () => {
  for (const cmd of commands) {
    bot.command(cmd.name, async (ctx) => {
      const runLog = log.child({ chatId: ctx.chat?.id, command: cmd.name });
      try {
        await cmd.handler(ctx);
      } catch (e) {
        runLog.error({ err: e }, "Command handler failed");
        await ctx.reply("Đã có lỗi xảy ra khi xử lý lệnh.");
      }
    });
  }
};

registerCommands();

// Text handler
bot.on(message("text"), async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = String(ctx.from.id);
  const text = ctx.message.text;

  trackMessage(chatId, ctx.message.message_id);

  const runLog = log.child({ chatId, userId });
  runLog.info({ text }, "Received message");

  const typingInterval = setInterval(() => {
    ctx.sendChatAction("typing").catch(() => {});
  }, TYPING_INTERVAL_MS);
  ctx.sendChatAction("typing").catch(() => {});

  try {
    const threadId = await getOrCreateThreadId(chatId);

    const context = {
      userId,
      agentId: "main-agent",
      timeZone: "Asia/Ho_Chi_Minh",
      locale: "vi-VN",
    };

    const run = await client.runs.create(threadId, "main-agent", {
      input: { messages: [{ role: "user", content: text }] },
      context,
      multitaskStrategy: "enqueue",
    });

    runningRunByChat.set(chatId, { threadId, runId: run.run_id });

    const result = await client.runs.join(threadId, run.run_id);

    const messages =
      (result as { messages?: Array<{ content: string }> }).messages ?? [];
    const lastMessage = messages.at(-1);

    if (lastMessage?.content) {
      runLog.info({ responseLength: lastMessage.content.length }, "Reply sent");
      await replyChunked(ctx, chatId, lastMessage.content);
    } else {
      runLog.warn("Agent returned no message content");
      const fallback = await ctx.reply("Xin lỗi, mình chưa xử lý được yêu cầu này.");
      trackMessage(chatId, fallback.message_id);
    }
  } catch (e) {
    runLog.error({ err: e }, "Failed to process message");
    const errorReply = await ctx.reply("Đã có lỗi xảy ra, thử lại sau.");
    trackMessage(chatId, errorReply.message_id);
  } finally {
    clearInterval(typingInterval);
    runningRunByChat.delete(chatId);
  }
});


// Webhook
export const startTelegramGateway = async () => {
  try {
    await bot.telegram.setMyCommands(
      commands.map((c) => ({ command: c.name, description: c.description })),
    );
    log.info("Registered bot commands with Telegram");
  } catch (e) {
    log.error({ err: e }, "Failed to register bot commands");
  }

  const webhookConfig = await bot.createWebhook({
    domain: env.TELEGRAM_WEBHOOK_DOMAIN,
    path: env.TELEGRAM_WEBHOOK_PATH,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
  });

  const server = createServer(webhookConfig);

  server.listen(env.TELEGRAM_WEBHOOK_PORT, () => {
    log.info(
      { domain: env.TELEGRAM_WEBHOOK_DOMAIN, port: env.TELEGRAM_WEBHOOK_PORT },
      "Telegram webhook listening",
    );
  });

  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
};
