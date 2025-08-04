/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { get, set } from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { definePluginSettings, migratePluginSettings } from "@api/Settings";
import { debounce } from "@shared/debounce";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { MessageStore, RestAPI } from "@webpack/common";

interface ConversationEntry {
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: number;
}

interface ConversationData {
    [channelId: string]: ConversationEntry[];
}

const settings = definePluginSettings({
    provider: {
        type: OptionType.SELECT,
        description: "AI provider to use",
        options: [
            { label: "OpenRouter", value: "openrouter", default: true },
            { label: "Chutes AI", value: "chutes" }
        ],
        default: "openrouter",
        restartNeeded: false
    },
    openrouterApiKey: {
        type: OptionType.STRING,
        description: "OpenRouter API Key (required when using OpenRouter)",
        placeholder: "sk-or-v1-...",
        restartNeeded: false
    },
    chutesApiKey: {
        type: OptionType.STRING,
        description: "Chutes AI API Token (required when using Chutes)",
        placeholder: "Your Chutes API token...",
        restartNeeded: false
    },
    model: {
        type: OptionType.STRING,
        description: "Model to use (OpenRouter: anthropic/claude-3.5-sonnet, meta-llama/llama-3.2-90b-vision-instruct | Chutes: zai-org/GLM-4.5-FP8, microsoft/Phi-3.5-mini-instruct)",
        default: "anthropic/claude-3.5-sonnet",
        placeholder: "Model identifier for your selected provider"
    },
    maxContextMessages: {
        type: OptionType.NUMBER,
        description: "Default maximum number of messages to include as context",
        default: 50,
        restartNeeded: false
    },
    maxConversationHistory: {
        type: OptionType.NUMBER,
        description: "Maximum number of conversation entries to keep per channel (0 = unlimited)",
        default: 100,
        restartNeeded: false
    },
    conversationHistoryDays: {
        type: OptionType.NUMBER,
        description: "Number of days to keep conversation history (0 = forever)",
        default: 30,
        restartNeeded: false
    },
    systemPrompt: {
        type: OptionType.STRING,
        description: "System prompt to use for the AI (optional)",
        default: "You are a helpful AI assistant in a Discord chat. Be concise and helpful.",
        placeholder: "Custom system prompt..."
    },
    showProviderInNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show which AI provider is being used in notifications",
        default: true,
        restartNeeded: false
    },
    temperature: {
        type: OptionType.SLIDER,
        description: "Temperature for AI responses (0.0 = deterministic, 1.0 = creative)",
        markers: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
        default: 0.7,
        stickToMarkers: false
    }
});

migratePluginSettings("aiagent", "AIAgent");

let conversationCache: ConversationData = {};

async function loadConversationData() {
    try {
        const data = await get("aiagent-conversations");
        if (data && typeof data === "object") {
            conversationCache = data;
            cleanupAllConversations();
        }
    } catch (error) {
        console.error("Failed to load conversation data:", error);
    }
}

function cleanupAllConversations() {
    let needsCleanup = false;

    for (const channelId in conversationCache) {
        const originalLength = conversationCache[channelId].length;
        cleanupConversationHistory(channelId);
        if (conversationCache[channelId].length !== originalLength) {
            needsCleanup = true;
        }
    }

    if (needsCleanup) {
        console.log("Auro: Cleaned up old conversation data");
        saveConversationDataImmediate();
    }
}

async function saveConversationDataImmediate() {
    try {
        await set("aiagent-conversations", conversationCache);
    } catch (error) {
        console.error("Failed to save conversation data:", error);
        showNotification({
            title: "Auro Error",
            body: "Failed to save conversation data. Your conversation history may not persist.",
            icon: "⚠️"
        });
    }
}

const saveConversationData = debounce(saveConversationDataImmediate, 1000);

function addToConversation(channelId: string, role: "user" | "assistant" | "system", content: string) {
    if (!conversationCache[channelId]) {
        conversationCache[channelId] = [];
    }

    conversationCache[channelId].push({
        role,
        content,
        timestamp: Date.now()
    });

    cleanupConversationHistory(channelId);

    saveConversationData();
}

