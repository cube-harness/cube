import { createServer } from "node:http";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { Client } from "@langchain/langgraph-sdk";
import { createLogger } from "@/config/logger.js";
import { env } from "@/config/env.js";

const log = createLogger("telegram.gateway");

const client = new Client({ apiUrl: env.LANGGRAPH_API_URL });

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

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

const replyChunked = async (
  ctx: { reply: (text: string) => Promise<unknown> },
  text: string,
) => {
  for (const chunk of splitMessage(text)) {
    await ctx.reply(chunk);
  }
};

// Map chatId -> thread_id. Tạm thời in-memory — mất khi restart process.
// TODO: thay bằng lưu trữ bền vững (DB/Redis) khi lên production.
const threadByChat = new Map<number, string>();

const getOrCreateThreadId = async (chatId: number): Promise<string> => {
  const existing = threadByChat.get(chatId);
  if (existing) return existing;

  const thread = await client.threads.create();
  threadByChat.set(chatId, thread.thread_id);
  return thread.thread_id;
};

bot.on(message("text"), async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = String(ctx.from.id);
  const text = ctx.message.text;

  const runLog = log.child({ chatId, userId });

  runLog.info({ text }, "Received message");

  try {
    const threadId = await getOrCreateThreadId(chatId);

    const context = {
      userId,
      timeZone: "Asia/Ho_Chi_Minh",
    };

    const run = await client.runs.wait(threadId, "agent", {
      input: { messages: [{ role: "user", content: text }] },
      context,
    });

    const messages =
      (run as { messages?: Array<{ content: string }> }).messages ?? [];
    const lastMessage = messages.at(-1);

    if (lastMessage?.content) {
      runLog.info({ responseLength: lastMessage.content.length }, "Reply sent");
      await replyChunked(ctx, lastMessage.content);
    } else {
      runLog.warn("Agent returned no message content");
      await ctx.reply("Xin lỗi, mình chưa xử lý được yêu cầu này.");
    }
  } catch (e) {
    runLog.error({ err: e }, "Failed to process message");
    await ctx.reply("Đã có lỗi xảy ra, thử lại sau.");
  }
});

export const startTelegramGateway = async () => {
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
