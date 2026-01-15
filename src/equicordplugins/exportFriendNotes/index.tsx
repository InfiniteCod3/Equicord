/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { getUniqueUsername } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { RelationshipStore, RestAPI, UserStore } from "@webpack/common";

const settings = definePluginSettings({
    onlyWithNotes: {
        type: OptionType.BOOLEAN,
        description: "Only export friends who have a note",
        default: false,
    },
});

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchNoteWithRetry(userId: string, maxRetries = 5): Promise<string | null> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await RestAPI.get({
                url: `/users/@me/notes/${userId}`,
            });
            return response.body?.note || null;
        } catch (e: any) {
            const status = e?.status ?? e?.response?.status ?? e?.httpStatus;
            const retryAfter = e?.body?.retry_after ?? e?.response?.body?.retry_after ?? 5;

            // If rate limited, wait and retry
            if (status === 429) {
                const waitTime = (retryAfter * 1000) + 2000;
                await sleep(waitTime);
                continue;
            }
            // 404 means no note exists, other errors we just return null
            return null;
        }
    }
    return null;
}

async function exportFriendNotes(onlyWithNotes: boolean, channelId: string): Promise<{ success: boolean; message: string; }> {
    const friendIds = RelationshipStore.getFriendIDs();

    if (friendIds.length === 0) {
        return { success: false, message: "You have no friends to export notes from." };
    }

    const estimatedMinutes = Math.ceil((friendIds.length * 3) / 60);
    sendBotMessage(channelId, {
        content: `⏳ Fetching notes for ${friendIds.length} friends... This will take approximately ${estimatedMinutes} minute(s).`,
    });

    const lines: string[] = [];
    lines.push("=== Discord Friend Notes Export ===");
    lines.push(`Exported on: ${new Date().toLocaleString()}`);
    lines.push(`Total friends: ${friendIds.length}`);
    lines.push("");
    lines.push("-----------------------------------");
    lines.push("");

    let notesCount = 0;
    let exportedCount = 0;

    for (let i = 0; i < friendIds.length; i++) {
        // Wait BEFORE making request (except for first one)
        if (i > 0) {
            await sleep(3000);
        }

        const friendId = friendIds[i];
        const user = UserStore.getUser(friendId);

        if (!user) {
            continue;
        }

        const note = await fetchNoteWithRetry(friendId);
        const username = getUniqueUsername(user);

        if (note) notesCount++;

        if (onlyWithNotes && !note) continue;

        lines.push(`User: ${username}`);
        lines.push(`ID: ${friendId}`);
        lines.push(`Note: ${note || "(No note)"}`);
        lines.push("");

        exportedCount++;
    }

    lines.push("-----------------------------------");
    lines.push(`Friends with notes: ${notesCount}/${friendIds.length}`);

    if (exportedCount === 0) {
        return { success: false, message: "No friends with notes to export." };
    }

    const content = lines.join("\n");
    const filename = `friend-notes-${new Date().toISOString().split("T")[0]}.txt`;

    if (IS_DISCORD_DESKTOP) {
        const data = new TextEncoder().encode(content);
        const result = await DiscordNative.fileManager.saveWithDialog(data, filename);

        if (result) {
            return { success: true, message: `Exported ${notesCount} notes from ${exportedCount} friends!` };
        }
        return { success: false, message: "Export cancelled." };
    } else {
        const file = new File([content], filename, { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(file);
        a.download = filename;

        document.body.appendChild(a);
        a.click();
        setImmediate(() => {
            URL.revokeObjectURL(a.href);
            document.body.removeChild(a);
        });

        return { success: true, message: `Exported ${notesCount} notes from ${exportedCount} friends!` };
    }
}

export default definePlugin({
    name: "ExportFriendNotes",
    description: "Export Discord notes from all your friends to a text file using /exportnotes",
    authors: [EquicordDevs.nobody],
    settings,

    commands: [
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "exportnotes",
            description: "Export notes from all your friends to a text file",
            options: [
                {
                    name: "onlywithnotes",
                    description: "Only export friends who have a note set",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false,
                },
            ],
            execute: async (opts, ctx) => {
                const onlyWithNotes = findOption(opts, "onlywithnotes", settings.store.onlyWithNotes);

                const result = await exportFriendNotes(onlyWithNotes, ctx.channel.id);

                sendBotMessage(ctx.channel.id, {
                    content: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
                });

                if (result.success) {
                    showNotification({
                        title: "Export Friend Notes",
                        body: result.message,
                    });
                }
            },
        },
    ],
});
