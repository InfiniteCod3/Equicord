/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ApplicationCommandInputType, ApplicationCommandOptionType } from "@api/Commands";
import { showNotification } from "@api/Notifications";
import { definePluginSettings, migratePluginToSetting } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import { EquicordDevs } from "@utils/constants";
import { showItemInFolder } from "@utils/native";
import definePlugin, { OptionType } from "@utils/types";
import { saveFile } from "@utils/web";
import { Message } from "@vencord/discord-types";
import { Menu, MessageStore, RestAPI, Toasts } from "@webpack/common";

import { ContactsList } from "./types";

migratePluginToSetting("ExportMessages", "ExportContacts", "exportContacts");
const settings = definePluginSettings({
    openFileAfterExport: {
        type: OptionType.BOOLEAN,
        description: "Open the exported file in the default file handler after export",
        default: true
    },
    exportContacts: {
        type: OptionType.BOOLEAN,
        description: "Export a list of friends to your clipboard. Adds a new button to the menu bar for the friends tab.",
        default: false
    }
});

function formatMessage(message: Message, allMessages: Message[] = [], includeReplies = true) {
    const { author } = message;

    // Timestamp removed from individual messages; a consolidated time range is shown in the header instead.
    let content = `${author.username}`;
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
            let replyContent: string | undefined = (referencedMessage as any).content;

            // If the referenced message has no text, try to surface sticker names instead
            if (!replyContent || replyContent.trim().length === 0) {
                const refStickerItems = ((referencedMessage as any).stickerItems ?? (referencedMessage as any).sticker_items ?? []) as Array<{ name?: string; }>;
                const refStickerNames = Array.isArray(refStickerItems)
                    ? refStickerItems.map(s => s?.name).filter((n): n is string => !!n && n.trim().length > 0)
                    : [];
                if (refStickerNames.length > 0) {
                    replyContent = `[Sticker${refStickerNames.length > 1 ? "s" : ""}] ${refStickerNames.join(", ")}`;
                }
            }

            content += ` (replying to: "${replyContent || "[No text content]"}")`;
        } else {
            content += " (replying to: [Message not found])";
        }
    }

    // Prefer message text; if empty, include sticker names so the export isn't blank
    const textContent = (message.content ?? "").trim();

    // Gather sticker items from both camelCase and snake_case shapes
    const stickerItems = (((message as any).stickerItems ?? (message as any).sticker_items) ?? []) as Array<{
        name?: string;
    }>;
    const stickerNames = Array.isArray(stickerItems)
        ? stickerItems.map(s => s?.name).filter((n): n is string => !!n && n.trim().length > 0)
        : [];

    if (textContent.length > 0) {
        content += `: ${textContent}`;
        if (stickerNames.length > 0) {
            content += `\n  Stickers: ${stickerNames.join(", ")}`;
        }
    } else if (stickerNames.length > 0) {
        content += `: [Sticker${stickerNames.length > 1 ? "s" : ""}] ${stickerNames.join(", ")}`;
    } else {
        // No text and no stickers; keep the colon to maintain format
        content += ":";
    }

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

        const firstMsg = messagesToExport[0];
        const lastMsg = messagesToExport[messagesToExport.length - 1];
        const firstDate = new Date(firstMsg.timestamp.toString());
        const lastDate = new Date(lastMsg.timestamp.toString());

        let content = `Exported ${messagesToExport.length} messages from channel\n`;
        content += `Export date: ${new Date().toLocaleString()}\n`;
        content += `Channel ID: ${channelId}\n`;
        content += `Message time range: ${firstDate.toLocaleString()} -> ${lastDate.toLocaleString()}\n`;
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