function cleanupConversationHistory(channelId: string) {
    const conversation = conversationCache[channelId];
    if (!conversation || conversation.length === 0) return;

    let needsCleanup = false;

    if (settings.store.conversationHistoryDays > 0) {
        const cutoffTime = Date.now() - (settings.store.conversationHistoryDays * 24 * 60 * 60 * 1000);
        const filteredByAge = conversation.filter(entry => entry.timestamp > cutoffTime);
        if (filteredByAge.length !== conversation.length) {
            conversationCache[channelId] = filteredByAge;
            needsCleanup = true;
        }
    }

    if (settings.store.maxConversationHistory > 0) {
        const currentConversation = conversationCache[channelId];
        if (currentConversation.length > settings.store.maxConversationHistory) {
            conversationCache[channelId] = currentConversation.slice(-settings.store.maxConversationHistory);
            needsCleanup = true;
        }
    }

    if (needsCleanup) {
        saveConversationDataImmediate();
    }
}
function getConversationHistory(channelId: string): ConversationEntry[] {
    return conversationCache[channelId] || [];
}

function clearConversation(channelId: string) {
    delete conversationCache[channelId];
    saveConversationDataImmediate();
}

function formatMessage(message: Message, allMessages: Message[] = [], includeReplies = true): string {
    const { author } = message;
    const timestamp = new Date(message.timestamp.toString()).toLocaleString();

    let content = `[${timestamp}] ${author.username}`;
    if (author.discriminator !== "0") {
        content += `#${author.discriminator}`;
    }

    if (includeReplies && ((message as any).referenced_message || message.messageReference || (message as any).type === 19)) {
        let referencedMessage: any = null;

        if ((message as any).referenced_message) {
            referencedMessage = (message as any).referenced_message;
        } else if (message.messageReference?.message_id) {
            const replyId = message.messageReference.message_id;

            referencedMessage = allMessages.find(msg => msg.id === replyId);

            if (!referencedMessage) {
                referencedMessage = MessageStore.getMessage(message.messageReference.channel_id, replyId);
            }
        } else if ((message as any).message_reference?.message_id) {
            const replyId = (message as any).message_reference.message_id;

            referencedMessage = allMessages.find(msg => msg.id === replyId);
            if (!referencedMessage) {
                referencedMessage = MessageStore.getMessage((message as any).message_reference.channel_id, replyId);
            }
        }

        if (referencedMessage) {
            const replyContent = referencedMessage.content || "[No text content]";
            content += ` (replying to: "${replyContent}")`;
        } else {
            content += " (replying to: [Message not found])";
        }
    }

    content += `: ${message.content}`;

    if (message.attachments?.length > 0) {
        content += "\n  Attachments:";
        message.attachments.forEach(attachment => {
            content += `\n    - ${attachment.filename} (${attachment.url})`;
        });
    }

    if (message.embeds?.length > 0) {
        content += "\n  Embeds:";
        message.embeds.forEach(embed => {
            if (embed.rawTitle) content += `\n    Title: ${embed.rawTitle}`;
            if (embed.rawDescription) content += `\n    Description: ${embed.rawDescription}`;
            if (embed.url) content += `\n    URL: ${embed.url}`;
        });
    }

    return content;
}

