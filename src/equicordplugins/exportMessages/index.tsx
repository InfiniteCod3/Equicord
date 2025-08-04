/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType } from "@api/Commands";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import { EquicordDevs } from "@utils/constants";
import { showItemInFolder } from "@utils/native";
import definePlugin, { OptionType } from "@utils/types";
import { saveFile } from "@utils/web";
import { Message } from "@vencord/discord-types";
import { MessageStore, RestAPI } from "@webpack/common";

const settings = definePluginSettings({
    openFileAfterExport: {
        type: OptionType.BOOLEAN,
        description: "Open the exported file in the default file handler after export",
        default: true
    }
});

function formatMessage(message: Message, allMessages: Message[] = [], includeReplies = true) {
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

                const delay = Math.min(200 + (allMessages.length / 100) * 50, 1000);
                await new Promise(resolve => setTimeout(resolve, delay));

            } catch (apiError) {
                console.warn("API error during message fetch:", apiError);
                if ((apiError as any)?.status === 429) {
                    const retryAfter = ((apiError as any)?.body?.retry_after || 5) * 1000;
                    console.log(`Rate limited, waiting ${retryAfter / 1000} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, retryAfter));
                    continue;
                }
                console.error("Non-rate-limit API error:", apiError);
                break;
            }
        }

        allMessages.sort((a, b) => {
            const timestampA = new Date(a.timestamp.toString()).getTime();
            const timestampB = new Date(b.timestamp.toString()).getTime();
            return timestampA - timestampB;
        });

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

async function exportMessages(channelId: string, messageCount: number, useClipboard: boolean = true) {
    try {
        if (!channelId) {
            showNotification({
                title: "Export Messages",
                body: "Invalid channel ID",
                icon: "❌"
            });
            return;
        }

        if (messageCount <= 0 || messageCount > 10000) {
            showNotification({
                title: "Export Messages",
                body: "Message count must be between 1 and 10,000",
                icon: "❌"
            });
            return;
        }

        if (messageCount > 1000) {
            showNotification({
                title: "Export Messages",
                body: `Starting export of ${messageCount} messages. This may take a while...`,
                icon: "⏳"
            });
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        let messagesToExport: Message[];
        try {
            messagesToExport = await fetchMessages(channelId, messageCount);
        } catch (error) {
            showNotification({
                title: "Export Messages",
                body: "Failed to fetch messages. Try again in a moment.",
                icon: "❌"
            });
            return;
        }

        if (!messagesToExport || messagesToExport.length === 0) {
            showNotification({
                title: "Export Messages",
                body: "No messages found in this channel",
                icon: "❌"
            });
            return;
        }

        if (messagesToExport.length === 0) {
            showNotification({
                title: "Export Messages",
                body: "No messages available to export",
                icon: "❌"
            });
            return;
        }

        const timestamp = new Date().toISOString().split("T")[0];
        const filename = `messages-${channelId}-${timestamp}.txt`;

        let content = `Exported ${messagesToExport.length} messages from channel\n`;
        content += `Export date: ${new Date().toLocaleString()}\n`;
        content += `Channel ID: ${channelId}\n`;
        content += "=".repeat(50) + "\n\n";

        let processedCount = 0;
        for (const message of messagesToExport) {
            try {
                if (message && message.author) {
                    content += formatMessage(message, messagesToExport) + "\n\n";
                    processedCount++;
                }
            } catch (error) {
                content += "[Error: Could not format this message]\n\n";
            }

            if (processedCount % 25 === 0) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        if (processedCount === 0) {
            showNotification({
                title: "Export Messages",
                body: "No valid messages could be processed",
                icon: "❌"
            });
            return;
        }

        try {
            if (useClipboard) {
                try {
                    await copyToClipboard(content);
                    showNotification({
                        title: "Export Messages",
                        body: `${processedCount} messages copied to clipboard successfully`,
                        icon: "📋"
                    });
                } catch (error) {
                    showNotification({
                        title: "Export Messages",
                        body: "Failed to copy messages to clipboard",
                        icon: "❌"
                    });
                }
                return;
            }

            if (IS_DISCORD_DESKTOP) {
                const data = new TextEncoder().encode(content);

                if (data.length > 50 * 1024 * 1024) {
                    showNotification({
                        title: "Export Messages",
                        body: "Export file too large. Try exporting fewer messages.",
                        icon: "❌"
                    });
                    return;
                }

                const result = await DiscordNative.fileManager.saveWithDialog(data, filename);

                if (result && settings.store.openFileAfterExport) {
                    showItemInFolder(result);
                }
            } else {
                const file = new File([content], filename, { type: "text/plain" });

                if (file.size > 50 * 1024 * 1024) {
                    showNotification({
                        title: "Export Messages",
                        body: "Export file too large. Try exporting fewer messages.",
                        icon: "❌"
                    });
                    return;
                }

                saveFile(file);
            }

            showNotification({
                title: "Export Messages",
                body: `${processedCount} messages exported successfully as ${filename}`,
                icon: "📄"
            });

        } catch (saveError) {
            showNotification({
                title: "Export Messages",
                body: "Failed to save export file. Check permissions and try again.",
                icon: "❌"
            });
        }

    } catch (error) {
        showNotification({
            title: "Export Messages",
            body: "An unexpected error occurred during export",
            icon: "❌"
        });
    }
}

export default definePlugin({
    name: "ExportMessages",
    description: "Allows you to export messages from the current channel using /exportmessages command",
    authors: [EquicordDevs.veygax],
    settings,
    commands: [
        {
            name: "exportmessages",
            description: "Export a specified number of messages from the current channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "count",
                    description: "Number of messages to export (default: 10, max: 10,000)",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                },
                {
                    name: "clipboard",
                    description: "Copy messages to clipboard instead of saving to file (default: true)",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false
                }
            ],
            execute: (args, ctx) => {
                const messageCount = Math.min(Math.max(Number(args[0]?.value) || 10, 1), 10000);
                const useClipboard = args[1]?.value !== undefined ? Boolean(args[1]?.value) : true;

                if (!ctx.channel?.id) {
                    return;
                }

                exportMessages(ctx.channel.id, messageCount, useClipboard);
            }
        }
    ]
});
