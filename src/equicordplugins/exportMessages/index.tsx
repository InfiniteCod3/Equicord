/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType } from "@api/Commands";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
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

    // Handle reply to another message
    if (includeReplies && ((message as any).referenced_message || message.messageReference || (message as any).type === 19)) {
        let referencedMessage: any = null;

        // Try different ways to get the referenced message
        if ((message as any).referenced_message) {
            // Direct referenced message from API
            referencedMessage = (message as any).referenced_message;
        } else if (message.messageReference?.message_id) {
            // Traditional messageReference approach
            const replyId = message.messageReference.message_id;

            // First try to find the referenced message in our exported messages
            referencedMessage = allMessages.find(msg => msg.id === replyId);

            // If not found in our set, try the MessageStore as fallback
            if (!referencedMessage) {
                referencedMessage = MessageStore.getMessage(message.messageReference.channel_id, replyId);
            }
        } else if ((message as any).message_reference?.message_id) {
            // Try message_reference property
            const replyId = (message as any).message_reference.message_id;

            referencedMessage = allMessages.find(msg => msg.id === replyId);
            if (!referencedMessage) {
                referencedMessage = MessageStore.getMessage((message as any).message_reference.channel_id, replyId);
            }
        }

        if (referencedMessage) {
            const replyContent = referencedMessage.content || "[No text content]";
            // Truncate long messages for readability
            const truncatedContent = replyContent.length > 100
                ? replyContent.substring(0, 100) + "..."
                : replyContent;
            content += ` (replying to: "${truncatedContent}")`;
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
        // Fetch messages using Discord's REST API
        while (allMessages.length < limit) {
            const remaining = limit - allMessages.length;
            const batchSize = Math.min(100, remaining); // Discord API limit is 100 per request

            try {
                // Fetch messages using Discord's REST API
                const response = await RestAPI.get({
                    url: `/channels/${channelId}/messages`,
                    query: {
                        limit: batchSize,
                        ...(beforeId && { before: beforeId })
                    }
                });

                if (!response.body || !Array.isArray(response.body) || response.body.length === 0) {
                    // No more messages available
                    break;
                }

                // Add fetched messages to our array
                allMessages.push(...response.body);

                // Set beforeId to the oldest message ID from this batch for next iteration
                beforeId = response.body[response.body.length - 1].id;

                // Add a progressive delay to respect rate limits (more delay for larger exports)
                const delay = Math.min(200 + (allMessages.length / 100) * 50, 1000);
                await new Promise(resolve => setTimeout(resolve, delay));

            } catch (apiError) {
                console.warn("API error during message fetch:", apiError);
                // If we hit a rate limit, wait longer before retrying
                if ((apiError as any)?.status === 429) {
                    const retryAfter = ((apiError as any)?.body?.retry_after || 5) * 1000; // Convert to milliseconds
                    console.log(`Rate limited, waiting ${retryAfter / 1000} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, retryAfter));
                    // Don't increment beforeId, retry the same request
                    continue;
                }
                // For other errors, stop fetching
                console.error("Non-rate-limit API error:", apiError);
                break;
            }
        }

        // Sort messages by timestamp (oldest to newest)
        allMessages.sort((a, b) => {
            const timestampA = new Date(a.timestamp.toString()).getTime();
            const timestampB = new Date(b.timestamp.toString()).getTime();
            return timestampA - timestampB;
        });

        // Remove duplicates based on message ID
        const uniqueMessages = allMessages.filter((message, index, array) =>
            array.findIndex(m => m.id === message.id) === index
        );

        // Return the most recent 'limit' messages in chronological order
        return uniqueMessages.slice(-limit);

    } catch (error) {
        // Fallback to loaded messages only
        const loadedMessages = MessageStore.getMessages(channelId);
        if (loadedMessages?._array) {
            // Sort and deduplicate fallback messages too
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

async function exportMessages(channelId: string, messageCount: number) {
    try {
        // Validate inputs
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

        // Show initial notification for large exports
        if (messageCount > 1000) {
            showNotification({
                title: "Export Messages",
                body: `Starting export of ${messageCount} messages. This may take a while...`,
                icon: "⏳"
            });
        }

        // Add a small delay to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 100));

        // Fetch messages from the channel (this will get more than what's currently loaded)
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

        // Validate we have messages to export
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

        // Process messages with error handling for individual messages
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

            // Add small delay every 25 messages to prevent overwhelming (reduced from 50 for better pacing)
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

        // File saving with enhanced error handling
        try {
            if (IS_DISCORD_DESKTOP) {
                const data = new TextEncoder().encode(content);

                // Check if file is too large (>50MB for larger exports)
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
                // Browser environment
                const file = new File([content], filename, { type: "text/plain" });

                // Check file size limit for browser (increased for larger exports)
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
                }
            ],
            execute: (args, ctx) => {
                const messageCount = Math.min(Math.max(Number(args[0]?.value) || 10, 1), 10000);

                if (!ctx.channel?.id) {
                    return;
                }

                exportMessages(ctx.channel.id, messageCount);
            }
        }
    ]
});