async function fetchMessages(channelId: string, limit: number): Promise<Message[]> {
    const allMessages: Message[] = [];
    let beforeId: string | undefined;

    try {
        while (allMessages.length < limit) {
            const remaining = limit - allMessages.length;
            const batchSize = Math.min(100, remaining);

            try {
                const response = await RestAPI.get({
                    url: `/channels/${channelId}/messages`,
                    query: {
                        limit: batchSize,
                        ...(beforeId && { before: beforeId })
                    }
                });

                if (!response.body || !Array.isArray(response.body) || response.body.length === 0) {
                    break;
                }

                allMessages.push(...response.body);
                beforeId = response.body[response.body.length - 1].id;

                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (apiError: any) {
                if (apiError?.status === 429) {
                    const retryAfter = (apiError?.body?.retry_after || 5) * 1000;
                    await new Promise(resolve => setTimeout(resolve, retryAfter));
                    continue;
                }
                break;
            }
        }

        // Sort by timestamp
        allMessages.sort((a, b) => {
            const timestampA = new Date(a.timestamp.toString()).getTime();
            const timestampB = new Date(b.timestamp.toString()).getTime();
            return timestampA - timestampB;
        });

        // Remove duplicates and return most recent messages
        const uniqueMessages = allMessages.filter((message, index, array) =>
            array.findIndex(m => m.id === message.id) === index
        );

        return uniqueMessages.slice(-limit);

    } catch (error) {
        const loadedMessages = MessageStore.getMessages(channelId);
        if (loadedMessages?._array) {
            const sortedMessages = [...loadedMessages._array].sort((a, b) => {
                const timestampA = new Date(a.timestamp.toString()).getTime();
                const timestampB = new Date(b.timestamp.toString()).getTime();
                return timestampA - timestampB;
            });
            return sortedMessages.slice(-limit);
        }
        return [];
    }
}

async function callOpenRouter(messages: any[]): Promise<string> {
    const apiKey = settings.store.openrouterApiKey;
    if (!apiKey) {
        throw new Error("OpenRouter API key not configured. Please set it in plugin settings.");
    }

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://discord.com",
                "X-Title": "Equicord AI Agent Plugin"
            },
            body: JSON.stringify({
                model: settings.store.model,
                messages: messages,
                temperature: settings.store.temperature,
                max_tokens: 4096,
                stream: false
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`OpenRouter API error (${response.status}): ${errorData}`);
        }

        const data = await response.json();

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error("Invalid response from OpenRouter API");
        }

        return data.choices[0].message.content;

    } catch (error: any) {
        throw new Error(`Failed to call OpenRouter API: ${error.message}`);
    }
}

async function callChutes(messages: any[]): Promise<string> {
    const apiKey = settings.store.chutesApiKey;
    if (!apiKey) {
        throw new Error("Chutes AI API token not configured. Please set it in plugin settings.");
    }

    try {
        const response = await fetch("https://llm.chutes.ai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: settings.store.model,
                messages: messages,
                temperature: settings.store.temperature,
                max_tokens: 4096,
                stream: false
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`Chutes AI API error (${response.status}): ${errorData}`);
        }

        const data = await response.json();

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error("Invalid response from Chutes AI API");
        }

        return data.choices[0].message.content;

    } catch (error: any) {
        throw new Error(`Failed to call Chutes AI API: ${error.message}`);
    }
}

async function callAIProvider(messages: any[]): Promise<string> {
    const { provider } = settings.store;

    switch (provider) {
        case "openrouter":
            return await callOpenRouter(messages);
        case "chutes":
            return await callChutes(messages);
        default:
            throw new Error(`Unknown AI provider: ${provider}`);
    }
}

async function runAIAgent(channelId: string, prompt: string, includeContext: boolean = true, contextCount?: number) {
    try {
        const { provider, openrouterApiKey, chutesApiKey, showProviderInNotifications } = settings.store;

        if (provider === "openrouter" && !openrouterApiKey) {
            showNotification({
                title: "Auro",
                body: "Please configure your OpenRouter API key in plugin settings",
                icon: "❌"
            });
            return;
        } else if (provider === "chutes" && !chutesApiKey) {
            showNotification({
                title: "Auro",
                body: "Please configure your Chutes AI API token in plugin settings",
                icon: "❌"
            });
            return;
        }

        const providerName = provider === "openrouter" ? "OpenRouter" : "Chutes AI";
        const processingMessage = showProviderInNotifications
            ? `Processing request using ${providerName}...`
            : "Processing request...";

        showNotification({
            title: "Auro",
            body: processingMessage,
            icon: "🤖"
        });

        // Build messages array for API
        const messages: any[] = [];

        // Add system prompt if configured
        if (settings.store.systemPrompt) {
            messages.push({
                role: "system",
                content: settings.store.systemPrompt
            });
        }

        // Add conversation history
        const conversationHistory = getConversationHistory(channelId);
        messages.push(...conversationHistory.map(entry => ({
            role: entry.role,
            content: entry.content
        })));

        // Add context messages if requested
        if (includeContext) {
            try {
                const maxContextMessages = contextCount ?? settings.store.maxContextMessages;
                const contextMessages = await fetchMessages(channelId, maxContextMessages);
                if (contextMessages.length > 0) {
                    const contextContent = `Recent channel context (${contextMessages.length} messages):\n\n` +
                        contextMessages.map(msg => formatMessage(msg, contextMessages)).join("\n\n");

                    messages.push({
                        role: "system",
                        content: contextContent
                    });
                }
            } catch (error) {
                console.warn("Failed to fetch context messages:", error);
                // Continue without context
            }
        }

        // Add the user's prompt
        messages.push({
            role: "user",
            content: prompt
        });

        // Call AI Provider API
        const response = await callAIProvider(messages);

        addToConversation(channelId, "user", prompt);
        addToConversation(channelId, "assistant", response);

        const auroUser = {
            id: "auro-ai-agent",
            username: "Auro",
            discriminator: "0000",
            bot: true,
            system: false,
            publicFlags: 0
        };

        const botMessage = sendBotMessage(channelId, {
            content: response
        });

        if (botMessage) {
            (botMessage as any).author = auroUser;
        }

        showNotification({
            title: "Auro",
            body: "Response sent successfully",
            icon: "✅"
        });
    } catch (error: any) {
        showNotification({
            title: "Auro Error",
            body: error.message || "An unexpected error occurred",
            icon: "❌"
        });
    }
}

