import { Client } from "@langchain/langgraph-sdk";
import { randomUUID } from "node:crypto";
import { Context, Telegraf } from "telegraf";
import { message as telegramMessage } from "telegraf/filters";
import { TELEGRAM_MESSAGE_MAX_LENGTH } from "@/config/constant.js";
import { env } from "@/config/env.js";

interface TelegramTextMessage {
  messageId: number;
  chatId: number;
  text: string;
  from?: {
    id: number;
    username?: string;
    languageCode?: string;
  };
}

interface MainStateValue {
  messages?: Array<{
    type?: string;
    content?: unknown;
  }>;
}

const langGraphClient = new Client<MainStateValue>({
  apiUrl: env.LANGGRAPH_API_URL,
  apiKey: null,
});

const activeTelegramThreadByChatId = new Map<number, string>();

const startTelegramGateway = async (): Promise<void> => {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required to run the Telegram gateway.");
  }

  const bot = createTelegramBot();

  setupTelegramBot(bot);

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  await bot.launch();
  console.log("Telegram gateway started.");
};

const createTelegramBot = (): Telegraf => {
  return new Telegraf(env.TELEGRAM_BOT_TOKEN);
};

const setupTelegramBot = (bot: Telegraf): void => {
  bot.start(async (ctx) => {
    await ctx.reply("Xin chào! Con vợ cần gì ?");
  });

  bot.command("clear", async (ctx) => {
    const threadId = randomUUID();
    activeTelegramThreadByChatId.set(ctx.chat.id, threadId);

    await ctx.reply("Đã bắt đầu conversation mới.");
  });

  bot.on(telegramMessage("text"), async (ctx) => {
    const message: TelegramTextMessage = {
      messageId: ctx.message.message_id,
      chatId: ctx.chat.id,
      text: ctx.message.text.trim(),
      from: ctx.from
        ? {
            id: ctx.from.id,
            username: ctx.from.username,
            languageCode: ctx.from.language_code,
          }
        : undefined,
    };

    if (!message.text) {
      return;
    }

    void handleTelegramTextMessage(ctx, message);
  });

  bot.on("message", async (ctx) => {
    await ctx.reply("Hiện tại bot chỉ xử lý text message.");
  });
};

const handleTelegramTextMessage = async (
  ctx: Context,
  message: TelegramTextMessage
): Promise<void> => {
  try {
    await ctx.sendChatAction("typing");
    const response = await generateAgentReply(message);

    for (const chunk of splitTelegramMessage(response)) {
      await ctx.reply(chunk);
    }
  } catch (error) {
    console.error("Telegram message handling failed:", error);
    await ctx.reply("Có lỗi khi xử lý tin nhắn. Vui lòng thử lại.");
  }
};

const generateAgentReply = async (
  message: TelegramTextMessage
): Promise<string> => {
  const threadId = await getOrCreateTelegramThread(message);

  const output = (await langGraphClient.runs.wait(
    threadId,
    env.LANGGRAPH_ASSISTANT_ID,
    {
      input: {
        messages: [{ type: "human", content: message.text }],
      },
        context: {
          userId: String(message.from?.id ?? message.chatId),
          userRole: "user",
          locale: "vi-VN",
        },
      metadata: {
        source: "telegram",
        chatId: message.chatId,
        messageId: message.messageId,
        username: message.from?.username,
      },
    }
  )) as MainStateValue;

  const messages = output.messages ?? [];
  const lastMessage = messages[messages.length - 1];

  if (typeof lastMessage?.content === "string" && lastMessage.content.trim()) {
    return lastMessage.content.trim();
  }

  return "Tôi đã xử lý xong nhưng không nhận được nội dung phản hồi.";
};

const getOrCreateTelegramThread = async (
  message: TelegramTextMessage
): Promise<string> => {
  let threadId = activeTelegramThreadByChatId.get(message.chatId);

  if (!threadId) {
    threadId = randomUUID();
    activeTelegramThreadByChatId.set(message.chatId, threadId);
  }

  try {
    await langGraphClient.threads.create({
      threadId,
      ifExists: "do_nothing",
      metadata: {
        source: "telegram",
        chatId: message.chatId,
        telegramUserId: message.from?.id,
        username: message.from?.username,
      },
    });
  } catch (error) {
    console.error(`Failed to get or create LangGraph thread ${threadId}:`, error);
    throw error;
  }

  return threadId;
};

const splitTelegramMessage = (text: string): string[] => {
  const remainingChunks: string[] = [];
  let remainingText = text.trim();

  while (remainingText.length > TELEGRAM_MESSAGE_MAX_LENGTH) {
    const chunkEndIndex = findTelegramChunkEndIndex(remainingText);
    const chunk = remainingText.slice(0, chunkEndIndex).trimEnd();

    if (chunk) {
      remainingChunks.push(chunk);
    }

    remainingText = remainingText.slice(chunkEndIndex).trimStart();
  }

  if (remainingText) {
    remainingChunks.push(remainingText);
  }

  return remainingChunks.length ? remainingChunks : [""];
};

const findTelegramChunkEndIndex = (text: string): number => {
  const hardLimit = TELEGRAM_MESSAGE_MAX_LENGTH;
  const candidate = text.slice(0, hardLimit);
  const newlineIndex = candidate.lastIndexOf("\n");

  if (newlineIndex > 0) {
    return newlineIndex;
  }

  const spaceIndex = candidate.lastIndexOf(" ");
  if (spaceIndex > 0) {
    return spaceIndex;
  }

  return hardLimit;
};

void startTelegramGateway().catch((error) => {
  console.error("Telegram gateway failed to start:", error);
  process.exit(1);
});