// Export a single message (for context menu)
async function exportMessage(message: Message) {
    const timestamp = new Date(message.timestamp.toString()).toISOString().split("T")[0];
    const filename = `message-${message.id}-${timestamp}.txt`;

    const content = formatMessage(message);

    try {
        if (IS_DISCORD_DESKTOP) {
            const data = new TextEncoder().encode(content);
            const result = await DiscordNative.fileManager.saveWithDialog(data, filename);

            if (result && settings.store.openFileAfterExport) {
                showItemInFolder(result);
            }
        } else {
            const file = new File([content], filename, { type: "text/plain" });
            saveFile(file);
        }

        showNotification({
            title: "Export Messages",
            body: `Message exported successfully as ${filename}`,
            icon: "📄"
        });
    } catch (error) {
        showNotification({
            title: "Export Messages",
            body: "Failed to export message",
            icon: "❌"
        });
    }
}

const messageContextMenuPatch = (children: Array<React.ReactElement<any> | null>, props: { message: Message; }) => {
    const { message } = props;

    if (!message) return;

    children.push(
        <Menu.MenuItem
            id="export-message"
            label="Export Message"
            icon={() => (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" />
                </svg>
            )}
            action={() => exportMessage(message)}
        />
    );
};

// for type parameter, it takes in a number that determines the type of the contact
// 1 is friends added
// 2 is blocked users
// 3 is incoming friend requests
// 4 is outgoing friend requests
function getUsernames(contacts: ContactsList[], type: number): string[] {
    return contacts
        // only select contacts that are the specified type
        .filter(e => e.type === type)
        // return the username, and discriminator if necessary
        .map(e => e.user.discriminator === "0" ? e.user.username : e.user.username + "#" + e.user.discriminator);
}

export default definePlugin({
    name: "ExportMessages",
    description: "Export messages from channels via /exportmessages command or right-click context menu",
    authors: [EquicordDevs.veygax, EquicordDevs.dat_insanity],
    settings,
    contextMenus: {
        "message": messageContextMenuPatch
    },
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
    ],
    patches: [
        {
            find: "fetchRelationships(){",
            replacement: {
                match: /(\.then\(\i)=>(\i\.\i\.dispatch\({type:"LOAD_RELATIONSHIPS_SUCCESS",relationships:(\i\.body)}\))/,
                replace: "$1=>{$2; $self.getContacts($3)}"
            }
        },
        {
            find: "[role=\"tab\"][aria-disabled=\"false\"]",
            replacement: {
                match: /("aria-label":(\i).{0,25})(\i)\.Children\.map\((\i),this\.renderChildren\)/,
                replace:
                    "$1($3 && $3.Children" +
                    "? ($2 === 'Friends'" +
                    "? [...$3.Children.map($4, this.renderChildren), $self.addExportButton()]" +
                    ": [...$3.Children.map($4, this.renderChildren)])" +
                    ": $3.map($4, this.renderChildren))"
            }
        }
    ],
    getContacts(contacts: ContactsList[]) {
        this.contactList = {
            friendsAdded: [...getUsernames(contacts, 1)],
            blockedUsers: [...getUsernames(contacts, 2)],
            incomingFriendRequests: [...getUsernames(contacts, 3)],
            outgoingFriendRequests: [...getUsernames(contacts, 4)]
        };
    },
    addExportButton() {
        return <ErrorBoundary noop key=".2">
            <button className="export-contacts-button" onClick={() => { this.copyContactToClipboard(); console.log("clicked"); }}>Export</button>
        </ErrorBoundary>;
    },
    copyContactToClipboard() {
        if (this.contactList) {
            copyToClipboard(JSON.stringify(this.contactList));
            Toasts.show({
                message: "Contacts copied to clipboard successfully.",
                type: Toasts.Type.SUCCESS,
                id: Toasts.genId(),
                options: {
                    duration: 3000,
                    position: Toasts.Position.BOTTOM
                }
            });
            return;
        }
        // reason why you need to click the all tab is because the data is extracted during
        // the request itself when you fetch all your friends. this is done to avoid sending a
        // manual request to discord, which may raise suspicion and might even get you terminated.
        Toasts.show({
            message: "Contact list is undefined. Click on the \"All\" tab before exporting.",
            type: Toasts.Type.FAILURE,
            id: Toasts.genId(),
            options: {
                duration: 3000,
                position: Toasts.Position.BOTTOM
            }
        });
    }
});