export default definePlugin({
    name: "AIAgent",
    description: "Auro - AI-powered assistant supporting OpenRouter and Chutes AI with conversation memory and message context",
    authors: [EquicordDevs.nobody],
    settings,

    async start() {
        await loadConversationData();
    },

    async stop() {
        await saveConversationDataImmediate();
    },

    commands: [
        {
            name: "ai",
            description: "Ask Auro a question",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "prompt",
                    description: "Your question or prompt for Auro",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "context",
                    description: "Include recent channel messages as context",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false
                },
                {
                    name: "contextcount",
                    description: "Number of recent messages to include as context (default from settings)",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                }
            ],
            execute: (args, ctx) => {
                const prompt = args[0]?.value as string;
                const includeContext = args[1]?.value !== undefined ? Boolean(args[1]?.value) : true;
                const contextCount = args[2]?.value !== undefined ? Number(args[2]?.value) : undefined;

                if (!ctx.channel?.id || !prompt) {
                    return;
                }

                runAIAgent(ctx.channel.id, prompt, includeContext, contextCount);
            }
        },
        {
            name: "aiclear",
            description: "Clear Auro's conversation memory for this channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (args, ctx) => {
                if (!ctx.channel?.id) {
                    return;
                }

                clearConversation(ctx.channel.id);

                showNotification({
                    title: "Auro",
                    body: "Conversation memory cleared for this channel",
                    icon: "🧹"
                });
            }
        },
        {
            name: "aihistory",
            description: "Show Auro's conversation history for this channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (args, ctx) => {
                if (!ctx.channel?.id) {
                    return;
                }

                const history = getConversationHistory(ctx.channel.id);
                if (history.length === 0) {
                    showNotification({
                        title: "Auro History",
                        body: "No conversation history for this channel",
                        icon: "📝"
                    });
                    return;
                }

                const summary = `${history.length} entries in conversation history`;
                const lastEntry = history[history.length - 1];
                const lastEntryPreview = lastEntry.content.length > 50
                    ? lastEntry.content.substring(0, 50) + "..."
                    : lastEntry.content;

                showNotification({
                    title: "Auro History",
                    body: `${summary}\nLast: [${lastEntry.role}] ${lastEntryPreview}`,
                    icon: "📝"
                });

                console.log("Auro History for channel", ctx.channel.id, ":", history);
            }
        },
        {
            name: "aicleanup",
            description: "Clean up old Auro conversation data and save current data",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (args, ctx) => {
                try {
                    cleanupAllConversations();
                    await saveConversationDataImmediate();

                    showNotification({
                        title: "Auro",
                        body: "Conversation data cleaned up and saved successfully",
                        icon: "🧹"
                    });
                } catch (error: any) {
                    showNotification({
                        title: "Auro Error",
                        body: `Failed to cleanup data: ${error.message}`,
                        icon: "❌"
                    });
                }
            }
        }
    ]
});
